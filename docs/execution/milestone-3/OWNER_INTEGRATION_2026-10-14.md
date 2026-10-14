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

## Actual owner-machine execution — 14 October 2026

Both runtime archives and both models are installed at F:\VideoFactory_Models\LocalGeneration and match their pinned sizes and SHA-256. The normal launcher loads the local settings and the existing vf-align configuration. No Google call was made in this integration. The earlier Google usage ledger was not reset.

- Actual Qwen local planning succeeded after one repair: three structurally valid treatments, each covering every supplied script line. Early real attempts exposed ignored JSON schema nesting and incomplete line coverage; these are now corrected. This establishes one English planning flow, not approval of every language or creative result.
- Actual stable-diffusion.cpp CPU generation succeeded: 384x640 PNG, seed 1729, 20 steps, VAE tiling; SHA-256 72a530a0b3bc79ea8da7986ce86c7d74ed7576d470998be7ea75be43cabef99b. It took about 349 seconds. The initial 360-pixel width was rounded by the engine and correctly refused, so native requests now use the 64-pixel grid. The successful picture includes a person despite a no-people instruction: it is technical evidence, not a creatively approved still.
- The still was registered and bound to one isolated religious draft. A real 4.6s portrait preview rendered at 1080x1920 with one existing owner-approved Arabic voice and no channel identity or logo. No new voice synthesis was requested.
- A real 17.9s landscape educational preview and final export used the existing Excel recording, existing voice and original BuildTrack mark. Four source windows, linked Arabic translations and five timed measured highlights were saved in the canonical editor document. Frames at 5.8, 6.4, 8.1, 10.8 and 12.6 seconds were inspected; highlights follow the demonstrated fields. The excerpt contains no product-mention sentence, and none was invented.
- The actual browser opened the project, showed saved clips/cues, selected Arabic only, sought to 6.4s and completed final export from the UI. A visual defect shifted uncropped media half off the assembly preview; top-left crop coordinates now match the render mapping.
- The latest runner executed on a byte-identical isolated copy of the owner's 58.84s narration. All 16 boundaries were returned, with cue 2 at 6.022s. The independent CTC transcript disagreed on 12 words, so acceptance was correctly blocked. No proposal was accepted and the original approved times were not replaced. A CTC transcript can contain recognition errors; this verdict does not prove the owner recording is wrong.
- One supplied library narration now resolves securely for alignment without adding an overlapping import track. Its existing hash is rechecked and its worker state is a private snapshot. Multiple library tracks are refused as an ambiguous spoken source. Actual execution on the approved 4.6s sample returned a matching independent transcript and a reviewable proposal. The audio track stayed byte-for-byte equivalent before and after. Non-24k mono PCM16 inputs remain refused by the existing alignment runner.
- Translation cues are excluded from spoken alignment units and snapshot ordering. They retain the source cue's boundaries instead of being treated as additional spoken text.

## Focused verification after the execution fixes

- Final planner/image/provider/UI set: 5 files, 121 passed.
- Final caption/alignment/library-audio set: 3 files, 48 passed, including changed-byte refusal and ambiguous-track refusal.
- The earlier planner repair/caption-alignment set passed 53 tests before the library alignment addition. Earlier merge checks remain listed above; repeated runs are not separate acceptance evidence.
- Core build, API and web typecheck and web build passed. Final script parser checks and owner checkout build are recorded at installation.
- A restricted test invocation could not resolve linked F dependencies (EPERM). The same focused suites were rerun with the approved filesystem access and passed; this was not hidden as an application pass.

## Scope and remaining acceptance

The installed CPU image model is modest and slow on this computer. Generated plans, pictures, captions and optional speech still need content/listening review before publication. This integration does not establish Arabic planning quality across arbitrary briefs, all voices, every input combination, or long-form visual quality. There is no local generative video engine; supplied video recordings are supported. Dissolve remains refused. One library narration can align; ambiguous multi-track or incompatible-format input must not be guessed.

The original F project, its WAV and voice state must retain their pre-integration hashes. New examples are QA_ONLY artifacts, not a republished product. Nothing is pushed to GitHub or published in this integration. Exact final source SHA, F installation evidence and artifact paths are saved in the local strategy checkpoint after verification.

Saved editor projects now advertise editor targets in the list and reopen directly in the canonical editor. The legacy storyboard is no longer presented as an empty replacement for a saved factory timeline.
