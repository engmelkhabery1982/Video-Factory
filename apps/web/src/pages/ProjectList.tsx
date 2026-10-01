import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Tag } from '../components/ui';

/**
 * PROJECT LIST — production-aware.
 *
 * For projects WITH production state the list surfaces the PRODUCTION status
 * (targets, build/artifact count, stale / needs-regeneration) instead of the
 * legacy `meta.status`. The anti-repetition section shows the REAL production
 * casting/style history (the authority for production projects); the legacy
 * `visual_history.json` log is only shown for legacy/reference projects and is
 * explicitly labelled as such.
 */
const PRODUCTION_STATUS_TONE: Record<string, '' | 'ok' | 'warn' | 'bad' | 'accent'> = {
  ready_for_export: 'ok',
  ready_for_preview: 'warn',
  generated: '',
  edited: 'warn',
  needs_regeneration: 'bad',
  blocked: 'bad',
  generating: 'warn',
};

export const ProjectList: React.FC<{ onOpen: (id: string) => void; onNew: () => void }> = ({ onOpen, onNew }) => {
  const [data, setData] = useState<any>(null);

  const load = async () => {
    try {
      setData(await api.projects());
    } finally {
      /* keep the previous list on transient failure */
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const projects = data?.projects ?? [];
  const legacyHistory = data?.history?.videos ?? [];
  const productionHistory = data?.productionHistory ?? [];
  const productionProjects = projects.filter((p: any) => p.production?.exists);
  const legacyProjects = projects.filter((p: any) => !p.production?.exists);

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>Projects</h2>
            <p className="sub" style={{ margin: 0 }}>
              Every project lives in its own folder and can be reopened, edited and re-exported at any time.
            </p>
          </div>
          <button className="btn primary" onClick={onNew}>
            + New video project
          </button>
        </div>
      </div>

      <div className="card">
        <h3>{projects.length} project(s)</h3>
        {!projects.length ? (
          <div className="banner info">No projects yet. Create one to get started.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Video ID</th>
                <th>Topic</th>
                <th>Status</th>
                <th>Targets</th>
                <th>Builds / artifacts</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.map((p: any) => {
                const production = p.production;
                return (
                  <tr key={p.videoId} className="clickable" onClick={() => onOpen(p.videoId)}>
                    <td className="mono">{p.videoId}</td>
                    <td>{p.topic}</td>
                    <td>
                      {production ? (
                        <>
                          <Tag kind={PRODUCTION_STATUS_TONE[production.status as string] ?? ''}>{String(production.status).replace(/_/g, ' ')}</Tag>
                          {production.stale ? <Tag kind="bad">stale</Tag> : null}
                          {production.readiness ? (
                            <Tag kind={production.readiness.readyForProductionDelivery ? 'ok' : production.readiness.status === 'blocked' ? 'bad' : 'warn'}>
                              QC {production.readiness.status}
                            </Tag>
                          ) : null}
                        </>
                      ) : (
                        <span className={`tag ${p.status === 'exported' ? 'ok' : p.status === 'storyboarded' ? 'warn' : ''}`}>{p.status}</span>
                      )}
                    </td>
                    <td className="small mono">{production ? (production.targets ?? []).join(', ') || '—' : `${p.scenes} scenes / ${p.shorts} shorts`}</td>
                    <td className="small">
                      {production ? `${production.buildCount} build(s) · ${production.artifactCount} artifact(s)` : `${p.artifacts} artifact(s)`}
                    </td>
                    <td className="small">{new Date(p.updatedAt).toLocaleString()}</td>
                    <td>
                      <button
                        className="btn sm danger"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (confirm(`Delete ${p.videoId}?`)) {
                            await api.deleteProject(p.videoId);
                            void load();
                          }
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {productionProjects.length + legacyProjects.length > 0 ? (
          <p className="small">
            {productionProjects.length} production project(s) · {legacyProjects.length} legacy/reference project(s) (legacy projects keep the
            original workflow until they are generated with the production engine).
          </p>
        ) : null}
      </div>

      <div className="card">
        <h3>Production anti-repetition log (production_history.json)</h3>
        <p className="sub">
          The REAL production casting/style history: complete persona keys per narrative role plus a semantic style fingerprint, written after
          every successful final production and consumed by the next generation.
        </p>
        {!productionHistory.length ? (
          <div className="banner info">
            Production history is empty. The first successful final production becomes the baseline for the next generation.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Video</th>
                <th>Recorded</th>
                <th>Challenger</th>
                <th>Technical authority</th>
                <th>Decision maker</th>
                <th>Style fingerprint</th>
              </tr>
            </thead>
            <tbody>
              {productionHistory.map((h: any, i: number) => (
                <tr key={`${h.videoId}-${i}`}>
                  <td className="mono">{h.videoId}</td>
                  <td className="small">{h.at ? new Date(h.at).toLocaleString() : '—'}</td>
                  <td className="mono small">{h.casting?.challenger ?? '—'}</td>
                  <td className="mono small">{h.casting?.technical_authority ?? '—'}</td>
                  <td className="mono small">{h.casting?.decision_maker ?? '—'}</td>
                  <td className="small" title={h.styleFingerprint}>
                    {typeof h.styleFingerprint === 'string' && h.styleFingerprint.length > 0
                      ? h.styleFingerprint.includes('"targets"')
                        ? 'per-target semantic fingerprint'
                        : 'semantic fingerprint'
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Legacy visual history (visual_history.json) — legacy/reference projects only</h3>
        <p className="sub">
          This is the ORIGINAL storyboard anti-repetition log. It is not the authority for production projects, which use the production
          casting/style history above.
        </p>
        {!legacyHistory.length ? (
          <div className="banner info">Legacy history is empty.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Video</th>
                <th>Hook</th>
                <th>CTA anim</th>
                <th>Captions</th>
                <th>Scene order</th>
              </tr>
            </thead>
            <tbody>
              {legacyHistory.map((h: any) => (
                <tr key={h.videoId}>
                  <td className="mono">{h.videoId}</td>
                  <td>{h.hookVariant}</td>
                  <td>{h.ctaAnimation}</td>
                  <td>{h.captionStyle}</td>
                  <td className="small">{(h.sceneOrder ?? []).join(' → ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
};
