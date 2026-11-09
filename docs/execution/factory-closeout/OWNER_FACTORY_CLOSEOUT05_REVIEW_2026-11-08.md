# CLOSEOUT05 host qualification — 8 November 2026

Status: HOST REVIEWED WITH REPAIRS; WHOLE FACTORY ACCEPTANCE OPEN.

## Source / preservation

Exact remote branch `arena/da9e43e6-video-factory` verified at `26f573337ee69fd091063fb56d0e39a1b3f3d0f4`, direct parent `59089ab47c943245909bcf673c4e2d468942d002`. Incoming19 paths/+1309/-23 independently inspected; isolated review checkout advanced FF, preserving owner regression files and cache. No F/approved/schedule changes. Approved remote independently read at `daae482aac9de85e993599a6d010e29908ac567a`.

## Findings and repairs (actual failures, not report-only review)

1. `numberEnv` converted an absent string to0, clamping default strength to0.05 and cfg-scale to1. The new actual-route adapter test failed at the strength assertion. Empty/undefined values now select the declared defaults1/7.5. Explicit finite values still use bounds. The real adapter-argument assertions now pass.
2. After fixing defaults, the same real-route test reached review but Apply returned409 `FACTORY_CANDIDATE_STALE/no_identity`. The adapter marks imported assets generated-locally, invoking the ordinary localCandidate prompt-identity gate, while masked jobs intentionally have a separate job/run/review/target identity. Under the canonical draft lock, only the already validated maskedApplication path uses that masked identity; ordinary binds retain their original candidate gate. Actual import→review→Apply now passes with a labelled fake CLI. Source/result/hash/target checks are retained.
3. `configureSdCliMaskedCorrection` recursively removed the whole configurable `work` root even when disabled. Owner sentinel regression proved deletion of an unrelated disposable file. Cleanup now resolves the exact run below work, refuses linked ancestors/junctions, requires a bounded matching owner marker and canonical run name, and deletes only that owned run. Unknown files/directories, malformed markers and junctions remain intact. Work root itself is retained. Per-run marker is written before inputs; startup recovery and finally use the same bounded cleanup. Actual Windows-junction/marker/sentinel regression passed. No owner data used.

## Executed current-tree evidence

| Check | Result |
|---|---|
| Core rebuild | exit0 |
| API typecheck | exit0, including repaired adapter |
| Core/web types | exit0 |
| Production web build | exit0;106 modules; `index-CdzLJewQ.js` |
| Capture actual React component / browser doubles |32/32 |
| Masked panel actual React component / client doubles |10/10 |
| G7 actual HTTP/store, mock and fake CLI integration |30 unique passing cases:29-case final repair group plus added marked-recovery case; unchanged passing cases reused |
| Local-image/freshness/visual-review compatibility |62/62; rerun because shared binder and CLI fixture changed |
| sd-cli protocol + masked PURE contracts |36/36,0skip |
| Whitespace | diff check passes |

Vitest total across current passing groups:134 unique cases; not a full-repository suite. Initial run was69pass/1fail of70, not green. Three fixes above were verified without weakening assertions. Filtered test cases were not added as passes. Historical CLOSEOUT04 evidence is retained separately, not added again to these totals. Recovery/file-symlink skip from that earlier review stays a skip.

## Interface and evidence limits

Pinned upstream source was read at https://raw.githubusercontent.com/leejet/stable-diffusion.cpp/1d0a58a35050d285b1d6fb1bc68a92924d35825e/examples/cli/main.cpp and https://raw.githubusercontent.com/leejet/stable-diffusion.cpp/1d0a58a35050d285b1d6fb1bc68a92924d35825e/src/pipeline/image.cpp : one-channel mask loading and white-region convention are source-backed. A runtime help-flag probe does not establish binary identity, model availability or visual quality. No new executable/model/dependency was obtained or enabled.

The fixture integration proves argument construction, actual adapter child process/import/provenance, review/Apply, cancellation/corrupt-output refusal and scratch cleanup. It does not prove real sd-cli inference. Capture tests prove actual component controls/object-URL lifecycle using browser doubles and synthetic blobs; they do not prove native consented capture or playable media. The previous browser unconfigured-mask check remains valid for its unchanged path; no new live browser/capture/output claim is made. The known Edge read blocker was not retried without a documented capability change.

## Remaining finite release gates

- G7: an exact already-authorized inpainting runtime/model, verified configuration, real owned image output and visual review through Apply/reopen. This review supplies no download/run permission for an absent model.
- G10: native capture on an owned synthetic surface with actual browser consent, real playback/upload/retry/discard and resource cleanup. No implicit screen or microphone capture.
- G1–G12: integrated supported-input/family/output/semantic/listening/recovery acceptance remains as the unified matrix records. Local semantic planner, ASR/alignment, real vision/conditioning, natural Arabic, generated motion,3D and talking-character evidence is not supplied by these tests. Missing runtimes remain explicit; no fixtures presented as completed capabilities.
- Existing Blender4s permission and deferred EP06/EP01 are unchanged. No engine installs, private uploads, publication, authority promotion or timing/media changes occurred. Final approved/F promotion still requires the chosen release's actual acceptance gates; this is a reviewed working increment only.
