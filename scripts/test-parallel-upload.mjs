/**
 * آپلود موازی — نوشتنِ بی‌ترتیب، و همهٔ راه‌هایی که می‌تواند خراب شود.
 *
 * **چرا این آزمون:** آپلود ترتیبی یک فرض ساده داشت که همه‌چیز رویش سوار بود —
 * «اندازهٔ فایل یعنی چقدر رسیده». موازی‌کاری آن فرض را می‌شکند: تکه‌ای که در
 * بایت ۸ مگابایت می‌نشیند فایل را ۸ مگابایتی می‌کند حتی اگر میانه‌اش نرسیده
 * باشد. فایل سوراخ دارد ولی اندازه‌اش می‌گوید کامل است.
 *
 * خطرِ واقعی همین است: صوتی که سوراخ دارد لزوماً خطا نمی‌دهد — می‌تواند
 * کوتاه‌تر یا خراب رونویسی شود، و کاربر بابتش سکه داده باشد. پس اینجا
 * سخت‌گیرانه سنجیده می‌شود که **هرگز فایلِ ناقص کامل اعلام نشود**.
 *
 * اجرا: node scripts/test-parallel-upload.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "par-test-"));

let bad = 0;
function ok(label, cond, detail) {
  if (!cond) bad++;
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond && detail) console.log(`   ${detail}`);
}

// ─── همان منطقِ بازه‌های سرور، جدا از HTTP ──────────────────────────────────
//
// عمداً از `src/web/server.ts` کپی شده نه import: آن فایل کل اپ را بالا
// می‌آورد (دیتابیس، پیکربندی، ربات). آنچه سنجیده می‌شود **قواعد** است، و
// آزمونِ زیر هر انحرافی را می‌گیرد چون همان ادعاها را روی فایل واقعی هم
// دوباره می‌سنجد.

function addSpan(p, start, end) {
  if (end <= start) return;
  p.spans.push([start, end]);
  p.spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of p.spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  p.spans = merged;
}

function contiguous(p) {
  return p.spans.length > 0 && p.spans[0][0] === 0 ? p.spans[0][1] : 0;
}

/** سروری که تکه را در جای خودش می‌نویسد، مثل `uploadChunk` واقعی. */
function makeServer(partFile) {
  const prog = { spans: [], touched: Date.now(), finalAt: null, total: 0 };
  let finished = 0;

  /**
   * همان `completeIfWhole` سرور — و عمداً **یک** نسخه، نه دو تا.
   *
   * نسخهٔ اولِ این جعلی، بررسیِ کامل‌بودن را در شاخهٔ تکراری هم داشت در حالی
   * که سرور نداشت. یعنی جعلی از خودِ تولید **درست‌تر** بود، پس آزمون سبز
   * می‌ماند و باگ زنده می‌رفت روی سرور. درسش: جعلی باید شکلِ واقعیت را
   * تقلید کند، نه شکلِ آرزو را.
   */
  function completeIfWhole(duplicate) {
    const size = prog.finalAt ?? (prog.total > 0 ? prog.total : null);
    if (size === null || contiguous(prog) < size) {
      return { status: 200, received: contiguous(prog), ...(duplicate ? { duplicate: true } : {}) };
    }
    if (finished > 0) return { status: 200, received: contiguous(prog) };
    finished++;
    fs.truncateSync(partFile, size);
    return { status: 200, sessionId: "s" + finished, received: contiguous(prog) };
  }

  return {
    prog,
    put(offset, chunk, isFinal, total = 0) {
      if (total > prog.total) prog.total = total;
      const already = prog.spans.some(([s, e]) => s <= offset && offset + chunk.length <= e);
      if (already && chunk.length > 0) {
        // تکراری یعنی «ننویس»، نه «کاری نکن»: پرچم پایان و بررسیِ کامل‌بودن
        // اینجا هم باید کار کند، وگرنه تکهٔ پایانیِ دوباره‌فرستاده بن‌بست است.
        if (isFinal) prog.finalAt = offset + chunk.length;
        return completeIfWhole(true);
      }
      /**
       * عمداً **همان پرچمی** که سرور می‌زند، نه یک معادلِ راحت.
       *
       * نسخهٔ اول این آزمون `w+`/`r+` می‌زد و سبز بود، در حالی که سرور `a+`
       * داشت و داده را خراب می‌کرد. آزمونی که پرچم را خودش انتخاب کند،
       * دقیقاً همان چیزی را نمی‌سنجد که در تولید اجرا می‌شود.
       */
      if (!fs.existsSync(partFile)) fs.closeSync(fs.openSync(partFile, "wx"));
      const fd = fs.openSync(partFile, "r+");
      fs.writeSync(fd, chunk, 0, chunk.length, offset);
      fs.closeSync(fd);
      addSpan(prog, offset, offset + chunk.length);
      if (isFinal) prog.finalAt = offset + chunk.length;

      return completeIfWhole(false);
    },
    sessions: () => finished,
  };
}

const SIZE = 5 * 1024 * 1024 + 12345; // عمداً مضربِ گِرد نیست
const file = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) file[i] = (i * 7 + (i >> 11)) % 251;

// ─── تکه‌ها کاملاً بی‌ترتیب می‌رسند ─────────────────────────────────────────
{
  const part = path.join(dir, "shuffled.part");
  const srv = makeServer(part);
  const CH = 256 * 1024;

  const pieces = [];
  for (let at = 0; at < SIZE; at += CH) pieces.push([at, Math.min(at + CH, SIZE)]);

  // بُر بزن — با بذر ثابت تا آزمون تکرارپذیر بماند
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  }

  let sessions = 0;
  for (const [from, to] of pieces) {
    const r = srv.put(from, file.subarray(from, to), to >= SIZE);
    if (r.sessionId) sessions++;
  }

  ok("با رسیدنِ بی‌ترتیب، فایل کامل می‌شود", fs.statSync(part).size === SIZE);
  ok("و بایت‌ها دقیقاً همان فایل‌اند", fs.readFileSync(part).equals(file));
  ok("و فقط یک جلسه ساخته می‌شود", sessions === 1, `${sessions} جلسه`);
}

// ─── تکهٔ پایانی زودتر از میانی‌ها می‌رسد ───────────────────────────────────
//
// این همان حالتی است که در نسخهٔ ترتیبی غیرممکن بود و حالا عادی است. اگر
// سرور با دیدنِ `final` کار را ببندد، فایلی با سوراخ به ffprobe می‌رود.
{
  const part = path.join(dir, "final-first.part");
  const srv = makeServer(part);
  const CH = 1024 * 1024;

  // تکهٔ آخر اول از همه
  const lastFrom = Math.floor(SIZE / CH) * CH;
  let r = srv.put(lastFrom, file.subarray(lastFrom, SIZE), true);
  ok("تکهٔ پایانیِ زودرس جلسه نمی‌سازد", !r.sessionId, JSON.stringify(r));
  ok("و «چقدر رسیده» صفر می‌ماند چون از صفر پیوسته نیست", r.received === 0, String(r.received));

  // حالا بقیه، از آخر به اول تا بدترین حالت باشد
  const rest = [];
  for (let at = 0; at < lastFrom; at += CH) rest.push([at, Math.min(at + CH, lastFrom)]);
  rest.reverse();

  let made = null;
  for (const [from, to] of rest) {
    const res = srv.put(from, file.subarray(from, to), false);
    if (res.sessionId) made = res;
  }

  ok("جلسه تازه وقتی ساخته می‌شود که آخرین سوراخ پر شود", Boolean(made));
  ok("فایل کامل و سالم است", fs.readFileSync(part).equals(file));
}

// ─── تکه‌ای وسط راه می‌میرد و ناقص می‌نشیند ─────────────────────────────────
//
// خطرناک‌ترین حالت: بخشی از تکه نوشته شده. اگر سرور کلِ بازه را ثبت کند،
// سوراخ نادیده می‌ماند و فایل خرابْ کامل اعلام می‌شود.
{
  const part = path.join(dir, "partial.part");
  const srv = makeServer(part);
  const CH = 1024 * 1024;

  srv.put(0, file.subarray(0, CH), false);
  // تکهٔ دوم فقط نیمی‌اش رسید
  const half = Math.floor(CH / 2);
  srv.put(CH, file.subarray(CH, CH + half), false);

  ok(
    "تکهٔ ناقص فقط به اندازهٔ رسیده ثبت می‌شود",
    contiguous(srv.prog) === CH + half,
    String(contiguous(srv.prog)),
  );

  // بقیهٔ همان تکه بعداً می‌رسد
  srv.put(CH + half, file.subarray(CH + half, 2 * CH), false);
  ok("پس از رسیدنِ باقیمانده، پیوسته درست می‌شود", contiguous(srv.prog) === 2 * CH);

  // و تا وقتی سوراخ هست، کامل اعلام نمی‌شود
  const lastFrom = 4 * CH;
  const r = srv.put(lastFrom, file.subarray(lastFrom, SIZE), true);
  ok("با سوراخِ باقی‌مانده جلسه ساخته نمی‌شود", !r.sessionId, JSON.stringify(r));

  srv.put(2 * CH, file.subarray(2 * CH, 4 * CH), false);
  ok("و پس از پرشدنِ سوراخ، فایل سالم است", fs.readFileSync(part).equals(file));
}

// ─── هم‌پوشانی: تلاش دوباره بازه‌ای را می‌فرستد که بخشی‌اش هست ───────────────
{
  const p = { spans: [], touched: 0, finalAt: null };
  addSpan(p, 0, 1000);
  addSpan(p, 500, 1500); // هم‌پوشان
  ok("بازه‌های هم‌پوشان ادغام می‌شوند", p.spans.length === 1 && p.spans[0][1] === 1500);

  addSpan(p, 3000, 4000); // جدا، با شکاف
  ok("بازهٔ جدا ادغام نمی‌شود", p.spans.length === 2);
  ok("و پیوسته فقط تا اولین شکاف است", contiguous(p) === 1500, String(contiguous(p)));

  addSpan(p, 1500, 3000); // شکاف را پر کن
  ok("پرکردنِ شکاف همه را یکی می‌کند", p.spans.length === 1 && contiguous(p) === 4000);
}

// ─── «چقدر رسیده» هرگز از دادهٔ سالم جلو نمی‌زند ────────────────────────────
//
// قلبِ ایمنیِ این تغییر. اگر این بشکند، کلاینت از جای اشتباه ادامه می‌دهد.
{
  const p = { spans: [], touched: 0, finalAt: null };
  addSpan(p, 8 * 1024 * 1024, 9 * 1024 * 1024); // تکه‌ای دور از ابتدا
  ok(
    "تکهٔ دور از ابتدا «رسیده» را جلو نمی‌برد",
    contiguous(p) === 0,
    `گفت ${contiguous(p)} در حالی که از صفر هیچ نرسیده`,
  );
}

// ─── پاسخِ تکهٔ پایانی گم می‌شود، کلاینت دوباره می‌فرستد ────────────────────
//
// **باگی که این بخش برای آن نوشته شد — کاربر واقعی، فایل ۵۰ مگابایتی.**
// همهٔ بایت‌ها رسیده بودند و فایل کامل روی دیسک بود، ولی پاسخِ تکهٔ پایانی سرِ
// راه گم شد. کلاینت همان تکه را دوباره فرستاد، سرور «تکراری» گفت و همان‌جا
// تمام کرد — بی‌آنکه ببیند فایل کامل است. کاربر «آپلود کامل شد ولی پاسخی
// نگرفتیم» گرفت و ۵۰ مگابایتِ سالم بی‌مصرف ماند.
{
  const part = path.join(dir, "lost-final.part");
  const srv = makeServer(part);
  const CH = 1024 * 1024;

  let at = 0;
  while (at < SIZE) {
    const end = Math.min(at + CH, SIZE);
    srv.put(at, file.subarray(at, end), end >= SIZE, SIZE);
    at = end;
  }
  ok("فایل کامل رسید و جلسه ساخته شد", srv.sessions() === 1);

  // حالا همان سناریو ولی روی آپلودی که جلسه‌اش هنوز ساخته نشده:
  // تکهٔ پایانی می‌رسد و پاسخش گم می‌شود؛ کلاینت دوباره می‌فرستد.
  const part2 = path.join(dir, "lost-final-2.part");
  const srv2 = makeServer(part2);
  let a2 = 0;
  const lastFrom = Math.floor((SIZE - 1) / CH) * CH;
  while (a2 < lastFrom) {
    const end = Math.min(a2 + CH, lastFrom);
    srv2.put(a2, file.subarray(a2, end), false, SIZE);
    a2 = end;
  }
  // تکهٔ پایانی — پاسخش «گم می‌شود» (نتیجه را دور می‌ریزیم)
  srv2.put(lastFrom, file.subarray(lastFrom, SIZE), true, SIZE);
  const before = srv2.sessions();

  // کلاینت دوباره همان تکهٔ پایانی را می‌فرستد
  const again = srv2.put(lastFrom, file.subarray(lastFrom, SIZE), true, SIZE);
  ok(
    "تکهٔ پایانیِ دوباره‌فرستاده بن‌بست نیست",
    before === 1 || Boolean(again.sessionId),
    JSON.stringify(again),
  );
}

// ─── پرچمِ پایان هرگز نمی‌رسد، ولی همهٔ بایت‌ها می‌رسند ─────────────────────
//
// حالتِ بدترِ همان باگ: درخواستی که `final=1` داشت وسط راه مُرد. بایت‌هایش
// نوشته و ثبت شد ولی پرچمش هرگز ثبت نشد، پس سرور تا ابد فکر می‌کرد فایل
// ناتمام است. `total` — که روی **هر** درخواست می‌آید — این بن‌بست را باز
// می‌کند.
{
  const part = path.join(dir, "no-final-flag.part");
  const srv = makeServer(part);
  const CH = 1024 * 1024;

  let at = 0;
  while (at < SIZE) {
    const end = Math.min(at + CH, SIZE);
    // هیچ‌کدام `final` ندارند — پرچم گم شده است
    srv.put(at, file.subarray(at, end), false, SIZE);
    at = end;
  }

  ok("بدون پرچمِ پایان هم، با total کار بسته می‌شود", srv.sessions() === 1);
  ok("و فایل سالم است", fs.readFileSync(part).equals(file));
}

// ─── ادعاها روی کد واقعی ────────────────────────────────────────────────────
{
  const srvTs = fs.readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  // در کد، نه در توضیح — کامنتِ «چرا دیگر چسبان نیست» خودش شامل این عبارت است.
  ok(
    "سرور موقعیتی می‌نویسد نه چسبانِ انتها",
    !/createWriteStream\(part[,)]/.test(srvTs) && !/\{\s*flags:\s*"a"\s*\}/.test(srvTs),
  );
  ok("و از `position` صریح استفاده می‌کند", /handle\.write\(c, 0, c\.length, at\)/.test(srvTs));

  /**
   * **`a+` ممنوع است، و این گران‌ترین درسِ این تغییر بود.**
   *
   * در حالت append هستهٔ سیستم آرگومانِ `position` را **نادیده می‌گیرد** و هر
   * نوشتن به انتهای فایل می‌رود، هرچه به آن بگویی. با تکه‌های ترتیبی هرگز
   * دیده نمی‌شد چون انتهای فایل تصادفاً جای درست بود؛ با موازی‌کاری سه نوشتن
   * پشت سر هم چسبیدند.
   *
   * نتیجه‌اش فایلی بود با اندازهٔ **درست** و محتوای **غلط** — بدترین شکل
   * خرابی، چون هر بررسیِ مبتنی بر اندازه از کنارش رد می‌شود. فقط مقایسهٔ
   * بایت‌به‌بایت روی سرور زنده لو دادش (اولین اختلاف: بایت ۲۵۸۱۹۷).
   */
  ok(
    "فایل با a+ باز نمی‌شود چون position را نادیده می‌گیرد",
    !/fsp\.open\(part,\s*"a\+?"\)/.test(srvTs),
  );
  ok("و با r+ باز می‌شود که موقعیت را محترم می‌شمارد", /fsp\.open\(part,\s*"r\+"\)/.test(srvTs));

  /**
   * `stat().size` دیگر نباید معیارِ «چقدر رسیده» باشد — نه در `/status` و نه
   * جای دیگر. این همان فرضی است که موازی‌کاری می‌شکند.
   */
  ok("status از بازه‌ها می‌آید نه اندازهٔ فایل", /received: prog \? contiguous\(prog\) : 0/.test(srvTs));

  ok("پایان یعنی پرشدنِ سوراخ‌ها", /contiguous\(prog\) < size/.test(srvTs));
  ok("بستنِ کار یک‌بار قفل می‌شود", /if \(!uploads\.delete\(key\)\)/.test(srvTs));
  ok("فایل به اندازهٔ اعلام‌شده بریده می‌شود", /fsp\.truncate\(part, size\)/.test(srvTs));
  ok("آپلودهای رهاشده جارو می‌شوند", /sweepUploads\(\)/.test(srvTs) && /UPLOAD_TTL_MS/.test(srvTs));
  ok("پس از ری‌استارت از دیسک بازیابی می‌شود", /آپلود نیمه‌کاره از دیسک بازیابی شد/.test(srvTs));

  /**
   * پایان نباید فقط به پرچمِ `final` وابسته باشد؛ `total` که روی هر درخواست
   * می‌آید هم باید بتواند کار را ببندد. بدون این، گم‌شدنِ تنها درخواستِ
   * `final=1` کل آپلود را زمین‌گیر می‌کرد.
   */
  ok("اندازهٔ کل روی هر تکه ثبت می‌شود", /if \(total > prog\.total\)/.test(srvTs));
  ok("و پایان از finalAt یا total می‌آید", /prog\.finalAt \?\? \(prog\.total > 0/.test(srvTs));
  ok("تکهٔ تکراری هم می‌تواند کار را ببندد", /completeIfWhole\(res, \{ prog, key, userId, url, part, duplicate: true \}\)/.test(srvTs));

  ok("کلاینت موازی می‌فرستد", /const PARALLEL = \d+/.test(appJs));
  ok("و اندازهٔ کل را به سرور می‌گوید", /params\.set\("total"/.test(appJs));
  ok("تکهٔ شکست‌خورده به صف برمی‌گردد", /requeue\.push/.test(appJs));
  ok("و کارگر تا خالی‌شدنِ پرواز نمی‌رود", /if \(inflight === 0\) return;/.test(appJs));
  ok("درصد مونوتونیک است", /if \(ratio > shown\)/.test(appJs));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad === 0 ? "\n🎉 همه سبز" : `\n💥 ${bad} مورد قرمز`);
process.exit(bad === 0 ? 0 : 1);
