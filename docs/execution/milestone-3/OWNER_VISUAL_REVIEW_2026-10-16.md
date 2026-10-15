# Owner integration and visual review — 16 October 2026

Integrated Arena repair `1e540c018dfbe7ac531b0c1fc95aed49a8ad0d52` with owner baseline `f045e6dfe0edbef20ccf56a59d019f001570048a` in the review checkout. No dependency/model/provider changes, no Google calls, no new render, no recording or approved timing edits.

## Integration

Resolved the three content conflicts in factory-service.ts, local-image.ts and gemini-contract.ts. Preserved owner native SD sizes (640×384 / 384×640), VAE tiling, progress parsing, Windows fixture execution, existing speech/header fixes and the owner's text-model setting. Production uses the exact server-composed positive/negative pair; the earlier localImagePromptPair remains only as a compatibility helper, not a second production prompt transformation.

Preserved replacement for an already-bound ordinary library image across prompt reads, identity/freshness checks and corrections. Recordings remain excluded. Bound images retain a displayed generation prompt. LocalImagePanel is now also available on supplied-script/local-rules drafts; it was previously gated to generated-plan drafts despite the API supporting both. An optional injected image client keeps DOM tests isolated.

Test adjustments: the old 'Site board photo' assertion now checks the fixture's new concrete notice-board subject. The owner's bound-image panel test now passes its list to the updated mount helper rather than mocking a client the helper no longer used. Assertions were retained. Offline page doubles gained read-only shot-list/status methods; reopen asserts that the local-image panel exists.

## Verification

- Core build; API/web source typechecks; web build passed.
- Initial affected five files: 87 tests passed (16 still-prompt, 12 freshness, 36 local-image including owner checks, 7 binding, 16 panel).
- Broader affected regression: seven files, 169 tests passed. No full-suite claim.
- After exposing the panel for supplied-script drafts: both relevant DOM suites passed, 36 tests. The subsequent explicit reopen regression passed (1 selected test, 19 intentionally filtered out).
- Earlier failures are not concealed: sandbox could not realpath the F-linked dependencies; rerun outside sandbox worked. Automatic merge left obsolete fixture expectations and a mount-helper mismatch, fixed as described. The first offline-panel run lacked new injected clients and failed; isolation was corrected and rerun passed.
- Actual local browser: supplied-script religious draft `dft_c889fd3a30ff6984` opened at 3033. Exact positive and per-shot negative displayed, model ready, existing-still replacement present. Saving a description requesting a BuildTrack logo produced the religious refusal and kept typed text. Reload restored the original saved description. No image job or approval was started by this browser check. Evidence outside Git: `.local-generation-review/vq-browser-refusal.*` and `vq-browser-restored.png` in the strategy workspace. This proves that path, not every editor control.

## Two actual generated images, inspected 16 October

These jobs completed during the previous session on 14 October. They were resumed from their saved results, not generated again. Both used the installed SD1.5 model, CPU, 20 steps, seed1729, 640×384. No image was approved, bound or rendered.

| Case | Job | SHA256 | Visual verdict |
|---|---|---|---|
| A: religious still life | lij_0e1b12f558c4ea4e | 9898383d2baa62e41bba437cd94c21388cbb58bf36ff01f76f741559acfe2f46 | Clear objects, no person/logo/readable scripture observed. Book is open instead of requested closed; lamp looks electric rather than brass oil lamp; composition differs. Partial subject/style success, fails exact storyboard fidelity. |
| B: educational illustration | lij_1066a0c88ccb1833 | 45b4bf25a2441fa40785aecab40bd780d5c8580ab2d193a8085660a5e3ab6156 | Clear illustrative trucks/yard, distinct from A. Three boxes and green tick are absent; an extra truck is cropped at the edge. Fails exact instructional-scene fidelity. |

Saved outside Git: `.local-generation-review/VQ_REPAIR_A.png`, `VQ_REPAIR_B.png`, `vq-repair-live.json`. The JSON records exact descriptions, prompts, negatives and job provenance.

## Acceptance boundary

The freshness/refusal repair is accepted at code/HTTP fixture level, with the supplied-script panel verified in a live browser. The local image engine demonstrably produces clear and varied candidate images. Precise object counts, book state and layout remain unreliable on this model. These two candidates are not approved for publication or for teaching exact facts. Use reviewed owner images/recordings where exact content matters, and review/replace local candidates before export. No further random generation or new model was started. This is not a declaration that all seven factory stages or professional generative-video capability are complete.
