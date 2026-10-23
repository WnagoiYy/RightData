from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PACK_PATH = PROJECT_ROOT / "client" / "screen-template" / "pack.py"
SPEC = importlib.util.spec_from_file_location("rightdata_screen_pack", PACK_PATH)
assert SPEC and SPEC.loader
pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pack)


class ScreenPackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="screen-pack-", dir=PROJECT_ROOT / "test")
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_template_package_is_deterministic_and_verified(self) -> None:
        source = PROJECT_ROOT / "client" / "screen-template"
        first = self.root / "first.zip"
        second = self.root / "second.zip"
        arguments = dict(source=source, screen_id="sales-screen", version="1.0.0", excludes=["README.md", "pack.py"])
        first_result = pack.build_package(output=first, **arguments)
        second_result = pack.build_package(output=second, **arguments)

        self.assertEqual(hashlib.sha256(first.read_bytes()).digest(), hashlib.sha256(second.read_bytes()).digest())
        self.assertEqual(first_result["sha256"], second_result["sha256"])
        manifest = pack.verify_archive(first)
        self.assertEqual(manifest["containerApiVersion"], 1)
        self.assertEqual(manifest["entry"], "index.html")
        self.assertEqual({item["path"] for item in manifest["files"]}, {"index.html", "screen.css", "screen.js"})
        with zipfile.ZipFile(first) as archive:
            stored = json.loads(archive.read("manifest.json"))
            self.assertEqual(stored, manifest)

    def test_rejects_invalid_paths_versions_and_output_locations(self) -> None:
        for value in ("../index.html", "assets//app.js", "/index.html", "CON.txt", "含中文.html"):
            with self.subTest(value=value), self.assertRaises(pack.PackageError):
                pack.validate_relative_path(value)
        with self.assertRaises(pack.PackageError):
            pack.build_package(
                source=PROJECT_ROOT / "client" / "screen-template",
                output=PROJECT_ROOT / "invalid.zip",
                screen_id="sales-screen",
                version="1.0.0-beta",
            )

    def test_manifest_detects_tampered_file_metadata(self) -> None:
        source = self.root / "source"
        source.mkdir()
        (source / "index.html").write_text("<main>screen</main>", encoding="utf-8")
        output = self.root / "screen.zip"
        pack.build_package(source=source, output=output, screen_id="screen-1", version="2.3.4")
        with zipfile.ZipFile(output) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        manifest["files"][0]["size"] += 1
        with self.assertRaises(pack.PackageError):
            pack.verify_archive(output, manifest)


if __name__ == "__main__":
    unittest.main()
