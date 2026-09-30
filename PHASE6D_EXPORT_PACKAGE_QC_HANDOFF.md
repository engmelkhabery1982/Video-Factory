# Phase 6D — Production Export Package + QC — Handoff

**Phase 6D turns the approved Phase 6C delivery output into a deterministic, auditable
production DELIVERY PACKAGE.**

Phase 6D does **NOT** create video content, generate Long/Short plans, render through the
legacy Storyboard/`Scene[]` path, publish/upload anywhere, or create archives.

---

## 1. Approved baseline

| | |
|---|---|
| Approved Phase 6C baseline | `53b10bc66415c3ede9154ca4c65cc6cd518a9573` |
| Baseline subject | `docs(delivery): hand off phase6c delivery targets` |
| Phase 6A / 6B / 6C | CLOSED — not reopened, not redesigned, not rewritten |

The baseline is the tip of `origin/arena/01a0f25c-video-factory`. It was fetched read-only
and this session branch was pointed at that exact SHA **before any edit**; `git rev-parse
HEAD` equalled it and the working tree was clean.

Phases 6A, 6B and 6C were **not** modified. The only pre-existing files touched are the two
"MINIMAL" files allowed by the Phase 6D file-ownership rule:

* `packages/core/src/scenario/index.ts` — two added `export *` lines.
* `.gitignore` — one added line for the `.test-phase6d/` test scratch directory (same
  convention as `.test-phase6b/` and `.test-phase6c/`).

## 2. Arena branch

| | |
|---|---|
| Arena branch | `arena/01a0f28c-video-factory` |
| Baseline | `53b10bc66415c3ede9154ca4c65cc6cd518a9573` |
| Commit 1 | `feat(package): add plan-based production delivery package` |
| Commit 2 | `feat(qc): add package integrity and media quality validation` |
| Commit 3 | `test(package): validate long short and partial delivery packaging` |
| Commit 4 | `docs(package): hand off phase6d export package and qc` |
| Commit 5 (safety correction) | `fix(package): reject symlink escape paths` |
| Final HEAD | five commits on top of `53b10bc` (see `git log -1` on the branch) |

History is a plain descendant chain: no force push, no rebase, no history rewrite, no merge
to `main`. `main`, `arena/01a0f25c-video-factory`, `arena/01a0f1a5-video-factory`,
`arena/01a0f15b-video-factory` and `freebuff/phase6a-renderer-assets` were read only
(`git fetch`), never written to.

## 3. Exact files changed

**New**

| File | Purpose |
|---|---|
| `packages/core/src/scenario/delivery-package-types.ts` | The Phase 6D package contract. |
| `packages/core/src/scenario/delivery-package-pipeline.ts` | The pure, filesystem-free package planner. |
| `apps/api/src/services/plan-package.ts` | The package materialiser (copy, hash, probe, write). |
| `tests/phase6d-delivery-package.test.ts` | 60 contract tests. |
| `tests/phase6d-real-package.test.ts` | 10 real-render package tests. |
| `PHASE6D_EXPORT_PACKAGE_QC_HANDOFF.md` | This document. |

**Minimal edits**

| File | Change |
|---|---|
| `packages/core/src/scenario/index.ts` | `export * from './delivery-package-types.js'` and `'./delivery-package-pipeline.js'`. |
| `.gitignore` | Added `.test-phase6d/` (test scratch, same convention as 6B/6C). |

**Explicitly NOT touched** — `apps/api/src/services/render.ts`, `apps/api/src/services/plan-delivery.ts`,
`apps/api/src/services/pipeline.ts`, `packages/core/src/targets.ts`, all
`packages/core/src/scenario/delivery-target-*`, all Phase 6A/6B/Phase 5 source, and
`apps/web/**`. No defect in a closed phase was found, so nothing was silently fixed.

**Safety correction (after the first closure review)**

A package-root safety defect was found during Phase 6D testing and corrected
**before** Phase 6D was declared closed. The original Phase 6D commits are
untouched; the correction is one extra commit on top.

| File | Change |
|---|---|
| `tests/phase6d-package-root-safety.test.ts` | **New.** 22 isolated-temporary-tree symlink-escape tests (§26.3). |
| `apps/api/src/services/plan-package.ts` | Layer-2 filesystem guard (`assertSafePackageRoot`, `assertSafePackagePath`, `ensureSafePackageDir`, `ensureSafePackageRootDir`, `removeSafePackageDir`); every copy/write/delete re-proved. |
| `packages/core/src/scenario/delivery-package-pipeline.ts` | Documentation only: `validateProductionPackageRoot` is now described as "layer 1 of 2", with the false "a symlink cannot smuggle an escape past it" claim withdrawn. No logic change. |

The correction changes **no** contract: package layout, manifest schema, checksum
schema, caption behaviour, QC result schema, production/test-evidence modes,
duration tolerance, package status semantics, target ordering, render contracts
and source-integrity semantics are all identical.

## 4. Package API

### Core (plan-based, filesystem-free)

```ts
import {
  PRODUCTION_DELIVERY_PACKAGE_VERSION,        // '1.0.0'
  buildProductionDeliveryPackage,              // the planner
  validateProductionPackageRoot,              // package-root safety
  collectPlanCaptionCues,                     // plan-derived caption flattening + validation
  buildCaptionDocument,
  renderPackageQcMarkdown,
  packageTargetDirectory, packageTargetFile,
  serialisePackageJson, sha256Hex, parseFpsRatio,
  PRODUCTION_PACKAGE_DURATION_POLICY,
  PRODUCTION_PACKAGE_VIDEO_CODEC_FAMILY,
  PRODUCTION_PACKAGE_AUDIO_CODEC_FAMILY,
  PRODUCTION_PACKAGE_TEST_EVIDENCE_DOWNGRADED_CODES,
  PRODUCTION_PACKAGE_ROOT_ENTRIES,
} from '@buildtrack/core';
```

```ts
buildProductionDeliveryPackage({
  targetSet,      // ProductionDeliveryTargetSet  — the identity authority
  renderResult,   // ProductionDeliveryRenderResult — the media outcome authority
  packageRoot,    // must be a strict descendant of the repository root (lexically)
                  // AND symlink-free on the real filesystem — see below
  repoRoot,       // default: process.cwd() in core, ROOT in the API service
  mediaByTarget,  // per-target measured evidence (see below)
  mode,           // 'production' (default) | 'test-evidence'
}): ProductionDeliveryPackage
```

The planner performs **no** filesystem I/O except hashing the text it has just produced. It
returns the complete package as data: `files` (text `contents` plus one `copyFrom` per target),
`manifest`, `summary`, `checksums`, `targets`, `findings`, `removePaths`.

### API (materialiser)

```ts
import {
  buildProductionDeliveryPackage,   // apps/api/src/services/plan-package.ts
  ProductionDeliveryPackageError,
  productionPackageErrors, productionPackageErrorCodes,
  type ProductionDeliveryPackageBuildResult,
  type ProductionPackageSourceIntegrity,
} from '../apps/api/src/services/plan-package.js';

await buildProductionDeliveryPackage({
  targetSet, renderResult, packageRoot,
  mode,        // default 'production'
  clean,       // 'stale' (default) | 'none' | 'full'
  repoRoot,    // default ROOT
});
```

Order of operations, all before any write:

1. Refuse an unsafe `packageRoot` (`ProductionDeliveryPackageError`, code
   `PACKAGE_ROOT_UNSAFE`). This is a **two-layer** check — see
   "Package-root safety (two layers)" below.
2. Refuse to clear a directory that is not a delivery package.
3. SHA256 each source render output.
4. **Copy** each successful render output to its package directory (never move).
   The destination directory and the destination file are both re-proven safe
   immediately before the copy.
5. SHA256 + `analyseFile(...)` probe of the **copied** file.
6. Hand everything to the pure planner.
7. Write exactly the files the planner produced; drop failed-target directories.
   Every write destination is re-proven safe immediately before the write.
8. Re-hash the sources to prove they were not mutated.

### Package-root safety (two layers)

A package path is only safe to write through when **both** layers hold.

**Layer 1 — lexical (core, filesystem-free).**
`validateProductionPackageRoot` resolves the path and requires it to be a
*strict descendant of the repository root*. It refuses the repo root, the
filesystem root, every ancestor and every sibling, including lexical `..`
escapes. This layer is **necessary but NOT sufficient on its own**: it inspects
only the text of the path, never the filesystem.

> **Correction.** Earlier revisions of this document and of the core planner
> claimed that lexical resolution alone meant "a symlink cannot smuggle an
> escape past it". **That claim was false** and is withdrawn. A path such as
> `<repo>/delivery-package` is lexically inside the repository while being a
> symbolic link to `/tmp/outside` or to a home directory. The same is true of
> every nested package-owned directory (`long`, `shorts`, `shorts/short_1`,
> `manifest`, `evidence`). A package-root safety defect of exactly this shape
> was discovered during Phase 6D testing and corrected before closure; see §26.

**Layer 2 — real filesystem (API service).**
`assertSafePackageRoot(...)` in `apps/api/src/services/plan-package.ts` resolves
the repository root to its real path (`realpathSync`) and requires that:

* every existing component from the repo root down to the package root is a
  real path, **not** a symlink (`lstatSync` — no link following);
* the package root itself is not a symlink, even as the final component;
* when the path exists, its `realpathSync` still lies strictly inside the real
  repository root.

**Per-operation guard (not a one-time check).**
A validated root does not make its children safe: a nested package-owned
directory can be replaced by a symlink after the root was accepted. Every single
`mkdirSync`, `writeFileSync`, `copyFileSync` and recursive delete is therefore
preceded by `assertSafePackagePath(packageRoot, destination)`, which applies the
same rule below the package root and re-checks containment after
`mkdir -p` / immediately before the destructive call.

**Cleanup.**

* `clean: 'full'` re-proves, *immediately before* `fs.rmSync`, that the root is
  still a real (non-symlink) directory strictly inside the real repo root, that
  it still contains nothing but `PRODUCTION_PACKAGE_ROOT_ENTRIES`, and that no
  package-owned entry (`manifest`, `evidence`, `long`, `shorts`) is a symlink.
* `clean: 'stale'` and every `pkg.removePaths` directory go through
  `removeSafePackageDir`, which refuses a symlinked candidate outright rather
  than following it to an external target.

An unsafe path aborts the **entire build** with `PACKAGE_ROOT_UNSAFE` and a
matching finding. It is explicitly re-thrown out of the per-target copy loop and
is never downgraded into a target-level error, so the service can never "package
around" an escape.

**Error code.** `PACKAGE_ROOT_UNSAFE`, already in the closed 13-code Phase 6D
vocabulary; the correction adds no code and changes no contract.

## 5. Package contract version

```
PRODUCTION_DELIVERY_PACKAGE_VERSION = '1.0.0'
```

Recorded in `manifest/delivery_manifest.json`, `evidence/package_summary.json`, every
`target.json` and every `captions.json`.

## 6. Type names

| Concept | Type |
|---|---|
| Package | `ProductionDeliveryPackage` |
| Per target | `ProductionDeliveryPackageTarget` |
| Manifest | `ProductionDeliveryPackageManifest`, `ProductionPackageManifestTargetEntry` |
| Finding | `ProductionPackageFinding`, `ProductionPackageFindingCode` |
| Summary | `ProductionDeliveryPackageSummary` |
| QC result | `ProductionTargetQcResult` |
| QC metrics | `ProductionTargetQcMetrics`, `ProductionTargetTechnicalMetrics` |
| Media evidence | `ProductionPackageMediaEvidence` |
| Build input | `BuildDeliveryPackageInput` |
| Statuses | `ProductionDeliveryPackageStatus` (`ready`/`partial`/`blocked`), `ProductionPackageTargetStatus` (`packaged`/`failed`), `ProductionTargetQcStatus` (`pass`/`warn`/`fail`), `ProductionPackageMode` |
| Layout | `ProductionDeliveryPackageFile`, `ProductionPackageChecksumEntry`, `ProductionPackageTargetDescriptor`, `ProductionPackageCaptionCue`, `ProductionPackageCaptionDocument` |

### Finding vocabulary (19 codes, closed)

`PACKAGE_ROOT_UNSAFE`, `PACKAGE_RENDER_RESULT_MISMATCH`, `PACKAGE_RENDER_FAILED`,
`PACKAGE_TARGET_MISMATCH`, `PACKAGE_PLAN_INVALID`, `PACKAGE_FILE_MISSING`,
`PACKAGE_FILE_EMPTY`, `PACKAGE_MEDIA_PROBE_FAILED`, `PACKAGE_CHECKSUM_MISMATCH`,
`PACKAGE_VIDEO_CODEC_MISMATCH`, `PACKAGE_DIMENSIONS_MISMATCH`, `PACKAGE_FPS_MISMATCH`,
`PACKAGE_AUDIO_MISSING`, `PACKAGE_AUDIO_CODEC_MISMATCH`, `PACKAGE_DURATION_TRUNCATED`,
`PACKAGE_DURATION_EXCESSIVE`, `PACKAGE_AUDIO_SILENT`, `PACKAGE_PARTIAL_FRAME_COVERAGE`,
`PACKAGE_CAPTION_INVALID`.

The Phase 6D spec named 13; `PACKAGE_ROOT_UNSAFE`, `PACKAGE_RENDER_FAILED`,
`PACKAGE_MEDIA_PROBE_FAILED`, `PACKAGE_DURATION_EXCESSIVE`, `PACKAGE_AUDIO_SILENT` and
`PACKAGE_PARTIAL_FRAME_COVERAGE` were added because they are genuine, distinguishable
outcomes that would otherwise have to be mislabelled. The set stays small and closed, and
Phase 6B's `PlanRenderErrorCode` is reused rather than duplicated.

## 7. Package directory layout

```
<packageRoot>/
  manifest/
    delivery_manifest.json
    checksums.sha256
  long/
    video.mp4  captions.srt  captions.vtt  captions.json
    target.json  qc.json  qc.md
  shorts/
    short_1/
      video.mp4  captions.srt  captions.vtt  captions.json
      target.json  qc.json  qc.md
    short_2/ ...
    short_3/ ...
  evidence/
    package_summary.json
```

* No directory is ever created for an unrequested target. A Short directory exists **only**
  when that Short is packaged.
* A failed or QC-failed target receives **no media package at all** — the whole target
  directory is removed, and the manifest records the target with `status: "failed"`, its
  error code and its findings.
* `clean: 'stale'` (default) also removes a target directory left by an earlier build of the
  same root, so a stale `short_2/video.mp4` can never survive into a new package.
* Names are fixed constants. The **manifest is the identity authority**, not a filename.

## 8. Package status rules

| Status | Meaning |
|---|---|
| `ready` | Every requested target rendered, passed required QC **and** carries full plan frame coverage, built in `production` mode. `readyForProductionDelivery: true`. |
| `partial` | At least one requested target is validly packaged, but another requested target failed, or a packaged target is not yet production-ready (test evidence, sub-range render). |
| `blocked` | Nothing is safely packageable, or the package failed an integrity rule. `readyForProductionDelivery: false` always. |

A failed target is **never** downgraded to a warning to make a package ready, and one target
failing never removes another target's artifacts.

`readyForProductionDelivery` is the single field a caller may gate delivery on, and it is
`true` only when `status === 'ready' && mode === 'production'`.

A blocked package may still write an audit manifest; it simply never claims readiness.

## 9. Target status rules

| Target status | Meaning |
|---|---|
| `packaged` | A real, non-empty MP4 was copied, and QC produced no error-severity finding. `qc.status` is `pass` or `warn`. |
| `failed` | The render failed, the target was not delivered by the target set, identity mismatched, the plan is invalid, captions are invalid, or QC produced an error finding. The target directory is removed. |

`productionReady` is `true` only when `qc.status !== 'fail'`, `mode === 'production'` and
`fullFrameCoverage` is `true`. Warnings are advisory and never block a full-coverage
production target.

## 10. QC rules

Structural plan validation is **delegated to Phase 6B** `validatePlanForRender(target.plan,
target.mediaMap)` at package time; every such finding is emitted as `PACKAGE_PLAN_INVALID`
with the message explicitly attributed to Phase 6B. Phase 6D adds no duplicate structural
rule. An invalid target plan blocks that target.

Technical QC is performed on the **copied packaged MP4** with the existing `analyseFile(...)`
helper — ffprobe infrastructure is reused, never duplicated. Recorded: `exists`, `sizeBytes`,
video codec, width, height, fps (+ raw ratio), duration, audio presence, audio codec, audio
sample rate, audio channels, container format, and — when the existing analyser already
reports them — black seconds / black intervals and longest silence / silence count.

Required checks: video file exists, non-zero size, H.264-family video, expected width,
expected height, ≈30 fps, audio present whenever the plan declares canonical audio,
AAC-family audio, duration covers the authoritative content, no premature truncation, no
impossible excessive duration.

Asset/media contract QC records `assetRefCount`, `mediaMapEntryCount`, `sceneCount`,
`canonicalAudioRefCount` and `captionCueCount` from the Phase 6C target plus its Phase 6A
mediaMap. **Assets are never re-resolved** (Phase 6A owns resolution) and asset success is
never inferred from file existence.

## 11. Duration tolerance

`PRODUCTION_PACKAGE_DURATION_POLICY`:

| Constant | Value | Rationale |
|---|---|---|
| `truncationToleranceSeconds` | `0.5` | 15 frames at 30fps of head-room for the final video frame boundary. |
| `maxContainerPaddingSeconds` | `2.0` | AAC encoder priming (up to 1024 samples ≈ 21ms at 48kHz) plus MP4 edit-list padding. |
| `fpsTolerance` | `0.5` | A probed rational frame rate must be within half a frame per second of the plan. |
| `fullySilentSecondsThreshold` | `1.0` | Below this a file is too short to judge full silence. |

The authority is the plan: `frameCapacitySeconds = durationInFrames / fps`. For the canonical
Long that is `3563 / 30 = 118.766666…s` against an authoritative `118.74s`.

* `measured < frameCapacity − 0.5s` → `PACKAGE_DURATION_TRUNCATED` (error).
* `frameCapacity ≤ measured ≤ frameCapacity + 2s` → **accepted**, no finding. This is normal
  AAC/container padding and is *never* reported as timing drift.
* `measured > frameCapacity + 2s` → `PACKAGE_DURATION_EXCESSIVE` (error).
* `ffprobe duration === 118.74` exactly is **not** required and is not asserted.

Phase 5/6B timing is untouched by Phase 6D. Captions are never retimed.

## 12. Audio rules

* If the plan declares canonical `audioRefs`, the packaged MP4 **must** carry an audio
  stream; a missing stream is a blocking `PACKAGE_AUDIO_MISSING`.
* AAC-family audio is required for the current production render; anything else is
  `PACKAGE_AUDIO_CODEC_MISMATCH`.
* A stream that is silent across essentially its whole length is `PACKAGE_AUDIO_SILENT`
  (blocking). Ordinary dialogue pauses are not failures. The rule requires
  `duration > 1.0s`, `longestSilence > 0` and `longestSilence ≥ duration − 1.0s`, because
  `analyseFile` reports `longestSilence = 0` when it detected **no** silence.
* Audio is never synthesised, repaired, replaced or remuxed in Phase 6D.

## 13. Caption rules

Captions come **only** from `target.plan.scenes[].captionCues`. `storyboard.captions` and
`shortCaptions` are never read, and a legacy `Project`/`Storyboard` is never package
authority (proved by test — a legacy payload with `voiceoverFile`, `targetAudio` and
`shortCaptions` contradicting the plan changes nothing in the package).

Flattening is deterministic: scene order, then a total order on `(start, end, scene index,
source index)`. Cues are validated before any delivery caption is written:

* `start >= 0`, `end > start`;
* monotonic, non-decreasing starts;
* `end ≤ (durationInFrames + 1) / fps` — one frame of container tolerance past the structural
  frame capacity; a cue beyond the authoritative target duration is
  `PACKAGE_CAPTION_INVALID`;
* the cue's `sceneId` belongs to the target's own plan;
* cross-target cue identity is rejected: a cue whose scene belongs to another target in the
  same delivery set (a Long cue leaking into a Short) is `PACKAGE_CAPTION_INVALID`;
* cue ids are unique within a target.

SRT and VTT are produced by the **existing, proven** `toSrt(...)` / `toVtt(...)` helpers,
fed with plan-derived cues. No third caption serialisation format was introduced. The
`captions.json` document carries `targetId`, `scenarioId`, `projectId`,
`authoritativeDurationSeconds`, `count` and the full `cues` array, plus `format`, `fps`,
`durationInFrames` and the contract version.

## 14. Manifest contract

`manifest/delivery_manifest.json` is the top-level package authority:

```jsonc
{
  "version": "1.0.0",
  "packageContractVersion": "1.0.0",
  "projectId": "proj-hospital-expansion",
  "status": "ready" | "partial" | "blocked",
  "mode": "production" | "test-evidence",
  "readyForProductionDelivery": true | false,
  "requestedTargetIds": ["long", "short_1"],
  "packagedTargetIds": ["long", "short_1"],
  "failedTargetIds": [],
  "targets": [ { "targetId", "format", "scenarioId", "projectId", "status",
                 "productionReady", "video", "captions", "qc", "descriptor",
                 "videoSha256", "error" } ],
  "summary": { ... },
  "artifacts": [ { "path", "kind", "sizeBytes", "sha256" } ],
  "checksumsFile": "manifest/checksums.sha256"
}
```

Target entries are **always** ordered `long, short_1, short_2, short_3` — never filesystem
order, never insertion order. The same canonical order drives `requestedTargetIds`,
`packagedTargetIds`, `failedTargetIds` and the summary.

**Determinism.** The manifest contains no timestamps, no random ids, no absolute paths, no
temporary directory names and no host names. `generatedAt` was deliberately **not** added.
The same logical input and the same artifact bytes produce a byte-identical manifest; this
is asserted by rebuilding the package and comparing files.

## 15. Checksum contract

`manifest/checksums.sha256`, `sha256sum` format (`<64 hex><two spaces><path>`), one line per
packaged artifact, **lexicographically sorted by package-relative path**, no timestamps in
the ordering, no absolute paths, no `..` segments.

Covered: `video.mp4`, `captions.srt`, `captions.vtt`, `captions.json`, `target.json`,
`qc.json`, `qc.md` for every packaged target.

Excluded on purpose: `manifest/delivery_manifest.json` and `manifest/checksums.sha256` (the
index of the package — including them would be circular) and
`evidence/package_summary.json` (it reports `artifactCount`/`checksumCount`, so it cannot
contain its own digest). The manifest's `artifacts` array is exactly the checksummed set;
`summary.artifactCount === summary.checksumCount` by construction, and the two are reported
separately so a future archive step can checksum a different set.

## 16. Source-file integrity evidence

Proved for both a Long and a Short fixture, from real on-disk files
(`tests/phase6d-delivery-package.test.ts` §7/§8, and the real render test):

| Target | Source SHA256 before | after | Packaged SHA256 | unchanged | packaged == source |
|---|---|---|---|---|---|
| `long` (real Remotion render) | `45ecf542…bd30c` | `45ecf542…bd30c` | `45ecf542…bd30c` | yes | yes |
| `short_1` (real Remotion render) | `2767e275…019b` | `2767e275…019b` | `2767e275…019b` | yes | yes |
| `long` (118.9s ffmpeg fixture) | identical | identical | identical | yes | yes |
| `short_1` (49.0s ffmpeg fixture) | identical | identical | identical | yes | yes |

Additional proof that nothing was re-encoded or remuxed: the packaged copy's first 32 bytes
are byte-identical to the source's, and `Buffer.equals` on the whole file is `true`. The
source render output still exists in place after packaging. The service never renames,
deletes, rewrites, re-encodes, remuxes or restamps media; it only calls `fs.copyFileSync`.

## 17. Real Long package evidence

Real Phase 6B/6C render (`renderProductionDeliveryTargets` → `renderCompositionPlan` →
`VideoPlan` → `@remotion/renderer`), cost-controlled to an inclusive **21-frame** sub-range
(Phase 6D §28/§31 — the expensive 3563-frame render is **not** repeated).

`long/target.json`:

```json
{ "packageContractVersion":"1.0.0", "targetId":"long", "format":"Long",
  "scenarioId":"scenario-pm-01", "projectId":"proj-hospital-expansion",
  "width":1920, "height":1080, "fps":30,
  "authoritativeDurationSeconds":118.74, "durationInFrames":3563,
  "sceneCount":5, "canonicalAudioRefCount":12, "captionCueCount":28,
  "assetRefCount":2, "mediaMapEntryCount":1, "compositionId":"VideoPlan",
  "renderedWithAudio":true, "renderedFrameCount":21, "fullFrameCoverage":false,
  "sourceRenderFile":"phase6d-real-long.mp4", "packagedVideoFile":"long/video.mp4",
  "videoSha256":"45ecf542002dc7e53f0a44fdf4fd23ee6c5cb16d2bcbc0ed28f875b1468bd30c",
  "qcStatus":"warn" }
```

Measured technical QC of the **copied** `long/video.mp4`:

| Field | Expected | Measured |
|---|---|---|
| Video codec | h264 | **h264** |
| Width × height | 1920×1080 | **1920×1080** |
| Frame rate | 30 | **30/1** |
| Audio present | yes | **yes** |
| Audio codec | aac | **aac** |
| Audio sample rate | — | 48000 |
| Audio channels | — | 2 |
| Container | mp4 | mov,mp4,m4a,3gp,3g2,mj2 |
| File size | > 0 | 341 991 bytes |
| Duration (sub-range render) | ≥ 118.267 s | 0.747 s → `PACKAGE_DURATION_TRUNCATED` (warning, test-evidence) |
| Black seconds / intervals | — | 0.000 s / 0 |
| Longest silence | — | 0.000 s / 0 events |
| Verdict | — | **WARN**, not production ready |

## 18. Real Short package evidence

Real Phase 6B/6C render, cost-controlled to an inclusive **60-frame** sub-range.

`shorts/short_1/target.json`: `format: "Short"`, `1080×1920`, `fps 30`,
`authoritativeDurationSeconds 48.99`, `durationInFrames 1470`, `sceneCount 3`,
`canonicalAudioRefCount 7`, `captionCueCount 15`, `assetRefCount 0`,
`renderedFrameCount 60`, `fullFrameCoverage false`, `sourceRenderFile
"phase6d-real-short_1.mp4"`, `videoSha256 2767e275e431850206058639930ad17884a447d24f69cbbce9cb8c4beb1b019b`,
`qcStatus "warn"`.

Measured technical QC of the **copied** `shorts/short_1/video.mp4`: `h264`, **1080×1920**,
**30/1 fps**, **AAC 48000 Hz stereo**, mp4 container, non-zero size, longest silence 0.
The Short's captions are its own 15 cues with its own ids — verified to be disjoint from the
Long's 28 cues, and its `videoSha256` differs from the Long's, proving full isolation.

Both targets are packaged with the same seven stable file names, and both media files appear
in `manifest/checksums.sha256`.

## 19. Canonical Phase 6B evidence (historical)

The 3563-frame / 118.74s canonical Long render was **not** repeated and the ignored full MP4
does not exist. It is referenced only as the historical proof recorded in
`PHASE6B_REAL_PRODUCTION_RENDER_HANDOFF.md` and `EVIDENCE/phase6b` of: 3563/3563 frames,
1920×1080, 30 fps, H.264, AAC, canonical audio, no truncation. Nothing in Phase 6D pretends
that file is still present — the real test explicitly asserts
`renderedFrameCount < PLAN_RENDER_CANONICAL.durationInFrames` and that no full canonical MP4
exists.

## 20. Partial package evidence

`tests/phase6d-delivery-package.test.ts` — `25b/§27`: Long success, `short_1` success,
`short_2` render failure.

* `status: "partial"`, `readyForProductionDelivery: false`.
* `packagedTargetIds: ["long","short_1"]`, `failedTargetIds: ["short_2"]`.
* `long/video.mp4`, `long/captions.srt`, `long/qc.md` and `shorts/short_1/video.mp4` all
  present; the Long's QC verdict is still `pass`.
* `shorts/short_2` **does not exist** — no fake video, no fake descriptor, no fake QC. Its
  manifest entry has `video/captions/qc/descriptor: null` and a structured `error`.

The real render also demonstrates partial reporting: the sub-range Long + Short package is
`partial` because neither target is production ready, with `qcWarnCount: 2`, `qcFailCount: 0`.

## 21. Blocked package evidence

`tests/phase6d-delivery-package.test.ts` — `28/§26`: every target fails.

* `status: "blocked"`, `valid: false`, `readyForProductionDelivery: false`.
* `packagedTargetIds: []`, `qcPassCount: 0`.
* No `long/` and no `shorts/short_1/` directory is created.
* An audit manifest **is** written, but it records `status: "blocked"`,
  `readyForProductionDelivery: false` and every target as `status: "failed"` with
  `video: null`. It never claims readiness.

Blocked is also reached when media is wrong rather than absent: zero-byte MP4, missing file,
wrong dimensions, wrong fps, missing audio, non-H.264 video, non-AAC audio, truncated
media, cross-target captions and a sub-range render judged in `production` mode all block.

## 22. Test-evidence mode and the production full-coverage rule

**`mode: 'production'` (default)** — the only mode that may reach `ready`. In this mode a
render whose `renderedFrameCount < plan.durationInFrames` raises
`PACKAGE_PARTIAL_FRAME_COVERAGE` as a hard **error**, and the target cannot be packaged.

**`mode: 'test-evidence'`** — explicitly marks a cost-controlled render as mechanics-only
evidence. Exactly **two** codes are downgraded to warnings, both of which are the direct,
expected consequence of a frame sub-range:
`PACKAGE_PARTIAL_FRAME_COVERAGE` and `PACKAGE_DURATION_TRUNCATED`. Both findings are still
emitted in full, with an added clause stating the package is not production-ready. **Nothing
else is relaxed** — `35c` asserts that `PACKAGE_AUDIO_MISSING` still blocks in test-evidence
mode — and a test-evidence package can never report `readyForProductionDelivery: true`.

The real tests therefore run the *same real media* twice: in `test-evidence` mode it
packages as `partial`/not-ready, and in `production` mode the same media **blocks** both
targets and ships no media at all. Production duration QC was never weakened to make a short
fixture render pass.

## 23. Regression results

| Suite | Files | Tests | Result |
|---|---|---|---|
| Phase 6D safety — `phase6d-package-root-safety` | 1 | 22 | pass |
| Phase 6D focused — `phase6d-delivery-package` | 1 | 60 | pass |
| Phase 6D focused — `phase6d-real-package` | 1 | 10 | pass |
| Phase 6C — `phase6c-delivery-targets` | 1 | 54 | pass |
| Phase 6C — `phase6c-real-short-render` | 1 | 5 | pass |
| Phase 6B — `phase6b-plan-render` | 1 | 44 | pass |
| Phase 6B — `phase6b-real-render` | 1 | 5 | pass |
| Phase 6A — production asset resolution | 1 | 28 | pass |
| Phase 6A — renderer assets | 1 | 15 | pass |
| Phase 6A — integration | 1 | 7 | pass |
| Phase 5C — Remotion composition / smoke | 3 | 24 | pass |
| Phase 5D — timing reconciliation / AV sync | 3 | 63 | pass |
| Phase 5E — closure | 1 | 19 | pass |
| **Full `npm test`** | **46** | **858** | **pass, 0 failed** |
| `npm run typecheck` (core strict + web strict) | — | — | pass |
| `npm run build` (core + web) | — | — | pass |
| `node scripts/assert-test-count.mjs` | — | 858 | pass (floor 300) |
| `git diff --check` | — | — | clean |

The expensive full canonical Long render was **not** rerun. Environment note: `npm ci` and
`npm run provision` were required to obtain the ffmpeg/ffprobe npm binaries and the local
Chromium that the real-render tests need; without Chromium those tests skip by design, as
they already did in Phase 6B/6C.

## 24. Deliberate non-goals (confirmed not done)

* **No ZIP / archive delivery.** Folder package only.
* **No publishing or upload.** No YouTube / TikTok / Instagram / LinkedIn, no scheduling,
  no OAuth, no cloud storage, no analytics.
* **No marketing metadata generation.** No titles, descriptions, hashtags, pinned comments
  or thumbnail copy. Package metadata describes the production artifact and nothing else.
* **No legacy pipeline rewrite.** `services/pipeline.ts`, `packages/core/src/targets.ts` and
  `exportProject(...)` are untouched and remain backward-compatible. The new package service
  is a parallel, plan-based path.
* **No asset re-resolution.** Phase 6A still owns resolution.
* **No retiming, re-encoding, remuxing or re-timing of media.**

## 25. Limitations and deferred work

1. **The package root must be inside the repository, and must be a real
   filesystem path, not a symlink.** This is a deliberate safety constraint: the
   delivery package is a repository-owned output, and requiring a strict
   descendant of the repo root makes the rule total (it refuses the repo root,
   the filesystem root, every ancestor, every sibling and every path outside).
   A deployment that must write to an external volume needs a Phase 6E/7
   decision on an explicit allow-list; the current code has no such escape
   hatch, by design. The same rule is applied to every nested package-owned
   path, so a symlink cannot redirect a copy, a metadata write or a recursive
   delete outside the repository. See "Package-root safety (two layers)" in §4.
2. **`clean: 'full'` refuses to clear a directory containing anything the package
   does not own, or containing a symlinked package-owned entry.** This is a
   safety feature, but it means a manually polluted package root must be
   cleaned by the operator rather than by the service.
3. **Black-frame and silence evidence is recorded, never enforced.** The existing
   `analyseFile` numbers are surfaced in `qc.json`/`qc.md` and left to Phase 6E+
   thresholds; a black-frame budget policy belongs with the visual QC phase.
4. **`artifactCount === checksumCount` by construction** (every artifact is checksummed).
   They are still reported separately so a future archive step can diverge.
5. **The `PACKAGE_AUDIO_SILENT` rule only judges files longer than 1.0s.** A sub-second
   encode is never judged silent. That is correct — there is not enough evidence — but it
   means a pathological sub-second silent encode is not caught by this rule.
6. **Phase 6D does not verify that the packaged MP4 is *watchable* end to end** (no decode
   sweep, no A/V drift measurement). It verifies container/streams/geometry/duration. A/V
   drift validation belongs to Phase 6E's end-to-end closure.
7. **Real-media evidence in this phase is sub-range.** The full 3563-frame Long render was
   deliberately not repeated, so the Long package is proven mechanically at 21 frames, with
   full-coverage readiness proven to be *refused*. A full-length Long package is deferred to
   Phase 6E.

## 26. Defects found and fixed during Phase 6D

**Three** defects in the **new** Phase 6D code were found by its own tests and fixed
before handoff. No closed phase was touched. **Phase 6D was NOT safe before defect 3
was fixed** - it was discovered during Phase 6D testing and corrected before closure.

1. **Package-root escape (lexical).** The first version of `validateProductionPackageRoot` only
   rejected the exact repo root and the filesystem root, so `'..'` resolved to the
   repository's parent and `clean: 'full'` recursively deleted it. The rule is now
   *resolved must be a strict descendant of the repository root*, which refuses the repo
   root, the filesystem root, every ancestor, every sibling and every path outside — plus
   the service resolves `packageRoot` once against the same `repoRoot` it validated, and
   refuses to clear any directory containing entries the package does not own. Regression
   coverage: tests `34`, `34b`, `34c`, `34e`.
2. **Degenerate silence rule.** `analyseFile` reports `longestSilence = 0` when it found no
   silence, and the first "fully silent" rule degenerated to `longestSilence >= max(0,
   duration − 1.0)`, which is `>= 0` for any file under 1s and therefore flagged every
   short audible render as silent. The rule now also requires `duration > 1.0s` and
   `longestSilence > 0`. Regression coverage: `16b` and the real Long package test.
3. **Package-root escape via symlinks - the safety correction.** Defect 1 is a
   *lexical* guard, and the core planner additionally documented the claim that
   lexical resolution alone means "a symlink cannot smuggle an escape past it".
   **That claim was false.** A path that is lexically a strict descendant of the
   repository root can still be a filesystem symbolic link to an external
   directory (`/tmp/outside`, a home directory, ...), and the same is true of
   every nested package-owned path (`packageRoot/long`, `packageRoot/shorts`,
   `packageRoot/shorts/short_1`, `packageRoot/manifest`, `packageRoot/evidence`).
   The service then performed `mkdir`, `copyFile`, `writeFile` and recursive
   `rm` through those paths, so a symlink could redirect writes and deletions
   outside the repository.

   **Correction.** Safety now requires BOTH layers (see section 4): the lexical
   strict-descendant rule, PLUS an `lstatSync`/`realpathSync` guard that rejects
   the package root and any ancestor below the repository root when they are
   symlinks; re-proves every nested destination immediately before each copy,
   write and recursive delete; refuses to follow a symlinked package-owned entry
   during `clean: 'full'`; and re-proves ownership *immediately before*
   `fs.rmSync`. `clean: 'stale'` and every `pkg.removePaths` directory go through
   `removeSafePackageDir`, which refuses a symlink rather than following it. An
   unsafe path aborts the whole build with `PACKAGE_ROOT_UNSAFE`; it is never
   downgraded into a per-target failure. The false claim was withdrawn from the
   core planner's documentation; the planner itself is unchanged and remains
   filesystem-free.

   **Regression coverage:** `tests/phase6d-package-root-safety.test.ts` (22
   tests) - package root is a symlink; symlinked ancestor (immediate parent and
   several levels up); `long` symlink; `manifest` symlink; `evidence` symlink;
   `shorts` symlink; `shorts/short_1` symlink; `clean: 'full'` through a symlinked
   root; `clean: 'full'` with a symlinked package-owned entry; `clean: 'stale'`
   through a symlinked `shorts/` and a symlinked `long/`; media copy refused
   through a symlinked target directory; metadata write refused through a
   symlinked `manifest/`; external sentinel files byte-identical (SHA-256) after
   every rejected operation; the three legitimate-build cases (pre-created real
   directory, brand-new non-existent directory, rebuild over an existing
   package); lexical `..` escape still rejected; empty root and repo root still
   rejected; plus an explicit **incident-regression test** that reproduces the
   exact earlier failure shape (a package path textually inside a fake
   repository, redirected outside it by a symlink, `clean: 'full'`) and asserts
   `PACKAGE_ROOT_UNSAFE`, no removals, no overwrites and unchanged sentinel
   hashes.

   **Test-safety policy.** Every symlink-escape fixture lives in a per-run
   `fs.mkdtempSync(os.tmpdir(), 'phase6d-safety-')` tree. No safety test uses
   `/home/user`, `~`, the repository parent, or any real shell / profile / cache
   directory as a destructive target, and no safety test may delete or modify
   anything outside its own temporary tree. This policy is itself asserted by a
   test inside the safety suite.

## 27. Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Exact baseline `53b10bc…` | pass |
| 2 | Descendant history | pass (4 commits, no rewrite) |
| 3 | No closed phase rewritten | pass (only `index.ts` + `.gitignore` touched) |
| 4 | Plan-based package API exists | pass |
| 5 | `targetSet` is package identity authority | pass |
| 6 | `renderResult` is media outcome authority | pass |
| 7 | No legacy Storyboard authority | pass (`40`, `40b`, `40c`) |
| 8 | Deterministic package layout | pass |
| 9 | Successful MP4 copied, never moved | pass |
| 10 | Source SHA unchanged | pass |
| 11 | Package SHA matches source | pass |
| 12 | Long package supported | pass |
| 13 | Short package supported | pass |
| 14 | Captions plan-derived | pass |
| 15 | SRT valid | pass |
| 16 | VTT valid | pass |
| 17 | Caption JSON valid | pass |
| 18 | Target descriptor valid | pass |
| 19 | `analyseFile` QC performed | pass |
| 20 | Dimensions checked | pass |
| 21 | fps checked | pass |
| 22 | Codec checked | pass |
| 23 | Audio checked | pass |
| 24 | Duration coverage checked | pass |
| 25 | Container padding handled correctly | pass (`23`, `23`-padding, `22c`) |
| 26 | Truncated media cannot be production ready | pass |
| 27 | Frame-range media cannot be misreported as full delivery | pass |
| 28 | SHA256 file generated | pass |
| 29 | Manifest generated | pass |
| 30 | Manifest portable | pass |
| 31 | Manifest deterministic | pass |
| 32 | Partial target failure isolated | pass |
| 33 | Blocked package supported | pass |
| 34 | No fake failed-target media | pass |
| 35 | Real Long package test passes | pass |
| 36 | Real Short package test passes | pass |
| 37 | Phase 6C regression passes | pass (59) |
| 38 | Phase 6B regression passes | pass (49) |
| 39 | Phase 6A regression passes | pass (50) |
| 40 | Phase 5C/5D/5E regressions pass | pass (24 / 63 / 19) |
| 41 | Full test suite passes | pass (858) |
| 42 | Typechecks pass | pass |
| 43 | Build passes | pass |
| 44 | Guard passes | pass |
| 45 | Diff check passes | pass |
| 46 | Handoff complete | pass |
| 47 | No Phase 6E work started | pass |
| 48 | Package root that is a symlink is rejected | pass (safety `1`, `1b`) |
| 49 | Symlinked ancestor between repo root and package root is rejected | pass (safety `2`, `2b`) |
| 50 | Nested package-owned symlinks (`long`, `shorts`, `shorts/short_1`, `manifest`, `evidence`) are rejected | pass (safety `3`-`6`, `4b`) |
| 51 | `clean: 'full'` and `clean: 'stale'` never follow a symlink | pass (safety `7`, `8`, `8b`, `8c`) |
| 52 | External sentinel bytes unchanged after every rejected operation | pass (SHA-256 asserted in every safety test) |
| 53 | Legitimate packages still build (real dir, new dir, existing dir) | pass (safety `12`-`14`) |
| 54 | Lexical `..` escape still rejected | pass (safety `15`, plus `34`/`34b`/`34c`) |
| 55 | Symlink incident regression (textually-inside path redirected outside, `clean: 'full'`) | pass (safety incident-regression test) |

## 28. Safe to close Phase 6D?

**Yes — Phase 6D is safe to close.**

The phase is implemented, tested, typechecked, built, guarded, diff-clean, committed and
pushed on `arena/01a0f28c-video-factory`. No closed phase was modified. All **three**
defects found in the new code were fixed in the new code.

**This verdict is conditional on the safety correction.** The first closure review found
that the package-root guard was purely lexical and that the core planner falsely claimed
"a symlink cannot smuggle an escape past it". Phase 6D was **not** safe at that point.
A package-root safety defect was discovered during Phase 6D testing and corrected - in a
single commit on top of the four original Phase 6D commits, with no amend, rebase or
force-push - by adding a real filesystem (`lstatSync`/`realpathSync`) guard to the package
service, a per-operation nested-path guard, a hardened `clean: 'full'` and `clean:
'stale'`, and 22 isolated-temporary-tree regression tests. The correction changes no
contract: layout, manifest, checksums, captions, QC, modes, duration tolerance, status
semantics, target ordering, render contracts and source-integrity semantics are all
unchanged, and no Phase 6A/6B/6C code was modified.

> **Phase 6D does NOT perform final full E2E production closure. That belongs to Phase 6E.**

Phase 6E must still, at minimum:

* run the **full-length** 3563-frame / 118.74s canonical Long render and package it in
  `production` mode, proving `readyForProductionDelivery: true` end to end;
* prove a full-length Short package in `production` mode;
* exercise `PACKAGE_AUDIO_SILENT`, black-frame budgets and any A/V drift validation as part
  of an end-to-end policy;
* decide the package-root policy if delivery must ever land outside the repository;
* orchestrate the whole plan-based E2E flow (Scenario → Phase 4 → Phase 5 → Phase 6A → 6B →
  6C → 6D) from a single entry point.

No Phase 6E work was started.
