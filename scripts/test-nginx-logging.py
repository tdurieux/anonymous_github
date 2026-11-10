#!/usr/bin/env python3
"""Exercise the logging config with an isolated local Nginx, never production listeners."""
import json
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

source = pathlib.Path(sys.argv[1]).read_text()
with tempfile.TemporaryDirectory(prefix="anonymous-nginx-test-") as root:
    root = pathlib.Path(root)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    # Only this isolated test substitutes the peer so both address families can
    # be exercised on loopback. Production always uses the real socket peer.
    config = source.replace("geo $remote_addr", "geo $arg_peer")
    path = root / "nginx.conf"
    path.write_text(f'pid {root}/pid; error_log {root}/error.log; events {{}} http {{\n'
                    + config + f'\nserver {{ listen 127.0.0.1:{port}; '
                    f'access_log {root}/access.log anonymous_json; return 200 "ok"; }} }}')
    subprocess.run(["nginx", "-t", "-p", str(root), "-c", str(path)], check=True, capture_output=True)
    process = subprocess.Popen(["nginx", "-p", str(root), "-c", str(path), "-g", "daemon off;"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=.1):
                    break
            except OSError:
                time.sleep(.1)
        cases = [
            ("127.0.0.1", "203.0.113.9", "0", "127.0.0.1", ""),
            ("173.245.48.1", "203.0.113.9", "1", "203.0.113.9", "test-ray"),
            ("2606:4700::1", "2001:db8::9", "1", "2001:db8::9", "test-ray"),
            ("173.245.48.1", "", "1", "127.0.0.1", "test-ray"),
        ]
        for peer, visitor, trusted, client, ray in cases:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/repo/private-repo/file/private-path?peer={peer}&code=SECRET",
                headers={"CF-Connecting-IP": visitor, "CF-Ray": "test-ray",
                         "User-Agent": 'test "quoted" \\ agent', "Cookie": "session=SECRET",
                         "Authorization": "Bearer SECRET"})
            with urllib.request.urlopen(req) as response:
                assert response.status == 200
            for _ in range(50):
                lines = (root / "access.log").read_text().splitlines()
                if len(lines) >= cases.index((peer, visitor, trusted, client, ray)) + 1:
                    break
                time.sleep(.01)
            row = json.loads(lines[-1])
            assert row["client_ip"] == client, row
            assert row["cloudflare_peer"] == trusted, row
            assert row["cf_ray"] == ray, row
            assert row["peer_ip"] == "127.0.0.1", row
            assert row["route"] == "/api/repo/:id/file/:path", row
            assert len(row["edge_request_id"]) == 32, row
            assert row["user_agent"] == 'test "quoted" \\ agent', row
            assert not any(secret in lines[-1] for secret in ["SECRET", "private-repo", "private-path"])
        print("PASS: trusted IPv4/IPv6, spoof rejection, missing-header fallback, JSON escaping and sensitive-data omission")
    finally:
        process.terminate()
        process.wait(timeout=10)
