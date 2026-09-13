/**
 * تحویل جلسه: چهار چیز فوری، سه چیز پشت دکمه.
 *
 * ## مسئله‌ای که این آزمون قفل می‌کند
 *
 * تحویل هفت پیام پشت‌سرهم بود — صوت، خلاصه، نکته‌ها، بخش‌بندی زمانی، جزوه،
 * رونوشت کامل، و SRT. دانشجو در آن دیوار نمی‌فهمید کجا را نگاه کند و
 * فورواردکردنی‌ترین چیز، خلاصه، زیر بقیه گم می‌شد.
 *
 * حالا فقط صوت و خلاصه و نکته‌ها و جزوه می‌آیند و سه تای دیگر پشت دکمه‌اند.
 *
 * ## و **هر دو در** یک شکل دارند
 *
 * آپلود در مینی‌اپ به `deliverToBot` می‌رسد و آپلود در خودِ ربات به
 * `sendResults`. هر دو اینجا رانده می‌شوند، چون تا امروز هرکدام شکل خودش را
 * داشت — یعنی نیمی از دانشجوها هفت پیام می‌دیدند و نیمی پنج‌تا. اگر کسی فقط
 * یکی را عوض کند، همین‌جا قرمز می‌شود.
 *
 * صوتِ آن دو هم فرق دارد: در مسیر ربات کاربر خودش صوت را فرستاده و در مسیر
 * مینی‌اپ ما می‌فرستیم. ولی هر دو باید در **یک جفت ستون** بنویسند، وگرنه
 * دکمهٔ بخش‌بندی در یکی از دو مسیر بی‌صدا زمان‌هایش را می‌بازد.
 *
 * ## چهار چیزی که اینجا سنجیده می‌شود، و هیچ آزمون دیگری نمی‌گیرد
 *
 * ۱. **تحویل فوری دقیقاً چهار چیز است.** هر پیام اضافه‌ای که کسی بعداً به
 *    مسیر تحویل اضافه کند، همین‌جا قرمز می‌شود.
 *
 * ۲. **زمان‌ها بعد از فشردن دکمه هم لینکِ پخش می‌مانند.** ستون این محصول
 *    همین است: تلگرام `MM:SS` را فقط داخل پیامی که ریپلایِ صوتِ همان چت
 *    است زدنی می‌کند. بخش‌بندی حالا شاید هفته‌ها بعد فرستاده شود، پس شناسهٔ
 *    صوتِ تحویل باید در پایگاه‌داده مانده باشد و آن پیام ریپلایش شود.
 *    و در چتِ *دیگری* — یعنی هم‌کلاسی‌ای که جلسه با او تقسیم شده — نباید
 *    ریپلای شود، چون آن شناسه آنجا پیام دیگری است.
 *
 * ۳. **کال‌بک یک URL است و هرکس می‌تواند تکرارش کند.** شناسهٔ جلسه رازی نیست
 *    (در لینک دعوت می‌آید)، پس غریبه باید رد شود نه اینکه رونوشت بگیرد.
 *
 * ۴. **فایلِ reap‌شده باید یک جمله بدهد، نه استثنا.** `KEEP_AUDIO_DAYS` فایل‌ها
 *    را پاک می‌کند ولی دکمه در تاریخچهٔ چت می‌ماند.
 *
 * اجرا: DATA_DIR=./data/tmp-deliver npx tsx scripts/test-deferred-delivery.mjs
 */
process.env.BOT_TOKEN ||= "111:aaa";
process.env.PUBLIC_URL ||= "https://passchi.ir";
// بله عمداً خاموش است: مسیر آپلود دستی‌اش واقعاً `fetch` می‌زند و این آزمون
// آفلاین است. بی‌واسطه‌بودنِ همان مسیر پایین با بازرسی متن کد سنجیده می‌شود.
delete process.env.BALE_BOT_TOKEN;

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Context } = await import("grammy");
const { bot, sendResults } = await import("../src/bot/index.ts");
const { setNotifyApis } = await import("../src/bot/notify.ts");
const { deliverToBot, MORE_CB, moreKeyboard } = await import("../src/bot/deliver.ts");
const { createSession, getSession, updateSession } = await import("../src/db/index.ts");
const { resolveIdentity } = await import("../src/db/identity.ts");
const S = await import("../src/bot/strings.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ─── ربات جعلی: هیچ درخواستی به شبکه نمی‌رود ────────────────────────────────
//
// ترنسفورمر پیش از لایهٔ شبکه می‌نشیند و خودش پاسخ می‌سازد.
const botInfo = {
  id: 1, is_bot: true, first_name: "passchi", username: "passchi",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business_account: false,
  has_main_web_app: false,
};
bot.botInfo = botInfo;

let calls = [];
let nextMessageId = 500;
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
    audio: { file_id: "AUDIO-FID" },
    document: { file_id: "DOC-FID" },
  };
  return { ok: true, result: call.result };
});
setNotifyApis(bot.api, null);

// ─── یک جلسهٔ واقعی روی دیسک ────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "passchi-deliver-"));
const touch = (name) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, "x");
  return p;
};

const OWNER = 7_100_001;
const STRANGER = 7_100_002;
const SESSION = "aaaa1111bbbb2222";

resolveIdentity({ platform: "telegram", platformUserId: String(OWNER), name: "مالک" });
resolveIdentity({ platform: "telegram", platformUserId: String(STRANGER), name: "غریبه" });

const report = {
  session_title: "مشتق جهت‌دار",
  headline: "مشتق جهت‌دار تدریس شد.",
  class_recap: "استاد مشتق جهت‌دار را از رو تعریف شروع کرد.",
  course_guess: null,
  chapters: [
    {
      start_ms: 0, end_ms: 900_000, kind: "teaching", title: "بخش اول",
      parts: [{ at_ms: 0, label: "شروع درس" }, { at_ms: 240_000, label: "مثال" }],
    },
  ],
  topics: [], professor_actions: [],
  key_points: [
    {
      kind: "exam", title: "نکتهٔ امتحانی", detail: "توضیح",
      evidence: { quote: "این تو امتحان میاد", at_ms: 300_000, speaker: "استاد", verified: true, score: 1 },
    },
  ],
  glossary: [], open_questions: [], next_session_hint: null,
  composition: [], silenceMs: 0, droppedCitations: 0,
};

createSession(SESSION, OWNER, null);
updateSession(SESSION, {
  status: "done",
  title: "مشتق جهت‌دار",
  original_file: touch("class.m4a"),
  original_ms: 900_000,
  billed_ms: 900_000,
  report_json: JSON.stringify(report),
  pdf_path: touch("notes.pdf"),
  transcript_pdf: touch("transcript.pdf"),
  transcript_txt: JSON.stringify([{ at_ms: 0, speaker: "استاد", text: "سلام" }]),
  transcript_srt: touch("subs.srt"),
});

// ─── ۱) تحویل فوری ──────────────────────────────────────────────────────────

calls = [];
const ok = await deliverToBot(OWNER, getSession(SESSION));
check("تحویل موفق بود", ok === true);

const sent = calls.filter((c) => c.method !== "getMe");
const texts = sent.filter((c) => c.method === "sendMessage").map((c) => c.payload.text);
const docs = sent.filter((c) => c.method === "sendDocument");

check("صوت اول از همه فرستاده شد", sent[0]?.method === "sendAudio", sent.map((c) => c.method).join(" → "));
check("خلاصهٔ کلاس آمد", texts.some((t) => t.includes(report.class_recap)));
check("نکته‌های استخراج‌شده آمد", texts.some((t) => t.includes("چی از کلاس درآوردم")));
check("جزوه آمد و فقط همان یک سند", docs.length === 1 && docs[0].payload.caption === S.CAPTION.notes);
check(
  "بخش‌بندی زمانی در تحویل فوری **نیامد**",
  !texts.some((t) => t.includes("کلاس به چه بخش‌هایی گذشت")),
);
check("رونوشت کامل در تحویل فوری نیامد", !docs.some((d) => d.payload.caption === S.CAPTION.transcript));
check("SRT در تحویل فوری نیامد", !docs.some((d) => d.payload.caption === S.CAPTION.srt));
check(
  // خلاصه و نکته‌ها و تسویه یک پیامِ دکمه‌دارند — دکمه‌ها زیرِ همان، نه پیامِ سومی پایینِ جزوه.
  "دقیقاً سه ارسال: صوت، پیامِ یکی‌شدهٔ خلاصه و نکته‌ها با دکمه‌ها، جزوه",
  sent.length === 3,
  sent.map((c) => c.method).join(" → "),
);
{
  const merged = sent.find((c) => c.method === "sendMessage");
  check(
    "پیامِ یکی‌شده هم خلاصه دارد هم «چی از کلاس درآوردم» هم دکمه‌ها",
    merged?.payload.text.includes("📋") && merged.payload.text.includes("چی از کلاس درآوردم") && Boolean(merged.payload.reply_markup),
  );
}

// ─── ۲) دکمه‌ها ─────────────────────────────────────────────────────────────

const prompt = sent.find((c) => c.method === "sendMessage" && c.payload.reply_markup);
let rows = prompt?.payload.reply_markup?.inline_keyboard ?? [];
const datas = rows.flat().map((b) => b.callback_data);
check("پیام آخر دکمه دارد", rows.length > 0);
check("هیچ ردیفِ خالی‌ای نیست", !rows.some((r) => r.length === 0));
// تقسیم هزینه اولِ سطرهاست — کارِ همین حالاست — و بایگانی پشتِ سرش.
check(
  "تقسیم هزینه و هر سه بخشِ بایگانی، زیرِ یک پیام",
  datas.join(",") ===
    `son:${SESSION},${MORE_CB.timeline}:${SESSION},${MORE_CB.transcript}:${SESSION},${MORE_CB.notes}:${SESSION}`,
  datas.join(" | "),
);
check("هیچ کال‌بکی از ۶۴ بایت رد نمی‌شود", datas.every((d) => Buffer.byteLength(d) <= 64));

// شناسهٔ صوتِ تحویل باید مانده باشد، وگرنه دکمهٔ بخش‌بندی زمان‌هایش را می‌بازد.
const audioMsgId = sent[0].result.message_id;
const rowAfter = getSession(SESSION);
check("شناسهٔ چتِ تحویل ذخیره شد", rowAfter.delivered_chat_id === OWNER);
check(
  "شناسهٔ پیامِ صوتِ تحویل ذخیره شد",
  Number.isInteger(rowAfter.delivered_audio_message_id) && rowAfter.delivered_audio_message_id === audioMsgId,
  String(rowAfter.delivered_audio_message_id),
);

// ─── همان دکمه‌ها، از سطرِ تازهٔ پایگاه‌داده ─────────────────────────────────
check("صفحه‌کلید از سطر تازه هم ساخته می‌شود", moreKeyboard(rowAfter) !== null);

// ─── ۳) فشردنِ دکمه ─────────────────────────────────────────────────────────

let updateId = 0;
async function press(data, fromId, chatId = fromId) {
  calls = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from: { id: fromId, is_bot: false, first_name: "u" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 490,
        date: 0,
        chat: { id: chatId, type: "private" },
        from: botInfo,
        text: "…",
        reply_markup: { inline_keyboard: rows },
      },
    },
  });
  return calls;
}

// ── بخش‌بندی زمانی: باید ریپلای همان صوت باشد ──────────────────────────────
let c = await press(`${MORE_CB.timeline}:${SESSION}`, OWNER);
const timeline = c.find((x) => x.method === "sendMessage");
check("بخش‌بندی زمانی فرستاده شد", Boolean(timeline?.payload.text.includes("کلاس به چه بخش‌هایی گذشت")));
check(
  "و **ریپلای همان صوتِ تحویل** است — وگرنه زمان‌ها لینکِ پخش نمی‌شوند",
  timeline?.payload.reply_parameters?.message_id === rowAfter.delivered_audio_message_id,
  JSON.stringify(timeline?.payload.reply_parameters),
);
check(
  "به کاربر هم گفته می‌شود زمان‌ها زدنی‌اند",
  timeline?.payload.text.includes("رو هر زمان بزنی"),
);
// دکمه باید **بماند**: کاربر روز امتحان همان پیام را بالا می‌آورد تا دوباره
// فایل را بردارد، و صفحه‌کلیدِ خالی آن راه را می‌بندد.
check(
  "دکمهٔ زده‌شده برداشته نمی‌شود",
  !c.some((x) => x.method === "editMessageReplyMarkup"),
  c.map((x) => x.method).join(" | "),
);
check(
  "به‌جایش همان لحظه یک بازخورد کوتاه می‌آید",
  c.some((x) => x.method === "answerCallbackQuery" && x.payload.text === S.MORE_SENDING.timeline),
);

// ── همان دکمه در چتِ دیگر: ریپلای نباید به پیامِ بی‌ربط بچسبد ───────────────
//
// هم‌کلاسی‌ای که جلسه با او تقسیم شده دکمه را در چتِ خودش می‌زند و شمارهٔ
// پیامِ صوت آنجا پیامِ دیگری است.
c = await press(`${MORE_CB.timeline}:${SESSION}`, OWNER, OWNER + 900);
const elsewhere = c.find((x) => x.method === "sendMessage");
check(
  "در چتِ دیگر بی‌ریپلای می‌رود، نه ریپلای به پیامِ اشتباه",
  elsewhere !== undefined && elsewhere.payload.reply_parameters === undefined,
);
check("و آنجا وعدهٔ زدنی‌بودن داده نمی‌شود", !elsewhere?.payload.text.includes("رو هر زمان بزنی"));

// ── رونوشت کامل + زیرنویس، با **یک** دکمه ──────────────────────────────────
c = await press(`${MORE_CB.transcript}:${SESSION}`, OWNER);
check(
  "رونوشت کامل با دکمه می‌آید",
  c.some((x) => x.method === "sendDocument" && x.payload.caption === S.CAPTION.transcript),
);
check(
  "و زیرنویس هم با همان یک دکمه می‌آید",
  c.some((x) => x.method === "sendDocument" && x.payload.caption === S.CAPTION.srt),
  c.filter((x) => x.method === "sendDocument").map((x) => x.payload.caption).join(" | "),
);

// ── جزوه، از همان صفحه‌کلید ────────────────────────────────────────────────
//
// در خودِ تحویل فرستاده شده، ولی در چتِ شلوغ گم می‌شود و کاربر انتظار دارد
// از همان‌جا دوباره بگیردش.
c = await press(`${MORE_CB.notes}:${SESSION}`, OWNER);
check(
  "دکمهٔ جزوه فایل جزوه را می‌فرستد",
  c.some((x) => x.method === "sendDocument" && x.payload.caption === S.CAPTION.notes),
  c.map((x) => x.method).join(" | "),
);

// ─── ۴) غریبه ───────────────────────────────────────────────────────────────

c = await press(`${MORE_CB.transcript}:${SESSION}`, STRANGER);
check("غریبه رد می‌شود", c.some((x) => x.method === "answerCallbackQuery" && x.payload.text === S.MORE_DENIED));
check(
  "و هیچ فایلی یا پیامی برایش نمی‌رود",
  !c.some((x) => x.method === "sendDocument" || x.method === "sendMessage"),
  c.map((x) => x.method).join(" | "),
);

// ─── ۵) فایلی که reap شده ───────────────────────────────────────────────────
//
// دکمه در تاریخچهٔ چت می‌ماند و ممکن است هفته‌ها بعد زده شود.
fs.rmSync(path.join(tmp, "subs.srt"));
c = await press(`${MORE_CB.srt}:${SESSION}`, OWNER);
check("فایلِ نبوده استثنا نمی‌دهد و سندی هم نمی‌فرستد", !c.some((x) => x.method === "sendDocument"));
check(
  "به‌جایش یک جملهٔ روشن می‌آید",
  c.some((x) => x.method === "sendMessage" && x.payload.text === S.MORE_GONE.srt),
  c.map((x) => x.method).join(" | "),
);

// ─── ۶) مسیر «آپلود در خودِ ربات» — همان شکل، صوتِ دیگر ─────────────────────
//
// اینجا صوت را کاربر فرستاده و `intakeAudio` شناسه‌اش را در
// `audio_chat_id`/`audio_message_id` گذاشته. `sendResults` باید همان را در
// `delivered_*` بنویسد تا دکمهٔ بخش‌بندی دقیقاً مثل مسیر مینی‌اپ کار کند.

const SESSION2 = "cccc3333dddd4444";
const USER_AUDIO_MSG = 42;
createSession(SESSION2, OWNER, null);
updateSession(SESSION2, {
  status: "done",
  title: "جلسهٔ دوم",
  original_ms: 900_000,
  billed_ms: 900_000,
  audio_chat_id: OWNER,
  audio_message_id: USER_AUDIO_MSG,
  report_json: JSON.stringify(report),
  pdf_path: touch("notes2.pdf"),
  transcript_pdf: touch("transcript2.pdf"),
  transcript_srt: touch("subs2.srt"),
});

/** `Context` دستی — خط لوله اجرا نمی‌شود، فقط مرحلهٔ تحویلش. */
function fakeCtx(chatId, fromId) {
  return new Context(
    {
      update_id: ++updateId,
      message: {
        message_id: 7,
        date: 0,
        chat: { id: chatId, type: "private" },
        from: { id: fromId, is_bot: false, first_name: "u" },
        text: "x",
      },
    },
    bot.api,
    botInfo,
  );
}

const pipelineOut = {
  report,
  notesMarkdown: "# جزوه",
  pdfPath: touch("out-notes.pdf"),
  pdfName: "جزوه.pdf",
  transcriptPath: touch("out-transcript.txt"),
  transcriptPdfPath: touch("out-transcript.pdf"),
  transcriptSrtPath: touch("out-subs.srt"),
  transcriptText: "سلام",
  originalDurationMs: 900_000,
  skippedMs: 0,
  billedDurationMs: 900_000,
  savedMs: 0,
  costUsd: 0,
  qualityWarnings: [],
  preprocessSteps: [],
  notesError: null,
};

calls = [];
await sendResults(fakeCtx(OWNER, OWNER), SESSION2, pipelineOut, "ریاضی مهندسی");
const inbot = calls.filter((c) => c.method !== "getMe");
const inbotTexts = inbot.filter((c) => c.method === "sendMessage").map((c) => c.payload.text);
const inbotDocs = inbot.filter((c) => c.method === "sendDocument");

check(
  "مسیر ربات هم بخش‌بندی زمانی را فوری نمی‌فرستد",
  !inbotTexts.some((t) => t.includes("کلاس به چه بخش‌هایی گذشت")),
);
check("و فقط یک سند می‌فرستد: جزوه", inbotDocs.length === 1, String(inbotDocs.length));
check("خلاصه و نکته‌ها همچنان می‌آیند", inbotTexts.some((t) => t.includes("چی از کلاس درآوردم")));

// پیامِ پایانی با متنِ تسویه می‌آید، نه با `MORE_PROMPT` — پس آخرین پیامِ
// دکمه‌دار را بگیر، نه پیامی با متنِ مشخص. همین یک بار جا افتاد و آزمون
// بی‌صدا هیچ‌چیز پیدا نکرد و سبز ماند.
const inbotPrompt = [...inbot].reverse().find((c) => c.method === "sendMessage" && c.payload.reply_markup);
const inbotDatas = (inbotPrompt?.payload.reply_markup?.inline_keyboard ?? [])
  .flat()
  .map((b) => b.callback_data);
check(
  "مسیر ربات هم همان چهار دکمه را در یک پیام می‌دهد",
  inbotDatas.join(",") ===
    `son:${SESSION2},${MORE_CB.timeline}:${SESSION2},${MORE_CB.transcript}:${SESSION2},${MORE_CB.notes}:${SESSION2}`,
  inbotDatas.join(" | "),
);
check("پیامِ پایانی یکی است، نه دو تا", inbot.filter((c) => c.method === "sendMessage" && c.payload.reply_markup).length === 1);

// و مهم‌تر از همه: صوتِ کاربر در همان جفت ستونی نشست که مسیر مینی‌اپ می‌نویسد.
const row2 = getSession(SESSION2);
check(
  "صوتِ خودِ کاربر در `delivered_*` نوشته شد — یک میدانِ معتبر برای هر دو مسیر",
  row2.delivered_chat_id === OWNER && row2.delivered_audio_message_id === USER_AUDIO_MSG,
  `${row2.delivered_chat_id} / ${row2.delivered_audio_message_id}`,
);

rows = inbotPrompt?.payload.reply_markup?.inline_keyboard ?? [];
c = await press(`${MORE_CB.timeline}:${SESSION2}`, OWNER);
const tl2 = c.find((x) => x.method === "sendMessage");
check(
  "دکمهٔ بخش‌بندی در مسیر ربات هم ریپلایِ صوتِ درست است",
  tl2?.payload.reply_parameters?.message_id === USER_AUDIO_MSG,
  JSON.stringify(tl2?.payload.reply_parameters),
);

// ─── ۷) جلسه‌ای که همهٔ تکه‌ها را ندارد ─────────────────────────────────────
//
// دکمه‌ای که بزنی و چیزی نیاید از نبودِ دکمه بدتر است.
const SESSION3 = "eeee5555ffff6666";
createSession(SESSION3, OWNER, null);
updateSession(SESSION3, { status: "done", report_json: JSON.stringify(report) });
const lean = (moreKeyboard(getSession(SESSION3))?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
check(
  "بی‌رونوشت و بی‌SRT فقط دکمهٔ بخش‌بندی می‌آید",
  lean.join(",") === `${MORE_CB.timeline}:${SESSION3}`,
  lean.join(" | "),
);

// ─── ۸) مسیر بله ────────────────────────────────────────────────────────────
//
// یک بار جزوه برای کاربر بله بی‌صدا نرسید چون `InputFile` خام ساخته شده بود و
// بله ارجاعِ `attach://` را نمی‌فهمد. آزمون رفتاری اینجا ممکن نیست (مسیر بله
// واقعاً `fetch` می‌زند)، پس خودِ متن کد بررسی می‌شود.
const src = fs.readFileSync("src/bot/deliver.ts", "utf8");
check("هیچ `InputFile` خامی در مسیر تحویل نیست", !src.includes("new InputFile"));
check("هر ارسال فایل از `sendFileTo` رد می‌شود", (src.match(/sendFileTo\(/g) ?? []).length >= 3);
check("هر ارسال فایل جداگانه `catch` شده", (src.match(/\.catch\(/g) ?? []).length >= 4);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
