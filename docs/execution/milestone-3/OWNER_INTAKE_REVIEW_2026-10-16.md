# Owner intake integration review — 16 October 2026

Upstream verified: 020798675bd7417f98f022e5cf6a9fba0fd322ae. Owner parent dffe733a7d3932e3af94ae5f75030fe0a3062029. Clean textual merge in the review checkout. No GitHub push, new dependency/model, or live provider call.

Independent local checks:
- Core/web build and API/core/web typechecks passed on the merged source.
- Initial focused run: 178 passed, 3 failed; the three DOM failures were missing shotList/images test doubles for the owner's supplied-script LocalImagePanel. Added explicit labelled doubles, without weakening expectations.
- Found real import loss: storyboard cards discarded imported startSec/endSec/speakerId/locked. Preserved those values through card import/export and added an exact round-trip regression. Added optional start/end inputs to the cards so a timed procedural storyboard can be authored from the UI without JSON.
- Final focused run: 10 files, 202 passed, exit0, including real ffmpeg silent/audio tests, real HTTP intake routes, legacy factory API, owner image-panel and Gemini integration doubles. No full suite.

Actual browser and Remotion proof on isolated port3033:
- Created a silent portrait storyboard panel with reviewed Arabic phrase and explicit0-4s timing, no imported recording, no voice and captions disabled.
- Selected kinetic_text and entered/reviewed its values through the normal UI; saved draft dft_e93fd3e207f78556 and applied to Factory_a6975a81de83.
- Editor showed1graphic,0captions,0audio,4s. Export exp_c0cfd2deb85642be became ready at revision1.
- ffprobe confirms1080x1920,4.000s,1video stream and ZERO audio streams. This is actual app Remotion export, not SVG-to-sharp evidence.
- Inspected actual frame at1.2s: Arabic connected lettering and diacritics visible; no caption band, identity or fabricated audio. This is a technical synthetic proof, not professional artistic acceptance of every style.
- Before entering explicit timing, the graphic form was unavailable; added card time fields resolve this supported path. An unsupported initial planned technique still needs explicit owner selection; it is not silently substituted.

Evidence under project-root .local-generation-review/intake-0207986/:
- browser-silent-export.txt/png, silent-export-probe.json, silent-portrait-arabic-t1.2.png
- data/projects/Factory_a6975a81de83/editor/exports/exp_c0cfd2deb85642be.mp4

Still incomplete:
- Real independent transcription runner is not configured. Job/API/fixture success does NOT prove audio-only production. Existing owner WSL/emissions runtime should be investigated before suggesting any new model download.
- Automatic image understanding/reference-conditioned generation remain engine gaps. Picture roles/reuse do not implement them.
- Storyboard cards cannot yet be edited after Create through a dedicated draft workflow. The editor can edit the applied clips, but that is not equivalent to draft-level card editing.
- Arbitrary source-file storyboard import is not proven by pasted JSON/card tests.
- No new local AI generation, actual owner narration, full content production or all-video-family acceptance in this session. Previous owner assets/timing approvals remain protected.

Do not call the complete input matrix or universal factory finished. This increment makes silent storyboard production usable and preserves reviewed imported metadata; remaining gaps stay in the master plan.
