# Native capture and interrupted-render recovery — 9 November 2026

Reviewed parent: `058de069072433524aff59037d20c24298c31d46`. Isolated owner-host qualification using existing installed browser/FFmpeg/Remotion only. No F/approved/3130, owner data, approved media, dependencies, new model or system configuration changes. These are bounded functional outcomes, **not whole-factory acceptance**.

## G11 actual interruption exposed and fixed a defect

Copied the owned three-colour QA project from the preserved CLOSEOUT07 fixture into `DIGITAL_INCOME_CONTROL/REC_QA_20261109`. Actual API3189 accepted two export jobs at revision3. A real Chromium child was observed under the verified QA API process; only that process tree was terminated. On a new API process both jobs truthfully became interrupted/failed, with null media URLs. The document stayed equal, but the running job had no durable scratch pointer and its marked temporary directory remained orphaned. First failure, files and logs retained.

Repair:
- Persist exact scratch intent/name before allocating/awaiting the renderer; bind the newly written ownership marker to the actual job ID.
- On interrupted-record recovery, clean only a matching job/project/kind/name under the exact project scratch parent or system temp, through no links, with a regular bounded marker matching kind/name/jobID.
- Foreign paths, another job's marker, legacy unbound markers and cleanup failures are preserved with a warning. No broad scavenging, data migration or deletion of legacy/unmarked directories. Final media and frozen/current documents are untouched.

Tests: two regressions failed before/pass after; **10 unique affected lifecycle/recovery cases PASS** across bounded runs, including four existing settlement/cleanup cases plus six new cases. The16 unrelated path/binary checks were filtered, not repeated or added to pass totals. The outside-root fixture initially fell back to system temp due its own long path; corrected to construct the forged path directly, then only that failed case was rerun. API typecheck exit0; whitespace check exit0. Controlled-render doubles prove job transitions only.

### Changed actual native restart check

Evidence `REC_QA_20261109/fixed/{running-journals,children-before-kill,kill-proof,recovery-proof}.json` plus logs; source fixture retained. A precondition initially expected3assets, but the real document has4assets/3visual clips. That attempt stopped before any job; corrected using the known document hash and actual schema, not relaxing a product check.

- Active job `exp_940f69fe6ddf8f20`, queued job `exp_45fe7a07288c3bad`.
- Real Chromium child observed; active scratch and exact marker/job association were on disk **before interruption**. Queued job had allocated no scratch.
- Killed only the verified3189 API/render subtree, restarted in a separate process, read both real API job records.
- Both failed truthfully as interrupted, finishedAt set on recovery, mediaURLnull. Active scratch was removed; an unowned sibling sentinel survived.
- Document JSON and fileSHA stayed equal: `446619a3b891184dee6e62c08771eb709f7c25d04785fa495807c06bfe3355ba`.
- Qualification completed18:56:03.887UTC; restarted API32724 stopped. No completed duplicate render or new visual acceptance claim. This qualifies one active+one queued process-tree interruption/restart, not prolonged load testing or every crash mode.

## G10 actual screen-only browser workflow

QA API/UI on127.0.0.1:3188, data isolated in `CAP_QA_20261109/qa-data`. An original synthetic page/animation at`/qa-source`, titled`VF_SYNTHETIC_CAPTURE_ONLY`, was prepared. The user performed the native sharing choice; the agent did not grant OS/browser privacy permissions or use auto-select/fake-stream flags. No microphone requested.

The first stopped19.065s buffer showed the browser window instead of the intended tab. It was never uploaded. Repeated user reports referred to the **same** blob UUID, not new captures. That unsaved QA buffer was reset; subsequent UI/native-picker flow produced a new actual tab capture. One accidental click on an unnamed project-row button opened a Delete confirmation; it was not accepted, and the QA project remained present and was reopened. Restoring/foregrounding the intended Edge tab resolved the hidden chooser; no service failure was inferred from a minimized window.

Actual successful path: user share → MediaRecorder record → Stop → real Blob review → playback observed to7.3718s and paused → explicit owned-capture checkbox → actual local canonical upload → library refresh → page reload → reopen project/library. The correct new preview showed only the synthetic page, not browser chrome. No narration/EP01/EP06/output sample was produced.

Canonical stored asset:
- ID`capture-screen-1794251038176-e2c97b01`, WebM,5214022bytes.
- Actual local SHA256 matched the registered asset:`544f8f042b6296028b94bb68f016a200b22d4362086fdbc3e6f6367e227b8ba6`.
-2864×1434,45.696seconds (browser Blob45.695878),hasAudio=false; metadata from real registration/probe, not an assumed silent duration.
- Original source/license recorded; UI displayed the asset after reload/reopen. Evidence`CAP_QA_20261109/capture-proof.json`,`real-capture-review.png`,`capture-library-reopened.png`. No media/screenshot/private configuration committed.

This qualifies **screen-only capture/review/local registration/reopen** on this browser. Microphone/screen-with-audio remain unrun. Playback7.37s is not full continuous viewing. At19:06:19UTC the fresh Codex observation was5h86%consumed/14%remaining(300min),weekly82%/18%(10080min),ordinaryAllowedtrue. Guard85 deferred a new full-file decode; it was not counted as passed. No model switch/reset/purchase. Existing capture QA API800 remains a recorded owned helper until controlled cleanup; it is not the owner's release server.

## D6 and release still open

The planned final three1.5B microtasks were executed once at18:29:14–18:29:16UTC, using saved native narration/binding. Outputs: movement`extend arm towards blue pipe`; partner`point at the blue pipe`; detail merely`blue pipe`. Partial diagnostic utility only; the three-task semantic condition did not pass, so no new D6 implementation/full run was made. All evidence retained in`D6_LOCAL_20261109/microtask-generation`; owned runtime31672 stopped. Do not repeat these microtasks or add refusal tests as a substitute for completing generation.

No further7B trial/new model permission is inferred. D6 semantic generation, ASR/vision/conditioning/inpainting/Arabic/motion/3D and remaining output/quality gates remain explicit. Next at capacity: decode the already captured file once and finish QA cleanup; then prepare a finite integrated generation/resource decision against the existing failures rather than another unchanged prompt loop. Approved/F remain`daae482aac9de85e993599a6d010e29908ac567a`.
