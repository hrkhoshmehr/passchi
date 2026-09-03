/**
 * آپلود دیگر خودش کار را شروع نمی‌کند — اول قیمت، بعد تأیید.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * `POST /api/sessions/upload` بلافاصله `startJob` می‌زد. یعنی کاربر فایلش را
 * می‌گذاشت و بی‌آنکه بداند چقدر خرج برمی‌دارد، سکه‌هایش کم می‌شد. بدتر:
 * مبنای کسر، `duration`ی بود که **مرورگر** می‌گفت و برای بعضی قالب‌ها صفر
 * یا غلط است.
 *
 * حالا آپلود فقط فایل را نگه می‌دارد و مدتِ اندازه‌گیری‌شده با ffmpeg را
 * برمی‌گرداند؛ کسر سکه فقط در `POST /api/sessions/:id/confirm` اتفاق می‌افتد.
 *
 * و وضعیت در **ربات** دنبال می‌شود نه در مینی‌اپ: کاربر صفحه را می‌بندد.
 *
 * اجرا: npx tsx scripts/test-confirm-flow.mjs
 */
import fs from "node:fs";

const readLf = (p) => fs.readFileSync(p, "utf8").split("\r\n").join("\n");
const server = readLf("src/web/server.ts");
const js = readLf("public/app.js");
const html = readLf("public/app.html");
const notify = readLf("src/bot/notify.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ─── سرور: آپلود کاری شروع نمی‌کند ──────────────────────────────────────────

const uploadFn = server.slice(
  server.indexOf("async function uploadAudio"),
  server.indexOf("async function confirmSession"),
);
check("تابع confirmSession وجود دارد", server.includes("async function confirmSession"));
check("آپلود دیگر startJob نمی‌زند", !uploadFn.includes("startJob("));
check("آپلود مدت را خودش اندازه می‌گیرد", /await probe\(srcFile\)/.test(server));
check("آپلود قیمت را برمی‌گرداند", /costCoins: costCoins\(sec\)/.test(uploadFn));
check("فایلِ بی‌مدت رد می‌شود", /if \(sec <= 0\)/.test(uploadFn));

const confirmFn = server.slice(
  server.indexOf("async function confirmSession"),
  server.indexOf("// ─── فایل‌های ایستا") >= 0
    ? server.indexOf("// ─── فایل‌های ایستا")
    : server.length,
);
check("تأیید کار را شروع می‌کند", confirmFn.includes("startJob("));
check("مالکیت جلسه بررسی می‌شود", /s\.tg_id !== userId/.test(confirmFn));
check(
  "تأیید دوباره رد می‌شود (جلوی کسر دوبارهٔ سکه)",
  /s\.status !== "queued"/.test(confirmFn),
);
check("مسیر تأیید ثبت شده", /sessionMatch\[2\] === "\/confirm"/.test(server));

// ─── وضعیت در ربات ─────────────────────────────────────────────────────────

check("پیام زندهٔ ربات ساخته می‌شود", confirmFn.includes("liveMessage(userId)"));
check("هر مرحله به ربات می‌رود", /live\.update\(progressMessage\(p\.stage/.test(confirmFn));
check("اولین وضعیت بی‌درنگ فرستاده می‌شود", /live\.update\(progressMessage\("queue"\)\)/.test(confirmFn));
check("پیام وضعیت پیش از تحویل پاک می‌شود", /live\.finish\(\)[\s\S]{0,200}deliverToBot/.test(confirmFn));
check("خطا هم به کاربر گفته می‌شود", /notifyUser\(userId, `⚠️/.test(confirmFn));

check("liveMessage صادر شده", /export function liveMessage/.test(notify));
check("ویرایش‌ها صف دارند", /chain = chain\.then/.test(notify));
check("پیام تکراری دوباره فرستاده نمی‌شود", /text === last/.test(notify));

// ─── مینی‌اپ ────────────────────────────────────────────────────────────────

check("صفحهٔ تأیید هست", html.includes('id="s-confirm"'));
for (const id of ["confirm-dur", "confirm-cost", "confirm-have", "confirm-go", "confirm-cancel"]) {
  check(`عنصر ${id} هست`, html.includes(`id="${id}"`));
}
check("اپ پس از آپلود قیمت را نشان می‌دهد", /askConfirm\(out, file\.name\)/.test(js));
check("تأیید به سرور POST می‌شود", /\/confirm`, \{ method: "POST" \}/.test(js));
check(
  "موجودی کم، دکمهٔ تأیید را می‌بندد",
  /\$\("confirm-go"\)\.disabled = !out\.enough/.test(js),
);

// نظرسنجی وضعیت باید کاملاً رفته باشد
check("نظرسنجی دوثانیه‌ای حذف شده", !js.includes("setInterval"));
check("renderProgress حذف شده", !js.includes("renderProgress"));
check("اپ می‌گوید صفحه را ببند", /این صفحه رو ببند/.test(html));

// ─── درصد آپلود ─────────────────────────────────────────────────────────────
//
// `fetch` هیچ راهی برای دنبال‌کردن پیشرفتِ فرستادن ندارد؛ تنها `XMLHttpRequest`
// این را می‌دهد. کاربر یک فایل ۹۰ دقیقه‌ای را روی اینترنت موبایل می‌فرستد و
// اسپینرِ بی‌عدد برای چند دقیقه، بدترین قسمت مسیر بود.
check("آپلود با XHR انجام می‌شود", /new XMLHttpRequest\(\)/.test(js));
check("پیشرفت فرستادن دنبال می‌شود", /xhr\.upload\.onprogress/.test(js));
check("آپلود از api.call رد نمی‌شود", !/api\.call\([^)]*sessions\/upload/.test(js));
check("درصد نشان داده می‌شود", /٪ فرستاده شد/.test(js));
check("مگابایت هم نشان داده می‌شود", /از \$\{fa\(total\)\} مگابایت/.test(js));
check(
  "بدون lengthComputable عدد ساختگی ساخته نمی‌شود",
  /e\.lengthComputable && e\.total > 0/.test(js),
);
check("تا پیش از پاسخ سرور روی ۹۹ می‌ماند", /Math\.min\(99/.test(js));
check("پس از آخرین بایت، مرحلهٔ بررسی گفته می‌شود", /دارم فایل رو بررسی می‌کنم/.test(js));
check("آپلود مهلت ندارد", /xhr\.timeout = 0/.test(js));
check("خطای XHR همان شکل api.call را دارد", /\{ data, status: xhr\.status \}/.test(js));
check("نوار پیشرفت در نشانه‌گذاری هست", html.includes("bar-fill"));

// ─── آپلودی که وسط راه خشک می‌شد ────────────────────────────────────────────
//
// سرور وقتی وسط یک آپلودِ در جریان پاسخ می‌داد و بدنه را نمی‌خواند، بافر
// دریافتِ سوکت پر می‌شد و `xhr.upload.onprogress` **از حرکت می‌ایستاد**:
// کاربر نوار درصد را روی مثلاً ۳۸٪ خشک می‌دید و بعد «اتصال قطع شد» می‌گرفت،
// در حالی که سرور از همان اول جواب داده بود. روی اینترنت پرسرعت دیده نمی‌شد
// چون کل فایل در بافرها جا می‌شد؛ روی موبایل ایران همیشه اتفاق می‌افتاد.
check("تابع refuse بدنه را مصرف می‌کند", /function refuse\([\s\S]{0,400}?req\.resume\(\)/.test(server));
check("پاسخ پس از پایان بدنه می‌رود", /req\.on\("end", done\)/.test(server));
check("۴۰۲ آپلود از refuse رد می‌شود", /return refuse\(req, res, 402/.test(server));
check("۴۰۱ هم از refuse رد می‌شود", /refuse\(req, res, 401/.test(server));

// و راه‌حل اصلی: پیش از فرستادن بایت‌ها بپرس
check("مسیر precheck هست", /case "POST \/api\/sessions\/precheck"/.test(server));
check("precheck اعتبار را می‌سنجد", /sec > 0 && u\.credit_sec < sec/.test(server));
check("precheck حجم را هم می‌سنجد", /sizeBytes > MAX_UPLOAD_BYTES/.test(server));
check("اپ پیش از آپلود precheck می‌زند", /api\.call\("\/api\/sessions\/precheck"/.test(js));
/**
 * ترتیب روی **جای صداکردن** سنجیده می‌شود، نه جای تعریف تابع.
 *
 * `uploadChunked` بالاتر از `upload()` تعریف شده، پس مقایسهٔ سادهٔ اولین
 * رخداد، تعریف را می‌گیرد نه فراخوانی — و آزمون بی‌آنکه چیزی خراب شده باشد
 * قرمز می‌شد.
 */
check(
  "precheck پیش از آپلود صدا زده می‌شود",
  js.indexOf("/api/sessions/precheck") < js.indexOf("out = await uploadChunked("),
);

// ─── تلاش دوباره ────────────────────────────────────────────────────────────
//
// دو شکست جدا اینجا پوشش داده می‌شود:
//
// ۱. CDN جلوی دامنه گاهی وسط آپلود ۵۰۴ می‌سازد بی‌آنکه درخواست به سرور برسد
//    (لاگ مبدأ هیچ ۵۰۴ای ندارد) — گاه‌به‌گاه، پس تلاش دوباره می‌گیردش.
//
// ۲. وب‌ویوی اندرویدِ بله اتصال طولانی را **خودش** می‌بُرد؛ برای یک کاربر هشت
//    بار پیاپی، هربار در نقطه‌ای متفاوت. آنجا تلاش دوبارهٔ کل فایل بی‌فایده
//    است — سه بار همان بیست مگابایت می‌سوزد و آخرش هیچ. راهش تکه‌تکه‌کردن
//    است، که در `test-chunked-upload.mjs` جداگانه سنجیده می‌شود.
//
// پس اینجا فقط *وجودِ* تلاشِ کران‌دار و درست بررسی می‌شود، نه شکل نوشتنش.
/**
 * **کران، حالا زمان است نه شمارش.**
 *
 * شمارندهٔ هشت‌تایی روی فایل بزرگ ناعادلانه بود: فایل ۵۰ مگابایتی ده‌ها تکه
 * است و شبکه‌ای که یک‌درمیان می‌افتد آن هشت‌تا را زود می‌سوزاند — کاربر با
 * آپلودِ ۸۰٪ کامل بیرون انداخته می‌شد. معیار درست «چند بار شکست خورد» نیست،
 * «چقدر شد که هیچ بایتی جلو نرفت» است.
 */
check("تلاش دوباره کران‌دار است", /Date\.now\(\) - lastProgressAt > NO_PROGRESS_MS/.test(js));
check("فقط شبکه و ۵xx دوباره امتحان می‌شوند", /!err\.status \|\| err\.status >= 500/.test(js));
/**
 * با کارگرهای موازی، «تسلیم شو» دیگر `throw` مستقیم نیست: کارگر خطا را در
 * `fatal` می‌گذارد و برمی‌گردد، و پس از `Promise.all` همان پرت می‌شود. اگر
 * مستقیم پرت می‌کرد، بقیهٔ کارگرها بی‌خبر ادامه می‌دادند.
 */
check("۴۰۲ دوباره امتحان نمی‌شود", /if \(!retryable\) \{\s*\n\s*fatal = err;/.test(js));
/**
 * **یک مسیر، نه دو تا.**
 *
 * پیش‌تر فقط فایلِ بزرگ‌تر از یک تکه تقسیم می‌شد و بقیه به مسیر یک‌تکهٔ قدیمی
 * می‌رفتند. وقتی وب‌ویوی بله نسخهٔ کهنهٔ `app.js` را اجرا کرد، همان مسیرِ
 * کم‌آزموده بود که کاربر را با فایل ۱۷ مگابایتی به «از اول» انداخت. دو مسیر
 * یعنی یکی‌شان همیشه عقب می‌ماند.
 */
check(
  "هر آپلودی تکه‌تکه می‌رود — یک مسیر، نه دو تا",
  /uploadChunked\(/.test(js) && !/file\.size > CHUNK_BYTES/.test(js),
);
check(
  "مسیر یک‌تکهٔ قدیمی دیگر از اپ صدا زده نمی‌شود",
  !/uploadWithProgress\(`\/api\/sessions\/upload/.test(js),
);
check("پس از شکست، از جایی که سرور رسیده ادامه می‌دهد", /uploads\/status/.test(js));

// precheck نباید دروازه باشد: شکستِ شبکه‌ایِ آن نباید جلوی آپلود را بگیرد
check("مهلت precheck بلندتر از پیش‌فرض است", /timeoutMs: 45000/.test(js));
check(
  "شکست شبکه‌ای precheck آپلود را متوقف نمی‌کند",
  /continuing anyway/.test(js) && /if \(err\.status\) \{/.test(js),
);

// ─── ورود از سایت روی گوشی ─────────────────────────────────────────────────
check(
  "کاربر موبایل به دکمه‌های ربات ارجاع داده می‌شود",
  /یکی از دکمه‌های زیر رو بزن/.test(js),
);
check("دکمه‌های ربات فقط روی دسکتاپ پنهان می‌شوند", /if \(strandedOnDesktop\) \{/.test(js));

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
