# ARENA CLOSEOUT07 DELIVERY — 2026-11-08

**Order:** VF-20261108-PARALLEL-CLOSEOUT07.
**Scope:** the two defects reproduced on the owner host, plus a class-**A** sweep. **Not** whole-product closure, **not** acceptance, **not** a claim about the D6 planner.

---

## 1. Identity

| Item | Value |
|---|---|
| Repository | `engmelkhabery1982/Video-Factory` |
| Session branch | `arena/88809335-video-factory` |
| Required reviewed base | `4a3673ef4f1e766844ea88b91539c95f47903fff` |
| Branch parent | `4a3673ef` (unchanged by this delta) |
| Tip | `eaef51c8be17188cc6db8d5a82bd6844844e3404` |
| Remote equality | `git ls-remote origin` = `eaef51c8be17188cc6db8d5a82bd6844844e3404` — equal, normal fast-forward from `4a3673e` |

Nothing was force-pushed, merged to `main`, deployed, or promoted to `review/owner-approved`.

## 2. Changed files

**Modified**

- `apps/api/src/services/editor-render.ts` — path validation at every binary boundary; `PREVIEW_ENCODE_FAILED` naming inputs, outputs and lengths.
- `apps/api/src/services/editor-preview.ts` — owned scratch per job; `renderScratchRoot`, `renderPathReadiness`; settlement-time `finishedAt`.
- `apps/api/src/routes/editor.ts` — pre-`202` `EDITOR_PATH_UNSUPPORTED` refusal on preview and export.
- `scripts/host-qualify.mjs` — four steps added for this delta only.

**Added**

- `apps/api/src/services/editor-render-paths.ts` — the path strategy (pure + ownership).
- `scripts/qualify-render-paths.mjs` — 16 cases.
- `scripts/qualify-export-contracts.mjs` — 7 cases.
- `scripts/qualify-ffmpeg-longpath.mjs` — the finite real-binary check; exits `SKIPPED` without ffmpeg.
- `tests/editor-render-paths.test.ts` — the vitest equivalent, for hosts that have vitest.
- This document; §F appended to `RELEASE_EXIT_MATRIX.md`.

No owner data, output, WAV, draft, timing, frozen revision or existing media was moved, renamed or edited. No system long-path setting was changed. No dependency, engine, provider or download was added.

## 3. Defect 1 — the Windows 262-character export path

**Proven failure (owner host, reused, not re-run):** the export rendered raw frames, then the packaged FFmpeg rejected the 262-character path to `raw-frames.mp4`. The file existed. Copying disposable QA data to a shorter root made the same revision export successfully.

**Root cause:** `renderEditorPreview` wrote the raw render to `path.join(input.workDir, 'raw-frames.mp4')` where `workDir` was `<BUILDTRAKE_DATA>/projects/<projectId>/editor/export-work/<jobId>`. The audio copies and the mux/probe inputs lived under the same long chain, and nothing checked length before invoking a binary.

**Repair, in order of the ffmpeg boundary:**

1. `WORK` path budget — `WINDOWS_MAX_PATH` 259 characters (260 including the NUL), POSIX 4095, plus a 255-byte per-component check.
2. `chooseScratchRoot` — prefer a short app-owned root; otherwise fall back to the short system temp directory; report `sameVolumeAsOutput`.
3. `openEditorRenderScratch` — a uniquely named (`exp-<32 hex>` / `edt-<32 hex>`) directory with an ownership marker; refuses linked roots.
4. `cleanupEditorRenderScratch` — removes only a directory carrying a valid marker with a matching name; never the root, never a link, never unowned content.
5. `assertBinaryReachablePath` — validates a path before `ffmpeg`/`ffprobe` receive it.
6. Routes refuse **before** answering `202` with `EDITOR_PATH_UNSUPPORTED` when the canonical final path could not be opened.

**What stays exactly where it was:** the project id, the draft and editor revisions, the frozen revision, `outputFile` (`…/editor/exports/exp_<id>.mp4`, `…/editor/previews/prv_<id>.mp4`), and the `mediaUrl` strings. Only intermediates move. Silence/audio policy, portrait 1080×1920 and landscape dimensions, frame timing, source hashes and original assets are untouched. `runPreview` never reports `ready` before the verified final file exists, because the status is assigned only after `renderEditorPreview` returns with the probed evidence.

**Honest boundary:** the path-budget and ownership cases are real and executed, but they are **not** Windows compatibility proof. The only check that can show the installed binaries accept these paths is `scripts/qualify-ffmpeg-longpath.mjs`, and it is **NOT RUN** here — no `ffmpeg`/`ffprobe` exist in this environment. It exits `SKIPPED` rather than pretending to pass.

## 4. Defect 2 — completion timestamps that were near creation time

**Root cause:** in `runPreview()` the record was built as `{ ...job, finishedAt: new Date().toISOString() }` **before** `await renderEditorPreview(...)`, so both the `ready` and `failed` records carried a stamp from enqueue time.

**Repair:** `finishedAt` is now assigned once, inside the `ready` branch and inside the `failed` branch, after settlement. `createdAt` is preserved. No duration field was introduced and nothing is relabelled as measured performance — `createdAt` is enqueue time, not start time, so `finishedAt - createdAt` is an upper bound, not a render duration. Interruption semantics in `loadJob` (a running record with no worker reads as failed) are unchanged.

**Proof:** a controlled delayed renderer drives the real lifecycle. With a 120 ms injected delay the persisted record shows a completion offset of at least 100 ms; the failure path is proven the same way with a 60 ms delay. The stand-in proves *when* the stamp is assigned, and nothing about real render duration.

## 5. Executed commands, exact results

Run on Node 22.22.3 in this container, which has **no `node_modules`, no `ffmpeg`, no `ffprobe`, no Chromium**.

```
node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs \
  --test scripts/qualify-render-paths.mjs
  -> # pass 16  # fail 0  # skipped 0

node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs \
  --test scripts/qualify-export-contracts.mjs
  -> # pass 7  # fail 0

node scripts/qualify-ffmpeg-longpath.mjs
  -> SKIPPED (ffmpeg=absent, ffprobe=absent) ... exit 0. NOT RUN, not a pass.

npm run qualify:all        # unchanged scripts, reused not re-derived
  -> 14 passed, 0 failed | steps: 16 passed, 0 failed | 9 passed, 0 failed | 9 passed, 0 failed

node --check scripts/host-qualify.mjs -> OK
```

**Honest skips and non-runs**

| Check | Status | Why |
|---|---|---|
| `tests/editor-render-paths.test.ts` | **NOT RUN** | vitest absent; the same cases run via `qualify-render-paths.mjs` |
| `qualify-ffmpeg-longpath.mjs` | **NOT RUN** | no real ffmpeg/ffprobe; needs the owner host |
| `tsc` build (core → API → web types) | **NOT RUN** | no TypeScript toolchain installed; every absence recorded, nothing installed |
| `vite` web build | **NOT RUN** | same |
| Windows junction check | **skipped in-test** | symlink creation not permitted here; reported as a skip, never a pass |

No historical 134/36 group was re-run, no identical render repeated, no model recommended, no inventory taken. The reviewer's already-passed checks (API error union, corrupt-object handling, `npx`-free host entry, exact source guards, Windows URL/restart, skip accounting, 5 service regressions, 4 HTTP cases, 48 service steps, the synthetic export) were **not** re-run.

## 6. Error codes

`EDITOR_PATH_UNSUPPORTED` and `PREVIEW_ENCODE_FAILED` are new. No core change was needed: `EditorError.code` is an open `string` in `packages/core/src/editor/document.ts:193`, so there is no closed union to extend — the defect class the reviewer hit with `FACTORY_DRAFT_CORRUPT` does not apply here. The browser already surfaces these messages: `apps/web/src/lib/editor-api.ts:55` prefers `data.error`, and it was verified against a real 409 body that the exact server text reaches the UI.

## 7. Class-A sweep — the bounded conclusion

Every row labelled **A** in `RELEASE_EXIT_MATRIX.md` §A and §B reads "IMPLEMENTED" or "None found in code". One row was stale and is corrected in §F.3 of the matrix: input row **8** claimed the multipart storyboard route was missing, but it exists at `apps/api/src/routes/factory-imports.ts:42` (`POST /api/factory/imports/storyboard-pdf`), is registered at `apps/api/src/server.ts:225`, checks measured `%PDF-` magic, enforces `PDF_MAX_BYTES`, requires source and licence, and only writes asset files after the whole multipart message is processed — so row 8's remaining work is `HTTP` execution (fastify absent) and owner documents, class **B**/**C**.

**Conclusion, with file-level evidence:** no further independently executable implementation gap remains in the existing services, editor or routes. Everything still open is (b) implemented but awaiting real runtime or output — rendered pixels per family, real inpainting, real ASR, native capture — or (c) human consent, listening, quality and release. The D6 planner belongs to the owner-host workstream and was not touched in any way.

## 8. Rollback

- This increment is additive plus four localized edits; `git revert <tip>` restores the base exactly, since the branch parent is `4a3673ef`.
- No storage migration, no schema change, no data rewrite. `PreviewJobRecord` gained **optional** fields (`workDir`, `scratchDir`, `scratchName`), so records written by the base still load and a reverted build still reads records written here.
- Scratch directories are created under `<data>/projects/<id>/editor/{export,preview}-work/` (or the system temp directory) and removed in a `finally`. A crash can leave one behind; the next run does not touch it, because cleanup requires the ownership marker and a matching `exp-<32 hex>`/`edt-<32 hex>` name. Any leftover is an inert directory that can be deleted by hand.
- No owner data, media, WAV or draft was modified, so no data rollback is required.

## 9. Finite host follow-up (owner host, smallest first)

1. `node scripts/qualify-ffmpeg-longpath.mjs --owner-path` — the real 262-character reproduction against the installed binary. This is the only check that can turn Defect 1 into a proven repair.
2. `npm run qualify:host` — runs build → types → web build → the four canonical scripts → the two new scripts → `tests/editor-render-paths.test.ts` → the real-ffmpeg step. All are wired into the existing entry; nothing was added outside it.
3. One real editor export from a project whose data root is deep enough to have produced the original failure, then confirm the file plays and the reported `finishedAt` follows the completion, not the enqueue.

## 10. What this increment is not

Not acceptance. Not whole-product closure. Not a Windows compatibility proof. Not a creative, cinematic or listening judgement. The reviewer integrates only this delta alongside the owner-host D6 work, runs the remaining feasible host checks and decides acceptance.
