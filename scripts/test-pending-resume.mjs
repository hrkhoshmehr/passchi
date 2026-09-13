/**
 * فایلِ منتظرِ تأیید پیدا می‌شود، و هیچ خطای لاتینی به صفحه نمی‌رسد.
 *
 * ## باگ‌هایی که این آزمون نگه می‌دارد
 *
 * ۱. **فایلِ رهاشده.** آپلودِ مینی‌اپ جلسه را `queued` و با فایلش نگه
 *    می‌داشت، ولی اپ شناسه‌اش را فقط در یک متغیرِ صفحه داشت. کاربری که سکه‌اش
 *    کم بود و برای شارژ بیرون رفت، دیگر راهی به همان فایل نداشت و متن هم
 *    می‌گفت «دوباره بفرست». حالا `GET /api/uploads/pending` جلسه را برمی‌گرداند
 *    و `checkPending` کارتِ «ادامه بدیم؟» را باز می‌کند.
 *
 *    ملاکِ «منتظر» باید تأییدشده‌ها را بیرون بگذارد: جلسهٔ تأییدشده‌ای که پشت
 *    کارِ دیگری در صف است هم `queued` است، ولی رزرو در دفتر دارد.
 *
 * ۲. **خطای انگلیسی.** `JSON.parse` روی صفحهٔ HTMLِ CDN و `AbortSignal.timeout`
 *    پیام‌هایی مثل «Unexpected token <» و «signal timed out» به کاربر
 *    می‌دادند. `friendlyError` باید برای هر خطای بی‌پاسخِ سرور، فارسی بدهد.
 *
 * ۳. **«نفری n تومان».** صفحهٔ تأیید سهم را پیش از هر درخواستی حساب می‌کند؛ اگر
 *    از `shareSeat` سرور عقب بماند، عددی که کاربر به هم‌کلاسی‌ها قول می‌دهد غلط است.
 *
 * اجرا: DATA_DIR=./data/tmp-pending npx tsx scripts/test-pending-resume.mjs
 */
process.env.BOT_TOKEN ||= "x";

import fs from "node:fs";

const readLf = (p) => fs.readFileSync(p, "utf8").split("\r\n").join("\n");
const server = readLf("src/web/server.ts");
const js = readLf("public/app.js");
const html = readLf("public/app.html");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/** یک تابع را از خودِ `app.js` بیرون بکش، با `async` اگر داشت. */
function grab(name) {
  let start = js.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`تابع ${name} در app.js پیدا نشد`);
  if (js.slice(start - 6, start) === "async ") start -= 6;
  let depth = 0;
  for (let j = js.indexOf("{", js.indexOf(")", start)); j < js.length; j++) {
    if (js[j] === "{") depth++;
    else if (js[j] === "}" && --depth === 0) return js.slice(start, j + 1);
  }
  throw new Error(`انتهای تابع ${name} پیدا نشد`);
}

// ─── ۱. سرور: کدام جلسه «منتظر» است ──────────────────────────────────────────

const block = server.slice(server.indexOf('"/api/uploads/pending"'));
const sql = block.match(/\.prepare\(\s*`([\s\S]*?)`/)?.[1];
check("مسیر pending در سرور هست", Boolean(sql));
check("فقط‌خواندنی است", Boolean(sql) && !/\b(UPDATE|INSERT|DELETE)\b/i.test(sql));
check("احراز هویت دارد", /"\/api\/uploads\/pending"[\s\S]{0,120}requireUser\(req, res\)/.test(server));
check("پیش از مسیرهای پارامتردار است (با «pending» به‌جای شناسه قاطی نمی‌شود)",
  server.indexOf('"/api/uploads/pending"') < server.indexOf("const sessionMatch"));
check("وجودِ فایل روی دیسک هم سنجیده می‌شود", /fs\.existsSync\(row\.file\)/.test(block));

if (sql) {
  const { db, upsertUser, createSession, updateSession } = await import("../src/db/index.ts");
  const { grant, reserve } = await import("../src/billing/ledger.ts");

  const ME = 7_100_001;
  const OTHER = 7_100_002;
  upsertUser(ME, "من", null);
  upsertUser(OTHER, "دیگری", null);
  grant(ME, 3600);

  const run = (uid) => db.prepare(sql).get(uid);
  const make = (id, uid, extra = {}) => {
    createSession(id, uid, null);
    updateSession(id, { mode: "full", download_route: "web", original_file: `/tmp/${id}.ogg`, ...extra });
  };

  check("بدون جلسه، چیزی برنمی‌گردد", run(ME) === undefined);

  make("pendold01", ME);
  db.prepare(`UPDATE sessions SET created_at = datetime('now','-2 hours') WHERE id = ?`).run("pendold01");
  make("pendnew01", ME);
  check("آپلودِ تأییدنشده پیدا می‌شود", run(ME)?.id === "pendnew01", String(run(ME)?.id));
  check("تازه‌ترین برمی‌گردد نه قدیمی‌تر", run(ME)?.id === "pendnew01");

  // تأییدشده و در صف: رزرو دارد، پس منتظرِ کاربر نیست
  reserve(ME, 600, "pendnew01");
  check("جلسهٔ تأییدشده (با رزرو) پیشنهاد نمی‌شود", run(ME)?.id === "pendold01", String(run(ME)?.id));

  updateSession("pendold01", { status: "error" });
  check("جلسهٔ ناموفق پیشنهاد نمی‌شود", run(ME) === undefined, String(run(ME)?.id));

  make("pendbot01", ME, { download_route: "bot" });
  check("جلسهٔ ربات (مسیر دیگر) پیشنهاد نمی‌شود", run(ME) === undefined);

  make("pendnof01", ME, { original_file: null });
  check("جلسهٔ بی‌فایل پیشنهاد نمی‌شود", run(ME) === undefined);

  make("pendoth01", OTHER);
  check("جلسهٔ کاربرِ دیگر به من نشان داده نمی‌شود", run(ME) === undefined);
  check("…ولی برای خودش پیدا می‌شود", run(OTHER)?.id === "pendoth01");
}

// ─── ۲. کلاینت: کارتِ «ادامه بدیم؟» ─────────────────────────────────────────

check("کارتِ ادامه از ابتدا بسته است", /id="resume" class="card hidden"/.test(html));
check("متنِ پیشنهاد همان واژه‌نامه است", html.includes("یه فایل آماده داری — ادامه بدیم؟"));
check("در بالاآمدن پیشنهاد سنجیده می‌شود", /go\("send"\);\s*\n\s*checkPending\(\);/.test(js));
check("برگشت به تبِ آپلود هم می‌سنجد", /t\.dataset\.go === "send"\) checkPending\(\)/.test(js));
check("برگشت به صفحه (visibilitychange) هم می‌سنجد", /visibilitychange[\s\S]{0,300}checkPending\(\)/.test(js));
check("«ادامه بده» مستقیم به صفحهٔ تأیید می‌رود", /resume-go[\s\S]{0,200}askConfirm\(out,/.test(js));
check(
  "متنِ «فایلت همین‌جا می‌مونه» فقط کنار سازوکارِ واقعیِ ازسرگیری است",
  js.includes("فایلت همین‌جا می‌مونه") && js.includes("/api/uploads/pending"),
);
check("«دوباره بفرست» دیگر به کاربرِ کم‌سکه گفته نمی‌شود", !js.includes("شارژ کن و دوباره بفرست"));

{
  const body = `let resumable = null;\n${grab("checkPending")}\nreturn { checkPending, get resumable() { return resumable; } };`;
  const make = (reply, dismissed = null) => {
    const els = { resume: { hidden: true }, "resume-meta": { textContent: "" } };
    const api = {
      async call(path) {
        if (path !== "/api/uploads/pending") throw new Error("unexpected " + path);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
    const mod = new Function("api", "$", "show", "faDuration", "faGroup", "dismissedPending", body)(
      api,
      (id) => els[id],
      (el, on) => (el.hidden = !on),
      (s) => `${Math.round(s / 60)} دقیقه`,
      (n) => String(n),
      () => dismissed,
    );
    return { mod, els };
  };
  // هزینه و موجودی به تومان، با همان نام‌هایی که سرور می‌فرستد (`cost`، `have`).
  const P = { sessionId: "abc123", durationSec: 5580, cost: 139_500, have: 20_000, enough: false };

  {
    const { mod, els } = make({ pending: P });
    const offered = await mod.checkPending();
    check("فایل منتظر → کارت باز می‌شود", offered === true && els.resume.hidden === false);
    check("کارت هزینه را می‌گوید", els["resume-meta"].textContent.includes("139500"), els["resume-meta"].textContent);
    check("همان جلسه برای «ادامه بده» نگه داشته می‌شود", mod.resumable?.sessionId === "abc123");
  }
  {
    const { mod, els } = make({ pending: null });
    check("بدون فایل منتظر → کارت بسته", (await mod.checkPending()) === false && els.resume.hidden === true);
  }
  {
    const { mod, els } = make({ pending: P }, "abc123");
    check("فایلی که «بی‌خیال» خورده دوباره پیشنهاد نمی‌شود", (await mod.checkPending()) === false && els.resume.hidden);
  }
  {
    const { mod, els } = make(new TypeError("Failed to fetch"));
    check("شکستِ شبکه بی‌صدا کارت را می‌بندد", (await mod.checkPending()) === false && els.resume.hidden);
  }
}

// ─── ۳. نگاشتِ خطا ──────────────────────────────────────────────────────────

{
  const friendlyError = new Function(`${grab("friendlyError")}\nreturn friendlyError;`)();
  const latin = /[A-Za-z]/;

  let parseErr;
  try {
    JSON.parse("<html><body>502 Bad Gateway</body></html>");
  } catch (e) {
    parseErr = e;
  }
  const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
  const cases = [
    ["JSON.parse روی صفحهٔ خطای CDN", parseErr],
    ["مهلتِ AbortSignal", timeout],
    ["قطعیِ fetch", new TypeError("Failed to fetch")],
    ["خطای tus بی‌بدنه", Object.assign(new Error("tus: failed to upload chunk at offset 0"), { status: 0, data: {} })],
    ["۵۰۲ با بدنهٔ HTML", Object.assign(new Error("خطایی رخ داد."), { status: 502, data: {} })],
    ["خطای سرور به انگلیسی", Object.assign(new Error("x"), { status: 500, data: { error: "Internal Server Error" } })],
    ["بدونِ خطا", undefined],
  ];
  for (const [label, err] of cases) {
    for (const kind of ["upload", "general"]) {
      const out = friendlyError(err, kind);
      check(`${label} (${kind}) → فارسی، بی‌حرفِ لاتین`, typeof out === "string" && out.length > 0 && !latin.test(out), out);
    }
  }
  check(
    "خطای شبکهٔ آپلود قدمِ بعد را می‌گوید",
    friendlyError(timeout, "upload") ===
      "اینترنت قطع و وصل شد. همین فایل رو دوباره انتخاب کن — از همون‌جایی که مونده بود ادامه می‌ده، نه از اول.",
  );
  const said = "فایل خیلی بزرگ است. سقف ۵۰۰ مگابایت است.";
  check("پیامِ فارسیِ سرور دست نمی‌خورد", friendlyError(Object.assign(new Error(said), { status: 413, data: { error: said } })) === said);
  check("api.call دیگر JSON.parse بی‌محافظ ندارد", !/const data = text \? JSON\.parse\(text\) : \{\};/.test(js));
  check("هیچ err.message خامی روی صفحه نمی‌رود", !/(fail\([^)]*|textContent = |esc\()\s*(err|e)\.message/.test(js));
}

// ─── ۴. «نفری n تومان» همان shareSeat سرور است ──────────────────────────────
//
// `shareSeat(costToman, people)` در app.js باید خودبسنده باشد (بی ثابتِ بیرونی)
// چون جدا از بقیهٔ فایل اجرا می‌شود.

{
  const money = await import("../src/billing/money.ts");
  const appSeat = new Function(`${grab("shareSeat")}\nreturn shareSeat;`)();
  let drift = null;
  for (const min of [1, 2, 3, 7, 15, 20, 45, 90, 94, 137, 240]) {
    for (const people of [2, 3, 5, 10, 20, 30, 1]) {
      const cost = money.priceOf(min * 60);
      const want = money.shareSeat(cost, people);
      const got = appSeat(cost, people);
      if (want !== got) drift ??= `${min} دقیقه (${cost} تومان)، ${people} نفر: سرور ${want} · اپ ${got}`;
    }
  }
  check("سهمِ صفحهٔ تأیید با shareSeat سرور یکی است", drift === null, drift ?? "");

  // تعدادهای روی صفحهٔ تأیید هم همان دکمه‌های ربات باشند؛ وگرنه مینی‌اپ «۲۰ نفر ·
  // نفری ۵۰۰» نشان می‌دهد در حالی که ربات آن را معنادار نمی‌داند.
  const appCounts = new Function(`${grab("shareSeat")}\n${grab("shareCountsFor")}\nreturn shareCountsFor;`)();
  let countDrift = null;
  for (const min of [1, 3, 5, 7, 10, 15, 20, 45, 67, 90, 137, 240]) {
    const cost = money.priceOf(min * 60);
    const want = JSON.stringify(money.shareCountsFor(cost));
    const got = JSON.stringify(appCounts(cost));
    if (want !== got) countDrift ??= `${min} دقیقه: سرور ${want} · اپ ${got}`;
  }
  check("تعدادهای صفحهٔ تأیید با shareCountsFor سرور یکی است", countDrift === null, countDrift ?? "");
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
