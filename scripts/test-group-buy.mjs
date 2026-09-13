/**
 * خرید گروهی — پول درست جابه‌جا می‌شود، و هیچ رزروی بی‌پایان نمی‌ماند.
 *
 * ## چه چیزی اینجا قفل می‌شود
 *
 *   ۱) سهمِ برابر: `ceil(هزینه / نفر)`، و برچسبِ «با سکهٔ هدیه میشه».
 *   ۲) سهمِ مالک همان لحظهٔ باز شدن رزرو می‌شود؛ مالکی که یک سهم ندارد گروهی
 *      نمی‌سازد و هیچ ردی نمی‌ماند.
 *   ۳) ورود رزرو می‌کند و عضو می‌سازد؛ ورودِ دوباره و ورودِ خودِ مالک رد می‌شود.
 *   ۴) **ری‌استارت گروهِ باز را خالی نمی‌کند** — `recoverInterrupted` هر رزروِ
 *      بی‌تسویه را آویزان می‌شمارد و بی استثنا هر استقرار همهٔ گروه‌ها را
 *      برمی‌گرداند.
 *   ۵) سقفِ هفتگیِ سکهٔ هدیه: سهمِ هدیه رد می‌شود، سهمِ خریداری‌شده می‌رود.
 *   ۶) پر شدن قفل و شروع می‌کند؛ موفقیت همه را تسویه می‌کند و مالک اختلافِ
 *      مدت را می‌دهد.
 *   ۷) «بقیه‌اش رو خودم می‌دم» پر و شروع می‌کند؛ شکستِ کار همه را برمی‌گرداند.
 *   ۸) انقضای ۴۸ ساعته دقیقاً برمی‌گرداند و جلسه را با فایلش به حالتی
 *      برمی‌گرداند که مالک تنها بپردازد — در ربات و در مینی‌اپ.
 *   ۹) رزروِ تازه پس از یک گروهِ منقضی، در ری‌استارت دیده می‌شود (دامِ سطرِ
 *      برگشتِ قدیمی که رزروِ تازه را پنهان می‌کرد).
 *  ۱۰) جمعِ دفتر برای هر جلسه با پایانش می‌خواند.
 *
 * اجرا: DATA_DIR=./data/tmp-group npx tsx scripts/test-group-buy.mjs
 */
process.env.BOT_TOKEN ||= "111:aaa";
process.env.GROUP_BUY = "true";
process.env.FREE_TRIAL_COINS = "20";
// سه سهمِ هدیهٔ ۱۸ سکه‌ای جا می‌شود، چهارمی نه.
process.env.GROUP_BUY_GIFT_COINS_PER_WEEK = "60";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { db, createSession, updateSession, getSession, upsertUser, listHistory, pendingWebUploadId } =
  await import("../src/db/index.ts");
const { grant, currentBalance, reserve, danglingReservations, orphanedQueued } = await import(
  "../src/billing/ledger.ts"
);
const { coinsToSec, groupSeat, GROUP_SIZES } = await import("../src/billing/coins.ts");
const GB = await import("../src/billing/group-buy.ts");
const { shareStatus } = await import("../src/billing/sharing.ts");
const { recoverInterrupted } = await import("../src/jobs/service.ts");
const { joinGroup, openGroup, payRestAndStart, startGroup, expireGroupsAndNotify, groupSizeKeyboard } =
  await import("../src/bot/group-buy.ts");
const S = await import("../src/bot/strings.ts");
const { lowBalanceKeyboard } = await import("../src/bot/index.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "passchi-group-"));
const audio = (name) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, "x");
  return p;
};

let nextUser = 8_800_000;
/** کاربر با سکهٔ هدیه (`trial`) و/یا خریداری‌شده (`topup`). */
function user(gift = 0, bought = 0) {
  const id = ++nextUser;
  upsertUser(id, `u${id}`, null);
  if (gift) grant(id, coinsToSec(gift), "trial");
  if (bought) grant(id, coinsToSec(bought), "topup");
  return id;
}

let nextSession = 0;
function session(owner, origin = "bot", costSec = 5400) {
  const id = `ab${String(++nextSession).padStart(10, "0")}`;
  createSession(id, owner, null);
  updateSession(id, {
    status: origin === "web" ? "queued" : "awaiting_credit",
    original_file: audio(`${id}.m4a`),
    original_ms: costSec * 1000,
    mode: "full",
    download_route: origin === "web" ? "web" : "bot-api",
  });
  return id;
}

/** جمعِ دفتر برای یک جلسه، به تفکیک نفر. */
function ledgerBy(sessionId) {
  const rows = db
    .prepare(`SELECT tg_id AS id, SUM(delta_sec) AS sum FROM credit_ledger WHERE session_id = ? GROUP BY tg_id`)
    .all(sessionId);
  return Object.fromEntries(rows.map((r) => [r.id, r.sum]));
}
const ledgerTotal = (sessionId) => Object.values(ledgerBy(sessionId)).reduce((a, b) => a + b, 0);
const isMemberRow = (sid, uid) =>
  Boolean(db.prepare(`SELECT 1 FROM session_members WHERE session_id = ? AND tg_id = ?`).get(sid, uid));

/** جای خط لوله: فقط ثبت می‌کند که کار با چه مشخصاتی راه افتاد. */
const started = [];
const deps = { startJob: (spec) => started.push(spec) };
const spy = [];
const notify = async (userId, text, extra = {}) => spy.push({ userId, text, extra });

// ─── ۱) سهمِ برابر و برچسب‌ها ────────────────────────────────────────────────
{
  const seats = Object.fromEntries(GROUP_SIZES.map((n) => [n, groupSeat(5400, n).seatCoins]));
  check("کلاس ۹۰ سکه‌ای: ۳ نفر ۳۰، ۵ نفر ۱۸، ۱۰ نفر ۹، ۲۰ نفر ۵", JSON.stringify(seats) === '{"3":30,"5":18,"10":9,"20":5}', JSON.stringify(seats));
  check("سهم به بالا گرد می‌شود: ۹۱ سکه بین ۵ نفر ⇒ ۱۹", groupSeat(91 * 60, 5).seatCoins === 19);
  check("برچسبِ «با سکهٔ هدیه میشه» وقتی سهم ≤ هدیه", S.groupSizeLabel(5, 18, 20).includes("با سکهٔ هدیه میشه"), S.groupSizeLabel(5, 18, 20));
  check("و نه وقتی سهم از هدیه بیشتر است", !S.groupSizeLabel(3, 30, 20).includes("هدیه"), S.groupSizeLabel(3, 30, 20));
  const kb = groupSizeKeyboard("ab00", 5400).inline_keyboard.flat();
  check("هیچ اندازه‌ای پنهان نیست", GROUP_SIZES.every((n) => kb.some((b) => b.callback_data === `gbn:ab00:${n}`)));
  check("«بی‌خیال» به دو گزینه برمی‌گردد", kb.some((b) => b.callback_data === "gbx:ab00"));
  check("برچسبِ دکمه همان «۵ نفر · نفری ۱۸ سکه»", kb.some((b) => b.text.startsWith("۵ نفر · نفری ۱۸ سکه")), kb.map((b) => b.text).join(" | "));

  const low = lowBalanceKeyboard("ab00").inline_keyboard;
  check(
    "صفحهٔ سکهٔ کم: دو گزینهٔ هم‌وزن در یک ردیف",
    low[0].length === 2 && low[0][0].text === S.GROUP_BTN.self && low[0][1].text === S.GROUP_BTN.group,
    low.map((r) => r.map((b) => b.text).join(" + ")).join(" / "),
  );
  check("دکمهٔ شریک‌شدنِ پس از تحویل همچنان اینجا نیست", !low.flat().some((b) => b.callback_data.startsWith("spre:")));
  check("جملهٔ دلگرمی زیرِ پیام هست", S.lowBalanceGroupMessage(5400, coinsToSec(20)).includes(S.GROUP_REASSURE));
}

// ─── ۲) باز شدن: سهمِ مالک رزرو می‌شود ──────────────────────────────────────
const OWNER = user(20); // فقط هدیه
const S1 = session(OWNER);
{
  const refusedSize = openGroup({ sessionId: S1, ownerId: OWNER, costSec: 5400, people: 4, origin: "bot" });
  check("اندازهٔ بی‌دکمه رد می‌شود", !refusedSize.ok && refusedSize.reason === "bad_size");

  const poor = user(10);
  const PS = session(poor);
  const short = openGroup({ sessionId: PS, ownerId: poor, costSec: 5400, people: 5, origin: "bot" });
  check("مالکی که یک سهم ندارد رد می‌شود", !short.ok && short.reason === "short" && short.seatSec === coinsToSec(18));
  check("…و هیچ گروهی نمی‌ماند", GB.groupBuy(PS) === null);
  check("…و وضعیت و موجودی دست نخورد", getSession(PS).status === "awaiting_credit" && currentBalance(poor) === coinsToSec(10));

  const out = openGroup({ sessionId: S1, ownerId: OWNER, costSec: 5400, people: 5, origin: "bot" });
  check("گروه باز شد", out.ok, JSON.stringify(out));
  check("سهمِ مالک همین حالا رزرو شد", currentBalance(OWNER) === coinsToSec(2), String(currentBalance(OWNER)));
  check("جلسه منتظرِ هم‌کلاسی‌هاست", getSession(S1).status === "awaiting_group");
  check("برچسبِ وضعیت فارسی است", S.sessionStatusLabel("awaiting_group") === "منتظرِ هم‌کلاسی‌ها");
  check("۱ از ۵", out.ok && out.progress.filled === 1 && out.progress.seats === 5);
  const again = openGroup({ sessionId: S1, ownerId: OWNER, costSec: 5400, people: 5, origin: "bot" });
  check("گروهِ دوم روی همان جلسه رد می‌شود", !again.ok && again.reason === "exists");
}

// ─── ۳) ورود ───────────────────────────────────────────────────────────────
const M1 = user(0, 100); // خریداری‌شده
{
  const r = await joinGroup(S1, M1, deps);
  check("هم‌کلاسی وارد شد", r.ok && r.progress.filled === 2, JSON.stringify(r));
  check("سهمش رزرو شد", currentBalance(M1) === coinsToSec(100 - 18));
  check("عضوِ جلسه شد", isMemberRow(S1, M1));
  check("جلسه در «📚 جلسه‌های من»ِ او هست", listHistory(M1, 10, 0).some((x) => x.id === S1 && x.joined === 1));

  const twice = await joinGroup(S1, M1, deps);
  check("ورودِ دوباره رد می‌شود", !twice.ok && twice.reason === "already");
  check("…و دوباره کم نمی‌شود", currentBalance(M1) === coinsToSec(100 - 18));
  const self = await joinGroup(S1, OWNER, deps);
  check("مالک نمی‌تواند وارد گروهِ خودش شود", !self.ok && self.reason === "owner");

  const broke = user(5);
  const short = await joinGroup(S1, broke, deps);
  check("کم‌سکه: کسریِ دقیق برمی‌گردد", !short.ok && short.reason === "short" && short.seatSec - short.balanceSec === coinsToSec(13));
  check("…و عضو نشد", !isMemberRow(S1, broke) && currentBalance(broke) === coinsToSec(5));
}

// ─── ۴) ری‌استارت گروهِ باز را خالی نمی‌کند ────────────────────────────────
{
  const before = { o: currentBalance(OWNER), m: currentBalance(M1) };
  spy.length = 0;
  check("گروهِ باز آویزان شمرده نمی‌شود", !danglingReservations().some((d) => d.sessionId === S1));
  const n = recoverInterrupted(notify);
  check("ری‌استارت چیزی از گروهِ باز برنگرداند", currentBalance(OWNER) === before.o && currentBalance(M1) === before.m);
  check("وضعیت همچنان منتظرِ هم‌کلاسی‌هاست", getSession(S1).status === "awaiting_group", getSession(S1).status);
  check("خبری هم نرفت", spy.length === 0 && n === 0, `${spy.length} / ${n}`);
  check("گروه باز ماند", GB.groupProgress(S1).status === "open");
  check("و `orphanedQueued` هم سراغش نمی‌رود", !orphanedQueued(0).some((o) => o.id === S1));
}

// ─── ۵) سقفِ هفتگیِ هدیه ────────────────────────────────────────────────────
const M2 = user(20);
const M3 = user(20);
const M4 = user(20);
const M5 = user(0, 50);
{
  // مالک ۱۸ سکه هدیه گذاشته؛ M2 و M3 هم ⇒ ۵۴ از ۶۰
  check("سهمِ هدیهٔ دوم پذیرفته شد", (await joinGroup(S1, M2, deps)).ok);
  const r3 = await joinGroup(S1, M3, deps);
  check("سهمِ هدیهٔ سوم پذیرفته شد", r3.ok && r3.progress.filled === 4);
  check("کار هنوز شروع نشده", started.length === 0);

  const r4 = await joinGroup(S1, M4, deps);
  check("سهمِ هدیهٔ چهارم از سقف رد شد", !r4.ok && r4.reason === "gift_cap", JSON.stringify(r4));
  check("…با پیامِ ساده دربارهٔ سکهٔ خریداری‌شده", S.GROUP_REFUSAL.gift_cap.includes("سکهٔ خریداری‌شده"));
  check("…و هیچ سکه‌ای از او کم نشد", currentBalance(M4) === coinsToSec(20) && !isMemberRow(S1, M4));

  // ─── ۶) پر شدن: قفل، شروع، تسویه ─────────────────────────────────────────
  const r5 = await joinGroup(S1, M5, deps);
  check("سهمِ خریداری‌شده با سقفِ پر هم می‌رود", r5.ok, JSON.stringify(r5));
  check("پنجمین نفر گروه را پر کرد و کار شروع شد", r5.ok && r5.started && started.length === 1);
  check("کار با رزروهای گروه راه افتاد، نه رزروِ تازه", started[0]?.groupBuy === true && started[0]?.userId === OWNER);
  check("گروه قفل شد", GB.groupProgress(S1).status === "started");
  check("جلسه در صف است", getSession(S1).status === "queued");
  check("شروعِ دوباره ممکن نیست", (await startGroup(S1, deps)) === false && started.length === 1);
  const late = await joinGroup(S1, user(0, 50), deps);
  check("ورود پس از شروع رد می‌شود", !late.ok && late.reason === "closed");

  // موفقیت: مدت همان تخمین ⇒ مالک دقیقاً یک سهم
  const ownerSec = GB.settleGroupBuy(S1, 5400);
  const by = ledgerBy(S1);
  check("مالک یک سهم داد", ownerSec === coinsToSec(18) && by[OWNER] === -coinsToSec(18), JSON.stringify(by));
  check("هر هم‌کلاسی دقیقاً یک سهم داد", [M1, M2, M3, M5].every((m) => by[m] === -coinsToSec(18)));
  check("جمعِ دفتر = هزینهٔ واقعی", ledgerTotal(S1) === -5400, String(ledgerTotal(S1)));
  check("گروه تمام شد", GB.groupBuy(S1).status === "done");
  updateSession(S1, { status: "done" });
  check("پس از تمام‌شدن هیچ رزروی آویزان نیست", !danglingReservations().some((d) => d.sessionId === S1));
  const st = shareStatus(S1);
  check(
    "شریک‌شدنِ بعدی: سقفِ برگشت روی سهمِ مالک است، نه کلِ جلسه",
    st.capSec <= coinsToSec(18) / 2 && st.capSec > 0,
    `سقف ${st.capSec / 60} سکه`,
  );
}

// ─── ۶ب) مدتِ واقعی بیشتر: مالک اختلاف را می‌دهد ────────────────────────────
{
  const O = user(0, 200);
  const A = user(0, 100);
  const B = user(0, 100);
  const sid = session(O);
  openGroup({ sessionId: sid, ownerId: O, costSec: 5400, people: 3, origin: "bot" });
  await joinGroup(sid, A, deps);
  const r = await joinGroup(sid, B, deps);
  check("گروهِ سه‌نفره پر و شروع شد", r.ok && r.started);
  GB.settleGroupBuy(sid, 5400 + 300);
  // خط لوله پیش از تسویه جلسه را «done» می‌کند؛ بی آن ری‌استارتِ آزمون‌های بعدی سهمِ اعضا را آویزان می‌دید.
  updateSession(sid, { status: "done" });
  const by = ledgerBy(sid);
  check("هم‌کلاسی‌ها همان سهمِ ثابت", by[A] === -coinsToSec(30) && by[B] === -coinsToSec(30));
  check("مالک سهم و پنج دقیقهٔ اضافه", by[O] === -(coinsToSec(30) + 300), String(by[O]));
  check("جمع = مدتِ واقعی", ledgerTotal(sid) === -5700);
}

// ─── ۷) «بقیه‌اش رو خودم می‌دم» و شکستِ کار ─────────────────────────────────
{
  const O = user(0, 200);
  const A = user(0, 100);
  const sid = session(O, "web");
  const startO = currentBalance(O);
  const startA = currentBalance(A);
  openGroup({ sessionId: sid, ownerId: O, costSec: 5400, people: 10, origin: "web" });
  await joinGroup(sid, A, deps);
  const before = started.length;
  const r = await payRestAndStart(sid, O, deps);
  check("مالک بقیه را داد و کار شروع شد", r.ok && r.started && started.length === before + 1);
  check("مالک ۹ سهم رزرو کرد", startO - currentBalance(O) === 9 * coinsToSec(9), String(startO - currentBalance(O)));
  check("هم‌کلاسی فقط سهمِ خودش", startA - currentBalance(A) === coinsToSec(9));

  const closed = GB.refundGroupBuy(sid, "کار ناموفق بود");
  check("شکستِ کار همه را برگرداند", Boolean(closed) && currentBalance(O) === startO && currentBalance(A) === startA);
  check("جمعِ دفترِ این جلسه صفر", ledgerTotal(sid) === 0, String(ledgerTotal(sid)));
  check("برگشتِ دوباره پول نمی‌دهد", GB.refundGroupBuy(sid, "x") === null && currentBalance(O) === startO);
}

// ─── ۸) انقضای ۴۸ ساعته ────────────────────────────────────────────────────
{
  const O = user(0, 100);
  const A = user(0, 100);
  const sid = session(O, "bot");
  const file = getSession(sid).original_file;
  openGroup({ sessionId: sid, ownerId: O, costSec: 5400, people: 3, origin: "bot" });
  await joinGroup(sid, A, deps);

  const early = await expireGroupsAndNotify(new Date(Date.now() + 47 * 3_600_000));
  check("پیش از ۴۸ ساعت منقضی نمی‌شود", early === 0 && GB.groupBuy(sid).status === "open");

  const n = await expireGroupsAndNotify(new Date(Date.now() + 49 * 3_600_000));
  check("پس از ۴۸ ساعت منقضی شد", n >= 1 && GB.groupBuy(sid).status === "expired");
  check("مالک دقیقاً همان موجودی را دارد", currentBalance(O) === coinsToSec(100), String(currentBalance(O)));
  check("هم‌کلاسی هم", currentBalance(A) === coinsToSec(100));
  check("جمعِ دفتر برای هر نفر صفر", Object.values(ledgerBy(sid)).every((v) => v === 0), JSON.stringify(ledgerBy(sid)));
  check("جلسهٔ ربات به «منتظر شارژ» برگشت", getSession(sid).status === "awaiting_credit");
  check("فایل دست نخورد", getSession(sid).original_file === file && fs.existsSync(file));
  check("عضویتِ پیش از شروع برداشته شد", !isMemberRow(sid, A));
  check("ورود پس از انقضا رد می‌شود", ((await joinGroup(sid, user(0, 50), deps)).reason) === "closed");
  check("متنِ انقضا یک جمله است", !S.groupExpiredMessage("owner", "bot", 48).includes("\n"));

  // ─── ۹) پس از انقضا مالک تنها می‌پردازد؛ ری‌استارت وسطِ کار دیده می‌شود ───
  //
  // سطرهای «برگشت» گروهِ منقضی در دفتر مانده‌اند. نسخهٔ قبلیِ
  // `danglingReservations` جلسه‌ای را که *هر* سطرِ برگشتی داشت کلاً رها می‌کرد،
  // پس این رزروِ تازه در ری‌استارت هرگز برنمی‌گشت.
  updateSession(sid, { status: "queued" });
  reserve(O, 5400, sid);
  updateSession(sid, { status: "stt" });
  const d = danglingReservations().find((x) => x.sessionId === sid);
  check("رزروِ تازه پس از گروهِ منقضی آویزان دیده می‌شود", d?.tgId === O && d?.reservedSec === 5400, JSON.stringify(d));
  spy.length = 0;
  recoverInterrupted(notify);
  check("…و ری‌استارت برش گرداند", currentBalance(O) === coinsToSec(100), String(currentBalance(O)));
}

// ─── ۸ب) انقضا در مینی‌اپ: آپلودِ تأییدنشده دوباره پیشنهاد می‌شود ───────────
{
  const O = user(0, 100);
  const sid = session(O, "web");
  openGroup({ sessionId: sid, ownerId: O, costSec: 5400, people: 3, origin: "web" });
  check("آپلودِ گروهی «منتظرِ تأیید» پیشنهاد نمی‌شود", pendingWebUploadId(O) !== sid);
  await expireGroupsAndNotify(new Date(Date.now() + 49 * 3_600_000));
  check("جلسهٔ مینی‌اپ به صف برگشت", getSession(sid).status === "queued");
  check("و دوباره همان فایل پیشنهاد می‌شود", pendingWebUploadId(O) === sid);
  check("ری‌استارت آن را یتیم نمی‌شمارد", !orphanedQueued(0).some((o) => o.id === sid));
  const reopened = openGroup({ sessionId: sid, ownerId: O, costSec: 5400, people: 5, origin: "web" });
  check("گروهِ تازه روی همان فایل باز می‌شود", reopened.ok);
  GB.cancelGroupBuy(sid);
  check("لغو هم دقیقاً برمی‌گرداند", currentBalance(O) === coinsToSec(100));
}

// ─── ۱۰) ری‌استارت وسطِ کارِ گروهی: همه برمی‌گردند، دکمه فقط برای مالک ──────
{
  const O = user(0, 100);
  const A = user(0, 100);
  const sid = session(O);
  openGroup({ sessionId: sid, ownerId: O, costSec: 5400, people: 3, origin: "bot" });
  await joinGroup(sid, A, deps);
  await payRestAndStart(sid, O, deps);
  updateSession(sid, { status: "analyze" });
  spy.length = 0;
  recoverInterrupted(notify);
  check("هر دو نفر کامل برگشتند", currentBalance(O) === coinsToSec(100) && currentBalance(A) === coinsToSec(100));
  check("جمعِ دفتر صفر", ledgerTotal(sid) === 0);
  check("گروه شکست‌خورده ثبت شد", GB.groupBuy(sid).status === "failed");
  const buttons = (x) => (x.extra?.reply_markup?.inline_keyboard ?? []).flat();
  check("دکمهٔ «دوباره» فقط برای مالک", spy.filter((x) => buttons(x).length).every((x) => x.userId === O));
  check("هم‌کلاسی هم خبر گرفت", spy.some((x) => x.userId === A));
  // پولش برگشته؛ اگر عضو بماند و مالک تنها دوباره بزند، جزوه را مجانی می‌خواند.
  check("عضویتِ هم‌کلاسیِ برگشت‌خورده برداشته شد", !isMemberRow(sid, A));
}

// ─── ۱۱) گروه روی کاری که راه افتاده یا تمام شده باز نمی‌شود ────────────────
{
  const O = user(0, 100);
  const sid = session(O);
  reserve(O, 5400, sid);
  updateSession(sid, { status: "stt" });
  const r = openGroup({ sessionId: sid, ownerId: O, costSec: 5400, people: 3, origin: "bot" });
  check("رزروِ تنهای بی‌تسویه ← busy", !r.ok && r.reason === "busy", JSON.stringify(r));
  check("…و هیچ گروهی ساخته نشد", GB.groupBuy(sid) === null && getSession(sid).status === "stt");

  const O2 = user(0, 100);
  const sid2 = session(O2);
  updateSession(sid2, { status: "done" });
  const r2 = openGroup({ sessionId: sid2, ownerId: O2, costSec: 5400, people: 3, origin: "bot" });
  check("جلسهٔ تمام‌شده ← busy", !r2.ok && r2.reason === "busy");
  check("…و سکه‌ای رزرو نشد", currentBalance(O2) === coinsToSec(100));
  check("متنِ busy هست", typeof S.GROUP_REFUSAL.busy === "string" && S.GROUP_REFUSAL.busy.length > 0);

  // فاصلهٔ «پیام فرستاده شد، رزرو هنوز نه» در startJob ربات
  const Q = await import("../src/queue.ts");
  const O3 = user(0, 100);
  const sid3 = session(O3);
  Q.markStarting(sid3);
  const r3 = openGroup({ sessionId: sid3, ownerId: O3, costSec: 5400, people: 3, origin: "bot" });
  check("کارِ در حال شروع ← busy", !r3.ok && r3.reason === "busy");
  Q.clearStarting(sid3);
  const r4 = openGroup({ sessionId: sid3, ownerId: O3, costSec: 5400, people: 3, origin: "bot" });
  check("بعد از پاک‌شدنِ علامت، گروه باز می‌شود", r4.ok);
  GB.cancelGroupBuy(sid3);
  check("…و لغوش دقیقاً برمی‌گرداند", currentBalance(O3) === coinsToSec(100));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
