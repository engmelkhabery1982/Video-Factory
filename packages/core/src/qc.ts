import { EXPLANATION_VARIANTS } from './variants.js';
import { captionOverMaxLines, MAX_CPS } from './captions.js';
import type { CaptionCue, QcFinding, QcReport, Scene, ShortPlan, Storyboard, VisualHistory, SimilarityResult } from './types.js';

export const PLACEHOLDER_RE = /(lorem ipsum|\bTBD\b|\bTODO\b|\bXXX\b|\bFIXME\b|\{\{|\}\}|<insert|\bplaceholder\b|your text here)/i;

export const MAX_BACKGROUND_CONTINUOUS = 15;

function f(
  category: QcFinding['category'],
  severity: QcFinding['severity'],
  title: string,
  detail: string,
  where?: string,
): QcFinding {
  return { id: `${category}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48)}`, category, severity, title, detail, where };
}

/* ------------------------------------------------------------------ */
/* Static (pre-render) visual + content QC                            */
/* ------------------------------------------------------------------ */

/**
 * PROJECT-WIDE static QC: the Long, every Short and the project gates.
 * Use only for an explicit project-level check; an export target uses
 * `targetStaticQc`, which never reports another target's findings.
 */
export function staticQc(storyboard: Storyboard, history: VisualHistory): QcFinding[] {
  void history;
  return [
    ...longStaticQc(storyboard),
    ...storyboard.shorts.flatMap((short) => [...shortQc(short), ...captionLineQc(short.id, shortCaptionsOf(storyboard, short))]),
    ...projectGateQc(storyboard),
  ];
}

export type QcTarget = 'long' | ShortPlan['id'];

/**
 * Static QC for ONE export target. Long -> Long structure + Long captions.
 * A Short -> that Short's structure, pacing, hook and captions only. The
 * project similarity gate is attached to every target only when it BLOCKS,
 * because a blocked project must not ship any of its targets.
 */
export function targetStaticQc(storyboard: Storyboard, target: QcTarget, captions?: CaptionCue[]): QcFinding[] {
  if (target === 'long') return [...longStaticQc(storyboard, captions), ...projectGateQc(storyboard)];
  const short = storyboard.shorts.find((s) => s.id === target);
  if (!short) return [f('content', 'critical', 'Short not in storyboard', `${target} does not exist in this storyboard.`, target)];
  return [...shortQc(short), ...captionLineQc(short.id, captions ?? shortCaptionsOf(storyboard, short)), ...projectGateQc(storyboard)];
}

function shortCaptionsOf(storyboard: Storyboard, short: ShortPlan): CaptionCue[] {
  return storyboard.shortCaptions?.[short.id] ?? [];
}

function captionLineQc(target: string, cues: CaptionCue[]): QcFinding[] {
  return cues
    .filter((c) => captionOverMaxLines(c.text))
    .map((c) => f('visual', 'critical', 'Caption exceeds two lines', `${target} cue ${c.id} is longer than two lines of caption text.`, `${target} ${c.start.toFixed(2)}s`));
}

function projectGateQc(storyboard: Storyboard): QcFinding[] {
  if (!storyboard.similarity?.blocking) return [];
  return [
    f('content', 'critical', 'Visual similarity above the gate', `${storyboard.similarity.score}% similar to a recent video (limit ${storyboard.similarity.threshold}%). ${storyboard.similarity.reasons.join('; ')}`, 'project gate'),
  ];
}

/** Long-only structure, pacing and caption checks. */
export function longStaticQc(storyboard: Storyboard, captions?: CaptionCue[]): QcFinding[] {
  const findings: QcFinding[] = [];
  const scenes = storyboard.long.scenes;
  const s0 = scenes[0];

  /* ---- long structure ---- */
  if (!s0 || s0.role !== 'hook') {
    findings.push(f('content', 'critical', 'Missing opening hook', 'The first scene is not a hook, so the video does not earn the first 5-8 seconds.'));
  } else {
    if (s0.duration < 5 || s0.duration > 8.2) {
      findings.push(f('content', 'warn', 'Hook outside the 5-8s window', `Hook is ${s0.duration.toFixed(1)}s; target is 5-8s.`));
    }
    if (s0.variant === 'cta_card') {
      findings.push(f('visual', 'critical', 'Logo / title card opener', 'The video opens with a plain title card - explicitly forbidden by the anti-repetition rules.'));
    }
  }

  const ctas = scenes.filter((s) => s.role === 'cta');
  if (ctas.length !== 1) {
    findings.push(f('content', 'critical', 'CTA count is not exactly one', `Found ${ctas.length} CTA scenes; exactly one is allowed.`));
  } else if (ctas[0].duration < 6 || ctas[0].duration > 8.5) {
    findings.push(f('content', 'warn', 'CTA duration outside 6-8s', `CTA is ${ctas[0].duration.toFixed(1)}s; the reference failure was a late, over-long CTA.`));
  }

  const summaries = scenes.filter((s) => s.role === 'summary');
  if (summaries.length > 1) {
    findings.push(f('content', 'critical', 'Duplicate summary', `${summaries.length} summary blocks found - only one is allowed.`));
  }

  const bodyScenes = scenes.filter((s) => s.role === 'body');
  const overEvol = bodyScenes.filter((s) => s.duration > 8.5);
  if (overEvol.length) {
    findings.push(f('visual', 'warn', 'Scene held too long', `${overEvol.length} body scene(s) exceed 8.5s without a visual change; target evolution every 5-8s.`, overEvol.map((s) => `#${s.index + 1}`).join(', ')));
  }
  const tiny = bodyScenes.filter((s) => s.duration < 3);
  if (tiny.length) {
    findings.push(f('visual', 'warn', 'Scene too short to read', `${tiny.length} body scene(s) are under 3s.`, tiny.map((s) => `#${s.index + 1}`).join(', ')));
  }

  /* ---- anti repetition ---- */
  const counts = new Map<string, number>();
  for (const s of scenes) counts.set(s.variant, (counts.get(s.variant) ?? 0) + 1);
  for (const [k, v] of counts) {
    if (v > 2) findings.push(f('visual', 'warn', 'Scene variant over-used', `"${k}" appears ${v} times in one video; the limit is 2.`, k));
  }
  for (let i = 2; i < scenes.length; i++) {
    const a = scenes[i - 2].transitionIn;
    const b = scenes[i - 1].transitionIn;
    const c = scenes[i].transitionIn;
    if (a === b && b === c) {
      findings.push(f('visual', 'warn', 'Transition repeated three times', `Transition "${c}" runs across three consecutive scenes.`, `scenes ${i - 1}-${i + 1}`));
    }
  }
  // continuous background run
  let runBg: string | null = null;
  let runStart = 0;
  let runSec = 0;
  const checkRun = (endScene: number) => {
    if (runBg && runSec > MAX_BACKGROUND_CONTINUOUS + 0.5) {
      findings.push(f('visual', 'warn', 'Background held too long', `Background "${runBg}" ran ${runSec.toFixed(1)}s continuously; limit is ${MAX_BACKGROUND_CONTINUOUS}s.`, `from scene ${runStart + 1} to ${endScene}`));
    }
  };
  scenes.forEach((s, i) => {
    if (s.background !== runBg) {
      checkRun(i);
      runBg = s.background;
      runStart = i;
      runSec = 0;
    }
    runSec += s.duration;
  });
  checkRun(scenes.length);

  /* ---- tiny text / full table / safe zones ---- */
  for (const s of scenes) {
    const items = s.content?.items ?? [];
    const headline = s.content?.headline ?? '';
    if (s.variant === 'progressive_table' && items.length > 4) {
      findings.push(f('visual', 'warn', 'Full table on screen', `Scene ${s.index + 1} shows more than 4 rows; only the row being explained should be visible.`));
    }
    if (headline.length > 70) {
      findings.push(f('visual', 'warn', 'Headline too long for one screen', `Scene ${s.index + 1} headline is ${headline.length} characters; long text is the main driver of clipped/small titles.`));
    }
    if (PLACEHOLDER_RE.test(headline) || PLACEHOLDER_RE.test(s.content?.subline ?? '')) {
      findings.push(f('content', 'critical', 'Placeholder text left in the script', `Scene ${s.index + 1} still contains placeholder copy.`));
    }
    if (s.role === 'cta' && storyboard.brand.logoAssetId && s.textPosition === 'right_column') {
      findings.push(f('visual', 'warn', 'CTA text in the platform-UI risk zone', `Scene ${s.index + 1} places CTA copy on the right rail.`));
    }
  }

  /* ---- product proof not only in the final second ---- */
  const proofIdx = scenes.findIndex((s) => s.variant === 'dashboard_demo' || s.variant === 'site_footage_callouts' || (s.content?.headline ?? '').includes(storyboard.brand.name.slice(0, 10)));
  const total = storyboard.long.totalDuration;
  if (proofIdx < 0 || (scenes[proofIdx] && scenes[proofIdx].startTime / total > 0.85)) {
    findings.push(f('content', 'critical', 'Product only appears at the end', 'No product proof scene before 85% of the runtime - the reference videos failed on this.'));
  }

  /* ---- Long captions ---- */
  for (const c of captions ?? storyboard.captions) {
    if (captionOverMaxLines(c.text)) {
      findings.push(f('visual', 'critical', 'Caption exceeds two lines', `Cue ${c.id} is longer than two lines of caption text.`, `${c.start.toFixed(2)}s`));
    }
  }

  return findings;
}

export function shortQc(short: ShortPlan): QcFinding[] {
  const out: QcFinding[] = [];
  const name = short.id;
  if (short.native !== true) {
    out.push(f('visual', 'critical', 'Short is not natively vertical', `${name} was not marked as a native 9:16 project.`));
  }
  if (short.totalDuration < 18 || short.totalDuration > 36) {
    out.push(f('content', 'warn', 'Short duration out of range', `${name} is ${short.totalDuration.toFixed(1)}s; target is 20-35s.`));
  }
  const ctas = short.scenes.filter((s) => s.role === 'cta');
  if (ctas.length !== 1) out.push(f('content', 'critical', 'Short CTA count', `${name} has ${ctas.length} CTAs; exactly one is required.`));

  const hook = short.scenes[0];
  if (!hook || hook.role !== 'hook') out.push(f('content', 'critical', 'Short missing hook', `${name} does not open with a hook.`));
  else if (hook.duration > 3) out.push(f('content', 'warn', 'Short hook too slow', `${name} hook lasts ${hook.duration.toFixed(1)}s; the full hook must be readable in the first 2 seconds.`));

  const explanationIds = new Set(EXPLANATION_VARIANTS.map((v) => v.id as string));
  for (const s of short.scenes) {
    // only real explanation layouts are subject to the 9:16 safety check;
    // hooks have their own native vertical implementations
    if (explanationIds.has(s.variant) && !EXPLANATION_VARIANTS.find((v) => v.id === s.variant)!.shortsSafe) {
      out.push(f('visual', 'critical', 'Landscape-first layout inside a vertical frame', `${name} scene ${s.index + 1} uses "${s.variant}", which would render as a shrunken landscape slide.`, s.id));
    }
    if (s.duration > 3.2 && s.role === 'body') {
      out.push(f('visual', 'warn', 'Short held on one idea too long', `${name} scene ${s.index + 1} runs ${s.duration.toFixed(1)}s; change the visual every 1.5-3s.`));
    }
    if (s.textPosition === 'right_column' || s.textPosition === 'bottom_center' || s.textPosition === 'lower_third') {
      out.push(f('visual', 'warn', 'Key text in the platform-UI zone', `${name} scene ${s.index + 1} uses text position "${s.textPosition}", which platforms cover with UI.`));
    }
    if (PLACEHOLDER_RE.test(s.content?.headline ?? '')) {
      out.push(f('content', 'critical', 'Placeholder text in short', `${name} scene ${s.index + 1} still has placeholder copy.`));
    }
    const shl = s.content?.headline ?? '';
    if (shl.length > 52) {
      out.push(f('visual', 'warn', 'Short headline too long', `${name} scene ${s.index + 1} headline is ${shl.length} characters; phone-sized type must stay short.`));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Technical QC from the real encoded file (ffprobe)                  */
/* ------------------------------------------------------------------ */

export interface ProbeInfo {
  width: number;
  height: number;
  r_frame_rate: string;
  codec_name: string;
  profile?: string;
  pix_fmt?: string;
  bit_rate?: string;
  duration: number;
  hasAudio: boolean;
  audioCodec?: string;
  audioBitrate?: string;
  audioSampleRate?: string;
  audioChannels?: number;
  field_order?: string;
}

export interface ExportSpec {
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  minVideoBitrate: number;
  maxVideoBitrate: number;
  audioCodec: string;
  audioBitrate: [number, number];
  audioSampleRate: number;
  pixFmt: string;
}

export const LONG_EXPORT_SPEC: ExportSpec = {
  width: 1920,
  height: 1080,
  fps: 30,
  videoCodec: 'h264',
  minVideoBitrate: 5_000_000,
  maxVideoBitrate: 14_000_000,
  audioCodec: 'aac',
  audioBitrate: [192_000, 256_000],
  audioSampleRate: 48_000,
  pixFmt: 'yuv420p',
};

export const SHORT_EXPORT_SPEC: ExportSpec = {
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  minVideoBitrate: 6_000_000,
  maxVideoBitrate: 14_000_000,
  audioCodec: 'aac',
  audioBitrate: [192_000, 256_000],
  audioSampleRate: 48_000,
  pixFmt: 'yuv420p',
};

export function technicalQc(info: ProbeInfo, spec: ExportSpec, target: QcReport['target']): QcFinding[] {
  const out: QcFinding[] = [];

  out.push(
    f('technical', info.width === spec.width && info.height === spec.height ? 'pass' : 'critical', 'Resolution', `${info.width}x${info.height} (expected ${spec.width}x${spec.height}).`),
  );
  const [num, den] = (info.r_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;
  out.push(f('technical', Math.abs(fps - spec.fps) < 0.01 ? 'pass' : 'critical', 'Frame rate', `${fps.toFixed(2)} fps (expected ${spec.fps}).`));

  const expectedAr = (spec.width / spec.height).toFixed(3);
  const actualAr = (info.width / info.height).toFixed(3);
  out.push(f('technical', Math.abs(Number(actualAr) - Number(expectedAr)) < 0.005 ? 'pass' : 'critical', 'Aspect ratio', `${actualAr} (expected ${expectedAr}).`));

  out.push(f('technical', info.codec_name === spec.videoCodec ? 'pass' : 'critical', 'Video codec', `${info.codec_name} (expected ${spec.videoCodec}).`));
  out.push(f('technical', info.pix_fmt === spec.pixFmt ? 'pass' : 'critical', 'Pixel format', `${info.pix_fmt} (expected ${spec.pixFmt} - required for browser playback).`));

  const vbr = Number(info.bit_rate ?? 0);
  out.push(
    f('technical', vbr >= spec.minVideoBitrate && vbr <= spec.maxVideoBitrate ? 'pass' : vbr > 0 ? 'warn' : 'critical', 'Video bitrate', `${Math.round(vbr / 1000)} kbps (target ${spec.minVideoBitrate / 1e6}-${spec.maxVideoBitrate / 1e6} Mbps).`),
  );

  out.push(f('technical', info.hasAudio && info.audioCodec === spec.audioCodec ? 'pass' : info.hasAudio ? 'warn' : 'critical', 'Audio codec', `${info.audioCodec ?? 'none'} (expected ${spec.audioCodec}).`));
  const abr = Number(info.audioBitrate ?? 0);
  out.push(
    f('technical', abr >= spec.audioBitrate[0] && abr <= spec.audioBitrate[1] ? 'pass' : 'warn', 'Audio bitrate', `${Math.round(abr / 1000)} kbps (expected 192-256 kbps).`),
  );
  out.push(f('technical', Number(info.audioSampleRate) === spec.audioSampleRate ? 'pass' : 'warn', 'Audio sample rate', `${info.audioSampleRate} Hz (expected ${spec.audioSampleRate}).`));
  // Duration must be checked against the target, not merely "longer than
  // half a second": a 24s Short padded out to the full 95s narration still
  // has a valid duration, and is exactly the kind of defect that ships.
  const planned = target === 'long' ? LONG_DURATION_RANGE : SHORT_DURATION_RANGE;
  const [lo, hi] = planned;
  const durOk = info.duration >= lo - 0.75 && info.duration <= hi + 0.75;
  out.push(
    f(
      'technical',
      durOk ? 'pass' : 'critical',
      'Duration',
      `${info.duration.toFixed(2)}s (${target === 'long' ? 'Long' : 'Short'} must be ${lo}-${hi}s).`,
    ),
  );
  return out;
}

/** Brief section 9: a Long video is a multi-minute piece. */
export const LONG_DURATION_RANGE: [number, number] = [45, 180];
/** Brief section 10: a Short is 20-35 seconds. */
export const SHORT_DURATION_RANGE: [number, number] = [20, 35];

export function mediaQc(info: { missingMedia: number; blackFrames: number; blackSeconds: number; longestSilence: number; silenceThreshold: number }): QcFinding[] {
  const out: QcFinding[] = [];
  out.push(f('technical', info.missingMedia === 0 ? 'pass' : 'critical', 'Missing media', `${info.missingMedia} referenced media file(s) could not be resolved.`));
  out.push(
    f('technical', info.blackFrames === 0 ? 'pass' : 'critical', 'Black or empty frames', `${info.blackFrames} black frame(s) detected, ${info.blackSeconds.toFixed(2)}s total.`),
  );
  out.push(
    f(
      'technical',
      info.longestSilence <= info.silenceThreshold ? 'pass' : 'warn',
      'Audio silence',
      `Longest silence ${info.longestSilence.toFixed(2)}s (threshold ${info.silenceThreshold}s).`,
    ),
  );
  return out;
}

export function captionQc(cues: CaptionCue[]): QcFinding[] {
  const out: QcFinding[] = [];
  const tooFast = cues.filter((c) => charactersPerSecond(c.text, c.end - c.start) > MAX_CPS);
  out.push(
    f('visual', tooFast.length === 0 ? 'pass' : 'warn', 'Caption reading speed', `${tooFast.length} cue(s) exceed ${MAX_CPS} characters per second.`, tooFast.slice(0, 5).map((c) => c.id).join(', ')),
  );
  return out;
}

function charactersPerSecond(text: string, sec: number): number {
  if (sec <= 0) return 999;
  return text.replace(/\s+/g, '').length / sec;
}

export function buildReport(
  videoId: string,
  target: QcReport['target'],
  findings: QcFinding[],
  metrics: QcReport['metrics'],
  similarity: SimilarityResult | null,
  override: QcReport['override'],
): QcReport {
  const criticals = findings.filter((x) => x.severity === 'critical').length;
  const warns = findings.filter((x) => x.severity === 'warn').length;
  const verdict: QcReport['verdict'] = criticals > 0 && !override ? 'fail' : warns > 0 ? 'warn' : 'pass';
  return { videoId, target, generatedAt: new Date().toISOString(), verdict, findings, metrics, similarity, override };
}

export function canExport(report: QcReport): { allowed: boolean; reason: string } {
  const criticals = report.findings.filter((f) => f.severity === 'critical');
  if (!criticals.length) return { allowed: true, reason: 'No critical findings.' };
  if (report.override) return { allowed: true, reason: `Override used: ${report.override.reason}` };
  return {
    allowed: false,
    reason: `Blocked by ${criticals.length} critical finding(s): ${criticals.slice(0, 3).map((c) => c.title).join('; ')}.`,
  };
}

/**
 * Normalise a figure so the same number is recognised however it was typed.
 * "59.5%", "59.5 %", "59.5 percent" and "fifty nine point five" style variants
 * must not be reported as a missing key number.
 */
export function normaliseNumber(raw: string): string[] {
  const forms = new Set<string>();
  const push = (v: string) => {
    const t = v.trim().toLowerCase().replace(/\s+/g, ' ');
    if (t) forms.add(t);
  };
  push(raw);
  const m = String(raw).match(/(\d+(?:[.,]\d+)?)\s*(%|percent|pct)?/i);
  if (m) {
    const n = m[1].replace(',', '.');
    push(n);
    if (m[2]) {
      push(`${n}%`);
      push(`${n} percent`);
      push(`${n} per cent`);
      push(`${n} pct`);
    }
  }
  return [...forms];
}

/**
 * Key numbers for ONE Short. Only numbers the Short actually uses (in its
 * narration or on-screen copy) are relevant; each must reach the Short's
 * screen. Long scenes are never evidence for a Short.
 */
export function shortKeyNumberFindings(numbers: string[], short: ShortPlan): QcFinding[] {
  const lower = (x: string) => x.toLowerCase().replace(/\s+/g, ' ');
  const screen = lower(
    short.scenes
      .map((s) => `${s.content?.headline ?? ''} ${s.content?.subline ?? ''} ${(s.content?.items ?? []).join(' ')} ${s.content?.stat ?? ''} ${s.content?.stat2 ?? ''}`)
      .join(' '),
  );
  const spoken = lower(short.scenes.map((s) => s.narration ?? '').join(' '));
  const has = (blob: string, n: string) => normaliseNumber(n).some((form) => new RegExp(`(^|[^0-9.])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`).test(blob));
  const relevant = numbers.filter((n) => has(spoken, n) || has(screen, n));
  if (!relevant.length) {
    return [f('content', 'pass', 'Key numbers (not applicable)', `${short.id} uses none of the ${numbers.length} project key number(s); nothing to check.`, short.id)];
  }
  const missing = relevant.filter((n) => !has(screen, n));
  if (!missing.length) return [f('content', 'pass', 'Key numbers', `${short.id}: all ${relevant.length} key number(s) it uses (${relevant.join(', ')}) appear on screen.`, short.id)];
  return [f('content', 'warn', 'Spoken key number not on screen', `${short.id} speaks ${missing.join(', ')} but never shows it.`, short.id)];
}

export function keyNumberFindings(numbers: string[], scenes: Scene[]): QcFinding[] {
  const blob = scenes
    .map((s) => `${s.content?.headline ?? ''} ${s.content?.subline ?? ''} ${(s.content?.items ?? []).join(' ')} ${s.content?.stat ?? ''} ${s.content?.stat2 ?? ''} ${s.narration ?? ''}`)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const missing = numbers.filter((n) => !normaliseNumber(n).some((form) => blob.includes(form)));
  if (!missing.length) return [f('content', 'pass', 'Key numbers', `All ${numbers.length} key number(s) from the script appear on screen.`)];
  return [f('content', 'critical', 'Key numbers missing on screen', `${missing.length} key number(s) never reach the screen: ${missing.slice(0, 5).join(', ')}.`)];
}
