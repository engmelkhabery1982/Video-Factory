# Owner integration review — 16 October 2026

Owner baseline: eea1392013db5dbaac7458b221683bbe8253b1f9.
Fetched GitHub session branch: f44f9ffc5344ebe38a8ff6e6bc12b425951a9750, independently verified as FETCH_HEAD.
Merged into the owner review checkout without textual conflicts. No GitHub push.

## Defects found and corrected locally

1. Actual browser reproduction: a silent storyboard containing blank narration was discarded by planning in favour of attached pictures. After deleting/reordering/duplicating panels, intake showed the saved panels while treatments and eventual Apply could use removed panels. `draft-plan.ts` now treats an explicit silent storyboard as authoritative for panel ids, order, pictures, locks and times even without a text source. A real-route regression verifies the selected source-unit ids, asset order, and the applied editor's sourceAssetId values.
2. The conflict integration test used a synchronous throwing double for `shotList`, although the real page performs that local read on mount. It now forwards that read through the real client and route, preserving refusal of generation calls. No assertion was relaxed.

## Verification

- Core build; core/web typecheck; API typecheck; web build: successful.
- Final affected run: 8 files, 103 passed, 1 skipped, exit 0. Files: factory-storyboard-edit-http, factory-input-matrix-integrated, both storyboard-conflict suites, factory-intake, factory-intake-http, factory-reference-candidates, local-image-freshness.
- Earlier upload MIME/batch, batch UI, picture-notes, storyboard-cards and factory-model tests passed. Initial broad run had sandbox-related server failures; outside-sandbox rerun isolated the genuine test-double issue above. Neither the initial failure nor its skipped tests is claimed as success.
- The one skipped render gate remains skipped; existing zero-audio portrait render evidence was not repeated because this patch does not alter rendering.

## Actual browser / real HTTP, isolated synthetic data

Server: loopback 3033. Data/output under this review checkout's `data/review-f44` and `output/review-f44`, not the owner's F data.

- Three synthetic PNGs uploaded in order through the real page and measured route. Two became panels; blue image attached as style reference and did not become a panel. The batch showed all three stored with hashes.
- Draft `dft_61737a51668b25cb`: duplicate, move, remove, save and reload worked. This exposed defect 1 before repair.
- Two browser tabs produced a genuine stale save (revision 1 against 2). Typed `Retained owner browser edit` stayed visible. Explicit Reload merged `Second writer saved words`; Save and page reload showed both at revision 3.
- After repaired core/server restart, cleared both narration fields and duplicated the first panel. Revision 5 showed matching intake and treatment order `p01 → p04 → p03`.
- Apply opened `Factory_c736d3a9e352`, editor revision 1: exactly three visual clips (`vc_p01`, `vc_p04`, `vc_p03`), 12 seconds, no audio/captions. Blue reference was not a visual clip. Browser assembly preview visually inspected; this is not a server render or an artistic-quality acceptance.
- Separate real local SAM synthesis through HTTP succeeded: draft `dft_8a17718de80a9f30`, project `Factory_cfafad012dfd`, speechGenerated 1, measured_synthesis. Input was a synthetic English sentence. No Google call. The earlier sandbox matrix failure came from the engine's documented cwd output restriction; success here does not prove arbitrary external data roots or natural/Arabic speech.

Evidence: `output/review-f44/evidence/browser-conflict.txt`, `browser-editor-three-clips.png`, `local-speech.json`. These are private ignored test artifacts, not committed media.

## Remaining capability gaps

Automatic image understanding and reference-conditioned generation remain unavailable. Attaching a style picture is not conditioning. PDF import remains unavailable. No new model, dependency, provider call, full-length render or independent transcription was requested by these checks. All-video-style completion is not claimed.

Owner hardware read: AMD Radeon(TM) Graphics, AdapterRAM reported 536870912 bytes (WMI value is not proof of dedicated VRAM), driver 31.0.12044.37003; RAM 16539365376 bytes. Existing configured local still path: `F:\VideoFactory_Models\LocalGeneration\runtime\sd-cpu\sd-cli.exe`; SD 1.5 fp16 base `F:\VideoFactory_Models\LocalGeneration\models\v1-5-pruned-emaonly-fp16.safetensors`. Runtime capabilities for reference conditioning have not been probed.

Before owner update, F was clean at eea1392; WAV, project JSON and voice-audio state hashes matched prior protected values. The update must remain fast-forward only and preserve these files.
