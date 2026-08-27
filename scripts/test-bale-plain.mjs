/**
 * تبدیل HTML به متن ساده برای بله.
 *
 * بله `parse_mode` را می‌پذیرد ولی نادیده می‌گیرد — نه HTML، نه Markdown، نه
 * `entities` — پس تگ‌ها باید پیش از ارسال برداشته شوند. این آزمون هم درستیِ
 * تبدیل را می‌سنجد و هم اینکه پیام‌های واقعیِ محصول پس از تبدیل تگی باقی
 * نگذارند.
 *
 * اجرا: npx tsx scripts/test-bale-plain.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { htmlToPlain } = await import("../src/util/text.ts");
const { WELCOME, HOW_IT_WORKS, packagesMessage } = await import("../src/bot/menu.ts");
const { HELP, PRIVACY, accountMessage, lowBalanceMessage, upsellMessage, settlementMessage } =
  await import("../src/bot/strings.ts");
const { claimedMessage, refusalMessage, DEFAULT_GIFT_COINS } = await import("../src/bot/gift.ts");
const { coinsToSec } = await import("../src/billing/coins.ts");

let bad = 0;
function eq(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) console.log(`   گرفتیم: ${JSON.stringify(actual)}\n   انتظار: ${JSON.stringify(expected)}`);
}

// ─── تبدیل پایه ──────────────────────────────────────────────────────────────
eq("تگ ساده", htmlToPlain("<b>پررنگ</b>"), "پررنگ");
eq("تودرتو", htmlToPlain("<b>پر<i>رنگ</i></b>"), "پررنگ");
eq("code", htmlToPlain("<code>/gift</code>"), "/gift");
eq("br به خط تازه", htmlToPlain("یک<br>دو"), "یک\nدو");
eq("بدون تگ دست‌نخورده", htmlToPlain("سلام دنیا"), "سلام دنیا");

// ─── موجودیت‌ها؛ ترتیب باز کردنشان مهم است ──────────────────────────────────
//
// اگر موجودیت‌ها *پیش از* حذف تگ باز شوند، متنی که کاربر نوشته و شامل
// `&lt;b&gt;` است به تگ واقعی تبدیل و بعد حذف می‌شود — یعنی محتوای کاربر
// بی‌صدا ناپدید می‌شود. این دو آزمون دقیقاً همان را می‌گیرند.
eq("موجودیتِ کاربر تبدیل به تگ نشود", htmlToPlain("<b>&lt;b&gt;</b>"), "<b>");
eq("امپرسند آخر باز شود", htmlToPlain("A &amp;lt; B"), "A &lt; B");
eq("نقل‌قول", htmlToPlain("<i>&quot;نقل&quot;</i>"), '"نقل"');

// ─── پیام‌های واقعی محصول ────────────────────────────────────────────────────
const screens = {
  WELCOME,
  HOW_IT_WORKS,
  HELP,
  PRIVACY,
  packages: packagesMessage(),
  account: accountMessage({ creditSec: coinsToSec(20), usedSec: 0, refundedSec: 0, sessionCount: 0 }),
  lowBalance: lowBalanceMessage(90 * 60, coinsToSec(20)),
  upsell: upsellMessage(90 * 60),
  settlement: settlementMessage(90 * 60, coinsToSec(30)),
  gift: claimedMessage(DEFAULT_GIFT_COINS, coinsToSec(DEFAULT_GIFT_COINS)),
  refusal: refusalMessage("already"),
};

console.log("\nپیام‌های محصول پس از تبدیل:");
for (const [name, html] of Object.entries(screens)) {
  const plain = htmlToPlain(html);
  const leftover = plain.match(/<\/?[a-z][^>]*>/gi);
  const ok = !leftover;
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` — تگ باقی مانده: ${leftover.join(", ")}`}`);
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
