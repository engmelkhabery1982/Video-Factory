# Owner integration and browser proof — 16 October 2026

Reviewed upstream: 4f01ea6ef3333d86f6fe5418162593e8393ceaa1.
Owner integration parent: 32776de087f5e0afc96f3a34c940a38466ba7113.

Merged in the existing review checkout. One textual conflict in ContentPlan imports was resolved by retaining both new graphic imports and the owner's LocalImageClient dependency. Owner speech settings, local image runtime, supplied-script image panel and protected audio/timings were preserved. No GitHub push or download.

Verification on the merged tree:
- Core/web builds and API/core/web typechecks passed.
- 12 focused files: 209 passed. These include treatments, graphics, HTTP draft/editor transactions, attachment/graphic DOM controls, owner Gemini integration and local-image freshness.
- Initial sandbox run failed on temporary-file rename permissions; the authorized run outside that restriction passed. A new attachment DOM test lacked the owner image-panel dependencies; added labelled shotList/images status doubles without changing assertions or hiding the panel. No live provider was called.
- After small display fixes, core/web builds and core/web types passed again; two affected DOM files: 21 passed (overlaps the earlier batch, not an additional unique total).
- No full suite, new model, live Google generation or owner narration alignment was run.

Real browser / real app render, isolated QA data on port3033:
1. Created an educational motion draft from two supplied English lines, observed three treatments. This short script is not proof that all scripts produce three visually distinct results.
2. The sample SAM Apply attempt failed because the isolated data directory is outside the repository working directory required by that engine. No audio was registered. This is not acceptance of generated speech.
3. Uploaded a generated 4s PCM tone through the app UI with source/licence; selected ready audio; created draft dft_f2e2876dd3cd3328 and Applied to Factory_f21b6b83f904. Exactly one audio clip, two graphic clips and two captions.
4. Edited first graphic to 'QA saved graphic'; saved revision2, Undo revision3, Redo revision4. Reloaded and reopened via Projects; value and revision4 remained.
5. Real Remotion preview prv_6bb665971c166599 succeeded at revision2. Undo marked it stale, correctly.
6. Final export exp_0aa1110037dc2219 succeeded at revision4. ffprobe: 1920x1080, video+audio, 4.022s. Actual frame at1.2s visually shows the changed graphic and original caption, with no identity (unbound). This is synthetic evidence, not owner listening or Arabic/portrait acceptance.

Proofs under project-root .local-generation-review/multistyle-4f01ea6/:
- browser-export-ready.txt/png, browser-reopened.txt, browser-final.png
- actual-export-t1.2.png
- data/projects/Factory_f21b6b83f904/editor/exports/exp_0aa1110037dc2219.mp4

Small integration fixes:
- Procedural graphics no longer count as unbound missing-image clips in the summary.
- Assembly-preview placeholder explicitly directs graphics to the real server preview; it does NOT claim to animate the graphic live.
- The local-image panel excludes shots whose selected technique is procedural, avoiding an irrelevant image-generation action.

Remaining: live assembly animation for graphics (server preview works), full portrait/Arabic/multi-language creative acceptance, broader all-input gaps G1..G12 including audio-only/images-only/reference conditioning/silent outputs, and unavailable video/3D/lip-sync engines. Owner image fidelity remains partially proven as recorded previously. Do not declare the complete factory finished from this increment.
