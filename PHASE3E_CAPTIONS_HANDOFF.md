# BuildTrack Video Factory — Phase 3E Scenario Captions Planner Handoff

## 1. Verified Source Gate & Branch Details

- **Remote Repository**: `https://github.com/engmelkhabery1982/Video-Factory`
- **Source Remote Branch**: `origin/arena/01a0ed0c-video-factory`
- **Verified Starting SHA**: `33d2c22a0227cce55f1e690f8ac3fa8e3b8130d2`
  - *Commit Message*: `Phase 3D.1: multi-speaker video renderer integration with Phase 3B visual beats and Phase 3C audio timeline`
- **Dedicated Local Working Branch**: `Video-Factory-Scenario-Captions`
- **Baseline Test Suite**: 269 passed (269).
- **Working Tree State at Start**: Clean.

---

## 2. File Ownership & Changes

In strict accordance with Phase 3E boundaries, **no existing files were modified**.
Only the five permitted files were created:

1. `packages/core/src/scenario/scenario-caption-types.ts`
   - Canonical `ScenarioCaptionPlan`, `ScenarioCaptionCue`, `ScenarioCaptionSpeaker`, `ScenarioCaptionScene`, `CaptionFormatProfile`, `ScenarioCaptionOptions`, `ScenarioCaptionFinding`, `ScenarioCaptionValidationReport`, and `CompileScenarioCaptionsResult`.
   - Renderer-neutral format profiles for Long (16:9), Short (9:16), and reusable.
2. `packages/core/src/scenario/compile-scenario-captions.ts`
   - Pure, deterministic compiler function `compileScenarioCaptions(scenario, audioPlan, options?)`.
   - Word-for-word text preservation without invented speaker name prefixes.
   - Word-weighted timing strictly within the speech interval `[clip.startTimeSeconds, clip.endTimeSeconds]`.
   - Zero encroachment into `pauseAfterSeconds`.
   - Balanced phrase chunking preventing 1-word orphan fragments.
3. `packages/core/src/scenario/validate-scenario-captions.ts`
   - Deterministic validator function `validateScenarioCaptionPlan(plan, sourceScenario, audioPlan)`.
   - Enforces whole-turn text reconstruction, cue sequence order, speaker and voice-slot consistency, monotonic non-overlapping timing, pause interval protection, and foreign clip rejections.
4. `tests/scenario-captions.test.ts`
   - 27 comprehensive unit tests covering all required test cases.
5. `PHASE3E_CAPTIONS_HANDOFF.md`
   - This handoff document.

### Specifically Prohibited Files Kept Untouched
- `packages/core/src/index.ts` (UNTOUCHED)
- `packages/core/src/scenario/index.ts` (UNTOUCHED)
- `scripts/assert-test-count.mjs` (UNTOUCHED)
- `package.json` & `package-lock.json` (UNTOUCHED)
- Existing tests & fixtures (UNTOUCHED)
- Phase 3A, 3B, 3C, or 3D files (UNTOUCHED)
- API routes, server files, captions.ts, semantics.ts (UNTOUCHED)
- Remotion renderer files (UNTOUCHED)

---

## 3. Discovery & Quota Limits

- **Existing source files read**: 3 files (`captions.ts`, `semantics.ts`, `dialogue-audio-types.ts`), well below the 12-file ceiling.
- **Repository search commands used**: 0 (used context manifest directly).
- **Prohibited features**: No Planning mode, Boost, Teamwork, subagents, MCP, browser agents, web browsing, video rendering, audio synthesis, demo generation, or FFmpeg runs were used.

---

## 4. Verification Suite Results

| Test / Check | Command | Result |
| :--- | :--- | :--- |
| **Baseline Test Suite** | `npm test` | **269 passed (269)** across 12 test files |
| **New Phase 3E Tests** | `npx vitest run tests/scenario-captions.test.ts` | **27 passed (27)** |
| **Full Vitest Suite** | `npm test` | **296 passed (296)** across 13 test files |
| **Strict Typecheck** | `npm run typecheck` | **Passed** (0 errors in core and web) |
| **Production Build** | `npm run build` | **Passed** (`build:core` and `build:web` succeeded) |
| **Environment Doctor** | `npm run doctor` | **Passed** (`Environment looks ready`) |
| **Test-Count Floor Guard** | `node scripts/assert-test-count.mjs` | **Passed** (296 $\ge$ 240 floor) |
| **Git Diff Check** | `git diff --check` | **Passed** (0 formatting/whitespace errors) |

---

## 5. Caption Splitting and Timing Implementation

1. **Text Splitting Strategy**:
   - Spoken dialogue is parsed into sentences via punctuation boundaries (`[.!?\u061F]`).
   - If a sentence exceeds the character budget for the profile (Long: 80 chars, Short/reusable: 54 chars), it is split at clause delimiters (commas, semicolons, dashes) or balanced word boundaries.
   - Protected tokens (percentages like `58%`, decimals like `28.5 MPa`, clauses like `Clause 12.2`, currency amounts like `185000 GBP`) are kept intact without internal fragmentation.
   - Single-word sentences inside multi-sentence turns are merged with neighboring sentences to prevent one-word orphan cues; standalone single-word turns (e.g. "Agreed.") remain valid single cues.
2. **Timing Strategy**:
   - Timing is allocated strictly within the audio clip's spoken speech interval: `[clip.startTimeSeconds, clip.startTimeSeconds + clip.durationSeconds]`.
   - Each cue's duration is calculated proportionally to its word count relative to the turn's total words, using integer-millisecond precision (`Math.round(ms) / 1000`).
   - Cue 0 starts at `clip.startTimeSeconds`. The final cue ends at `clip.endTimeSeconds`.
   - The trailing pause interval (`[clip.endTimeSeconds, clip.endTimeSeconds + clip.pauseAfterSeconds]`) is strictly preserved as silence/breathing and contains zero caption cues.
3. **Text Reconstruction**:
   - `plan.cues.filter(c => c.turnId === turn.id).map(c => c.text).join(' ')` reconstructs `turn.spokenText.trim().replace(/\s+/g, ' ')` with byte-for-byte exactness.

---

## 6. Recovery Artifacts & Application Instructions

Push capability was tested via dry-run (`git push --dry-run origin Video-Factory-Scenario-Captions`), which returned authentication limitation (`fatal: could not read Username for 'https://github.com': No such device or address`). In accordance with Section 2, the local commit was preserved and recovery artifacts were generated in the workspace root.

1. **`Video-Factory-Phase3E.bundle`**:
   Self-contained Git bundle containing complete history through the final Phase 3E commit.
2. **`Video-Factory-Phase3E.patch`**:
   Standard unified Git patch generated from `33d2c22a0227cce55f1e690f8ac3fa8e3b8130d2..HEAD`.
3. **`Video-Factory-Phase3E-changed-files.zip`**:
   Zip archive containing only the 5 newly created files preserving repository paths.

### Independent Verification of Bundle
```bash
git bundle verify Video-Factory-Phase3E.bundle
git clone Video-Factory-Phase3E.bundle /tmp/verify-phase3e
cd /tmp/verify-phase3e
git log -n 1 --format="%H %s"
npx vitest run tests/scenario-captions.test.ts
```

### Applying via Git Patch
```bash
# On branch Video-Factory-Scenario-Captions at 33d2c22a0227cce55f1e690f8ac3fa8e3b8130d2:
git apply --check Video-Factory-Phase3E.patch
git am < Video-Factory-Phase3E.patch
```

### Applying via Git Bundle
```bash
git fetch /path/to/Video-Factory-Phase3E.bundle Video-Factory-Scenario-Captions:Video-Factory-Scenario-Captions
git checkout Video-Factory-Scenario-Captions
```
