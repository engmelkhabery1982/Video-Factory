/**
 * BuildTrack Video Factory — production-native deliverables (Workstream D).
 *
 * The production final build must produce the SAME user-facing, non-video
 * deliverables the original MVP produced — but from the NEW production
 * authority, never from the legacy Storyboard:
 *
 *   ProjectInput + generated Scenarios + real production plans
 *     + actual Phase 6A asset resolutions + final target identities
 *       → publishing kit JSON
 *       → human-readable titles/description markdown
 *       → Long title alternatives / description / tags / pinned comment
 *       → Short metadata per generated Short
 *       → chapters derived from the production Long Scenario + plan
 *       → production Scenario JSON snapshots
 *       → asset provenance JSON + CSV (only really bound/used assets)
 *       → real thumbnails + contact sheets extracted from the finished MP4
 *       → product-kit manifest + checksums
 *       → production readiness QC
 *
 * Everything here is deterministic and derived from the same objects the
 * renderer used. Nothing re-renders video to make a still: thumbnails are
 * extracted from the completed MP4 with the existing ffmpeg media helpers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  description as buildDescription,
  pinnedComment as buildPinnedComment,
  shortsTitles,
  tags as buildTags,
  titleVariants,
  validateScenario,
  type Project,
  type ProjectInput,
  type Scenario,
} from '@buildtrack/core';
import type { Asset } from '@buildtrack/core';
import { ASSETS_DIR, OUTPUT_DIR } from './platform.js';
import { contactSheet, extractPoster } from './media.js';
import type { ProductionState, ProductionTargetId } from './production-state.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DeliverableFileRecord {
  /** kit-relative POSIX path */
  relPath: string;
  sizeBytes: number;
  sha256: string;
}

/** Integrity of the real asset FILE a provenance row points at (audit item G). */
export interface ProductionProvenanceIntegrity {
  algorithm: 'sha256';
  sha256: string;
  sizeBytes: number;
}

export interface ProductionProvenanceRow {
  assetId: string;
  name: string;
  kind: string;
  source: string;
  license: string;
  target: string;
  logicalRef: string;
  sceneIds: string[];
  /**
   * DURABLE media reference (audit item G): path of the real asset file
   * relative to the data root (`data/assets/...`), i.e. a file that still
   * resolves after the API process stops, after a restart on a different port
   * and after the data directory is moved as a whole.
   *
   * A per-job live URL such as `http://127.0.0.1:<port>/media/asset/<id>` is a
   * RUNTIME RENDER DIAGNOSTIC only and is deliberately never persisted into
   * the delivered product kit.
   */
  mediaRef: string | null;
  /** sha256 + size of the referenced file at kit-write time (null if unreadable) */
  integrity: ProductionProvenanceIntegrity | null;
  usage: string;
}

export interface ProductionReadinessFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  dimension: string;
  target?: string;
  message: string;
}

export interface ProductionReadinessDimension {
  dimension: string;
  status: 'pass' | 'warn' | 'fail' | 'not_applicable';
  detail: string;
}

export interface ProductionReadinessResult {
  schemaVersion: 1;
  at: string;
  kind: 'preview' | 'final';
  status: 'ready' | 'blocked' | 'incomplete';
  readyForProductionDelivery: boolean;
  dimensions: ProductionReadinessDimension[];
  findings: ProductionReadinessFinding[];
  /** semantic casting/style observation this production used for diversity */
  historyObservation: {
    source: 'production' | 'legacy-visual' | 'none';
    productionEntryCount: number;
    videoIds: string[];
    personaKeyCount: number;
    personas: Record<string, string>;
    styleFingerprint: string | null;
  };
  /**
   * Explicit replacement notes for legacy Storyboard QC dimensions that are no
   * longer structurally applicable to the production data model.
   */
  supersededLegacyQcDimensions: Array<{ legacyDimension: string; replacement: string }>;
}

export interface ProductionUsedInUpdate {
  assetId: string;
  videoId: string;
  sceneId: string;
  role: string;
}

export interface WriteProductionDeliverablesInput {
  project: Project;
  state: ProductionState;
  kind: 'preview' | 'final';
  /** plans actually built/rendered for this run */
  plans: Array<{
    target: ProductionTargetId;
    scenario: Scenario;
    plan: { scenes: Array<{ sceneId: string; captionCues?: unknown[]; audioRefs?: Array<{ path?: string; sourcePath?: string }> }>; width?: number; height?: number };
    mediaMap: Record<string, string>;
    resolution: {
      bindings: Array<{
        assetRef: string;
        resolved: boolean;
        assetId: string | null;
        /** Asset record; `path`/`sizeBytes`/`fileName` are the durable file identity (audit item G). */
        asset: { id: string; name: string; kind: string; source: string; license: string; path: string; fileName?: string; sizeBytes?: number } | null;
        /**
         * Per-job live URL used by the renderer (`http://127.0.0.1:<port>/media/asset/<id>`).
         * RUNTIME DIAGNOSTIC ONLY — never persisted into the product kit (audit item G).
         */
        renderUrl: string | null;
        required: boolean;
        usages: Array<{ sceneId: string }>;
      }>;
    };
  }>;
  /** targetId -> output-root-relative video path actually produced */
  outputs: Partial<Record<ProductionTargetId, string>>;
  /** output-root-relative Phase 6D package root (final only) */
  packageRelPath?: string | null;
  /** package READY state from Phase 6D (final only) */
  packageStatus?: string | null;
  /** package findings (final only) */
  packageFindings?: Array<{ severity: string; code: string; message: string }>;
  /** persona/style observation of this production (from the engine) */
  historyObservation: ProductionReadinessResult['historyObservation'];
  onLog?: (message: string) => void;
}

export interface WriteProductionDeliverablesResult {
  /** absolute product-kit root */
  kitRoot: string;
  /** output-root-relative product-kit root (POSIX) */
  kitRelPath: string;
  files: DeliverableFileRecord[];
  readiness: ProductionReadinessResult;
  usedInUpdates: ProductionUsedInUpdate[];
  provenance: ProductionProvenanceRow[];
}

/* ------------------------------------------------------------------ */
/*  Path safety                                                        */
/* ------------------------------------------------------------------ */

/** Output-root-relative POSIX path, rejecting anything outside OUTPUT_DIR. */
export function outputRelativePath(file: string): string {
  const root = path.resolve(OUTPUT_DIR);
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `production artifact path must stay inside the output root (${root}); received '${file}'`,
    );
  }
  return rel.split(path.sep).join('/');
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ------------------------------------------------------------------ */
/*  Metadata (production-native)                                       */
/* ------------------------------------------------------------------ */

/** Chapter list from the production Long Scenario scenes + the real plan timing. */
function productionChapters(longScenario: Scenario | null, scenes: Array<{ sceneId: string; captionCues?: unknown[] }>): Array<{ time: string; label: string }> {
  const out: Array<{ time: string; label: string }> = [];
  if (!longScenario) return out;
  let at = 0;
  for (const scene of longScenario.scenes) {
    const planScene = scenes.find((s) => s.sceneId === scene.id);
    const cues = (planScene?.captionCues ?? []) as Array<{ startTimeSeconds?: number; endTimeSeconds?: number }>;
    const starts = cues.map((c) => Number(c.startTimeSeconds ?? 0)).filter((n) => Number.isFinite(n));
    const ends = cues.map((c) => Number(c.endTimeSeconds ?? 0)).filter((n) => Number.isFinite(n));
    const start = starts.length > 0 ? Math.min(...starts) : at;
    const end = ends.length > 0 ? Math.max(...ends) : start;
    const mm = Math.floor(start / 60);
    const ss = Math.floor(start % 60);
    out.push({ time: `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, label: scene.title || scene.narrativePurpose });
    at = Math.max(at, end);
  }
  return out;
}

function buildProductionPublishingKit(input: {
  project: Project;
  targets: Array<{ target: ProductionTargetId; scenario: Scenario; plan: { scenes: Array<{ sceneId: string; captionCues?: unknown[] }> } }>;
  captionsByTarget: Record<string, string[]>;
}) {
  const projectInput: ProjectInput = input.project.meta.input;
  const long = input.targets.find((t) => t.target === 'long') ?? null;
  const shorts = input.targets.filter((t) => t.target !== 'long');
  const titles = titleVariants(projectInput);
  return {
    schema: 'production-publishing-kit.v1',
    videoId: projectInput.videoId,
    authority: 'production (ProjectInput + generated Scenarios + production plans)',
    topic: projectInput.topic,
    language: projectInput.outputLanguage,
    brand: projectInput.brandPreset,
    product: projectInput.productName,
    long: long
      ? {
          scenarioId: long.scenario.metadata.id,
          titles: titles.map((t) => t),
          titleAlternatives: titles.map((t) => t),
          description: buildDescription(projectInput),
          tags: buildTags(projectInput),
          pinnedComment: buildPinnedComment(projectInput, 'full video'),
          cta: projectInput.cta,
          chapters: productionChapters(long.scenario, long.plan.scenes),
          captionFiles: input.captionsByTarget.long ?? [],
        }
      : null,
    shorts: shorts.map((s) => {
      const declared = shortsTitles(projectInput).find((x) => x.id === s.target) ?? null;
      return {
        id: s.target,
        scenarioId: s.scenario.metadata.id,
        title: declared?.title ?? s.scenario.metadata.title,
        description: declared?.description ?? buildDescription(projectInput),
        pinnedComment: declared?.pinned ?? buildPinnedComment(projectInput, `${s.target} (production)`),
        captionFiles: input.captionsByTarget[s.target] ?? [],
      };
    }),
    cta: projectInput.cta,
  };
}

function productionMarkdown(kit: ReturnType<typeof buildProductionPublishingKit>, input: ProjectInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.topic}`);
  lines.push('');
  lines.push('> Production authority: generated Scenarios + production plans (no legacy Storyboard).');
  lines.push('');
  if (kit.long) {
    lines.push('## Long');
    lines.push('');
    lines.push('### Title alternatives');
    for (const t of kit.long.titleAlternatives) lines.push(`- ${t}`);
    lines.push('');
    lines.push('### Description');
    lines.push('');
    lines.push(kit.long.description);
    lines.push('');
    lines.push('### Tags');
    lines.push('');
    lines.push(kit.long.tags.join(', '));
    lines.push('');
    lines.push('### Pinned comment / CTA');
    lines.push('');
    lines.push(kit.long.pinnedComment);
    lines.push('');
    if (kit.long.chapters.length > 0) {
      lines.push('### Chapters');
      lines.push('');
      for (const c of kit.long.chapters) lines.push(`- ${c.time} ${c.label}`);
      lines.push('');
    }
  }
  for (const s of kit.shorts) {
    lines.push(`## ${s.id}`);
    lines.push('');
    lines.push(`- title: ${s.title}`);
    lines.push(`- pinned comment: ${s.pinnedComment}`);
    lines.push('');
    lines.push(s.description);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/*  Provenance                                                         */
/* ------------------------------------------------------------------ */

/**
 * Data-root relative durable path of a real asset file. The asset record's
 * `path` is already relative to `data/assets`; the `assets/` prefix is added so
 * the reference is unambiguous against the whole data root.
 */
function assetMediaRef(assetRelPath: string): string {
  return `assets/${String(assetRelPath).split(path.sep).join('/')}`;
}

/** sha256 + size of the real asset file, or null when it cannot be read. */
function assetIntegrity(assetRelPath: string): ProductionProvenanceIntegrity | null {
  try {
    const abs = path.resolve(ASSETS_DIR, String(assetRelPath));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return { algorithm: 'sha256', sha256: sha256File(abs), sizeBytes: fs.statSync(abs).size };
  } catch {
    return null;
  }
}

function buildProvenance(input: {
  project: Project;
  targets: WriteProductionDeliverablesInput['plans'];
}): ProductionProvenanceRow[] {
  const rows: ProductionProvenanceRow[] = [];
  const seen = new Set<string>();
  for (const target of input.targets) {
    for (const binding of target.resolution.bindings) {
      if (!binding.resolved || !binding.assetId || !binding.asset) continue;
      const key = `${target.target}|${binding.assetRef}|${binding.assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        assetId: binding.asset.id,
        name: binding.asset.name,
        kind: binding.asset.kind,
        source: binding.asset.source,
        license: binding.asset.license,
        target: target.target,
        logicalRef: binding.assetRef,
        sceneIds: [...new Set(binding.usages.map((u) => u.sceneId))].sort(),
        mediaRef: assetMediaRef(binding.asset.path),
        integrity: assetIntegrity(binding.asset.path),
        usage: binding.required ? 'required screen insert (resolved)' : 'optional screen insert (resolved)',
      });
    }
  }
  // Source references are provenance of the CONTENT, never fake assets.
  for (const ref of input.project.meta.input.sourceReferences ?? []) {
    rows.push({
      assetId: 'source-reference',
      name: ref,
      kind: 'source reference',
      source: 'operator supplied',
      license: 'see reference',
      target: 'all',
      logicalRef: '',
      sceneIds: [],
      mediaRef: null,
      integrity: null,
      usage: 'content provenance only (not a media asset)',
    });
  }
  return rows;
}

export function provenanceToCsv(rows: readonly ProductionProvenanceRow[]): string {
  const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const header = 'asset_id,name,kind,source,license,target,logical_ref,scene_ids,media_ref,integrity_sha256,size_bytes,usage';
  return [
    header,
    ...rows.map((r) =>
      [
        r.assetId,
        r.name,
        r.kind,
        r.source,
        r.license,
        r.target,
        r.logicalRef,
        r.sceneIds.join(' '),
        r.mediaRef ?? '',
        r.integrity?.sha256 ?? '',
        r.integrity?.sizeBytes ?? '',
        r.usage,
      ]
        .map(esc)
        .join(','),
    ),
  ].join('\n');
}

/** Real final-use updates for Asset.usedIn (deduplicated, deterministic). */
export function usedInUpdatesFromPlans(
  videoId: string,
  plans: WriteProductionDeliverablesInput['plans'],
): ProductionUsedInUpdate[] {
  const out: ProductionUsedInUpdate[] = [];
  const seen = new Set<string>();
  for (const target of plans) {
    for (const binding of target.resolution.bindings) {
      if (!binding.resolved || !binding.assetId) continue;
      for (const sceneId of [...new Set(binding.usages.map((u) => u.sceneId))].sort()) {
        const key = `${binding.assetId}|${videoId}|${sceneId}|screen_insert`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ assetId: binding.assetId, videoId, sceneId, role: 'screen_insert' });
      }
    }
  }
  return out;
}

/**
 * Merge real final-use updates into the Asset Library records.
 *
 * Deterministic and idempotent: an existing `{videoId, sceneId, role}` usage is
 * never duplicated, and the caller must only invoke this after a SUCCESSFUL
 * final production with no blocking readiness finding (the guard lives in the
 * production engine, which knows whether the build actually succeeded).
 */
export function mergeUsedInUpdates(
  assets: readonly Asset[],
  updates: readonly ProductionUsedInUpdate[],
): { assets: Asset[]; changed: number } {
  const byId = new Map(assets.map((a) => [a.id, { ...a, usedIn: [...(a.usedIn ?? [])] }]));
  let changed = 0;
  for (const update of updates) {
    const asset = byId.get(update.assetId);
    if (!asset) continue;
    const existing = asset.usedIn ?? [];
    if (existing.some((u) => u.videoId === update.videoId && u.sceneId === update.sceneId && u.role === update.role)) continue;
    asset.usedIn = [...existing, { videoId: update.videoId, sceneId: update.sceneId, role: update.role }];
    changed += 1;
  }
  return { assets: assets.map((a) => byId.get(a.id) ?? a), changed };
}

/* ------------------------------------------------------------------ */
/*  Readiness QC                                                       */
/* ------------------------------------------------------------------ */

export function buildProductionReadiness(input: WriteProductionDeliverablesInput): ProductionReadinessResult {
  const findings: ProductionReadinessFinding[] = [];
  const dimensions: ProductionReadinessDimension[] = [];

  /* 1. Scenario validation */
  let scenarioErrors = 0;
  for (const target of input.plans) {
    const report = validateScenario(target.scenario);
    if (!report.valid) {
      scenarioErrors += 1;
      for (const f of report.findings.filter((x) => x.severity === 'error')) {
        findings.push({ severity: 'error', code: 'READINESS_SCENARIO_INVALID', dimension: 'scenario_validation', target: target.target, message: f.message });
      }
    }
  }
  dimensions.push({
    dimension: 'scenario_validation',
    status: scenarioErrors > 0 ? 'fail' : 'pass',
    detail: scenarioErrors > 0 ? `${scenarioErrors} target(s) failed validateScenario` : `all ${input.plans.length} generated Scenario(s) valid`,
  });

  /* 2. Generation findings */
  const genErrors = input.state.generationFindings.filter((f) => f.severity === 'error');
  for (const f of genErrors) {
    findings.push({ severity: 'error', code: `READINESS_${f.code}`, dimension: 'generation_findings', target: f.target, message: f.message });
  }
  dimensions.push({
    dimension: 'generation_findings',
    status: genErrors.length > 0 ? 'fail' : 'pass',
    detail: genErrors.length > 0 ? `${genErrors.length} error-level generation finding(s)` : `${input.state.generationFindings.length} generation finding(s), none error-level`,
  });

  /* 3. Stale-input status */
  const stale = input.state.inputFingerprint !== null && input.state.status === 'needs_regeneration';
  if (stale) findings.push({ severity: 'error', code: 'READINESS_STALE_INPUT', dimension: 'stale_input', message: 'ProjectInput changed after generation; regenerate before export.' });
  dimensions.push({ dimension: 'stale_input', status: stale ? 'fail' : 'pass', detail: stale ? 'state is stale against ProjectInput' : 'state matches the current ProjectInput' });

  /* 4. Unresolved REQUIRED assets */
  const unresolvedRequired: string[] = [];
  for (const target of input.plans) {
    for (const b of target.resolution.bindings) {
      if (b.required && !b.resolved) unresolvedRequired.push(`${target.target}:${b.assetRef}`);
    }
  }
  for (const ref of unresolvedRequired) findings.push({ severity: 'error', code: 'READINESS_REQUIRED_ASSET_UNRESOLVED', dimension: 'required_assets', message: `required asset ref ${ref} is unresolved` });
  dimensions.push({
    dimension: 'required_assets',
    status: unresolvedRequired.length > 0 ? 'fail' : 'pass',
    detail: unresolvedRequired.length > 0 ? `${unresolvedRequired.length} unresolved REQUIRED ref(s)` : 'all required asset refs resolved',
  });

  /* 5. Phase 5/6 plan validity: geometry + caption plan + audio presence */
  const geometryProblems: string[] = [];
  const captionProblems: string[] = [];
  const audioProblems: string[] = [];
  for (const target of input.plans) {
    const expect = target.target === 'long' ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 };
    if (target.plan.width !== expect.w || target.plan.height !== expect.h) {
      geometryProblems.push(`${target.target}: ${target.plan.width}x${target.plan.height} (expected ${expect.w}x${expect.h})`);
    }
    const cueTotal = target.plan.scenes.reduce((n, s) => n + (s.captionCues?.length ?? 0), 0);
    if (cueTotal === 0) captionProblems.push(`${target.target}: no reconciled caption cues`);
    for (const scene of target.plan.scenes) {
      const refs = scene.audioRefs ?? [];
      if (refs.length === 0) audioProblems.push(`${target.target}/${scene.sceneId}: no production audio ref`);
    }
  }
  for (const p of geometryProblems) findings.push({ severity: 'error', code: 'READINESS_TARGET_GEOMETRY', dimension: 'target_geometry', message: p });
  for (const p of captionProblems) findings.push({ severity: 'error', code: 'READINESS_CAPTION_PLAN', dimension: 'caption_plan', message: p });
  for (const p of audioProblems) findings.push({ severity: 'error', code: 'READINESS_PRODUCTION_AUDIO', dimension: 'production_audio', message: p });
  dimensions.push({ dimension: 'target_geometry', status: geometryProblems.length ? 'fail' : 'pass', detail: geometryProblems.join('; ') || 'every target is at its authoritative geometry' });
  dimensions.push({ dimension: 'caption_plan', status: captionProblems.length ? 'fail' : 'pass', detail: captionProblems.join('; ') || 'every target carries reconciled caption cues' });
  dimensions.push({ dimension: 'production_audio', status: audioProblems.length ? 'fail' : 'pass', detail: audioProblems.join('; ') || 'every scene carries production audio refs' });

  /* 6. Phase 6D technical QC + final package READY state */
  if (input.kind === 'final') {
    const pkgFindings = input.packageFindings ?? [];
    for (const f of pkgFindings.filter((x) => x.severity === 'error')) {
      findings.push({ severity: 'error', code: `READINESS_PACKAGE_${f.code}`, dimension: 'phase6d_package', message: f.message });
    }
    const ready = input.packageStatus === 'ready';
    dimensions.push({
      dimension: 'phase6d_package',
      status: ready ? 'pass' : 'fail',
      detail: ready ? 'Phase 6D package status is ready' : `Phase 6D package status is '${input.packageStatus ?? 'unknown'}'`,
    });
    const finalOutputs = Object.entries(input.outputs ?? {});
    const missing = finalOutputs.filter(([, rel]) => {
      try {
        const abs = path.resolve(OUTPUT_DIR, rel as string);
        return !fs.existsSync(abs) || fs.statSync(abs).size === 0;
      } catch {
        return true;
      }
    });
    for (const [target] of missing) findings.push({ severity: 'error', code: 'READINESS_TARGET_OUTPUT_MISSING', dimension: 'final_outputs', target, message: `rendered target ${target} is missing or zero bytes` });
    dimensions.push({
      dimension: 'final_outputs',
      status: missing.length ? 'fail' : 'pass',
      detail: missing.length ? `missing/zero-byte targets: ${missing.map(([t]) => t).join(', ')}` : `${finalOutputs.length} target output(s) present and non-zero`,
    });
  } else {
    dimensions.push({ dimension: 'phase6d_package', status: 'not_applicable', detail: 'preview builds carry no Phase 6D package' });
    dimensions.push({ dimension: 'final_outputs', status: 'not_applicable', detail: 'preview builds are not final delivery' });
  }

  /* 7. Semantic style/casting history observation used for diversity */
  dimensions.push({
    dimension: 'style_casting_history',
    status: 'pass',
    detail:
      input.historyObservation.source === 'production'
        ? `${input.historyObservation.productionEntryCount} production observation(s) consumed (${input.historyObservation.videoIds.join(', ')})`
        : `history source: ${input.historyObservation.source}`,
  });

  const errors = findings.filter((f) => f.severity === 'error');
  const status: ProductionReadinessResult['status'] = errors.length > 0 ? 'blocked' : input.kind === 'final' ? 'ready' : 'incomplete';

  return {
    schemaVersion: 1,
    at: new Date().toISOString(),
    kind: input.kind,
    status,
    readyForProductionDelivery: input.kind === 'final' && errors.length === 0 && input.packageStatus === 'ready',
    dimensions,
    findings,
    historyObservation: input.historyObservation,
    // Legacy Storyboard QC dimensions are NOT silently dropped: each one is
    // mapped to the production authority that replaced it.
    supersededLegacyQcDimensions: [
      { legacyDimension: 'storyboard static QC (Scene[] variants/transitions)', replacement: 'Scenario validation + production plan validation' },
      { legacyDimension: 'legacy caption QC (storyboard.captions retiming)', replacement: 'reconciled production caption plan (audio authority)' },
      { legacyDimension: 'targetAudio presence QC', replacement: 'production audio refs per scene (Kokoro per-turn WAVs)' },
      { legacyDimension: 'storyboard similarity score', replacement: 'semantic style/casting history observation (scenario-style-history)' },
      { legacyDimension: 'renderTarget/mux QC on the legacy video path', replacement: 'Phase 6D per-target technical QC on the packaged media' },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Thumbnails + contact sheets (extracted from the finished MP4)      */
/* ------------------------------------------------------------------ */

/**
 * Deterministic thumbnail timestamps from the Long plan: one position inside
 * each of three evenly spaced meaningful scenes (never the first/last frame,
 * never a transition-only position).
 */
export function thumbnailTimestamps(longPlanScenes: ReadonlyArray<{ sceneId: string; captionCues?: unknown[] }>, count = 3): number[] {
  const usable = longPlanScenes
    .map((s) => {
      const cues = (s.captionCues ?? []) as Array<{ startTimeSeconds?: number; endTimeSeconds?: number }>;
      const starts = cues.map((c) => Number(c.startTimeSeconds ?? 0)).filter((n) => Number.isFinite(n));
      const ends = cues.map((c) => Number(c.endTimeSeconds ?? 0)).filter((n) => Number.isFinite(n));
      if (starts.length === 0 || ends.length === 0) return null;
      const start = Math.min(...starts);
      const end = Math.max(...ends);
      if (!(end > start)) return null;
      return start + (end - start) * 0.4;
    })
    .filter((n): n is number => n !== null);
  if (usable.length === 0) return [];
  const picked: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = usable.length === 1 ? 0 : Math.round((i / (count - 1)) * (usable.length - 1));
    picked.push(usable[idx]);
  }
  return [...new Set(picked.map((n) => Math.round(n * 100) / 100))];
}

async function writeThumbnailsAndSheets(input: {
  videoId: string;
  kitRoot: string;
  outputs: Partial<Record<ProductionTargetId, string>>;
  longPlanScenes: ReadonlyArray<{ sceneId: string; captionCues?: unknown[] }>;
  log: (m: string) => void;
}): Promise<{ images: Array<{ name: string; at: number | null }> }> {
  const images: Array<{ name: string; at: number | null }> = [];
  const longRel = input.outputs.long;
  if (!longRel) return { images };
  const longFile = path.resolve(OUTPUT_DIR, longRel);
  if (!fs.existsSync(longFile) || fs.statSync(longFile).size === 0) return { images };

  const thumbDir = path.join(input.kitRoot, 'thumbnails');
  fs.mkdirSync(thumbDir, { recursive: true });
  const stamps = thumbnailTimestamps(input.longPlanScenes, 3);
  for (let i = 0; i < stamps.length; i++) {
    const out = path.join(thumbDir, `long_thumb_${String(i + 1).padStart(2, '0')}.jpg`);
    await extractPoster(longFile, out, stamps[i]);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      images.push({ name: path.join('thumbnails', path.basename(out)).replace(/\\/g, '/'), at: stamps[i] });
    } else {
      input.log(`thumbnail candidate ${i + 1} produced no bytes (${stamps[i]}s)`);
    }
  }

  const sheetsDir = path.join(input.kitRoot, 'contact_sheets');
  fs.mkdirSync(sheetsDir, { recursive: true });
  const longSheet = path.join(sheetsDir, 'long.jpg');
  await contactSheet({ videoFile: longFile, outFile: longSheet });
  images.push({ name: 'contact_sheets/long.jpg', at: null });

  // The accepted Short's own contact sheet, if the Short was part of this build.
  const shortRel = input.outputs.short_1;
  if (shortRel) {
    const shortFile = path.resolve(OUTPUT_DIR, shortRel);
    if (fs.existsSync(shortFile) && fs.statSync(shortFile).size > 0) {
      const shortSheet = path.join(sheetsDir, 'short_1.jpg');
      await contactSheet({ videoFile: shortFile, outFile: shortSheet });
      images.push({ name: 'contact_sheets/short_1.jpg', at: null });
    }
  }
  return { images };
}

/* ------------------------------------------------------------------ */
/*  Writer                                                             */
/* ------------------------------------------------------------------ */

/**
 * Write the production product kit for a completed production build.
 *
 * The kit is SEPARATE from the deterministic Phase 6D package (which keeps its
 * own manifest/checksums untouched); the kit carries its own manifest and
 * checksums, and the build result links both.
 */
export async function writeProductionDeliverables(
  input: WriteProductionDeliverablesInput,
): Promise<WriteProductionDeliverablesResult> {
  const log = input.onLog ?? (() => {});
  const videoId = input.project.meta.input.videoId;
  const kitRelPath = `${videoId}/production-kit`;
  const kitRoot = path.resolve(OUTPUT_DIR, kitRelPath);
  fs.mkdirSync(kitRoot, { recursive: true });

  /* ── caption file references (kit-relative, from the Phase 6D package when present) ── */
  const captionsByTarget: Record<string, string[]> = {};
  for (const target of input.plans) {
    captionsByTarget[target.target] = ['.srt', '.vtt', '.json'].map((ext) =>
      input.packageRelPath ? `${input.packageRelPath}/${target.target === 'long' ? 'long' : `shorts/${target.target}`}/captions${ext}` : `captions/${videoId}_${target.target}${ext}`,
    );
  }

  /* ── metadata deliverables ─────────────────────────────────────── */
  const publishingKit = buildProductionPublishingKit({
    project: input.project,
    targets: input.plans.map((p) => ({ target: p.target, scenario: p.scenario, plan: p.plan })),
    captionsByTarget,
  });
  const files: DeliverableFileRecord[] = [];
  const writeFile = (rel: string, contents: string) => {
    const abs = path.join(kitRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf8');
    files.push({ relPath: rel.split(path.sep).join('/'), sizeBytes: fs.statSync(abs).size, sha256: sha256File(abs) });
  };

  writeFile('publishing_kit.json', `${JSON.stringify(publishingKit, null, 2)}\n`);
  writeFile('titles_and_description.md', productionMarkdown(publishingKit, input.project.meta.input));

  for (const target of input.plans) {
    writeFile(`scenarios/${target.target}.json`, `${JSON.stringify(target.scenario, null, 2)}\n`);
  }

  const provenance = buildProvenance({ project: input.project, targets: input.plans });
  writeFile('asset_provenance.json', `${JSON.stringify(provenance, null, 2)}\n`);
  writeFile('asset_provenance.csv', `${provenanceToCsv(provenance)}\n`);

  /* ── readiness QC ──────────────────────────────────────────────── */
  const readiness = buildProductionReadiness(input);
  writeFile('readiness.json', `${JSON.stringify(readiness, null, 2)}\n`);

  /* ── thumbnails + contact sheets (final only, extracted from the MP4) ── */
  if (input.kind === 'final' && input.outputs.long) {
    try {
      const longPlan = input.plans.find((p) => p.target === 'long');
      const { images } = await writeThumbnailsAndSheets({
        videoId,
        kitRoot,
        outputs: input.outputs,
        longPlanScenes: longPlan?.plan.scenes ?? [],
        log,
      });
      for (const image of images) {
        const abs = path.join(kitRoot, image.name);
        if (!fs.existsSync(abs)) continue;
        files.push({ relPath: image.name, sizeBytes: fs.statSync(abs).size, sha256: sha256File(abs) });
      }
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      log(`thumbnail/contact-sheet extraction failed: ${message}`);
      readiness.findings.push({
        severity: 'error',
        code: 'READINESS_MEDIA_STILLS_FAILED',
        dimension: 'thumbnails_contact_sheets',
        message: `thumbnail/contact-sheet extraction failed: ${message.slice(0, 300)}`,
      });
      readiness.status = 'blocked';
      readiness.readyForProductionDelivery = false;
      writeFile('readiness.json', `${JSON.stringify(readiness, null, 2)}\n`);
    }
  }

  /* ── kit manifest + checksums ──────────────────────────────────── */
  const manifest = {
    schema: 'production-product-kit.v1',
    videoId,
    kind: input.kind,
    createdAt: new Date().toISOString(),
    authority: 'production (Scenario → production audio → Phase 5 → Phase 6A → Phase 6C → Phase 6D)',
    phase6dPackage: input.packageRelPath ?? null,
    phase6dPackageStatus: input.packageStatus ?? null,
    assetProvenance: {
      mediaRefBase: 'data',
      integrity: 'sha256 of the referenced asset file at kit-write time',
      liveUrlPolicy:
        'per-job loopback media URLs (API host and port of the running render job) are runtime render diagnostics and are never written into this kit',
    },
    readiness: { status: readiness.status, readyForProductionDelivery: readiness.readyForProductionDelivery },
    files: files.map((f) => f.relPath).sort(),
  };
  writeFile('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  writeFile(
    'checksums.sha256',
    `${files
      .slice()
      .sort((a, b) => (a.relPath < b.relPath ? -1 : 1))
      .map((f) => `${f.sha256}  ${f.relPath}`)
      .join('\n')}\n`,
  );

  return {
    kitRoot,
    kitRelPath,
    files,
    readiness,
    usedInUpdates: usedInUpdatesFromPlans(videoId, input.plans),
    provenance,
  };
}
