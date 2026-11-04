# Four-phrase portrait kinetic layout — 4 November2026

Bounded existing G5 repair on approved244a0ff. The validator already permits four portrait phrases, but the shared form builder placed them at0.28,0.52,0.76,1.00; the last position violated the existing0.95 safe maximum and prevented canonical saving. The regression failed before the repair.

Only the four-phrase portrait layout now uses positions0.25,0.475,0.70,0.925. Spacing0.225 remains above the existing portrait0.22 minimum. Text, phrase order, preferred emphasis, action IDs/times, shorter portrait layouts and all landscape layouts remain unchanged. No validator relaxation, truncation, new technique or model.

68/68 affected graphic/form/evaluator tests pass, core build and web production build pass. Actual isolated HTTP canonical save/reopen preserves all four Arabic phrases, actions,3-second duration and empty audio/caption tracks. Existing Remotion rendered3seconds/90frames at1080x1920 with no audio. Inspected late rendered frame shows the title and all four phrases complete and legible with no overlap/cropping: راجع، قارن، صحح، احفظ. This is technical layout/render evidence, not a completed religious episode or whole-family motion/quality acceptance.

Private QA evidence stays outside Git under FACTORY_KINETIC_QA: editor.json, result.json, kinetic-proof.mp4, probe.json, early.png, late.png. First harness attempt mistakenly selected numeric_comparison for a kinetic graphic; the unchanged validator correctly refused it. Corrected selection then saved/rendered. That refusal is not counted as production output.

Safe installation must verify clean244a0ff ancestry, no running owner factory process, FF-only source, rollback builds and byte-identical reviewed artifacts. The local factory-kinetic-installed-proof.json records actual installed SHA after promotion. No owner data/output/media/timing is touched.

G5/G6/G7 remain open. In particular, this does not repair landscape6–8-phrase layouts, add generated motion/3D/lip-sync engines, approve all illustrative styles, or resolve known PDF/runtime/quality gates. Large remaining direction work belongs to the existing Arena Order03 scope when an actual execution path is available; do not resend the failed task unchanged.
