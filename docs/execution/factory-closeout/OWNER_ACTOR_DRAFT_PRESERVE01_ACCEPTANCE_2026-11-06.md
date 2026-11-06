# ACTOR-DRAFT-PRESERVE01 — owner functional review, 6 November 2026

Scope: existing Order03 actor authoring, not a new engine/family. Work base69b1b3a; approved base d34d36e. No external worker or duplicate Arena dispatch.

An actor inspector erased a local title and blank pose input whenever the parent graphic changed, including action-only edits. The new DOM regression first failed on the lost title after correcting a fixture call mistake. Actor values now compare their own base separately from timed actions: action-only updates preserve raw local fields, Apply uses current actions, and an external pose/object/title change blocks a dirty Apply until the user explicitly chooses current values. Undoing the conflict retains typing. Removal checks current action references. Clean replacements and own-Apply echoes still refresh.

Verification on the owner host:
- New regression1, existing actor-authoring20 and numeric/process/kinetic-refresh3:24/24. Existing action-draft16/16, total40/40. An initially mistyped action-test filename matched no fourth file; the correct file was subsequently run, not counted as skipped/pass.
- Core build, web types and web build exit0. No dependencies or runtimes installed.
- Real production UI, isolated copy of earlier synthetic actor QA at3161, project Factory_007756f6e2c8. Local Arabic title and raw blank pose remained visible while editing actions. Invalid blank pose was rejected. A trial65-degree action was also rejected for discontinuity with the following70-degree action; it was not counted as a valid action update.
- A valid easing change to linear then preserved local Arabic title and armAngle13. Apply and Save revision4, browser reload/reopen retained all three. A dirty local title survived Undo revision5; conflict alert and disabled Apply were visible. Explicit current values and Redo revision6 restored the saved title/pose/actions. An observation taken during the async Redo still showed revision5; a later completed-state read independently confirmed revision6, Apply enabled, title/13/linear.
- Actual shared-renderer preview prv_78a71d2ecbd64d83, revision6,3seconds/90frames1920x1080silent. Server completion, independent media probe, and actual early/late frames reviewed. Arabic title/box label remain visible; actor arm/box/tick actions remain. This is a short procedural proof, not cinema or full continuous film/audio review.

Private evidence: ACTOR_DRAFT_PRESERVE01_UI_QA/after-reopen.json, render-status.json, ui-proof.json, actor-draft-preview.mp4, early.png and late.png. New QA data was copied from synthetic QA, not owner storage. Initial QA start used an unsupported Windows absolute loader path; launching the existing tsx from repo cwd fixed setup. No product fix/installation attributed to that setup error.

Approved isolated checks and exact installed/remote SHAs are recorded separately after safe promotion. WholeG5/G6/G7, factory release and both religious episodes remain OPEN. This increment does not close them.

Isolated approved integration:40/40, core/web types and builds exit0 on3e3f9b5. Browser/render were run on the work tree with the identical component delta; unrelated pendingOrder02 remains excluded from approved.

