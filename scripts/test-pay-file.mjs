/**
 * «💳 پرداخت همین فایل» — از دکمه تا ادامهٔ همان فایل.
 *
 * ۱) صفحهٔ موجودیِ کم «پرداخت همین فایل» و «بی‌خیال» دارد — نه شارژِ حساب، نه خرید گروهی.
 * ۲) دکمه سفارشی به‌اندازهٔ **کسریِ همین فایل** در درگاه می‌سازد، نه یک پکیج.
 * ۳) پس از verifyِ موفق همان مبلغ واریز می‌شود و پیامِ «ادامهٔ همون فایل» می‌آید.
 * ۴) کسی که دیگر کسری ندارد سفارش نمی‌سازد؛ غریبه هم نه.
 *
 * زیبال و تلگرام هر دو جعلی‌اند؛ هیچ درخواستی بیرون نمی‌رود.
 *
 * اجرا: DATA_DIR=./data/tmp-payfile node --import tsx scripts/test-pay-file.mjs
 */
process.env.ZIBAL_MERCHANT ||= "zibal";
process.env.PUBLIC_URL ||= "https://example.test";
process.env.CARD_NUMBER = "";
process.env.BOT_TOKEN ||= "111:aaa";
process.env.GROUP_BUY = "true";
process.env.FREE_FIRST_FILE = "false";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let verifyResult = 202;
let nextTrack = 7000;
const zibal = [];
const amountOf = new Map();
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  zibal.push({ url: String(url), body });
  const reply = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (String(url).endsWith("/v1/request")) {
    amountOf.set(++nextTrack, body.amount);
    return reply({ result: 100, message: "success", trackId: nextTrack });
  }
  if (String(url).endsWith("/v1/verify")) {
    if (verifyResult === 100) return reply({ result: 100, amount: amountOf.get(body.trackId), refNumber: 555, status: 1 });
    return reply({ result: verifyResult, message: "x" });
  }
  throw new Error("unexpected " + url);
};

const { bot, lowBalanceKeyboard } = await import("../src/bot/index.ts");
const { setNotifyApis } = await import("../src/bot/notify.ts");
const { createSession, updateSession, getUser, getTopup, db } = await import("../src/db/index.ts");
const { resolveIdentity } = await import("../src/db/identity.ts");
const { grant } = await import("../src/billing/ledger.ts");
const { fileTopup, fmtToman, priceOf } = await import("../src/billing/money.ts");
const { settleTopup } = await import("../src/bot/topup.ts");
const { config } = await import("../src/config.ts");
const S = await import("../src/bot/strings.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ─── ربات جعلی ───────────────────────────────────────────────────────────────
const botInfo = {
  id: 1, is_bot: true, first_name: "passchi", username: "passchi",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business_account: false, has_main_web_app: false,
};
bot.botInfo = botInfo;
let calls = [];
let nextMessageId = 100;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method === "getMe") return { ok: true, result: botInfo };
  if (method.startsWith("answer") || method.startsWith("edit") || method.startsWith("delete")) return { ok: true, result: true };
  return { ok: true, result: { message_id: ++nextMessageId, date: 0, chat: { id: payload.chat_id, type: "private" } } };
});
setNotifyApis(bot.api, null);

let updateId = 0;
async function press(data, fromId) {
  calls = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from: { id: fromId, is_bot: false, first_name: "u" },
      chat_instance: "ci",
      data,
      message: { message_id: 10, date: 0, chat: { id: fromId, type: "private" }, from: botInfo, text: "…" },
    },
  });
  return calls;
}
const buttons = (cs) =>
  cs.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat() ?? []);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "passchi-payfile-"));
const OWNER_PID = 55_001;
const owner = resolveIdentity({ platform: "telegram", platformUserId: String(OWNER_PID), name: "مالک" }).tg_id;
grant(owner, 20_000, "trial");
const COST = priceOf(90 * 60); // ۱۳۵٬۰۰۰ تومان
const SHORT = COST - 20_000;
const SID = "abcd0000abcd0001";
createSession(SID, owner, null);
const audio = path.join(tmp, "a.m4a");
fs.writeFileSync(audio, "x");
updateSession(SID, { status: "awaiting_credit", original_ms: 90 * 60 * 1000, original_file: audio, mode: "full" });

// ─── ۱) صفحهٔ موجودیِ کم ────────────────────────────────────────────────────────
{
  const low = lowBalanceKeyboard(SID).inline_keyboard;
  check("«پرداخت همین فایل» ردیفِ اول", low[0][0].callback_data === `pf:${SID}`);
  const flat = low.flat();
  check("زیرش فقط «بی‌خیال»", flat.map((b) => b.callback_data).join(" ") === `pf:${SID} nogo:${SID}`, flat.map((b) => b.callback_data).join(" "));
  check("شارژِ حساب کنارِ «پرداخت همین فایل» نیست", !flat.some((b) => b.callback_data === "topup"));
  check("خرید گروهی دیگر روی صفحهٔ موجودیِ کم نیست", !flat.some((b) => b.callback_data.startsWith("gb")));
  const t = fileTopup(SHORT);
  check("مبلغِ «پرداخت همین فایل» همان کسری است، گرد به هزار", t.price === SHORT && t.credit === t.price, JSON.stringify(t));
  check("متنِ موجودیِ کم مبلغِ دقیقِ همین فایل را می‌گوید", S.lowBalanceMessage(COST, 20_000, true).includes(fmtToman(t.price)), fmtToman(t.price));
  const small = fileTopup(15_000);
  check(
    "کسریِ کوچک به کمترین شارژ گرد می‌شود و اضافه‌اش گفته می‌شود",
    small.price === 50_000 && S.lowBalanceMessage(20_000, 5_000, true).includes(fmtToman(35_000)),
    JSON.stringify(small),
  );
  check("متنِ سهمِ جزوهٔ هم‌کلاسی «همین فایل» ندارد", !S.lowBalanceMessage(15_000, 0).includes("همین فایل"));
}

// ─── ۲) دکمه ⇒ سفارشِ به‌اندازهٔ کسری ───────────────────────────────────────
const want = fileTopup(SHORT); // ۱۳۵ هزار لازم، ۲۰ هزار دارد
let cs = await press(`pf:${SID}`, OWNER_PID);
const req = zibal.find((z) => z.url.endsWith("/v1/request"));
check("درگاه صدا زده شد", Boolean(req));
check("مبلغِ درگاه همان مبلغِ کسری است (ریال)", req?.body.amount === want.price * 10, `${req?.body.amount} · ${want.price * 10}`);
const payBtn = buttons(cs).find((b) => b.url?.startsWith("https://gateway.zibal.ir/start/"));
check("لینکِ پرداخت برای دانشجو فرستاده شد", Boolean(payBtn));
const row = db.prepare(`SELECT * FROM topups WHERE tg_id = ? ORDER BY created_at DESC LIMIT 1`).get(owner);
check("ردیفِ سفارش: package_id = file، اعتبار = کسری، مبلغ = همان", row.package_id === "file" && row.credit_toman === want.credit && row.price_toman === want.price, JSON.stringify({ p: row.package_id, c: row.credit_toman, t: row.price_toman }));

// ─── ۳) پرداخت ⇒ واریز و ادامهٔ همان فایل ───────────────────────────────────
calls = [];
verifyResult = 100;
const r = await settleTopup({ topupId: row.id });
check("پرداختِ تأییدشده واریز شد", r.outcome === "credited", r.outcome);
check("حالا موجودی دقیقاً هزینهٔ فایل است", getUser(owner).credit_toman === COST, String(getUser(owner).credit_toman));
check("پیامِ واریز دکمهٔ «ادامهٔ همون فایل» دارد", buttons(calls).some((b) => b.callback_data === `resume:${SID}`), buttons(calls).map((b) => b.callback_data).join(" "));
check("تسویهٔ دوباره واریزِ دوباره نمی‌کند", (await settleTopup({ topupId: row.id })).outcome === "already" && getUser(owner).credit_toman === COST);
check("سفارش approved ماند", getTopup(row.id).status === "approved");

// ─── ۴) بی‌کسری و غریبه ──────────────────────────────────────────────────────
{
  const before = zibal.length;
  cs = await press(`pf:${SID}`, OWNER_PID);
  const alert = cs.find((c) => c.method === "answerCallbackQuery");
  check("بی‌کسری: سفارشی ساخته نمی‌شود", zibal.length === before);
  // صفحهٔ موجودیِ کم دکمهٔ «شروع کن» ندارد؛ پس به آن ارجاع نمی‌دهد و خودش شروع می‌کند.
  check("… و به دکمه‌ای که روی صفحه نیست ارجاع نمی‌دهد", !alert?.payload.text?.includes(S.CONFIRM_BTN.go) && Boolean(alert?.payload.text?.includes("شروع کردم")), alert?.payload.text);

  const strangerPid = 55_002;
  resolveIdentity({ platform: "telegram", platformUserId: String(strangerPid), name: "غریبه" });
  cs = await press(`pf:${SID}`, strangerPid);
  check("غریبه سفارشی برای فایلِ دیگری نمی‌سازد", zibal.length === before && cs.some((c) => c.method === "answerCallbackQuery" && c.payload.text?.includes("مال تو نیست")));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
