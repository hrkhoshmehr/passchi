/**
 * صفحه‌کلیدهای شیشه‌ای — هیچ ردیف خالی، و همه‌جا راه برگشت.
 *
 * دو چیز سنجیده می‌شود:
 *
 * ۱. **ردیف خالی نباشد.** `new InlineKeyboard()` خودش با `[[]]` شروع می‌شود،
 *    پس یک `row()` بی‌احتیاط یک ردیف خالی جا می‌گذارد و تلگرام کل پیام را
 *    رد می‌کند — خطایی که فقط در زمان اجرا و روی همان یک صفحه دیده می‌شود.
 *
 * ۲. **دکمهٔ بازگشت هست.** هر صفحه‌ای که کاربر را جایی می‌برد باید راه
 *    برگشت داشته باشد، وگرنه تنها راه بیرون‌آمدن اسکرول‌کردن تا صفحه‌کلید
 *    پایین است.
 *
 * اجرا: npx tsx scripts/test-keyboards.mjs
 */
process.env.BOT_TOKEN ||= "x";
process.env.PUBLIC_URL ||= "https://passchi.ir";

const { InlineKeyboard } = await import("grammy");
const { packagesKeyboard, supportKeyboard, mainKeyboard } = await import("../src/bot/menu.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/** همان تابعی که `bot/index.ts` دارد؛ اینجا کپی است چون صادر نشده. */
function withBack(kb, to = "home") {
  if (to !== "home") return kb;
  const rows = kb.inline_keyboard;
  if (rows.length && rows[rows.length - 1].length) kb.row();
  return kb.text("🏠 منوی اصلی", "home");
}

const noEmptyRow = (kb) => !kb.inline_keyboard.some((r) => r.length === 0);
const hasBack = (kb) => kb.inline_keyboard.flat().some((b) => b.callback_data === "home");

// ─── حالت‌هایی که `withBack` می‌گیرد ─────────────────────────────────────────
const cases = {
  "صفحه‌کلید خالی (حریم خصوصی)": withBack(new InlineKeyboard()),
  "یک دکمه (حساب)": withBack(new InlineKeyboard().text("🪙 شارژ حساب", "topup")),
  "چند ردیفه (شارژ)": withBack(packagesKeyboard()),
  "دکمهٔ سکو تهی (پشتیبانی در بله)": withBack(supportKeyboard("bale") ?? new InlineKeyboard()),
  "دکمهٔ سکو موجود (پشتیبانی در تلگرام)": withBack(
    supportKeyboard("telegram") ?? new InlineKeyboard(),
  ),
};

for (const [name, kb] of Object.entries(cases)) {
  const rows = kb.inline_keyboard.map((r) => r.map((b) => b.text));
  check(`${name}: بدون ردیف خالی`, noEmptyRow(kb), JSON.stringify(rows));
  check(`${name}: دکمهٔ بازگشت دارد`, hasBack(kb));
}

// ─── صفحه‌کلید اصلی: دکمهٔ تکراری نداشته باشد ───────────────────────────────
//
// «صوت بفرستم» و «ارسال صوت» یک کار می‌کنند؛ اگر هر دو بیایند کاربر باید
// حدس بزند کدام را بزند.
const mainLabels = mainKeyboard.build().flat().map((b) => b.text);
check("صفحه‌کلید اصلی ردیف خالی ندارد", !mainKeyboard.build().some((r) => r.length === 0));
check(
  "دکمهٔ ارسال صوت تکراری نیست",
  mainLabels.filter((t) => t.includes("صوت")).length === 1,
  mainLabels.join(" | "),
);

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
