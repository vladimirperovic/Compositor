# Compositor with Darkroom and Enlarger

This fork is [Compositor](https://github.com/robbietilton/Compositor) plus two features of our own: **Darkroom**, a
finishing workspace for renders, and **Enlarger**, AI upscaling with Real-ESRGAN (see [docs/darkroom.md](docs/darkroom.md)).

Both were offered upstream and declined: [#71](https://github.com/robbietilton/Compositor/pull/71) (the separate
workspace didn't fit the app's style, though it prompted upstream's own Vignette, Bloom / Glow and Tonal Contrast
filters in 1.2.4) and [#73](https://github.com/robbietilton/Compositor/pull/73) (upstream would rather rethink AI
features as a whole). So this fork carries them on top of every new upstream release.

## Branches

| Branch | Contents | Merged from |
|---|---|---|
| `main` | an exact copy of upstream's `main` | upstream `main` (fast-forward only) |
| `studio` | the app we use: upstream, Darkroom, Enlarger, this file and the fork's scripts | `main` |
| `feature/darkroom`, `feature/enlarger` | frozen snapshots of pull requests #71 and #73 | nothing |

Everything now happens on `studio`. The two feature branches are kept only as a record of what was offered upstream;
they are no longer merged into or updated. Keep `main` free of our commits so it always matches upstream.

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
git push origin main studio
```

The script fetches upstream, fast-forwards `main`, merges it into `studio` and runs the C checks. Run the Swift suites
too after larger upstream changes:

```sh
COMPOSITOR_AI_MODEL_PATH=/path/RealESRGAN_x4plus.pth python3 scripts/test-swift.py --all
```

## Where our code touches upstream's

Almost all of Darkroom and Enlarger lives in files of our own (`RenderFinish*`, `RenderComparison*`, `FinishPixels.c`,
`ESRGAN*`, `AIUpscale*`, `EnlargerStep.swift`, their tests and docs). Upstream's own files carry as little of ours as
possible, so their changes and ours rarely land on the same lines:

| Upstream file | What we add |
|---|---|
| `Rendering/EditorCanvas.swift` | one-line `darkroom…` calls in the draw, mouse, cursor and key methods; everything they call sits in one block at the end of the class, marked `MARK: - Darkroom (fork)` |
| `Document/Filters.swift` | the `renderFinish` filter kind, its settings, one `darkroom` property on `FilterEdit` (all Darkroom's per-edit state is in `DarkroomEdit`), the preview job's cache, and the Apply hook |
| `Document/EditorSession.swift` | `filterEdit == nil` in `canUseHistory`, and the zoom anchor seam |
| `IO/ProjectController.swift` | `aiUpscale(factor:autoStart:)`, which calls into our own file |
| `ContentView.swift`, `CompositorApp.swift`, `UI/FilterSheet.swift`, `UI/KeyboardShortcuts.swift`, `Rendering/CanvasViewport.swift`, the bridging header | the workspace swap, the menu items, one `switch` case, the `\` shortcut, `nonisolated` on `zoomRange`, two imports |

When a merge does conflict, the answer is nearly always "keep both sides": upstream added something next to our seam.
`git rerere` is enabled, so a conflict resolved once is replayed automatically the next time it appears. If upstream
renames or rewrites what a seam calls into, the compiler and the tests say so immediately — that is a code change on
our side, not a merge puzzle.

## Building the fork's app

```sh
python3 scripts/build-studio.py --open        # optimized; --debug builds faster
```

This builds `build/Compositor Darkroom.app` with the Command Line Tools (no Xcode needed). It has its own bundle
identifier and no update feed, so upstream's Sparkle updates cannot replace it; its version reads like `1.2.2-darkroom`,
after the upstream release it is built on. Sparkle.framework is taken from an app already in `build/` or
`--sparkle-framework`. To distribute builds to other people, sign them with your own Developer ID and use your own
update feed, if any.
