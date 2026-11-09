# D6 composition completeness delta — 9 November 2026

Reviewed parent: `b11bd6828ec922d8752bb2c9c1f74a220ba0c203`.
Scope: local educational visual refinement only. No new model/runtime, downloads, dependencies, media, owner data, timings, approved branch or F changes.

## Fixed and verified

The decoder's short composition regex could force a phrase to end mid-word or on an article. Increased its grammar allowance while retaining the existing host field-length rejection: overlong output is rejected, never clipped. Prompt requests one complete concise phrase. Added conservative English incomplete-ending rejection, including punctuation after cut-off words. This is a limited completeness guard, not a grammar or meaning certificate; other languages and unlisted endings remain subject to review.

Three regressions using actual observed endings failed before the fix and passed after it: `ready for an`, `in the t-`, and `in hand, facing`. Added punctuation variants and a complete directional-phrase control. Final affected suite: **11/11 PASS**, labelled provider doubles. API `tsc --noEmit`: exit 0. `git diff --check`: exit 0. Prior 36 provider tests, native JSON/draft/cold-reopen, CLOSEOUT07 checks/export and schedule acceptance were not repeated; their unaffected evidence remains historical.

## Actual native experiments (not passing product gates)

Same previously authorized Qwen GGUF and llama.cpp b11429 CPU, loopback only; every owned server stopped in `finally`.

Three changed, bounded decomposition experiments reused the saved native narration and subject/action binding. **Nine actual native requests**, three per experiment; full prompts, schemas and responses retained in local `D6_LOCAL_20261109/compact-composition-probe{,2,3}/results.json`.

- Short method-specific fields alone did not create meaning: conversational roles repeated; before/after were equivalent.
- More explicit state questions still returned `empty trench` for both positions; a hard word-count regex introduced another cut-off phrase. Not integrated into production.
- Removing the hard word-count constraint improved conversational roles (`FIRST person places...`, `SECOND person points...`), but comparison remained identical and worked demonstration remained weak. Not accepted and not substituted manually.

Changed production refinement check at **14:52 UTC**, recorded exact timestamps in `compact-refinement-integration/qualification.json`: reused the actual previously generated plan from `tuples-json-safe` plus **two explicitly replayed historical native binding responses** from `bound-content-refinement`; **six composition calls were new actual native inference**. No initial planning rerun and no fixture-authored content. Production helper completed; unchanged core plan validator passed; original plan remained JSON-identical. Six compositions had no observed cut-off endings.

**Visual semantics FAILED review:** one comparison claimed the trench becomes filled with soil and debris after inspection, contradicting the source sequence; two pipe compositions collapsed to `blue pipe in trench`, without the required participant/comparison differentiation. A worked composition also asserted absence of debris without supporting narration. The result was retained only as diagnostic evidence; **not persisted as a newly accepted draft, Applied, rendered or promoted**. Existing draft/cold-reopen evidence is reused, not claimed as new.

One initial host script launch failed before any request due to Windows absolute `--import` URL handling; fixed by running installed `tsx` from the checkout. That launch is not a native test success.

## Actual stop and next decision

Completeness guard is code-qualified; semantic quality is still NOT accepted, and factory release is OPEN. Do not repeat these prompts, unchanged full plans or successful historical checks. Three constrained decomposition variants plus the changed production subtask now provide concrete quality counterexamples with this exact resource. Next prepare one finite resource/architecture decision against these saved failures, including an exact scoped artifact/license/hardware manifest if proposing another model; do not download or switch models from a timer. Alternatively a changed bounded implementation must explain how it addresses the demonstrated contradiction, not merely rename fields or add another generic prompt. No capability of ASR/vision/inpainting/Arabic/motion/3D/native capture is inferred from this work.

Approved/F remain `daae482aac9de85e993599a6d010e29908ac567a`. No release acceptance.
