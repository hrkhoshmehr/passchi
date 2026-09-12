/**
 * آزمون سرراست: یک بازهٔ پنج‌دقیقه‌ای از یک کلاس واقعی، از چند موتور ارزان
 * رد می‌شود و با رونوشتِ سونیوکسِ همان بازه سنجیده می‌شود.
 *
 * چیزی که سنجیده می‌شود: تعداد کلمه، وجود مهر زمانی، و اینکه نقل‌قول‌های
 * واقعیِ همان بازه با دروازهٔ ۰٫۷۵ پیدا می‌شوند یا نه.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { config } from "../src/config.js";

const run = promisify(execFile);

const AUDIO = process.argv[2];
const CACHE = process.argv[3];
const START = Number(process.argv[4] ?? 180);
const DUR = Number(process.argv[5] ?? 300);

const MODELS = [
  "qwen/qwen3-asr-1.7b",
  "qwen/qwen3-asr-0.6b",
  "openai/whisper-large-v3-turbo",
];

const clip = "/tmp/bakeoff.mp3";
await run(ffmpeg, ["-y", "-ss", String(START), "-t", String(DUR), "-i", AUDIO,
  "-ac", "1", "-ar", "16000", "-b:a", "48k", clip]);
const bytes = await fs.readFile(clip);
console.log(`بریده: ${(bytes.length / 1024).toFixed(0)} کیلوبایت · از ثانیهٔ ${START} به مدت ${DUR}`);

// ── مرجع: سونیوکس روی همان بازه ─────────────────────────────────────────
const raw = JSON.parse(await fs.readFile(path.join(config.dataDir, "cache", CACHE), "utf8"));
const lo = START * 1000, hi = (START + DUR) * 1000;
const refTokens = raw.transcript.tokens.filter((t) => t.start_ms >= lo && t.start_ms < hi);
const refText = refTokens.map((t) => t.text).join("").replace(/\s+/g, " ").trim();
const refWords = refText.split(/\s+/).filter(Boolean);
console.log(`مرجع سونیوکس: ${refWords.length} کلمه، ${refTokens.length} توکن`);
console.log(`نمونهٔ مرجع: ${refText.slice(0, 180)}…\n`);

// چند عبارتِ واقعی از مرجع، برای آزمونِ پیداشدن
const probes = [];
for (let i = 0; i + 12 < refWords.length && probes.length < 8; i += Math.floor(refWords.length / 9)) {
  probes.push(refWords.slice(i, i + 10).join(" "));
}

function norm(s) {
  return s.replace(/[‌‏]/g, " ").replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ").trim();
}
/** بیشینهٔ شباهتِ سه‌گانه‌ایِ عبارت با هر پنجره‌ای از متن */
function bestMatch(needle, hay) {
  const n = norm(needle).split(" "), h = norm(hay).split(" ");
  if (!n.length || !h.length) return 0;
  let best = 0;
  const set = new Set(n);
  for (let i = 0; i + n.length <= h.length; i++) {
    let hit = 0;
    for (let j = 0; j < n.length; j++) if (set.has(h[i + j])) hit++;
    best = Math.max(best, hit / n.length);
  }
  return best;
}

for (const model of MODELS) {
  const fd = new FormData();
  fd.set("file", new Blob([bytes], { type: "audio/mpeg" }), "clip.mp3");
  fd.set("model", model);
  fd.set("language", "fa");
  fd.set("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "segment");
  fd.append("timestamp_granularities[]", "word");

  const t0 = Date.now();
  let r, body;
  try {
    r = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
      body: fd,
    });
    body = await r.text();
  } catch (e) {
    console.log(`\n■ ${model} → خطای شبکه: ${String(e).slice(0, 120)}`);
    continue;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!r.ok) {
    console.log(`\n■ ${model} → HTTP ${r.status} در ${secs}s :: ${body.slice(0, 260)}`);
    continue;
  }
  let j;
  try { j = JSON.parse(body); } catch { console.log(`\n■ ${model} → پاسخ JSON نبود: ${body.slice(0, 200)}`); continue; }

  const text = (j.text ?? "").replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter(Boolean);
  const segs = j.segments?.length ?? 0;
  const wts = j.words?.length ?? 0;
  const scores = probes.map((p) => bestMatch(p, text));
  const pass = scores.filter((s) => s >= 0.75).length;

  console.log(`\n■ ${model}  (${secs}s)`);
  console.log(`   کلمه: ${words.length}  (مرجع ${refWords.length}، یعنی ${(words.length / refWords.length * 100).toFixed(0)}٪)`);
  console.log(`   مهر زمانی: بخش=${segs} کلمه=${wts}`);
  console.log(`   عبارت‌های پیداشده با دروازهٔ ۰٫۷۵: ${pass} از ${probes.length}`);
  console.log(`   میانگین شباهت: ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)}`);
  console.log(`   نمونه: ${text.slice(0, 180)}…`);
}
