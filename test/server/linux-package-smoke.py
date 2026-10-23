"""Run the shipped Linux executable, including encrypted storage and restart."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

package = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="linux-package-", dir="test/runtime") as directory:
    root = Path(directory).resolve()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    config = root / "config.json"
    config.write_text('{"server":{"address":"127.0.0.1:0"}}')
    env = dict(os.environ, RIGHTDATA_ADDRESS=f"127.0.0.1:{port}",
               RIGHTDATA_DATA_DIR=str(root / "data"), GF_GCFG_FILE=str(config))
    env.pop("RIGHTDATA_ADMIN_PASSWORD", None)
    token = ""
    process = None

    def api(path, method="GET", body=None, key=None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if key:
            headers["Idempotency-Key"] = key
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
            data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=30) as response:
            envelope = json.load(response)
        assert envelope["code"] == "ok", envelope.get("code")
        return envelope["data"]

    def start(log):
        global process
        process = subprocess.Popen([str(package / "rightdata")], cwd=package, env=env, stdout=log, stderr=log)
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError("Packaged server exited before readiness")
            try:
                probe = api("/api/probe")
                assert probe["ready"] and probe["service"] == "RightData"
                return probe
            except (OSError, AssertionError):
                time.sleep(0.25)
        raise RuntimeError("Packaged server readiness timed out")

    def stop():
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise AssertionError("Server did not stop gracefully")

    with (root / "server.log").open("w+") as log:
        try:
            first = start(log)
            try:
                api("/api/v1/datasets")
                raise AssertionError("Unauthenticated request succeeded")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            password = subprocess.check_output([str(package / "rightdata")], cwd=package,
                env=dict(env, RIGHTDATA_PRINT_INITIAL_PASSWORD="1"), text=True).strip()
            assert len(password) >= 12

            def login():
                global token
                token = api("/api/v1/auth/login", "POST", {"username": "admin", "password": password, "remember": False})["accessToken"]
                assert api("/api/v1/auth/me")["username"] == "admin"

            login()
            database = api("/api/v1/data-files", "POST", {"name": "linux-check.duckdb", "password": secrets.token_urlsafe(24)})["id"]
            api(f"/api/v1/datasets/{database}/schema:mutate", "POST", {"action": "create_table", "table": "smoke", "fields": [{"name": "id", "dataType": "BIGINT", "primaryKey": True, "nullable": False}]}, str(uuid.uuid4()))
            api(f"/api/v1/datasets/{database}/tables/smoke/records:mutate", "POST", {"operations": [{"action": "insert", "values": {"id": "9007199254740993"}}]}, str(uuid.uuid4()))
            stop()
            token = ""
            second = start(log)
            assert second["instanceId"] == first["instanceId"]
            login()
            result = api(f"/api/v1/datasets/{database}/tables/smoke/query", "POST", {"fields": ["id"], "limit": 10, "offset": 0})
            assert result["total"] == 1 and result["rows"][0]["id"] == "9007199254740993"
            print("Linux package: offline extension, random initial password, authentication, encrypted database, graceful restart and exact persisted BIGINT passed.")
        except Exception:
            log.flush()
            log.seek(0)
            print(log.read()[-6000:], file=sys.stderr)
            raise
        finally:
            stop()
