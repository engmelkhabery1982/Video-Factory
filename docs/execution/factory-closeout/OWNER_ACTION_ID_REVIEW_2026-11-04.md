# Owner bounded review — timed action identity, 4 November 2026

Scope: Order03 G5, existing action editor only. Before the fix, removing action-2 from action-1/2/3 and adding twice produced duplicate action-3, React duplicate keys and a canonical validation obstacle. The editor now chooses the first unused action-N without renumbering or changing surviving action values/times.

Evidence: new DOM regression failed before repair (3 unique IDs for 4 actions) and passes after; editor panel8/8, related content-plan and canonical transaction HTTP15/15. The first combined run's extra no-alert assertion was too broad: newly added default actions can legitimately overlap until the owner edits their timing. It was narrowed to duplicate-ID diagnostics; overlap validation remains active. Work web typecheck, core and web builds passed; approved core/web builds passed.

Real isolated HTTP: a synthetic three-second portrait graphic with survivor action-1/action-3 and replacement action-2 saved and reopened exactly, preserving clip duration, audio and captions. Actual Remotion preview produced90frames1080x1920, no audio. Inspected early/late frames show the edited opacity timing and readable Arabic. Private local evidence: FACTORY_ACTION_ID_QA/editor.json, result.json, probe.json, early.png, late.png and kinetic-proof.mp4. No provider calls. This HTTP setup is not a real-browser interaction test; DOM interaction is separately labelled. Existing renderer sources are unchanged from the approved baseline.

Working code e4bb89d; isolated approved cherry-pick3f649eb from7081394, excluding unrelated pending Order02 changes. Final installed and remote SHAs are recorded only after verification in factory-action-id-installed-proof.json. No owner data/output/WAV/assets/timing touched.

Not whole G5/Order03 acceptance, no actor-authoring implementation or cinematic/series/audio quality acceptance. Next independent defect: preserve deliberately empty actions when applying changed graphic values; current mergeActions falls back to default movement. Large actor authoring remains open under Order03 and requires a real Arena execution path rather than retrying the failed dispatch unchanged.
