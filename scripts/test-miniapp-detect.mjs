/**
 * تشخیص مینی‌اپ بدون SDK.
 *
 * اسکریپت بله (`tapi.bale.ai/miniapp/bale-web-app.js`) ۴۰۴ می‌دهد، پس
 * `globalThis.Bale` هرگز ساخته نمی‌شود و اپ فکر می‌کند داخل مرورگر است — و به
 * کاربر بله فرم شمارهٔ موبایل نشان می‌دهد. راه‌حل: خواندن `initData` از قطعهٔ
 * آدرس، همان جایی که خودِ SDK هم از آن می‌خواند.
 *
 * توابع از خودِ `public/app.js` بیرون کشیده و اجرا می‌شوند، نه کپی — اگر آن
 * فایل عوض شود و این مسیر را بشکند، آزمون همان لحظه قرمز می‌شود.
 *
 * اجرا: npx tsx scripts/test-miniapp-detect.mjs
 */
import fs from "node:fs";

// فایل‌های مخزن روی ویندوز با CRLF ذخیره می‌شوند و الگوهای چندخطی زیر روی
// خط تازهٔ ساده نوشته شده‌اند.
const readLf = (p) => fs.readFileSync(p, "utf8").split("\r\n").join("\n");
const src = readLf("public/app.js");
const html = readLf("public/app.html");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ─── نشانه‌گذاری ─────────────────────────────────────────────────────────────
// فقط تگ `<script>` مهم است، نه ذکرِ آدرس در توضیحات — که عمداً مانده تا
// دفعهٔ بعد کسی دوباره همان را اضافه نکند.
check(
  "اسکریپت ۴۰۴ بله بار نمی‌شود",
  !/<script[^>]+tapi\.bale\.ai\/miniapp/.test(html),
);
check(
  "فرم شماره از ابتدا پنهان است",
  html.includes('id="form-phone" class="stack hidden"'),
);

// ─── توابع را از منبع بیرون بکش ─────────────────────────────────────────────
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`تابع ${name} در app.js پیدا نشد`);
  // از اولین `{` تا آکولاد متناظرش
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`انتهای تابع ${name} پیدا نشد`);
}

const body = grab("initDataFromUrl") + "\n" + grab("host") + "\nreturn { host };";

function run(hash, globals = {}, search = "") {
  return new Function("location", "globalThis", body)({ hash, search }, globals);
}

const DATA = "user=%7B%22id%22%3A5%7D&auth_date=1787850000&hash=abc";
const FRAG = `#tgWebAppData=${encodeURIComponent(DATA)}`;

// بدون SDK ولی با قطعهٔ آدرس — همان حالتی که کاربر بله در آن گیر کرده بود
{
  const h = run(FRAG).host();
  check("بدون SDK ولی با قطعهٔ آدرس، مینی‌اپ تشخیص داده شد", h !== null);
  check("سکو نامعلوم می‌ماند تا امضا تصمیم بگیرد", h?.platform === null, String(h?.platform));
  check("initData درست خوانده شد", h?.sdk.initData === DATA);
}

// مرورگر معمولی
check("مرورگر معمولی مینی‌اپ تشخیص داده نمی‌شود", run("").host() === null);

// SDK تلگرام حاضر → مقدم است
{
  const h = run(FRAG, { Telegram: { WebApp: { initData: "from-sdk" } } }).host();
  check(
    "SDK تلگرام بر قطعهٔ آدرس مقدم است",
    h?.platform === "telegram" && h.sdk.initData === "from-sdk",
  );
}

// SDK بله، اگر روزی آدرسش درست شد
{
  const h = run("", { Bale: { WebApp: { initData: "from-bale-sdk" } } }).host();
  check("SDK بله هم اگر بود کار می‌کند", h?.platform === "bale" && h.sdk.initData === "from-bale-sdk");
}

// قطعهٔ آدرسِ بی‌ربط نباید مینی‌اپ حساب شود
check("قطعهٔ نامربوط نادیده گرفته می‌شود", run("#foo=bar").host() === null);

// بله ممکن است initData را جای دیگری بگذارد — همهٔ جاهای محتمل بررسی می‌شوند
check(
  "کلید initData در قطعهٔ آدرس",
  run(`#initData=${encodeURIComponent(DATA)}`).host()?.sdk.initData === DATA,
);
check(
  "initData در رشتهٔ پرس‌وجو",
  run("", {}, `?tgWebAppData=${encodeURIComponent(DATA)}`).host()?.sdk.initData === DATA,
);
// بدون `hash=` یک رشتهٔ initData معتبر نیست و نباید برداشته شود
check("مقدار بی‌امضا رد می‌شود", run("#tgWebAppData=user%3D1").host() === null);
// `location` ناقص نباید بالاآمدن را بشکند
check("location بدون search خطا نمی‌دهد", run("#foo=bar", {}, undefined).host() === null);

// ─── متنِ کادر صوت در دو جا نوشته شده و نباید از هم عقب بماند ────────────────
//
// یک‌بار در `app.html` (حالت اول) و یک‌بار در `resetDrop()` (بعد از خطا یا
// آپلود). عوض‌کردن یکی و جاماندنِ دیگری هیچ خطایی نمی‌دهد: کاربر فقط بعد از
// اولین خطا متنِ کهنه را می‌بیند و کسی متوجه نمی‌شود.
{
  const inHtml = html.match(/<div class="drop" id="drop">([\s\S]*?)<\/div>\s*<input/);
  const inJs = src.match(/function resetDrop\(\)[\s\S]*?drop\.innerHTML =([\s\S]*?);\n\}/);
  const words = (s) => (s ? (s.match(/[؀-ۿ]+/g) ?? []).join(" ") : null);
  check("متن کادر صوت در html پیدا شد", Boolean(inHtml));
  check("متن کادر صوت در resetDrop پیدا شد", Boolean(inJs));
  check(
    "دو نسخهٔ متنِ کادر صوت یکی‌اند",
    words(inHtml?.[1]) === words(inJs?.[1]),
    `html=${words(inHtml?.[1])} | js=${words(inJs?.[1])}`,
  );
  // و خودِ متن باید کاری را بگوید که روی موبایل ممکن است: زدن، نه کشیدن.
  check("تیتر کادر، «زدن» را می‌گوید نه «گذاشتن»", /بزن<\/h3>/.test(inHtml?.[1] ?? ""));
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
