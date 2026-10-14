# Owner integration — 14 October 2026

Integration base: owner-local `de545d0fe69e9d3047c0e052323c74488cffdddb` and upstream `2370c1fbab824f00b4843d9214bd770134749dbf`.
Religious identity isolation, the original narration/timings, Google speech REST fixes, extended voice catalog, pan overscan and explicit screen-recording logo are retained. Google is speech only. Images and semantic planning are local.

## Integration corrections
- Local planner configuration is exposed in the status route. The actual planning UI previously required a Google key, enabled Google generation, and unused Google text quota. It now gates on the local planner and explicit input confirmation only. Missing planner status fails closed.
- Speech evidence is bound to the key and speech model, independently of the obsolete Google text model. This prevents valid speech evidence disappearing after the planning migration.
- Tests retain extended-voice metadata coverage and use the corrected Interactions speech transport. The local image fixture uses Node explicitly under Vitest on Windows; this hook cannot run in ordinary production.
- Setup stops before downloads on preflight failure, hides the helper window, checks the installed planner executable against the verified archive, rechecks model identity before launch, and stops its own helper on failed startup. Reports distinguish setup from actual generation.
- Large downloads use measured-size byte ranges and the complete pinned SHA-256; runtime archives also require pinned size/hash. No changed model or provider is substituted.
- The normal batch launcher loads installed local settings and starts an existing local planner when necessary. It never downloads at application startup. Supplied-media editing remains available without model setup.

## Checks actually performed
- 11 affected suites: 168/168 passed (labelled fixtures/doubles).
- Five sync/alignment/caption suites plus asset-binding suite: 86/86 passed across successful runs. Binding test required migration to the corrected speech transport.
- Core build, API and web typecheck, and web build passed. Script parsing: zero errors.
- Real Windows preflight passed without changing F. A forced-low-space preflight test exited 1 and created no download directory.
- Downloaded image runtime help confirms seed, steps and CFG flags. This is real binary evidence, not a fake runner.

## Live state at this integration checkpoint
The two CPU runtime archives and SD 1.5 FP16 weights were downloaded and matched their pins. Planner model download is in progress. No Google request, model-image generation, semantic-plan quality check, final render or owner listening acceptance is claimed here. Subsequent evidence must record exact outcomes separately.

The final local source SHA and owner-host acceptance results are recorded in the project checkpoint only after verification. Nothing is pushed or published by this integration.
