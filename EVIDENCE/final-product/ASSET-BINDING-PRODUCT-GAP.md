# REAL PRODUCT ACCEPTANCE GAP — Asset Library binding in the fresh-content flow

**Status: BLOCKER — requires product review before acceptance can complete.**

**Do not "fix" this in acceptance infrastructure.** The acceptance driver has been
corrected to discover the real logical asset ref instead of hardcoding one; the
correction surfaced a genuine product gap.

---

## 1. What the acceptance is trying to prove

The complete user asset path, end to end, on **freshly generated** content:

```
upload -> Asset Library -> persisted relative path (DATA_DIR)
       -> GET /media/asset/:id (real bytes)
       -> explicit production binding (PUT /api/projects/:id/production/assets/:target/:logicalRef)
       -> Phase 6A resolution -> mediaMap -> Remotion
```

Every link except the binding is already proven and passing:

| Link | Status | Evidence |
|---|---|---|
| Asset Library upload (`POST /api/assets`) | **proven** | gate K |
| Persisted `Asset.path` relative to `DATA_DIR` | **proven** | gate K (retry-2 fix) |
| `GET /media/asset/:id` serves the real bytes (SHA256 match) | **proven** | gate K2 |
| Explicit production binding (`PUT .../assets/long/<ref>`) | **blocked** | gate L0/L2 |
| Phase 6A resolution into `mediaMap` | **blocked** | gate M |

## 2. The gap

**Freshly generated production content exposes ZERO bindable asset refs.**

The acceptance driver now discovers logical asset refs from the product's own
generated Long plan (no hardcoded value). For the acceptance content
(`FinalAcceptance_RFI_Backlog`, Long + `short_1`) the discovered set is empty:

```
discovered logical asset refs: []
discovered count            : 0
```

Because there is no `logicalRef` to bind to, the explicit binding route has
nothing to receive, and Phase 6A has nothing to resolve. The binding therefore
cannot be proven in the real fresh-content flow.

## 3. Root cause (verified in product code, not assumed)

A plan's `assetRefs` come from exactly one place in the Scenario:

`scene.production.screenInsert.assetRef`
→ `compile-visual-plan.ts:122`
→ `visual-production-pipeline.ts` (`sceneCues` and beat `cues`)
→ `RemotionCompositionPlan.scenes[].assetRefs[]`
→ `resolveProductionAssets` (Phase 6A, `production-asset-resolution.ts:196-232`)

`ProductionDirection.screenInsert.assetRef` is declared **optional**
(`packages/core/src/scenario/types.ts:176`). Every `assetRef` occurrence outside
the type declarations is a **consumer** that reads the field; none writes it.

The **only** producer of `screenInsert` in the product is the scenario generator,
and it never sets `assetRef`:

```ts
// packages/core/src/scenario/script-scenario-generator.ts:1683-1686
...(evidenceRecord
  ? { screenInsert: { title: 'Source Record', description: evidenceRecord.claim } }
  : {}),
```

Verification performed:

| Check | Result |
|---|---|
| `grep -c "assetRef" packages/core/src/scenario/script-scenario-generator.ts` | **0** — the generator never assigns an `assetRef` |
| `grep -ci "asset"` over `generateProductionScenariosFromProjectInput` (lines 1972–2250) | **0** — no ProjectInput field can produce an assetRef |
| `compileScenarioVisualPlan` on the fresh generated Long | `unique assetRefs: []`, `total usages: 0` |
| `compileScenarioVisualPlan` on the fresh generated `short_1` | `unique assetRefs: []`, `total usages: 0` |
| Every non-declaration `assetRef` site in `packages/`, `apps/` | consumer only (compile / resolve / validate / render) |
| Repo scenarios that DO carry an `assetRef` | `tests/fixtures/scenarios/progress-meeting.json` (`scenes[1].production.screenInsert.assetRef = 'asset-iva-progress-chart'`) and `tests/fixtures/scenarios/claim-variation.json` — both **hand-authored fixtures** |

The only `assetRef` in the repo that reaches a production plan lives in the
**progress-meeting fixture**, which the acceptance constraints explicitly forbid
using. Phase 6A itself is correct and well tested
(`tests/phase6a-renderer-assets.test.ts` passes) — but with **synthetic,
hand-authored** scenarios and plans, not generated ones.

## 4. Why this is a product gap and not an acceptance-script defect

The acceptance driver was corrected to remove the hardcoded `rfi-ageing-summary`
and to select a real ref from the generated plan using a deterministic rule
(required-unresolved → first-unresolved-optional → first-bindable-usage). That
rule is proven non-vacuous against synthetic plans carrying refs. On the real
generated content the rule correctly returns "no bindable ref".

Closing this from the acceptance side would require one of the following, all of
which are forbidden by the acceptance constraints and would invalidate the
result:

- fabricating a `logicalRef` that the generated plan does not use;
- mutating the generated Scenario to inject a `screenInsert.assetRef`;
- injecting a `mediaMap` entry by hand;
- falling back to the canonical progress-meeting fixture, which is forbidden.

So the gap must be reviewed in the product, not papered over in acceptance.

## 5. What is needed to close it (product scope, for review only)

The generator needs a supported, input-driven way to declare an asset usage so
that `screenInsert.assetRef` is populated for generated content. That is a
product change in `packages/core/src/scenario/script-scenario-generator.ts`
(and its input contract), and is **out of scope for acceptance**. Until it
exists, the fresh-content flow has no bindable asset usage.

Possible directions for the owning workstream to evaluate (not prescribed here):

1. Add an asset-usage input to the scenario generation contract and map it to
   `screenInsert.assetRef` on the scenes that carry evidence/screen inserts.
2. Or document explicitly that asset binding is only reachable for
   operator-authored/imported Scenarios, and scope acceptance of that feature to
   that path — in which case the fresh-content acceptance must state that
   binding is exercised on an authored Scenario rather than a generated one.

## 6. Current acceptance state

- `preflight` stops at **gate L0** with `REAL_PRODUCT_ACCEPTANCE_GAP`.
- `short-smoke`, `final-production` and `evidence` are gated on `preflight` and
  therefore do not run.
- No product code was modified. No fake asset ref was added. No test-only visual
  was forced. No `mediaMap` was fabricated.

## 7. Reproduce locally

```bash
# fresh project + generate (no Kokoro required)
# then inspect the generated Long plan's asset refs:
node --import tsx -e "
  process.env.BUILDTRAKE_DATA='.stills/repro/data';
  const { loadProductionState } = await import('./apps/api/src/services/production-state.js');
  const core = await import('./packages/core/dist/index.js');
  const s = loadProductionState('FinalAcceptance_RFI_Backlog');
  const r = core.compileScenarioVisualPlan(s.scenarios.long);
  const refs = [];
  for (const sc of r.plan.scenes) {
    for (const c of sc.sceneCues ?? []) if (c.assetRef) refs.push(c.assetRef);
    for (const b of sc.beats ?? []) for (const c of b.cues ?? []) if (c.assetRef) refs.push(c.assetRef);
  }
  console.log('discovered asset refs:', refs);
"
```
