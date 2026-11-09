# Integrated editor handoff — 13 October 2026

Backend parent: `45be804780c13ba8787833e610f56efd077479b9`.
This branch incorporates the recovered Freebuff frontend, frontend/backend DTO integration fixes, and Codex's locally tested corrections. It is an intermediate development baseline, not completed owner acceptance or a finished factory.

The exact source patch before this documentation was added was 266942 bytes, SHA256 `9a41e855a68915e92473fde85f3f607268afafd4cbc52436f0907ae50a74c191`. It changed 27 files. Do not apply that patch again or request its attachment. Start from the integrated commit supplied in the owner message.

## Verified corrections

- Frontend adapts backend alignment DTOs, including unavailable row spans; still-image source ranges stay nullable.
- Worker completion, polling and proposal display use caption/narration dependencies, not a visual-only revision change. Acceptance retains current-revision concurrency checks.
- Caption alignment preserves emitted times beyond a shortened visual track. The worker derives a validated contextual tokenizer separator when isolated whitespace is stripped.
- Browser audio and footage playback use explicit play/pause/source-offset synchronization, preserving mounted media and stable source URLs.
- `/media/asset/:id` supports the existing single-byte-range contract after its access checks: 200/206/416 and exact byte lengths.

## Verification actually performed locally

- After alignment fixes: 72 tests in four affected suites passed; core build and API/web typechecks passed.
- After playback fixes: 22 UI/integration tests passed; web typecheck and build passed.
- After asset Range fix: eight integration/parser tests passed; API typecheck passed. These runs overlap; do not sum them as unique coverage.
- Real browser with a derived copy: image binding, save/reopen, crop/motion edits, undo/redo, visual split followed by undo, and timed highlight worked.
- UI alignment request called the actual existing WSL runner in align-only mode through a test-only cache wrapper that checks job audio SHA against saved emissions. Sixteen real caption units were placed, none unresolved; second start was 6.022 s without a hardcoded target. This was not a fresh model forward or a new independent listening approval. The reviewed result was accepted on the derived copy only.
- A single four-second UI-requested server preview completed at revision 9, landscape 1920x1080, probed 4.022 s, with actual narration and video. Inspected frames show the image, Arabic shaping/diacritics and highlight absent before its interval and present within it. This is technical evidence, not creative/publication approval.
- Browser audio seek/play at requested 10/30/50 s read 10.109875/30.205186/50.165742 while playing, with a stable source URL and no media error. This is player-state evidence, not listening evidence.
- Actual uploaded screen-recording media retained source time 3 s when paused and played at 3.250339 s after the Range fix. A local real-HTTP multipart upload succeeded; browser upload failed with `Failed to fetch`. The latter's cause is unproven.

No source recording, approved original project/timings, or original production output was changed. No models/providers were installed, no model forward repeated, and no full production render, deployment or publication occurred. Owner media, cache wrapper, screenshots, previews, weights and dependencies are deliberately excluded from this Git delivery.

## Four gates still to close

Read `CLOSE_EDITOR_M1_EN.txt`. This consolidated order permits the necessary frontend/backend integration across the earlier tool ownership split for these four gates only.

1. Prove actual UI file import; distinguish browser transport limitations from app defects.
2. Browser assembly currently plays only the first audio clip; implement all tracks and accurate gain handling, matching source mapping in server previews.
3. Canonical document identity must drive the UI and render consistently; the UI currently displays the legacy project brand even when document identity is null.
4. Final export must use the frozen canonical editor revision and all saved edits, not silently revert to the legacy storyboard.

Dissolve remains refused pending amendment A1. Legacy projects must remain readable. Generation/diversity and compound-input milestones 2/3 are separate and unfinished. Keep unavailable host/media/runtime checks honest; fixture tests do not replace owner acceptance.
