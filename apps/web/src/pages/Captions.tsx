import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Banner, Tag, useData } from '../components/ui';
import { TargetAudioPanel } from '../components/TargetAudioPanel';
import { VoiceAudioPanel } from '../components/VoiceAudioPanel';
import { ExternalNarrationPanel } from '../components/ExternalNarrationPanel';

/**
 * CAPTIONS PAGE — production-aware.
 *
 * For projects WITH production state the caption authority is the reconciled
 * PRODUCTION caption plan (`GET /api/projects/:id/production/captions/:target`),
 * derived from production audio (Kokoro) timing. The legacy storyboard captions
 * editor is deliberately NOT offered here, because editing legacy cues would
 * not change the production video:
 *
 *   - wording changes belong to the Production Storyboard (dialogue editing),
 *   - timing is owned by production audio and cannot be nudged by hand,
 *   - captions are regenerated whenever the production plan is rebuilt.
 *
 * Legacy projects (no production state) keep the previous captions editor and
 * the legacy target-audio panel unchanged.
 */
export const CaptionsPage: React.FC<{ projectId: string; onNext: () => void; onBack: () => void; toast: (t: string, k?: any) => void }> = ({
  projectId,
  onNext,
  onBack,
  toast,
}) => {
  const { variants } = useData();
  const [p, setP] = useState<any>(null);
  const [prod, setProd] = useState<any>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [target, setTarget] = useState<string>('long');
  const [captions, setCaptions] = useState<any[] | null>(null);
  const [captionError, setCaptionError] = useState<string | null>(null);
  const [assets, setAssets] = useState<any[]>([]);
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = async () => {
    const r = await api.project(projectId);
    setP(r.project);
    setAssets(r.assets);
    let production: any = null;
    try {
      const pr = await api.production(projectId);
      production = pr.production ?? null;
    } catch {
      production = null;
    }
    setProd(production);
    const generated: string[] = production?.targets ?? [];
    setTargets(generated);
    if (generated.length > 0) setTarget((cur) => (generated.includes(cur) ? cur : generated[0]));
  };
  useEffect(() => {
    void load();
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    if (!prod?.exists || !target) {
      setCaptions(null);
      return () => {
        alive = false;
      };
    }
    setCaptionError(null);
    api
      .productionCaptions(projectId, target)
      .then((r) => {
        if (alive) setCaptions(r.captions ?? []);
      })
      .catch((e: any) => {
        if (alive) {
          setCaptions(null);
          setCaptionError(e?.message ?? 'production captions unavailable');
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, target, prod?.exists]);

  if (!p) return <div className="card">Loading…</div>;

  /* ───────────────────── production mode ───────────────────── */
  if (prod?.exists) {
    /* Stale input: readiness and product-kit records describe the replaced content. */
    const staleProd = prod.status === 'needs_regeneration' || prod.stale === true;
    return (
      <>
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2>Production captions</h2>
              <p className="sub" style={{ margin: 0 }}>
                Reconciled from production audio — the timing authority is the Kokoro dialogue track, not this page.
              </p>
            </div>
            <div className="row">
              <button className="btn" onClick={onBack}>
                ← Storyboard
              </button>
              <button className="btn primary" onClick={onNext}>
                QC &amp; export →
              </button>
            </div>
          </div>
        </div>

        <Banner kind="info">
          To change the spoken wording, edit the dialogue on the <b>Production Storyboard</b> — production captions are regenerated from
          production audio. Manual timing edits are intentionally not offered here because they would drift away from the audio.
        </Banner>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>Generated targets</h3>
            <div className="row">
              {targets.map((t) => (
                <button key={t} className={`btn sm ${t === target ? 'primary' : ''}`} onClick={() => setTarget(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <p className="sub">
            {captions ? `${captions.length} reconciled cue(s) for ${target}` : 'loading production captions…'} · status:{' '}
            {String(prod.status).replace(/_/g, ' ')}
            {!staleProd && prod.lastReadiness ? ` · readiness: ${prod.lastReadiness.status}` : ''}
          </p>

          {captionError ? <div className="banner bad">Production captions could not be built: {captionError}</div> : null}

          {captions && captions.length === 0 ? (
            <div className="banner info">No reconciled caption cues for this target yet. Run a preview to build the production plan.</div>
          ) : null}

          {(captions ?? []).map((c: any) => (
            <div key={c.cueId} className="scene" style={{ gridTemplateColumns: '1fr 150px' }}>
              <div>
                <div className="headline" style={{ fontSize: 13, fontWeight: 500 }}>
                  {c.text}
                </div>
                <div className="meta">
                  <span className="mono small">
                    {Number(c.start).toFixed(2)} → {Number(c.end).toFixed(2)}s
                  </span>
                  {c.sceneId ? <Tag>{c.sceneId}</Tag> : null}
                  {c.speakerId ? <Tag kind="accent">{c.speakerId}</Tag> : null}
                  {c.voiceSlot ? <Tag>{c.voiceSlot}</Tag> : null}
                </div>
              </div>
              <div className="right">
                <span className="small">audio authority</span>
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>Where these captions come from</h3>
          <ul className="small">
            <li>
              <b>Target</b>: {target}
            </li>
            <li>
              <b>Timing</b>: production audio (Kokoro per-turn WAVs) → reconciled caption plan. Never hand-nudged.
            </li>
            <li>
              <b>Wording</b>: generated Scenario dialogue, editable on the Production Storyboard.
            </li>
            <li>
              <b>Legacy editor removed for this project</b>: storyboard caption edits do not change the production video, so they are not
              offered here.
            </li>
          </ul>
          {!staleProd && prod.productKitPath ? (
            <p className="small">
              Production deliverables (publishing kit, provenance, readiness): <span className="mono">{prod.productKitPath}</span>
            </p>
          ) : staleProd ? (
            <p className="small">
              The ProjectInput changed: previous readiness and product-kit results are no longer current. Regenerate in the Storyboard.
            </p>
          ) : null}
        </div>
      </>
    );
  }

  /* ───────────────────── legacy mode (unchanged) ───────────────────── */
  const cues = p.storyboard.captions;

  const save = async (id: string, text: string) => {
    const r = await api.patchCue(projectId, id, { text });
    setP(r.project);
    setEdit(null);
    toast('Caption updated.', 'ok');
  };

  const nudge = async (id: string, delta: number) => {
    const c = cues.find((x: any) => x.id === id);
    if (!c) return;
    const start = Math.max(0, Number((c.start + delta).toFixed(2)));
    const end = Number((c.end + delta).toFixed(2));
    const r = await api.patchCue(projectId, id, { start, end });
    setP(r.project);
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>Captions, glossary and assets</h2>
            <p className="sub" style={{ margin: 0 }}>
              Legacy project · {cues.length} cues · correction is local and free — no paid transcription service is used.
            </p>
          </div>
          <div className="row">
            <button className="btn" onClick={onBack}>
              ← Storyboard
            </button>
            <button className="btn primary" onClick={onNext}>
              QC &amp; export →
            </button>
          </div>
        </div>
      </div>
      <TargetAudioPanel projectId={projectId} toast={toast} onAudioChange={load} />
      <VoiceAudioPanel projectId={projectId} toast={toast} />
      <ExternalNarrationPanel projectId={projectId} toast={toast} onAudioChange={load} />

      <div className="grid2">
        <div className="card">
          <h3>Caption cues</h3>
          <p className="sub">Click a cue to correct the words, or nudge its timing. Timing moves the linked scene with it.</p>
          {cues.map((c: any) => (
            <div key={c.id} className={`scene ${edit === c.id ? 'sel' : ''}`} style={{ gridTemplateColumns: '1fr 140px' }}>
              <div>
                {edit === c.id ? (
                  <div className="row">
                    <input style={{ flex: 1 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <button className="btn sm primary" onClick={() => save(c.id, draft)}>
                      Save
                    </button>
                    <button className="btn sm ghost" onClick={() => setEdit(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="headline" style={{ fontSize: 13, fontWeight: 500 }}>
                      {c.text}
                    </div>
                    <div className="meta">
                      <span className="mono small">
                        {c.start.toFixed(2)} → {c.end.toFixed(2)}s
                      </span>
                      {c.sceneId ? <Tag>{c.sceneId}</Tag> : null}
                      {c.terms?.map((t: string) => (
                        <Tag kind="accent" key={t}>
                          {t}
                        </Tag>
                      ))}
                      {c.userEdited ? <Tag>edited</Tag> : null}
                    </div>
                  </>
                )}
              </div>
              <div className="right">
                {edit !== c.id ? (
                  <>
                    <button className="btn sm" onClick={() => { setEdit(c.id); setDraft(c.text); }}>
                      Edit
                    </button>
                    <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                      <button className="btn sm ghost" onClick={() => nudge(c.id, -0.1)}>
                        −0.1
                      </button>
                      <button className="btn sm ghost" onClick={() => nudge(c.id, 0.1)}>
                        +0.1
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div>
          <div className="card">
            <h3>Construction glossary</h3>
            <p className="sub">These terms are corrected automatically in every generated caption and highlighted on screen.</p>
            <table>
              <thead>
                <tr>
                  <th>Term</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {(variants?.glossary ?? []).map((g: any) => (
                  <tr key={g.canonical}>
                    <td className="mono">{g.canonical}</td>
                    <td className="small">{g.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Project assets</h3>
            <p className="sub">Upload new material or manage what is already here.</p>
            <div className="field">
              <label>Add asset</label>
              <input
                type="file"
                multiple
                onChange={async (e) => {
                  for (const f of Array.from(e.target.files ?? [])) {
                    const fd = new FormData();
                    fd.append('file', f);
                    fd.append('source', 'Project upload');
                    fd.append('license', 'Operator owned');
                    const r = await api.uploadAsset(fd);
                    setAssets(r.assets);
                  }
                  toast('Assets uploaded.', 'ok');
                }}
              />
            </div>
            {assets.length === 0 ? <div className="banner info">No assets yet.</div> : null}
            {assets.map((a) => (
              <div key={a.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid #14263c' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                  <div className="small">
                    {a.kind} · {a.license} · {a.usedIn?.length ? `used in ${a.usedIn.length} scene(s)` : 'not used yet'}
                  </div>
                </div>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const r = await api.patchAsset(a.id, { preferred: !a.preferred });
                    setAssets(r.assets);
                  }}
                >
                  {a.preferred ? '★ preferred' : '☆ prefer'}
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const r = await api.patchAsset(a.id, { status: a.status === 'archived' ? 'active' : 'archived' });
                    setAssets(r.assets);
                  }}
                >
                  {a.status === 'archived' ? 'Unarchive' : 'Archive'}
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const r = await api.patchAsset(a.id, { blocked: !a.blocked });
                    setAssets(r.assets);
                  }}
                >
                  {a.blocked ? 'Unblock' : 'Block'}
                </button>
              </div>
            ))}
            <Banner kind="info">
              Stock footage is never downloaded automatically. Anything added here is owned or licensed by you and recorded in the
              provenance file.
            </Banner>
          </div>
        </div>
      </div>
    </>
  );
};
