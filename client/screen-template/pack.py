#!/usr/bin/env python3
"""Build and verify a RightData screen package using only Python's standard library."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import zipfile

MAX_PACKAGE = 50 * 1024 * 1024
MAX_MANIFEST = 1 * 1024 * 1024
MAX_FILE = 32 * 1024 * 1024
MAX_EXPANDED = 200 * 1024 * 1024
MAX_FILES = 2048
MAX_RATIO = 100
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
SCREEN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
GENERATED_DIRECTORIES = {"__pycache__"}
GENERATED_SUFFIXES = {".pyc", ".pyo"}


class PackageError(ValueError):
    pass


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def validate_relative_path(value: str, *, allow_manifest: bool = False) -> str:
    raw_parts = value.split("/")
    if not value or len(value) > 240 or not SAFE_PATH.fullmatch(value) or "\\" in value or any(part in {"", ".", ".."} for part in raw_parts):
        raise PackageError(f"不安全的包内路径：{value!r}")
    path = PurePosixPath(value)
    parts = path.parts
    if path.is_absolute() or len(parts) > 16:
        raise PackageError(f"不安全的包内路径：{value!r}")
    for part in parts:
        if part.endswith(".") or part.split(".", 1)[0].upper() in WINDOWS_RESERVED:
            raise PackageError(f"不兼容 Windows 的包内路径：{value!r}")
    normalized = path.as_posix()
    if not allow_manifest and normalized.casefold() == "manifest.json":
        raise PackageError("源目录不能包含 manifest.json；该文件由打包器生成")
    return normalized


def _validate_path_graph(paths: list[str]) -> None:
    entries: dict[str, str] = {}
    for value in paths:
        parts = PurePosixPath(value).parts
        for index in range(1, len(parts)):
            parent = "/".join(parts[:index]).casefold()
            if entries.get(parent) == "file":
                raise PackageError(f"文件与目录冲突：{value}")
            entries[parent] = "dir"
        leaf = value.casefold()
        if leaf in entries:
            raise PackageError(f"路径重复或文件与目录冲突：{value}")
        entries[leaf] = "file"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_files(source: Path, excludes: set[str]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    expanded = 0
    for root, directories, files in os.walk(source, followlinks=False):
        root_path = Path(root)
        for directory in list(directories):
            candidate = root_path / directory
            if candidate.is_symlink():
                raise PackageError(f"不允许符号链接目录：{candidate.relative_to(source).as_posix()}")
            if directory in GENERATED_DIRECTORIES:
                directories.remove(directory)
        for filename in files:
            candidate = root_path / filename
            if candidate.is_symlink() or not candidate.is_file():
                raise PackageError(f"只允许普通文件：{candidate.relative_to(source).as_posix()}")
            if candidate.suffix.lower() in GENERATED_SUFFIXES:
                continue
            relative = validate_relative_path(candidate.relative_to(source).as_posix())
            if relative in excludes:
                continue
            size = candidate.stat().st_size
            if size > MAX_FILE:
                raise PackageError(f"单个文件超过 32 MiB：{relative}")
            expanded += size
            if expanded > MAX_EXPANDED:
                raise PackageError("展开内容超过 200 MiB")
            records.append({"path": relative, "source": candidate, "size": size, "sha256": _sha256(candidate)})
    records.sort(key=lambda item: str(item["path"]))
    if not records:
        raise PackageError("源目录没有可打包文件")
    if len(records) > MAX_FILES:
        raise PackageError("普通文件数量超过 2048")
    _validate_path_graph([str(record["path"]) for record in records])
    return records


def _zip_info(name: str, compression: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_TIME)
    info.compress_type = compression
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    return info


def _write_archive(path: Path, manifest_bytes: bytes, records: list[dict[str, object]], compression: int) -> None:
    with zipfile.ZipFile(path, "w", compression=compression, compresslevel=9, allowZip64=False) as archive:
        archive.writestr(_zip_info("manifest.json", compression), manifest_bytes)
        for record in records:
            info = _zip_info(str(record["path"]), compression)
            with Path(record["source"]).open("rb") as source, archive.open(info, "w", force_zip64=False) as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)


def verify_archive(path: Path, expected_manifest: dict[str, object] | None = None) -> dict[str, object]:
    if path.stat().st_size > MAX_PACKAGE:
        raise PackageError("ZIP 超过 50 MiB")
    with path.open("rb") as stream:
        if stream.read(4) not in {b"PK\x03\x04", b"PK\x05\x06"}:
            raise PackageError("ZIP 包含自解压前缀或格式无效")
    with zipfile.ZipFile(path, "r", allowZip64=False) as archive:
        if archive.testzip() is not None:
            raise PackageError("ZIP 完整性校验失败")
        infos = archive.infolist()
        names = [validate_relative_path(info.filename, allow_manifest=True) for info in infos]
        if names.count("manifest.json") != 1 or len(names) != len(set(name.casefold() for name in names)):
            raise PackageError("ZIP 必须且只能包含一个根 manifest.json，路径不得重复")
        if any(info.is_dir() or info.flag_bits & 1 or info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED} for info in infos):
            raise PackageError("ZIP 含目录、加密条目或不支持的压缩方式")
        if len(infos) - 1 > MAX_FILES:
            raise PackageError("普通文件数量超过 2048")
        manifest_info = archive.getinfo("manifest.json")
        if manifest_info.file_size > MAX_MANIFEST:
            raise PackageError("manifest.json 超过 1 MiB")
        try:
            manifest = json.loads(archive.read(manifest_info))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PackageError("manifest.json 不是有效 UTF-8 JSON") from error
        if expected_manifest is not None and manifest != expected_manifest:
            raise PackageError("写入后的 manifest.json 与预期不一致")
        listed = manifest.get("files") if isinstance(manifest, dict) else None
        if not isinstance(listed, list):
            raise PackageError("manifest.files 必须是数组")
        listed_by_path = {item.get("path"): item for item in listed if isinstance(item, dict)}
        actual_files = [info for info in infos if info.filename != "manifest.json"]
        if set(listed_by_path) != {info.filename for info in actual_files} or len(listed_by_path) != len(listed):
            raise PackageError("manifest.files 与 ZIP 文件不一致")
        total_size = 0
        total_compressed = 0
        for info in actual_files:
            item = listed_by_path[info.filename]
            if info.file_size > MAX_FILE or item.get("size") != info.file_size:
                raise PackageError(f"文件大小不匹配：{info.filename}")
            digest = hashlib.sha256()
            with archive.open(info) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if item.get("sha256") != digest.hexdigest():
                raise PackageError(f"文件摘要不匹配：{info.filename}")
            if info.file_size and info.file_size / max(1, info.compress_size) > MAX_RATIO:
                raise PackageError(f"文件压缩比超过 100：{info.filename}")
            total_size += info.file_size
            total_compressed += info.compress_size
        if total_size > MAX_EXPANDED or total_size and total_size / max(1, total_compressed) > MAX_RATIO:
            raise PackageError("整体展开大小或压缩比超过限制")
        entry = manifest.get("entry")
        if entry not in listed_by_path or not str(entry).lower().endswith((".html", ".htm")):
            raise PackageError("entry 必须指向清单内的 HTML 文件")
        if manifest.get("containerApiVersion") != 1 or not SCREEN_ID.fullmatch(str(manifest.get("screenId", ""))) or not SEMVER.fullmatch(str(manifest.get("version", ""))):
            raise PackageError("screenId、version 或 containerApiVersion 无效")
        return manifest


def build_package(*, source: Path, output: Path, screen_id: str, version: str, entry: str = "index.html", compression: str = "deflate", excludes: list[str] | None = None, force: bool = False) -> dict[str, object]:
    source = source.expanduser().resolve()
    output = output.expanduser().resolve()
    if not source.is_dir():
        raise PackageError(f"源目录不存在：{source}")
    allowed_roots = [(project_root() / name).resolve() for name in ("client", "test", "deploy")]
    if not any(_within(output, root) for root in allowed_roots) or output.suffix.lower() != ".zip":
        raise PackageError("输出必须显式指定为项目 client/、test/ 或 deploy/ 内的 .zip 文件")
    if _within(output, source):
        raise PackageError("输出 ZIP 不能位于源目录内")
    if output.exists() and not force:
        raise PackageError(f"输出已存在；确认替换时使用 --force：{output}")
    if not SCREEN_ID.fullmatch(screen_id):
        raise PackageError("screen-id 仅允许字母、数字、连字符和下划线，且必须以字母或数字开头")
    if not SEMVER.fullmatch(version):
        raise PackageError("version 必须是稳定 SemVer x.y.z")
    entry = validate_relative_path(entry)
    if not entry.lower().endswith((".html", ".htm")):
        raise PackageError("entry 必须是 .html 或 .htm 文件")
    excluded = {validate_relative_path(item, allow_manifest=True) for item in (excludes or [])}
    records = collect_files(source, excluded)
    if entry not in {record["path"] for record in records}:
        raise PackageError(f"入口文件不在源目录中：{entry}")
    manifest = {
        "screenId": screen_id,
        "version": version,
        "entry": entry,
        "containerApiVersion": 1,
        "files": [{"path": record["path"], "size": record["size"], "sha256": record["sha256"]} for record in records],
    }
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(manifest_bytes) > MAX_MANIFEST:
        raise PackageError("manifest.json 超过 1 MiB")
    compression_type = zipfile.ZIP_DEFLATED if compression == "deflate" else zipfile.ZIP_STORED
    output.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.stem}-", suffix=".zip", dir=output.parent)
    os.close(file_descriptor)
    temporary = Path(temporary_name)
    try:
        _write_archive(temporary, manifest_bytes, records, compression_type)
        verify_archive(temporary, manifest)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return {"output": str(output), "sha256": _sha256(output), "sizeBytes": output.stat().st_size, "manifest": manifest}


def main() -> int:
    parser = argparse.ArgumentParser(description="生成并校验 RightData 数据大屏静态包")
    parser.add_argument("--source", required=True, type=Path, help="静态文件目录")
    parser.add_argument("--output", required=True, type=Path, help="项目 client/test/deploy 内的输出 ZIP")
    parser.add_argument("--screen-id", required=True, help="已有 screen 配置 ID")
    parser.add_argument("--version", required=True, help="稳定 SemVer，例如 1.0.0")
    parser.add_argument("--entry", default="index.html", help="HTML 入口相对路径")
    parser.add_argument("--compression", choices=("deflate", "store"), default="deflate")
    parser.add_argument("--exclude", action="append", default=[], help="排除一个相对路径，可重复")
    parser.add_argument("--force", action="store_true", help="替换已存在的输出文件")
    args = parser.parse_args()
    try:
        result = build_package(source=args.source, output=args.output, screen_id=args.screen_id, version=args.version, entry=args.entry, compression=args.compression, excludes=args.exclude, force=args.force)
    except (PackageError, OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
