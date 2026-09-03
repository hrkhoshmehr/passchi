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

// ─── کلاینت و سرور روی یک عدد توافق دارند ───────────────────────────────────
{
  const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const m = appJs.match(/const CHUNK_BYTES = (\d+) \* 1024 \* 1024/);
  ok("اندازهٔ تکه در app.js پیدا شد", Boolean(m));
  if (m) {
    ok(
      "اندازهٔ تکه از سقف آپلود کوچک‌تر است",
      Number(m[1]) * 1024 * 1024 < 500 * 1024 * 1024,
      `تکه ${m[1]} مگابایت`,
    );
  }
  // مسیر تکه‌تکه باید واقعاً صدا زده شود، وگرنه همهٔ این‌ها کد مرده است.
  ok("app.js مسیر تکه‌تکه را صدا می‌زند", appJs.includes("uploadChunked("));
  /**
   * **برای هر حجمی، نه فقط فایل بزرگ.**
   *
   * شاخهٔ `file.size > CHUNK_BYTES` برداشته شد: داشتنِ دو مسیر یعنی یکی‌شان
   * کم‌آزموده می‌ماند، و وقتی وب‌ویوی بله نسخهٔ کهنهٔ `app.js` را اجرا کرد
   * همان مسیرِ یک‌تکه بود که فایل ۱۷ مگابایتی را از اول شروع کرد.
   */
  ok("برای هر حجمی، نه فقط بزرگ", !/file\.size > CHUNK_BYTES/.test(appJs));
  ok(
    "شمارندهٔ خطا مشترک است تا درجازدن بی‌پایان نشود",
    /MAX_STRIKES/.test(appJs) && /strikes = 0/.test(appJs),
  );
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad === 0 ? "\n🎉 همه سبز" : `\n💥 ${bad} مورد قرمز`);
process.exit(bad === 0 ? 0 : 1);
