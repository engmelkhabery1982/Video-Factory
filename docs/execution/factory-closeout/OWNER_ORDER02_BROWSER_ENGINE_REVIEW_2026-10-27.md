# Owner review — Windows browser probe and real kept-audio preview,27October2026

Base23db3c0. Existing approved/F release remains eb0eac8; new UI and add-policy render acceptance still pending.
Reproduced installed Chrome failing the old --version stdout probe, causing the real API to refuse preview501. A separate-profile headless blank-page launch succeeded in2.5seconds with actual HTML and exit0. Windows GUI launchers need not emit usable stdout for --version.
The shared resolver now proves Windows headless operation using a newly created temporary profile and about:blank, with15second timeout, hidden window and normal browser security. Only its own validated temp path is cleaned; no personal profile or installed browser modified. Linux/macOS retain the version probe. Edge's standard x86 install path is also included. Invalid override/ELF refusal stays unchanged.
Existing resolver regressions plus x86 Edge fallback:7/7 pass. git diff --check exit0.

Real app HTTP evidence on synthetic input: upload a3second testsrc MP4 with440Hz audio, canonical factory original-policy draft/apply, GET editor, POST preview0–2s, real Remotion Chrome render and ffmpeg mux. Job prv_bcd83c567389aee9 ready:1920x1080,30fps,2.022s,video/audio present, no separate narration or audio clips. Independently decoded1second of exported audio:8000samples,RMS0.0883188,estimated440Hz. This proves kept source audio actually survives the browser render, not just a document flag or injected raw-video fixture.

No model/provider calls, downloads, owner media or publication. QA profile/server closed. No claim of full factory completion. Remaining checks: new intake UI in real browser; add-policy source+narration mix and offsets end-to-end; final affected checks and approved/F safe integration before scheduling dispatch.
