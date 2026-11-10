#!/usr/bin/env python3
"""Exercise Nginx admission against a disposable origin, not production traffic."""
import datetime
import http.server
import json
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

source = pathlib.Path(sys.argv[1])
class Origin(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"origin")
    do_HEAD = do_GET
    do_POST = do_GET
    def log_message(self, *_args):
        pass
origin = http.server.HTTPServer(("127.0.0.1", 0), Origin)
threading.Thread(target=origin.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix="anonymous-nginx-bulk-test-") as temp:
        root = pathlib.Path(temp)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        date = datetime.datetime.now().astimezone().strftime("%Y-%m-%d")
        blocks = root / "blocks.map"
        blocks.write_text(f'"~^{date}T.*:203\\.0\\.113\\.2$" 1;\n')
        logging = (source / "anonymous-logging.conf").read_text().replace("geo $remote_addr", "geo $arg_peer")
        limits = (source / "anonymous-bulk-limits.conf").read_text().replace("/etc/nginx/anonymous-bulk-blocks.map", str(blocks))
        location = (source / "anonymous-bulk-location.conf").read_text()
        server = (source / "anonymous-bulk-server.conf").read_text()
        config = root / "nginx.conf"
        config.write_text(f'pid {root}/pid; error_log {root}/error.log notice; events {{}} http {{ access_log off; '
                          + logging + limits + f' server {{ listen 127.0.0.1:{port}; ' + server
                          + ' location / { ' + location + f' proxy_pass http://127.0.0.1:{origin.server_port}; }} }} }}')
        subprocess.run(["nginx", "-t", "-p", str(root), "-c", str(config)], check=True, capture_output=True)
        process = subprocess.Popen(["nginx", "-p", str(root), "-c", str(config), "-g", "daemon off;"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(50):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=.1):
                        break
                except OSError:
                    time.sleep(.1)
            def request(path, client="203.0.113.1", method="GET"):
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}?peer=173.245.48.1", method=method,
                                             headers={"CF-Connecting-IP": client})
                try:
                    response = urllib.request.urlopen(req)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    return response.status, dict(response.headers), response.read()
            files = [request("/api/repo/test/file/a.txt")[0] for _ in range(65)]
            assert files[0] == 200 and files[-1] == 429 and files.count(200) <= 61, files
            listing = [request("/api/repo/test/files/counts")[0] for _ in range(35)]
            assert listing[0] == 200 and listing[-1] == 429 and listing.count(200) <= 31, listing
            status, headers, body = request("/api/repo/test/file/a.txt")
            assert status == 429 and headers["Retry-After"] == "30"
            assert json.loads(body)["error"] == "rate_limited" and b"ZIP" in body
            assert request("/api/repo/test/zip")[0] == 200
            assert request("/r/test/")[0] == 200
            assert request("/api/repo/test/file/a.txt", method="POST")[0] == 200
            assert request("/api/repo/test/file/a.txt", client="203.0.113.3")[0] == 200
            for path in ["/api/repo/test/file/a.txt", "/api/repo/test/files/counts", "/API/REPO/test/FILE/a.txt"]:
                status, headers, body = request(path, client="203.0.113.2")
                assert status == 429 and headers["Retry-After"] == "3600", (status, headers, body)
            assert request("/api/repo/test/file/a.txt", client="203.0.113.2", method="HEAD")[0] == 429
            assert request("/api/repo/test/zip", client="203.0.113.2")[0] == 200
            assert request("/", client="203.0.113.2")[0] == 200
            print("PASS: file/listing budgets, client separation, scoped block, HEAD/case variants, JSON retry response, ZIP/navigation/write exclusions")
        finally:
            process.terminate()
            process.wait(timeout=10)
finally:
    origin.shutdown()
    origin.server_close()
