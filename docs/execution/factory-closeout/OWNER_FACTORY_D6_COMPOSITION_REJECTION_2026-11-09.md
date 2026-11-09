# D6 low-information composition rejection — 9 November 2026

Reviewed parent `f6a721aa633a2e7057a435ea0d99dfbb7e51b78a`. This is a bounded failure-rejection delta to existing educational visual refinement. It does **not** implement or certify a semantic planner.

## Boundary fixed

The refinement helper previously accepted a composition that was only the narration, bound subject/action, continuity environment or camera label. It also accepted exactly the same composition for the same source lines across different methods, even with a different camera. Those degenerate answers could reach a structurally successful plan despite providing no composition information or method distinction.

Added two negative checks before returning the cloned plan:

- Reject an exact source-field echo after UnicodeNFKC/case/punctuation/whitespace normalization, comparing only against the current bound narration/subject/action/environment/shot. The actual source and saved values are never normalized or rewritten.
- Reject an exact repeated composition for the same ordered source-line IDs across treatments. The same arrangement on different source lines is permitted; no global layout ban.

No action keyword classifier, generated answer, model critic, preset layout or positive semantic verdict was added. Passing these checks only means the answer is not one of these exact degenerate forms. Paraphrases, weak roles, invented claims and incomplete action coverage can still pass and require quality review. Subjects/actions retain the previous host equality guard; budget8, cancellation, cloned-input safety, original text/IDs/values/references and core validator remain unchanged. No extra inference or repair loop.

## Verification and limits

Five new cases failed before the fix: four source-field echoes and one identical composition for the same line across methods. Final affected suite **22/22 PASS**, labelled provider doubles: echo rejection, exact cross-method duplicate rejection, source immutability, English normalization/Arabic source text and same-arrangement/different-source-line control, plus the affected existing safety cases. Fixtures were made explicitly distinct where successful-helper tests require distinction; these are **not** native semantic examples. API `tsc --noEmit`: exit0. `git diff --check`: exit0 after documentation whitespace normalization.

Reused actual historical model responses through the **real canonical service/store** in isolated QA: two initial native plan responses, two historical subject/action bindings, then the first two responses from `D6_LOCAL_20261109/direction-authority-refinement`. All are explicitly replayed; **zero new native/network calls**. The recorded `the empty trench` composition now raises `FACTORY_AI_INVALID_OUTPUT`; job ends `failed` with no plan result, and `createDraftFromPlanJob` refuses with `FACTORY_JOB_NOT_READY`. Replay6responses/expected rejection PASS. This proves failure containment, not successful generation, HTTP/DOM/native inference or quality acceptance.

Evidence: local `D6_LOCAL_20261109/composition-rejection-replay/qualification.json` and six captured requests, script `replay-composition-rejection.mjs`. Initial replay CLI launch used a wrong relative path and failed before execution; corrected to an absolute path, without rerunning the passing test/type suite. No runtime started,7B retry, download, draft, Apply, render, old accepted test suite, Schedule or owner data change.

## Actual stop

Low-information/repeated-composition rejection is code-qualified. D6 semantic quality and factory release remain OPEN. Existing JSON/draft/cold-reopen and CLOSEOUT07 evidence remain historical and were not repeated. Approved/F remain `daae482aac9de85e993599a6d010e29908ac567a`.

Further work must improve actual source-bound action/role/layout generation and demonstrate new meaningful output under a changed bounded design. Do not count these refusal tests as product completion or replace generated descriptions with local templates. Repeating the same native prompts cannot establish progress; no further7B trial or new-resource permission is inferred.
