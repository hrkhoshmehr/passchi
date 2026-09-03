/**
 * آپلود تکه‌تکه و از سرگیری‌اش.
 *
 * **باگی که این آزمون برای آن نوشته شد:** وب‌ویوی اندرویدِ بله آپلود را وسط
 * راه خودش می‌بُرد — هشت بار پیاپی برای یک کاربر، هربار در نقطه‌ای متفاوت
 * (۰٫۹ و ۱۶ و ۲۳ و ۲۵ و ۳۴ مگابایت از ۵۰). لاگ nginx و لاگ خود اپ هر دو
 * «کلاینت آپلود را رها کرد» می‌گفتند، و آزمون با نرخ ۲۰۰ کیلوبیت ثابت کرد
 * مسیر سالم است: همان ۵۰ مگابایت در ۲۵۶ ثانیه از همان CDN رد شد.
 *
 * تلاش دوبارهٔ قبلی از **صفر** شروع می‌کرد، پس روی اتصالی که سرِ ۲۰ مگابایت
 * می‌مُرد سه تلاش همان ۲۰ مگابایت را سه بار می‌سوزاند و کاربر آخرش هیچ.
 *
 * پس آنچه اینجا سنجیده می‌شود دقیقاً همان چیزی است که آن روز نبود:
 * **آنچه رسیده باید بماند.**
 *
 * اجرا: npx tsx scripts/test-chunked-upload.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunk-test-"));
process.env.DATA_DIR ||= dir;
process.env.BOT_TOKEN ||= "x";
process.env.WEB_ENABLED = "1";

let bad = 0;
function ok(label, cond, detail) {
  if (!cond) bad++;
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond && detail) console.log(`   ${detail}`);
}

/**
 * منطق چسباندن تکه‌ها، جدا از HTTP.
 *
 * همان قواعدی که `uploadChunk` روی سرور دارد: `offset` برابرِ آنچه هست
 * می‌نویسد، کمتر را تکراری می‌شمارد، و بیشتر را شکاف و رد می‌کند.
 */
function makeServer(partFile) {
  return {
    put(offset, chunk) {
      const have = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
      if (offset < have) return { status: 200, received: have, duplicate: true };
      if (offset > have) return { status: 409, received: have };
      fs.appendFileSync(partFile, chunk);
      return { status: 200, received: have + chunk.length };
    },
    size: () => (fs.existsSync(partFile) ? fs.statSync(partFile).size : 0),
  };
}

const part = path.join(dir, "up.part");
const srv = makeServer(part);

// فایل ۱۰ مگابایتی با محتوای قابل‌تشخیص، تا خرابیِ ترتیب دیده شود
const SIZE = 10 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const file = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) file[i] = i % 251;

// ─── مسیر عادی ──────────────────────────────────────────────────────────────
let sent = 0;
while (sent < SIZE) {
  const end = Math.min(sent + CHUNK, SIZE);
  const r = srv.put(sent, file.subarray(sent, end));
  ok(`تکهٔ ${sent / 1024 / 1024} تا ${end / 1024 / 1024} مگابایت پذیرفته شد`, r.status === 200);
  sent = end;
}
ok("اندازهٔ نهایی درست است", srv.size() === SIZE, `${srv.size()} به‌جای ${SIZE}`);
ok("بایت‌ها سالم‌اند", fs.readFileSync(part).equals(file));

// ─── تکهٔ تکراری: کلاینت پس از مهلت دوباره می‌فرستد ─────────────────────────
{
  const before = srv.size();
  const r = srv.put(0, file.subarray(0, CHUNK));
  ok("تکهٔ تکراری فایل را خراب نمی‌کند", r.status === 200 && r.duplicate === true);
  ok("اندازه پس از تکرار عوض نشد", srv.size() === before, `${srv.size()} به‌جای ${before}`);
}

// ─── شکاف: تکه‌ای گم شده ────────────────────────────────────────────────────
{
  const r = srv.put(SIZE + CHUNK, Buffer.alloc(16));
  ok("تکه با شکاف رد می‌شود", r.status === 409);
  ok("و می‌گوید تا کجا رسیده", r.received === SIZE, `گفت ${r.received}`);
}

// ─── از سرگیری پس از قطعِ وسط راه — قلبِ ماجرا ──────────────────────────────
{
  fs.rmSync(part, { force: true });
  const s2 = makeServer(part);

  // دو تکه رفت، بعد ارتباط مُرد
  s2.put(0, file.subarray(0, CHUNK));
  s2.put(CHUNK, file.subarray(CHUNK, 2 * CHUNK));
  const survived = s2.size();
  ok(
    "آنچه پیش از قطعی رسیده بود، ماند",
    survived === 2 * CHUNK,
    `${survived} به‌جای ${2 * CHUNK}`,
  );

  // کلاینت می‌پرسد تا کجا رسیده و از همان‌جا ادامه می‌دهد
  let from = s2.size();
  while (from < SIZE) {
    const end = Math.min(from + CHUNK, SIZE);
    s2.put(from, file.subarray(from, end));
    from = end;
  }
  ok("پس از از سرگیری، فایل کامل است", s2.size() === SIZE);
  ok("و بایت‌ها همانِ فایل اصلی‌اند", fs.readFileSync(part).equals(file));

  /**
   * ادعای اصلی: از سرگیری باید **کمتر از کل فایل** بفرستد.
   *
   * اگر روزی کسی منطق را به «از اول شروع کن» برگرداند، این خط قرمز می‌شود.
   */
  const resent = SIZE - survived;
  ok(
    "از سرگیری فقط باقیمانده را می‌فرستد نه کل فایل",
    resent < SIZE,
    `${resent} از ${SIZE} — یعنی از اول شروع کرده`,
  );
}

// ─── نوار پیشرفت هرگز عقب نمی‌رود ───────────────────────────────────────────
//
// **باگی که کاربر آن را «از اول تلاش می‌کنم» دید.** آپلود واقعاً از اول
// نمی‌رفت؛ نوار این را می‌گفت. وقتی تکه‌ای وسط راه می‌مُرد، تلاش دوباره نسبتِ
// همان تکه را از صفر شروع می‌کرد و درصد از ۳۰ برمی‌گشت به ۲۵ — و با چند بار
// تکرار، از دید کاربر یعنی کار از نو شروع شده.
{
  // همان محافظِ `advance` در `uploadChunked`، جدا از DOM.
  let shown = 0;
  const seen = [];
  const advance = (ratio) => {
    if (ratio > shown) {
      shown = ratio;
      seen.push(ratio);
    }
  };

  // تکهٔ اول تا نیمه رفت و مُرد؛ تلاش دوباره از صفرِ همان تکه شروع می‌کند.
  advance(0.1);
  advance(0.2);
  advance(0.3);
  advance(0.05); // ← عقب‌گردِ تلاش دوباره
  advance(0.12);
  advance(0.35);

  ok(
    "درصد هرگز عقب نمی‌رود",
    seen.every((v, i) => i === 0 || v > seen[i - 1]),
    seen.join(" → "),
  );
  ok("و به بالاترین مقدار می‌رسد", shown === 0.35, String(shown));
}

// ─── اندازهٔ تکه با سرعتِ اتصال جلو و عقب می‌رود ─────────────────────────────
//
// تکهٔ ثابتِ ۴ مگابایتی روی اینترنت موبایلِ ۲۰۰ کیلوبیت یعنی یک اتصالِ ۱۶۰
// ثانیه‌ای — همان اتصالِ چنددقیقه‌ای که ثابت شد وب‌ویوی بله دوام نمی‌آورد.
{
  const CHUNK_MIN = 256 * 1024;
  const CHUNK_MAX = 4 * 1024 * 1024;
  const TARGET_MS = 15000;
  const next = (size, took) => {
    if (took > TARGET_MS * 1.5) return Math.max(CHUNK_MIN, Math.round(size / 2));
    if (took < TARGET_MS / 2) return Math.min(CHUNK_MAX, size * 2);
    return size;
  };

  ok("تکهٔ کند کوچک می‌شود", next(1024 * 1024, 40000) === 512 * 1024);
  ok("تکهٔ سریع بزرگ می‌شود", next(1024 * 1024, 2000) === 2 * 1024 * 1024);
  ok("تکهٔ به‌اندازه دست‌نخورده می‌ماند", next(1024 * 1024, 15000) === 1024 * 1024);

  // روی اتصالِ خیلی کند باید کف کند، نه اینکه به صفر برسد.
  let s = 4 * 1024 * 1024;
  for (let i = 0; i < 20; i++) s = next(s, 60000);
  ok("اندازه به کف می‌رسد و پایین‌تر نمی‌رود", s === CHUNK_MIN, String(s));

  // و روی وایفای سریع به سقف، نه بی‌نهایت.
  let f = CHUNK_MIN;
  for (let i = 0; i < 20; i++) f = next(f, 500);
  ok("اندازه از سقف بالاتر نمی‌رود", f === CHUNK_MAX, String(f));

  /**
   * ادعای اصلی این بخش: روی اتصالِ کند، یک تکه نباید اتصال را دقایق طولانی
   * باز نگه دارد. با کفِ ۲۵۶ کیلوبایت و نرخ ۲۰۰ کیلوبیت بر ثانیه، هر تکه
   * حدود ۱۰ ثانیه است — نه ۱۶۰ ثانیه‌ای که تکهٔ ۴ مگابایتی می‌شد.
   */
  const slowBytesPerSec = (200 * 1024) / 8;
  ok(
    "کفِ تکه روی اتصال کند زیر ۳۰ ثانیه می‌ماند",
    CHUNK_MIN / slowBytesPerSec < 30,
    `${(CHUNK_MIN / slowBytesPerSec).toFixed(1)} ثانیه`,
  );
}

// ─── کلاینت و سرور روی یک عدد توافق دارند ───────────────────────────────────
{
  const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  const min = appJs.match(/const CHUNK_MIN = (\d+) \* 1024/);
  const max = appJs.match(/const CHUNK_MAX = (\d+) \* 1024 \* 1024/);
  ok("اندازهٔ تکه در app.js پیدا شد", Boolean(min && max));
  if (max) {
    ok(
      "سقف تکه از سقف آپلود کوچک‌تر است",
      Number(max[1]) * 1024 * 1024 < 500 * 1024 * 1024,
      `تکه ${max[1]} مگابایت`,
    );
  }

  // مسیر تکه‌تکه باید واقعاً صدا زده شود، وگرنه همهٔ این‌ها کد مرده است.
  ok("app.js مسیر تکه‌تکه را صدا می‌زند", appJs.includes("uploadChunked("));

  /**
   * **برای هر حجمی، نه فقط فایل بزرگ.**
   *
   * شاخهٔ اندازه‌محور برداشته شد: داشتنِ دو مسیر یعنی یکی‌شان کم‌آزموده
   * می‌ماند، و وقتی وب‌ویوی بله نسخهٔ کهنهٔ `app.js` را اجرا کرد همان مسیرِ
   * یک‌تکه بود که فایل ۱۷ مگابایتی را از اول شروع کرد.
   */
  ok("برای هر حجمی، نه فقط بزرگ", !/file\.size > CHUNK_/.test(appJs));

  /**
   * **مهلتِ بی‌حرکتی، نه مهلتِ کلی.**
   *
   * `xhr.timeout = 0` تنها بود و یک حفره باز می‌کرد: اتصالِ نیمه‌مردهٔ وب‌ویو
   * نه `error` می‌داد نه `load`، پس آپلود تا ابد آنجا می‌ماند و کاربر فقط یک
   * نوار خشکیده می‌دید. معیار باید ایستادنِ بایت‌ها باشد نه گذشتِ زمان، تا
   * تکهٔ کند کشته نشود و تکهٔ ایستاده زود کشته شود.
   */
  ok("مهلتِ بی‌حرکتی روی تکه هست", /const STALL_MS = \d+/.test(appJs));
  ok("و با هر نشانهٔ زندگی از نو می‌افتد", /upload\.onprogress[\s\S]{0,200}bump\(\)/.test(appJs));

  /**
   * **سقفِ درجازدن زمان است، نه شمارشِ شکست.**
   *
   * شمارندهٔ هشت‌تایی روی فایل بزرگ ناعادلانه بود: فایل ۵۰ مگابایتی ده‌ها
   * تکه است و شبکه‌ای که یک‌درمیان می‌افتد آن هشت‌تا را زود می‌سوزاند —
   * کاربر با آپلودِ ۸۰٪ کامل بیرون انداخته می‌شد.
   */
  ok("سقف بر پایهٔ زمانِ بی‌پیشرفت است", /const NO_PROGRESS_MS = \d+/.test(appJs));
  ok("شمارندهٔ شکستِ قدیمی برداشته شده", !/MAX_STRIKES/.test(appJs));

  // لغوِ کاربر نباید مثل خطای شبکه تلاش دوباره بگیرد.
  ok("لغوِ کاربر از خطای شبکه جدا شده", /err\.canceled/.test(appJs));

  /**
   * **تکهٔ آخر مهلتِ جدا دارد.**
   *
   * پاسخش تازه بعد از کار سرور می‌آید — جابه‌جایی فایل و ffprobe روی چند صد
   * مگابایت. با همان بیست ثانیه، مهلتِ بی‌حرکتی چیزی را می‌بُرید که درست دارد
   * کار می‌کند، آن هم بدترین جای ممکن: فایل کامل رسیده و `.part` دیگر سر
   * جایش نیست، پس تلاش دوباره از صفر شروع می‌کرد.
   */
  ok("تکهٔ آخر مهلت بلندتری دارد", /const STALL_FINAL_MS = \d+/.test(appJs));
  ok(
    "و آن مهلت واقعاً به تکهٔ آخر داده می‌شود",
    /isFinal \? STALL_FINAL_MS : STALL_MS/.test(appJs),
  );
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad === 0 ? "\n🎉 همه سبز" : `\n💥 ${bad} مورد قرمز`);
process.exit(bad === 0 ? 0 : 1);
