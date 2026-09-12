/**
 * برآورد دقتِ رونویسیِ خودمان، بدون مرجع انسانی.
 *
 * سه موتورِ مستقلِ ردهٔ بالا همان بازه را می‌شنوند. جایی که هر سه یک چیز
 * بگویند تقریباً قطعاً درست است؛ نرخِ اختلافِ سونیوکس با اجماعِ دو موتور
 * دیگر، برآوردی از خطای ماست. این WER نیست — کف است، چون خطایی که هر سه
 * مشترکاً مرتکب شوند دیده نمی‌شود.
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
const START = Number(process.argv[4] ?? 300);
const DUR = Number(process.argv[5] ?? 240);

const PEERS = ["openai/gpt-transcribe", "microsoft/mai-transcribe-2"];

const clip = "/tmp/tri.mp3";
await run(ffmpeg, ["-y", "-ss", String(START), "-t", String(DUR), "-i", AUDIO,
  "-ac", "1", "-ar", "16000", "-b:a", "64k", clip]);
const bytes = await fs.readFile(clip);

// مرجعِ سونیوکس، با یک ثانیه حاشیه در دو سر تا توکنِ نصفه‌شده نداشته باشیم
const raw = JSON.parse(await fs.readFile(path.join(config.dataDir, "cache", CACHE), "utf8"));
const toks = raw.transcript.tokens.filter((t) => t.start_ms >= START * 1000 - 1000 && t.start_ms < (START + DUR) * 1000 + 1000);
const soniox = toks.map((t) => t.text).join("");
const conf = toks.map((t) => t.confidence).filter((n) => typeof n === "number");

const norm = (s) => s
  .replace(/[‌‏‎]/g, " ")
  .replace(/[أإآا]/g, "ا").replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/ۀ/g, "ه")
  .replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);

/** نسبتِ طولانی‌ترین زیردنبالهٔ مشترک — تقریبِ همسانیِ دو رونوشت */
function lcsRatio(a, b) {
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return 0;
  let prev = new Uint32Array(B.length + 1), cur = new Uint32Array(B.length + 1);
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[B.length] / Math.max(A.length, B.length);
}

async function transcribe(model) {
  const fd = new FormData();
  fd.set("file", new Blob([bytes], { type: "audio/mpeg" }), "clip.mp3");
  fd.set("model", model);
  fd.set("language", "fa");
  const r = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` }, body: fd,
  });
  const body = await r.text();
  if (!r.ok) return { model, err: `HTTP ${r.status} ${body.slice(0, 150)}` };
  try { return { model, text: JSON.parse(body).text ?? "" }; }
  catch { return { model, err: body.slice(0, 150) }; }
}

console.log(`فایل ${path.basename(AUDIO)} · از ثانیهٔ ${START} به مدت ${DUR}`);
console.log(`سونیوکس: ${words(soniox).length} کلمه · میانگین اطمینان ${(conf.reduce((a, b) => a + b, 0) / conf.length).toFixed(3)}`);

const out = [];
for (const m of PEERS) {
  const r = await transcribe(m);
  if (r.err) { console.log(`\n■ ${m} → ${r.err}`); continue; }
  out.push(r);
  console.log(`\n■ ${m}: ${words(r.text).length} کلمه`);
  console.log(`   همسانی با سونیوکس: ${(lcsRatio(soniox, r.text) * 100).toFixed(1)}٪`);
}
if (out.length === 2) {
  console.log(`\nهمسانی دو موتور مستقل با هم: ${(lcsRatio(out[0].text, out[1].text) * 100).toFixed(1)}٪`);
  console.log("\nنمونهٔ سه‌طرفه ────────────");
  console.log("سونیوکس :", norm(soniox).slice(0, 200));
  console.log(out[0].model.padEnd(9).slice(0, 9), ":", norm(out[0].text).slice(0, 200));
  console.log(out[1].model.padEnd(9).slice(0, 9), ":", norm(out[1].text).slice(0, 200));
}
