"""Real macOS service process/socket lifecycle. No installed user service is touched."""
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import time

root = Path(__file__).resolve().parents[2]
data = root / 'test/runtime/unix-service'
data.mkdir(parents=True, exist_ok=True)
binary = root / 'client/network-service/target/debug/rightdata-network-service'
sock = data / 'network.sock'

def start():
    process = subprocess.Popen([str(binary), '--data-dir', str(data)])
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError('Service exited during startup')
        try:
            request('status')
            return process
        except (OSError, EOFError):
            time.sleep(.1)
    process.terminate()
    raise TimeoutError('Service socket did not become ready')

def request(op):
    def read_exact(connection, size):
        result = b''
        while len(result) < size:
            chunk = connection.recv(size - len(result))
            if not chunk:
                raise EOFError('Truncated frame')
            result += chunk
        return result
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(str(sock))
        payload = json.dumps({'v': 1, 'id': 'unix-test', 'op': op}).encode()
        connection.sendall(struct.pack('>I', len(payload)) + payload)
        length, = struct.unpack('>I', read_exact(connection, 4))
        assert 0 < length <= 65536
        value = json.loads(read_exact(connection, length))
        assert value['ok'], value
        return value['data']

process = start()
try:
    first = request('status')
    assert stat.S_IMODE(sock.stat().st_mode) == 0o600
    assert stat.S_IMODE(data.stat().st_mode) == 0o700
    duplicate = subprocess.run([str(binary), '--data-dir', str(data)], timeout=10, capture_output=True)
    assert duplicate.returncode != 0
    request('stop')
    assert request('status')['enabled'] is False
    process.kill()  # Simulate a crash: the next process must recover its stale socket.
    process.wait(timeout=10)
    process = start()
    second = request('status')
    assert second['deviceId'] == first['deviceId']
    assert second['enabled'] is False
    request('start')
    assert request('status')['enabled'] is True
finally:
    process.terminate()
    process.wait(timeout=10)
print('PASS: Unix socket permissions, duplicate lock, pause persistence, crash recovery, stable device identity')
