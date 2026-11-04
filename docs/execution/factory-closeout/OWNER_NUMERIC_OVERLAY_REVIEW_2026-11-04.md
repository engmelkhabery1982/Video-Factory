# Numeric-overlay precision — bounded owner review, 4 November2026

Scope: one independent existing Order03/G5 accuracy defect, not completion of visual families or Order02. Work-line fix6b11a8cfd9cb6b7028599bf6bd869849f7cad916 descends frome593883. Owner integration cherry-picks only the two-file formatter/test change onto approvedeb0eac8 (code commit a4e928f5d29f89e8ec23dfbaa5efae8ed6b93150). No bulk acceptance of intervening work.

`exactValueLabel` previously rounded12.3456 to12.346, and0.0001 to0.000, when a graphic declared three preferred decimal places. Stored values stayed correct but the actual text could become false. Preferred trailing-zero padding is now used only if it preserves the numeric value exactly; otherwise the supplied numeric value is rendered. Existing7.0 and0.00 formatting remains. No schema, dependency, speech, timing, provider or engine change.

Evidence:
- New precision regression fails on the prior code. Affected graphic renderer/form/evaluator tests pass67/67 on both work and approved integration trees. Core build/typecheck, web TypeScript on work, and core/web production builds on the approved tree pass.
- HTTP with isolated synthetic QA: create a3-second silent project, edit one clip through the canonical editor route to numeric_comparison, save and GET/reopen. Exact graphic values, audio-clips/captions and duration remain unchanged. No provided recording or owner media.
- REAL existing Remotion preview pipeline rendered90frames at1920x1080, duration3seconds, zero audio streams. Actual rendered early/late frames show legible Arabic labels/title and exactly12.3456m3 and0.0001m3; the first bar grows between these frames. The MP4 exists locally. This proves this formatting repair reaches rendered pixels; it does not certify an entire animation/cinematic family or episode quality.
- Renderer/evaluator/builder source blobs are identical between the work and approved integration for this proof. Reuse that rendered evidence; the intake/API behavior of the later work tree is not thereby approved.

Private QA records remain outside Git in the local control folder: FACTORY_NUMERIC_QA/editor.json, result.json, numeric-proof.mp4, probe.json, early.png, late.png. They are test evidence, never a user video delivery. First harness attempt incorrectly set a video-only audio policy for a still placeholder and was correctly refused; the corrected harness clears that policy. Refusal is not counted as output.

Owner installation requires clean approved lineage, no running factory server, rollback source/build copies and byte-matched compiled core/web artifacts. See local factory-numeric-installed-proof.json for the verified installed SHA; this document alone does not assert installation.

Remaining: G5 distinct meaning-led editable families, G6 genuine video/3D/talking engines, G7 conditioning/correction quality; PDF browser permission and other existing runtime gates remain open. No new runtime download, no public link, no final religious video, no owner quality/listening approval inferred.
