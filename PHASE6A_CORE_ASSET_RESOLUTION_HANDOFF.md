# PHASE 6A — TRACK A HANDOFF
# CORE PRODUCTION ASSET RESOLUTION

## 1. BASELINE & ENVIRONMENT

- **Approved Starting Baseline**: `d7062a37864e5db5e4810e90ce10931ae9d7ce73` (Phase 5E closure commit)
- **Arena Session Working Branch**: `arena/01a0f15b-video-factory`
- **Upstream / Shared Branches**: Untouched (`main`, `arena/01a0eeb0-video-factory` not modified)
- **Implementation Commits**:
  - `2b78430`: `feat(assets): add deterministic production asset resolution`
  - `e85fd4f`: `test(assets): cover production asset resolution`
- **Final HEAD**: Current HEAD of `arena/01a0f15b-video-factory` after the documentation commit; resolve dynamically with `git rev-parse arena/01a0f15b-video-factory`.

---

## 2. RESOLUTION PRIORITY — LOCKED ORDER

The resolution engine evaluates each unique logical asset reference (`assetRef`) using the exact locked priority order:

1. **Priority 1 — Explicit Binding**:
   - Checked via `explicitBindings[assetRef]`.
   - If present, the specified asset ID is authoritative.
   - If the specified asset is missing from the library, inactive, blocked, or has empty source/license provenance, resolution halts with a structured error (`PRODUCTION_ASSET_LIBRARY_ENTRY_MISSING`, `PRODUCTION_ASSET_INACTIVE`, `PRODUCTION_ASSET_BLOCKED`, or `PRODUCTION_ASSET_PROVENANCE_INVALID`). It never silently falls through to exact ID or alias tags.

2. **Priority 2 — Exact Asset ID**:
   - Only evaluated if no explicit binding exists.
   - Checked via `asset.id === assetRef` for active, eligible assets in the asset library.
   - If an eligible asset matches exact ID, it resolves with source `'exact_id'`.

3. **Priority 3 — Explicit Alias Tag**:
   - Only evaluated if not explicitly bound and not resolved by exact ID.
   - Checked via exact tag matching: `asset-ref:<logicalAssetRef>`.
   - If exactly one eligible asset has this tag, it resolves with source `'alias_tag'`.
   - If multiple eligible assets match, resolution fails with a structured ambiguity error (`PRODUCTION_ASSET_BINDING_AMBIGUOUS`).
   - Explicit binding removes ambiguity.

4. **Otherwise — Unresolved**:
   - No fuzzy matching, no name similarity, no substring guessing, no AI inference.
   - Emits structured finding `PRODUCTION_ASSET_BINDING_MISSING`.

---

## 3. ALIAS TAG FORMAT

Exact format:
```
asset-ref:<logicalAssetRef>
```
Example:
```
asset-ref:asset-iva-progress-chart
```
Helper utilities:
- `formatAssetRefAliasTag(logicalAssetRef)` -> `asset-ref:${logicalAssetRef}`
- `parseAssetRefAliasTag(tag)` -> extracted `logicalAssetRef` or `null`

---

## 4. ASSET ELIGIBILITY POLICY

An asset library entry is eligible for production resolution only when:
1. `status === 'active'` (archived assets are never automatically rendered)
2. `blocked === false` (blocked assets are never automatically rendered)
3. `source` is a non-empty string after trim
4. `license` is a non-empty string after trim

Helper utility:
- `isProductionAssetEligible(asset)` returns `{ eligible: boolean; errorCode?: ProductionAssetErrorCode; reason?: string }`

---

## 5. REQUIRED vs OPTIONAL REFERENCES

Preserves the existing Phase 5 `assetRef.required` semantics:
- **Unresolved optional reference**: Emits a `warning` finding (`PRODUCTION_ASSET_BINDING_MISSING`), report remains `valid: true`, summary status `'warning'`.
- **Unresolved required reference**: Emits an `error` finding (`PRODUCTION_ASSET_BINDING_MISSING`), report becomes `valid: false`, summary status `'error'`.
- **Current canonical Phase 5 references**: All are optional (`required === false`). Phase 5 contracts were not modified.

---

## 6. PROVENANCE & DUPLICATE LOGICAL REFERENCE POLICY

The canonical fixture `scenario-pm-01` produces two asset usages sharing the same logical reference:
`asset-iva-progress-chart` (from scene `sc-02-context` screen insert title and description).

- **Deduplication**: Resolution runs ONCE per unique logical reference.
- **Provenance Preservation**: Every single usage is recorded in `binding.usages` with:
  - `sceneId`
  - `cueId`
  - `beatId`
  - `cueKind`
  - `sourceField`
  - `required`
  - `order`
- **Summary Metrics**: Clearly distinguishes:
  - `totalUsages` (total usages across all scenes)
  - `totalUniqueLogicalRefs` (distinct logical references)
  - `totalResolvedUnique` (distinct references successfully resolved)
  - `totalUnresolvedUnique` (distinct references unresolved)
  - `totalRenderUrlsResolved` (distinct references mapped to URLs)

---

## 7. RENDERER-FACING MEDIA MAP DIRECTION

When an eligible asset is resolved:
- **mediaMap key direction**:
  ```ts
  mediaMap[logicalAssetRef] = assetUrlById[assetId]
  ```
  This is `logicalAssetRef → render URL`, NOT `assetId → URL`, allowing Remotion compositions referencing logical keys to look up renderable URLs directly.
- **assetIdMap**:
  ```ts
  assetIdMap[logicalAssetRef] = assetId
  ```
- If an eligible asset resolves but `assetUrlById[assetId]` is not supplied:
  - `binding.assetId` is recorded
  - No URL is invented
  - Emits finding `PRODUCTION_ASSET_URL_MISSING` (`warning` if optional, `error` if required)

---

## 8. CANONICAL FIXTURE EVIDENCE (`scenario-pm-01`)

From `tests/production-asset-resolution.test.ts`:
- **Total Asset Usages**: 2 (both `asset-iva-progress-chart` in `sc-02-context`)
- **Total Unique Logical Refs**: 1 (`asset-iva-progress-chart`)
- **Total Resolved Unique**: 1 (`asset-progress-chart-real`)
- **Total Unresolved Unique**: 0
- **Total Render URLs Resolved**: 1
- **Report Valid**: `true`
- **Summary Status**: `'ok'`
- **Error Count**: 0
- **Warning Count**: 0
- **mediaMap mapping**:
  `mediaMap["asset-iva-progress-chart"] = "http://127.0.0.1:3000/media/asset/asset-progress-chart-real"`
- **assetIdMap mapping**:
  `assetIdMap["asset-iva-progress-chart"] = "asset-progress-chart-real"`

---

## 9. TEST COVERAGE

All 13 minimum required negative tests are implemented and passing in `tests/production-asset-resolution.test.ts`:

1. `unresolved optional ref → warning, report remains valid`
2. `unresolved required ref → error`
3. `explicit binding to nonexistent asset → error (PRODUCTION_ASSET_LIBRARY_ENTRY_MISSING)`
4. `explicit binding to archived asset → error (PRODUCTION_ASSET_INACTIVE)`
5. `explicit binding to blocked asset → error (PRODUCTION_ASSET_BLOCKED)`
6. `empty source → error (PRODUCTION_ASSET_PROVENANCE_INVALID)`
7. `empty license → error (PRODUCTION_ASSET_PROVENANCE_INVALID)`
8. `ambiguous alias tags → error (PRODUCTION_ASSET_BINDING_AMBIGUOUS)`
9. `resolved asset without render URL → warning if optional, error if required`
10. `malformed logical asset reference → error (PRODUCTION_ASSET_REFERENCE_INVALID)`
11. `duplicate usages remain grouped without duplicate resolution`
12. `no input mutation (verified against deep-frozen inputs)`
13. `deterministic repeat output (byte-equivalent across 10 runs)`

Additional tests verify priority overriding, alias disambiguation via explicit bindings, zero-asset plans, duplicate asset IDs, and helper utilities.

---

## 10. VALIDATION METRICS

| Check | Command | Result |
|---|---|---|
| Focused Tests | `npx vitest run tests/production-asset-resolution.test.ts` | 28/28 passed |
| AV Sync Regression | `npx vitest run tests/audiovisual-sync.test.ts` | 28/28 passed |
| Phase 5E Closure Regression | `npx vitest run tests/phase5-closure.test.ts` | 19/19 passed |
| Full Test Suite | `npm test` | 636/636 passed (37 files) |
| Test Count Guard | `node scripts/assert-test-count.mjs` | Passed (636 >= 300 floor) |
| Core Typecheck | `npm run typecheck` | Passed (zero errors) |
| Core Build | `npm run build:core` | Passed (zero errors) |
| Git Diff Check | `git diff --check` | Clean (zero whitespace/EOF issues) |

---

## 11. FILES CHANGED

New files:
- `packages/core/src/scenario/production-asset-types.ts`
- `packages/core/src/scenario/production-asset-resolution.ts`
- `tests/production-asset-resolution.test.ts`
- `PHASE6A_CORE_ASSET_RESOLUTION_HANDOFF.md`

Modified files:
- `packages/core/src/scenario/index.ts` (re-exports new production asset types and resolver)

Untouched (strict ownership compliance):
- `packages/video/**` (zero modifications — reserved for Track B)
- `apps/api/**` (zero modifications)
- Existing Phase 5 pipeline contracts and handoffs (zero modifications)

---

## 12. KNOWN LIMITATIONS & PARALLEL TRACK B INTEGRATION

- **Zero I/O**: The core resolver performs no network calls and no filesystem operations. The API runtime is responsible for providing `assetUrlById` (e.g. mapping `/media/asset/:id`).
- **Renderer Consumption**: Track B will wire `mediaMap` into the Remotion composition rendering pipeline in `packages/video/**`.
- **Safe to Integrate**: Yes. All tests pass, contracts are backwards compatible, and no overlapping files were modified.
