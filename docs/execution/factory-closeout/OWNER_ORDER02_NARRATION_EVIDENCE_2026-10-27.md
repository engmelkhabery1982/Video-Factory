# Order02 — recorded-narration evidence correction

Base: 36d28e850e43e916c45a29cdf4916a829609f159.
The real add-policy preview previously mixed the supplied recording correctly, but reported hasNarration:false because the evidence checked only the literal asset id narration. Factory supplied recordings use ac_full_narration and a library-specific asset id.

Evidence now recognizes that canonical full-recording clip, retaining the legacy asset convention, and requires positive overlap with the trimmed preview range. Audio rendering and mixing are unchanged. Per-turn generated speech is outside this recorded-narration correction.

Validation: tests/editor-narration-evidence.test.ts 4/4 pass; API tsc --noEmit exit 0; git diff --check exit 0. Real add-policy PCM evidence was already recorded in ORDER02_REVIEW_ADD_AUDIO_2026-10-27.md outside the repository; no redundant render was started for this metadata-only change.

Remaining acceptance: real-browser topic starter/PDF/policy interaction, final affected gates and safe owner integration. Approved branch and installed F checkout remain unchanged. This is not factory completion.
