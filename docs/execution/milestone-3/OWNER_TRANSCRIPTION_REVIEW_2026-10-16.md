# Owner script-free transcription and storyboard review — 16 October 2026

Verified upstream c2bf698325eb3fd699be2c0d67ce89c28fd25fbd, merged into owner parent ba20529d5617543701f3c4007f6e96753a53639f. Conflicts in IntakePanels.tsx and factory-model.ts were equivalent timing/speaker/lock preservation fixes; retained the new validated controls and all unrelated owner changes. No model/dependency download or live cloud call.

Local checks: core/web build and API/core/web typechecks passed. Eight focused suites157/157 passed, including real-route storyboard edits, runner contract, legacy factory API and owner image/speech DOM tests. No full suite or new content render.

REAL transcription (not fixture):
- ONE execution via scripts/transcribe-owner-check.ts and the existing vf-align WSL CPU runtime, checkpoint and tokenizer. No script/caption argument or text was supplied to the runner.
- Input: owner's58.84s WAV, SHA256 dc8e6f2422be7777d0ddfab9fc5014cdd68090a5eb7489edf29ca5caa46bd6b7,2824364bytes. Evidence confirms unchanged afterwards.
- Job trs_6dba42073e7ff328 succeeded.2941frames,frameSec0.020006800408024484,429transcript characters. Non-fixture greedy_ctc/frame-emission provenance. Emissions digest21778ccfe8107efe316a52c0f8671089899d1165efde4efefa34c0c8da1bb137.
- Execution timestamps indicate about57seconds for this particular run. Do not generalize performance.
- Independent textual review against the owner's separately stored script found recognition errors: فقد instead of فقدت; عطيت instead of أعطيت; نها/نه for إنها/إنه; ساعة رحمة instead of سعة رحمة; بسميه instead of باسميه; joined/incorrect final words. This is NOT an approved transcript or listening-quality claim. No accepted text, captions, timings or original recording was overwritten.
- Evidence and owner-review transcript are under project-root .local-generation-review/audio-only-c2bf698/. reviewedAt remains null.

REAL browser (isolated data, port3033):
- Created a silent storyboard card with0-4s explicit timing; draft dft_808385cee4cd5631.
- Changed its post-create words from 'First reviewed panel.' to 'Updated reviewed panel.' and saved through the real intake route, revision0->1.
- Reloaded: updated words and0/4s values persisted. Existing missing-graphic-values blocker remained honest; no Apply/render or model call was needed for this edit proof.
- Evidence .local-generation-review/storyboard-c2bf698/browser-card-reopen.txt/png.

Unfinished parts of original order:
- Post-create add/remove/reorder is still refused universally. Only existing-row words/picture/timing editing is delivered. Preserve this as a real gap rather than calling storyboard editing fully complete.
- Source-change invalidation and frozen applied-project preservation were not newly proved on the owner host this session.
- Actual job execution is proven; transcript accuracy still needs human correction/review before use. No automatic replacement of the reviewed script is allowed.
- Automatic image understanding/reference-conditioned generation and video/3D/lip-sync remain separate master-plan gaps.

The tested local transcriber configuration must be bound to the installed F path for normal app startup; the one-shot review path is not the permanent owner launcher configuration. No further model installation is needed for this tested engine.
