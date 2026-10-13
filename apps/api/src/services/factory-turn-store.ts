/**
 * Durable per-turn speech cache (Milestone 3). Independent of the project transaction.
 *
 * A successful, validated Gemini turn is saved here the moment it is received, before any
 * later step of an apply can fail. A rolled-back apply removes the library asset and the
 * project, but never these clips, so a retry does not pay for a turn that already succeeded.
 *
 * Identity: the key covers provider, model, voice, language, style and the exact text
 * (see geminiClipKey). Reuse needs the key, the file SHA-256, the byte count and a valid WAV
 * whose duration matches the record. Anything else is treated as missing and the turn is requested again.
 *
 * Clips here are private and unapproved. They reach the library only when an apply adopts them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseWav } from '@buildtrack/core';
import { DATA_DIR } from './platform.js';

export interface TurnEntry {
  key: string;
  sha256: string;
  bytes: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  model: string;
  voice: string;
  language: 'ar' | 'en';
  style: string;
  textSha256: string;
  createdAt: string;
  /** Always false until an owner approves the audio. */
  approved: false;
}

export interface StoredTurn extends TurnEntry {
  bytesData: Uint8Array;
}

const turnDir = () => path.join(DATA_DIR, 'factory', 'ai', 'turns');
const indexFile = () => path.join(turnDir(), 'index.json');
const SAFE_KEY = /^[a-f0-9]{64}$/;

function readIndex(): Record<string, TurnEntry> {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), 'utf8')) as Record<string, TurnEntry>;
  } catch {
    return {};
  }
}

function writeAtomic(file: string, data: string | Uint8Array) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Verified lookup. Returns null for any mismatch, so the caller requests the turn again. */
export function lookupTurn(key: string): StoredTurn | null {
  if (!SAFE_KEY.test(key)) return null;
  const entry = readIndex()[key];
  if (!entry || entry.approved !== false) return null;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(turnDir(), `${key}.wav`));
  } catch {
    return null;
  }
  if (bytes.byteLength !== entry.bytes) return null;
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return null;
  let wav;
  try {
    wav = parseWav(bytes);
  } catch {
    return null;
  }
  if (wav.durationSec === null || Math.abs(wav.durationSec - entry.durationSec) > 0.01) return null;
  return { ...entry, bytesData: new Uint8Array(bytes) };
}

/** Saves one validated turn durably. Called as soon as the provider's audio passed validation. */
export function saveTurn(key: string, clip: { bytes: Uint8Array; durationSec: number; sampleRate: number; channels: number; model: string; voice: string; language: 'ar' | 'en'; style: string; textSha256: string }): TurnEntry {
  if (!SAFE_KEY.test(key)) throw new Error('turn key must be a sha256 hex string');
  const sha256 = createHash('sha256').update(clip.bytes).digest('hex');
  writeAtomic(path.join(turnDir(), `${key}.wav`), clip.bytes);
  const entry: TurnEntry = {
    key,
    sha256,
    bytes: clip.bytes.byteLength,
    durationSec: clip.durationSec,
    sampleRate: clip.sampleRate,
    channels: clip.channels,
    model: clip.model,
    voice: clip.voice,
    language: clip.language,
    style: clip.style,
    textSha256: clip.textSha256,
    createdAt: new Date().toISOString(),
    approved: false,
  };
  const index = readIndex();
  index[key] = entry;
  writeAtomic(indexFile(), JSON.stringify(index, null, 2));
  return entry;
}

/** Count of stored turns, for the QA evidence summary. Never lists text. */
export function storedTurnCount(): number {
  return Object.keys(readIndex()).length;
}
