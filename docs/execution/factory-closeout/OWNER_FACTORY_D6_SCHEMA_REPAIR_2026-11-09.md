# D6 schema compatibility and bounded visual refinement —9November2026

Baseline1.2; source base1459b61e6be05b9f9717be9ad9e225fe7792e43f. Same already-approved/SHA-verified Qwen1.5BQ4 and llama.cppb11429CPUx64. No download, alternate model, dependency, provider, owner-media change or release promotion.

## Diagnosed causes, not guesses about missing tools
1. The pinned regex-to-GBNF converter copies regex character classes into the quoted JSON string. Our earlier broad negated visual classes allowed raw quotes, backslashes and control bytes. A minimal native literal-quote schema produced malformed JSON; a JSON-safe class produced valid output. Excluded those bytes explicitly while preserving finite labels and clause bounds. New regression failed before/passed after.
2. The pinned JSON-schema parser gives homogeneous `items` precedence over `prefixItems`. The existing repair schema supplied both, silently discarding its per-treatment/per-line tuple constraints. Source inspection found the precedence, then native probes with schema values HIDDEN from the text prompt proved it: with-items returned WRONG/WRONG; prefix-only forced A/B. Earlier prompt-visible probes were confounded by the model seeing the expected IDs; they did not establish tuple enforcement and are not accepted as such. Removed homogeneous items at both fully bound repair-tuple levels; unchanged downstream validator retained. New regression failed before/passed after.
3. With these fixes, the real complete job first succeeded. Chronological artifacts: tuples-json-safe started10:50:36UTC and finished10:52:31UTC,2actual requests,3valid treatments,draftdft_a294a88738724e95 persisted/reopened identical. This was STRUCTURAL success only: visuals still depicted empty trench for the pipe-placement line.
4. One generic semantic-guidance change also produced a structurally valid saved draft(dft_095b7cad97462230), but did not resolve repeated visuals. It is not semantic acceptance. No unchanged full-run repetitions were made.

## Current-line orchestration, using the existing native model
Small real native probes showed that including the whole earlier sequence anchors the small model on the earlier inspection step. Isolating just the current line returned actual subjectbluepipe/actionplace. Added a bounded repair only for repeated short educational proposals:
- Subject/action binding extracted by the actual local model from each unique current narration, without replaying earlier steps.
- Up to6scene-composition calls use those actual model bindings as constants while applying the chosen visual method. No hand-authored/fake scene answer or local_rules substitution.
- Hard cap8total refinement requests including bindings,120s phase deadline,45s maximum per request, cancellation inherited, original plan cloned, no partial mutation. Larger cases stay explicitly review-required; other profiles unchanged.
- Subject/action/composition fields are revalidated and the SAME complete plan validator runs before persistence. Words, lineIDs, sources, methods, camera values unchanged. Metadata distinguishes the2main planning attempts from8additional refinement requests; output remains refined_unreviewed. Owner review warning is explicit.
- First integrated version failed the unchanged validator on one-word composition fields; failed native traces retained. Added the existing required multiword JSON-safe composition constraint; no validator weakened.

## Executed evidence
- Repair-schema group5PASS:2new regressions plus3affected existing cases. Other15 cases filtered. No full historical suite repeated.
- New refinement suite5PASS with LABELLED provider doubles: current-line isolation/immutability/8request cap; budget refusal; other-profile preservation; malformed-field refusal without partial mutation; cancellation. These are not native-quality proof.
- Affected provider contracts36PASS, preserved for unchanged non-degenerate paths; final refinement delta retested with its5cases. API tsc --noEmit0, whitespace0. No capture/render/old134/36/48/schedule rerun.
- Real final canonical startPlanJob -> native plan -> automatic schema repair -> native content bindings/refinement -> unchanged validation -> ProviderStore -> createDraftFromPlanJob -> getDraft:
  jobb6bbd94b-786b-404c-b7ad-38ee665bb08a,11:15:01.277–11:17:08.276UTC,10actual local requests(2main+8refinement),statussucceeded,3treatments,6scenes,draftdft_14fe1144670b0abf,revision0,reopened JSONidentical. No output/still/audio/episode produced. Runtime stopped in finally.
- Exact words retained: Inspect the empty trench. / Place the blue pipe. Every treatment now binds its placement scene to actual native subjectbluepipe/actionplace; conversational composition includes two participants demonstrating pipe placement. This is a concrete improvement over the unchanged empty-trench proposal.

## Quality decision — still OPEN
The functional native-to-persisted-draft path is proven for this owned English educational case. Semantic direction is NOT fully accepted: the result_then_explanation output still fails to provide a genuine before/after direction; two composition descriptions end incompletely at their field limit; repeated titles remain. Draft remains blocked by missing materials and unapproved text/visuals. This is not acceptance of3meaningfully distinct finished treatments, all profiles/inputs, images, cinema, Arabic, capture or whole-factory release.
Next bounded code task: compact method-specific composition fields/clear completeness check and quality evaluation, reusing this real generated script and bindings instead of regenerating already-verified planning/words. Do not repeat a full unchanged job, claim partial sentences complete, install another model, or reopen accepted07 checks.

All native requests/responses, failures and JSON snapshots remain local under DIGITAL_INCOME_CONTROL/D6_LOCAL_20261109/{counterexample,quote-probes,decoder-only,json-safe,tuples-json-safe,semantic-guidance,scene-prototype,scene-line-only,integrated-scene-refinement,bound-content-refinement}. Protocol probes are not product outputs. No model/media/config is committed.

Pinned primary sources: [parser precedence](https://raw.githubusercontent.com/ggml-org/llama.cpp/b11429/common/json-schema.cpp), [regex conversion](https://raw.githubusercontent.com/ggml-org/llama.cpp/b11429/common/json-schema-to-grammar.cpp). Actual native probes confirm the documented source behavior; they do not certify creative quality.
