/**
 * مسیر درگاه، بدون زیبال: `fetch` جعلی است و هر بار می‌گوید verify چه بگوید.
 *
 * چیزی که این آزمون نگه می‌دارد:
 *
 * • بازگشت با `success=1` بدون verifyِ موفق سکه نمی‌دهد.
 * • دو تسویهٔ **همزمان** روی یک سفارش (بازگشت از درگاه + دکمهٔ «بررسی
 *   پرداخت») دقیقاً یک بار واریز می‌کنند.
 * • تسویهٔ دوباره، حتی وقتی زیبال ۲۰۱ («قبلاً تأیید شده») می‌دهد، واریز
 *   دوباره نمی‌کند.
 * • «بررسی پرداخت» از ربات سفارشِ پرداخت‌نشده را باز نگه می‌دارد.
 * • بازگشتِ **بی‌احراز** از درگاه — حتی با `success=0` و روی سفارشِ یک غریبه —
 *   سفارش را نمی‌بندد و پکیج و سکه‌اش را در صفحه نشان نمی‌دهد. پیش‌تر می‌بست:
 *   هرکس trackIdها را می‌شمرد، سفارش باز دیگری را پیش از پرداخت می‌بست و
 *   پول او بی‌سکه می‌ماند. بازگشتِ واقعی پس از پرداخت هنوز یک بار واریز می‌کند.
 * • سفارشی که پیش از تغییر قیمت باز شده، پس از آن با **سکه و مبلغِ ذخیره‌شده
 *   روی ردیف** تسویه می‌شود، نه با `PACKAGES` امروز.
 *
 * اجرا: DATA_DIR=./data/tmp-gw node --import tsx scripts/test-topup-gateway.mjs
 */
process.env.ZIBAL_MERCHANT ||= "zibal";
process.env.PUBLIC_URL ||= "https://example.test";
process.env.CARD_NUMBER = "";
process.env.BOT_TOKEN ||= "x";

let verifyResult = 202;
// fetch واقعی برای زدنِ سرورِ محلیِ خودمان؛ جعلی فقط برای زیبال است.
const realFetch = globalThis.fetch;
let nextTrack = 5000;
const calls = [];
/**
 * مبلغی که هر trackId با آن ساخته شد — درگاه واقعی هم همین را در verify
 * برمی‌گرداند. عددِ سفت‌شده (قبلاً ۱۱۸۰۰۰۰ ریال) با اولین تغییر قیمت از
 * واقعیت جدا می‌شد و مسیر «اختلاف مبلغ» را بی‌صدا روی هر تسویه روشن می‌کرد.
 */
const amountOf = new Map();
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), body });
  const reply = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (String(url).endsWith("/v1/request")) {
    if (body.merchant !== "zibal") return reply({ result: 102, message: "merchant not found" });
    if (!body.callbackUrl?.startsWith("https://")) return reply({ result: 106 });
    amountOf.set(++nextTrack, body.amount);
    return reply({ result: 100, message: "success", trackId: nextTrack });
  }
  if (String(url).endsWith("/v1/verify")) {
    // تأخیر کوچک تا دو تسویهٔ همزمان واقعاً هم‌پوشان باشند
    await new Promise((r) => setTimeout(r, 20));
    if (verifyResult === 100) return reply({ result: 100, amount: amountOf.get(body.trackId), refNumber: 777, status: 1 });
    return reply({ result: verifyResult, message: "x" });
  }
  throw new Error("unexpected " + url);
};

const { upsertUser, getUser, getTopup } = await import("../src/db/index.ts");
const { beginTopup, settleTopup, cancelTopup, gatewayConfigured } = await import("../src/bot/topup.ts");
const { balanceCoins, findPackage, fmtCoins, fmtToman } = await import("../src/billing/coins.ts");
const { createWebServer } = await import("../src/web/server.ts");
const { resolveBotLinks } = await import("../src/bot/links.ts");
const { resolveIdentity } = await import("../src/db/identity.ts");
const { zibalVerify } = await import("../src/billing/zibal.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const TG = 9101;
upsertUser(TG, "آزمون درگاه", "gw");
const bal = () => balanceCoins(getUser(TG).credit_sec);
const start = bal();
const p1 = findPackage("p4");

check("درگاه تنظیم است", gatewayConfigured());

// ── شروع ────────────────────────────────────────────────────────────────────
const o = await beginTopup(TG, "p4");
check("لینک پرداخت ساخته شد", o.payUrl?.startsWith("https://gateway.zibal.ir/start/"), o.payUrl);
check("مبلغ به ریال رفت", calls[0].body.amount === p1.price * 10, String(calls[0].body.amount));
check("orderId همان شناسهٔ سفارش است", calls[0].body.orderId === o.id);
check("آدرس بازگشت روی PUBLIC_URL است", calls[0].body.callbackUrl === "https://example.test/pay/zibal/callback", calls[0].body.callbackUrl);
const row = getTopup(o.id);
check("وضعیت awaiting_payment", row.status === "awaiting_payment", row.status);
check("track_id ذخیره شد", row.track_id === String(nextTrack), row.track_id);

// ── بازگشت جعلی: success=1 ولی درگاه می‌گوید پرداخت نشده ─────────────────────
verifyResult = 202;
let r = await settleTopup({ trackId: row.track_id });
check("بدون verify موفق، سکه‌ای واریز نمی‌شود", r.outcome === "unpaid" && bal() === start, `${r.outcome} · ${bal()}`);
check("«بررسی پرداخت» سفارش را باز نگه می‌دارد", getTopup(o.id).status === "awaiting_payment");

// ── پرداخت واقعی، دو تسویهٔ همزمان ──────────────────────────────────────────
verifyResult = 100;
const [a, b] = await Promise.all([settleTopup({ trackId: row.track_id }), settleTopup({ topupId: o.id })]);
const outcomes = [a.outcome, b.outcome].sort();
check("از دو تسویهٔ همزمان یکی واریز کرد و یکی «قبلاً»", outcomes.join(",") === "already,credited", outcomes.join(","));
check("دقیقاً یک بار واریز شد", bal() === start + p1.coins, `${bal()} (انتظار ${start + p1.coins})`);
check("شمارهٔ مرجع ذخیره شد", getTopup(o.id).ref_number === "777", getTopup(o.id).ref_number);

// ── تسویهٔ سوم، زیبال ۲۰۱ می‌دهد ──────────────────────────────────────────────
verifyResult = 201;
r = await settleTopup({ topupId: o.id });
check("تسویهٔ دوباره واریز نمی‌کند", r.outcome === "already" && bal() === start + p1.coins, r.outcome);

// ── بازگشتِ بی‌احراز روی سفارشِ یک غریبه ─────────────────────────────────────
//
// از خودِ سرور HTTP، نه از `settleTopup`: آسیب‌پذیری در مسیرِ بازگشت بود
// (`success=0` ⇒ بستن) و در صفحه‌ای که پکیج را برمی‌گرداند.
const server = createWebServer();
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;
/** درخواستِ بی‌کوکی و بی‌توکن، همان‌طور که یک غریبه می‌زند. */
const anon = async (qs) => {
  const res = await realFetch(`${base}/pay/zibal/callback?${qs}`);
  return { status: res.status, html: await res.text() };
};
try {
  const p2 = findPackage("p5");
  const o2 = await beginTopup(TG, "p5");
  const track2 = getTopup(o2.id).track_id;
  /** هر نشانه‌ای که بگوید این سفارش چیست یا مال کیست. */
  const leaks = (html) =>
    [p2.title, fmtCoins(p2.coins), fmtToman(p2.price), o2.id, String(TG)].filter((s) => html.includes(s));

  verifyResult = 202;
  let page = await anon(`trackId=${track2}&success=0&status=3`);
  check("بازگشت بی‌احراز با success=0 سفارشِ پرداخت‌نشده را نمی‌بندد", getTopup(o2.id).status === "awaiting_payment", getTopup(o2.id).status);
  check("صفحهٔ «پرداخت انجام نشد» پکیج و سکه و شناسه را لو نمی‌دهد", leaks(page.html).length === 0, leaks(page.html).join(" | "));

  page = await anon(`trackId=${track2}&success=1`);
  check("بازگشتِ جعلی با success=1 هم نمی‌بندد و واریز نمی‌کند", getTopup(o2.id).status === "awaiting_payment" && bal() === start + p1.coins, `${getTopup(o2.id).status} · ${bal()}`);

  // حتی اگر صداکننده‌ای گزینهٔ قدیمی را هنوز بفرستد، دیگر اثری ندارد.
  r = await settleTopup({ trackId: track2 }, { closeIfUnpaid: true });
  check("settleTopup دیگر هیچ راهی برای بستن ندارد", getTopup(o2.id).status === "awaiting_payment", getTopup(o2.id).status);

  // حالا صاحب سفارش واقعاً پرداخت می‌کند و از درگاه برمی‌گردد.
  verifyResult = 100;
  page = await anon(`trackId=${track2}&success=1`);
  check("بازگشتِ واقعی پس از پرداخت واریز می‌کند", page.status === 200 && getTopup(o2.id).status === "approved", `${page.status} · ${getTopup(o2.id).status}`);
  check("دقیقاً سکهٔ همان سفارش واریز شد", bal() === start + p1.coins + p2.coins, `${bal()} (انتظار ${start + p1.coins + p2.coins})`);
  check("صفحهٔ «پرداخت موفق» هم پکیج و سکه را لو نمی‌دهد", leaks(page.html).length === 0, leaks(page.html).join(" | "));

  verifyResult = 201;
  page = await anon(`trackId=${track2}&success=1`);
  check("بازگشتِ دوباره واریز دوباره نمی‌کند", bal() === start + p1.coins + p2.coins && leaks(page.html).length === 0, String(bal()));

  // ── راه برگشت: فقط ربات سکوی صاحب سفارش، و بی «بازکردن اپ» ──────────────────
  //
  // بازگشت از بانک در مرورگرِ بیرونی باز می‌شود؛ `/app` آنجا فقط صفحهٔ ورود
  // است، و کاربر بله با دکمهٔ تلگرام به چتی می‌رفت که در آن نبود.
  const fakeApi = (username) => ({ getMe: async () => ({ username }) });
  await resolveBotLinks(fakeApi("paschi_tg_bot"), fakeApi("paschi_bale_bot"));
  const baleOwner = resolveIdentity({ platform: "bale", platformUserId: "77001", name: "بله‌ای" });
  const ob = await beginTopup(baleOwner.tg_id, "p4");
  verifyResult = 100;
  page = await anon(`trackId=${getTopup(ob.id).track_id}&success=1`);
  check("صفحهٔ بازگشتِ کاربر بله ربات بله را نشان می‌دهد", page.html.includes("ble.ir/paschi_bale_bot"));
  check("… و ربات تلگرام را نه", !page.html.includes("t.me/paschi_tg_bot"));
  check("«بازکردن اپ» برای کاربر ربات نیست", !page.html.includes('href="/app"'));
  page = await anon("trackId=987654321&success=1");
  check("سفارش ناشناس هر دو ربات را نشان می‌دهد، بی اپ",
    page.html.includes("t.me/paschi_tg_bot") && page.html.includes("ble.ir/paschi_bale_bot") && !page.html.includes('href="/app"'));
} finally {
  await new Promise((ok) => server.close(ok));
}

// ── انصراف از ربات — تنها راهِ بستنِ سفارشِ درگاهی ────────────────────────────
{
  const before = bal();
  const o3 = await beginTopup(TG, "p6");
  check("انصراف کاربر روی سفارش درگاهی", cancelTopup(o3.id, TG) && getTopup(o3.id).status === "rejected");
  check("انصراف با شناسهٔ غلط رد می‌شود", cancelTopup(o.id, 1) === false);
  verifyResult = 100;
  r = await settleTopup({ topupId: o3.id });
  check("سفارش بسته دیگر تسویه نمی‌شود، حتی با verify موفق", r.outcome !== "credited" && bal() === before, r.outcome);
}

// ── سفارشِ بازمانده از قیمت قبلی ─────────────────────────────────────────────
//
// کاربر پرداخت را پیش از استقرار باز کرده و بعد از آن پرداخت می‌کند. اگر
// واریز از `PACKAGES` امروز خوانده می‌شد، یا سکهٔ اشتباه می‌گرفت یا (با
// مقایسهٔ سخت مبلغ) پولش می‌رفت و سکه نمی‌آمد.
{
  const before = bal();
  const o4 = await beginTopup(TG, "p4");
  const stored = getTopup(o4.id);
  const pkg = findPackage("p4");
  const saved = { coins: pkg.coins, price: pkg.price };
  // «استقرار»: همان شناسه، سکه و قیمتِ دیگر
  pkg.coins = saved.coins + 7;
  pkg.price = saved.price + 12_000;
  try {
    verifyResult = 100;
    const v = await zibalVerify(stored.track_id);
    check("درگاه مبلغِ زمانِ ساخت را برمی‌گرداند، نه قیمت امروز", v.amountToman === stored.price_toman, `${v.amountToman} · ${stored.price_toman}`);
    const r4 = await settleTopup({ trackId: stored.track_id });
    check("سفارش قدیمی پس از تغییر قیمت واریز می‌شود", r4.outcome === "credited", r4.outcome);
    check("سکهٔ ذخیره‌شده روی ردیف واریز شد، نه سکهٔ پکیج امروز", bal() === before + stored.coins, `${bal()} (انتظار ${before + stored.coins})`);
    check("قیمت روی ردیف همان قیمت زمانِ ساخت ماند", getTopup(o4.id).price_toman === saved.price, String(getTopup(o4.id).price_toman));
  } finally {
    Object.assign(pkg, saved);
  }
}

// ── سفارش ناشناس ─────────────────────────────────────────────────────────────
r = await settleTopup({ trackId: "424242" });
check("trackId ناشناس", r.outcome === "unknown");

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
