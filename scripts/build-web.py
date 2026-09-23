#!/usr/bin/env python3
"""Builds the browser version of the filters: the same C core, compiled to WebAssembly, next to the page.

    python3 scripts/build-web.py [--serve] [--port 8777]
    python3 scripts/build-web.py --into ~/path/to/site/darkroom

Output is build/web/, a folder of static files — index.html, the page's script and style, darkroom.wasm and
an example image. Nothing runs on the server, so publishing it is a copy into any folder that serves files.
`--into` does that copy, removes what an earlier build left behind, and writes the .htaccess the page needs
there: WebAssembly will not compile without 'wasm-unsafe-eval' in the Content-Security-Policy, and a site's
own policy will not have it.

Every reference between the files carries ?v=<hash of this build>, so a browser holding the old page in its
cache cannot end up running one new file against seven old ones.

Needs Emscripten. If emcc is not on PATH, the script uses an emsdk checked out beside this repository.
"""
import argparse
import hashlib
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

# One policy for the folder, replacing whatever the surrounding site sets: the page needs WebAssembly, its
# own worker and the studio's fonts, and nothing else.
POLICY = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
          "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; "
          "object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'")

HTACCESS = f"""# Darkroom — static files only, no PHP. Written by scripts/build-web.py; edits here are overwritten.
DirectoryIndex index.html
AddType application/wasm .wasm

<IfModule mod_headers.c>
    # The surrounding site's policy has no 'wasm-unsafe-eval', and two policies intersect rather than
    # replace, so the inherited one is dropped from both tables before this one is set.
    Header unset Content-Security-Policy
    Header always unset Content-Security-Policy
    Header set Content-Security-Policy "{POLICY}"

    # Everything the page pulls in carries this build's version, so it can be kept for a year; the page
    # itself is what points at the new version, and must not be.
    <FilesMatch "\\.(js|css|wasm|jpg)$">
        Header set Cache-Control "public, max-age=31536000, immutable"
    </FilesMatch>
    <FilesMatch "^index\\.html$">
        Header set Cache-Control "no-cache"
    </FilesMatch>

    # Multithreading needs these two. The build is single-threaded for now, so they stay off; turning them
    # on also means serving the fonts with crossorigin.
    # Header set Cross-Origin-Opener-Policy "same-origin"
    # Header set Cross-Origin-Embedder-Policy "require-corp"
</IfModule>

<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE application/wasm application/javascript text/css text/html
</IfModule>
"""


def emcc():
    """emcc from PATH, else from an emsdk checked out beside this repository."""
    found = shutil.which("emcc")
    if found:
        return [found]
    activated = EMSDK / ".emscripten"
    upstream = EMSDK / "upstream/emscripten/emcc"
    if activated.exists() and upstream.exists():
        return [str(upstream)] if os.access(upstream, os.X_OK) else [sys.executable, str(upstream) + ".py"]
    sys.exit(f"emcc not found. Install Emscripten, or check out emsdk at {EMSDK} and run ./emsdk activate latest")


def module(name, debug):
    """The WebAssembly build of the core, as a classic script the worker pulls in with importScripts."""
    subprocess.run(emcc() + [
        str(ROOT / "web/wasm/darkroom.c"), str(CORE / "FinishPixels.c"),
        # web/wasm comes first: it holds the stand-in for libdispatch the core includes.
        "-I", str(ROOT / "web/wasm"), "-I", str(CORE),
        "-O3" if not debug else "-O0",
        "-std=c11", "-Wall", "-Wextra",
        "-sMODULARIZE=1", "-sEXPORT_NAME=createDarkroom", "-sENVIRONMENT=web,worker",
        "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=64MB", "-sSTACK_SIZE=1MB",
        "-sEXPORTED_FUNCTIONS=_dk_apply,_dk_reach,_dk_is_opaque,_dk_premultiply,_dk_unpremultiply,_malloc,_free",
        "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32",
        "-o", str(OUT / name),
    ], check=True)


def build(debug=False):
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    module("darkroom.js", debug)
    for source in sorted(p for p in SRC.iterdir() if p.is_file()):
        shutil.copy2(source, OUT / source.name)

    # One version for the whole build, so what a file references is always what this build produced.
    digest = hashlib.sha256()
    for name in sorted(p.name for p in OUT.iterdir() if p.is_file()):
        digest.update(name.encode())
        digest.update((OUT / name).read_bytes())
    version = digest.hexdigest()[:10]
    for path in OUT.iterdir():
        if path.suffix in {".html", ".js", ".css"}:
            text = path.read_text()
            if "%%V%%" in text:
                path.write_text(text.replace("%%V%%", version))
    (OUT / ".htaccess").write_text(HTACCESS)

    total = sum(p.stat().st_size for p in OUT.iterdir() if p.is_file())
    print(f"Built {OUT} — version {version}, {total / 1024:.0f} KB")
    for path in sorted(OUT.iterdir()):
        if path.is_file():
            print(f"  {path.name:<16} {path.stat().st_size / 1024:8.1f} KB")
    return version


def publish(target):
    """Copies the build into a folder a web server serves, or a repository behind one."""
    target = Path(target).expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    built = {p.name for p in OUT.iterdir() if p.is_file()}
    stale = [p for p in target.iterdir() if p.is_file() and p.name not in built]
    for path in stale:
        path.unlink()
    for name in sorted(built):
        shutil.copy2(OUT / name, target / name)
    left = f", removed {len(stale)} left by an older build" if stale else ""
    print(f"\nPublished {len(built)} files to {target}{left}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--into", help="also copy the build into this folder")
    parser.add_argument("--serve", action="store_true", help="serve build/web on localhost afterwards")
    parser.add_argument("--port", type=int, default=8777)
    args = parser.parse_args()
    build(args.debug)
    if args.into:
        publish(args.into)
    if args.serve:
        subprocess.run([sys.executable, str(ROOT / "scripts/serve-web.py"), "--port", str(args.port)])


if __name__ == "__main__":
    main()
