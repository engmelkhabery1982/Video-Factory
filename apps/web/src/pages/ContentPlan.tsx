/**
 * Content plan (Milestone 2). A workflow beside the existing steps, not a new app.
 *
 * Flow: inputs -> draft (server-side, revisioned) -> three treatments -> explicit
 * selection and review -> apply into a NEW project that opens in the existing Editor.
 *
 * Honesty rules enforced here:
 *   - the form is never cleared on an error; the server's refusal is shown verbatim,
 *   - a transport failure is never reported as completed; the draft is reloaded to check,
 *   - apply is blocked while there are unsaved selection edits or missing inputs,
 *   - speech and timing labels say what is measured, estimated, or unknown,
 *   - there is no fallback data. A failed load is shown as failed.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Banner, Tag } from '../components/ui';
import { api } from '../lib/api';
import {
  applyBlockers,
  attachmentNotice,
  attachmentsForMode,
  visualKindOf,
  buildCreateBody,
  checkPlanForm,
  MODE_ATTACHMENT_KINDS,
  withProfile,
  EMPTY_PLAN_FORM,
  errorView,
  identityOptionsFor,
  INPUT_MODE_LABELS,
  materialLabel,
  materialSummaryOf,
  moveScene,
  panelsFromStoryboard,
  PROFILE_LABELS,
  profileNoteFor,
  speakerRowsFor,
  planningTimingLabel,
  speechStatusFor,
  visualExecutionLabel,
  type ErrorView,
  type PlanForm,
  type PlanInputMode,
} from '../lib/factory-model';
import {
  factoryApi,
  FactoryApiError,
  type FactoryApplyResult,
  type FactoryCapabilities,
  type FactoryClient,
  type FactoryDraftEnvelope,
  type FactoryDraftScene,
  type FactoryIntakePatch,
  type FactoryPatchBody,
} from '../lib/factory-api';
import type { LibraryAudio } from '../lib/audio-track-ops';
import { GraphicActionsEditor, GraphicValuesForm, techniqueChoices } from '../components/graphic/GraphicEditors';
import { kindOfTechnique } from '../lib/graphic-form';
import { VISUAL_LANGUAGES, VISUAL_TECHNIQUES } from '@buildtrack/core/visual';
import { factoryAi, localImageApi, type AiStatus, type FactoryAiClient, type LocalImageClient } from '../lib/factory-api';
import { METHOD_LABELS, narrationChanges, type PlanMethod } from '../lib/gemini-plan-model';
import { GeminiPlanPanel } from '../components/plan/GeminiPlanPanel';
import {
  IntakeReview,
  NarrationChoice,
  PdfStoryboardImport,
  PictureRoles,
  PlannerGateNote,
  PostCreateStoryboard,
  StoryboardCards,
  TopicStarter,
  TranscriptionPanel,
  VideoAudioPolicyChoice,
} from '../components/factory/IntakePanels';
import { ImageBatchUpload } from '../components/factory/ImageBatchUpload';
import { PictureAnalysis } from '../components/factory/PictureAnalysis';
import { visionApi, type VisionClient } from '../lib/vision-api';
import { DerivedRewritePanel, GeminiVoicesPanel, GeneratedApplyPanel, ShotListPanel } from '../components/plan/GeneratedDraftPanels';
import { LocalImagePanel } from '../components/plan/LocalImagePanel';

/** A library entry as the planner needs it. Mirrors the asset index fields it reads. */
export interface PlanLibraryItem extends LibraryAudio {
  mimeType?: string;
  width?: number;
  height?: number;
  sha256?: string | null;
}

/** Injected dependencies. Production uses `defaultPlanDeps`; tests pass their own labelled doubles. */
export interface PlanDeps {
  client: FactoryClient;
  loadLibrary: () => Promise<PlanLibraryItem[]>;
  uploadLibraryFile: (form: FormData) => Promise<unknown>;
  /** Gemini client. Production uses the real `factoryAi`; tests pass a labelled provider double. */
  ai?: FactoryAiClient;
  /** Local picture analysis client. Production uses `visionApi` (loopback server only); tests pass a labelled double. */
  vision?: VisionClient;
  images?: LocalImageClient;
}

export const defaultPlanDeps: PlanDeps = {
  client: factoryApi,
  loadLibrary: async () => ((await api.assets()).assets ?? []) as PlanLibraryItem[],
  uploadLibraryFile: (form) => api.uploadAsset(form),
  ai: factoryAi,
  vision: visionApi,
};

const isAudio = (a: PlanLibraryItem) => (a.mimeType ?? '').toLowerCase().startsWith('audio/') && a.status !== 'inactive';
const isVisual = (a: PlanLibraryItem) => {
  const m = (a.mimeType ?? '').toLowerCase();
  const k = a.kind;
  return (m.startsWith('image/') || m.startsWith('video/')) && !['logo', 'icon', 'font'].includes(k) && !m.includes('svg');
};
const usable = (a: PlanLibraryItem) => a.status !== 'inactive' && a.blocked !== true;

export interface ContentPlanProps {
  initialDraftId: string | null;
  onOpenEditor: (projectId: string) => void;
  deps?: PlanDeps;
}

export const ContentPlanPage: React.FC<ContentPlanProps> = ({ initialDraftId, onOpenEditor, deps = defaultPlanDeps }) => {
  const [form, setForm] = useState<PlanForm>(EMPTY_PLAN_FORM);
  const [caps, setCaps] = useState<FactoryCapabilities | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [library, setLibrary] = useState<PlanLibraryItem[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [env, setEnv] = useState<FactoryDraftEnvelope | null>(null);
  const [sceneEdits, setSceneEdits] = useState<FactoryDraftScene[] | null>(null);
  /** Draft-level visual language being edited. undefined = no edit pending; null = cleared. */
  const [languageEdit, setLanguageEdit] = useState<string | null | undefined>(undefined);
  /** Shots whose technique or graphic choices block a language change. Empty when none. */
  const [overrideIds, setOverrideIds] = useState<string[]>([]);
  /** Visible notice for attachments removed when the input mode changed. */
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [speakerEdits, setSpeakerEdits] = useState<Record<string, string | null>>({});
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [applied, setApplied] = useState<FactoryApplyResult | null>(null);
  const [uploadDraft, setUploadDraft] = useState({ source: '', license: '' });
  const [method, setMethod] = useState<PlanMethod>('local');
  const [narrationEdits, setNarrationEdits] = useState<Record<string, string>>({});
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);

  const { client } = deps;
  const ai = deps.ai ?? factoryAi;
  const generated = env?.generationMode === 'gemini_plan';
  const orderLocked = env?.speechOrderLocked ?? false;
  const selected = env?.treatments.find((t) => t.id === env.selectedTreatmentId) ?? null;
  const rows = sceneEdits ?? selected?.scenes ?? [];
  const pendingNarration = generated ? narrationChanges(rows, narrationEdits).length : 0;
  const unsaved = sceneEdits !== null || Object.keys(speakerEdits).length > 0 || pendingNarration > 0;

  const refreshAiStatus = useCallback(() => {
    // Read-only status. It never starts a provider call.
    ai.aiStatus().then(setAiStatus).catch(() => setAiStatus(null));
  }, [ai]);
  useEffect(() => {
    refreshAiStatus();
  }, [refreshAiStatus]);

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await deps.loadLibrary());
      setLibraryError(null);
    } catch (e) {
      setLibrary([]);
      setLibraryError(`The library could not be read: ${(e as Error).message}`);
    }
  }, [deps]);

  useEffect(() => {
    let alive = true;
    client
      .capabilities()
      .then((c) => alive && setCaps(c))
      .catch((e) => alive && setCapsError(`Capabilities could not be read: ${(e as Error).message}. Generation is not assumed.`));
    void refreshLibrary();
    return () => {
      alive = false;
    };
  }, [client, refreshLibrary]);

  const adopt = useCallback((next: FactoryDraftEnvelope, keepEdits = false) => {
    setEnv(next);
    if (!keepEdits) {
      setSceneEdits(null);
      setSpeakerEdits({});
      setNarrationEdits({});
    }
    setReviewed(false);
    setApplied(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('draft', next.draftId);
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* URL update is a convenience for reopen; the page works without it. */
    }
  }, []);

  /* Reopen: the draft id in the address restores the draft, its selection and its speaker decisions. */
  useEffect(() => {
    if (!initialDraftId) return;
    let alive = true;
    setLoadingDraft(true);
    client
      .getDraft(initialDraftId)
      .then((e) => {
        if (alive) adopt(e);
      })
      .catch((e) => {
        if (alive) setError(errorView(e));
      })
      .finally(() => alive && setLoadingDraft(false));
    return () => {
      alive = false;
    };
  }, [client, initialDraftId, adopt]);

  /* ---- create ---------------------------------------------------- */

  const create = async () => {
    const check = checkPlanForm(form);
    if (!check.ok) {
      setError({ title: 'Check the inputs', detail: check.errors.join(' '), missing: [], next: 'fix_input', completionConfirmed: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await client.createDraft(buildCreateBody(form, check.storyboard));
      adopt(created);
      setNotice(created.status === 'blocked' ? 'The draft is saved but blocked. Resolve the list below.' : 'Draft saved. Review the treatments below.');
    } catch (e) {
      // The form is kept exactly as the user left it.
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  };

  /* ---- selection ------------------------------------------------- */

  const patchSelection = async (treatmentId: string, scenes: FactoryDraftScene[], speakers: Record<string, string | null>, keepEdits: boolean, language?: string | null, reset = false) => {
    if (!env) return false;
    const speakerRows = env.speakers.map((s) => ({ id: s.id, voiceId: s.id in speakers ? speakers[s.id] : s.voiceId }));
    // A language change sends only the owner's fields. Server-owned shot fields and the shot's technique and graphic
    // come from the server's rows for the new language, so the owner's old choices never ride along by accident.
    const languageRows = (s: FactoryDraftScene): FactoryPatchBody['scenes'][number] => ({
      id: s.id,
      narration: s.narration,
      speakerId: s.speakerId,
      visualIntent: s.visualIntent,
      assetId: s.assetId,
      startSec: s.startSec,
      endSec: s.endSec,
      locked: s.locked,
    });
    const body: FactoryPatchBody = {
      expectedRevision: env.revision,
      selectedTreatmentId: treatmentId,
      scenes: language !== undefined ? scenes.map(languageRows) : scenes.map((s) => ({
        id: s.id,
        narration: s.narration,
        speakerId: s.speakerId,
        visualIntent: s.visualIntent,
        assetId: s.assetId,
        startSec: s.startSec,
        endSec: s.endSec,
        locked: s.locked,
        sourceUnitId: s.sourceUnitId,
        beat: s.beat,
        language: s.language,
        assetOrigin: s.assetOrigin,
        timingSource: s.timingSource,
        visualDecision: s.visualDecision,
        ...(s.shot !== undefined ? { shot: s.shot } : {}),
        ...(s.technique !== undefined ? { technique: s.technique } : {}),
        ...(s.graphic !== undefined ? { graphic: s.graphic } : {}),
      })),
      speakers: speakerRows,
      ...(language !== undefined ? { visualLanguage: language } : {}),
      ...(language !== undefined && reset ? { resetShotTechniques: true } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const next = await client.patchDraft(env.draftId, body);
      adopt(next, false);
      setOverrideIds([]);
      setNotice('Selection saved. Nothing is applied until you confirm the review below.');
      return true;
    } catch (e) {
      // Keep the user's edits on screen so nothing is lost on a recoverable refusal.
      if (keepEdits) setSceneEdits(scenes);
      const ids = e instanceof FactoryApiError && Array.isArray(e.details.sceneIds) ? (e.details.sceneIds as string[]) : [];
      setOverrideIds(ids);
      setError(errorView(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chooseTreatment = (treatmentId: string) => {
    if (!env || treatmentId === env.selectedTreatmentId) return;
    // Switching treatment replaces the scene rows, so unsaved scene edits must be saved or abandoned first.
    if (pendingNarration > 0) {
      setError({ title: 'Save your narration edits first', detail: 'Use “Save narration edits” before switching treatment, so the unapproved text is not lost.', missing: [], next: 'fix_input', completionConfirmed: false });
      return;
    }
    if (sceneEdits !== null) {
      setError({ title: 'Save or discard your scene edits first', detail: 'Switching treatment would replace the unsaved scene edits on this screen. Use “Save selection” first.', missing: [], next: 'fix_input', completionConfirmed: null });
      return;
    }
    const target = env.treatments.find((t) => t.id === treatmentId);
    if (!target) return;
    void patchSelection(treatmentId, target.scenes, speakerEdits, false);
  };

  const saveSelection = () => {
    if (!env) return;
    if (pendingNarration > 0) {
      setError({ title: 'Save your narration edits first', detail: 'Use “Save narration edits” first. The selection save does not carry generated narration.', missing: [], next: 'fix_input', completionConfirmed: false });
      return;
    }
    void patchSelection(env.selectedTreatmentId ?? '', rows, speakerEdits, true);
  };

  const saveNarration = async () => {
    if (!env) return;
    const changes = narrationChanges(rows, narrationEdits);
    if (changes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const next = await ai.patchGenerated(env.draftId, { expectedRevision: env.revision, edits: changes });
      adopt(next, false);
      setNotice('Narration saved as unapproved text. Only the changed lines are regenerated on Apply.');
    } catch (e) {
      // The typed narration stays on screen so a refused save loses nothing.
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  };

  const editScene = (index: number, change: Partial<FactoryDraftScene>) => {
    const next = rows.map((r, i) => (i === index ? { ...r, ...change } : r));
    setSceneEdits(next);
    setReviewed(false);
  };

  /** Language the rows are being judged against: the pending edit if any, else the saved draft language. */
  const languageInUse = languageEdit !== undefined ? languageEdit : (env?.visualLanguage ?? null);

  const changeTechnique = (index: number, technique: string | null) => {
    const row = rows[index];
    const kind = technique ? kindOfTechnique(technique) : null;
    if (row.graphic && row.graphic.kind !== kind) {
      editScene(index, { technique: technique as FactoryDraftScene['technique'], graphic: null });
      setNotice('The graphic values on this shot were cleared because the technique changed. Enter values for the new technique.');
      return;
    }
    editScene(index, { technique: technique as FactoryDraftScene['technique'] });
  };

  const saveLanguage = async (reset = false) => {
    if (!env || languageEdit === undefined) return;
    const ok = await patchSelection(env.selectedTreatmentId ?? '', rows, {}, true, languageEdit, reset);
    if (ok) setLanguageEdit(undefined);
  };

  /** Mode change: keep the attachments the new mode accepts and say what was removed. */
  const changeInputMode = (mode: PlanInputMode) => {
    const change = attachmentsForMode(mode, form.visualAssetIds, attachable);
    setForm((f) => ({ ...f, inputMode: mode, visualAssetIds: change.kept }));
    setAttachNotice(attachmentNotice(mode, change.removed));
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = moveScene(rows, index, delta, orderLocked);
    if (next !== rows) {
      setSceneEdits(next);
      setReviewed(false);
    }
  };

  /* ---- apply ----------------------------------------------------- */

  const blockers = applyBlockers(env, unsaved, reviewed);

  const apply = async () => {
    if (!env || blockers.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.applyDraft(env.draftId, env.revision);
      setApplied(result);
      setNotice(
        result.reused
          ? `This draft revision was already applied. Opening the existing project ${result.projectId}; nothing new was created.`
          : `Created project ${result.projectId} (${result.format}). Opening it in the editor.`,
      );
      onOpenEditor(result.projectId);
    } catch (e) {
      setError(errorView(e));
      if (e instanceof FactoryApiError && !e.answered) {
        // No reply: check the server for a project before anyone is told the apply failed.
        const before = env.appliedProjects.length;
        try {
          const check = await client.getDraft(env.draftId);
          if (check.appliedProjects.length > before) {
            adopt(check);
            setNotice(`The server shows that project ${check.appliedProjects[check.appliedProjects.length - 1].projectId} was created by this draft.`);
          } else {
            setEnv(check);
          }
        } catch {
          /* still unknown: the message above already says no completion is confirmed */
        }
      }
    } finally {
      setBusy(false);
    }
  };

  /** One revision-checked intake change. The draft is replaced only by the server's answer; a refusal keeps it. */
  const patchIntakeNow = async (change: Partial<FactoryIntakePatch>) => {
    if (!env) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.patchIntake(env.draftId, { expectedRevision: env.revision, ...change });
      adopt(next);
      setNotice('Saved. The review queue below is up to date.');
    } catch (e) {
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  };

  const reloadDraft = async () => {
    if (!env) return;
    setBusy(true);
    try {
      const next = await client.getDraft(env.draftId);
      adopt(next, true);
      setNotice('Draft reloaded. Your unsaved selection edits are kept on screen. Save them again to apply them to this revision.');
      setError(null);
    } catch (e) {
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  };

  /* ---- library upload (reuses the existing asset endpoint) ------- */

  const upload = async (file: File, kind: 'audio' | 'visual') => {
    if (!uploadDraft.source.trim() || !uploadDraft.license.trim()) {
      setLibraryError('Enter the source and the licence for the file before uploading. Audio without them is refused.');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind === 'audio' ? 'sfx' : file.type.startsWith('video') ? 'broll' : 'screenshot');
    fd.append('source', uploadDraft.source.trim());
    fd.append('license', uploadDraft.license.trim());
    setBusy(true);
    try {
      await deps.uploadLibraryFile(fd);
      await refreshLibrary();
      setLibraryError(null);
      if (kind === 'audio') setForm((f) => ({ ...f, audioAssetId: null }));
    } catch (e) {
      setLibraryError(`The file was NOT added to the library: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const audioChoices = useMemo(() => library.filter((a) => isAudio(a) && usable(a) && (a.durationSec ?? 0) > 0), [library]);
  const visualChoices = useMemo(() => library.filter((a) => isVisual(a) && usable(a)), [library]);
  /** Every library picture or clip as an attachment: its id, name and attachment kind (image or video). */
  const attachable = useMemo(
    () => visualChoices.map((a) => ({ id: a.id, name: a.name, kind: visualKindOf(a.mimeType) ?? 'unknown' })),
    [visualChoices],
  );
  const modeChoices = useMemo(
    () => visualChoices.filter((a) => (MODE_ATTACHMENT_KINDS[form.inputMode] as readonly string[]).includes(visualKindOf(a.mimeType) ?? '')),
    [visualChoices, form.inputMode],
  );
  /** The explicit video-audio policy only applies when at least one attached library item is footage. */
  const hasAttachedVideo = useMemo(
    () => form.visualAssetIds.some((id) => visualChoices.some((a) => a.id === id && visualKindOf(a.mimeType) === 'video')),
    [form.visualAssetIds, visualChoices],
  );
  const envHasVideo = useMemo(
    () => env?.inputs.visualAssetIds.some((id) => visualChoices.some((a) => a.id === id && visualKindOf(a.mimeType) === 'video')) ?? false,
    [env, visualChoices],
  );
  const identityOptions = identityOptionsFor(form.profile);
  const speakerRows = speakerRowsFor(env ?? emptyEnv, caps);

  const setField = <K extends keyof PlanForm>(key: K, value: PlanForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="plan-page" data-testid="content-plan">
      <div className="card">
        <h2>Content plan</h2>
        <p className="small">
          Plan from your own words and media. Choose labelled offline rules or local AI, review a treatment, and edit the resulting project before export.
          Applying creates a new project that opens in the editor.
        </p>
        {capsError ? <Banner kind="warn">{capsError}</Banner> : null}
        <details className="mt">
          <summary>Engine status (technical)</summary>
          <EngineStatus caps={caps} />
        </details>
      </div>

      {error ? <ErrorBanner view={error} onReload={env ? reloadDraft : undefined} /> : null}
      {notice ? <Banner kind="info">{notice}</Banner> : null}
      {loadingDraft ? <div className="card">Loading the draft…</div> : null}

      {!env ? (
        <div className="card" data-testid="method-choice">
          <h3>How is the plan made?</h3>
          {(Object.keys(METHOD_LABELS) as PlanMethod[]).map((m) => (
            <label key={m} className="row" style={{ gap: 8 }}>
              <input type="radio" name="planMethod" value={m} checked={method === m} onChange={() => setMethod(m)} data-testid={`method-${m}`} />
              {METHOD_LABELS[m]}
            </label>
          ))}
          <p className="small">Offline rules are labelled as offline. Local AI runs only when you press Generate. Google is used only for optional speech.</p>
        </div>
      ) : null}
      {!env && method === 'gemini' ? (
        <GeminiPlanPanel ai={ai} hasUnsavedEdits={false} onDraft={(next) => adopt(next, false)} />
      ) : null}
      {!env && method === 'local' ? (
        <div className="card" data-testid="plan-form">
          <h3>1. Inputs</h3>
          <div className="grid2">
            <label className="field">
              <span>Content profile</span>
              <select value={form.profile} onChange={(e) => setForm((f) => withProfile(f, e.target.value as PlanForm['profile']))}>
                {Object.entries(PROFILE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <small className="small">{profileNoteFor(form.profile)}</small>
            </label>
            <label className="field">
              <span>Format</span>
              <select value={form.format} onChange={(e) => setField('format', e.target.value as PlanForm['format'])}>
                <option value="landscape">Landscape (long video)</option>
                <option value="portrait">Portrait (short video)</option>
              </select>
              <small className="small">Format is kept on the new project and selects the matching composition.</small>
            </label>
            <label className="field">
              <span>Channel identity</span>
              <select value={form.identity} onChange={(e) => setField('identity', e.target.value as PlanForm['identity'])}>
                {identityOptions.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
                ))}
              </select>
              {identityOptions.find((o) => o.disabled) ? <small className="small">{identityOptions.find((o) => o.disabled)?.reason}</small> : null}
            </label>
          </div>

          <label className="field mt" data-testid="create-visual-language">
            <span>Visual language</span>
            <select aria-label="Create visual language" value={form.visualLanguage ?? ''} onChange={(e) => setField('visualLanguage', (e.target.value || null) as PlanForm['visualLanguage'])}>
              <option value="">No language (existing behaviour: no per-shot technique)</option>
              {Object.values(VISUAL_LANGUAGES).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            {form.visualLanguage ? (
              <small className="small">
                {VISUAL_LANGUAGES[form.visualLanguage].summary} Techniques: {VISUAL_LANGUAGES[form.visualLanguage].techniques.map((t) => VISUAL_TECHNIQUES[t].label).join('; ')}.
                {VISUAL_LANGUAGES[form.visualLanguage].capability === 'ready' ? '' : ` ${VISUAL_LANGUAGES[form.visualLanguage].reason}`}
              </small>
            ) : null}
          </label>
          <TopicStarter
            client={client}
            profile={form.profile}
            onUseTopic={(title) => {
              setForm((f) => ({ ...f, brief: title, inputMode: 'brief' }));
              setNotice('Topic copied into the brief. The rules wrote no script: supply reviewed words or open the local semantic planner when it is ready.');
            }}
          />

          <label className="field mt">
            <span>Brief (one line, not narration)</span>
            <input value={form.brief} onChange={(e) => setField('brief', e.target.value)} placeholder="What this video is about" />
          </label>

          <fieldset className="mt">
            <legend>Starting point (add any other material below)</legend>
            {(Object.keys(INPUT_MODE_LABELS) as PlanInputMode[]).map((mode) => (
              <label key={mode} className="row" style={{ gap: 8 }}>
                <input type="radio" name="inputMode" checked={form.inputMode === mode} onChange={() => changeInputMode(mode)} />
                {INPUT_MODE_LABELS[mode]}
              </label>
            ))}
            {form.inputMode === 'brief' ? (
              <Banner kind="warn">
                No text engine is configured. A brief alone is blocked until you supply reviewed script text. No script is generated.
              </Banner>
            ) : null}
          </fieldset>

          {form.inputMode === 'brief' ? (
            <p className="small mt" data-testid="brief-script-note">
              The brief starting point does not send script text. {form.script.trim() ? 'The script you wrote is kept here and is not sent. Choose another starting point to send it.' : 'Choose another starting point to add a reviewed script.'}
            </p>
          ) : (
            <label className="field mt">
              <span>Reviewed script (optional{form.inputMode === 'audio_script' || form.inputMode === 'video_narration' ? ': the words the audio speaks' : ''})</span>
              <textarea rows={8} value={form.script} onChange={(e) => setField('script', e.target.value)} />
              <small className="small">Your words are kept exactly. Each sentence becomes one scene. Nothing is rewritten.</small>
            </label>
          )}

          <div className="mt">
            <label className="field">
              <span>Audio file (optional, library)</span>
              <select
                aria-label="Audio file"
                value={form.audioAssetId ?? ''}
                onChange={(e) => {
                  // A changed audio file clears the attached transcript: it was made from the old file.
                  setField('audioAssetId', e.target.value || null);
                  setField('transcriptJobId', null);
                }}
              >
                <option value="">No audio</option>
                {audioChoices.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({(a.durationSec ?? 0).toFixed(1)} s measured)</option>
                ))}
              </select>
            </label>
            <p className="small">Supplied audio is used as it is. Its words come from the reviewed script or the reviewed transcript below. They are never guessed.</p>
          </div>

          <NarrationChoice value={form.narrationChoice} onChange={(v) => setField('narrationChoice', v)} audioAttached={!!form.audioAssetId} />
          {hasAttachedVideo ? (
            <VideoAudioPolicyChoice value={form.videoAudioPolicy} onChange={(next) => setField('videoAudioPolicy', next)} disabled={busy} />
          ) : null}
          <label className="row mt" style={{ gap: 8 }}>
            <input type="checkbox" checked={form.captions} onChange={(e) => setField('captions', e.target.checked)} data-testid="create-captions" />
            Captions (optional)
          </label>

          <TranscriptionPanel
            key={form.audioAssetId ?? 'no-audio'}
            client={client}
            audioAssetId={form.audioAssetId}
            attachedJobId={form.transcriptJobId}
            onAttach={(id) => setField('transcriptJobId', id)}
          />

          <StoryboardCards
            panels={form.panels}
            onChange={(next) => setField('panels', next)}
            pictures={visualChoices.map((a) => ({ id: a.id, name: a.name }))}
          />

          <PdfStoryboardImport
            client={client}
            onImported={(result) => {
              // Exact page order, panel ids, pictures and null times/locks come straight from the parser.
              setForm((f) => ({
                ...f,
                panels: panelsFromStoryboard(result.storyboard),
                visualAssetIds: Array.from(new Set([...f.visualAssetIds, ...result.visualAssetIds])),
              }));
              void refreshLibrary();
              setNotice(`PDF “${result.report.sourceFileName}” imported: ${result.report.pageCount} panel(s), ${result.visualAssetIds.length} picture(s). Review every panel before creating the draft.`);
            }}
          />

          <fieldset className="mt" data-testid="attachments">
            <legend>Attached to this input (library)</legend>
            <p className="small">
              {INPUT_MODE_LABELS[form.inputMode]} accepts {MODE_ATTACHMENT_KINDS[form.inputMode].join(' or ')} only. Only the items listed as attached are sent with Create.
            </p>
            {attachNotice ? <Banner kind="info">{attachNotice}</Banner> : null}
            {form.visualAssetIds.length > 0 ? (
              <ul className="small" data-testid="attached-list">
                {form.visualAssetIds.map((id) => {
                  const item = attachable.find((a) => a.id === id);
                  return (
                    <li key={id} className="row" style={{ gap: 8 }}>
                      <span>{item ? `${item.name} (${item.kind})` : id}</span>
                      <button className="btn sm" type="button" onClick={() => { setAttachNotice(null); setField('visualAssetIds', form.visualAssetIds.filter((x) => x !== id)); }}>Remove</button>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="small">Nothing attached.</p>}
            {modeChoices.length === 0 ? (
              <p className="small">No {MODE_ATTACHMENT_KINDS[form.inputMode].join(' or ')} is in the library yet. Upload one below, or continue: scenes will show as missing.</p>
            ) : null}
            <div className="grid2">
              {modeChoices.map((a) => (
                <label key={a.id} className="row" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={form.visualAssetIds.includes(a.id)}
                    onChange={(e) => { setAttachNotice(null); setField('visualAssetIds', e.target.checked ? [...form.visualAssetIds, a.id] : form.visualAssetIds.filter((x) => x !== a.id)); }}
                  />
                  {a.name} <span className="small">({visualKindOf(a.mimeType)})</span>
                </label>
              ))}
            </div>
          </fieldset>

          <PictureRoles
            pictures={form.visualAssetIds.map((id) => ({ id, name: attachable.find((a) => a.id === id)?.name ?? id }))}
            roles={form.visualRoles}
            onChange={(next) => setField('visualRoles', next)}
            notes={form.visualNotes}
            onNotesChange={(next) => setField('visualNotes', next)}
          />

          <ImageBatchUpload
            source={uploadDraft.source}
            license={uploadDraft.license}
            upload={(fd) => deps.uploadLibraryFile(fd)}
            onLibraryChanged={refreshLibrary}
            panels={form.panels}
            busy={busy}
            onCards={(r) =>
              setForm((f) => ({
                ...f,
                panels: r.panels,
                visualAssetIds: Array.from(new Set([...f.visualAssetIds, ...r.attachIds])),
                visualRoles: { ...f.visualRoles, ...Object.fromEntries(r.references.map((x) => [x.assetId, x.role])) },
              }))
            }
          />
          <LibraryUpload draft={uploadDraft} setDraft={setUploadDraft} onFile={upload} busy={busy} libraryError={libraryError} />

          <div className="row mt" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" disabled={busy} onClick={() => void create()} data-testid="create-draft">
              {busy ? 'Saving…' : 'Create draft'}
            </button>
          </div>
        </div>
      ) : env ? (
        <>
          <div className="card" data-testid="draft-status">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3>2. Draft <span className="mono small">{env.draftId}</span>{generated ? <> <Tag kind="accent">Gemini-generated · unapproved</Tag></> : null}</h3>
                <div className="small">
                  Revision {env.revision} · {PROFILE_LABELS[env.profile.contentProfile].split(' (')[0]} · {env.profile.format}
                  {env.profile.channelBrandId ? ` · identity ${env.profile.channelBrandId}` : ' · no channel identity'}
                </div>
              </div>
              <div className="row">
                <Tag kind={env.status === 'review_required' ? 'ok' : 'warn'}>{env.status === 'review_required' ? 'ready for review' : 'blocked'}</Tag>
                <Tag kind={env.speechOrderLocked ? 'accent' : ''}>{env.speechOrderLocked ? 'order fixed by supplied speech' : 'order may change'}</Tag>
                <button className="btn sm" onClick={() => { setEnv(null); setSceneEdits(null); setSpeakerEdits({}); setApplied(null); setReviewed(false); setError(null); setNotice(null); window.history.replaceState(null, '', window.location.pathname); }}>
                  Start a new plan
                </button>
              </div>
            </div>
            <InputsSummary env={env} />
            {env.missing.length > 0 ? (
              <div className="banner warn" data-testid="missing-list">
                <b>Missing ({env.missing.length})</b>
                <ul>
                  {env.missing.map((m, i) => (
                    <li key={`${m.kind}-${m.sceneId ?? i}`}>
                      <span className="mono small">{m.kind}{m.sceneId ? ` · ${m.sceneId}` : ''}</span> {m.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {env.plannerGate ? <PlannerGateNote gate={env.plannerGate} /> : null}
            <IntakeReview env={env} busy={busy} onPatch={(change) => void patchIntakeNow(change as Partial<FactoryIntakePatch>)} />
            {env.intake?.storyboard ? (
              <PostCreateStoryboard
                storyboard={env.intake.storyboard}
                revision={env.revision}
                busy={busy}
                pictures={env.inputs.visualAssetIds.map((id) => ({ id, name: attachable.find((a) => a.id === id)?.name ?? id }))}
                onReload={reloadDraft}
                onSave={async (body) => {
                  const next = await client.patchIntake(env.draftId, body);
                  adopt(next);
                  setNotice('Storyboard saved. The review queue below is up to date.');
                }}
              />
            ) : null}
            <div className="card mt" data-testid="intake-controls">
              <NarrationChoice
                value={env.intake ? (env.intake.requestedNarrationMode ?? 'auto') : 'auto'}
                onChange={(v) => void patchIntakeNow({ narrationMode: v === 'auto' ? null : v })}
                audioAttached={!!env.inputs.audioAssetId}
              />
              {envHasVideo && env.intake ? (
                <VideoAudioPolicyChoice
                  value={env.intake.videoAudioPolicy ?? null}
                  onChange={(next) => void patchIntakeNow({ videoAudioPolicy: next })}
                  disabled={busy}
                />
              ) : null}
              <PictureRoles
                pictures={env.inputs.visualAssetIds.map((id) => ({ id, name: attachable.find((a) => a.id === id)?.name ?? id }))}
                roles={env.intake?.visualRoles ?? {}}
                onChange={(next) => void patchIntakeNow({ visualRoles: next })}
                notes={env.intake?.visualNotes ?? {}}
                onNotesChange={(next) => void patchIntakeNow({ visualNotes: next })}
                engineNotes={false}
              />
              <PictureAnalysis
                client={deps.vision ?? visionApi}
                env={env}
                pictures={env.inputs.visualAssetIds.map((id) => {
                  const a = visualChoices.find((x) => x.id === id);
                  return { id, name: a?.name ?? id, source: a?.source ?? null, license: a?.license ?? null, sha256: a?.sha256 ?? null };
                })}
                onSaved={(next) => adopt(next)}
              />
              {env.inputs.audioAssetId ? (
                <TranscriptionPanel
                  key={`${env.draftId}-${env.inputs.audioAssetId}`}
                  client={client}
                  audioAssetId={env.inputs.audioAssetId}
                  attachedJobId={env.intake?.transcript?.jobId ?? null}
                  onAttach={(id) => void patchIntakeNow({ transcriptJobId: id })}
                />
              ) : null}
            </div>
            {env.warnings.length > 0 ? (
              <ul className="small" data-testid="warnings">
                {env.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            ) : null}
            {env.appliedProjects.length > 0 ? (
              <div className="small" data-testid="applied-projects">
                <div>Applied so far:</div>
                {env.appliedProjects.map((p) => (
                  <AppliedProjectRow key={p.projectId} client={client} projectId={p.projectId} onOpen={onOpenEditor} />
                ))}
              </div>
            ) : null}
          </div>

          <div className="card" data-testid="treatments">
            <h3>3. Treatments</h3>
            <p className="small">
              Each treatment keeps your words unchanged. They differ in visual framing, motion and speaker labels
              {env.speechOrderLocked ? '. The order of speech is fixed because a recording or your timing is supplied.' : ', and in scene order, because no recording is supplied.'}
            </p>
            {env.treatments.map((t) => {
              const mat = materialSummaryOf(t);
              const isSel = t.id === env.selectedTreatmentId;
              return (
                <div key={t.id} className={`treatment ${isSel ? 'selected' : ''}`} data-testid={`treatment-${t.id}`} style={{ borderLeft: isSel ? '3px solid var(--accent, #0B3D91)' : '3px solid transparent', padding: '8px 10px', marginTop: 8 }}>
                  <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <input type="radio" name="treatment" checked={isSel} disabled={busy} onChange={() => chooseTreatment(t.id)} />
                    <span>
                      <b>{t.title}</b>
                      <div className="small">{t.rationale}</div>
                    </span>
                  </label>
                  <div className="small" style={{ marginTop: 4 }}>
                    Scene order: {t.scenes.map((s) => s.sourceUnitId).join(' → ')} · Beats: {t.structure.join(', ')}
                    {' · '}Pictures: {mat.supplied} supplied, {mat.library} library, {mat.reviewer} chosen in review, {mat.missing} missing
                    {mat.gaps.length ? ` · ${mat.gaps.length} requested visual feature(s) not executed` : ''}
                  </div>
                  {isSel ? null : (
                    <ol className="small" style={{ marginTop: 4 }}>
                      {t.scenes.map((s) => (
                        <li key={s.id}>{s.sourceUnitId} · {s.beat} · {speakerLabel(s.speakerId)} · {s.visualIntent}</li>
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
          </div>

          {selected ? (
            <div className="card" data-testid="selected-scenes">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3>4. Scenes of “{selected.title}”</h3>
                <div className="row">
                  {unsaved ? <Tag kind="warn">unsaved edits</Tag> : null}
                  <button className="btn sm primary" disabled={!unsaved || busy} onClick={saveSelection} data-testid="save-selection">Save selection</button>
                </div>
              </div>
              <p className="small">
                {generated
                  ? 'Narration is generated and unapproved. Edit it here, then save the narration edits. Only changed lines are regenerated on Apply. Speaker, picture, lock and order are yours to change.'
                  : 'Speech is the supplied text and is not edited here. Speaker, picture, lock and order are the decisions you can change.'}
              </p>
              {generated ? (
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn sm" disabled={busy || sceneEdits !== null || pendingNarration === 0} onClick={() => void saveNarration()} data-testid="save-narration">
                    Save narration edits{pendingNarration > 0 ? ` (${pendingNarration})` : ''}
                  </button>
                  {sceneEdits !== null ? <span className="small">Save the selection first, then edit the narration.</span> : null}
                </div>
              ) : null}
              <div className="row mt" style={{ gap: 8, flexWrap: 'wrap' }} data-testid="visual-language">
                <label className="field">
                  <span>Visual language (whole draft)</span>
                  <select aria-label="Visual language" disabled={busy || sceneEdits !== null} value={languageInUse ?? ''} onChange={(e) => setLanguageEdit(e.target.value || null)}>
                    <option value="">No language (existing behaviour)</option>
                    {Object.values(VISUAL_LANGUAGES).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                </label>
                {languageEdit !== undefined ? (
                  <button className="btn sm" disabled={busy} onClick={() => void saveLanguage()} data-testid="save-language">Save visual language</button>
                ) : null}
                {languageEdit !== undefined && overrideIds.length > 0 ? (
                  <Banner kind="warn">
                    Shots {overrideIds.join(', ')} have a technique or graphic chosen for the current language. Those choices stay until you discard them.{' '}
                    <button className="btn sm" disabled={busy} onClick={() => void saveLanguage(true)} data-testid="reset-language-choices">Discard those choices and change language</button>
                  </Banner>
                ) : null}
                <span className="small">{sceneEdits !== null ? 'Save the selection first, then change the language.' : 'Changing the language does not change any narration or timing.'}</span>
              </div>
              <table className="plan-table" style={{ width: '100%', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>#</th><th>{generated ? 'Speech (generated, unapproved)' : 'Speech (supplied, unchanged)'}</th><th>Speaker</th><th>Picture</th><th>Visual execution</th><th>Timing</th><th>Lock</th><th>Order</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s, i) => {
                    const mat = materialLabel(s);
                    const sceneGaps = s.visualDecision.unexecuted;
                    return (
                      <tr key={s.id} data-testid={`scene-${s.id}`} style={{ verticalAlign: 'top' }}>
                        <td className="mono">{s.sourceUnitId}</td>
                        <td dir={s.language === 'ar' ? 'rtl' : 'ltr'}>
                          {generated ? (
                            <textarea
                              rows={2}
                              aria-label={`Narration for ${s.sourceUnitId}`}
                              value={narrationEdits[s.sourceUnitId] ?? s.narration}
                              disabled={busy || sceneEdits !== null}
                              dir={s.language === 'ar' ? 'rtl' : 'ltr'}
                              onChange={(e) => setNarrationEdits((m) => ({ ...m, [s.sourceUnitId]: e.target.value }))}
                              style={{ width: '100%' }}
                            />
                          ) : s.narration}
                          <div className="small">{s.beat} · {s.language === 'ar' ? 'Arabic' : s.language === 'en' ? 'English' : 'language not detected'}</div>
                        </td>
                        <td>
                          <select aria-label={`Speaker for ${s.id}`} value={s.speakerId ?? ''} onChange={(e) => editScene(i, { speakerId: e.target.value || null })} disabled={busy}>
                            <option value="">None</option>
                            {(env?.speakers ?? []).map((sp) => <option key={sp.id} value={sp.id}>{sp.id}</option>)}
                            {s.speakerId && !(env?.speakers ?? []).some((sp) => sp.id === s.speakerId) ? <option value={s.speakerId}>{s.speakerId}</option> : null}
                          </select>
                        </td>
                        <td>
                          <select aria-label={`Picture for ${s.id}`} value={s.assetId ?? ''} onChange={(e) => editScene(i, { assetId: e.target.value || null })} disabled={busy}>
                            <option value="">None (missing)</option>
                            {visualOptions(library, s.assetId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                          <div className="small">{mat.label}</div>
                        </td>
                        <td className="small">
                          <select aria-label={`Technique for ${s.id}`} value={s.technique ?? ''} disabled={busy} onChange={(e) => changeTechnique(i, e.target.value || null)}>
                            <option value="">No technique (as before)</option>
                            {techniqueChoices(languageInUse).map((t) => (
                              <option key={t.id} value={t.id} disabled={!t.allowed && s.technique !== t.id}>{t.label}{t.allowed ? '' : ' (not in this language)'}</option>
                            ))}
                          </select>
                          {s.technique ? <div data-testid={`readiness-${s.id}`}>{readinessLine(env, s, sceneEdits !== null)}</div> : null}
                          {visualExecutionLabel(s)}
                          {sceneGaps.map((g) => <div key={g} className="warn-text">Not executed: {g}</div>)}
                        </td>
                        <td className="small">{planningTimingLabel(env, s.timingSource)}{s.startSec !== null ? ` (${s.startSec}–${s.endSec} s)` : ''}</td>
                        <td>
                          <input type="checkbox" aria-label={`Lock ${s.id}`} checked={s.locked} disabled={busy} onChange={(e) => editScene(i, { locked: e.target.checked })} />
                        </td>
                        <td>
                          {orderLocked ? <span className="small">fixed</span> : (
                            <>
                              <button className="btn sm" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.id} up`}>↑</button>
                              <button className="btn sm" disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.id} down`}>↓</button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.map((s, i) => {
                const kind = kindOfTechnique(s.technique);
                if (!kind) return null;
                const timed = s.startSec !== null && s.endSec !== null;
                const duration = timed ? (s.endSec as number) - (s.startSec as number) : 0;
                const format = env?.profile.format ?? 'landscape';
                const profile = env?.profile.contentProfile ?? null;
                return (
                  <div key={s.id} className="card mt" data-testid={`graphic-shot-${s.id}`}>
                    <b>{s.id}: {techniqueChoices(null).find((t) => t.id === s.technique)?.label ?? s.technique}</b>
                    {timed ? null : <div className="warn-text small">This shot has no timing yet. Its graphic duration is needed before values can be checked, so values are not offered.</div>}
                    {timed ? (
                      <>
                        <GraphicValuesForm key={`${s.id}-${s.technique}`} label={s.id} technique={s.technique as NonNullable<FactoryDraftScene['technique']>} graphic={s.graphic ?? null} format={format} profile={profile} durationSec={duration} disabled={busy} onChange={(g) => editScene(i, { graphic: g })} />
                        {s.graphic ? <GraphicActionsEditor label={s.id} graphic={s.graphic} format={format} profile={profile} durationSec={duration} disabled={busy} onChange={(g) => editScene(i, { graphic: g })} /> : null}
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {generated ? <ShotListPanel ai={ai} env={env} /> : null}
          <LocalImagePanel ai={ai} images={deps.images ?? localImageApi} env={env} onAdopt={(next) => adopt(next, false)} />
          {generated ? (
            <GeminiVoicesPanel ai={ai} env={env} status={aiStatus} pollMs={1500} disabled={busy} onAdopt={(next) => adopt(next, false)} onStatus={refreshAiStatus} />
          ) : (
          <div className="card" data-testid="voices">
            <h3>5. Voices and audio</h3>
            {speakerRows.length === 0 ? <p className="small">No speaker is assigned in the selected treatment.</p> : null}
            {speakerRows.map((r) => (
              <div key={r.speakerId} className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }} data-testid={`speaker-${r.speakerId}`}>
                <div>
                  <b>{r.speakerId}</b> <span className="small">({r.languages.map((l) => (l === 'ar' ? 'Arabic' : l === 'en' ? 'English' : 'unknown language')).join(', ')})</span>
                  <div className="small">{r.message}</div>
                </div>
                {r.status === 'audio_supplied' || r.status === 'unavailable' ? (
                  <Tag kind={r.status === 'unavailable' ? 'warn' : 'accent'}>{r.status === 'unavailable' ? 'generation unavailable' : 'supplied recording'}</Tag>
                ) : (
                  <select
                    aria-label={`Voice for ${r.speakerId}`}
                    value={r.speakerId in speakerEdits ? speakerEdits[r.speakerId] ?? '' : r.voiceId ?? ''}
                    onChange={(e) => { setSpeakerEdits((m) => ({ ...m, [r.speakerId]: e.target.value || null })); setReviewed(false); }}
                    disabled={busy || r.options.length === 0}
                  >
                    <option value="">No voice</option>
                    {r.options.map((v) => <option key={v.id} value={v.id}>{v.speakerLabel}</option>)}
                  </select>
                )}
              </div>
            ))}
            <p className="small">
              Voices are the local sample voices reported by the capability check. They are robotic English samples, not natural speech.
              Arabic speech is not available here, so Arabic lines need imported approved audio (supply it at input, or add it in the editor).
            </p>
          </div>

          )}
            <DerivedRewritePanel
              ai={ai}
              env={env}
              disabled={unsaved || busy}
              onAdopt={(next) => {
                adopt(next);
                setReviewed(false);
                setNotice(next.derivedFrom ? 'Derived rewrite created. It needs your review before speech or apply. The original draft is unchanged.' : 'Review recorded.');
              }}
              onError={(e) => setError(errorView(e))}
            />
          {generated ? (
            <>
              <div className="card" data-testid="review">
                <h3>6. Review and apply</h3>
                <label className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={unsaved || busy} data-testid="review-confirm" />
                  I reviewed the selected treatment, its scene order, pictures, speakers and the unapproved narration.
                </label>
              </div>
              <GeneratedApplyPanel
                ai={ai}
                env={env}
                unsaved={unsaved}
                reviewed={reviewed}
                busy={busy}
                setBusy={setBusy}
                onOpenEditor={onOpenEditor}
                onNotice={(m) => setNotice(m)}
                onError={(e) => setError(errorView(e))}
              />
            </>
          ) : (
          <div className="card" data-testid="apply">
            <h3>6. Apply</h3>
            <p className="small">
              Apply creates a NEW project from the saved selection and opens it in the editor. It does not approve any audio.
              Generated speech is unapproved. A supplied recording stays as supplied and unapproved until you approve it in the editor.
              The reference project and existing library files are not changed.
            </p>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={unsaved || busy} data-testid="review-confirm" />
              I reviewed the selected treatment, its scene order, pictures and speakers.
            </label>
            {blockers.length > 0 ? (
              <ul className="small" data-testid="apply-blockers">
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            ) : null}
            <div className="row mt" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" disabled={busy || blockers.length > 0} onClick={() => void apply()} data-testid="apply-draft">
                {busy ? 'Working…' : 'Apply to a new project'}
              </button>
            </div>
            {applied ? <p className="small">Created {applied.projectId}.</p> : null}
          </div>
          )}
        </>
      ) : null}
    </div>
  );
};

const emptyEnv: FactoryDraftEnvelope = {
  draftId: '',
  revision: 0,
  status: 'blocked',
  generationMode: 'local_rules',
  speechOrderLocked: false,
  selectedTreatmentId: null,
  treatments: [],
  speakers: [],
  missing: [],
  warnings: [],
  appliedProjects: [],
  profile: { contentProfile: 'educational', format: 'landscape', channelBrandId: null },
  inputs: { audioAssetId: null, audioDurationSec: null, visualAssetIds: [], scriptSupplied: false, storyboardSupplied: false },
};

/** One applied project: opens it, and shows its timing status as the server reports it. */
const AppliedProjectRow: React.FC<{ client: FactoryClient; projectId: string; onOpen: (projectId: string) => void }> = ({ client, projectId, onOpen }) => {
  const [state, setState] = useState<{ label: string } | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setState(null);
    client
      .projectTiming(projectId)
      .then((t) => { if (alive) setState({ label: t.label }); })
      .catch(() => { if (alive) setState({ error: 'Timing status could not be loaded.' }); });
    return () => { alive = false; };
  }, [client, projectId]);
  return (
    <div style={{ marginTop: 4 }}>
      <button className="btn sm" onClick={() => onOpen(projectId)}>Open {projectId}</button>
      <span style={{ marginLeft: 8 }} data-testid="applied-timing">
        {state === null ? 'Checking timing…' : 'error' in state ? state.error : state.label}
      </span>
    </div>
  );
};

function speakerLabel(id: string | null): string {
  return id ?? 'no speaker';
}

/** Picture choices for a scene: the library's usable visuals, plus the scene's current asset even if it was removed. */
/** Server readiness for the saved state. Pending edits on screen are not yet judged by the server. */
function readinessLine(env: FactoryDraftEnvelope | null, s: FactoryDraftScene, unsaved: boolean): string {
  const r = env?.visualReadiness?.find((x) => x.sceneId === s.id);
  if (!r) return unsaved ? 'Save the selection to check this shot.' : 'Readiness not reported yet.';
  const label = r.state === 'ready' ? 'Ready' : r.state === 'needs_values' ? 'Needs values' : r.state === 'needs_asset' ? 'Needs an asset' : r.state === 'needs_runtime' ? 'Needs a runtime' : r.state === 'refused' ? 'Refused' : 'Legacy';
  return `${label}: ${r.reason}${unsaved ? ' (unsaved edits are not judged yet)' : ''}`;
}

function visualOptions(library: PlanLibraryItem[], current: string | null) {
  const list = library.filter((a) => isVisual(a) && usable(a));
  if (current && !list.some((a) => a.id === current)) return [...list, { id: current, name: `${current} (not in library)`, kind: 'image' }];
  return list;
}

const InputsSummary: React.FC<{ env: FactoryDraftEnvelope }> = ({ env }) => (
  <div className="small" style={{ marginTop: 6 }} data-testid="inputs-summary">
    Inputs: {env.inputs.scriptSupplied ? 'reviewed script' : env.inputs.storyboardSupplied ? 'storyboard' : 'no script (brief only)'}
    {env.inputs.audioAssetId ? ` · ready audio ${env.inputs.audioAssetId}${env.inputs.audioDurationSec ? ` (${env.inputs.audioDurationSec.toFixed(1)} s measured)` : ''}` : ' · no audio supplied'}
    {' · '}{env.inputs.visualAssetIds.length} picture(s) supplied
  </div>
);

const EngineStatus: React.FC<{ caps: FactoryCapabilities | null }> = ({ caps }) => {
  if (!caps) return <p className="small">Capabilities have not loaded.</p>;
  const en = speechStatusFor(caps, 'en');
  const ar = speechStatusFor(caps, 'ar');
  return (
    <ul className="small" data-testid="engine-status">
      <li>Text: {caps.text.mode === 'local_rules' ? 'local rules only (no semantic AI)' : caps.text.mode} — {caps.text.reason}</li>
      <li>Speech English: {en.available ? 'available' : 'unavailable'} — {en.reason}</li>
      <li>Speech Arabic: {ar.available ? 'available' : 'unavailable'} — {ar.reason}</li>
      <li>Pictures: {caps.image.available ? 'available' : 'unavailable'} — {caps.image.reason}</li>
      <li>Transcription: {caps.transcription.available ? 'available' : 'unavailable'} — {caps.transcription.reason}</li>
      {caps.speech.engines.map((e) => <li key={e.id}>Engine {e.id}: {e.available ? 'available' : 'not available'} — {e.reason}</li>)}
    </ul>
  );
};

const ErrorBanner: React.FC<{ view: ErrorView; onReload?: () => void }> = ({ view, onReload }) => (
  <div className="banner bad" role="alert" data-testid="plan-error">
    <b>{view.title}.</b> {view.detail}
    {view.missing.length > 0 ? (
      <ul>{view.missing.map((m, i) => <li key={`${m.kind}-${i}`}>{m.kind}{m.sceneId ? ` · ${m.sceneId}` : ''}: {m.reason}</li>)}</ul>
    ) : null}
    {view.next === 'reload' && onReload ? <div className="row mt"><button className="btn sm" onClick={onReload}>Reload draft</button></div> : null}
  </div>
);

const LibraryUpload: React.FC<{
  draft: { source: string; license: string };
  setDraft: (d: { source: string; license: string }) => void;
  onFile: (file: File, kind: 'audio' | 'visual') => void;
  busy: boolean;
  libraryError: string | null;
}> = ({ draft, setDraft, onFile, busy, libraryError }) => (
  <fieldset className="mt" data-testid="library-upload">
    <legend>Add a file to the library</legend>
    <div className="grid2">
      <label className="field"><span>Source (required)</span><input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} /></label>
      <label className="field"><span>Licence (required)</span><input value={draft.license} onChange={(e) => setDraft({ ...draft, license: e.target.value })} /></label>
    </div>
    <div className="row mt">
      <label className="btn sm">
        Upload audio
        <input type="file" accept="audio/*" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f, 'audio'); e.target.value = ''; }} />
      </label>
      <label className="btn sm">
        Upload picture or footage
        <input type="file" accept="image/*,video/*" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f, 'visual'); e.target.value = ''; }} />
      </label>
    </div>
    {libraryError ? <Banner kind="bad">{libraryError}</Banner> : null}
  </fieldset>
);
