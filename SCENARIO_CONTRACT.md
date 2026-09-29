# BuildTrack Video Factory — Scenario Contract (Phase 3A)

## 1. Overview & Data Model in Plain Language

Phase 3A introduces the **Scenario Engine Contract**: a typed, versioned, and strictly JSON-serializable specification for multi-character, dialogue-driven, and evidence-grounded construction and engineering scenarios.

Rather than treating video as arbitrary paragraphs split across a timer, a **Scenario** represents a realistic human workplace interaction (e.g. site inspections, commercial claim negotiations, progress dispute meetings, schedule-risk war rooms). It models:

1. **Metadata**: Schema version, project ID, title, language, intended outcome, and target format (`Long` vs `Short` vs `reusable`).
2. **Characters**: Distinct professional personas with roles (e.g. *Project Manager*, *Lead Planning Engineer*, *Contractor Commercial Representative*), narrative functions (*challenger*, *decision_maker*, *technical_authority*), communication styles, and constraints.
3. **Locations**: Structured workplace environments (`progress_meeting`, `commercial_meeting`, `planning_review`, `site_walk`).
4. **Evidence & Numeric Claims**: Concrete records, laboratory test logs, contract clauses, and schedule metrics with numerical values, units, and confidence classifications.
5. **Scenes**: Chronologically sequenced narrative beats (`hook`, `context`, `problem`, `evidence`, `disagreement`, `decision`, `solution`, `cta`).
6. **Dialogue Turns**: Spoken interactions between characters with communicative intents (`assertion`, `objection`, `clarification`, `call_to_action`), delivery tones, pause markers, and evidence citations.
7. **Production Directions**: Renderer-neutral shot framings (`wide`, `medium`, `two_shot`, `close_up`, `over_the_shoulder`), speaker focal points, camera movements (`slow_push`, `pan_left`, `static`), screen inserts, and transition intents.

---

## 2. Compact JSON Example

```json
{
  "metadata": {
    "schemaVersion": "1.0.0",
    "id": "scenario-sched-risk-03",
    "projectId": "proj-biotech-campus",
    "title": "Substation Handover - Critical Path Float Erosion",
    "language": "en-US",
    "targetFormat": "Short",
    "sourceBrief": "Mitigate critical path delay on primary 33kV substation energization.",
    "targetAudience": "Turnkey MEP managers and commissioning directors",
    "intendedOutcome": "Authorize dual-shift cable pulling to recover 18 days of eroded float.",
    "estimatedDuration": { "targetSeconds": 48 }
  },
  "characters": [
    {
      "id": "char-maya-planner",
      "name": "Maya Patel",
      "role": "Lead Planning Engineer",
      "narrativeFunction": "challenger",
      "communicationStyle": "Fast-paced, metric-dense, focused on total float erosion."
    },
    {
      "id": "char-tom-director",
      "name": "Tom Chen",
      "role": "Project Director",
      "narrativeFunction": "decision_maker",
      "communicationStyle": "Decisive executive balancing acceleration cost against delay damages."
    }
  ],
  "locations": [
    {
      "id": "loc-war-room",
      "name": "Project Planning War Room",
      "settingType": "planning_review",
      "environment": "indoor"
    }
  ],
  "evidence": [
    {
      "id": "ev-float-erosion",
      "claim": "Substation float has eroded by 18 days due to switchgear slippage.",
      "evidenceType": "schedule_metric",
      "sourceRef": "Integrated Master Schedule IMS-Rev4B",
      "numericFacts": [{ "metric": "float_erosion", "value": 18, "unit": "days" }],
      "confidence": "verified",
      "usedInSceneIds": ["sc-01-hook"],
      "usedInTurnIds": ["turn-01-maya"]
    }
  ],
  "scenes": [
    {
      "id": "sc-01-hook",
      "index": 0,
      "narrativePurpose": "hook",
      "locationId": "loc-war-room",
      "estimatedDuration": 15,
      "participantIds": ["char-maya-planner", "char-tom-director"],
      "turns": [
        {
          "id": "turn-01-maya",
          "speakerId": "char-maya-planner",
          "spokenText": "Tom, the latest schedule run shows our 33kV substation has suffered 18 days of critical path float erosion.",
          "intent": "assertion",
          "delivery": "urgent",
          "evidenceId": "ev-float-erosion"
        },
        {
          "id": "turn-02-tom",
          "speakerId": "char-tom-director",
          "spokenText": "That threatens our October cleanroom qualification. Protect your project milestones with BuildTrack today.",
          "intent": "call_to_action",
          "delivery": "authoritative"
        }
      ],
      "production": {
        "shotType": "close_up",
        "framing": "center",
        "speakerFocus": "speaking_character",
        "cameraMovement": "slow_push",
        "transitionIntent": { "type": "fade_black" }
      }
    }
  ]
}
```

---

## 3. Validation Severities & Rules

The validator (`validateScenario`) performs local, deterministic checks and reports structured findings:

### Severities
- **`error`**: Structurally or contractually invalid scenario that blocks downstream generation, preview, and rendering.
- **`warning`**: Potential quality, pacing, or diversity defect that alerts the creator while permitting workflow continuation.

### Summary of Rule Checks
| Rule ID | Category | Severity | Description |
| :--- | :--- | :--- | :--- |
| `RULE-001-SCHEMA-VERSION` | schema | error | Requires semver `1.x.x`. Rejects unsupported major versions. |
| `RULE-002-UNIQUE-IDS` | integrity | error | Enforces global uniqueness across characters, evidence, scenes, and turns. |
| `RULE-003-SPEAKER-EXISTS` | integrity | error | Every `turn.speakerId` must resolve to a valid declared character. |
| `RULE-004-EVIDENCE-REF` | evidence | error | Every `turn.evidenceId` must resolve to declared evidence. |
| `RULE-005-CHARACTERS-REQUIRED` | integrity | error | Scenario must declare $\ge 1$ character. |
| `RULE-006-SCENES-REQUIRED` | narrative | error | Scenario must declare $\ge 1$ scene with substantive dialogue or visual direction. |
| `RULE-007-NONEMPTY-DIALOGUE` | schema | error | Disallows empty or whitespace-only dialogue turns. |
| `RULE-008-FIRST-SCENE-HOOK` | narrative | error | First scene must have `narrativePurpose: 'hook'`. |
| `RULE-009-FINAL-SCENE-CTA` | narrative | error | Final scene in Long or Short scenario must provide a call-to-action (`cta`). |
| `RULE-010-SCENE-ORDER` | integrity | error | Scene indices must be strictly sequential and ascending. |
| `RULE-011-POSITIVE-DURATION` | timing | error | Scene durations must be $> 0$. |
| `RULE-012-TARGET-DURATION-MATCH` | timing | warning | Warns when calculated duration diverges $>35\%$ from target. |
| `RULE-013-NUMERIC-FACT-PRESERVED` | evidence | warning | Warns if spoken text citing evidence omits the exact numerical figure. |
| `RULE-014-FORBIDDEN-PATH-SECRET` | security | error | Rejects API keys, tokens, or absolute host file paths (`/etc/`, `C:\`). |
| `RULE-015-EXCESSIVE-MONOLOGUE` | diversity | error | Characters speaking $>2$ consecutive uninterrupted turns require `monologueReason`. |
| `RULE-016-REPEATED-SENTENCE` | diversity | error | Rejects identical substantive sentences repeated across turns. |
| `RULE-017-REPEATED-SHOT` | diversity | warning | Flags mechanical repetition of identical shot types across $>3$ scenes without justification. |
| `RULE-018-UNUSED-PARTICIPANT` | narrative | warning | Warns if character is listed as participant but never speaks or receives focus. |
| `RULE-019-SPEAKER-IN-PARTICIPANTS`| integrity | error | Turn speaker must be listed in `scene.participantIds`. |
| `RULE-020-CTA-AS-EVIDENCE` | evidence | error | Rejects marketing CTAs disguised as factual evidence. |
| `RULE-021-SHORT-DURATION-CEILING` | timing | error/warn| Short videos $>65.0$s trigger hard error; $>60.0$s trigger warning. |
| `RULE-022-LONG-DURATION-FLOOR` | timing | warning | Long videos $<30.0$s trigger warning for brevity. |

---

## 4. Duration Estimation Assumptions

Calculated offline and deterministically by `estimateScenarioDuration`:

- **Words Per Minute (WPM)**: Default 150 WPM (2.5 words per second), matching natural conversational pacing.
- **Turn Speech Duration**: `Math.max(minTurnSeconds, (wordCount / WPM) * 60)`.
- **Minimum Turn Floor**: Default 0.8 seconds (single-word utterances like *"Agreed."* or *"Understood."* require natural breathing cadence).
- **Turn Pauses**: Default 0.3s pause added after turns unless explicitly overridden by `pauseAfterSeconds`.
- **Scene Transitions**: Default 0.5s buffer added for non-cut transitions (`dissolve`, `fade_black`).
- **Non-Dialogue Beats**: Default 2.5s floor for scenes containing zero dialogue (establishing shots, document cutaways).

---

## 5. Downstream Integration Architecture

### How Phase 3B Will Generate This Contract
- Phase 3B will introduce scenario generator adapters (e.g. LLM prompts, template synthesizers).
- Generators will output raw JSON adhering to `Scenario`.
- The generator pipeline runs `validateScenario(json)` immediately; if errors or diversity failures are flagged, it deterministically repairs or regenerates prior to persisting.

### How Phase 3C Will Preview and Edit It
- Phase 3C will add web UI inspector panels for reading and editing scenarios:
  - Participant assignment matrix;
  - Script view with inline turn editing;
  - Evidence linkage explorer;
  - Live duration estimator bar showing target vs actual seconds;
  - Live diversity badge (tracking repeated shots, speaker monologue runs).

### How Phase 3D Will Integrate with Video Production
- Multi-Voice Audio Synthesis: Maps each `character.voiceSlot` to distinct TTS speaker models (or target audio tracks).
- Alignment & Target Audio: Replaces estimated turn durations with synthesized audio waveform boundaries while preserving scene indices.
- Caption Generator: Directly converts `DialogueTurn` entries into clean captions labeled by speaking character.
- Remotion Renderer: Maps renderer-neutral `ProductionDirection` (`shotType`, `speakerFocus`, `cameraMovement`, `screenInsert`) into existing Remotion visual components.

---

## 6. Deliberately Deferred Scope

In strict adherence to Phase 3A boundaries:
- **No Video Rendering**: No Remotion scene compositions or video renders are executed.
- **No Audio Generation**: No TTS API calls, WAV generation, or audio mixing are performed.
- **No Gemini / Cloud APIs**: All validation and duration math run 100% offline and locally.
- **No UI Modifications**: Existing Phase 0C / 0C.1 web panels (`TargetAudioPanel.tsx`, `Captions.tsx`) remain untouched.
