import fs from 'node:fs';
import path from 'node:path';
import {
  appendHistory,
  buildStoryboard,
  emptyHistory,
  getBrandPreset,
  migrateProject,
  PROJECT_SCHEMA_VERSION,
  type SceneTiming,
  type ShortId,
  type HistoryEntry,
  type Project,
  type ProjectInput,
  type ProjectMeta,
  type Storyboard,
  type VisualHistory,
} from '@buildtrack/core';
import { HISTORY_FILE, OUTPUT_DIR, PROJECTS_DIR, ensureDirs, projectAssetDir, projectDir, projectFile } from './platform.js';

/** One folder per project, re-openable and re-exportable later. */

export function loadHistory(): VisualHistory {
  ensureDirs();
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as VisualHistory;
      return raw?.videos ? raw : emptyHistory();
    }
  } catch {
    /* corrupted history must never block the app */
  }
  return emptyHistory();
}

export function saveHistory(h: VisualHistory) {
  ensureDirs();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2), 'utf8');
}

export function listProjects(): string[] {
  ensureDirs();
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((d) => fs.existsSync(path.join(PROJECTS_DIR, d, 'project.json')))
    .sort();
}

export function projectExists(videoId: string) {
  return fs.existsSync(projectFile(videoId));
}

export function saveProject(project: Project) {
  ensureDirs();
  const dir = projectDir(project.meta.input.videoId);
  fs.mkdirSync(projectAssetDir(project.meta.input.videoId), { recursive: true });
  fs.writeFileSync(projectFile(project.meta.input.videoId), JSON.stringify(project, null, 2), 'utf8');
  // mirror to the output tree so the deliverable folder is always self-contained
  const out = path.join(OUTPUT_DIR, project.meta.input.videoId);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'project.json'), JSON.stringify(project, null, 2), 'utf8');
  return dir;
}

export function loadProject(videoId: string): Project | null {
  const f = projectFile(videoId);
  if (!fs.existsSync(f)) return null;
  // explicit, additive schema upgrade: v1 projects (one project-wide
  // voiceover/caption track) load unchanged and gain per-Short captions
  return migrateProject(JSON.parse(fs.readFileSync(f, 'utf8')) as Project);
}

export function newProject(input: ProjectInput): Project {
  const brand = getBrandPreset(input.brandPreset);
  const meta: ProjectMeta = {
    input,
    brand,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
  };
  const storyboard: Storyboard = {
    videoId: input.videoId,
    createdAt: new Date().toISOString(),
    brand,
    long: { scenes: [], totalDuration: 0, endScreenReserveSeconds: 8 },
    shorts: [],
    captions: [],
    segments: [],
    warnings: [],
    similarity: null,
  };
  return { schemaVersion: PROJECT_SCHEMA_VERSION, meta, storyboard, artifacts: [], qc: [] };
}

export interface GenerateOpts {
  audioDuration?: number | null;
  /** each Short's own narration duration; never the Long's */
  shortAudioDurations?: Partial<Record<ShortId, number | null>>;
  shortSceneTimings?: Partial<Record<ShortId, SceneTiming[] | null>>;
  assetIds?: string[];
  hasMedia?: boolean;
  /** keep locked / user-edited scenes exactly as they are */
  preserveEdits?: boolean;
}

export function generateStoryboard(project: Project, history: VisualHistory, opts: GenerateOpts = {}) {
  const built = buildStoryboard({
    input: project.meta.input,
    history,
    audioDuration: opts.audioDuration ?? null,
    shortAudioDurations: opts.shortAudioDurations ?? {},
    shortSceneTimings: opts.shortSceneTimings ?? {},
    assetIds: opts.assetIds ?? [],
    hasMedia: opts.hasMedia,
  });

  const next: Storyboard = {
    videoId: built.videoId,
    createdAt: built.createdAt,
    brand: built.brand,
    long: built.long,
    shorts: built.shorts,
    captions: built.captions,
    shortCaptions: built.shortCaptions ?? {},
    segments: built.segments,
    warnings: built.warnings,
    similarity: built.similarity,
  };

  if (opts.preserveEdits) {
    // restore user decisions: locked scenes keep their variant, timing and copy
    const prev = project.storyboard;
    const prevByIndex = new Map(prev.long.scenes.map((s) => [s.index, s]));
    next.long.scenes = next.long.scenes.map((s, i) => {
      const old = prev.long.scenes.find((x) => x.id === s.id) ?? prevByIndex.get(i);
      if (!old) return s;
      if (!old.locked && !old.userEdited) return s;
      return { ...s, variant: old.variant, background: old.background, transitionIn: old.transitionIn, textPosition: old.textPosition, duration: old.duration, content: old.content, assetIds: old.assetIds, locked: old.locked, userEdited: true };
    });
  }

  const nextProject: Project = {
    ...project,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    storyboard: next,
    meta: { ...project.meta, updatedAt: new Date().toISOString(), status: 'storyboarded' },
  };
  saveProject(nextProject);

  const entry: HistoryEntry = (built as unknown as { historyEntry: HistoryEntry }).historyEntry;
  saveHistory(appendHistory(history, entry));
  return nextProject;
}
