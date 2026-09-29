import type { ProjectInput } from './types.js';

/**
 * Publishing kit (brief section 4): titles, description, pinned comment, CTA.
 * Generated locally with deterministic, topic-aware templates so the copy is
 * never a colour swap of the previous video.
 */

export interface TitleVariant {
  text: string;
  style: 'question' | 'number' | 'benefit' | 'risk' | 'curiosity';
}

export function titleVariants(input: ProjectInput): TitleVariant[] {
  const topic = input.topic;
  const num = input.keyNumbers[0] ?? '';
  const num2 = input.keyNumbers[1] ?? '';
  const out: TitleVariant[] = [
    { text: num && num2 ? `${num} vs ${num2}: What Your ${topic} Report Is Not Telling You` : `${topic}: What Most Progress Reports Get Wrong`, style: 'number' },
    { text: `Why ${topic} Breaks Down in the Last 20%`, style: 'question' },
    { text: `The ${input.productName} Method for ${topic}`, style: 'benefit' },
    { text: num ? `The ${num} Number That Changes Everything in ${topic}` : `Stop Guessing: A Better Way to See ${topic}`, style: 'curiosity' },
    { text: `${input.mainProblem || topic}? Here Is the Fix`, style: 'risk' },
  ];
  return out;
}

export function description(input: ProjectInput): string {
  const points = input.keyPoints.length ? input.keyPoints : ['What the number means', 'Why it drifts', 'What to do next'];
  const refs = input.sourceReferences.length ? `\n\nReferences:\n${input.sourceReferences.map((r) => `- ${r}`).join('\n')}` : '';
  return [
    `${input.topic}`,
    '',
    input.viewerPromise || '',
    '',
    'In this video:',
    ...points.map((p, i) => `${i + 1}. ${p}`),
    '',
    `Target audience: ${input.targetAudience}`,
    `Product: ${input.productName}`,
    '',
    input.cta,
    refs,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export function pinnedComment(input: ProjectInput, shortCode: string): string {
  const line = input.keyNumbers[0] ? `The number in this video: ${input.keyNumbers.join(' vs ')}.` : `Key point: ${input.keyPoints[0] ?? input.topic}.`;
  return [
    `📌 Pinned - ${shortCode}`,
    line,
    '',
    `${input.cta}`,
    '',
    `Full breakdown of "${input.topic}": link in the description.`,
  ].join('\n');
}

export function shortsTitles(input: ProjectInput): { id: string; title: string; description: string; pinned: string }[] {
  const n = input.keyNumbers;
  return [
    {
      id: 'short_1',
      title: (input.hook || `${input.mainProblem || input.topic}?`).slice(0, 92),
      description: `${input.viewerPromise || input.topic}\n\n${input.cta}`,
      pinned: pinnedComment(input, 'Short 1/3 - the problem'),
    },
    {
      id: 'short_2',
      title: n.length >= 2 ? `${n[0]} vs ${n[1]} - the gap nobody tracks` : `The number behind ${input.topic}`,
      description: `${input.topic}\n\n${input.cta}`,
      pinned: pinnedComment(input, 'Short 2/3 - the comparison'),
    },
    {
      id: 'short_3',
      title: `The mistake that ruins ${input.topic.toLowerCase()}`,
      description: `${input.mainProblem || input.topic}\n\n${input.cta}`,
      pinned: pinnedComment(input, 'Short 3/3 - the mistake'),
    },
  ];
}

export function tags(input: ProjectInput): string[] {
  const base = ['buildtrack', 'construction', 'project controls', 'progress reporting'];
  const extra = input.keyPoints
    .flatMap((p) => p.toLowerCase().split(/\W+/))
    .filter((w) => w.length > 3 && !base.includes(w));
  return Array.from(new Set([...base, ...extra])).slice(0, 12);
}

export interface ProvenanceRow {
  assetId: string;
  fileName: string;
  kind: string;
  source: string;
  license: string;
  usedIn: string;
}

/** Asset + source + licence manifest (brief section 4). */
export function provenance(
  input: ProjectInput,
  assets: { id: string; name: string; kind: string; fileName: string; source: string; license: string; usedIn: { videoId: string; sceneId: string }[] }[],
  videoId: string,
): ProvenanceRow[] {
  const rows: ProvenanceRow[] = assets.map((a) => ({
    assetId: a.id,
    fileName: a.fileName,
    kind: a.kind,
    source: a.source,
    license: a.license,
    usedIn:
      a.usedIn.filter((u) => u.videoId === videoId).map((u) => u.sceneId).join(', ') ||
      (a.kind === 'logo' || a.kind === 'font' ? 'brand layer (all videos)' : 'not used in this video'),
  }));
  for (const ref of input.sourceReferences) {
    rows.push({ assetId: 'ref', fileName: ref, kind: 'source reference', source: 'operator supplied', license: 'see reference', usedIn: 'metadata only' });
  }
  for (const f of [...input.productShots, ...input.brollFiles]) {
    rows.push({ assetId: 'upload', fileName: f, kind: 'operator upload', source: 'project input', license: 'operator owned', usedIn: 'source material' });
  }
  return rows;
}

export function toCsv(rows: ProvenanceRow[]): string {
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  return ['asset_id,file,kind,source,license,used_in', ...rows.map((r) => [r.assetId, r.fileName, r.kind, r.source, r.license, r.usedIn].map(esc).join(','))].join('\n');
}
