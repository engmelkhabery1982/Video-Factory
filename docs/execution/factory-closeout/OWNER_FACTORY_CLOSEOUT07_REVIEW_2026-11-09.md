# Owner CLOSEOUT07 host review —9November2026

Reviewed delivery:31ea9d8ac0530d5e6d5790b9641ca57e1e50d271 on arena/88809335-video-factory, descendant of4a3673ef4f1e766844ea88b91539c95f47903fff. Eleven incoming paths. Working review tree fast-forwarded, owner untracked tests/cache and concurrent local D6 changes preserved. No approved/F/3130/owner-store promotion.

## Additional actual defects and repairs
1. Scratch selection measured the directory without raw-frames.mp4. A250-character directory was accepted although its child exceeded259. New regression FAILED, then PASSED after budgeting the actual raw child for candidate and fallback roots.
2. Cleanup could throw after rendering and prevent the ready record from being saved. A controlled EBUSY regression FAILED (the completed export appeared failed), then PASSED after recording a cleanupWarning while preserving the settled outcome. Renderer in this regression is explicitly a delayed double; the job/filesystem lifecycle is real.
3. The finite native script's owner-path branch wrote to a hard-coded C:/Users/Owner tree and a shared deterministic temp directory outside its cleanup root. It was NOT run in that form. All writes now stay below its unique mkdtemp root, verified before recursive cleanup. It resolves the same already-installed ffmpeg/ffprobe packages as this host. A known unsupported long path is an observation, not a counted success/failure of the repaired strategy.
4. Host entry now requires both actual binaries before counting the native check; otherwise records NOT RUN. Full host entry was not rerun (it repeats historical journeys); changed script syntax checked only.
5. Delivered test assertions that returned PASS after a denied symlink or used `|| true` were corrected. Windows junction test actually ran on host; no fake pass/skip. One fixture assumption forced scratch to stay under export-work even when safe fallback is required; now checks actual budget, persisted scratch identity and cleanup.

## Executed checks, no double counting
- New owner regressions2FAIL before/2PASS after, remaining18 delivered path/lifecycle cases ran once on host:20 unique cases PASS,0 actual skips. Different targeted invocations filtered the complementary cases; filtered cases are not additional passes.
- Existing local API tsc --noEmit:exit0 on the merged review source; no core/web source changes in07, prior unaffected build evidence reused.
- node --check changed host/native scripts and git diff --check:exit0.
- Real finite FFmpeg check:3 meaningful checks PASS,0FAIL/0SKIP. Installed binary refused a measured262-character original-shape path and308-character padded path; the79-character scratch path opened. These two refusals are observations, not product successes. No system configuration or binary changed.
- Original134/36,5service/4HTTP/48journeys and historical whole-factory suites were NOT rerun or added to totals.

## Actual integrated native export on the original path shape
An isolated COPY of the owned prior three-colour QA project was placed at CLOSEOUT07_HOST_QA/temp/vf-journey-8yFt0X/data; the failed06 original was preserved. The old per-job raw path is exactly262characters. Actual API POST/GET, installed Remotion/Chromium/FFmpeg/ffprobe, no renderer substitute:
- job exp_2368451d4c11e69f READY, projectFactory_6f48d0d55af7, frozen/currentrevision3, stale=false.
-12.000seconds,360frames,1080x1920,30fps,silent(no audio/narration),144228bytes.
- SHA2564e3c228c726faa28fb84a53f04f4eff2dd83fbb07ab5abacbbb5afd5b9e84df5, byte-identical to the previously decoded/visually sampled native06 output. Reused that exact-file visual/decode evidence; no duplicate render for appearance and no new cinematic/listening claim.
- created09:59:38.867UTC; filemtime10:00:13.967UTC; finishedAt10:00:14.070UTC. Finished follows the actual file write and render settlement, not enqueue.
- Persisted scratch was the unique exp-a57d8d76400310212cbf4a2cbe1f546c under system temp and was removed. Canonical final file/URL/project/revision remain unchanged in meaning.
- Editor document JSON before/after is identical, revision3 after reopen.
- QA3187 server stopped, including explicit listener verification. Owner3130 untouched.

Local evidence: DIGITAL_INCOME_CONTROL/AUTONOMOUS_EXECUTION_2026-10-27/CLOSEOUT07_HOST_QA/{start,status,native-export-proof,scratch-proof,before}.json and API logs. No media/data/model/private configuration is committed.

## Decision and rollback
The07 path and settlement repair is functionally qualified on THIS host after the owner fixes. This is not whole-factory, semantic-planner, cinematic, capture, audio or release acceptance; approved/F remain unchanged.
Rollback is a normal reviewed revert of the exact source implementation commit eaef51c8be17188cc6db8d5a82bd6844844e3404 plus subsequent owner source-fix commits as needed, in reverse dependency order. The three Arena tip follow-ups change documents only; reverting the final document tip alone does NOT restore source to4a3673e. No reset/clean, data migration or owner file move is required.
