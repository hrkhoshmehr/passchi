/**
 * لنگرِ سرفصل‌ها روی رونوشتِ واقعی.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * `anchorTopics` بیشینهٔ سراسری می‌گرفت و تا رسیدن به نمرهٔ ۰٫۶ جلو می‌رفت.
 * ولی پاره‌گفتارها کوتاه‌اند و هیچ‌کدام هر پنج اصطلاحِ یک سرفصل را ندارند،
 * پس آن آستانه عملاً هرگز نمی‌خورد و حلقه تا ته رونوشت می‌رفت — آنجا یک
 * پاره‌گفتارِ بلندِ جمع‌بندیِ آخرِ کلاس چند اصطلاح را کنار هم دارد و برنده
 * می‌شد.
 *
 * روی همین کلاس ۹۴ دقیقه‌ایِ حقوق مدنی ۳ نتیجه‌اش این بود: «محدوده درس و
 * تعریف عقد» که واقعاً دقیقهٔ ۱۴ گفته شده به دقیقهٔ ۸۲ رفت، و سه سرفصل بعدی
 * با آبشارِ «قبلی + ۴۵ ثانیه» پشتش چیده شدند (۸۴، ۸۶، ۸۷). یعنی نیمهٔ دوم
 * فهرست، عددهای ساختگی بودند — و کاربر رویشان می‌زند و صوت جای دیگری است.
 *
 * پس اینجا سه سرفصلِ واقعی با زمانِ دستی‌خواندهٔ خودشان سنجیده می‌شوند، و یک
 * موردِ چهارم با `start_ms` عمداً غلط: لنگر باید حدسِ پرتِ مدل را هم به جای
 * درست برگرداند، نه اینکه دنبالش برود.
 *
 * اجرا: npx tsx scripts/test-topic-anchor.mjs
 */
import fs from "node:fs";
import { anchorTopics } from "../src/stt/transcript.ts";
import { normalizeFa } from "../src/util/text.ts";

const TXT = "data/out/1920a3872f59.transcript.txt";
const DURATION_MS = 5_621_249;

if (!fs.existsSync(TXT)) {
  console.log(`⏭️ رونوشت نیست: ${TXT} — آزمون رد شد`);
  process.exit(0);
}

/**
 * رونوشتِ `.txt` را به همان شکلی می‌خواند که `buildTranscript` می‌سازد.
 *
 * چرا از txt و نه از کش: فایل کش هفت مگابایت است و در مخزن نیست، ولی همین
 * رونوشتِ متنی هست و برای لنگرِ سرفصل — که فقط به متن و زمانِ شروع نگاه
 * می‌کند — دقیقاً همان اطلاعات را دارد.
 */
function parseTranscript(text) {
  const utterances = [];
  for (const line of text.split("\n")) {
    const m = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*([^:]+):\s*([\s\S]*)$/.exec(line.trim());
    if (!m) continue;
    const startMs = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
    const body = m[5].trim();
    if (!body) continue;
    utterances.push({
      index: utterances.length,
      startMs,
      endMs: startMs,
      speakerId: "1",
      role: m[4].trim() === "استاد" ? "استاد" : "نامشخص",
      text: body,
      confidence: 1,
      normalized: normalizeFa(body),
    });
  }
  return { utterances, speakers: [], totalSpeechMs: 0, words: 0, lowConfidenceRatio: 0 };
}

const t = parseTranscript(fs.readFileSync(TXT, "utf8"));

const min = (m) => m * 60_000;

/**
 * سرفصل اول عمداً «معرفی درس» است و سنجیده نمی‌شود: قاعده این است که سرفصل
 * اول همیشه روی صفر می‌نشیند، پس اگر موردِ آزمون اولین باشد چیزی را نمی‌سنجد.
 */
const topics = [
  { title: "معرفی درس و منابع", terms: ["کاتوزیان", "شهیدی", "اعمال حقوقی"], start_ms: 0 },
  {
    title: "محدوده درس و تعریف عقد",
    terms: ["ماده ۱۸۳", "ماده ۳۰۰", "عقد", "توافق", "اثر حقوقی"],
    start_ms: 840_000,
    want: [min(13), min(17)],
  },
  {
    title: "الزامات و تعهدات",
    terms: ["الزامات", "تعهدات", "التزام", "الزامات قراردادی", "الزامات خارج از قرارداد"],
    start_ms: min(52),
    want: [min(50), min(57)],
  },
  {
    title: "نقد ماده ۱۸۳ قانون مدنی",
    terms: ["ماده ۱۸۳", "عقد عهدی", "عقد تملیکی", "جامع و مانع", "ضمانت اجرا"],
    start_ms: min(62),
    want: [min(60), min(66)],
  },
];

let bad = 0;
const clock = (ms) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const run = (list) => anchorTopics(t, list.map(({ title, terms, start_ms }) => ({ title, terms, start_ms })), DURATION_MS);

{
  const got = run(topics);
  topics.forEach((tp, i) => {
    if (!tp.want) return;
    const at = got[i];
    check(
      `«${tp.title}» بین ${clock(tp.want[0])} و ${clock(tp.want[1])}`,
      at >= tp.want[0] && at <= tp.want[1],
      clock(at),
    );
  });

  // هیچ سرفصلی نباید در ۱۰٪ آخر بیفتد — همان جایی که بیشینهٔ سراسری می‌بردشان
  check(
    "هیچ سرفصلی به ده درصد آخر پرتاب نشد",
    got.every((ms) => ms < DURATION_MS * 0.9),
    got.map(clock).join(" · "),
  );
  check("ترتیب زمانی حفظ شد", got.every((ms, i) => i === 0 || ms > got[i - 1]));
  check("هیچ دو سرفصلی یک زمان نگرفتند", new Set(got).size === got.length);
}

// ── حدسِ عمداً غلطِ مدل ──────────────────────────────────────────────────
//
// همان سرفصلِ دقیقهٔ ۱۴، این بار با start_ms هشتاد دقیقه. جستجوی نزدیک
// (±۱۰ دقیقه) چیزی پیدا نمی‌کند، پس باید به گشتنِ کلِ رونوشت برگردد و باز
// همان دقیقهٔ ۱۴ را بدهد.
{
  const wrong = [
    topics[0],
    { ...topics[1], start_ms: 4_800_000 },
  ];
  const got = run(wrong);
  check(
    "start_ms غلطِ ۸۰ دقیقه‌ای هم به دقیقهٔ ۱۴ برمی‌گردد",
    got[1] >= min(13) && got[1] <= min(17),
    clock(got[1]),
  );
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
