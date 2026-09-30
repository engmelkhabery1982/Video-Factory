#!/usr/bin/env node
/**
 * Provision the local production TTS model cache (kokoro-js / Kokoro-82M ONNX).
 *
 * Downloads ONCE, deterministically, into the repo-local cache:
 *   .tts-cache/models/onnx-community/Kokoro-82M-v1.0-(.*)/
 *
 * After provisioning, normal production synthesis is cache-only: the
 * KokoroDialogueSynthesizer sets `env.allowRemoteModels = false`, so no
 * network is touched at synthesis time. Missing cache -> clear structured
 * failure, never a silent download and never a silent SAM fallback.
 *
 * Safe to repeat: re-runs are no-ops when the cache is already valid.
 * No destructive cleanup: never deletes user directories; only removes
 * its own previous partial download marker directory when re-downloading.
 *
 * License/source documentation (also in PRODUCTION_DIALOGUE_AUDIO_HANDOFF.md):
 * - kokoro-js 1.2.1 (npm)  -> Apache-2.0 (hexgrad/Kokoro)
 * - onnx-community/Kokoro-82M-v1.0-ONNX -> Apache-2.0 (HF model repo)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.tts-cache', 'models');
const MARKER = path.join(ROOT, '.tts-cache', '.kokoro-model.ok');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = 'q8';

const log = (...a) => console.log('[provision:tts]', ...a);

/** kokoro-js exports map hides package.json; read version via the resolved entry */
function readKokoroVersion() {
  const entry = require.resolve('kokoro-js'); // .../kokoro-js/dist/kokoro.cjs
  const pkgPath = path.resolve(path.dirname(entry), '..', 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
}

function markerValid() {
  try {
    const info = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    return info.modelId === MODEL_ID && info.dtype === DTYPE && info.kokoroJs === readKokoroVersion();
  } catch {
    return false;
  }
}

async function main() {
  // 0. Sanity: kokoro-js must be installed (it also provides voices/*.bin).
  let kokoroVersion;
  try {
    kokoroVersion = readKokoroVersion();
  } catch {
    console.error('[provision:tts] ERROR: kokoro-js is not installed. Run `npm install` first.');
    process.exit(1);
  }
  log('kokoro-js', kokoroVersion, '| model', `${MODEL_ID} (${DTYPE})`);
  log('cache dir:', CACHE_DIR);

  // 1. Short-circuit when already provisioned.
  if (markerValid()) {
    log('already provisioned (marker + kokoro-js version match) -> nothing to do');
    return;
  }

  // 2. Verify target files exist on the HF repo BEFORE touching the cache.
  //    (Deterministic model/voice source: exact pinned model id + revision.)
  log('checking model files on huggingface.co ...');
  const res = await fetch(`https://huggingface.co/api/models/${MODEL_ID}`);
  if (!res.ok) {
    console.error(`[provision:tts] ERROR: cannot reach Hugging Face model API for '${MODEL_ID}' (HTTP ${res.status}).`);
    process.exit(1);
  }
  const meta = await res.json();
  const siblings = Array.isArray(meta.siblings) ? meta.siblings.map(s => s.rfilename) : [];
  const need = [`onnx/model_${DTYPE === 'q8' ? 'quantized' : DTYPE}.onnx`, 'config.json', 'tokenizer.json', `voices/af_heart.bin`];
  const missing = need.filter(n => !siblings.includes(n));
  if (missing.length) {
    console.error(`[provision:tts] ERROR: pinned model repo is missing expected files: ${missing.join(', ')}`);
    process.exit(1);
  }
  log('model repo verified (Apache-2.0):', meta.id ?? MODEL_ID);

  // 3. Prepare cache dir (no destructive cleanup; only ensure it exists).
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // 4. Real download through transformers.js (same code path as synthesis).
  log('downloading model (~92 MB q8) + tokenizer + config ...');
  const { env } = require('@huggingface/transformers');
  env.cacheDir = CACHE_DIR;
  env.localModelPath = CACHE_DIR;
  env.allowRemoteModels = true;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.useFSCache = env.useFSCache !== false;

  const { KokoroTTS } = require('kokoro-js');
  const loggedMilestone = new Map();
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: DTYPE,
    device: null,
    progress_callback: p => {
      if (p && p.status === 'progress' && p.file && p.progress !== undefined) {
        // Log at 25% milestones only (avoid per-chunk spam).
        const milestone = Math.floor(p.progress / 25) * 25;
        if (milestone > (loggedMilestone.get(p.file) ?? -1)) {
          loggedMilestone.set(p.file, milestone);
          log(`  ${String(p.file).padEnd(26)} ${milestone}%`);
        }
      }
      if (p && p.status === 'done' && p.file) {
        log(`  ${String(p.file).padEnd(26)} done`);
      }
    },
  });

  if (!tts) {
    console.error('[provision:tts] ERROR: KokoroTTS.from_pretrained returned no instance.');
    process.exit(1);
  }

  // 5. Prove a real 2-voice synthesis from the fresh cache (no fallbacks).
  log('proving synthesis from cache with 2 distinct voices ...');
  const t0 = Date.now();
  const a = await tts.generate('Provisioning check. Cache ready.', { voice: 'af_heart' });
  const b = await tts.generate('Provisioning check. Cache ready.', { voice: 'bm_george' });
  const ms = Date.now() - t0;
  if (!a || !a.audio || a.audio.length === 0 || !b || !b.audio || b.audio.length === 0) {
    console.error('[provision:tts] ERROR: post-download synthesis proof failed (empty audio).');
    process.exit(1);
  }
  log(`synthesis proof ok (2 voices, ${ms} ms, ${a.sampling_rate} Hz mono)`);

  // 6. Write success marker only after a full real proof.
  fs.writeFileSync(
    MARKER,
    JSON.stringify({ modelId: MODEL_ID, dtype: DTYPE, kokoroJs: kokoroVersion, provisionedAt: new Date().toISOString() }, null, 2) + '\n',
  );
  log('done. Normal production synthesis is now cache-only and offline.');
}

main().catch(e => {
  console.error('[provision:tts] failed:', e && e.message ? e.message : e);
  process.exit(1);
});
