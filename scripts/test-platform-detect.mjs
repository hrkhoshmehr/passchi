/**
 * تشخیص سکو باید از آپدیتِ واقعی بگذرد، نه از شیئی که خودمان ساخته‌ایم.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * `platformOf` با `ctx.api === baleApi` مقایسه می‌کرد. ولی grammY برای **هر
 * آپدیت** یک `Api` تازه می‌سازد:
 *
 *     const api = new Api(this.token, this.clientConfig, …);
 *     const ctx = new this.ContextConstructor(update, api, this.me);
 *
 * پس آن مقایسه هرگز درست نمی‌شد و **هر کاربر بله «تلگرام» تشخیص داده
 * می‌شد**: هویتش در فضای نام تلگرام ثبت می‌شد (با خطر برخورد شناسه)، صوت
 * نمونه با `file_id` تلگرام فرستاده می‌شد، و مسیر آپلود مخصوص بله هرگز
 * اجرا نمی‌شد.
 *
 * آزمون‌های قبلی این را نمی‌گرفتند چون همه `baleBot.api` را مستقیم صدا
 * می‌زدند — همان یک حالتی که اتفاقاً درست کار می‌کرد.
 *
 * اجرا: npx tsx scripts/test-platform-detect.mjs
 */
process.env.BOT_TOKEN ||= "111:aaa";
process.env.BALE_BOT_TOKEN ||= "222:bbb";

const { Bot } = await import("grammy");
const { platformOf, isBale, setBaleApi } = await import("../src/bot/identity.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!bad && !ok) bad++;
  else if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const tg = new Bot("111:aaa", { botInfo: info(1, "tg") });
const bale = new Bot("222:bbb", { botInfo: info(2, "bale") });

function info(id, name) {
  return {
    id, is_bot: true, first_name: name, username: name,
    can_join_groups: true, can_read_all_group_messages: false,
    supports_inline_queries: false, can_connect_to_business_account: false,
    has_main_web_app: false,
  };
}

setBaleApi(bale.api);

// ─── خودِ شیء (حالتی که پیش‌تر هم درست بود) ──────────────────────────────────
check("isBale روی api بله درست است", isBale(bale.api) === true);
check("isBale روی api تلگرام نادرست است", isBale(tg.api) === false);

// ─── آپدیت واقعی: همان مسیری که در زمان اجرا طی می‌شود ───────────────────────
//
// `bot.handleUpdate` همان `Api` تازه را می‌سازد؛ اینجا سکویی که هر ربات
// تشخیص می‌دهد از داخل خودِ دست‌کد خوانده می‌شود.
function update(id) {
  return {
    update_id: id,
    message: {
      message_id: id, date: 1, text: "سلام",
      chat: { id: 55, type: "private" },
      from: { id: 55, is_bot: false, first_name: "کاربر" },
    },
  };
}

const seen = {};
tg.on("message", (ctx) => { seen.tg = platformOf(ctx); });
bale.on("message", (ctx) => { seen.bale = platformOf(ctx); });

await tg.init();
await bale.init();
await tg.handleUpdate(update(1));
await bale.handleUpdate(update(2));

check("آپدیت تلگرام → telegram", seen.tg === "telegram", String(seen.tg));
// این همان بررسی‌ای است که پیش از رفع باگ قرمز می‌شد
check("آپدیت بله → bale", seen.bale === "bale", String(seen.bale));

// ─── خاموش‌بودن بله ─────────────────────────────────────────────────────────
setBaleApi(null);
check("بدون بله، هیچ‌چیز bale تشخیص داده نمی‌شود", isBale(bale.api) === false);

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
