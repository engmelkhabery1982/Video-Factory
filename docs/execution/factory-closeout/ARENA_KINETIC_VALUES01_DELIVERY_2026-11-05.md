# VF-20261105-KINETIC-VALUES01 — 5 November 2026

**IMPLEMENTED / PENDING OWNER REVIEW.** Existing kinetic value editing only, not renderer/layout work or whole-G5/episode acceptance.

## Identity / preservation

- Branch: `arena/25f29d2c-video-factory`.
- Implementation: `bbac6348ca03141d48e81475829b6135cadc50db`.
- Parent / required pre-edit FF base: `86290955a8ae1f67bac0f4ce6f54e0d889f7a315`; base parent `2a6c694c76681b6d32fe2ac68b4216b05ce90919`.
- Preservation stash `ec022c90a084a262183b88e45634fceadc9b48a1` remains retained and **not applied**. Accepted PROCESS-LABEL01 and earlier work were preserved.
- Pre-documentation remote observations: session `2a6c694c76681b6d32fe2ac68b4216b05ce90919`, working review `86290955a8ae1f67bac0f4ce6f54e0d889f7a315`, approved `0bedea4f5733c6eb50c35c847c98070f328177b1` (read-only). Installed owner checkout **not inspected**. The final documentation/delivery SHA and independent remote equality are reported at handoff after push, not predicted here.

## Bounded implementation

`listFormFrom` now retains kinetic word IDs. `buildKineticValues` patches exact text by those IDs, preserving the rest of the saved graphic and its action array, including `[]`. It does not rebuild surviving positions, sizes, emphasis, palette, direction or timing. Unchanged JSON, including null versus empty title, is preserved; explicit title/phrase edits affect only that field. New IDs reserve existing/removed object IDs and action IDs/targets, preventing silent retargeting. Canonical validation visibly refuses removal of a linked target. Successful Apply refreshes the form's row IDs so repeated Apply in the same mounted inspector cannot rename a newly added word.

New graphics still delegate to the existing builder. New phrases use its defaults; if those defaults collide with authored surviving positions, unchanged canonical spacing rules refuse Apply rather than automatically moving objects. No new layout algorithm, screen, renderer, validation/content-limit change or family.

### Exact changed files

| File | Change / evidence scope |
|---|---|
| `apps/web/src/lib/graphic-form.ts` | Kinetic identity seeding and minimal preservation helper |
| `apps/web/src/components/graphic/GraphicEditors.tsx` | Existing kinetic Apply uses helper; retains row IDs; no action filtering |
| `tests/helpers/kinetic-values-cases.ts` | Synthetic authored graphic and 20 PURE assertions |
| `tests/kinetic-values-source-check.mjs` | Installed-Node runner and before-fix reproduction; not a DOM/runtime substitute |
| `tests/kinetic-values.test.ts` | Same assertions for Vitest; not executed through Vitest here |
| `tests/web/kinetic-values.test.tsx` | 15 inspector DOM cases, **unexecuted** |
| `tests/editor-graphic-transaction-http.test.ts` | 3 new `KINETIC-VALUES01` HTTP cases, **unexecuted**; existing cases not rerun |

Documentation: this report and `docs/execution/factory-closeout/STATUS.md`. Implementation: **7 files, 322 insertions / 9 deletions**; production code alone **2 files, 27 insertions / 8 deletions**. Core/renderer/dependency/lock files unchanged.

## Actual checks, in execution order

| Evidence | Actual command / result |
|---|---|
| Before-fix PURE regression | `VF_KINETIC_VALUES_BEFORE=1 node --experimental-transform-types --test tests/kinetic-values-source-check.mjs` — **0 passed / 2 failed / 0 skipped**, exit **1**, before any production edits. Valid synthetic inputs reached the existing builder and the actual pure `mergeActions` function extracted verbatim from the component source. Both unchanged JSON and one-phrase-only expectations failed: IDs/text/geometry/emphasis/sizes/palette changed and an authored action disappeared. React was not mounted. |
| After-fix PURE | `node --experimental-transform-types --test tests/kinetic-values-source-check.mjs` — final **20 passed / 0 failed / 0 skipped**, exit **0**, Node **v22.22.3**. Includes the same two assertions, both directions/formats, exact spaces/Arabic marks/English punctuation, supplied/static actions, null/empty titles, middle removal/insertion/addition, ID collisions/refusal and unchanged new-graphic defaults. No historical layout/render suite ran. |
| TS syntax only | Installed Node `stripTypeScriptTypes` parsed the model and three `.ts` test files listed in the command below; exit **0**. This erases/transforms types, **not a typecheck or TSX compilation**. Node's experimental-feature warning was expected. |
| Diff/scope | `git diff --check`, `git diff --cached --check`, and `git diff --exit-code -- packages/core packages/video package.json package-lock.json` — exit **0**. Retained stash verified with `git stash list` / `git rev-parse refs/stash`. |
| Availability | Individual executable probes for `node_modules/.bin/vitest`, `tsc`, `vite`, `tsx`: **absent**; PATH probes likewise found none. No install or download attempted. |
| Vitest / DOM / HTTP | **UNAVAILABLE / NOT RUN.** The 15 DOM and 3 HTTP cases are test code, not executed UI/save/reopen evidence. |
| Type/build | **UNAVAILABLE / NOT RUN:** core/API/web typechecks, TSX compilation, `npm run build:core`, `npm run typecheck`, `npm run build:web`. Historical passing checks do not cover this increment. |
| Actual browser / Remotion / owner review | **NOT RUN / PENDING OWNER HOST**, not acceptance. No historical tests/renders, audio work, preview server or alternate proof project. |

Exact syntax-only operation (no imports executed from the test files):

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
for (const path of ['apps/web/src/lib/graphic-form.ts', 'tests/helpers/kinetic-values-cases.ts', 'tests/kinetic-values.test.ts', 'tests/editor-graphic-transaction-http.test.ts']) {
  stripTypeScriptTypes(fs.readFileSync(path, 'utf8'), { mode: 'transform', sourceUrl: path });
  console.log(`TS syntax parsed: ${path}`);
}
JS
```

Local, ignored logs: `.stills/kinetic-values01-checks/before-fix.log` and `after-fix.log`. No installations, provisioning, dependency/runtime/browser/model/executable downloads, new environment/service, provider/cost/permission changes, private uploads, owner data/output/WAV/assets/timing edits, approved/main changes, force-push or deployment in this slice.

## Next bounded owner-host gate

Using the owner's existing environment, run only the new focused tests (commands **not run here**), then the affected type/build gates:

```sh
./node_modules/.bin/vitest run tests/kinetic-values.test.ts tests/web/kinetic-values.test.tsx
./node_modules/.bin/vitest run tests/editor-graphic-transaction-http.test.ts -t KINETIC-VALUES01
```

Review actual unchanged Apply, a one-field edit, stable membership IDs and linked-removal refusal through UI save/reopen, plus real output for this affected edit path. No installation authorization or new scope choice is requested. Whole G5/Order03/factory and cinematic/religious episode quality remain open.
