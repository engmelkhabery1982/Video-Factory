/**
 * Generates the demo narration tracks into data/voiceover/.
 *
 * Why this exists: `npm run demo` needs one narration file per demo project at
 * data/voiceover/<VideoId>.mp3. Those are user content, so `data/` is gitignored
 * and they cannot be shipped in the repository - a fresh clone would fail with
 * "Missing narration". This script makes the demo reproducible instead: it
 * reads the three demo scripts and synthesises a local narration track for
 * each, so `npm run demo` works immediately after `npm install`.
 *
 * The synthesiser is SAM (Software Automatic Mouth, 1982) compiled to
 * JavaScript. It is a very old, very recognisable voice - it is here so the
 * pipeline can be exercised end to end offline, NOT because it sounds good.
 * Real users record their own narration and upload it through the UI; the
 * pipeline treats any MP3 or WAV the same way.
 *
 * If you already have narration, drop your own files at those exact paths and
 * this script will leave them alone.
 *
 * Target-specific narration (Phase 0): besides the Long track
 * (<VideoId>.mp3, spoken from the full script) every enabled Short gets its
 * OWN track, <VideoId>_short_N.mp3, spoken from that Short's scene narration in
 * scene order. A Short is never made by trimming the Long audio. Next to each
 * Short track a <VideoId>_short_N.txt records the exact text that was spoken,
 * so the demo runner can prove audio, captions and scenes describe the same
 * Short (and regenerate the track if the storyboard text changes).
 *
 * Usage:  npm run voiceovers [-- --only Video_01] [-- --out <dir>]
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const OUT_DIR = path.resolve(argOf('--out') ?? process.env.VOICEOVER_OUT ?? path.join(ROOT, 'data', 'voiceover'));
const ONLY = argOf('--only');
/** Shorts must fit the 20-35s Short window; leave headroom for the tail. */
const SHORT_MAX_SEC = 34;
/**
 * Realistic timing contract. A Short is voiced at the natural demo speed and
 * may be nudged at most ~10% faster (SAM speed 62 -> 56). Anything that still
 * does not fit, or that would exceed SHORT_MAX_WPS, is a script problem and
 * fails loudly - the voice is never accelerated to hide excess text, and
 * spoken text is never cut.
 */
const SHORT_FASTEST_SPEED = 56;
const SHORT_MAX_WPS = 3.2;

const FFMPEG = (() => {
  try {
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch {
    return 'ffmpeg';
  }
})();

const SAMPLE_RATE = 22050; // SAM's native output rate
/**
 * Voice settings. Note SAM's `speed` is inverted: LOWER is faster, and 72 is
 * the documented default. 62 lands these three scripts at 89-94s, which keeps
 * the Long video inside its intended 45-180s window without the render taking
 * three times as long.
 */
const VOICE = { speed: 62, pitch: 64, throat: 128, mouth: 128 };

/** SAM has no digit or percent vocabulary - spell them out so they are spoken. */
function speakable(text) {
  return text
    .replace(/%/g, ' percent')
    .replace(/(\d)\.(\d)/g, '$1 point $2') // 59.5 -> 59 point 5
    .replace(/(\d+)-(\d+)/g, '$1 to $2')
    .replace(/&/g, ' and ')
    .replace(/\bvs\.?(?=\s)/gi, 'versus')
    .replace(/[—–]/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * 2;
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * Streams a paragraph at a time; SAM's buffer is a fixed 256k window.
 * `script` is either a text with blank-line paragraphs (the Long) or an array
 * of paragraphs (a Short: one paragraph per scene, in scene order).
 */
function synthToWav(SamJs, script, outWav, voice = VOICE, pauses = { sentence: 0.12, paragraph: 0.3 }) {
  // the voice must be passed to the constructor; buf32() only takes the text
  const sam = new SamJs(voice);
  const paragraphs = (Array.isArray(script) ? script : script.split(/\n{2,}/))
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  const paragraphSamples = [];
  for (const [pi, p] of paragraphs.entries()) {
    const before = chunks.reduce((a, c) => a + c.length, 0);
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      const text = speakable(sentence);
      if (!text) continue;
      const res = sam.buf32(text);
      const samples = Array.isArray(res) ? res[0] : res;
      if (samples && samples.length) chunks.push(samples);
      // a short pause between sentences keeps the narration from running together
      const sp = typeof pauses.sentence === 'function' ? pauses.sentence(pi) : pauses.sentence;
      chunks.push(new Float32Array(Math.round(SAMPLE_RATE * sp)));
    }
    // a longer beat between paragraphs
    const gap = typeof pauses.paragraph === 'function' ? pauses.paragraph(pi) : pauses.paragraph;
    chunks.push(new Float32Array(Math.round(SAMPLE_RATE * gap)));
    // a beat too short to read gets a natural pause, never a stretched word
    const minSec = pauses.minParagraph ? pauses.minParagraph(pi) : 0;
    const have = chunks.reduce((a, c) => a + c.length, 0) - before;
    if (have < minSec * SAMPLE_RATE) chunks.push(new Float32Array(Math.round(minSec * SAMPLE_RATE - have)));
    paragraphSamples.push(chunks.reduce((a, c) => a + c.length, 0) - before);
  }

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const pcm = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const v = Math.max(-1, Math.min(1, c[i]));
      pcm[o++] = Math.round(v * 32767);
    }
  }

  const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  fs.writeFileSync(outWav, Buffer.concat([wavHeader(body.length), body]));
  synthToWav.lastParagraphSeconds = paragraphSamples.map((n) => n / SAMPLE_RATE);
  return total / SAMPLE_RATE;
}

function toMp3(wav, mp3) {
  // normalise to a delivery-friendly narration: 44.1k mono MP3
  execFileSync(
    FFMPEG,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', wav,
      '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', mp3],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  fs.rmSync(wav, { force: true });
}

/**
 * Synthesise one Short from its own scene narration (one paragraph per scene).
 * Returns the per-scene timing so the storyboard can align scenes and captions
 * to the words actually being spoken.
 */
function synthShort(SamJs, sceneTexts, mp3, label) {
  const wav = mp3.replace(/\.mp3$/, '.wav');
  const last = sceneTexts.length - 1;
  const pauses = {
    sentence: (i) => (i === 0 ? 0 : 0.08),
    // the hook must land inside 3s: no trailing beat after it
    paragraph: (i) => (i === 0 ? 0.02 : 0.12),
    // body beats are held for at least 1.5s so each visual can be read
    minParagraph: (i) => (i > 0 && i < last ? 1.55 : 0),
  };
  const words = sceneTexts.join(' ').split(/\s+/).filter(Boolean).length;
  let speed = VOICE.speed;
  let seconds = synthToWav(SamJs, sceneTexts, wav, { ...VOICE, speed }, pauses);
  while (seconds > SHORT_MAX_SEC && speed > SHORT_FASTEST_SPEED) {
    speed -= 2;
    seconds = synthToWav(SamJs, sceneTexts, wav, { ...VOICE, speed }, pauses);
  }
  const wps = words / seconds;
  if (seconds > SHORT_MAX_SEC || wps > SHORT_MAX_WPS) {
    fs.rmSync(wav, { force: true });
    throw new Error(
      `Short narration is too long: ${label} needs ${seconds.toFixed(1)}s for ${words} words ` +
        `(${wps.toFixed(2)} words/s at the fastest allowed voice). A Short must fit in ${SHORT_MAX_SEC}s at <= ${SHORT_MAX_WPS} words/s. ` +
        `Shorten the Short's scene narration; the voice will not be sped up further and text is never cut.`,
    );
  }
  const scenes = sceneTexts.map((text, i) => ({ text, duration: Number(synthToWav.lastParagraphSeconds[i].toFixed(3)) }));
  toMp3(wav, mp3);
  return { seconds, speed, wps, scenes };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { DEMO_PROJECTS } = await import('../tests/fixtures/demo-projects.js');
  const { buildStoryboard, emptyHistory, targetNarration } = await import('../packages/core/src/index.js');
  const { default: SamJs } = await import('sam-js');

  console.log(`Generating demo narration into ${path.relative(ROOT, OUT_DIR) || OUT_DIR}/\n`);

  for (const p of DEMO_PROJECTS) {
    if (ONLY && p.videoId !== ONLY) continue;

    /* ---- Long: the full script ---- */
    const mp3 = path.join(OUT_DIR, `${p.videoId}.mp3`);
    if (fs.existsSync(mp3) && fs.statSync(mp3).size > 0) {
      console.log(`  [skip] ${p.videoId}.mp3 already exists - leaving your file alone`);
    } else {
      const wav = path.join(OUT_DIR, `${p.videoId}.wav`);
      const seconds = synthToWav(SamJs, p.script, wav);
      toMp3(wav, mp3);
      const kb = Math.round(fs.statSync(mp3).size / 1024);
      console.log(`  [ok]   ${p.videoId}.mp3  ${seconds.toFixed(1)}s  ${kb} KB  "${p.topic}"`);
    }

    /* ---- Shorts: each from its OWN scene narration, in scene order ---- */
    // Short scene text does not depend on visual history or audio timing, so
    // an empty history yields the same narration the real storyboard uses
    // (the demo runner re-checks this against the .txt sidecar).
    const sb = buildStoryboard({ input: p, history: emptyHistory(), audioDuration: null });
    for (const plan of sb.shorts) {
      const stem = `${p.videoId}_${plan.id}`;
      const smp3 = path.join(OUT_DIR, `${stem}.mp3`);
      const txt = path.join(OUT_DIR, `${stem}.txt`);
      const timingFile = path.join(OUT_DIR, `${stem}.timing.json`);
      const spoken = targetNarration(plan.scenes);
      const upToDate = fs.existsSync(smp3) && fs.statSync(smp3).size > 0 && fs.existsSync(txt) && fs.readFileSync(txt, 'utf8').trim() === spoken && fs.existsSync(timingFile);
      if (upToDate) {
        console.log(`  [skip] ${stem}.mp3 already matches ${plan.id}'s scene narration`);
        continue;
      }
      const sceneTexts = plan.scenes.map((s) => (s.narration ?? '').trim());
      const { seconds, speed, wps, scenes } = synthShort(SamJs, sceneTexts, smp3, stem);
      fs.writeFileSync(txt, spoken + '\n', 'utf8');
      fs.writeFileSync(timingFile, JSON.stringify({ target: plan.id, durationSec: Number(seconds.toFixed(3)), wordsPerSec: Number(wps.toFixed(2)), speed, scenes }, null, 2), 'utf8');
      const kb = Math.round(fs.statSync(smp3).size / 1024);
      console.log(`  [ok]   ${stem}.mp3  ${seconds.toFixed(1)}s  ${kb} KB  speed ${speed}  ${wps.toFixed(2)} words/s  ${plan.scenes.length} scenes`);
    }
  }

  console.log('\nDone. Run `npm run demo` to build and export the three demo videos.');
  console.log('These are synthetic placeholder narrations. To use your own voice,');
  console.log('replace the files in data/voiceover/ with your own MP3 or WAV, using the');
  console.log('same file names: Video_01.mp3 (Long), Video_01_short_1.mp3 ... (one per Short).');
}

export { synthShort, SHORT_MAX_SEC, SHORT_MAX_WPS, SHORT_FASTEST_SPEED };

// run only when executed directly, so tests can import synthShort
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
}
