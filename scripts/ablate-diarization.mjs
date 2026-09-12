/**
 * آزمونِ جداسازی: همان رونوشت، یک بار با نقشِ گوینده و یک بار بدون آن.
 *
 * فقط یک متغیر عوض می‌شود — برچسبِ گوینده — پس هر تفاوتی در خروجی
 * مستقیماً به تفکیک گوینده نسبت داده می‌شود، نه به کیفیت رونویسی.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { buildTranscript } from "../src/stt/transcript.js";
import { analyzeClass } from "../src/analysis/analyze.js";
import { TimeMap } from "../src/audio/ffmpeg.js";
import { config } from "../src/config.js";

const cacheFile = process.argv[2];
if (!cacheFile) {
  console.error("usage: ablate-diarization.mjs <cacheFileName>");
  process.exit(1);
}

const raw = JSON.parse(await fs.readFile(path.join(config.dataDir, "cache", cacheFile), "utf8"));
const built = buildTranscript(raw.transcript.tokens, TimeMap.fromJSON(raw.preprocess?.timeMap));

// نسخهٔ «بدون تفکیک گوینده»: همهٔ پاره‌گفتارها یک گویندهٔ ناشناس می‌شوند.
// قطعه‌بندی دست نمی‌خورد تا فقط برچسب سنجیده شود، نه مرزها.
const blind = {
  ...built,
  speakers: [{ ...built.speakers[0], speakerId: "1", role: "نامشخص" }],
  utterances: built.utterances.map((u) => ({ ...u, speakerId: "1", role: "نامشخص" })),
};

const meta = { courseName: null, sessionDate: "۱۴۰۵/۶/۲۲", durationMs: raw.preprocess?.originalDurationMs ?? 0 };

function summarize(tag, out) {
  const r = out.report ?? out;
  const kp = r.key_points ?? [];
  const acts = (r.professor_actions ?? []).filter((a) => a.happened);
  const spk = {};
  for (const k of kp) {
    const s = k.evidence?.speaker ?? "(none)";
    spk[s] = (spk[s] ?? 0) + 1;
  }
  console.log(`\n──── ${tag} ────`);
  console.log("عنوان:", r.session_title);
  console.log("نکته‌ها:", kp.length, "· گویندهٔ نکته‌ها:", JSON.stringify(spk));
  console.log("حذف‌شده — بی‌نقل‌قول:", r.droppedCitations, "· تأییدنشده:", r.droppedUnverified, "· کم‌اهمیت:", r.droppedImportance);
  console.log("رویدادهای رخ‌داده:", acts.map((a) => a.action).join(", ") || "(هیچ)");
  for (const a of acts) {
    const q = a.evidence?.quote ?? "";
    console.log(`   • ${a.action} ← ${a.evidence?.speaker ?? "?"} : «${q.slice(0, 70)}»`);
  }
  console.log("سرفصل‌ها:", (r.chapters ?? []).length, "· واژه‌نامه:", (r.glossary ?? []).length);
  return { kp, acts, r };
}

console.log(`فایل: ${cacheFile}`);
console.log(`پاره‌گفتار: ${built.utterances.length} · گویندگان: ${built.speakers.length}`);
console.log(`سهم گویندهٔ اول: ${((built.speakers[0]?.speechMs ?? 0) / built.speakers.reduce((a, s) => a + s.speechMs, 0) * 100).toFixed(0)}%`);

const withD = await analyzeClass(built, meta, { skipNotes: true });
const a = summarize("با تفکیک گوینده", withD);

const withoutD = await analyzeClass(blind, meta, { skipNotes: true });
const b = summarize("بدون تفکیک گوینده", withoutD);

console.log("\n════ تفاوت ════");
console.log(`نکته‌ها: ${a.kp.length} → ${b.kp.length}`);
console.log(`رویدادها: ${a.acts.length} → ${b.acts.length}`);
const qa = new Set(a.kp.map((k) => (k.evidence?.quote ?? "").slice(0, 40)));
const qb = new Set(b.kp.map((k) => (k.evidence?.quote ?? "").slice(0, 40)));
const lost = [...qa].filter((q) => !qb.has(q));
const gained = [...qb].filter((q) => !qa.has(q));
console.log(`نکته‌های از‌دست‌رفته: ${lost.length}`, lost.slice(0, 4));
console.log(`نکته‌های تازه: ${gained.length}`, gained.slice(0, 4));
