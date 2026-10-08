const BASE = '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const hasBody = init?.body !== undefined && init?.body !== null;
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (!isForm && hasBody && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, {
    ...init,
    headers: isForm ? undefined : headers,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err: any = new Error(data?.error ?? data?.blockReason ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data as T;
}

export const api = {
  /* ── VS3: Voice & Audio (project-scoped, same `req` error contract) ── */
  voiceAudio: (id: string) => req<any>(`/api/projects/${id}/voice-audio`),
  uploadVoiceReference: (id: string, form: FormData) =>
    req<any>(`/api/projects/${id}/voice-audio/references`, { method: 'POST', body: form }),
  authorizeVoiceReference: (id: string, refId: string, body: { ownerConfirmed: true; statement: string; confirmedBy: string }) =>
    req<any>(`/api/projects/${id}/voice-audio/references/${refId}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  approveVoiceReference: (id: string, refId: string, body: { decision: 'approved' | 'rejected'; approver: string; rights?: unknown }) =>
    req<any>(`/api/projects/${id}/voice-audio/references/${refId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  removeVoiceReference: (id: string, refId: string, clearAssignments = false) =>
    req<any>(`/api/projects/${id}/voice-audio/references/${refId}${clearAssignments ? '?clearAssignments=true' : ''}`, {
      method: 'DELETE',
    }),
  setVoiceAssignments: (id: string, assignments: Array<{ speakerId: string; engine: string; referenceId?: string; presetVoiceId?: string }>) =>
    req<any>(`/api/projects/${id}/voice-audio/assignments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignments }),
    }),
  generateVoicePreview: (id: string) =>
    req<any>(`/api/projects/${id}/voice-audio/previews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  voiceAudioJob: (id: string, jobId: string) => req<any>(`/api/projects/${id}/voice-audio/jobs/${jobId}`),
  decideVoicePreview: (id: string, previewId: string, body: { decision: 'approved' | 'rejected'; approvedBy: string }) =>
    req<any>(`/api/projects/${id}/voice-audio/previews/${previewId}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),


  health: () => req<any>('/api/health'),
  variants: () => req<any>('/api/variants'),
  projects: () => req<any>('/api/projects'),
  project: (id: string) => req<any>(`/api/projects/${id}`),
  createProject: (input: unknown) => req<any>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id: string, input: unknown) => req<any>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteProject: (id: string) => req<any>(`/api/projects/${id}`, { method: 'DELETE' }),
  storyboard: (id: string, preserveEdits = true) =>
    req<any>(`/api/projects/${id}/storyboard`, { method: 'POST', body: JSON.stringify({ preserveEdits }) }),
  regenerate: (id: string) => req<any>(`/api/projects/${id}/regenerate`, { method: 'POST' }),
  patchScene: (id: string, sceneId: string, patch: unknown) =>
    req<any>(`/api/projects/${id}/scenes/${sceneId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  regenerateScene: (id: string, sceneId: string) =>
    req<any>(`/api/projects/${id}/regenerate-scene/${sceneId}`, { method: 'POST' }),
  patchCue: (id: string, cueId: string, patch: unknown) =>
    req<any>(`/api/projects/${id}/captions/${cueId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  recheckSimilarity: (id: string) => req<any>(`/api/projects/${id}/recheck-similarity`, { method: 'POST' }),
  qc: (id: string) => req<any>(`/api/projects/${id}/qc`),
  runQc: (id: string, body: unknown) => req<any>(`/api/projects/${id}/qc`, { method: 'POST', body: JSON.stringify(body) }),
  startExport: (id: string, body: unknown) => req<any>(`/api/projects/${id}/export`, { method: 'POST', body: JSON.stringify(body) }),
  job: (jobId: string) => req<any>(`/api/jobs/${jobId}`),
  assets: () => req<any>('/api/assets'),
  patchAsset: (id: string, patch: unknown) => req<any>(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAsset: (id: string) => req<any>(`/api/assets/${id}`, { method: 'DELETE' }),
  uploadAsset: (form: FormData) => req<any>('/api/assets', { method: 'POST', body: form }),
  history: () => req<any>('/api/history'),
  files: () => req<any>('/api/files'),
  targetAudio: (projectId: string) => req<any>(`/api/projects/${projectId}/target-audio`),
  uploadTargetAudio: (projectId: string, target: string, form: FormData) =>
    req<any>(`/api/projects/${projectId}/target-audio/${target}`, { method: 'POST', body: form }),
  deleteTargetAudio: (projectId: string, target: string) =>
    req<any>(`/api/projects/${projectId}/target-audio/${target}`, { method: 'DELETE' }),
  /* ---- VS4: narration imported from outside the app ---- */
  externalNarration: (projectId: string) => req<any>(`/api/projects/${projectId}/external-narration`),
  importExternalNarration: (projectId: string, target: string, form: FormData) =>
    req<any>(`/api/projects/${projectId}/target-audio/${target}/external`, { method: 'POST', body: form }),
  externalNarrationTarget: (projectId: string, target: string) =>
    req<any>(`/api/projects/${projectId}/target-audio/${target}/external`),
  externalNarrationApproval: (projectId: string, target: string, body: unknown) =>
    req<any>(`/api/projects/${projectId}/target-audio/${target}/external/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  externalNarrationAudioUrl: (projectId: string, target: string) =>
    `/api/projects/${projectId}/target-audio/${target}/external/audio`,
  externalNarrationTiming: (projectId: string, target: string) =>
    req<any>(`/api/projects/${projectId}/external-narration/timing/${target}`),
  externalDialogueCoverage: (projectId: string) =>
    req<any>(`/api/projects/${projectId}/external-narration/dialogue`),
  importExternalDialogueTurn: (projectId: string, form: FormData) =>
    req<any>(`/api/projects/${projectId}/external-narration/dialogue-turns`, { method: 'POST', body: form }),
  /* ---- production engine (Workstream D) ---- */
  production: (projectId: string) => req<any>(`/api/projects/${projectId}/production`),
  productionGenerate: (projectId: string) =>
    req<any>(`/api/projects/${projectId}/production/generate`, { method: 'POST' }),
  productionPatchScene: (projectId: string, target: string, sceneId: string, patch: unknown) =>
    req<any>(`/api/projects/${projectId}/production/scenes/${target}/${sceneId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  productionPatchTurn: (projectId: string, target: string, turnId: string, patch: unknown) =>
    req<any>(`/api/projects/${projectId}/production/turns/${target}/${turnId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  productionBindingAssets: (projectId: string) => req<any>(`/api/projects/${projectId}/production/assets`),
  productionSetBinding: (projectId: string, target: string, logicalRef: string, assetId: string) =>
    req<any>(`/api/projects/${projectId}/production/assets/${target}/${encodeURIComponent(logicalRef)}`, { method: 'PUT', body: JSON.stringify({ assetId }) }),
  productionClearBinding: (projectId: string, target: string, logicalRef: string) =>
    req<any>(`/api/projects/${projectId}/production/assets/${target}/${encodeURIComponent(logicalRef)}`, { method: 'DELETE' }),
  productionRerollScene: (projectId: string, target: string, sceneId: string) =>
    req<any>(`/api/projects/${projectId}/production/scenes/${target}/${sceneId}/reroll`, { method: 'POST' }),
  productionBuild: (projectId: string, body?: unknown) =>
    req<any>(`/api/projects/${projectId}/production/build`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  productionCaptions: (projectId: string, target: string) => req<any>(`/api/projects/${projectId}/production/captions/${target}`),
  productionPreview: (projectId: string) => req<any>(`/api/projects/${projectId}/production/preview`, { method: 'POST' }),
  productionExport: (projectId: string) => req<any>(`/api/projects/${projectId}/production/export`, { method: 'POST' }),
  productionJob: (projectId: string, jobId: string) => req<any>(`/api/projects/${projectId}/production/jobs/${jobId}`),
  productionHistory: () => req<any>('/api/production-history'),
};

export function videoUrl(videoId: string, rel: string) {
  return `${BASE}/output/${videoId}/${rel}`;
}

export function assetUrl(id: string) {
  return `${BASE}/media/asset/${id}`;
}

/** Output-root-relative artifact path -> served URL (production artifacts). */
export function outputUrl(relPath: string, download = false) {
  const clean = String(relPath).replace(/^\/+/, '');
  return `${BASE}/output/${clean}${download ? '?download=1' : ''}`;
}
