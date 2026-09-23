#!/usr/bin/env python3
"""Builds the browser version of the filters: the same C core, compiled to WebAssembly, next to the page.

    python3 scripts/build-web.py [--serve] [--port 8777]

Output is build/web/, a folder of static files — index.html, the page's script and style, and darkroom.wasm.
Nothing runs on the server, so publishing it is a copy into any folder that serves files.

Needs Emscripten. If emcc is not on PATH, the script sources ../emsdk/emsdk_env.sh next to this repository.
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web/src"
OUT = ROOT / "build/web"
CORE = ROOT / "Compositor/Rendering"
EMSDK = ROOT.parent / "emsdk"


def emcc():
    """emcc from PATH, else from an emsdk checked out beside this repository."""
    found = shutil.which("emcc")
    if found:
        return [found]
    activated = EMSDK / ".emscripten"
    upstream = EMSDK / "upstream/emscripten/emcc"
    if activated.exists() and upstream.exists():
        return [sys.executable, str(upstream) + ".py"] if not os.access(upstream, os.X_OK) else [str(upstream)]
    sys.exit(f"emcc not found. Install Emscripten, or check out emsdk at {EMSDK} and run ./emsdk activate latest")


def build(debug=False):
    OUT.mkdir(parents=True, exist_ok=True)
    command = emcc() + [
        str(ROOT / "web/wasm/darkroom.c"), str(CORE / "FinishPixels.c"),
        # web/wasm comes first: it holds the stand-in for libdispatch the core includes.
        "-I", str(ROOT / "web/wasm"), "-I", str(CORE),
        "-O3" if not debug else "-O0",
        "-std=c11", "-Wall", "-Wextra",
        # One self-contained ES module the page imports; memory grows with the image it is given.
        "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=web,worker",
        "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=64MB", "-sSTACK_SIZE=1MB",
        "-sEXPORTED_FUNCTIONS=_dk_apply,_dk_reach,_dk_is_opaque,_dk_premultiply,_dk_unpremultiply,_malloc,_free",
        "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32",
        "-o", str(OUT / "darkroom.js"),
    ]
    subprocess.run(command, check=True)
    for name in sorted(p.name for p in SRC.iterdir() if p.is_file()):
        shutil.copy2(SRC / name, OUT / name)
    # Multithreading in the browser needs the page to be cross-origin isolated; on Apache these two
    # headers do it. Copied along so publishing the folder is enough.
    (OUT / ".htaccess").write_text(
        'Header set Cross-Origin-Opener-Policy "same-origin"\n'
        'Header set Cross-Origin-Embedder-Policy "require-corp"\n'
        "AddType application/wasm .wasm\n"
        "<IfModule mod_deflate.c>\n"
        "  AddOutputFilterByType DEFLATE application/wasm application/javascript text/css text/html\n"
        "</IfModule>\n")
    total = sum(p.stat().st_size for p in OUT.iterdir() if p.is_file())
    print(f"Built {OUT} ({total / 1024:.0f} KB total)")
    for p in sorted(OUT.iterdir()):
        if p.is_file():
            print(f"  {p.name:<16} {p.stat().st_size / 1024:8.1f} KB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--serve", action="store_true", help="serve build/web on localhost afterwards")
    parser.add_argument("--port", type=int, default=8777)
    args = parser.parse_args()
    build(args.debug)
    if args.serve:
        subprocess.run([sys.executable, str(ROOT / "scripts/serve-web.py"), "--port", str(args.port)])


if __name__ == "__main__":
    main()
