#!/bin/sh
# Brings the original Compositor's latest main into this fork, branch by branch:
#   upstream/main → main → feature/darkroom → feature/enlarger → studio
# Stops at the first merge conflict so it can be resolved (then run the script again).
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
parent=main
for branch in feature/darkroom feature/enlarger studio; do
    git checkout -q "$branch"
    if ! git merge --no-edit "$parent"; then
        echo
        echo "Merge conflict on $branch. Resolve it, commit, then run this script again."
        exit 1
    fi
    parent=$branch
done
git checkout -q "$start"
echo
echo "Up to date with $remote/main ($(git rev-parse --short "$remote/main")). Running the checks:"
sh scripts/test-render-finish.sh
