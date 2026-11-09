/**
 * Production Storyboard (Workstream D)
 *
 * Adapts the EXISTING storyboard concept to the NEW production authority:
 * tabs Long/SHORT 1..3 (only generated targets), production scene inspector
 * (title/on-screen info, dialogue turns, casting, shot/framing/focus/camera/
 * transition, asset binding, lock), dialogue editing with evidence safety.
 *
 * Timing is AUDIO authority: the legacy duration slider is intentionally
 * absent — durations shown come from generated/reconciled production state.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, assetUrl } from '../lib/api';
import { Field, Tag, useData } from '../components/ui';
import { VoiceAudioPanel } from '../components/VoiceAudioPanel';

type Tab = 'long' | 'short_1' | 'short_2' | 'short_3';
type ProdState = any;

const STATUS_LABEL: Record<string, string> = {
  not_generated: 'Not generated',
  generating: 'Generating…',
  generated: 'Generated',
  edited: 'Edited',
  needs_regeneration: 'Needs regeneration',
  ready_for_preview: 'Ready for preview',
  ready_for_export: 'Ready for export',
  blocked: 'Blocked',
};

function statusTagClass(status: string): string {
  if (status === 'blocked' || status === 'needs_regeneration') return 'warn';
  if (status === 'ready_for_export' || status === 'ready_for_preview') return 'ok';
  return 'accent';
}

export const ProductionStoryboardPage: React.FC<{ projectId: string; onNext: () => void; onAssets: () => void; toast: (t: string, k?: any) => void }> = ({
  projectId,
  onNext,
  onAssets,
  toast,
}) => {
  const { variants } = useData();
  const [p, setP] = useState<any>(null);
  const [prod, setProd] = useState<ProdState | null>(null);
  const [scenarios, setScenarios] = useState<Record<string, any>>({});
  /** Complete generated Scenario objects per target (scenes, characters, turns, production directions). */
  const [fullScenarios, setFullScenarios] = useState<Record<string, any>>({});
  const [tab, setTab] = useState<Tab>('long');
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [assets, setAssets] = useState<any[]>([]);
  const [assetRule, setAssetRule] = useState<{ rule: string | null; ineligible: Array<{ id: string; name: string; kind: string; reason: string }> }>({
    rule: null,
    ineligible: [],
  });
  const [turnEdit, setTurnEdit] = useState<string | null>(null);
  const [turnDraft, setTurnDraft] = useState('');

  const load = useCallback(async () => {
    const r = await api.project(projectId);
    setP(r.project);
    const pr = await api.production(projectId);
    setProd(pr.production);
    setScenarios(pr.scenarios ?? {});
    setFullScenarios(pr.fullScenarios ?? {});
  }, [projectId]);

  useEffect(() => {
    void load();
    api
      .productionBindingAssets(projectId)
      .then((r) => {
        setAssets(r.assets ?? []);
        setAssetRule({ rule: r.eligibleRule ?? null, ineligible: r.ineligible ?? [] });
      })
      .catch(() => {});
  }, [load]);

  const status = prod?.status ?? 'not_generated';
  const targets: Tab[] = (prod?.targets ?? []) as Tab[];
  const activeTab: Tab | null = targets.includes(tab) ? tab : (targets[0] ?? null);
  // Prefer the complete generated Scenario; fall back to the summary shape.
  const scenario = activeTab ? (fullScenarios[activeTab] ?? scenarios[activeTab] ?? null) : null;

  const bindingsFor = (t: string) => (prod?.assetBindings ?? []).filter((b: any) => b.target === t);

  /**
   * Logical media slots the operator can bind for the active target.
   *
   * Source 1 — the generated Scenario's own `screenInsert.assetRef` values, so a
   *            freshly generated slot is discoverable BEFORE any binding exists.
   * Source 2 — persisted bindings, so older/custom bindings are never hidden.
   *
   * Union, then deduplicated deterministically (sorted) so the list is stable
   * across renders and reloads.
   */
  const refSummaries = useMemo(() => {
    const refs = new Set<string>();
    const generated = fullScenarios[activeTab ?? ''];
    for (const scene of generated?.scenes ?? []) {
      const ref = scene?.production?.screenInsert?.assetRef;
      if (typeof ref === 'string' && ref.trim()) refs.add(ref);
    }
    for (const b of bindingsFor(activeTab ?? '')) refs.add(b.logicalRef);
    return Array.from(refs).sort();
  }, [fullScenarios, prod, activeTab]);

  /** A generated slot the operator has not bound yet. */
  const isUnboundGeneratedRef = (ref: string) =>
    !bindingsFor(activeTab ?? '').some((b: any) => b.logicalRef === ref);

  if (!p || !prod) return <div className="card">Loading production state…</div>;

  const regenerate = async () => {
    setBusy(true);
    try {
      const r = await api.productionGenerate(projectId);
      setProd(r.production);
      await load();
      toast('Production scenarios generated from the project input.', 'ok');
    } catch (e: any) {
      toast(e.payload?.error ?? e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const patchScene = async (sceneId: string, patch: any) => {
    try {
      const r = await api.productionPatchScene(projectId, activeTab!, sceneId, patch);
      setProd(r.production);
      await load();
    } catch (e: any) {
      toast(e.payload?.error ?? e.message, 'bad');
    }
  };

  const rerollScene = async (sceneId: string) => {
    try {
      const r = await api.productionRerollScene(projectId, activeTab!, sceneId);
      setProd(r.production);
      await load();
      const changed = (r.direction?.changed ?? []) as string[];
      toast(changed.length ? `Scene treatment re-rolled: ${changed.join(', ')}.` : 'Scene already at the only valid treatment.', 'ok');
    } catch (e: any) {
      toast(e.payload?.error ?? e.message, 'bad');
    }
  };

  const patchTurn = async (turnId: string, patch: any) => {
    try {
      const r = await api.productionPatchTurn(projectId, activeTab!, turnId, patch);
      setProd(r.production);
      await load();
      toast('Dialogue updated. Audio will regenerate on the next preview/export.', 'ok');
    } catch (e: any) {
      toast(e.payload?.error ?? e.message, 'bad');
    }
  };

  const setBinding = async (logicalRef: string, assetId: string) => {
    try {
      if (!assetId) {
        const r = await api.productionClearBinding(projectId, activeTab!, logicalRef);
        setProd(r.production);
      } else {
        const r = await api.productionSetBinding(projectId, activeTab!, logicalRef, assetId);
        setProd(r.production);
        toast('Asset bound. It will be used in the final mediaMap.', 'ok');
      }
      await load();
    } catch (e: any) {
      toast(e.payload?.error ?? e.message, 'bad');
    }
  };

  const scene = scenario?.scenes?.find((s: any) => s.id === sel) ?? null;

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>
              {p.meta.input.videoId} — {p.meta.input.topic}
            </h2>
            <p className="sub" style={{ margin: 0 }}>
              Production mode · audio authority: Kokoro (local TTS) · targets: {targets.length ? targets.join(', ') : 'none yet'}
            </p>
          </div>
          <div className="row">
            <span className={`tag ${statusTagClass(status)}`}>{STATUS_LABEL[status] ?? status}</span>
            <button className="btn" onClick={onAssets}>
              Asset library
            </button>
            <button className="btn" disabled={busy} onClick={regenerate}>
              {busy ? 'Generating…' : prod.exists ? 'Regenerate scenarios' : 'Generate production scenarios'}
            </button>
            <button className="btn primary" disabled={!prod.exists} onClick={onNext}>
              Captions &amp; assets →
            </button>
          </div>
        </div>
      </div>

      {prod.stale ? (
        <div className="banner warn">
          <b>Project input changed after generation.</b> Regenerate the production scenarios before building preview or export — stale
          scenarios are never exported against new input.
        </div>
      ) : null}

      {status === 'blocked' ? (
        <div className="banner bad">
          <b>Generation failed.</b>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {(prod.generationFindings ?? []).filter((f: any) => f.severity === 'error').map((f: any, i: number) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!prod.exists ? (
        <div className="card">
          <h3>Production state</h3>
          <div className="banner info">
            No production scenarios yet. “Generate production scenarios” builds the Long (when requested) and up to three Shorts from
            your project input with the production content engine — no fixtures, no legacy storyboard.
          </div>
        </div>
      ) : (
        <div className="sb-layout">
          <div>
            <div className="card">
              <div className="preview-tabs">
                {targets.map((t) => (
                  <button key={t} className={`step ${activeTab === t ? 'active' : ''}`} onClick={() => { setTab(t); setSel(null); }}>
                    {t === 'long' ? `Long 16:9 (${scenarios[t]?.sceneCount ?? 0} scenes)` : `${t.replace('_', ' ').toUpperCase()} 9:16 (${scenarios[t]?.sceneCount ?? 0} scenes)`}
                  </button>
                ))}
              </div>

              {(scenario?.scenes ?? []).map((s: any) => (
                <div key={s.id} className={`scene ${s.id === sel ? 'sel' : ''} ${prod.locks?.[s.id] ? 'locked' : ''}`} onClick={() => setSel(s.id === sel ? null : s.id)}>
                  <div className="num">
                    {String(s.index + 1).padStart(2, '0')}
                    <div style={{ fontSize: 10, color: 'var(--dim)' }}>{s.narrativePurpose}</div>
                  </div>
                  <div>
                    <div className="headline">{s.onScreenInfo?.title ?? s.title}</div>
                    <div className="narration">{s.turns.map((t: any) => `${s.characters && false ? '' : ''}${t.spokenText}`).join(' ')}</div>
                    <div className="meta">
                      <Tag kind="accent">{s.production.shotType}</Tag>
                      <Tag>{s.production.framing}</Tag>
                      <Tag>{s.production.cameraMovement}</Tag>
                      <Tag>focus: {s.production.speakerFocus}</Tag>
                      <Tag>via {s.production.transitionIntent?.type ?? 'cut'}</Tag>
                      {prod.locks?.[s.id] ? <Tag kind="warn">locked</Tag> : null}
                    </div>
                  </div>
                  <div className="right">
                    <div className="dur">{Number(s.estimatedDuration ?? 0).toFixed(0)}s est</div>
                    <div className="small" style={{ marginTop: 4 }}>audio is timing authority</div>
                  </div>
                </div>
              ))}
              {!scenario?.scenes?.length ? <div className="banner info">This target has no scenes.</div> : null}
            </div>

            <div className="card">
              <h3>Asset bindings ({activeTab})</h3>
              <p className="sub">
                Explicit logicalRef → Asset Library bindings. They reach the final Phase 6A mediaMap.
              </p>
              <div className="banner info">
                Generated media slots are <b>screen-insert images</b>. Only active image assets with real source and license are offered here.
                Video B-roll, audio, fonts and documents are not supported in generated slots yet and are deliberately not listed — this product
                does not claim B-roll support.
              </div>
              {!refSummaries.length ? (
                <div className="banner info">No logical media slots for this target yet. Generate the production scenarios first — generated source-record slots appear here automatically.</div>
              ) : null}
              {refSummaries.map((ref) => {
                const binding = bindingsFor(activeTab!).find((b: any) => b.logicalRef === ref);
                return (
                  <div key={ref} className="row" style={{ padding: '6px 0' }}>
                    <div className="mono small" style={{ flex: 1 }}>
                      {ref}
                      {isUnboundGeneratedRef(ref) ? <span className="sub"> — not bound</span> : null}
                    </div>
                    <select value={binding?.assetId ?? ''} onChange={(e) => setBinding(ref, e.target.value)} style={{ minWidth: 200 }}>
                      <option value="">— not bound —</option>
                      {assets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.kind})
                        </option>
                      ))}
                    </select>
                    {binding?.assetId ? <img src={assetUrl(binding.assetId)} alt="" style={{ height: 24, borderRadius: 3 }} /> : null}
                  </div>
                );
              })}
              {assetRule.ineligible.length ? (
                <details style={{ marginTop: 8 }}>
                  <summary className="small">
                    {assetRule.ineligible.length} asset(s) not offered for generated slots — click for the real reason
                  </summary>
                  <ul className="small">
                    {assetRule.ineligible.map((a) => (
                      <li key={a.id}>
                        <span className="mono">{a.name}</span> ({a.kind}) — {a.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          </div>

          <div>
            {scene ? (
              <div className="card">
                <h2>
                  Scene {scene.index + 1} — {scene.narrativePurpose}
                </h2>
                <p className="sub">{scene.title}</p>

                <Field label="On-screen info title">
                  <input
                    value={scene.onScreenInfo?.title ?? ''}
                    onChange={(e) => patchScene(scene.id, { onScreenInfo: { ...scene.onScreenInfo, title: e.target.value } })}
                  />
                </Field>

                <div className="grid2">
                  <Field label="Shot type">
                    <select value={scene.production.shotType} onChange={(e) => patchScene(scene.id, { production: { ...scene.production, shotType: e.target.value } })}>
                      {['two_shot', 'medium', 'close_up', 'wide', 'over_the_shoulder'].map((v) => (
                        <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Framing">
                    <select value={scene.production.framing} onChange={(e) => patchScene(scene.id, { production: { ...scene.production, framing: e.target.value } })}>
                      {['center', 'rule_of_thirds_left', 'rule_of_thirds_right', 'symmetric'].map((v) => (
                        <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Speaker focus">
                    <select value={scene.production.speakerFocus} onChange={(e) => patchScene(scene.id, { production: { ...scene.production, speakerFocus: e.target.value } })}>
                      {['speaking_character', 'document', 'group', 'reaction'].map((v) => (
                        <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Camera movement">
                    <select value={scene.production.cameraMovement} onChange={(e) => patchScene(scene.id, { production: { ...scene.production, cameraMovement: e.target.value } })}>
                      {['slow_push', 'pan_right', 'static', 'pan_left', 'subtle_drift', 'slow_pull'].map((v) => (
                        <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Transition">
                    <select
                      value={scene.production.transitionIntent?.type ?? 'cut'}
                      onChange={(e) => patchScene(scene.id, { production: { ...scene.production, transitionIntent: { ...(scene.production.transitionIntent ?? { durationSeconds: 0 }), type: e.target.value } } })}
                    >
                      {['cut', 'dissolve', 'fade_black', 'wipe'].map((v) => (
                        <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Duration">
                    <div className="hint" style={{ paddingTop: 6 }}>
                      Audio authority — durations come from generated production audio and cannot be edited here.
                    </div>
                  </Field>
                </div>

                <h3 className="mt">Dialogue turns</h3>
                {(scene.turns ?? []).map((t: any) => {
                  const speaker = (scenario.characters ?? []).find((c: any) => c.id === t.speakerId);
                  return (
                    <div key={t.id} className="scene" style={{ gridTemplateColumns: '1fr' }}>
                      <div className="meta">
                        <Tag kind="accent">{speaker?.name ?? t.speakerId}</Tag>
                        <Tag>{speaker?.role ?? ''}</Tag>
                        {t.delivery ? <Tag>{t.delivery}</Tag> : null}
                      </div>
                      {turnEdit === t.id ? (
                        <div className="row" style={{ marginTop: 6 }}>
                          <textarea style={{ flex: 1, minHeight: 60 }} value={turnDraft} onChange={(e) => setTurnDraft(e.target.value)} />
                          <button className="btn sm primary" onClick={() => { patchTurn(t.id, { spokenText: turnDraft }); setTurnEdit(null); }}>
                            Save
                          </button>
                          <button className="btn sm ghost" onClick={() => setTurnEdit(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="narration" style={{ marginTop: 6 }}>{t.spokenText}</div>
                          <div className="row" style={{ marginTop: 6 }}>
                            <button className="btn sm" onClick={() => { setTurnEdit(t.id); setTurnDraft(t.spokenText); }}>
                              Edit dialogue
                            </button>
                            {t.evidenceId ? <span className="small">evidence-linked: numeric edits are validated against the source record</span> : null}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}

                <h3 className="mt">Cast</h3>
                {(scenario.characters ?? []).map((c: any) => (
                  <div key={c.id} className="row small" style={{ padding: '3px 0' }}>
                    <Tag kind="accent">{c.name}</Tag>
                    <span>{c.role} · {c.narrativeFunction}</span>
                  </div>
                ))}

                <div className="row mt">
                  <button className={`btn ${prod.locks?.[scene.id] ? 'primary' : ''}`} onClick={() => patchScene(scene.id, { locked: !prod.locks?.[scene.id] })}>
                    {prod.locks?.[scene.id] ? 'Unlock scene' : 'Lock scene'}
                  </button>
                  <button
                    className="btn"
                    disabled={!!prod.locks?.[scene.id]}
                    title={
                      prod.locks?.[scene.id]
                        ? 'Unlock the scene before re-rolling it.'
                        : 'Deterministically cycles this scene\u2019s visual treatment (shot, framing, camera). Dialogue, evidence and audio timing are untouched.'
                    }
                    onClick={() => rerollScene(scene.id)}
                  >
                    Re-roll scene treatment
                  </button>
                </div>
              </div>
            ) : (
              <div className="card">
                <h3>Scene inspector</h3>
                <div className="banner info">Select any scene to edit its production values or dialogue. Timing comes from the audio.</div>
              </div>
            )}
          </div>
        </div>
      )}
      {void variants}
      {/* VS3: "Voice & Audio" lives with the production workflow — this is where
          cloned voice references are approved and previews are generated. */}
      <VoiceAudioPanel projectId={projectId} toast={toast} />
    </>
  );
};
