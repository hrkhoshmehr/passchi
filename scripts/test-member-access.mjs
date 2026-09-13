/**
 * هم‌کلاسی‌ای که جلسه را گرفته — همان تجربهٔ مالک، نه نسخهٔ عقب‌ماندهٔ آن.
 *
 * ## چهار چیزی که اینجا قفل می‌شود
 *
 * ۱. **تحویلِ عضو هم دکمه‌ای است و خبرِ پول اول می‌آید.** مسیرِ پیوستن هنوز
 *    هشت پیامِ پشت‌سرهم می‌فرستاد — صوت، خلاصه، نکته‌ها، بخش‌بندی، جزوه،
 *    رونوشت، SRT — و «گرفتیش، n سکه کم شد» آخرِ همه می‌آمد.
 *
 * ۲. **زمان‌ها برای عضو هم لینکِ پخش می‌مانند.** دکمهٔ «کلاس دقیقه‌به‌دقیقه»
 *    در چتِ عضو باید ریپلایِ صوتی باشد که *در همان چت* برای او رفته، نه
 *    شناسهٔ پیامِ مالک که آنجا پیامِ بی‌ربطی است.
 *
 * ۳. **جلسهٔ گرفته‌شده در «📚 جلسه‌های من» دیده می‌شود و باز می‌شود.** پیش‌تر
 *    فهرست فقط مالکیت را می‌دید و تنها راهِ رسیدن به آن تایپِ `/shared` بود.
 *
 * ۴. **صفحهٔ سکهٔ کم دکمهٔ شریک‌شدن ندارد**، و **برچسبِ وضعیت‌ها لاتین ندارند.**
 *
 * اجرا: DATA_DIR=./data/tmp-member npx tsx scripts/test-member-access.mjs
 */
process.env.BOT_TOKEN ||= "111:aaa";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { bot, lowBalanceKeyboard } = await import("../src/bot/index.ts");
const { setNotifyApis } = await import("../src/bot/notify.ts");
const { MORE_CB } = await import("../src/bot/deliver.ts");
const {
  createSession, getSession, updateSession, listHistory, countHistory, memberDelivery,
} = await import("../src/db/index.ts");
const { resolveIdentity } = await import("../src/db/identity.ts");
const { grant } = await import("../src/billing/ledger.ts");
const { registerOwner, setShareEnabled, setShareTarget } = await import("../src/billing/sharing.ts");
const { coinsToSec } = await import("../src/billing/coins.ts");
const S = await import("../src/bot/strings.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ─── ربات جعلی: هیچ درخواستی به شبکه نمی‌رود ────────────────────────────────
const botInfo = {
  id: 1, is_bot: true, first_name: "passchi", username: "passchi",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business_account: false,
  has_main_web_app: false,
};
bot.botInfo = botInfo;

let calls = [];
let nextMessageId = 900;
bot.api.config.use(async (_prev, method, payload) => {
  const call = { method, payload, result: true };
  calls.push(call);
  if (method === "getMe") return { ok: true, result: botInfo };
  if (method.startsWith("answer") || method.startsWith("edit") || method.startsWith("delete")) {
    return { ok: true, result: true };
  }
  call.result = {
    message_id: ++nextMessageId,
    date: 0,
    chat: { id: payload.chat_id, type: "private" },
    audio: { file_id: "AUDIO-FID", duration: 900 },
    document: { file_id: "DOC-FID" },
  };
  return { ok: true, result: call.result };
});
setNotifyApis(bot.api, null);

let updateId = 0;
async function press(data, fromId, markup = { inline_keyboard: [] }) {
  calls = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from: { id: fromId, is_bot: false, first_name: "u" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 10, date: 0, chat: { id: fromId, type: "private" }, from: botInfo, text: "…",
        reply_markup: markup,
      },
    },
  });
  return calls;
}
async function say(text, fromId) {
  calls = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: 11, date: 0, chat: { id: fromId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "u" }, text,
    },
  });
  return calls;
}
const inChat = (list, chatId) => list.filter((c) => c.payload?.chat_id === chatId);
const datasOf = (c) => (c?.payload?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);

// ─── یک جلسهٔ کامل و اشتراکی ────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "passchi-member-"));
const touch = (name) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, "x");
  return p;
};

const OWNER = resolveIdentity({ platform: "telegram", platformUserId: "7200001", name: "مالک" }).tg_id;
const MEMBER = resolveIdentity({ platform: "telegram", platformUserId: "7200002", name: "هم‌کلاسی" }).tg_id;
const STRANGER = resolveIdentity({ platform: "telegram", platformUserId: "7200003", name: "غریبه" }).tg_id;
grant(MEMBER, coinsToSec(20), "trial");

const SESSION = "abcd1234abcd5678";
const OWNER_AUDIO_MSG = 77;
const report = {
  session_title: "مشتق جهت‌دار", headline: "مشتق جهت‌دار تدریس شد.",
  class_recap: "استاد مشتق جهت‌دار را از رو تعریف شروع کرد.", course_guess: null,
  chapters: [
    { start_ms: 0, end_ms: 900_000, kind: "teaching", title: "بخش اول",
      parts: [{ at_ms: 0, label: "شروع درس" }, { at_ms: 240_000, label: "مثال" }] },
  ],
  topics: [], professor_actions: [],
  key_points: [
    { kind: "exam", title: "نکتهٔ امتحانی", detail: "توضیح",
      evidence: { quote: "این تو امتحان میاد", at_ms: 300_000, speaker: "استاد", verified: true, score: 1 } },
  ],
  glossary: [], open_questions: [], next_session_hint: null,
  composition: [], silenceMs: 0, droppedCitations: 0,
};
createSession(SESSION, OWNER, null);
updateSession(SESSION, {
  status: "done", title: "مشتق جهت‌دار", mode: "full",
  original_file: touch("class.m4a"), original_ms: 900_000, billed_ms: 900_000,
  audio_file_id: "AUDIO-FID",
  report_json: JSON.stringify(report),
  pdf_path: touch("notes.pdf"), transcript_pdf: touch("transcript.pdf"),
  transcript_txt: JSON.stringify([{ at_ms: 0, speaker: "استاد", text: "سلام" }]),
  transcript_srt: touch("subs.srt"),
  delivered_chat_id: OWNER, delivered_audio_message_id: OWNER_AUDIO_MSG,
});
registerOwner(SESSION, OWNER, 900);
setShareTarget(SESSION, 10);
setShareEnabled(SESSION, true);

// ─── ۱) پیوستن: تأیید اول، بعد همان تحویلِ دکمه‌ای ──────────────────────────
let c = await press(`jdo:${SESSION}`, MEMBER);
const toMember = inChat(c, MEMBER).filter((x) => x.method.startsWith("send"));
const order = toMember.map((x) => x.method).join(" → ");

check(
  "اولین چیزی که عضو می‌گیرد تأییدِ «گرفتیش» است",
  toMember[0]?.method === "sendMessage" && toMember[0].payload.text.includes("گرفتیش"),
  order,
);
check("تأیید می‌گوید چند سکه کم شد", /سکه/.test(toMember[0]?.payload.text ?? ""), toMember[0]?.payload.text);
check(
  "تأیید پیش از صوت آمد",
  toMember.findIndex((x) => x.payload.text?.includes("گرفتیش")) <
    toMember.findIndex((x) => x.method === "sendAudio"),
  order,
);
check("فقط یک تأیید رفت، نه دو تا", toMember.filter((x) => x.payload.text?.includes("گرفتیش")).length === 1);

const memberTexts = toMember.filter((x) => x.method === "sendMessage").map((x) => x.payload.text);
const memberDocs = toMember.filter((x) => x.method === "sendDocument");
check("خلاصه آمد", memberTexts.some((t) => t.includes(report.class_recap)));
check("نکته‌ها آمد", memberTexts.some((t) => t.includes("چی از کلاس درآوردم")));
check("کلاس دقیقه‌به‌دقیقه **فوری نیامد**", !memberTexts.some((t) => t.includes("کلاس به چه بخش‌هایی گذشت")));
check(
  "فقط یک سند: جزوه — نه متن کامل، نه زیرنویس",
  memberDocs.length === 1 && memberDocs[0].payload.caption === S.CAPTION.notes,
  memberDocs.map((d) => d.payload.caption).join(" | "),
);

const memberClosing = [...toMember].reverse().find((x) => x.payload.reply_markup);
const closingDatas = datasOf(memberClosing);
check(
  "پیامِ آخر همان دکمه‌های بایگانیِ مالک را دارد",
  closingDatas.join(",") ===
    `${MORE_CB.timeline}:${SESSION},${MORE_CB.transcript}:${SESSION},${MORE_CB.notes}:${SESSION}`,
  closingDatas.join(" | "),
);
check("دکمهٔ شریک‌شدنِ مالک به عضو نشان داده نمی‌شود", !closingDatas.some((d) => /^(son|slink):/.test(d)));
check(
  "دقیقاً چهار ارسال: تأیید، صوت، پیامِ یکی‌شدهٔ خلاصه و نکته‌ها با دکمه‌ها، جزوه",
  toMember.length === 4,
  order,
);

// ─── ۲) زمان‌ها برای عضو هم لینکِ پخش می‌مانند ─────────────────────────────
const memberAudio = toMember.find((x) => x.method === "sendAudio");
const pair = memberDelivery(SESSION, MEMBER);
check(
  "صوتِ عضو کنارِ عضویتش ذخیره شد",
  pair?.chatId === MEMBER && pair?.audioMessageId === memberAudio?.result.message_id,
  JSON.stringify(pair),
);
const extracted = toMember.find((x) => x.payload.text?.includes("چی از کلاس درآوردم"));
check(
  "نکته‌ها ریپلایِ صوتِ خودِ عضو است",
  extracted?.payload.reply_parameters?.message_id === memberAudio?.result.message_id,
  JSON.stringify(extracted?.payload.reply_parameters),
);
check(
  "جفتِ مالک دست نخورد",
  getSession(SESSION).delivered_chat_id === OWNER &&
    getSession(SESSION).delivered_audio_message_id === OWNER_AUDIO_MSG,
);

c = await press(`${MORE_CB.timeline}:${SESSION}`, MEMBER, memberClosing.payload.reply_markup);
const tl = c.find((x) => x.method === "sendMessage");
check("عضو کلاس دقیقه‌به‌دقیقه را با دکمه می‌گیرد", Boolean(tl?.payload.text.includes("کلاس به چه بخش‌هایی گذشت")));
check(
  "و ریپلایِ **صوتِ خودش** است، نه شناسهٔ پیامِ مالک",
  tl?.payload.reply_parameters?.message_id === memberAudio?.result.message_id &&
    tl?.payload.reply_parameters?.message_id !== OWNER_AUDIO_MSG,
  JSON.stringify(tl?.payload.reply_parameters),
);
check("به عضوِ تلگرام گفته می‌شود زمان‌ها زدنی‌اند", Boolean(tl?.payload.text.includes("رو هر زمان بزنی")));

// مالک همچنان ریپلایِ صوتِ خودش را می‌گیرد.
c = await press(`${MORE_CB.timeline}:${SESSION}`, OWNER);
check(
  "مالک هم همچنان ریپلایِ صوتِ خودش را می‌گیرد",
  c.find((x) => x.method === "sendMessage")?.payload.reply_parameters?.message_id === OWNER_AUDIO_MSG,
);

// پیوستنِ دوباره: پیام اول می‌آید، نه آخر.
c = await press(`jdo:${SESSION}`, MEMBER);
const again = inChat(c, MEMBER).filter((x) => x.method.startsWith("send"));
check(
  "دوباره‌گرفتن هم خبرش اول است",
  again[0]?.method === "sendMessage" && again[0].payload.text === S.JOIN_AGAIN,
  again.map((x) => x.method).join(" → "),
);

// ─── ۳) «📚 جلسه‌های من» ────────────────────────────────────────────────────
const memberRows = listHistory(MEMBER, 10, 0);
check("جلسهٔ گرفته‌شده در فهرستِ عضو هست", memberRows.some((r) => r.id === SESSION && r.joined === 1));
check("شمارِ فهرستِ عضو درست است", countHistory(MEMBER) === 1, String(countHistory(MEMBER)));
const ownerRows = listHistory(OWNER, 10, 0);
check(
  "در فهرستِ مالک یک بار و بی‌نشان می‌آید",
  ownerRows.filter((r) => r.id === SESSION).length === 1 && ownerRows[0].joined === 0,
);
check("شمارِ فهرستِ مالک هم تکراری نشد", countHistory(OWNER) === 1, String(countHistory(OWNER)));

c = await say("📚 جلسه‌های من", MEMBER);
const list = c.find((x) => x.method === "sendMessage" && x.payload.reply_markup);
const listButtons = (list?.payload.reply_markup?.inline_keyboard ?? []).flat();
const btn = listButtons.find((b) => b.callback_data === `sess:${SESSION}`);
check("دکمهٔ جلسه در منوی عضو هست", Boolean(btn), listButtons.map((b) => b.text).join(" | "));
check("با نشانِ «👥»", Boolean(btn?.text.includes(S.MEMBER_MARK)), btn?.text);
check("تاریخ شمسی است، نه رقمِ لاتین", Boolean(btn && !/[0-9A-Za-z]/.test(btn.text)), btn?.text);

c = await press(`sess:${SESSION}`, MEMBER);
const card = c.find((x) => x.method === "sendMessage");
const cardDatas = datasOf(card);
check("کارتِ جلسه برای عضو باز می‌شود", Boolean(card), c.map((x) => x.method).join(" | "));
check("کارت جزوه و خلاصه دارد", cardDatas.includes(`pdf:${SESSION}`) && cardDatas.includes(`rep:${SESSION}`));
check("کارتِ عضو دکمه‌های مالک را ندارد", !cardDatas.some((d) => /^(son|slink|go|full):/.test(d)), cardDatas.join(" | "));

c = await press(`sess:${SESSION}`, STRANGER);
check(
  "غریبه کارت را نمی‌بیند",
  c.some((x) => x.method === "answerCallbackQuery" && x.payload.text === "این جلسه پیدا نشد.") &&
    !c.some((x) => x.method === "sendMessage"),
);

c = await say("📚 جلسه‌های من", STRANGER);
check(
  "فهرستِ خالی می‌گوید از لینکِ هم‌کلاسی هم می‌شود رسید",
  c.some((x) => x.method === "sendMessage" && x.payload.text === S.HISTORY_EMPTY),
);

// ─── ۴) وضعیت‌ها و صفحهٔ سکهٔ کم ─────────────────────────────────────────────
const statuses = [
  "queued", "awaiting_credit", "awaiting_confirm", "preprocess", "stt", "analyze", "pdf",
  "done", "error", "cancelled",
];
for (const st of statuses) {
  const label = S.sessionStatusLabel(st);
  check(`برچسبِ «${st}» فارسی است`, Boolean(label) && !/[A-Za-z]/.test(label), label);
}
check("همهٔ وضعیت‌های نوع برچسب دارند", statuses.every((st) => st in S.STATUS_LABEL));

const PENDING = "ffff0000ffff1111";
createSession(PENDING, OWNER, null);
updateSession(PENDING, { status: "awaiting_credit", original_ms: 600_000, original_file: touch("p.m4a") });
c = await press(`sess:${PENDING}`, OWNER);
const pendingCard = c.find((x) => x.method === "sendMessage")?.payload.text ?? "";
check("کارتِ جلسهٔ منتظر شارژ وضعیت را فارسی می‌گوید", pendingCard.includes("منتظر شارژ"), pendingCard);
check("و نامِ ستون در آن نیست", !pendingCard.includes("awaiting_credit"));

const lowKb = lowBalanceKeyboard(SESSION).inline_keyboard.flat();
check("صفحهٔ سکهٔ کم دکمهٔ شارژ دارد", lowKb.some((b) => b.callback_data === "topup"));
check("صفحهٔ سکهٔ کم دکمهٔ «ادامه» دارد", lowKb.some((b) => b.callback_data === `go:${SESSION}`));
check(
  "صفحهٔ سکهٔ کم **دکمهٔ شریک‌شدن ندارد**",
  !lowKb.some((b) => b.callback_data.startsWith("spre:") || b.text === S.CONFIRM_BTN.share),
  lowKb.map((b) => b.text).join(" | "),
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
