/**
 * گرفتن یک رونویسی *موجود* از حساب، بدون ساختن رونویسی تازه.
 *
 * چیزی حساب نمی‌شود: هزینه هنگام ساخت رونویسی گرفته می‌شود، نه هنگام
 * خواندن نتیجه‌اش. هیچ فایلی هم پاک نمی‌شود.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";

const id = process.argv[2];
if (!id) { console.error("استفاده: soniox-fetch.mjs <transcription-id> [cache-base]"); process.exit(1); }
const key = config.SONIOX_API_KEY;
const get = async (p) => {
  const r = await fetch(`https://api.soniox.com${p}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`${p} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

const meta = await get(`/v1/transcriptions/${id}`);
console.log("تنظیمات این رونویسی:");
for (const k of ["filename","model","status","audio_duration_ms","language_hints","enable_speaker_diarization","enable_language_identification","created_at","client_reference_id"]) {
  console.log(`  ${k.padEnd(32)} ${JSON.stringify(meta[k])}`);
}
if (meta.context) console.log("  context                          ", JSON.stringify(meta.context).slice(0, 200));

if (process.argv[3]) {
  const transcript = await get(`/v1/transcriptions/${id}/transcript`);
  const base = process.argv[3];
  const cacheDir = path.join(config.dataDir, "cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const prePath = path.join(cacheDir, `${base}.preprocess.json`);
  const pre = JSON.parse(await fs.readFile(prePath, "utf8").catch(() => "{}"));
  const out = path.join(cacheDir, `${base}.soniox.json`);
  await fs.writeFile(out, JSON.stringify({
    savedAt: new Date().toISOString(),
    fetchedExisting: id,
    model: meta.model,
    preprocess: pre,
    transcription: meta,
    transcript,
  }, null, 2), "utf8");
  console.log(`\n✅ ذخیره شد در ${out}`);
  console.log(`   ${transcript.tokens?.length ?? 0} توکن`);
}
