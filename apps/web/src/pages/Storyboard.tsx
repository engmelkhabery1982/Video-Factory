import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, videoUrl } from '../lib/api';
import { Field, Tag, useData } from '../components/ui';

type Tab = 'long' | 'short_1' | 'short_2' | 'short_3';

export const StoryboardPage: React.FC<{ projectId: string; onNext: () => void; onAssets: () => void; toast: (t: string, k?: any) => void }> = ({
  projectId,
  onNext,
  onAssets,
  toast,
}) => {
  const { variants } = useData();
  const [p, setP] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('long');
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [artifacts, setArtifacts] = useState<any[]>([]);

  const load = useCallback(async () => {
    const r = await api.project(projectId);
    setP(r.project);
    setArtifacts(r.project.artifacts ?? []);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const scenes: any[] = useMemo(() => {
    if (!p) return [];
    if (tab === 'long') return p.storyboard.long.scenes;
    return p.storyboard.shorts.find((s: any) => s.id === tab)?.scenes ?? [];
  }, [p, tab]);

  const scene = scenes.find((s) => s.id === sel) ?? null;
  const sim = p?.storyboard?.similarity;

  const regenerate = async () => {
    setBusy(true);
    try {
      const r = await api.regenerate(projectId);
      setP(r.project);
      toast('Storyboard regenerated. Locked and edited scenes were kept.', 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (sceneId: string, body: any) => {
    const r = await api.patchScene(projectId, sceneId, body);
    setP(r.project);
  };

  const roll = async (sceneId: string) => {
    try {
      const r = await api.regenerateScene(projectId, sceneId);
      setP(r.project);
      toast('Scene re-rolled to the strongest unused variant.', 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  if (!p) return <div className="card">Loading project…</div>;
  const st = p.storyboard;

  const preview = artifacts.find((a) => a.target === (tab === 'long' ? 'long' : tab) && a.kind === 'preview') ?? artifacts.find((a) => a.kind === 'preview');

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>
              {p.meta.input.videoId} — {p.meta.input.topic}
            </h2>
            <p className="sub" style={{ margin: 0 }}>
              Long: {st.long.scenes.length} scenes · {st.long.totalDuration.toFixed(1)}s · Shorts: {st.shorts.length} · Captions:{' '}
              {st.captions.length}
            </p>
          </div>
          <div className="row">
            <button className="btn" onClick={onAssets}>
              Asset library
            </button>
            <button className="btn" disabled={busy} onClick={regenerate}>
              {busy ? 'Regenerating…' : 'Regenerate storyboard'}
            </button>
            <button className="btn primary" onClick={onNext}>
              Captions & assets →
            </button>
          </div>
        </div>
      </div>

      {sim ? (
        <div className={`banner ${sim.blocking ? 'bad' : sim.score > 50 ? 'warn' : 'ok'}`}>
          <b>Visual similarity {sim.score}%</b> (gate: {sim.threshold}%) against the last five videos.{' '}
          {sim.reasons.join(' · ')}
          {sim.blocking ? ' — change the highlighted scenes before exporting.' : ''}
        </div>
      ) : null}

      {st.warnings?.length ? (
        <div className="banner warn">
          <b>Storyboard warnings</b>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {st.warnings.map((w: string, i: number) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="sb-layout">
        <div>
          <div className="card">
            <div className="preview-tabs">
              <button className={`step ${tab === 'long' ? 'active' : ''}`} onClick={() => { setTab('long'); setSel(null); }}>
                Long 16:9 ({st.long.scenes.length} scenes)
              </button>
              {st.shorts.map((s: any) => (
                <button key={s.id} className={`step ${tab === s.id ? 'active' : ''}`} onClick={() => { setTab(s.id as Tab); setSel(null); }}>
                  {s.id.replace('_', ' ').toUpperCase()} 9:16 ({s.totalDuration.toFixed(0)}s)
                </button>
              ))}
            </div>

            {scenes.map((s) => (
              <div
                key={s.id}
                className={`scene ${s.id === sel ? 'sel' : ''} ${s.locked ? 'locked' : ''}`}
                onClick={() => setSel(s.id === sel ? null : s.id)}
              >
                <div className="num">
                  {String(s.index + 1).padStart(2, '0')}
                  <div style={{ fontSize: 10, color: 'var(--dim)' }}>{s.role}</div>
                </div>
                <div>
                  <div className="headline">{s.content.headline}</div>
                  <div className="narration">{s.narration}</div>
                  <div className="meta">
                    <Tag kind="accent">{s.variant}</Tag>
                    <Tag>{s.background}</Tag>
                    <Tag>via {s.transitionIn}</Tag>
                    <Tag>{s.textPosition}</Tag>
                    {s.content.stat ? <Tag kind="ok">{s.content.stat}{s.content.stat2 ? ` vs ${s.content.stat2}` : ''}</Tag> : null}
                    {s.locked ? <Tag kind="warn">locked</Tag> : null}
                    {s.userEdited ? <Tag>edited</Tag> : null}
                  </div>
                </div>
                <div className="right">
                  <div className="dur">{s.duration.toFixed(1)}s</div>
                  <div className="small mono" style={{ marginTop: 4 }}>{s.startTime.toFixed(1)}s</div>
                </div>
              </div>
            ))}
            {!scenes.length ? <div className="banner info">No scenes yet — press “Generate Storyboard”.</div> : null}
          </div>

          <div className="card">
            <h3>Preview</h3>
            {preview ? (
              <div className="preview-stage">
                <video controls src={videoUrl(projectId, preview.relPath)} />
              </div>
            ) : (
              <div className="banner info">
                No preview rendered yet. Generate a quick preview on the QC &amp; export screen to review timing before the final export.
              </div>
            )}
          </div>
        </div>

        <div>
          {scene ? (
            <div className="card">
              <h2>
                Scene {scene.index + 1} — {scene.role}
              </h2>
              <p className="sub">{scene.section}</p>

              <div className="reason">
                <b>Why this design was chosen</b>
                <br />
                {scene.reason.evidence}
                <br />
                <br />
                <b>Detected:</b> {scene.reason.detected}
                {scene.reason.alternatives?.length ? (
                  <>
                    <br />
                    <b>Alternatives:</b> {scene.reason.alternatives.join(', ')}
                  </>
                ) : null}
              </div>

              <div className="mt">
                <Field label="On-screen headline">
                  <input value={scene.content.headline} onChange={(e) => patch(scene.id, { content: { ...scene.content, headline: e.target.value } })} />
                </Field>
                <Field label="Sub line">
                  <input
                    value={scene.content.subline ?? ''}
                    onChange={(e) => patch(scene.id, { content: { ...scene.content, subline: e.target.value } })}
                  />
                </Field>
                <Field label="Items / points" hint="One per line">
                  <textarea
                    style={{ minHeight: 80 }}
                    value={scene.content.items.join('\n')}
                    onChange={(e) => patch(scene.id, { content: { ...scene.content, items: e.target.value.split('\n').filter(Boolean) } })}
                  />
                </Field>
              </div>

              <div className="grid2">
                <Field label="Scene variant">
                  <select value={scene.variant} onChange={(e) => patch(scene.id, { variant: e.target.value })}>
                    {(variants?.hooks ?? []).map((v: any) => (
                      <option key={v.id} value={v.id}>
                        HOOK: {v.label}
                      </option>
                    ))}
                    {(variants?.explanations ?? []).map((v: any) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                        {!v.shortsSafe && tab !== 'long' ? ' (not 9:16 safe)' : ''}
                      </option>
                    ))}
                    {scene.role === 'cta' ? <option value="cta_card">CTA card</option> : null}
                  </select>
                </Field>
                <Field label="Background">
                  <select value={scene.background} onChange={(e) => patch(scene.id, { background: e.target.value })}>
                    {(variants?.backgrounds ?? []).map((v: any) => (
                      <option key={v.id} value={v.id}>
                        {v.label} (max {v.maxContinuousSeconds}s)
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Transition in">
                  <select value={scene.transitionIn} onChange={(e) => patch(scene.id, { transitionIn: e.target.value })}>
                    {(variants?.transitions ?? []).map((v: any) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Text position">
                  <select value={scene.textPosition} onChange={(e) => patch(scene.id, { textPosition: e.target.value })}>
                    {(variants?.textPositions ?? []).map((v: string) => (
                      <option key={v} value={v}>
                        {v.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Duration (${scene.duration.toFixed(1)}s)`}>
                  <input
                    type="range"
                    min={1}
                    max={14}
                    step={0.1}
                    value={scene.duration}
                    onChange={(e) => patch(scene.id, { duration: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Media / asset">
                  <select
                    value={scene.assetIds[0] ?? ''}
                    onChange={(e) => patch(scene.id, { assetIds: e.target.value ? [e.target.value] : [] })}
                  >
                    <option value="">none</option>
                    <option value="">— pick an asset below —</option>
                  </select>
                  <div className="hint">Attach an asset on the Captions &amp; assets screen, then choose it here.</div>
                </Field>
              </div>

              <div className="row mt">
                <button className={`btn ${scene.locked ? 'primary' : ''}`} onClick={() => patch(scene.id, { locked: !scene.locked })}>
                  {scene.locked ? 'Unlock scene' : 'Lock scene'}
                </button>
                <button className="btn" disabled={scene.locked} onClick={() => roll(scene.id)}>
                  Re-roll this scene
                </button>
                <button className="btn ghost" onClick={() => patch(scene.id, { reset: true })}>
                  Clear edits
                </button>
              </div>
              <p className="small mt">Locked and edited scenes survive a full storyboard regeneration.</p>
            </div>
          ) : (
            <div className="card">
              <h3>Scene inspector</h3>
              <div className="banner info">Select any scene on the left to change its layout, copy, timing, or lock it.</div>
            </div>
          )}

          <div className="card">
            <h3>Per-target summary</h3>
            <div className="kv">
              <div>
                <span>Long scenes</span>
                <span>{st.long.scenes.length}</span>
              </div>
              <div>
                <span>Long duration</span>
                <span>{st.long.totalDuration.toFixed(1)}s</span>
              </div>
              <div>
                <span>Hook</span>
                <span>{st.long.scenes[0]?.variant}</span>
              </div>
              <div>
                <span>End-screen reserve</span>
                <span>{st.long.endScreenReserveSeconds}s</span>
              </div>
              {st.shorts.map((s: any) => (
                <React.Fragment key={s.id}>
                  <div>
                    <span>{s.id} hook</span>
                    <span>{s.hookVariant}</span>
                  </div>
                  <div>
                    <span>{s.id} duration</span>
                    <span>{s.totalDuration.toFixed(1)}s</span>
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
