# Owner review of local reference integration — 16 October 2026

Reviewed incoming session commit: 33c515a84d76242e301993a4121e85c0eeb01081, fetched from GitHub. Owner starting point: 262f364b7d314b73f76760aa7cab2e06c174ec75. Ancestry retained the reviewed owner fixes; review checkout advanced fast-forward, not a replacement checkout.

## Decisions resolved during source review

- Accept exclusion of attached style/character references from automatic shot fallbacks. This enforces the existing explicit role contract; a reference is not automatically footage.
- Accept restored Gemini verification binding to credential and model identities; changed model configuration must not silently inherit a readiness record. The updated fixture model names match the configured default without weakening assertions.
- Preserve 640x384/384x640 output and --vae-tiling. No new package dependency or model was installed.
- Model licence metadata in the manifest is not a completed review of all upstream licence terms. No model download or licence acceptance was performed. Runtime/quality gates remain open.

## Owner defects corrected before acceptance

1. Reviews and candidate freshness previously compared the library's recorded image hash, not always the current file bytes. Changing a reference file without changing index.json could retain an old manual review and an old candidate. Current reference hashes now come from the actual eligible file; source/licence changes invalidate manual review and candidate identity. Missing/blocked/inactive references cannot remain current. Tests mutate actual bytes with an unchanged library record and check refusal/staleness; a separate test changes the licence without a review save and checks conditioning refusal.
2. Vision timeout relied on fetch honoring abort, and a late answer could overwrite timeout. Timeout now records a terminal result at the deadline; late results are discarded. Cancellation stays cancelled beyond the deadline even when transport ignores abort. Loopback health and image requests refuse redirects, preventing redirection of image requests outside the selected local endpoint.

## Checks and evidence levels

- Incoming focused run: 10 files, 109 passed, exit 0. Includes local vision, manual/analysed review routes, visual review core, silent-storyboard Apply, real local SAM, Gemini evidence/binding/spend and picture-analysis DOM.
- Final post-fix group: 5 files, 58 passed, exit 0; API typecheck exit 0. Files: local-vision, factory-manual-reference, factory-visual-review-http, factory-reference-candidates and local-image-freshness. The additional cancellation-after-deadline regression passed.
- Core build, core/web typecheck, API typecheck and web build succeeded. No full suite or new render was run; earlier unmodified rendering evidence is not repeated.
- Real browser and real HTTP, synthetic isolated data only: draft dft_61737a51668b25cb in review data/review-f44. Wrong licence was refused while typed description stayed visible. An underspecified description was refused with its exact missing-parts message and retained text. A valid manual description saved at revision 6 without any vision runtime. Conditioning reference style-blue at strength 0.70 saved at revision 7; reload retained manual approval and settings. No generation request or provider call was made.
- Evidence (private ignored QA artifacts): output/review-33c/evidence/manual-reference-browser.txt and manual-reference-reopen.png. The screenshot is an interface proof, not an image-generation quality sample.
- Actual installed sd-cli.exe --help reported all five flags present: --vae-tiling, --clip_vision, --ip-adapter, --ip-adapter-image, --ip-adapter-strength. No model was loaded by this help check.

## What remains unproven / next task

Real vision inference, actual reference-conditioned output, Pair A/B quality and heavyweight provisioning are NOT accepted. Fixture runner arguments and UI save/reopen do not prove these capabilities. The proposed weights/projector/IP-Adapter/CLIP files remain a separately scoped provisioning decision; no automatic download is authorized.

Order 01 implementation/manual-review workflow can be integrated with the runtime gates explicitly open. Continue the independent remaining input/planning work in Order 02 after reading the canonical plan; do not let missing weights stop unrelated authorized implementation. Preserve existing owner audio, timings and protected files.
