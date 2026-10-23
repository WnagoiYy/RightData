"""Exercise the final macOS DMG and its per-user LaunchAgent on GitHub Actions.

This test deliberately refuses to run outside an ephemeral GitHub-hosted macOS
job. It never removes the RightData data directory. See installer-macos.md for
the expected workflow invocation and cleanup guarantees.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid


LABEL = "com.rightdata.network"
BUNDLE_ID = "com.rightdata.client"
MAX_FRAME_SIZE = 64 * 1024
STARTUP_TIMEOUT_SECONDS = 30


def require_ephemeral_macos_runner() -> None:
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_OS") != "macOS"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
        or platform.system() != "Darwin"
    ):
        raise RuntimeError(
            "This installation lifecycle test only runs on an ephemeral "
            "GitHub Actions macOS runner."
        )


def parse_args(project: Path) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Mount and exercise a final RightData macOS DMG."
    )
    parser.add_argument(
        "target",
        nargs="?",
        choices=("aarch64-apple-darwin", "x86_64-apple-darwin"),
        help="Release target; derives the final artifact path, version, and architecture",
    )
    parser.add_argument("--package", type=Path, help="Final DMG path")
    parser.add_argument("--expected-version")
    parser.add_argument(
        "--expected-arch",
        choices=("arm64", "x86_64"),
        help="Native architecture expected in both app and helper",
    )
    parser.add_argument(
        "--result",
        type=Path,
        default=Path("test/results/installer-macos.json"),
    )
    args = parser.parse_args()
    if args.target:
        if args.package or args.expected_version or args.expected_arch:
            parser.error("target cannot be combined with explicit package expectations")
        package_document = json.loads(
            (project / "client/package.json").read_text(encoding="utf-8")
        )
        version = package_document.get("version")
        if not isinstance(version, str) or not version:
            parser.error("client/package.json has no release version")
        artifact_arch, executable_arch = {
            "aarch64-apple-darwin": ("arm64", "arm64"),
            "x86_64-apple-darwin": ("x64", "x86_64"),
        }[args.target]
        args.package = (
            project
            / f"test/artifacts/release/RightData-{version}-macos-{artifact_arch}.dmg"
        )
        args.expected_version = version
        args.expected_arch = executable_arch
    elif not args.package or not args.expected_version or not args.expected_arch:
        parser.error(
            "provide a release target, or all of --package, --expected-version, and --expected-arch"
        )
    return args


def run(
    arguments: list[str | Path],
    *,
    check: bool = True,
    timeout: int = 30,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [str(value) for value in arguments],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        command = " ".join(str(value) for value in arguments[:2])
        raise RuntimeError(f"{command} failed with exit code {result.returncode}")
    return result


def path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def architecture(path: Path) -> set[str]:
    output = run(["/usr/bin/lipo", "-archs", path]).stdout.strip()
    values = set(output.split())
    if not values:
        raise RuntimeError(f"No Mach-O architecture reported for {path.name}")
    return values


def verify_signature(app: Path, helper: Path) -> None:
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
    run(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", helper])


def read_exact(connection: socket.socket, size: int) -> bytes:
    result = bytearray()
    while len(result) < size:
        chunk = connection.recv(size - len(result))
        if not chunk:
            raise EOFError("Truncated network-service frame")
        result.extend(chunk)
    return bytes(result)


def service_request(socket_path: Path, operation: str = "status") -> dict[str, object]:
    request_id = str(uuid.uuid4())
    payload = json.dumps(
        {"v": 1, "id": request_id, "op": operation}, separators=(",", ":")
    ).encode("utf-8")
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(str(socket_path))
        connection.sendall(struct.pack(">I", len(payload)) + payload)
        (length,) = struct.unpack(">I", read_exact(connection, 4))
        if not 0 < length <= MAX_FRAME_SIZE:
            raise RuntimeError("Invalid network-service response length")
        response = json.loads(read_exact(connection, length))
    if (
        response.get("v") != 1
        or response.get("id") != request_id
        or response.get("ok") is not True
        or not isinstance(response.get("data"), dict)
    ):
        raise RuntimeError("Invalid network-service status response")
    return response["data"]


def launchctl_job() -> str:
    return f"gui/{os.geteuid()}/{LABEL}"


def job_state() -> tuple[bool, int | None]:
    result = run(["/bin/launchctl", "print", launchctl_job()], check=False)
    if result.returncode != 0:
        return False, None
    match = re.search(r"(?m)^\s*pid = (\d+)\s*$", result.stdout)
    return True, int(match.group(1)) if match else None


def start_app(executable: Path, log_path: Path) -> tuple[subprocess.Popen[bytes], object]:
    log = log_path.open("ab", buffering=0)
    process = subprocess.Popen(
        [str(executable)],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return process, log


def stop_app(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def wait_for_service(
    app: subprocess.Popen[bytes] | None,
    socket_path: Path,
    *,
    previous_job_pid: int | None = None,
    timeout: int = STARTUP_TIMEOUT_SECONDS,
) -> tuple[dict[str, object], int | None]:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if app is not None and app.poll() is not None:
            raise RuntimeError(f"App exited during initialization ({app.returncode})")
        try:
            loaded, job_pid = job_state()
            if loaded and (previous_job_pid is None or job_pid != previous_job_pid):
                status = service_request(socket_path)
                if status.get("running") is True and status.get("deviceId"):
                    return status, job_pid
        except (OSError, EOFError, json.JSONDecodeError, RuntimeError) as error:
            last_error = error
        time.sleep(0.25)
    detail = type(last_error).__name__ if last_error else "not ready"
    raise TimeoutError(f"Network service did not initialize within {timeout}s ({detail})")


def verify_plist(plist_path: Path, helper_path: Path, data_root: Path) -> None:
    with plist_path.open("rb") as stream:
        document = plistlib.load(stream)
    expected_arguments = [str(helper_path), "--data-dir", str(data_root)]
    if document.get("Label") != LABEL:
        raise RuntimeError("Installed LaunchAgent has the wrong label")
    if document.get("ProgramArguments") != expected_arguments:
        raise RuntimeError("Installed LaunchAgent has unexpected arguments")
    if document.get("RunAtLoad") is not False or document.get("KeepAlive") is not False:
        raise RuntimeError("Installed LaunchAgent changed first-run startup policy")
    if document.get("ProcessType") != "Background":
        raise RuntimeError("Installed LaunchAgent has the wrong process type")
    if document.get("AssociatedBundleIdentifiers") != [BUNDLE_ID]:
        raise RuntimeError("Installed LaunchAgent has the wrong associated bundle")
    if document.get("ExitTimeOut") != 10 or document.get("Umask") != 0o77:
        raise RuntimeError("Installed LaunchAgent has unexpected process settings")


def verify_owned_mode(path: Path, expected_mode: int, description: str) -> None:
    metadata = path.stat(follow_symlinks=False)
    if metadata.st_uid != os.geteuid():
        raise RuntimeError(f"{description} is not owned by the current user")
    if stat.S_IMODE(metadata.st_mode) != expected_mode:
        raise RuntimeError(f"{description} mode is not {expected_mode:04o}")


def wait_for_backend_failure(
    app: subprocess.Popen[bytes], socket_path: Path, timeout: int = 15
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if app.poll() is not None:
            raise RuntimeError(f"App exited while the backend was unreachable ({app.returncode})")
        status = service_request(socket_path)
        if status.get("ready") is False and status.get("lastError"):
            return status
        time.sleep(0.25)
    raise TimeoutError("Network service did not report the unreachable backend")


def main() -> None:
    require_ephemeral_macos_runner()
    project = Path(__file__).resolve().parents[2]
    args = parse_args(project)
    runner_arch = {"arm64": "arm64", "x86_64": "x86_64"}.get(platform.machine())
    if runner_arch != args.expected_arch:
        raise RuntimeError("Release architecture does not match the native runner")
    package = args.package.resolve()
    if not package.is_file() or package.suffix.lower() != ".dmg":
        raise RuntimeError("--package must point to one final DMG")

    build_root = (project / "test/build").resolve()
    build_root.mkdir(parents=True, exist_ok=True)
    run_root = build_root / f"installer-macos-{uuid.uuid4()}"
    mount_point = run_root / "mount"
    install_root = run_root / "installed"
    mount_point.mkdir(parents=True)
    install_root.mkdir()

    home = Path.home().resolve()
    data_root = home / "Library/Application Support/RightData/network"
    installed_helper = data_root / "bin/rightdata-network-service"
    socket_path = data_root / "network.sock"
    plist_path = home / "Library/LaunchAgents" / f"{LABEL}.plist"
    result_path = args.result if args.result.is_absolute() else project / args.result

    mounted = False
    preflight_complete = False
    app_process: subprocess.Popen[bytes] | None = None
    app_log: object | None = None
    app_copy: Path | None = None
    summary: dict[str, object] = {}
    try:
        loaded, _ = job_state()
        if loaded or plist_path.exists() or data_root.exists():
            raise RuntimeError(
                "Runner already contains RightData user state; refusing to modify or delete it"
            )
        preflight_complete = True

        run(
            [
                "/usr/bin/hdiutil",
                "attach",
                "-nobrowse",
                "-readonly",
                "-mountpoint",
                mount_point,
                package,
            ],
            timeout=60,
        )
        mounted = True
        apps = sorted(mount_point.glob("*.app"))
        if len(apps) != 1:
            raise RuntimeError(f"Expected one app at the DMG root, found {len(apps)}")
        app_copy = install_root / apps[0].name
        run(["/usr/bin/ditto", apps[0], app_copy], timeout=60)

        info_path = app_copy / "Contents/Info.plist"
        with info_path.open("rb") as stream:
            info = plistlib.load(stream)
        if info.get("CFBundleIdentifier") != BUNDLE_ID:
            raise RuntimeError("App bundle identifier is not com.rightdata.client")
        if info.get("CFBundleShortVersionString") != args.expected_version:
            raise RuntimeError("App bundle version does not match the release version")
        executable_name = info.get("CFBundleExecutable")
        if not isinstance(executable_name, str) or not executable_name:
            raise RuntimeError("App bundle has no executable name")
        app_executable = app_copy / "Contents/MacOS" / executable_name
        bundled_helper = app_copy / "Contents/Resources/rightdata-network-service"
        if not app_executable.is_file() or not bundled_helper.is_file():
            raise RuntimeError("App bundle is missing its main executable or network helper")
        expected_architectures = {args.expected_arch}
        if architecture(app_executable) != expected_architectures:
            raise RuntimeError("App executable architecture does not match the runner target")
        if architecture(bundled_helper) != expected_architectures:
            raise RuntimeError("Bundled helper architecture does not match the runner target")
        verify_signature(app_copy, bundled_helper)

        app_process, app_log = start_app(app_executable, run_root / "app.log")
        first, first_job_pid = wait_for_service(app_process, socket_path)
        if not plist_path.is_file() or not installed_helper.is_file():
            raise RuntimeError("App did not install its LaunchAgent and helper")
        verify_plist(plist_path, installed_helper, data_root)
        if sha256(installed_helper) != sha256(bundled_helper):
            raise RuntimeError("Installed helper differs from the bundled helper")
        verify_owned_mode(data_root, 0o700, "Network-service data directory")
        verify_owned_mode(installed_helper.parent, 0o700, "Network-service bin directory")
        verify_owned_mode(installed_helper, 0o700, "Installed network helper")
        verify_owned_mode(plist_path, 0o600, "Installed LaunchAgent plist")
        verify_owned_mode(socket_path, 0o600, "Network-service socket")
        wait_for_backend_failure(app_process, socket_path)
        first_device_id = first["deviceId"]

        stop_app(app_process)
        app_process = None
        if app_log is not None:
            app_log.close()
            app_log = None
        after_app_exit = service_request(socket_path)
        if after_app_exit.get("deviceId") != first_device_id:
            raise RuntimeError("Service identity changed after the app exited")

        run(["/bin/launchctl", "kickstart", "-k", launchctl_job()])
        restarted, second_job_pid = wait_for_service(
            None, socket_path, previous_job_pid=first_job_pid
        )
        if first_job_pid is None or second_job_pid is None or first_job_pid == second_job_pid:
            raise RuntimeError("LaunchAgent service process did not restart")
        if restarted.get("deviceId") != first_device_id:
            raise RuntimeError("Service identity changed after process restart")

        app_process, app_log = start_app(app_executable, run_root / "app-restart.log")
        final, _ = wait_for_service(app_process, socket_path)
        time.sleep(1)
        if app_process.poll() is not None:
            raise RuntimeError("App did not remain running while the backend was unreachable")
        if final.get("deviceId") != first_device_id:
            raise RuntimeError("Service identity changed after app restart")

        summary = {
            "version": args.expected_version,
            "architecture": args.expected_arch,
            "bundleIdentifier": BUNDLE_ID,
            "signatureVerified": True,
            "helperInstalled": True,
            "launchAgentInstalled": True,
            "socketStatusReadable": True,
            "appSurvivedBackendFailure": True,
            "serviceSurvivedAppExit": True,
            "deviceIdentityPreserved": True,
            "serviceProcessRestarted": True,
        }
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(summary, separators=(",", ":")))
    finally:
        stop_app(app_process)
        if app_log is not None:
            app_log.close()
        # Only clean shared user paths after preflight proved they were absent.
        if preflight_complete:
            if job_state()[0]:
                run(["/bin/launchctl", "bootout", launchctl_job()], check=False)
            if plist_path.is_file():
                plist_path.unlink()
        if mounted:
            detached = run(["/usr/bin/hdiutil", "detach", mount_point], check=False, timeout=30)
            if detached.returncode != 0:
                run(["/usr/bin/hdiutil", "detach", "-force", mount_point], check=False, timeout=30)
        if path_is_within(run_root, build_root):
            shutil.rmtree(run_root, ignore_errors=True)
        # Deliberately retain ~/Library/Application Support/RightData/network.
        # Product uninstall semantics preserve device identity and connection data.


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"macOS installer smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
