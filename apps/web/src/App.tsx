import React, { useEffect, useState } from 'react';
import { api } from './lib/api';
import { ToastHost, useData, useToast } from './components/ui';
import { ProjectList } from './pages/ProjectList';
import { NewProject } from './pages/NewProject';
import { StoryboardPage } from './pages/Storyboard';
import { ProductionStoryboardPage } from './pages/ProductionStoryboard';
import { CaptionsPage } from './pages/Captions';
import { AssetsPage } from './pages/Assets';
import { ExportPage } from './pages/Export';

type Step = 'projects' | 'new' | 'storyboard' | 'captions' | 'assets' | 'export';

const STEPS: { id: Step; label: string }[] = [
  { id: 'projects', label: '1. Projects' },
  { id: 'new', label: '2. New project' },
  { id: 'storyboard', label: '3. Storyboard' },
  { id: 'captions', label: '4. Captions & assets' },
  { id: 'export', label: '5. QC & export' },
];

const Shell: React.FC<{ step: Step; setStep: (s: Step) => void; projectId: string | null; setProjectId: (id: string) => void }> = ({
  step,
  setStep,
  projectId,
  setProjectId,
}) => {
  const { ready, error } = useData();
  const toast = useToast();
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const idx = STEPS.findIndex((s) => s.id === step);
  const canOpen = (s: Step) => {
    if (s === 'projects' || s === 'new' || s === 'assets') return true;
    return !!projectId;
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="dot">▚</div>
          <div>
            Build<b>Track</b> Video Factory
            <div className="small" style={{ fontWeight: 500, fontSize: 11, marginTop: -2 }}>
              local MVP · no accounts · no subscriptions · no watermark
            </div>
          </div>
        </div>
        <nav className="steps">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              className={`step ${step === s.id ? 'active' : ''} ${i < idx ? 'done' : ''}`}
              disabled={!canOpen(s.id)}
              onClick={() => setStep(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="row">
          {health ? (
            <>
              <Tag2 ok={health.ffmpegOk}>ffmpeg</Tag2>
              <Tag2 ok={health.ffprobeOk}>ffprobe</Tag2>
              <Tag2 ok={health.chrome?.ok}>browser</Tag2>
            </>
          ) : (
            <span className="tag bad">API offline</span>
          )}
        </div>
      </header>

      <main className="content">
        {!ready ? <div className="card">Loading…</div> : null}
        {error ? <div className="card"><div className="banner bad">Could not reach the API: {error}. Is the server running?</div></div> : null}
        {ready && !error ? (
          <>
            {step === 'projects' && <ProjectList onOpen={(id) => { setProjectId(id); setStep('storyboard'); }} onNew={() => setStep('new')} />}
            {step === 'new' && <NewProject onCreated={(id) => { setProjectId(id); setStep('storyboard'); }} onCancel={() => setStep('projects')} />}
            {step === 'storyboard' && projectId && <StoryboardGate projectId={projectId} onNext={() => setStep('captions')} onAssets={() => setStep('assets')} toast={toast} />}
            {step === 'captions' && projectId && <CaptionsPage projectId={projectId} onNext={() => setStep('export')} onBack={() => setStep('storyboard')} toast={toast} />}
            {step === 'assets' && <AssetsPage />}
            {step === 'export' && projectId && <ExportPage projectId={projectId} onBack={() => setStep('captions')} toast={toast} />}
          </>
        ) : null}
      </main>
    </div>
  );
};

const Tag2: React.FC<{ ok: boolean; children: React.ReactNode }> = ({ ok, children }) => (
  <span className={`tag ${ok ? 'ok' : 'bad'}`}>{children}</span>
);

/**
 * Routes the existing Storyboard step to the production storyboard when the
 * project has production state (Workstream D), and falls back to the legacy
 * storyboard for legacy/reference projects. No shell redesign.
 */
const StoryboardGate: React.FC<{ projectId: string; onNext: () => void; onAssets: () => void; toast: (t: string, k?: any) => void }> = (props) => {
  const [mode, setMode] = useState<'loading' | 'production' | 'legacy'>('loading');
  useEffect(() => {
    let alive = true;
    api.production(props.projectId).then((r) => {
      if (alive) setMode(r.production?.exists ? 'production' : 'production'); // new engine is the default; legacy stays importable
    }).catch(() => {
      if (alive) setMode('production');
    });
    return () => {
      alive = false;
    };
  }, [props.projectId]);
  if (mode === 'production') return <ProductionStoryboardPage {...props} />;
  return <StoryboardPage {...props} />;
};

export const App: React.FC = () => {
  const [step, setStep] = useState<Step>('projects');
  const [projectId, setProjectId] = useState<string | null>(() => new URLSearchParams(location.search).get('p'));
  return (
    <ToastHost>
      <Shell step={step} setStep={setStep} projectId={projectId} setProjectId={setProjectId} />
    </ToastHost>
  );
};
