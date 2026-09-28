import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Field, useToast } from '../components/ui';

const blank = {
  videoId: 'Video_',
  videoType: 'long' as 'long' | 'short',
  topic: '',
  targetAudience: '',
  mainProblem: '',
  viewerPromise: '',
  hook: '',
  script: '',
  keyNumbers: '',
  keyPoints: '',
  productName: 'BuildTrack',
  cta: '',
  outputLanguage: 'en',
  brandPreset: 'buildtrack',
  shortCount: 3,
  sourceReferences: '',
};

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export const NewProject: React.FC<{ onCreated: (id: string) => void; onCancel: () => void }> = ({ onCreated, onCancel }) => {
  const toast = useToast();
  const [f, setF] = useState({ ...blank });
  const [assets, setAssets] = useState<any[]>([]);
  const [shots, setShots] = useState<string[]>([]);
  const [broll, setBroll] = useState<string[]>([]);
  const [voice, setVoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.assets().then((r) => setAssets(r.assets)).catch(() => {});
  }, []);

  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }));

  const attach = async (file: File, kind: 'broll' | 'screenshot' | 'voice') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind === 'voice' ? 'broll' : kind);
    fd.append('name', file.name);
    fd.append('source', 'Project input');
    fd.append('license', 'Operator owned');
    const r = await api.uploadAsset(fd);
    const a = r.asset;
    setAssets(r.assets);
    if (kind === 'voice') setVoice(a.path);
    else if (kind === 'broll') setBroll((s) => [...s, a.path]);
    else setShots((s) => [...s, a.path]);
  };

  const submit = async () => {
    if (!f.videoId.trim() || !f.topic.trim() || !f.script.trim()) {
      toast('Video ID, topic and script are required.', 'bad');
      return;
    }
    setBusy(true);
    try {
      const input = {
        ...f,
        shortCount: Number(f.shortCount),
        keyNumbers: csv(f.keyNumbers),
        keyPoints: lines(f.keyPoints),
        sourceReferences: lines(f.sourceReferences),
        productShots: shots,
        brollFiles: broll,
        voiceoverFile: voice,
      };
      await api.createProject(input);
      const sb = await api.storyboard(f.videoId.trim());
      const p = sb.project;
      if (p.storyboard.warnings?.length) {
        toast(`Storyboard created with ${p.storyboard.warnings.length} warning(s).`, 'info');
      } else {
        toast(`Storyboard created: ${p.storyboard.long.scenes.length} scenes, ${p.storyboard.shorts.length} shorts.`, 'ok');
      }
      onCreated(f.videoId.trim());
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>New video project</h2>
        <p className="sub">Fill in what you know. Everything is editable later on the storyboard screen.</p>

        <div className="grid2">
          <Field label="Video ID" hint="Folder name for this project, e.g. Video_04">
            <input value={f.videoId} onChange={(e) => set('videoId', e.target.value)} />
          </Field>
          <Field label="Video type">
            <select value={f.videoType} onChange={(e) => set('videoType', e.target.value)}>
              <option value="long">Long (16:9) — up to 3 shorts are produced from the same topic</option>
              <option value="short">Short only (9:16)</option>
            </select>
          </Field>
        </div>

        <Field label="Topic">
          <input value={f.topic} onChange={(e) => set('topic', e.target.value)} placeholder="Executed 70% vs Accepted 59.5%" />
        </Field>

        <div className="grid2">
          <Field label="Target audience">
            <input value={f.targetAudience} onChange={(e) => set('targetAudience', e.target.value)} />
          </Field>
          <Field label="Main problem">
            <input value={f.mainProblem} onChange={(e) => set('mainProblem', e.target.value)} />
          </Field>
        </div>

        <Field label="Viewer promise" hint="Shown in the first promise beat, within the first 15 seconds.">
          <input value={f.viewerPromise} onChange={(e) => set('viewerPromise', e.target.value)} />
        </Field>

        <Field label="Hook" hint="The opening line. If empty, the generator picks the strongest line from the script.">
          <input value={f.hook} onChange={(e) => set('hook', e.target.value)} />
        </Field>

        <Field label="Full script" hint="One idea per paragraph works best — blank lines separate beats. Paste, or import from a .txt file.">
          <textarea value={f.script} onChange={(e) => set('script', e.target.value)} placeholder={'Paste or write the narration here…'} />
        </Field>
        <div className="row mb">
          <label className="btn sm">
            Import .txt
            <input
              type="file"
              accept=".txt,.md"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) set('script', await file.text());
              }}
            />
          </label>
          <span className="small">{f.script.length} characters · ~{Math.max(1, Math.round(f.script.split(/\s+/).filter(Boolean).length / 155 * 60))}s at 155 wpm</span>
        </div>

        <div className="grid2">
          <Field label="Key numbers" hint="Comma separated, e.g. 70%, 59.5%, 10.5%">
            <input value={f.keyNumbers} onChange={(e) => set('keyNumbers', e.target.value)} />
          </Field>
          <Field label="Output language">
            <input value={f.outputLanguage} onChange={(e) => set('outputLanguage', e.target.value)} />
          </Field>
        </div>

        <Field label="Key points" hint="One per line. These drive the checklist, summary and Short copy.">
          <textarea style={{ minHeight: 110 }} value={f.keyPoints} onChange={(e) => set('keyPoints', e.target.value)} />
        </Field>

        <div className="grid2">
          <Field label="Product name">
            <input value={f.productName} onChange={(e) => set('productName', e.target.value)} />
          </Field>
          <Field label="Brand preset">
            <input value={f.brandPreset} onChange={(e) => set('brandPreset', e.target.value)} />
          </Field>
        </div>

        <Field label="Call to action" hint="Used once, at the end. 6-8 seconds in the long video, one shot in each Short.">
          <input value={f.cta} onChange={(e) => set('cta', e.target.value)} />
        </Field>

        <div className="grid2">
          <Field label="Voiceover file" hint="MP3 or WAV. Optional — captions are generated from the script and timed to the audio.">
            <input type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && attach(e.target.files[0], 'voice')} />
            {voice ? <div className="hint" style={{ color: 'var(--good)' }}>attached: {voice.split('/').pop()}</div> : null}
          </Field>
          <Field label="How many Shorts">
            <select value={f.shortCount} onChange={(e) => set('shortCount', e.target.value)}>
              <option value={0}>0</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </Field>
        </div>

        <div className="grid2">
          <Field label="Product screenshots / demo" hint={`${shots.length} attached`}>
            <input type="file" accept="image/*,video/*" multiple onChange={(e) => Array.from(e.target.files ?? []).forEach((f) => attach(f, 'screenshot'))} />
          </Field>
          <Field label="Optional B-roll" hint={`${broll.length} attached`}>
            <input type="file" accept="image/*,video/*" multiple onChange={(e) => Array.from(e.target.files ?? []).forEach((f) => attach(f, 'broll'))} />
          </Field>
        </div>

        <Field label="Source references" hint="One per line. These are written into the provenance file.">
          <textarea style={{ minHeight: 80 }} value={f.sourceReferences} onChange={(e) => set('sourceReferences', e.target.value)} />
        </Field>

        <div className="row">
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create project & generate storyboard'}
          </button>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <span className="small">Library has {assets.length} asset(s) available.</span>
        </div>
      </div>
    </>
  );
};
