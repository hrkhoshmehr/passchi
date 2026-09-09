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
 * • انصراف در درگاه (`success=0`) سفارش را می‌بندد؛ «بررسی پرداخت» از ربات
 *   سفارشِ پرداخت‌نشده را باز نگه می‌دارد.
 *
 * اجرا: DATA_DIR=./data/tmp-gw node --import tsx scripts/test-topup-gateway.mjs
 */
process.env.ZIBAL_MERCHANT ||= "zibal";
process.env.PUBLIC_URL ||= "https://example.test";
process.env.CARD_NUMBER = "";
process.env.BOT_TOKEN ||= "x";

let verifyResult = 202;
let nextTrack = 5000;
const calls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), body });
  const reply = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (String(url).endsWith("/v1/request")) {
    if (body.merchant !== "zibal") return reply({ result: 102, message: "merchant not found" });
    if (!body.callbackUrl?.startsWith("https://")) return reply({ result: 106 });
    return reply({ result: 100, message: "success", trackId: ++nextTrack });
  }
  if (String(url).endsWith("/v1/verify")) {
    // تأخیر کوچک تا دو تسویهٔ همزمان واقعاً هم‌پوشان باشند
    await new Promise((r) => setTimeout(r, 20));
    if (verifyResult === 100) return reply({ result: 100, amount: body.amount ?? 1180000, refNumber: 777, status: 1 });
    return reply({ result: verifyResult, message: "x" });
  }
  throw new Error("unexpected " + url);
};

const { upsertUser, getUser, getTopup } = await import("../src/db/index.ts");
const { beginTopup, settleTopup, cancelTopup, gatewayConfigured } = await import("../src/bot/topup.ts");
const { balanceCoins, findPackage } = await import("../src/billing/coins.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const TG = 9101;
upsertUser(TG, "آزمون درگاه", "gw");
const bal = () => balanceCoins(getUser(TG).credit_sec);
const start = bal();
const p1 = findPackage("p1");

check("درگاه تنظیم است", gatewayConfigured());

// ── شروع ────────────────────────────────────────────────────────────────────
const o = await beginTopup(TG, "p1");
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

// ── انصراف در درگاه ───────────────────────────────────────────────────────────
const o2 = await beginTopup(TG, "p2");
verifyResult = 202;
r = await settleTopup({ trackId: getTopup(o2.id).track_id }, { closeIfUnpaid: true });
check("success=0 سفارش را می‌بندد", r.outcome === "unpaid" && getTopup(o2.id).status === "rejected", getTopup(o2.id).status);
verifyResult = 100;
r = await settleTopup({ topupId: o2.id });
check("سفارش بسته دیگر تسویه نمی‌شود، حتی با verify موفق", r.outcome !== "credited" && bal() === start + p1.coins, r.outcome);

// ── انصراف از ربات ───────────────────────────────────────────────────────────
const o3 = await beginTopup(TG, "p3");
check("انصراف کاربر روی سفارش درگاهی", cancelTopup(o3.id, TG) && getTopup(o3.id).status === "rejected");
check("انصراف با شناسهٔ غلط رد می‌شود", cancelTopup(o.id, 1) === false);

// ── سفارش ناشناس ─────────────────────────────────────────────────────────────
r = await settleTopup({ trackId: "424242" });
check("trackId ناشناس", r.outcome === "unknown");

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
