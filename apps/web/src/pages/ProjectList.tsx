import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

export const ProjectList: React.FC<{ onOpen: (id: string) => void; onNew: () => void }> = ({ onOpen, onNew }) => {
  const [data, setData] = useState<any>(null);

  const load = async () => {
    try {
      setData(await api.projects());
    } finally {
      }
  };
  useEffect(() => {
    void load();
  }, []);

  const projects = data?.projects ?? [];
  const history = data?.history?.videos ?? [];

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
                <th>Scenes</th>
                <th>Shorts</th>
                <th>Similarity</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.map((p: any) => (
                <tr key={p.videoId} className="clickable" onClick={() => onOpen(p.videoId)}>
                  <td className="mono">{p.videoId}</td>
                  <td>{p.topic}</td>
                  <td>
                    <span className={`tag ${p.status === 'exported' ? 'ok' : p.status === 'storyboarded' ? 'warn' : ''}`}>{p.status}</span>
                  </td>
                  <td>{p.scenes}</td>
                  <td>{p.shorts}</td>
                  <td>
                    {p.similarity == null ? (
                      <span className="small">—</span>
                    ) : (
                      <span className={`tag ${p.similarity > 65 ? 'bad' : 'ok'}`}>{p.similarity}%</span>
                    )}
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
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Anti-repetition log (visual_history.json)</h3>
        <p className="sub">
          Records the hook, scene order, backgrounds, transitions, text positions, accents, scene durations, CTA animation and caption
          style of every finished video. New videos are scored against the last five.
        </p>
        {!history.length ? (
          <div className="banner info">History is empty. The first storyboard you generate becomes the baseline.</div>
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
              {history.map((h: any) => (
                <tr key={h.videoId}>
                  <td className="mono">{h.videoId}</td>
                  <td>{h.hookVariant}</td>
                  <td>{h.ctaAnimation}</td>
                  <td>{h.captionStyle}</td>
                  <td className="small">{h.sceneOrder.join(' → ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
};
