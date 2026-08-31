/**
 * بایگانی همیشه به کانالِ **تلگرام** می‌رود، از هر سه در که وارد شده باشد.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * `archiveAudio(ctx.api, …)` صدا زده می‌شد. برای کاربر بله `ctx.api` همان
 * سرور بله است، پس `sendAudio` روی `ARCHIVE_CHAT_ID` — که شناسهٔ یک کانال
 * **تلگرامی** است — به سرورِ بله می‌رفت و همیشه رد می‌شد. و چون قاعدهٔ ۱
 * بایگانی می‌گوید شکست را ببلع، **بی‌صدا** رد می‌شد: کانال خالی می‌ماند و
 * لاگ چیزی نمی‌گفت جز یک `warn` که کسی دنبالش نبود.
 *
 * مسیر مینی‌اپ از این هم بدتر بود: اصلاً `archiveAudio` صدا زده نمی‌شد.
 *
 * دو چیز اینجا سنجیده می‌شود که هیچ آزمون دیگری نمی‌گیرد:
 *
 *   ۱) مقصد همیشه `tgApi` است، حتی وقتی `setBaleApi` هم ست شده.
 *   ۲) منبع درست انتخاب می‌شود: `file_id` فقط برای تلگرام، و برای بقیه
 *      بایتِ واقعیِ فایل — چون `file_id` بله روی تلگرام بی‌معنی است.
 *
 * اجرا: npx tsx scripts/test-archive-routing.mjs
 */
process.env.BOT_TOKEN ||= "111:aaa";
process.env.BALE_BOT_TOKEN ||= "222:bbb";
process.env.ARCHIVE_CHAT_ID ||= "-1001234567890";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Bot, InputFile } = await import("grammy");
const { setBaleApi } = await import("../src/bot/identity.ts");
const { archiveAudio, audioCaption, archiveEnabled, setArchiveApi } = await import(
  "../src/bot/archive.ts"
);

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

function info(id, name) {
  return {
    id, is_bot: true, first_name: name, username: name,
    can_join_groups: true, can_read_all_group_messages: false,
    supports_inline_queries: false, can_connect_to_business_account: false,
    has_main_web_app: false,
  };
}

/**
 * هیچ درخواستی به شبکه نمی‌رود.
 *
 * ترنسفورمر پیش از لایهٔ شبکه می‌نشیند و خودش پاسخ می‌سازد، پس آزمون بدون
 * توکن واقعی و بدون اینترنت اجرا می‌شود.
 */
function spy(bot, log, label) {
  bot.api.config.use(async (_prev, method, payload) => {
    log.push({ via: label, method, payload });
    return { ok: true, result: { message_id: log.length + 100 } };
  });
}

const calls = [];
const tg = new Bot("111:aaa", { botInfo: info(1, "tg") });
const bale = new Bot("222:bbb", { botInfo: info(2, "bale") });
spy(tg, calls, "telegram");
spy(bale, calls, "bale");

// همان دو سیم‌کشی‌ای که `bot/index.ts` موقع بالا آمدن انجام می‌دهد
setBaleApi(bale.api);
setArchiveApi(tg.api);

check("بایگانی روشن است", archiveEnabled() === true);

const caption = (origin) =>
  audioCaption({
    sender: { tgId: 55, name: "کاربر", username: null },
    mode: "full",
    durationMs: 60_000,
    sessionId: "sess1",
    courseName: null,
    origin,
  });

// یک فایل کوچک روی دیسک — جای صوتی که بله/مینی‌اپ دانلود یا آپلود کرده
const tmp = path.join(os.tmpdir(), `archive-test-${Date.now()}.mp3`);
fs.writeFileSync(tmp, Buffer.alloc(1024, 7));

// ─── مسیر تلگرام: با file_id، بدون آپلود ────────────────────────────────────
calls.length = 0;
await archiveAudio("sess1", { fileId: "TG_FILE_ID" }, caption("telegram"));
check("تلگرام: یک تماس", calls.length === 1, `${calls.length}`);
check("تلگرام: از api تلگرام", calls[0]?.via === "telegram", String(calls[0]?.via));
check("تلگرام: sendAudio", calls[0]?.method === "sendAudio", String(calls[0]?.method));
check(
  "تلگرام: file_id بدون آپلود می‌رود",
  calls[0]?.payload?.audio === "TG_FILE_ID",
  String(calls[0]?.payload?.audio),
);

// ─── مسیر بله: فایل واقعی، ولی باز هم روی api تلگرام ────────────────────────
//
// این همان بررسی‌ای است که پیش از رفع باگ قرمز می‌شد.
calls.length = 0;
await archiveAudio("sess1", { path: tmp }, caption("bale"));
check("بله: یک تماس", calls.length === 1, `${calls.length}`);
check(
  "بله: به api تلگرام می‌رود نه بله",
  calls[0]?.via === "telegram",
  String(calls[0]?.via),
);
check(
  "بله: چت مقصد همان کانال بایگانی است",
  String(calls[0]?.payload?.chat_id) === process.env.ARCHIVE_CHAT_ID,
  String(calls[0]?.payload?.chat_id),
);
check(
  "بله: بایتِ فایل آپلود می‌شود نه file_id",
  calls[0]?.payload?.audio instanceof InputFile,
  typeof calls[0]?.payload?.audio,
);
check("بله: برچسب سکو در کپشن هست", /بله/.test(calls[0]?.payload?.caption ?? ""));

// ─── مسیر مینی‌اپ: همان رفتار، برچسب دیگر ───────────────────────────────────
calls.length = 0;
await archiveAudio("sess1", { path: tmp }, caption("web"));
check("مینی‌اپ: به api تلگرام می‌رود", calls[0]?.via === "telegram", String(calls[0]?.via));
check("مینی‌اپ: برچسب سکو در کپشن هست", /مینی‌اپ/.test(calls[0]?.payload?.caption ?? ""));

// ─── فایلی که نیست: کپشن باید برود، نه سکوت ─────────────────────────────────
//
// جلسه‌ای که در کانال هیچ ردی ندارد از دید ادمین اصلاً وجود نداشته.
calls.length = 0;
await archiveAudio("sess1", { path: path.join(os.tmpdir(), "نیست.mp3") }, caption("web"));
check("فایل نبود: باز هم پیام می‌رود", calls.length === 1, `${calls.length}`);
check("فایل نبود: به‌جای صوت، متن", calls[0]?.method === "sendMessage", String(calls[0]?.method));
check("فایل نبود: صریح گفته می‌شود", /صوت آپلود نشد/.test(calls[0]?.payload?.text ?? ""));

// ─── کپشن تلگرام برچسب سکو نمی‌گیرد ─────────────────────────────────────────
//
// حالت پیش‌فرض است؛ برچسب زدن به همه‌چیز، برچسب را بی‌ارزش می‌کند.
check("تلگرام: کپشن برچسب سکو ندارد", !/تلگرام/.test(caption("telegram")));

fs.unlinkSync(tmp);

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
