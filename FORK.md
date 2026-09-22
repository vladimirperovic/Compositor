# Compositor with Darkroom and Enlarger

This fork is [Compositor](https://github.com/robbietilton/Compositor) plus two features offered upstream as pull
requests: **Darkroom**, a finishing workspace for renders, and **Enlarger**, AI upscaling with Real-ESRGAN (see
[docs/darkroom.md](docs/darkroom.md)). If upstream takes them, this fork only has to follow upstream; if not, it keeps
them on top of every new upstream release.

## Branches

| Branch | Contents | Merged from |
|---|---|---|
| `main` | an exact copy of upstream's `main` | upstream `main` (fast-forward only) |
| `feature/darkroom` | Darkroom — pull request 1 | `main` |
| `feature/enlarger` | Enlarger — pull request 2, needs Darkroom | `feature/darkroom` |
| `studio` | the app we use: everything above, plus this file and the fork's scripts | `feature/enlarger` |

Changes to Darkroom go on `feature/darkroom`, changes to Enlarger on `feature/enlarger`, and fork-only files on
`studio`; the sync script carries each one forward. Keep `main` free of our commits so it always matches upstream.

## Remotes

After forking on GitHub, point `origin` at the fork and keep the original as `upstream`:

```sh
git remote rename origin upstream        # github.com/robbietilton/Compositor
git remote add origin https://github.com/<your-account>/Compositor.git
git push -u origin main feature/darkroom feature/enlarger studio
```

## Following upstream

```sh
sh scripts/sync-upstream.sh
git push origin main feature/darkroom feature/enlarger studio
```

The script fetches upstream, fast-forwards `main`, then merges `main` → `feature/darkroom` → `feature/enlarger` →
`studio` and runs the Darkroom checks. On a conflict it stops on that branch: resolve, commit, and run it again. Merges
rather than rebases keep the pull requests' history intact; avoid force-pushing branches others use. Run the Swift
suites with `python3 scripts/test-swift.py` (add `COMPOSITOR_AI_MODEL_PATH=/path/RealESRGAN_x4plus.pth` for the GPU
cases) after larger upstream changes.

If upstream merges a pull request, its commits arrive through `main`; the merge into the feature branch then brings
nothing new for those files, and the branch can be retired once nothing remains on it.

## Building the fork's app

```sh
python3 scripts/build-studio.py --open        # optimized; --debug builds faster
```

This builds `build/Compositor Darkroom.app` with the Command Line Tools (no Xcode needed). It has its own bundle
identifier and no update feed, so upstream's Sparkle updates cannot replace it; its version reads like `1.2.2-darkroom`,
after the upstream release it is built on. Sparkle.framework is taken from an app already in `build/` or
`--sparkle-framework`. To distribute builds to other people, sign them with your own Developer ID and use your own
update feed, if any.
