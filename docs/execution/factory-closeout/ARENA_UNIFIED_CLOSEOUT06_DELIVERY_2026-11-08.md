# CLOSEOUT06 delivery — implementation, qualification and the finite open list

**Status: WORKING INCREMENT DELIVERED; WHOLE-FACTORY ACCEPTANCE OPEN. Not closed. Not code-complete.**

Session branch `arena/88809335-video-factory` (fixed by the platform). The owner's message named `arena/da9e43e6-video-factory`; that is the *review* branch holding the required base. This session branch was a pure ancestor of that base, so it was **fast-forwarded** to it: no reset, no clean, no force-checkout, nothing lost.

---

## 1. Verified source state

| Fact | Value |
|---|---|
| Required reviewed base | `fa1e1cea79fb67a93081731f953869ba5b0a2353` |
| Session branch before work | `b235b002df4cab2237ef0a8093b1aeef225f6903` |
| Relationship | `b235b00` is an **ancestor** of `fa1e1ce` (verified with `git merge-base --is-ancestor`); fast-forward preserved all 209 intervening commits |
| Delivery commit | `d1cec66ba5ffde8192cf58c0d6e5f5161980d48a` |
| Its parent | `fa1e1cea79fb67a93081731f953869ba5b0a2353` (the exact required base) |
| Branch | `arena/88809335-video-factory` |
| Remote | `origin` = `https://github.com/engmelkhabery1982/Video-Factory.git` |
| Approved authority (read only, never advanced) | `review/owner-approved @ daae482aac9de85e993599a6d010e29908ac567a` |

**Remote equality is verified in §8 after the push.** No branch other than the session branch is pushed to; `main`, `review/owner-approved` and every other branch are untouched. No force operations.

### Changed paths (complete, 12)

```
.gitignore                                          (ignore generated EVIDENCE/journey reports)
apps/api/src/services/factory-service.ts            (two repairs, §5)
package.json                                        (qualify:* scripts)
scripts/host-qualify.mjs                            (new: owner-host entry point)
scripts/qualify-input-routes.mjs                    (new)
scripts/qualify-production-journey.mjs              (new)
scripts/qualify-recovery.mjs                        (new)
scripts/qualify-visual-families.mjs                 (new)
tests/factory-technique-media-need.test.mjs         (new: PURE regression for the repaired defect)
tools/lib/journey-harness.mjs                       (new: isolated storage + owned synthetic PNG)
tools/lib/ts-module-graph.mjs                       (new: type-binding elision reader)
tools/lib/ts-source-loader.mjs                      (new: dependency-free source loader)
docs/execution/factory-closeout/RELEASE_EXIT_MATRIX.md  (new: the finite matrix)
docs/execution/factory-closeout/ARENA_UNIFIED_CLOSEOUT06_DELIVERY_2026-11-08.md (this file)
```

No owner data, output, WAV, approved text, timing, media or configuration was read for writes or modified. All qualification runs used `mkdtemp` roots under the system temp dir and refused to run if a root resolved onto `data/` or `output/`.

---

## 2. Environment reality (why some labels are absent)

| Tool | Present | Consequence |
|---|---|---|
| Node 22.22.3 | yes | TypeScript runs natively (`--experimental-transform-types`) |
| `node_modules` | **no** | no `fastify`, `@remotion/*`, `vitest`, `typescript`, `react` |
| `ffmpeg` / `ffprobe` | **no** | no mux, no measured audio facts |
| Chromium / Remotion | **no** | no rendered output |
| GPU / model runtimes | **no** | no vision, inpainting, ASR, Arabic TTS, video, 3D |

Nothing was installed or downloaded. Instead of reporting "everything blocked", the canonical **service layer** was made executable with a loader (below), which is where the real value of this increment comes from.

### What the loader is, and what it is not

`tools/lib/ts-source-loader.mjs` + `ts-module-graph.mjs` are **not** mocks, fixtures or stubs. They only reproduce the decision `tsc` already makes: elide imports that name types. Without them, Node keeps `import { DialogueTurn } from './types.js'`, which fails at runtime because `DialogueTurn` is an interface. With them, the *same TypeScript source* runs with the *same value bindings*.

Proof of boundary honesty: 164 of 175 API+core sources load; the 11 that still fail do so **only** on `fastify` or `@remotion/*`. Nothing else is hidden.

---

## 3. Executed evidence — actual commands and results

Node version 22.22.3, all runs from the repository root, all storage isolated.

### 3.1 PURE contracts (no I/O, no dependencies)

```
node --experimental-transform-types --test tests/*.test.mjs
```

| File | Result |
|---|---|
| `capture-state-machine.test.mjs` | 31 pass, 0 fail, 0 skip |
| `factory-data-recovery.test.mjs` | 9 pass, 0 fail |
| `factory-masked-correction-pure.test.mjs` | 27 pass, 0 fail |
| `factory-technique-media-need.test.mjs` (new) | 5 pass, 0 fail |
| `masked-correction-sd-cli-contract.test.mjs` | 9 pass, 0 fail |
| `masked-correction-ui-pure.test.mjs` | 6 pass, 0 fail |
| **Total** | **87 pass, 0 fail, 0 skip** |

Earlier session evidence (CLOSEOUT05 host review) recorded 134 affected Vitest cases and 36 PURE. **Those are reused, not repeated**: the source paths they cover are unchanged by this increment except `factory-service.ts`, whose affected groups are listed in §3.6 as owner-host work.

### 3.2 Production journey — real service, isolated storage

```
npm run qualify:journey
# node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs scripts/qualify-production-journey.mjs
```

**14 passed, 0 failed.** Steps that actually executed against `factory-service.ts`:

1. `createDraft` from a supplied script (portrait, silent) → 3 treatments, 3 scenes
2. Supplied words preserved exactly (159 chars)
3. Treatment switch changes structure, keeps words
4. One owned synthetic PNG per scene bound through the canonical library
5. A still with no recorded source/licence is **refused** (`FACTORY_ASSET_INVALID`)
6. Stale revision refused (`FACTORY_REVISION_CONFLICT`, `currentRevision 4`)
7. Apply preflight clean (`canApply`, 0 speech calls)
8. `applyDraft` creates the project + editor document (3 visual clips, each keeping `sourceAssetId`)
9. Re-applying the same revision **reuses** the project (no duplicate)
10. Real trim: clip 0 `4s → 5s`, following clips moved, project `12s → 13s`
11. Editor **refuses** a negative duration and leaves the document byte-identical
12. Undo restores the previous revision
13. Reopen keeps text, identity/asset bindings, timing and the edit
14. On-disk draft (13,057 B) and `project.json` (2,693 B) are self-describing

### 3.3 Input routes — all 11 rows

```
npm run qualify:inputs
```

**16 passed, 0 failed.** Row-level results are in the matrix §B. Notable honest outcomes: a brief alone produces **no** scenes and names the planner gate; a conflicting script+storyboard is reported with both sources; audio-only and video-with-audio are marked BLOCKED rather than passed.

### 3.4 Visual families — all 7

```
npm run qualify:families
```

**9 passed, 0 failed.** Structure/validation/values proven for every family; pixels explicitly not. Exact numeric value `12.3456` survives; Arabic RTL and Arabic words survive a reopen; two families coexist in one draft.

### 3.5 Readiness, faults, restart, recovery

```
npm run qualify:recovery
```

**9 passed, 0 failed.**

| Check | Result |
|---|---|
| Capabilities computed from real host state | pass |
| Masked correction reports unavailable with no runner | pass (BLOCKED row, truthful) |
| Two **concurrent** identical applies | converge on **one** project; second reports `reused` |
| Stale `expectedRevision` on Apply | refused, **no project written** |
| Corrupt draft sidecar | `FACTORY_DRAFT_CORRUPT` (500), damaged file **preserved**, recovery tool named |
| **Separate process** reads the same draft | same revision, words intact, format portrait |
| Offline backup → verify → restore of real factory data | 9 files, **9 byte-identical** |
| Tampered backup | verification fails, restore writes nothing |
| Symlinked data root | refused |

### 3.6 Host qualification entry point — dry run here

```
node scripts/host-qualify.mjs
```

Executed correctly and reported honestly: `node_modules absent → BLOCKED (exit 2)`, listing the not-run steps as **not passes** and printing the exact `npm ci` instruction. It creates an isolated temp data/output root, records branch/tip/parent/dirty state, and promotes nothing. Its real value is on the owner host (§7).

---

## 4. Evidence labels — kept separate, as required

| Label | Occurred here? | Where |
|---|---|---|
| IMPLEMENTED (code + tests present) | yes | throughout |
| PURE (no I/O) | **yes, 87 cases** | §3.1 |
| SERVICE (real canonical service, isolated storage) | **yes, 48 steps** | §3.2–3.5 |
| HTTP (`app.inject` real routes) | **no** — fastify absent | owner host §7 |
| DOM/component (happy-dom) | **no** — vitest absent | owner host §7 |
| Real browser | **no** | owner host §7 |
| Real engine output | **no** | blocked, §D package |
| Rendered output | **no** | blocked |
| Quality review / listening / acceptance | **no** — owner only | §7 |

A green service test is not a rendered frame, and neither is acceptance.

---

## 5. Defects found and repaired (not report-only)

### 5.1 A still could be bound to a "screen recording" row

**Reproduction (before the fix):** change a draft row's technique to `screen_recording`, then bind an eligible still:

```
after patch, draft status = blocked
missing = [{ kind: "recording", ... }]        ← correct at first
BOUND a still to a screen_recording scene.
draft status = review_required   missing = []  ← DRAFT CLAIMED READY
applyPreview.canApply = false                  ← only preflight caught it
apply refused: EDITOR_VALIDATION_FAILED | visual vc_u01 is a screen recording but its asset is not a video
```

**Root cause:** `sceneNeedOf` derived the media requirement from the *planner's suggested shot* only. Changing the technique never changed the requirement, so an image row stayed `image_needed`, accepted a still, and the inconsistency surfaced much later at Apply.

**Repair:** the owner's explicit technique now decides (`factory-service.ts`):

```ts
if (s.technique === 'screen_recording' || s.technique === 'footage_clip') return 'screen_recording_needed';
```

plus a footage-specific refusal message so the two families are not conflated.

**After the repair:** the row reports `kind: "recording"` with a screen-recording reason; `bindLocalImage` refuses with 409 and the draft is unchanged (revision untouched, nothing bound); `footage_clip` reports a footage reason. `tests/factory-technique-media-need.test.mjs` (5 cases) locks this in, including a control that a `still_image` row still takes a still and that Apply stays closed.

### 5.2 A corrupt draft surfaced as a bare crash

`loadDraft` called `JSON.parse` unguarded, so a damaged sidecar produced a generic 500 with no actionable message and no assurance the file was preserved. It now throws `FACTORY_DRAFT_CORRUPT` / `FACTORY_DRAFT_UNREADABLE`, **leaves the damaged file in place for recovery**, and names `scripts/factory-data-recovery.mjs`. A non-object document is refused the same way. Verified in §3.5.

### 5.3 One earlier family test was wrong, not the product

`actor_action`/`kinetic_text`/`numeric_comparison` cases initially failed because the qualification script used values the validators correctly refuse (`easing: 'easeInOut'` instead of `'ease_in_out'`, word `size` outside `0.02–0.2`, `decimals` above 3). The validators were right; the script was corrected. This is recorded so it is not mistaken for a product defect.

---

## 6. The finite release exit matrix

See **`RELEASE_EXIT_MATRIX.md`** in this folder: every G1–G12 gap, all 11 input rows and all 7 visual families, each with the required outcome, existing authority, exact missing implementation, required engine, verification method, existing evidence, missing acceptance evidence, and an A/B/C class — plus the consolidated resource decision package (D1–D7).

Its summary: **the code gaps inside this tree are closed for G1, G4 (parser), G5 (structure), G9 (identity), G11 and G12 (recovery).** What remains is runtime (D1–D7), render (Remotion), browser/HTTP/DOM execution, and owner judgement — none of which this environment can produce.

---

## 7. Owner-host checklist — finite and executable

Run in order on the owner machine. Each line is a command and its expected observable result. **Stop at the first failure** and send the report; do not jump ahead.

**Step 0 — prepare (once)**
```
git fetch origin
git switch arena/88809335-video-factory
git pull --ff-only
git rev-parse HEAD          # expect d1cec66ba5ffde8192cf58c0d6e5f5161980d48a
npm ci                      # existing dependencies only; nothing new
```

**Step 1 — automated verification (one command)**
```
npm run qualify:host
```
Expects: core rebuild, API typecheck, web typecheck, web build, PURE group, and the five affected Vitest groups, each with a recorded exit code, written to `host-qualification.json`. It uses disposable temp storage and never touches `data/`, `output/` or your configuration.
- If core fails to build, everything after it is skipped on purpose — fix core first.
- Any `not run` line is **not** a pass.

**Step 2 — the same three service qualifications on your host** (they need no browser):
```
npm run qualify:all
```
Expects `14 / 16 / 9 / 9` passing steps and 0 failures. A failure here is a real defect: send the printed step name.

**Step 3 — the browser groups the sandbox could not run**
```
npx vitest run tests/web/capture-panel.test.tsx
npx vitest run tests/web/masked-correction-panel.test.tsx
npx vitest run tests/web/picture-analysis.test.tsx tests/web/intake-panels.test.tsx tests/web/storyboard-cards.test.tsx
```
These are component-level (happy-dom), still not a real browser.

**Step 4 — real browser (needs a provisioned Chromium)**
```
npm run provision            # only if Chromium is not already provisioned
npx vitest run tests/external-audio-seek-browser.test.ts
```
Then open the app and walk one real journey by hand: intake → treatments → scene completion → Apply → edit → preview → export → reopen. Record what you saw; a passing test does not replace this.

**Step 5 — render the seven families (needs Remotion + Chromium + ffmpeg)**
For each of `process_path`, `actor_action`, `kinetic_text`, `numeric_comparison`, `still_image` (supplied), `footage_clip` (supplied), `screen_recording` (supplied), export a short clip and keep the file. This is the only thing that closes the render columns.

**Step 6 — consented capture (G10), only if you choose to**
Capture an **owned synthetic surface** (a window you made for this), confirm playback, upload, retry a failure, discard, and confirm the temporary URLs/resources are gone. Never capture your own screen or microphone implicitly.

**Step 7 — engine rows, only after a scoped decision each (D1–D7)**
Each row needs: the resource decision recorded, the artifact present with its hash recorded, the runtime configured, one acceptance output produced, and **your** visual/listening review. Fixtures and adapters never close these.

**Step 8 — release decision (yours alone)**
Nothing in this delivery advances `review/owner-approved`, merges `main`, deploys or publishes. After your acceptance, the review agent advances the approved branch; this session branch stays a normal fast-forward target.

---

## 8. Remote verification

Recorded after the push in the section below (branch tip must equal the local tip).

---

## 9. Rollback and recovery

**Code rollback (safe, no force):**
```
git fetch origin
git switch arena/88809335-video-factory
git revert --no-edit d1cec66ba5ffde8192cf58c0d6e5f5161980d48a   # or: git reset --hard fa1e1ce (local only)
```
The delivery commit's parent *is* the required reviewed base, so reverting it restores the base exactly. Nothing else was touched, so no other rollback is needed.

**Data recovery (no Git involved):**
```
node scripts/factory-data-recovery.mjs backup --data <DATA_DIR> --out <BACKUP_DIR>
node scripts/factory-data-recovery.mjs verify --backup <BACKUP_DIR>
node scripts/factory-data-recovery.mjs restore --backup <BACKUP_DIR> --data <EMPTY_TARGET> --confirm
```
Restore is non-merging by design: the destination must be absent or empty, tampering fails closed, and symlinked/junction roots are refused. Verified here on real factory data (9 files, 9 byte-identical).

**Damaged draft:** now reported as `FACTORY_DRAFT_CORRUPT` and left on disk. Restore it from an offline backup; do not delete it before you have that backup.

---

## 10. Honest limitations of this delivery

- **No pixel was rendered.** No claim about visual quality, direction or composition.
- **No audio was produced or listened to.** No speech claim.
- **HTTP/DOM/browser evidence was not produced here.** fastify, vitest and Chromium are absent; the owner-host script covers them and says so.
- **The service execution is real but scoped:** it exercises the canonical service functions, not a running server process.
- **Six of seven engine capabilities remain BLOCKED** with a named resource each; the seventh (masked correction) has code and no runtime.
- **Whole-factory acceptance, episode production, EP06/EP01, scheduling/BuildTrack/BIM and release promotion are untouched** and remain out of scope for this order.
- **The factory is not closed and not code-complete.** What is delivered is an operating, honestly-labelled core with a finite open list.
