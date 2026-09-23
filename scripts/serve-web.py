#!/usr/bin/env python3
"""Serves build/web on localhost with the headers the published folder will have.

    python3 scripts/serve-web.py [--port 8777]

The Content-Security-Policy is read out of the .htaccess the build writes, so a page that works here works
behind Apache too — a policy without 'wasm-unsafe-eval' stops WebAssembly dead, and that is worth finding
before the deploy rather than after. Ctrl-C stops the server.
"""
import argparse
import functools
import http.server
import re
import socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "build/web"


def policy():
    htaccess = ROOT / ".htaccess"
    if not htaccess.exists():
        return None
    found = re.search(r'Header set Content-Security-Policy "([^"]+)"', htaccess.read_text())
    return found.group(1) if found else None


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm"}
    csp = None

    def end_headers(self):
        if self.csp:
            self.send_header("Content-Security-Policy", self.csp)
        self.send_header("Cache-Control", "no-store")   # always the newest build while working on it
        super().end_headers()

    def log_message(self, format, *args):
        if "GET" in format % args and " 200" not in format % args:
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8777)
    args = parser.parse_args()
    if not ROOT.exists():
        raise SystemExit("build/web not found — run python3 scripts/build-web.py first")
    Handler.csp = policy()
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), functools.partial(Handler, directory=str(ROOT))) as server:
        print(f"Darkroom on http://localhost:{args.port}/  (Ctrl-C to stop)")
        print("Content-Security-Policy: " + ("from the build's .htaccess" if Handler.csp else "none found"))
        server.serve_forever()


if __name__ == "__main__":
    main()
