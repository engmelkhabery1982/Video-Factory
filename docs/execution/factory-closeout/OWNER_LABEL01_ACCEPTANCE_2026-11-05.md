# LABEL01 bounded owner review — 5 November 2026

Accepted functional label-fit increment only. Whole G5/Order03, cinematic families, engine availability and the two episode deliveries remain open.

## Source and independent checks

Arena delivery `9c2dae67ca785f53f34986a769e7ed5eca5761f8`, implementation `84e1e148eab8969474bd15ff5a5c2fc5d35b2be1`, descends directly from requested `b0ac8f49d30ea64637a9b13dffb552a882806c66`. Eight files +420/-9; no package/lock changes, dependencies, executable/media/config uploads or owner-storage edits. Its no-install statement is a delivery assertion, not an audit of every hidden command. The previous ACTOR01 provisioning breach stays recorded.

Independent owner run: 155/155 across the reported nine affected suites; core/web builds and web typecheck passed. Actual portrait output revealed English terminal punctuation moving to the beginning of a wrapped line in an RTL scene. Owner fix `7dad7a5` resolves direction from the first letter of the complete label, consistently across every wrapped line, with the scene direction as fallback for non-letter labels. Arabic stays RTL, English/identifiers stay LTR; canonical scene direction and exact text do not change. Final targeted layout/SVG/DOM run:36/36. Only affected output was rendered again after this correction.

Integration is on a separate approved branch from `a2f5e69b1a31bb19d9ba8a331e07080381af619a`: `b5ba6ef`, `a85cb9b`, `8e24133`. Pending Order02/e593 content remains on the working branch, not installed by this increment. Integration checks and installed SHA/build manifest are saved separately in the local control directory.

## Actual browser and canonical persistence

Isolated localhost3161 QA only, synthetic actor context created through existing HTTP routes; this setup does not repeat or re-prove accepted actor creation. Real browser edited box label to `  هٰذَا  صُنْدُوقٌ  مُهِمٌ  `, width/height0.02 and scale0.2. The advisory appeared before Apply, did not block valid Apply/Save, and persisted after actual reload/project reopen, with spaces/marks intact. The owner explicitly enlarged width/height to0.3 and scale1: advisory disappeared; save/reopen preserved those chosen values. IDs, actions, clip duration, captions and audio were not automatically changed.

Project `Factory_41936aa69e78`: actual UI full preview `prv_798fc5c644ff8660` and UI final export `exp_ed66878aa396dec1`, both current revision5, 3seconds/90frames/1920x1080/no audio. Byte-identical SHA256 `0D86CACEA928D9662A3CF940189B3CFE78E53D746437D2C5318FA50BF980DC12`. Arabic glyphs/marks and label contained in the box were visually inspected in the actual video frame. These Arabic outputs precede the English-only bidi correction; final portrait below exercises corrected rendering.

QA harness first used relative storage paths, causing a worker `project not found` result. Restarting only the QA helper with absolute paths corrected the harness. A stale revision4 request was refused after reload normalization to5; refreshed current revision rendered successfully. These failures are recorded, not claimed as passed renders or product fixes.

## Actual wrapped-label output

Synthetic portrait HTTP save/reopen and real Remotion output with40-character Arabic,40-character English, marked/spaced Arabic, and40-character unbroken identifier. Geometry was explicitly authored for this QA context, not silently changed by the renderer. Final project `Factory_62268874edd1`, preview `prv_7b519deba0be740e`, revision2,3seconds/90frames/1080x1920/no audio. Actual frame inspection shows all four labels contained, Arabic shaping/marks retained, English period on the correct end after the owner fix, and the identifier wrapped without omitted characters. Exact substring preservation/extreme geometry is additionally tested; visual frames alone do not prove every character or every font/size combination.

Local private evidence: `LABEL01_UI_QA` (canonical snapshots, runtime-proof.json, actual preview/export, probe/frames), `LABEL01_PORTRAIT_QA` (before-bidi output), `LABEL01_PORTRAIT_BIDI_QA` (final output), and `label01-*-tests/build/type` logs. No media committed. QA servers/browser closed after review; no owner F data/output/WAV/timing changes or new runtime/download/provider calls.

The advisory deliberately admits tiny valid boxes can make exact text unreadable. This is bounded functional acceptance, not a phone readability guarantee, arbitrary scene-quality approval, audio listening, animation-family acceptance or a finished episode.
