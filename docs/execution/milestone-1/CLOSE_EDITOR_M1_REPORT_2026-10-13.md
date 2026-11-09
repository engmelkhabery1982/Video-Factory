# Milestone 1 — editor closure round: report (2026-10-13)

Base (integrated start): `86a075327d93dfe609133c3bb317051230ec6b16` (`factory/m1-integrated-handoff-2026-10-13`).
Session branch: `arena/890ccb82-video-factory`. Earlier round baseline: `59c8d29`. Source branch not modified.

## Gate status

Evidence labels: **[BROWSER]** real Chromium against the isolated built app; **[HTTP]** Fastify `inject`/real server with real ffmpeg files; **[RENDER]** real Remotion export through the server; **[CODE]** unit-level only; **[NOT RUN]** not performed.

| Gate | Status | Evidence |
|---|---|---|
| 1. Import image/video/audio from the editor | PASS (fixture) | [BROWSER] upload of a PNG, MP4 and WAV via the editor input shows measured type and duration (`Added “aud.wav” … as audio · 3.00 s`). Audio binds to an audio track (`Add to audio track`) and no longer offers a picture-slot action. [HTTP] measured type/duration, source/licence kept, unreadable file refused 422 and not stored, video declared as audio refused 422 `UPLOAD_TYPE_MISMATCH`, 70 MB body measured rather than cut off. Save/reopen: the existing save path is unchanged; **not separately re-run in the browser this round**. Error path (pending work kept, no success shown): [CODE] only. |
| 2. Browser audio assembly | PASS (fixture, browser) | [BROWSER] two clips of one source: two independent players; both play from the common playhead and stop on pause; seek resumes at the right offset; no players remain after leaving the editor. [CODE] `audioClipPosition` for trimmed clips (`sourceInSec`), per-clip windows, dB→factor. Gain: Web Audio GainNode is wired; **whether the boost is audible was not measured**. Unsupported gain is reported (`editor-audio-gain-unapplied`) when Web Audio is missing. |
| 3. Channel identity | PASS (code + UI fixture), render not re-verified | One resolver (`resolveDocumentIdentity`) for the saved revision; the server returns it in the editor envelope; the UI shows it. Blank → no identity, never BuildTrack. Religious + BuildTrack → refused. Educational BuildTrack → bound. The render receives empty `productName`/`ctaText`/`logoSrc` when unbound. **Render-level proof of the religious no-identity output was not run** (render budget used for the export acceptance). A bound BuildTrack logo is drawn only if the logo is a document asset, so the built-in SVG logo does not appear in editor renders (limitation). |
| 4. Final export from frozen revision | PASS (fixture render, landscape and portrait) | [RENDER] `POST /api/projects/:id/editor/export` freezes the saved revision and renders the whole document via the preview renderer and audio resolver. Landscape: 1920×1080, 3.022 s, audio stream present. Portrait: 1080×1920, 3.022 s. A later edit moved the document to rev 2; the export stayed at rev 1 and was reported `stale: true`. [RENDER] Source time: the export frame at 1.5 s matches the source at 2.3 s (= sourceIn 0.8 + 1.5) visually, not pixel-compared. Legacy export untouched; projects without an editor document get `409 NO_EDITOR_DOCUMENT`. |

## Behaviour changes (intentional, to be reviewed)

- `EDITOR_CHANNEL_MISMATCH` removed. The document's `channelBrandId` is authoritative; a refused identity is `EDITOR_IDENTITY_REFUSED` (409). `tests/editor-milestone1-ui.test.ts` updated accordingly.
- The UI no longer fetches `/api/projects/:id/brand` for identity display.
- Library audio assets are now measured by the server (were silently excluded when no duration existed).
- `POST /api/assets` now has its own 520 MB body limit (was global 64 MB).
- Audio rows in the editor no longer show "Assign to selected clip"; the validator still refuses audio on picture slots.

## Tests run (this round)

- `npm run build:core` exit 0; `npm run build:web` exit 0; `tsc` web exit 0; `tsc` API exit 0.
- Vitest, 13 files, **187/187 passed**: the 9 existing editor/identity suites plus 4 new `tests/m1-close-*.test.ts` suites.
- Browser proof (`.stills/scripts/m1-browser-proof.mts`, scratch, git-ignored): **14/14 PASS**.
- Export acceptance (`.stills/scripts/m1-export-acceptance.mts`, scratch): landscape and portrait, one render each, both PASS.
- Not run: full suite, owner-host checks, full-length renders, dissolve.

## Known blockers and not done

- **Owner-host acceptance (STEP 5–7 of the local steps) was not run.** The owner's own WAV, MP4 and project were not used.
- "Failed to fetch" on upload was **not reproduced** in headless Chromium with small files. The most likely cause found was the 64 MB global body limit (fixed, HTTP-tested). Owner-size footage in a real browser is **unproven**.
- The export job list is not restored after a page reload; the panel only shows the job started in this session.
- Gain above 0 dB is not verified as audible; only the wiring and the reporting path are checked.
- Edits to the channel identity are shown only after save (the panel shows the saved identity).
- Dissolve amendment A1 remains pending; dissolve remains refused (`EDITOR_CAPABILITY_UNAVAILABLE`).
- Generation, diversity, new TTS, new image/video APIs, storyboard importer: out of scope, not implemented.
