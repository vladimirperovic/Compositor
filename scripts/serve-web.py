#!/usr/bin/env python3
"""Serves build/web on localhost with the headers a published copy would have.

    python3 scripts/serve-web.py [--port 8777]

The two Cross-Origin-* headers are what a browser wants before it hands a page shared memory, so what is
tested here behaves like the folder on the real site. Ctrl-C stops it.
"""
import argparse
import functools
import http.server
import socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "build/web"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm"}

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
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
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), functools.partial(Handler, directory=str(ROOT))) as server:
        print(f"Darkroom on http://localhost:{args.port}/  (Ctrl-C to stop)")
        server.serve_forever()


if __name__ == "__main__":
    main()
