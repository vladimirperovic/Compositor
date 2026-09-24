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
import re
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

# The policy for the folder. It is the site's own policy — so a page that brings its header and footer
# keeps its fonts, analytics and maps — with what WebAssembly and a worker need added: without
# 'wasm-unsafe-eval' the module does not compile at all. Keep it in step with the site's root .htaccess.
POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://www.google.com https://www.gstatic.com "
    "https://www.googletagmanager.com https://www.google-analytics.com; "
    "worker-src 'self' blob:; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; "
    "img-src 'self' data: blob: https:; media-src 'self' blob:; "
    "connect-src 'self' https://www.google.com https://www.google-analytics.com https://*.google-analytics.com "
    "https://www.googletagmanager.com https://*.analytics.google.com https://googleads.g.doubleclick.net "
    "https://*.g.doubleclick.net; "
    "frame-src https://www.google.com https://maps.google.com; "
    "frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests"
)

HTACCESS = f"""# Darkroom — static files only, no PHP. Written by scripts/build-web.py; edits here are overwritten.
AddType application/wasm .wasm
# index.php first: a page that brings the site's header and footer takes precedence over the standalone one.
DirectoryIndex index.php index.html

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
        "-sEXPORTED_FUNCTIONS=_dk_apply,_dk_expand,_dk_reach,_dk_is_opaque,_dk_premultiply,_dk_unpremultiply,_malloc,_free",
        "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32",
        "-o", str(OUT / name),
    ], check=True)


SCOPE = "#darkroom"


def scope_selectors(prelude):
    """Every selector is put under the tool's own element, so a page around it keeps its styles."""
    kept = ""
    text = prelude
    while True:
        found = re.match(r"\s*(/\*.*?\*/)\s*", text, re.S)
        if not found:
            break
        kept += text[:found.end()]
        text = text[found.end():]
    written = []
    for selector in (part.strip() for part in text.split(",")):
        if not selector:
            continue
        if SCOPE in selector:
            written.append(selector)          # already says where it belongs
        elif selector in (":root", "html", "body"):
            written.append(SCOPE)
        elif selector == "*":
            written.append(f"{SCOPE}, {SCOPE} *")
        elif selector.startswith("body"):
            # A class on <body> stays where it is; what it selects moves under the tool.
            head, _, rest = selector.partition(" ")
            written.append(head if not rest else f"{head} {SCOPE} {rest}")
        else:
            written.append(f"{SCOPE} {selector}")
    unique = list(dict.fromkeys(written))
    return kept + ",\n".join(unique) + " "


def scope_css(css):
    out = ""
    at = 0
    while at < len(css):
        opening = css.find("{", at)
        if opening < 0:
            out += css[at:]
            break
        prelude = css[at:opening]
        depth, cursor = 1, opening + 1
        while cursor < len(css) and depth:
            depth += (css[cursor] == "{") - (css[cursor] == "}")
            cursor += 1
        body = css[opening + 1:cursor - 1]
        # A comment sits in the prelude of the rule after it, so what kind of rule this is has to be
        # decided on the prelude without its comments — or an @media ends up scoped like a selector.
        head = re.sub(r"/\*.*?\*/", "", prelude, flags=re.S).strip()
        if head.startswith("@keyframes") or head.startswith("@font-face"):
            out += prelude + "{" + body + "}\n"
        elif head.startswith("@"):
            out += prelude + "{" + scope_css(body) + "}\n"
        else:
            out += scope_selectors(prelude) + "{" + body + "}\n"
        at = cursor
    return out


def build(debug=False):
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    module("darkroom.js", debug)
    for source in sorted(p for p in SRC.iterdir() if p.is_file()):
        shutil.copy2(source, OUT / source.name)

    # The page is the tool with a page around it; the partial is the tool on its own, for a site that
    # brings its own header and footer. Both put it inside #darkroom, which the stylesheet is scoped to.
    tool = (SRC / "tool.html").read_text()
    (OUT / "index.html").write_text((SRC / "index.html").read_text().replace("<!--TOOL-->", tool))
    (OUT / "tool.html").write_text(
        '<link rel="stylesheet" href="/darkroom/style.css?v=%%V%%">\n'
        f'<div id="darkroom" data-chrome="page">\n{tool}</div>\n'
        '<script type="module" src="/darkroom/app.js?v=%%V%%"></script>\n')
    (OUT / "style.css").write_text(scope_css((SRC / "style.css").read_text()))

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


MANIFEST = ".darkroom-build"


def publish(target):
    """Copies the build into a folder a web server serves, or a repository behind one.

    Only files an earlier build of ours put there are ever removed — the folder is also where a site keeps
    its own index.php, and deleting that would take the page down.
    """
    target = Path(target).expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    built = {p.name for p in OUT.iterdir() if p.is_file()}
    previous = set()
    record = target / MANIFEST
    if record.exists():
        previous = {line.strip() for line in record.read_text().splitlines() if line.strip()}
    stale = sorted(previous - built)
    for name in stale:
        (target / name).unlink(missing_ok=True)
    for name in sorted(built):
        shutil.copy2(OUT / name, target / name)
    record.write_text("\n".join(sorted(built)) + "\n")
    theirs = sorted(p.name for p in target.iterdir()
                    if p.is_file() and p.name not in built and p.name != MANIFEST)
    left = f", removed {len(stale)} left by an older build" if stale else ""
    kept = f", left {', '.join(theirs)} alone" if theirs else ""
    print(f"\nPublished {len(built)} files to {target}{left}{kept}")


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
