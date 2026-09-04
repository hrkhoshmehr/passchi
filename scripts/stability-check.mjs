/**
 * پایداریِ استخراج را روی یک رونوشتِ ثابت اندازه می‌گیرد.
 *
 * ## چرا لازم شد
 *
 * کاربر یک صوت را دو بار فرستاد و یک بار «استاد تکلیف داد» درآمد و بار دیگر
 * نه. پنج اجرای ذخیره‌شده روی یک رونوشتِ بایت‌به‌بایت یکسان نشان داد نوسان
 * واقعی و بزرگ است: تعداد بخش‌ها ۲ تا ۷، و در یک اجرا هر پنج بخش داخل هفت
 * دقیقهٔ اولِ یک کلاس ۹۴ دقیقه‌ای.
 *
 * علتِ ریشه‌ای این بود که هیچ دمایی فرستاده نمی‌شد و مدل روی پیش‌فرضِ خودش
 * (۱٫۰) کار می‌کرد، و اینکه تقریباً هر نکته‌ای برچسب `emphasis` می‌خورد —
 * یعنی همان برچسبی که دروازهٔ تأکید رویش سخت‌گیر است. پس رسیدنِ «تکلیف» به
 * دانشجو به یک قرعه‌کشی بستگی داشت.
 *
 * **بعد از هر تغییر در پرامپت، اسکیما یا دما این را اجرا کن.** یک بار اجرا
 * هیچ چیزی ثابت نمی‌کند؛ کمینهٔ معنادار چهار پنج اجراست.
 *
 *   npx tsx scripts/stability-check.mjs [تعداد]
 *
 * رونویسی از کش خوانده می‌شود، پس فقط هزینهٔ مدل را می‌دهی — روی این کلاس
 * حدود ۰٫۰۱۴ دلار برای هر اجرا. جزوه ساخته نمی‌شود.
 */
import fs from "node:fs";
import { buildTranscript } from "../src/stt/transcript.ts";
import { analyzeClass } from "../src/analysis/analyze.ts";

const CACHE = "data/cache/class example.7c6a57d28c894bfb.soniox.json";
const N = Number(process.argv[2] ?? 5);

if (!fs.existsSync(CACHE)) {
  console.error(`رونوشتِ کش‌شده نیست: ${CACHE}\nیک بار خط لوله را روی «class example.m4a» اجرا کن تا ساخته شود.`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const t = buildTranscript(raw.transcript.tokens, { toOriginal: (ms) => ms, skippedMs: 0 });
const durationMs = raw.transcription?.audio_duration_ms ?? 94 * 60_000;

const meta = {
  courseName: "حقوق مدنی ۳",
  professorName: null,
  sessionDate: "۱۴۰۵/۰۶/۱۳",
  originalDurationMs: durationMs,
  silenceMs: 0,
  speakerSummary: "یک گوینده (استاد)",
  qualityNote: "",
};

/**
 * حقیقتِ زمینی، دستی از رونوشت خوانده شده:
 * استاد **مطالعهٔ دو کتاب را تکلیف کرده** (دقیقهٔ ۱ تا ۴) و گفته کتاب قانون
 * را سر جلسه همراه بیاورند (دقیقهٔ ۱۲). امتحان، کوییز، حضور و غیاب، بارم و
 * مهلتی در کار نبوده. یک تلهٔ عمدی هم هست: «هر کی قانون همراهش نباشه دو
 * نمره کم می‌کنم» را مطرح می‌کند و **همان‌جا ردش می‌کند** — نباید به‌عنوان
 * قاعدهٔ نمره‌دهی گزارش شود.
 */
const runs = [];
for (let i = 0; i < N; i++) {
  const { report } = await analyzeClass(t, meta, { skipNotes: true });
  const kp = report.key_points;
  const last = report.chapters.at(-1);
  const r = {
    n: kp.length,
    kinds: kp.map((k) => k.kind).sort().join(","),
    chapters: report.chapters.length,
    lastPct: last ? Math.round((last.start_ms / durationMs) * 100) : 0,
    homework: (report.professor_actions || []).some((a) => a.action === "homework" && a.happened),
    trap: kp.some((k) => /دو نمره/.test(k.evidence?.quote ?? "")),
    dropped: report.droppedCitations,
  };
  runs.push(r);
  console.log(
    `اجرا ${i + 1}: نکته ${r.n} · بخش ${r.chapters} · شروعِ بخش آخر ٪${r.lastPct} · ` +
      `تکلیف ${r.homework ? "بله" : "خیر"} · حذف‌شده ${r.dropped}`,
  );
  for (const k of kp) console.log(`   • [${k.kind}] ${k.title} ← «${(k.evidence?.quote ?? "").slice(0, 50)}»`);
}

const chs = runs.map((r) => r.chapters);
const hw = runs.filter((r) => r.homework).length;
const trap = runs.filter((r) => r.trap).length;

console.log(`\n— تکلیف «بله»: ${hw} از ${N}   (باید ${N} باشد)`);
console.log(`— تلهٔ «دو نمره»: ${trap} از ${N}   (باید صفر باشد)`);
console.log(`— بخش‌ها: ${chs.join(", ")}   (هیچ‌کدام نباید زیر ۴ باشد)`);
console.log(`— شروعِ بخش آخر: ${runs.map((r) => "٪" + r.lastPct).join(", ")}   (زیر ٪۲۵ یعنی زمان‌ها حدسی‌اند)`);
console.log(`— الگوهای متمایزِ نوع: ${new Set(runs.map((r) => r.kinds)).size} از ${N}`);

const failed = hw < N || trap > 0 || Math.min(...chs) < 4;
console.log(failed ? "\n❌ پایداری افت کرده" : "\n✅ پایدار");
process.exit(failed ? 1 : 0);
