# Owner bounded review — process RTL and direction retention, 4 November2026

Order03 G5, existing procedural process only. The builder ignored RTL placement and put the first supplied step on the left. It now mirrors only landscape positions when direction is RTL; step IDs, supplied order, labels, actions and their timing stay identical. Portrait and default/LTR placement stay unchanged.

A second real UI-code defect was confirmed: Apply values rebuilt every graphic with default LTR. The values form now passes the saved direction to each existing numeric/kinetic/process builder. New DOM regression failed before the fix and passes after; it presses the actual Apply values control and checks RTL positions and direction.

Evidence: new builder regression failed first; affected graphic-form/core/render identity75/75 after. DOM editor panel9/9, work web typecheck and core/web builds; approved core/web builds. Actual isolated HTTP save/reopen exact, duration/audio/captions preserved; real Remotion3seconds90frames1920x1080/no audio. Early/late inspected frames show supplied Arabic sequence راجع then صحح then احفظ reading from the right, marker travel right to left. Private FACTORY_PROCESS_RTL_QA plus process-rtl-*.log. DOM is labelled separately from HTTP/real renderer, not a browser-quality approval of the whole family.

Working commits3b75bed andc26d81b; approved cherry-picksccfd79d/c9b729f onto70bf927, excluding pending Order02. Final remote/F SHA and rollback/build equality recorded separately. No new runtime/dependency/provider or changes to owner media/data/output/WAV/timing.

FullOrder03/G5/G6/G7 and episodes remain open. Next bounded path: inspect editing of existing actor graphics without inventing a new engine or claiming actor authoring is complete. Large absent authoring/engine work stays open until a real authorized execution path exists.
