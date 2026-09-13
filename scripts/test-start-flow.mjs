/**
 * لحظهٔ «شروع کن» — سه باگی که دانشجو دید.
 *
 * ۱) سکه کم و «شروع کن»: صوت **به بایگانی نمی‌رود**، صفحهٔ سکهٔ کم «پرداخت همین
 *    فایل» دارد و جلسه منتظرِ شارژ می‌ماند (نه `queued` بی‌صاحب).
 * ۲) سکهٔ کافی: صوت دقیقاً یک بار به بایگانی می‌رود، همان لحظهٔ شروع.
 * ۳) پیامِ بلند: دکمه‌ها فقط زیرِ تکهٔ آخر، ریپلای روی همه.
 * ۴) بی‌کلام: پیام می‌گوید چقدر کم شد و بقیه برگشت.
 * ۵) درسِ جلسه پیش از شروع عوض می‌شود، و بعد از شروع نه.
 *
 * اجرا: DATA_DIR=./data/tmp-start node --import tsx scripts/test-start-flow.mjs
 */
process.env.BOT_TOKEN ||= "111:aaa";
process.env.ARCHIVE_CHAT_ID = "-1001234567890";
process.env.FREE_FIRST_FILE = "false";
process.env.GROUP_BUY = "true";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { bot } = await import("../src/bot/index.ts");
const { setNotifyApis } = await import("../src/bot/notify.ts");
const { setArchiveApi } = await import("../src/bot/archive.ts");
const { sendWithKeyboard } = await import("../src/bot/deliver.ts");
const { createSession, updateSession, getSession, getUser, createCourse } = await import("../src/db/index.ts");
const { resolveIdentity } = await import("../src/db/identity.ts");
const { grant } = await import("../src/billing/ledger.ts");
const { InlineKeyboard } = await import("grammy");
const S = await import("../src/bot/strings.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const botInfo = {
  id: 1, is_bot: true, first_name: "passchi", username: "passchi",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business_account: false, has_main_web_app: false,
};
bot.botInfo = botInfo;
let calls = [];
let mid = 500;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method === "getMe") return { ok: true, result: botInfo };
  if (method.startsWith("answer") || method.startsWith("edit") || method.startsWith("delete")) return { ok: true, result: true };
  return { ok: true, result: { message_id: ++mid, date: 0, chat: { id: payload.chat_id, type: "private" } } };
});
setNotifyApis(bot.api, null);
setArchiveApi(bot.api);

let n = 0;
const press = async (data, fromId) => {
  calls = [];
  await bot.handleUpdate({
    update_id: ++n,
    callback_query: {
      id: String(n), from: { id: fromId, is_bot: false, first_name: "u" }, chat_instance: "ci", data,
      message: { message_id: 10, date: 0, chat: { id: fromId, type: "private" }, from: botInfo, text: "…" },
    },
  });
  // کارِ صف و بایگانیِ `void` یک لحظه وقت می‌خواهند.
  await new Promise((r) => setTimeout(r, 300));
  return calls;
};
const archived = (cs) => cs.filter((c) => String(c.payload?.chat_id) === process.env.ARCHIVE_CHAT_ID && c.method === "sendAudio");
const btns = (cs) => cs.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat() ?? []).map((b) => b.callback_data);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "passchi-start-"));
const PID = 66_001;
const U = resolveIdentity({ platform: "telegram", platformUserId: String(PID), name: "آزمون" }).tg_id;
const mk = (sid, sec) => {
  const f = path.join(tmp, `${sid}.m4a`);
  fs.writeFileSync(f, "not really audio");
  createSession(sid, U, null);
  updateSession(sid, { status: "awaiting_confirm", original_ms: sec * 1000, original_file: f, mode: "full", download_route: "bot-api" });
  return sid;
};

// ─── ۱) سکه کم ───────────────────────────────────────────────────────────────
{
  grant(U, 50, "trial"); // ۵۰ ثانیه
  const sid = mk("aaaa0000aaaa0001", 100);
  const cs = await press(`go:${sid}`, PID);
  check("سکه کم: صوت به بایگانی نرفت", archived(cs).length === 0, cs.map((c) => c.method).join(" "));
  check("سکه کم: «پرداخت همین فایل» روی صفحه", btns(cs).includes(`pf:${sid}`), btns(cs).join(" "));
  check("سکه کم: جلسه منتظرِ شارژ است (بعد از شارژ پیشنهادِ ادامه می‌آید)", getSession(sid).status === "awaiting_credit", getSession(sid).status);
  check("سکه کم: هیچ سکه‌ای رزرو نشد", getUser(U).credit_sec === 50, String(getUser(U).credit_sec));
}

// ─── ۱ب) مسیری که بررسیِ بالای `resumeSession` را دور می‌زند ────────────────
//
// «🎁 اولین صوت رایگان» آن بررسی را عمداً رد می‌کند (رایگان هنوز واریز نشده).
// اگر رایگان رد شود و سکه کم باشد، فقط بررسیِ **پیش از شروع** جلوی بایگانی و
// بن‌بستِ `reserve` را می‌گیرد — همان بررسی که پیش‌تر نبود.
{
  const sid = mk("aaaa0000aaaa0004", 100);
  const cs = await press(`ff:${sid}`, PID);
  check("رایگانِ ردشده و سکهٔ کم: صوت به بایگانی نرفت", archived(cs).length === 0, cs.map((c) => c.method).join(" "));
  check("… «پرداخت همین فایل» روی صفحه", btns(cs).includes(`pf:${sid}`), btns(cs).join(" "));
  check("… و جلسه منتظرِ شارژ است", getSession(sid).status === "awaiting_credit", getSession(sid).status);
  check("… و هیچ سکه‌ای رزرو نشد", getUser(U).credit_sec === 50, String(getUser(U).credit_sec));
}

// ─── ۵) درس، پیش از شروع ─────────────────────────────────────────────────────
{
  const c = createCourse(U, "ریاضی مهندسی", null);
  const sid = mk("aaaa0000aaaa0003", 30);
  let cs = await press(`crs:${sid}`, PID);
  check("فهرستِ درس‌ها با «درس جدید» و «بدون درس»", btns(cs).includes(`crsset:${sid}:${c.id}`) && btns(cs).includes(`crsnew:${sid}`) && btns(cs).includes(`crsset:${sid}:0`), btns(cs).join(" "));
  await press(`crsset:${sid}:${c.id}`, PID);
  check("درس روی جلسه نشست", getSession(sid).course_id === c.id);
  const other = resolveIdentity({ platform: "telegram", platformUserId: "66002", name: "غریبه" }).tg_id;
  const foreign = createCourse(other, "درسِ غریبه", null);
  await press(`crsset:${sid}:${foreign.id}`, PID);
  check("درسِ کسِ دیگر روی جلسهٔ من نمی‌نشیند", getSession(sid).course_id === c.id);
  updateSession(sid, { status: "queued" });
  cs = await press(`crsset:${sid}:0`, PID);
  check("بعد از شروع درس عوض نمی‌شود", getSession(sid).course_id === c.id && cs.some((x) => x.payload?.text === S.COURSE_LOCKED));
}

// ─── ۲) سکهٔ کافی ────────────────────────────────────────────────────────────
{
  grant(U, 600, "grant");
  const sid = mk("aaaa0000aaaa0002", 100);
  const cs = await press(`go:${sid}`, PID);
  check("سکهٔ کافی: صوت دقیقاً یک بار به بایگانی رفت", archived(cs).length === 1, String(archived(cs).length));
  check("شناسهٔ پیامِ بایگانی روی جلسه نشست", Boolean(getSession(sid).archive_message_id));
  // فایلِ ساختگی خط لوله را در پیش‌پردازش می‌شکند؛ «دوباره» نباید دوباره بایگانی کند.
  await new Promise((r) => setTimeout(r, 1500));
  updateSession(sid, { status: "awaiting_confirm" });
  const again = await press(`go:${sid}`, PID);
  check("شروعِ دوباره روی همان جلسه دوباره بایگانی نمی‌کند", archived(again).length === 0, String(archived(again).length));
}

// ─── ۳) پیامِ بلند ───────────────────────────────────────────────────────────
{
  const sent = [];
  const api = { sendMessage: async (chatId, text, extra) => { sent.push({ text, extra }); return { message_id: 1 }; } };
  const long = Array.from({ length: 400 }, (_, i) => `خط شماره ${i} از یک پیامِ بلند برای آزمون`).join("\n");
  await sendWithKeyboard({ api, chatId: 1 }, long, { reply_parameters: { message_id: 9 } }, new InlineKeyboard().text("x", "y"));
  check("پیامِ بلند تکه شد", sent.length > 1, String(sent.length));
  check("دکمه فقط زیرِ تکهٔ آخر", sent.slice(0, -1).every((m) => !m.extra.reply_markup) && Boolean(sent.at(-1).extra.reply_markup));
  check("ریپلای روی همهٔ تکه‌ها", sent.every((m) => m.extra.reply_parameters?.message_id === 9));
}

// ─── ۴) بی‌کلام ──────────────────────────────────────────────────────────────
{
  const charged = S.jobFailedMessage("no_speech", false, 720);
  check("بی‌کلام: می‌گوید چقدر گوش داده شد و همان کم شد", charged.includes("۱۲") && charged.includes("کم شد") && charged.includes("برگشت"), charged);
  check("بی‌کلامِ بی‌هزینه: «کامل برگشت»", S.jobFailedMessage("no_speech", false, 0).includes("کامل برگشت"));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
