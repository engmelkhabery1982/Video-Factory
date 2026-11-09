MANDATORY FIRST ACTIONS
Read docs/execution/factory-closeout/START_HERE.md, PLAN.md, STATUS.md and this entire work order before changing code. Read repository AGENTS instructions. Re-read these four files at every resumed session and before delivery. Do not rely on chat memory or a pasted historical report.
Select only this order's incomplete items, preserve verified existing work, and record the actual base SHA. Use the current remote session branch, not a historical detached baseline. If an authorized task is already running, continue it rather than starting conflicting work.
All standing constraints, acceptance labels and delivery/sync rules in START_HERE apply. Do not rewrite the plan or mark work accepted from fixture evidence.

ORDER 05 — SYNCHRONIZATION, IN-APP CAPTURE AND RELIABLE DAILY USE
Scope: G9/G10/G11 and residual G2 integration.
- Reuse existing owner transcription/alignment runtimes; no hardcoded observed boundaries. Independent transcript accuracy, forced alignment and listening review are separate evidence gates.
- Preserve source trim/offset mapping, caption-level alignment independent of visual edits, translation cue links and independent language correctness. Existing approved timings stay unchanged.
- Test new narration, silence/offset, mixed speakers, changed audio/text, stale proposal, locked cue, translated cue timing and boundary playback. Do not ask the owner to retime every sentence.
- Add missing in-app screen/microphone capture using explicit browser permission and visible start/stop/review. Real recording, not moving screenshots. Permission/cancel errors retain work. Use synthetic/owned screens for tests.
- Complete readiness, disk/CPU/RAM queue limits, timeouts, cancel/late-result handling, retry/cache identities, crash/restart recovery and backup/restore. Do not imply a finished job resumed if its output is missing.
- Keep source integrity and owner approvals, Range playback, add/replace audio distinctions, captions/identity/format and frozen revision exports consistent after save/reopen/restart.
Acceptance: focused fault/restart/real-route checks and browser for changed controls. One bounded new-recording sync example plus owner listening where needed; reuse valid old render evidence. No kill of owner processes, no destructive data cleanup, no repeated full renders. Report any process-kill orphan/recovery limit explicitly.
