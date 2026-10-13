# Milestone 3 — evidence inventory

Status key. Each row carries its strongest evidence. Nothing here is owner acceptance unless the last column says so.

- **implemented**: code exists in this branch.
- **fixture-tested**: exercised by a test using labelled fixtures or labelled test doubles. No provider call.
- **route-tested**: exercised through the real registered server, with no key set.
- **code-checked**: checked by running the script's gates or redaction with a dummy key (no provider reached).
- **live-tested**: a real provider call succeeded. **None in this delivery.** The LIVE gates are blocked (see ARENA_DELIVERY.md §5).
- **listened/reviewed**: a human listened to or reviewed the output. **None.**
- **owner-approved**: the owner approved it. **None.**

| # | Capability | Implemented | Fixture-tested | Route / code-checked | Live-tested | Listened / reviewed | Owner-approved | Evidence (file / test) |
|---|---|---|---|---|---|---|---|---|
| 1 | Plan JSON schema for structured output | yes | yes | — | **no (blocked)** | no | no | `packages/core/src/factory/gemini-contract.ts`; `tests/gemini-contract.test.ts` |
| 2 | Strict plan validation (methods, shot sequences, line coverage, unknown refs, unknown shot types) | yes | yes (22 contract tests) | — | no | no | no | `tests/gemini-contract.test.ts` |
| 3 | Three treatments per profile with distinct methods and distinct shot sequences (structural check only; not a judgement of storytelling quality) | yes | yes | — | no | no | no | `validateGeneratedPlan` |
| 4 | Religious rules: quotations need a supplied reference; no product mention; no screen recordings | yes | yes | — | no | no | no | `tests/gemini-contract.test.ts` (religious block) |
| 5 | Sources only from supplied references; unverified claims marked `needs_verification` | yes | yes | — | no | no | no | `tests/gemini-contract.test.ts` |
| 6 | Product mention default off; needs an explicit request and a supplied fact | yes | yes | — | no | no | no | `tests/gemini-contract.test.ts` |
| 7 | Prompt data scope (brief + supplied references only; product facts only when requested) | yes | yes | — | no | no | no | `tests/gemini-contract.test.ts` |
| 8 | generateContent REST request shape (structured text) | yes | yes | — | **no (blocked)** | — | — | `buildTextRequestBody`; the REST key naming is an open live gate (ARENA_DELIVERY.md §5) |
| 9 | TTS request shape: verbatim `text`, style only in `speech_metadata`, prebuilt voice, AUDIO modality | yes | yes | — | **no (blocked)** | — | — | `buildSpeechRequestBody`; `tests/gemini-contract.test.ts` |
| 10 | Angle-bracket tags refused in speech text | yes | yes | — | — | — | — | `tests/gemini-contract.test.ts` |
| 11 | WAV validation (RIFF, PCM, 16-bit, channels, sample rate, bytes, duration) on synthesized files | yes | yes (synthesized WAV, not provider output) | — | no | no | no | `parseWav`; `tests/gemini-contract.test.ts` |
| 12 | Speech preview: MIME check, WAV check, 20-second limit, SHA-256, provenance, `approved: false` | yes | yes | — | no | no | no | `tests/gemini-provider.test.ts` (speech block) |
| 13 | Arabic readiness state separate from English (`fixture_only` until a recorded live Arabic run) | yes | yes | — | no | no | no | `aiCapabilities`; no live Arabic run |
| 14 | 401 / 403 / 429 / 5xx / timeout / network mapping, one attempt, no automatic fallback | yes | yes | — | no | — | — | `tests/gemini-provider.test.ts` (error mapping block) |
| 15 | Cancellation: in-flight abort, and a late success is never adopted | yes | yes | — | no | — | — | `tests/gemini-provider.test.ts` (cancellation block) |
| 16 | Budgets: text ≤ 2, voice ≤ 2 per session, hard caps not raisable by config, failed attempts counted | yes | yes | route-tested (status) | no | — | — | `tests/gemini-provider.test.ts` (budgets block) |
| 17 | Idempotency: same input reuses the job and its reservation; a failed job retries under the same key, budgeted | yes | yes | — | no | — | — | `tests/gemini-provider.test.ts` |
| 18 | One schema repair within the same text budget; blocked or empty output is not repaired | yes | yes | — | no | — | — | `tests/gemini-provider.test.ts` (plan block) |
| 19 | Restart handling: a running job becomes `interrupted`, never `succeeded` | yes | yes | — | — | — | — | `tests/gemini-provider.test.ts` (restart block) |
| 20 | Source identity: a changed reference is a new job | yes | yes | — | — | — | — | `tests/gemini-provider.test.ts` |
| 21 | Edited narration: unchanged text reuses its clip, edited text gets a new clip, and the cap still applies within a session | yes | yes | — | — | — | — | `tests/gemini-provider.test.ts` (edited narration) |
| 22 | Selective regeneration preserves an earlier preview byte-for-byte | yes | yes | — | — | — | — | `tests/gemini-provider.test.ts` (preview level only) |
| 23 | Capability states: credentials missing, catalog reachable, ready, quota blocked, live-test unverified | yes | yes (recorded verification files) | route-tested (`credentials_missing`, no network) | no | — | — | `tests/gemini-provider.test.ts`; `tests/gemini-routes.test.ts` |
| 24 | Secrets: the key is never in responses, job records, or the verification record | yes | yes | route-tested; code-checked (dummy key not printed by the script) | — | — | — | `tests/gemini-routes.test.ts`; `tools/gemini-verify.mjs` |
| 25 | Windows verification script: preflight without generation, free-tier confirmation, budget ledger, one preview per profile, redacted evidence | yes | — | code-checked (gates, network-error path, dummy key) | **no (blocked; not run on Windows)** | no | no | `tools/gemini-verify.mjs`; `LOCAL_VERIFY_STEPS.txt` |
| 26 | M2 factory regressions still pass after the change | — | yes (factory-api 56, planning 25, timing 9) | — | — | — | — | run recorded in ARENA_DELIVERY.md §4 (152 tests) |
| 27 | Core and web builds; API and web typechecks | — | — | build / typecheck exit 0 | — | — | — | ARENA_DELIVERY.md §4 |
| 28 | ContentPlan / Editor UI wiring for Gemini planning and speech | **no** | — | — | — | — | — | not built (ARENA_DELIVERY.md §6) |
| 29 | Treatments converted into a draft or storyboard, and applied to render | **no** | — | — | — | — | — | not built |
| 30 | Gemini speech in the apply/render path, per-turn clip ownership in drafts, selective regeneration and narration-edit invalidation in the draft pipeline | **no** | — | — | — | — | — | not built; only the preview-level behaviour (row 21–22) is tested |
| 31 | Multi-speaker TTS (two speakers) | **no** | — | — | — | — | — | not built; single-speaker per-turn request only |
| 32 | Visuals: shot prompts for missing assets, import and binding of supplied results, portrait and landscape plans | **no** | — | — | — | — | — | not built; the plan's `assetNeed` and `shotType` fields exist |
| 33 | Approved-script immutability and derived rewrite | **no** | — | — | — | — | — | not built |
| 34 | Arabic speech quality | — | — | — | **no** | **no** | no | no live Arabic run |
| 35 | Any Gemini speech listened to | — | — | — | — | **no** | no | — |
| 36 | Owner-host checks (preview, browser, deployed host) | — | — | — | — | — | — | not run |
