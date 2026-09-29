import React, { useEffect, useState } from 'react';
import { api, assetUrl } from '../lib/api';

export const AssetsPage: React.FC = () => {
  const [assets, setAssets] = useState<any[]>([]);
  const [files, setFiles] = useState<any>(null);

  const load = async () => {
    const [a, f] = await Promise.all([api.assets(), api.files()]);
    setAssets(a.assets);
    setFiles(f);
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <div className="card">
        <h2>Asset library</h2>
        <p className="sub">
          Local library of logos, product screenshots, charts, icons, B-roll, documents, textures and sound effects. Every asset keeps
          its source and licence; nothing of unknown provenance is ever downloaded automatically.
        </p>
        <div className="row">
          <label className="btn primary">
            Upload assets
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={async (e) => {
                for (const f of Array.from(e.target.files ?? [])) {
                  const fd = new FormData();
                  fd.append('file', f);
                  fd.append('kind', f.type.startsWith('video') ? 'broll' : f.type.startsWith('audio') ? 'sfx' : 'screenshot');
                  fd.append('source', 'Operator upload');
                  fd.append('license', 'Operator owned');
                  await api.uploadAsset(fd);
                }
                void load();
              }}
            />
          </label>
          <button className="btn" onClick={load}>
            Refresh
          </button>
        </div>
      </div>

      <div className="card">
        <h3>{assets.length} asset(s)</h3>
        <div className="asset-grid">
          {assets.map((a) => (
            <div key={a.id} className="asset">
              <div className="thumb" style={a.mimeType.startsWith('image') ? { backgroundImage: `url(${assetUrl(a.id)})` } : undefined}>
                {!a.mimeType.startsWith('image') ? a.kind : null}
              </div>
              <div className="info">
                <div className="name">{a.name}</div>
                <div className="small" style={{ marginBottom: 6 }}>
                  {a.kind} · {a.license}
                </div>
                <div className="row">
                  <button className="btn sm" onClick={async () => setAssets((await api.patchAsset(a.id, { preferred: !a.preferred })).assets)}>
                    {a.preferred ? '★' : '☆'}
                  </button>
                  <button
                    className="btn sm"
                    onClick={async () => setAssets((await api.patchAsset(a.id, { status: a.status === 'archived' ? 'active' : 'archived' })).assets)}
                  >
                    {a.status === 'archived' ? 'Unarchive' : 'Archive'}
                  </button>
                  <button className="btn sm" onClick={async () => setAssets((await api.patchAsset(a.id, { blocked: !a.blocked })).assets)}>
                    {a.blocked ? 'Unblock' : 'Block'}
                  </button>
                </div>
                <div className="small" style={{ marginTop: 6 }}>
                  {a.usedIn?.length ? `used in ${a.usedIn.length} scene(s)` : 'not used yet'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Output tree</h3>
        <p className="sub">Everything produced by this app, on this machine.</p>
        {files ? (
          <>
            <div className="small mono mb">{files.root}</div>
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {files.files.slice(0, 300).map((f: any) => (
                  <tr key={f.rel}>
                    <td className="mono small">{f.rel}</td>
                    <td className="small">{(f.size / 1024).toFixed(0)} KB</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {files.files.length > 300 ? <div className="small mt">…and {files.files.length - 300} more</div> : null}
          </>
        ) : null}
      </div>
    </>
  );
};
