import fs from 'node:fs';
import path from 'node:path';
import {
  buildReport,
  captionQc,
  captionsByTarget,
  captionsForTarget,
  planTargets,
  targetNarration,
  canExport,
  keyNumberFindings,
  mediaQc,
  provenance,
  staticQc,
  shortKeyNumberFindings,
  targetStaticQc,
  technicalQc,
  toCsv,
  toSrt,
  toVtt,
  description as buildDescription,
  pinnedComment,
  shortsTitles,
  tags as buildTags,
  titleVariants,
  type CaptionCue,
  type CaptionStyleId,
  type Project,
  type QcFinding,
  type QcReport,
  type Scene,
  type TargetAudioMap,
  type TargetId,
  type TargetMedia,
  type VisualHistory,
} from '@buildtrack/core';
import { OUTPUT_DIR, ensureDirs, projectAssetDir, projectDir, run } from './platform.js';
import { analyseFile, contactSheet } from './media.js';
import { exportSpecFor, muxAndEncode, renderTarget } from './render.js';

/* ------------------------------------------------------------------ */
/* Output layout (brief section 4)                                     */
/* ------------------------------------------------------------------ */

export function outputLayout(videoId: string) {
  const base = path.join(OUTPUT_DIR, videoId);
  return {
    base,
    long: path.join(base, 'long'),
    shorts: path.join(base, 'shorts'),
    thumbnails: path.join(base, 'thumbnails'),
    captions: path.join(base, 'captions'),
    metadata: path.join(base, 'metadata'),
    qc: path.join(base, 'qc'),
    assets: path.join(base, 'assets'),
    contacts: path.join(base, 'qc', 'contact_sheets'),
  };
}

export function ensureLayout(videoId: string) {
  const l = outputLayout(videoId);
  for (const dir of [l.base, l.long, l.shorts, l.thumbnails, l.captions, l.metadata, l.qc, l.assets, l.contacts]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return l;
}

/* ------------------------------------------------------------------ */
/* Captions + metadata deliverables                                     */
/* ------------------------------------------------------------------ */

/** Caption file stem for one target, e.g. `Video_01_short_2`. */
export function captionStem(videoId: string, target: TargetId) {
  return `${videoId}_${target}`;
}

function writeCueFiles(dir: string, stem: string, json: Record<string, unknown>, cues: CaptionCue[]) {
  fs.writeFileSync(path.join(dir, `${stem}.srt`), toSrt(cues), 'utf8');
  fs.writeFileSync(path.join(dir, `${stem}.vtt`), toVtt(cues), 'utf8');
  fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify({ ...json, count: cues.length, cues }, null, 2), 'utf8');
}

/**
 * One SRT/VTT/JSON set per target, each from that target's own captions.
 * `<VideoId>.srt|vtt|json` are kept as the legacy Long caption files.
 */
export function writeCaptions(project: Project) {
  const videoId = project.meta.input.videoId;
  const l = ensureLayout(videoId);
  const st = project.storyboard;
  // legacy names: Long captions only
  writeCueFiles(l.captions, videoId, { videoId, target: 'long' }, st.captions);
  for (const [target, cues] of Object.entries(captionsByTarget(st)) as [TargetId, CaptionCue[]][]) {
    const scenes = target === 'long' ? st.long.scenes : (st.shorts.find((s) => s.id === target)?.scenes ?? []);
    const durationSec = target === 'long' ? st.long.totalDuration : (st.shorts.find((s) => s.id === target)?.totalDuration ?? 0);
    writeCueFiles(l.captions, captionStem(videoId, target), { videoId, target, durationSec, narration: targetNarration(scenes) }, cues);
  }
  return l.captions;
}

export function writeMetadata(project: Project, assets: Parameters<typeof provenance>[1]) {
  const l = ensureLayout(project.meta.input.videoId);
  const input = project.meta.input;
  const st = project.storyboard;

  const titles = titleVariants(input);
  const shortMeta = shortsTitles(input);
  const md = {
    videoId: input.videoId,
    topic: input.topic,
    language: input.outputLanguage,
    brand: input.brandPreset,
    product: input.productName,
    long: {
      titles: titles.map((t) => t),
      description: buildDescription(input),
      tags: buildTags(input),
      chapters: chapterList(st.long.scenes),
      durationSec: st.long.totalDuration,
      endScreenReserveSec: st.long.endScreenReserveSeconds,
    },
    shorts: shortMeta.map((s) => {
      // look the plan up by id so metadata can never drift onto another Short
      const plan = st.shorts.find((x) => x.id === s.id);
      return {
        id: s.id,
        angle: plan?.angle,
        hookVariant: plan?.hookVariant,
        durationSec: plan?.totalDuration,
        captionFiles: plan ? ['srt', 'vtt', 'json'].map((ext) => `captions/${captionStem(input.videoId, plan.id)}.${ext}`) : [],
        narrationAudio: plan ? (input.targetAudio?.[plan.id] ?? null) : null,
        title: s.title,
        description: s.description,
        pinnedComment: s.pinned,
      };
    }),
    cta: input.cta,
  };
  fs.writeFileSync(path.join(l.metadata, 'publishing_kit.json'), JSON.stringify(md, null, 2), 'utf8');
  fs.writeFileSync(path.join(l.metadata, 'titles_and_description.md'), markdownKit(input, st, shortMeta), 'utf8');

  const rows = provenance(input, assets, input.videoId);
  fs.writeFileSync(path.join(l.metadata, 'asset_provenance.json'), JSON.stringify(rows, null, 2), 'utf8');
  fs.writeFileSync(path.join(l.metadata, 'asset_provenance.csv'), toCsv(rows), 'utf8');

  fs.writeFileSync(
    path.join(l.metadata, 'storyboard.json'),
    JSON.stringify(
      {
        videoId: input.videoId,
        long: st.long,
        shorts: st.shorts,
        warnings: st.warnings,
        similarity: st.similarity,
        captions: st.captions,
        captionsByTarget: captionsByTarget(st),
      },
      null,
      2,
    ),
    'utf8',
  );
  return l.metadata;
}

function chapterList(scenes: Scene[]) {
  const out: { time: string; label: string }[] = [];
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };
  for (const s of scenes) {
    if (s.role === 'hook' || s.role === 'body' || s.role === 'summary' || s.role === 'cta') {
      if (s.role === 'body' || s.role === 'hook') out.push({ time: fmt(s.startTime), label: s.section });
    }
  }
  return out;
}

function markdownKit(input: Project['meta']['input'], st: Project['storyboard'], shortMeta: ReturnType<typeof shortsTitles>) {
  const titles = titleVariants(input);
  const lines: string[] = [
    `# ${input.videoId} — publishing kit`,
    '',
    `**Topic:** ${input.topic}  `,
    `**Product:** ${input.productName}  `,
    `**Audience:** ${input.targetAudience}  `,
    `**Language:** ${input.outputLanguage}`,
    '',
    '## Title options',
    '',
    ...titles.map((t, i) => `${i + 1}. **[${t.style}]** ${t.text}`),
    '',
    '## Description',
    '',
    '```',
    buildDescription(input),
    '```',
    '',
    '## Pinned comment',
    '',
    '```',
    pinnedComment(input, 'full video'),
    '```',
    '',
    '## Chapters',
    '',
    ...chapterList(st.long.scenes).map((c) => `- ${c.time} — ${c.label}`),
    '',
    '## Shorts',
    '',
  ];
  for (const s of shortMeta) {
    const plan = st.shorts.find((x) => x.id === s.id);
    lines.push(
      `### ${s.id} (${plan?.angle ?? ''}, hook: ${plan?.hookVariant ?? ''}, ${plan?.totalDuration ?? 0}s)`,
      '',
      `**Title:** ${s.title}`,
      '',
      '```',
      s.description,
      '```',
      '',
      '```',
      s.pinned,
      '```',
      '',
    );
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* QC                                                                   */
/* ------------------------------------------------------------------ */

export interface QcRunResult {
  report: QcReport;
  blocked: boolean;
  blockReason: string;
}

export async function runQc(opts: {
  project: Project;
  history: VisualHistory;
  target: 'long' | `short_${number}` | 'thumbnails' | 'captions' | 'project';
  file?: string | null;
  override?: { reason: string } | null;
  /** the resolved target; QC checks this target's scenes and captions */
  media?: TargetMedia | null;
}): Promise<QcRunResult> {
  const { project, history, target } = opts;
  const l = ensureLayout(project.meta.input.videoId);
  const st = project.storyboard;
  const keyNumbers = project.meta.input.keyNumbers;
  const findings: QcFinding[] = [];

  const isMediaTarget = target === 'long' || /^short_\d$/.test(target);
  const scenes = opts.media?.scenes ?? (target === 'long' ? st.long.scenes : (st.shorts.find((s) => s.id === target)?.scenes ?? []));
  const cues = opts.media?.captions ?? (isMediaTarget ? captionsForTarget(st, target as TargetId) : st.captions);

  if (isMediaTarget) {
    // target-specific: never another target's findings or evidence
    findings.push(...targetStaticQc(st, target as TargetId, cues));
    if (target === 'long') findings.push(...keyNumberFindings(keyNumbers, st.long.scenes));
    else {
      const plan = st.shorts.find((s) => s.id === target);
      if (plan) findings.push(...shortKeyNumberFindings(keyNumbers, { ...plan, scenes }));
    }
  } else {
    // explicit project-wide QC ('project', or the legacy 'captions'/'thumbnails')
    findings.push(...staticQc(st, history));
    findings.push(...keyNumberFindings(keyNumbers, st.long.scenes));
  }
  findings.push(...captionQc(cues as CaptionCue[]));

  const metrics: Record<string, string | number | boolean> = {
    sceneCount: scenes.length,
    plannedDurationSec: Number(scenes.reduce((a, s) => a + s.duration, 0).toFixed(2)),
    captionCues: cues.length,
  };
  if (opts.media) {
    metrics.audioFile = opts.media.audioFile ? path.basename(opts.media.audioFile) : 'none';
    if (opts.media.audioDurationSec != null) metrics.audioDurationSec = Number(opts.media.audioDurationSec.toFixed(2));
    metrics.targetDurationSec = opts.media.durationSec;
  }

  if (opts.file && fs.existsSync(opts.file)) {
    const spec = exportSpecFor(target === 'long' ? 'long' : 'short');
    const a = await analyseFile(opts.file);
    findings.push(...technicalQc(a, spec, target));
    findings.push(
      ...mediaQc({
        missingMedia: 0,
        blackFrames: a.blackIntervals,
        blackSeconds: a.blackSeconds,
        longestSilence: a.longestSilence,
        silenceThreshold: 1.5,
      }),
    );
    Object.assign(metrics, {
      width: a.width,
      height: a.height,
      fps: a.r_frame_rate,
      videoCodec: a.codec_name,
      pixFmt: a.pix_fmt,
      videoBitrateKbps: Math.round(Number(a.bit_rate ?? 0) / 1000),
      audioCodec: a.audioCodec ?? 'none',
      audioBitrateKbps: a.audioBitrate ? Math.round(Number(a.audioBitrate) / 1000) : 0,
      audioSampleRate: a.audioSampleRate ?? 'none',
      durationSec: Number(a.duration.toFixed(2)),
      sizeMB: Number((a.sizeBytes / 1e6).toFixed(2)),
      blackSeconds: Number(a.blackSeconds.toFixed(2)),
      longestSilenceSec: Number(a.longestSilence.toFixed(2)),
      aspectRatio: Number((a.width / a.height).toFixed(3)),
      expectedAspectRatio: Number((spec.width / spec.height).toFixed(3)),
    });
  } else {
    findings.push({
      id: 'technical_no_file',
      category: 'technical',
      severity: 'warn',
      title: 'File not analysed',
      detail: 'No encoded file was supplied, so technical QC ran on the storyboard only.',
    });
  }

  const report = buildReport(
    project.meta.input.videoId,
    target,
    findings,
    metrics,
    st.similarity,
    opts.override ? { reason: opts.override.reason, at: new Date().toISOString() } : null,
  );
  const gate = canExport(report);
  fs.writeFileSync(path.join(l.qc, `qc_${target}.json`), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(l.qc, `qc_${target}.md`), qcMarkdown(report), 'utf8');
  return { report, blocked: !gate.allowed, blockReason: gate.reason };
}

function qcMarkdown(r: QcReport) {
  const group = (c: QcReport['findings'][number]['category']) => r.findings.filter((f) => f.category === c);
  const line = (f: (typeof r.findings)[number]) => `| ${f.severity.toUpperCase()} | ${f.category} | ${f.title} | ${f.detail} | ${f.where ?? ''} |`;
  return [
    `# QC report — ${r.videoId} (${r.target})`,
    '',
    `**Verdict:** ${r.verdict.toUpperCase()}  `,
    `**Generated:** ${r.generatedAt}  `,
    r.override ? `**Override:** ${r.override.reason}\n` : '',
    ...(r.metrics && Object.keys(r.metrics).length
      ? ['', '## Metrics', '', '| key | value |', '| --- | --- |', ...Object.entries(r.metrics).map(([k, v]) => `| ${k} | ${v} |`)]
      : []),
    ...(['technical', 'visual', 'content'] as const).flatMap((c) => {
      const rows = group(c);
      if (!rows.length) return [];
      return ['', `## ${c[0].toUpperCase() + c.slice(1)} QC`, '', '| severity | category | check | detail | where |', '| --- | --- | --- | --- | --- |', ...rows.map(line)];
    }),
    '',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Full export                                                          */
/* ------------------------------------------------------------------ */

export interface ExportOptions {
  kind: 'preview' | 'final';
  videoId: string;
  includeShorts?: boolean;
  /** restrict the export to these targets (e.g. ['short_1']); default all */
  onlyTargets?: string[] | null;
  includeThumbnails?: boolean;
  includeBurnedCaptions?: boolean;
  override?: { reason: string } | null;
  history: VisualHistory;
  assets: Parameters<typeof provenance>[1];
  ctaAnimation: CaptionStyleId | string;
  captionStyle: CaptionStyleId | string;
  /**
   * Narration per target. There is intentionally no project-wide `audioFile`:
   * a Short only ever receives `targetAudio[shortId]`.
   */
  targetAudio: TargetAudioMap;
  assetUrls?: Record<string, string>;
  logoUrl?: string | null;
  onLog?: (msg: string) => void;
}

/** Result of one target of an export. Blocked targets have no file. */
export interface ExportTargetResult {
  target: string;
  file: string;
  qc: QcReport;
  blocked: boolean;
  blockReason: string;
}

function blockedReport(videoId: string, target: TargetId, error: string): QcReport {
  return buildReport(
    videoId,
    target,
    [{ id: 'target_audio_missing', category: 'technical', severity: 'critical', title: 'Target cannot be exported', detail: error, where: target }],
    {},
    null,
    null,
  );
}

export async function exportProject(project: Project, o: ExportOptions) {
  // A single project-wide audio/caption pair is exactly the defect this
  // contract removes. Refuse it loudly rather than silently ignoring it.
  const legacy = o as unknown as Record<string, unknown>;
  for (const key of ['audioFile', 'captions']) {
    if (key in legacy) {
      throw new Error(`exportProject: "${key}" is not accepted. Pass per-target narration in "targetAudio" (long, short_1..short_3); captions are resolved per target.`);
    }
  }
  if (!o.targetAudio || typeof o.targetAudio !== 'object') {
    throw new Error('exportProject: "targetAudio" is required (per-target narration map).');
  }

  ensureDirs();
  const log = o.onLog ?? (() => {});
  const l = ensureLayout(o.videoId);
  const st = project.storyboard;
  const input = project.meta.input;

  writeCaptions(project);
  writeMetadata(project, o.assets);

  const historyEntry = o.history.videos.find((v) => v.videoId === o.videoId);
  const ctaAnimation = (historyEntry?.ctaAnimation ?? 'slide_in') as never;
  const captionStyle = (historyEntry?.captionStyle ?? 'boxed_center') as never;

  const results: ExportTargetResult[] = [];

  /** Render, mux and QC one target from its resolved media ONLY. */
  const doTarget = async (m: TargetMedia) => {
    const target = m.targetId;
    const file = target === 'long' ? path.join(l.long, `${o.videoId}_long_${o.kind}.mp4`) : path.join(l.shorts, `${o.videoId}_${target}_${o.kind}.mp4`);
    log(`Rendering ${target} (${m.scenes.length} scenes, ${m.captions.length} cues, audio ${m.audioFile ? path.basename(m.audioFile) : 'none'})…`);
    const { rawVideo } = await renderTarget({
      format: m.format,
      scenes: m.scenes,
      videoId: o.videoId,
      ctaAnimation,
      captionStyle,
      ctaText: input.cta,
      productName: input.productName,
      brand: st.brand,
      audioUrl: null,
      logoUrl: o.logoUrl ?? null,
      mediaMap: o.assetUrls ?? {},
      captions: m.captions,
      burnedCaptions: true,
      quality: o.kind,
      outputFile: file,
      onProgress: onLogProgress(log, target, o.kind),
    });
    log(`Encoding ${target}…`);
    await muxAndEncode({
      rawVideo,
      audioFile: m.audioFile,
      outFile: file,
      spec: exportSpecFor(m.format),
      videoBitrate: o.kind === 'preview' ? '3M' : '8M',
      maxrate: o.kind === 'preview' ? '5M' : '10M',
      // the rendered picture is the authority on length
      durationSec: m.durationSec,
      finalExport: o.kind === 'final',
      onProgress: (p, note) => log(`${target}: ${note} ${(p * 100).toFixed(0)}%`),
    });

    const qc = await runQc({ project, history: o.history, target, file, override: o.override, media: m });
    results.push({ target, file, qc: qc.report, blocked: qc.blocked, blockReason: qc.blockReason });
    log(`${target} QC: ${qc.report.verdict.toUpperCase()}`);

    if (o.kind === 'final') {
      try {
        await contactSheet({ videoFile: file, outFile: path.join(l.contacts, `${target}_contact.png`), cols: 4, rows: 3 });
      } catch (e) {
        log(`contact sheet skipped: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    return file;
  };

  const plan = planTargets(project, o.targetAudio, { includeShorts: o.includeShorts }).filter((r) => !o.onlyTargets || o.onlyTargets.includes(r.targetId));
  for (const r of plan) {
    if (!r.ok) {
      // block only this target; the others continue with their own media
      log(`${r.targetId} BLOCKED: ${r.error}`);
      const report = blockedReport(o.videoId, r.targetId, r.error);
      fs.writeFileSync(path.join(l.qc, `qc_${r.targetId}.json`), JSON.stringify(report, null, 2), 'utf8');
      fs.writeFileSync(path.join(l.qc, `qc_${r.targetId}.md`), qcMarkdown(report), 'utf8');
      results.push({ target: r.targetId, file: '', qc: report, blocked: true, blockReason: r.error });
      continue;
    }
    await doTarget(r.media);
  }

  if (o.includeThumbnails !== false) {
    const { renderThumbnails } = await import('./render.js');
    const files = await renderThumbnails({
      scenes: st.long.scenes,
      videoId: o.videoId,
      count: 3,
      outDir: l.thumbnails,
      videoProps: {
        scenes: st.long.scenes,
        captions: st.captions,
        brand: st.brand,
        format: 'long',
        ctaAnimation,
        captionStyle,
        ctaText: input.cta,
        productName: input.productName,
        logoSrc: o.logoUrl ?? null,
        audioSrc: null,
        burnedCaptions: false,
        mediaMap: o.assetUrls ?? {},
      },
      onProgress: (p) => log(`thumbnails ${(p * 100).toFixed(0)}%`),
    });
    fs.writeFileSync(
      path.join(l.thumbnails, 'concepts.json'),
      JSON.stringify(
        files.map((f, i) => ({
          concept: i + 1,
          file: path.basename(f),
          source: 'rendered from a distinct scene of this video',
          rationale: 'Each concept is a frame from a different scene, so the three thumbnails are structurally different from each other.',
        })),
        null,
        2,
      ),
      'utf8',
    );
  }

  const summary = {
    videoId: o.videoId,
    kind: o.kind,
    generatedAt: new Date().toISOString(),
    results: results.map((r) => ({ target: r.target, file: r.file ? path.relative(l.base, r.file) : null, verdict: r.qc.verdict, blocked: r.blocked, blockReason: r.blockReason })),
    exportSpec: { long: exportSpecFor('long'), short: exportSpecFor('short') },
  };
  fs.writeFileSync(path.join(l.qc, `export_summary_${o.kind}.json`), JSON.stringify(summary, null, 2), 'utf8');

  return { layout: l, results, summary };
}

function onLogProgress(log: (m: string) => void, target: string, kind: string) {
  let last = 0;
  return (p: number) => {
    const pct = Math.floor(p * 100);
    if (pct >= last + 10) {
      last = pct;
      log(`${target} (${kind}): ${pct}%`);
    }
  };
}

export function copyProjectAssets(videoId: string) {
  const from = projectAssetDir(videoId);
  const to = path.join(projectDir(videoId), 'assets');
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, force: true });
  return to;
}

export { run };
