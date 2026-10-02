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
import { storyboardModeForProduction, type StoryboardMode } from './lib/production-navigation';

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
 * Routes the existing Storyboard step to the PRODUCTION storyboard when the
 * project has production state, and to the LEGACY storyboard for legacy
 * projects. No shell redesign.
 *
 * The decision (and the documented legacy-project policy: legacy projects stay
 * on their original pipeline and are never silently migrated to a production
 * view that has no state to edit or export) lives in
 * `lib/production-navigation.ts`, so it can be tested directly.
 */
export const StoryboardGate: React.FC<{ projectId: string; onNext: () => void; onAssets: () => void; toast: (t: string, k?: any) => void }> = (props) => {
  const [mode, setMode] = useState<StoryboardMode>('loading');
  useEffect(() => {
    let alive = true;
    api
      .production(props.projectId)
      .then((r) => {
        if (alive) setMode(storyboardModeForProduction(r.production));
      })
      .catch(() => {
        // A failed production-state read means no production state is known:
        // fall back to the legacy storyboard (a working path), never to a
        // production view without state.
        if (alive) setMode(storyboardModeForProduction(null));
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
