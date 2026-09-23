#!/bin/sh
# Brings the original Compositor's latest main into this fork:
#   upstream/main → main → studio
# feature/darkroom and feature/enlarger are frozen snapshots of the two pull requests and are left alone.
# Stops at a merge conflict so it can be resolved (then run the script again); git rerere replays the
# resolutions we have already made for the same conflicts.
set -eu
cd "$(dirname "$0")/.."

# The original project: the `upstream` remote, or whichever remote points at robbietilton/Compositor.
remote=$(git remote -v | awk '/robbietilton\/Compositor(\.git)? \(fetch\)/ { print $1; exit }')
[ -n "$remote" ] || { echo "No remote points at github.com/robbietilton/Compositor."; exit 1; }
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Commit or stash your changes first."; exit 1
fi
start=$(git branch --show-current)
git fetch "$remote" --tags
git checkout -q main
git merge --ff-only "$remote/main"
git config rerere.enabled true
git config rerere.autoupdate true
git checkout -q studio
if ! git merge --no-edit main; then
    echo
    echo "Merge conflict on studio. Our code sits behind one-line \`darkroom…\` seams and in blocks marked"
    echo "\"MARK: - Darkroom (fork)\"; keeping both sides is almost always the answer. See FORK.md."
    echo "Resolve, commit, then run this script again."
    exit 1
fi
git checkout -q "$start"
echo
echo "Up to date with $remote/main ($(git rev-parse --short "$remote/main")). Running the checks:"
sh scripts/test-render-finish.sh
