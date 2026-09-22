#!/usr/bin/env python3
"""Build this fork's app — Compositor with Darkroom and Enlarger — without Xcode.

Uses the Command Line Tools' Swift compiler and SDK. The result, build/Compositor Darkroom.app, has its own bundle
identifier and no update feed, so upstream's Sparkle updates can never replace it. Optimized by default; pass --debug
for a faster, unoptimized build.

    python3 scripts/build-studio.py [--debug] [--sparkle-framework /path/Sparkle.framework] [--open]

Sparkle.framework is taken from --sparkle-framework, else from an app already in build/, else from
/tmp/compositor-check (where earlier local builds unpacked it). Nothing is downloaded.
"""

import argparse
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
APP = BUILD / "Compositor Darkroom.app"
# The identifier earlier local builds used, so saved presets and the downloaded model stay where they are.
BUNDLE_ID = "local.compositor.render-finish"


def sparkle(explicit):
    candidates = [explicit] if explicit else []
    candidates += sorted(BUILD.glob("*.app/Contents/Frameworks/Sparkle.framework"))
    candidates.append(Path("/tmp/compositor-check/sparkle-real/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"))
    for candidate in candidates:
        if candidate and (Path(candidate) / "Sparkle").exists():
            return Path(candidate).resolve()
    sys.exit("Sparkle.framework not found: pass --sparkle-framework /path/to/Sparkle.framework")


def project_setting(name, fallback):
    """The app target's build setting from the Xcode project (the last, Release, value)."""
    values = re.findall(rf"{name} = ([^;]+);", (ROOT / "Compositor.xcodeproj/project.pbxproj").read_text())
    return values[-1].strip().strip('"') if values else fallback


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--debug", action="store_true", help="unoptimized build (faster to compile)")
    parser.add_argument("--sparkle-framework", type=Path)
    parser.add_argument("--open", action="store_true", help="open the app when built")
    args = parser.parse_args()

    framework = sparkle(args.sparkle_framework)
    target = project_setting("MACOSX_DEPLOYMENT_TARGET", "26.5")
    # The SDK matching the project's deployment target when installed; a newer default SDK can reject this source.
    default = Path(subprocess.check_output(["xcrun", "--show-sdk-path"], text=True).strip())
    matching = default.parent / f"MacOSX{target}.sdk"
    sdk = str(matching if matching.exists() else default)
    work = BUILD / "studio"
    work.mkdir(parents=True, exist_ok=True)
    if APP.exists() and framework.is_relative_to(APP):
        framework = Path(shutil.copytree(framework, work / "Sparkle.framework", dirs_exist_ok=True))
    shutil.rmtree(APP, ignore_errors=True)
    macos = APP / "Contents/MacOS"
    macos.mkdir(parents=True)

    objects = []
    for source in sorted((ROOT / "Compositor/Rendering").glob("*.c")):
        obj = work / (source.stem + ".o")
        subprocess.run(["clang", "-O2", "-isysroot", sdk, f"-mmacosx-version-min={target}", "-c", source, "-o", obj], check=True)
        objects.append(obj)
    features = ["MemberImportVisibility", "NonisolatedNonsendingByDefault", "InferIsolatedConformances",
                "DisableOutwardActorInference", "GlobalActorIsolatedTypesUsability"]
    command = ["swiftc", "-emit-executable", "-whole-module-optimization", "-g", "-Onone" if args.debug else "-O",
               "-sdk", sdk, "-target", f"arm64-apple-macos{target}", "-module-name", "Compositor", "-swift-version", "5",
               "-default-isolation", "MainActor", "-F", framework.parent, "-framework", "Sparkle",
               "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
               "-module-cache-path", work / "module-cache",
               "-import-objc-header", ROOT / "Compositor/Compositor-Bridging-Header.h", "-o", macos / "Compositor"]
    for feature in features:
        command += ["-enable-upcoming-feature", feature]
    command += sorted((ROOT / "Compositor").rglob("*.swift")) + objects
    log = work / "build.log"
    with log.open("w") as output:
        # In the work folder, so the compiler's side files don't land in the repository.
        result = subprocess.run([str(part) for part in command], stdout=output, stderr=subprocess.STDOUT, cwd=work)
    if result.returncode:
        print(log.read_text()[-12000:], file=sys.stderr)
        sys.exit(result.returncode)

    shutil.copytree(framework, APP / "Contents/Frameworks/Sparkle.framework", symlinks=True)
    info = plistlib.loads((ROOT / "Config/Info.plist").read_bytes())
    for key in ["SUFeedURL", "SUPublicEDKey", "SUEnableInstallerLauncherService"]:
        info.pop(key, None)
    info.update(CFBundleExecutable="Compositor", CFBundleIdentifier=BUNDLE_ID, CFBundleName="Compositor Darkroom",
                CFBundleDisplayName="Compositor Darkroom", CFBundlePackageType="APPL", SUEnableAutomaticChecks=False,
                CFBundleShortVersionString=project_setting("MARKETING_VERSION", "1.0") + "-darkroom",
                CFBundleVersion=project_setting("CURRENT_PROJECT_VERSION", "1"), LSMinimumSystemVersion=target,
                NSHighResolutionCapable=True)
    (APP / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", APP], check=True, capture_output=True)
    print(f"Built {APP}")
    if args.open:
        subprocess.run(["open", APP])


if __name__ == "__main__":
    main()
