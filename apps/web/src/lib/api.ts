const BASE = '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: init?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
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
};

export function videoUrl(videoId: string, rel: string) {
  return `${BASE}/output/${videoId}/${rel}`;
}

export function assetUrl(id: string) {
  return `${BASE}/media/asset/${id}`;
}
