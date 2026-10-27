# Owner review — Order 02 PDF repairs (27 October 2026)
Incoming Arena base: f64d1dd76bc943f1c1c4f6b8681b7d56d9397197. Approved release remains eb0eac8; this report does not close Order02.

Reproduced Arabic CID corruption: expected سل, actual سسسل when all encoded two-byte keys were below256. The added test fails on the incoming implementation and passes with byte-width selection from the CMap's source hex/codespace. Mixed or unsupported widths, backwards ranges and malformed UTF16 destinations are refused. Restricting source width before bfrange expansion also bounds adversarial 32-bit ranges.

PDF image import now validates all JPEG signatures, end markers and positive SOF dimensions before any file mutation. Invalid/truncated pictures refuse the whole import. Image writes and index commit share rollback; paths are tracked only after exclusive creation, before any potentially partial write. Fault injection proves a failed second image removes both prior and partial files without changing the existing index. A failed index rename removes imported pictures and the temporary index. The shared index writer uses unique temp names and cleanup.

Independent evidence: parser16/16; final PDF HTTP8/8; image MIME HTTP5/5; real ffmpeg kept-audio mux5/5. API typecheck and git diff --check exit0. Core build passed before the route-only changes. Earlier focused policy/topic tests9+7 also pass. No provider/model call or download; tests use isolated synthetic media.

Not proven: browser PDF/topic/policy UI, Remotion's actual kept-audio emission, ordinary owner PDFs, owner media approval, absent local semantic model. Mux success does not prove the browser emitted source audio. No F/approved update until the remaining acceptance checks.
