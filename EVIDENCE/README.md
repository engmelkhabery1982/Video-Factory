# Evidence

Generated for commit `51ee4ff` — a checkpoint taken **before** any render.

| File | What it is |
|---|---|
| `validation-summary.txt` | doctor / tests / typecheck / build / smoke results, with the two honest gaps called out |
| `tests.txt` | raw `npm test` output — 53 passed |
| `build.txt` | raw `npm run build` output |
| `doctor.txt` | raw `npm run doctor` output, ANSI stripped |
| `ui-projects.png` | project list + anti-repetition log, captured from the running app |
| `ui-storyboard.png` | storyboard view, captured from the running app |

**No render evidence is present, on purpose.**

The demo render was stopped at `long (final): 40%` of Video_01 by a sandbox
reset before any MP4 was written, and `output/` was subsequently removed. There
are therefore deliberately **no** `ffprobe.txt`, no `qc/` reports, no
`similarity.txt`, no `deliverables.tsv` and no `frames/` here, because there
are no exported files to describe. Inventing them would be worse than their
absence.

Regenerate the full set with:

```bash
npm run demo      # render and export all three projects
npm run verify    # ffprobe every exported file
npm run evidence  # writes ffprobe, QC, similarity, frames, manifest into EVIDENCE/
```
