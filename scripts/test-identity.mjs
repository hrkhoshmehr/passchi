/**
 * هویت بدون شمارهٔ موبایل.
 *
 * دو ادعا سنجیده می‌شود:
 *
 *   ۱. **در ورود با شماره بسته است** تا وقتی `SMS_ENDPOINT` خالی باشد — هم
 *      در گرفتن کد و هم در تأیید آن. اگر فقط اولی بسته می‌شد، کدی که پیش از
 *      خاموش‌شدن صادر شده تا انقضایش هنوز یک در باز بود.
 *   ۲. **شناسهٔ هر سکو یکتاست**: همان عدد در تلگرام و بله دو حساب جدا
 *      می‌سازد و سکه‌هایشان روی هم نمی‌ریزد.
 *
 * اجرا: DATA_DIR=./data/tmp-id npx tsx scripts/test-identity.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { requestOtp, verifyOtp, phoneLoginEnabled, OtpError } = await import("../src/web/auth.ts");
const { resolveIdentity, identitiesOf } = await import("../src/db/identity.ts");
const { grant, currentBalance } = await import("../src/billing/ledger.ts");
const { coinsToSec, balanceCoins } = await import("../src/billing/coins.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ─── ۱) در شماره بسته است ────────────────────────────────────────────────────
check("phoneLoginEnabled خاموش است", phoneLoginEnabled() === false);

let reqErr = null;
try {
  await requestOtp("09121234567");
} catch (e) {
  reqErr = e;
}
check("requestOtp رد می‌شود", reqErr instanceof OtpError && reqErr.code === "disabled", reqErr?.code);

let verErr = null;
try {
  verifyOtp("09121234567", "123456");
} catch (e) {
  verErr = e;
}
check("verifyOtp هم رد می‌شود", verErr instanceof OtpError && verErr.code === "disabled", verErr?.code);

// ─── ۲) شناسهٔ سکو یکتاست ────────────────────────────────────────────────────
//
// عمداً یک عدد یکسان: اگر فضای شناسه‌ها تفکیک نشده باشد، این دو به یک حساب
// می‌رسند و سکه‌های یکی در دست دیگری می‌افتد.
const SAME = "70000123";
const tg = resolveIdentity({ platform: "telegram", platformUserId: SAME, name: "تلگرامی" });
const bale = resolveIdentity({ platform: "bale", platformUserId: SAME, name: "بله‌ای" });

check("دو حساب جدا ساخته شد", tg.tg_id !== bale.tg_id, `${tg.tg_id} ≠ ${bale.tg_id}`);
check("شناسهٔ تلگرام همان عدد است", tg.tg_id === Number(SAME));
check("شناسهٔ بله از فضای داخلی است", bale.tg_id > 2 ** 52);

grant(tg.tg_id, coinsToSec(30), "grant");
check("سکهٔ تلگرام به بله نشت نکرد", currentBalance(bale.tg_id) === 0,
  `بله: ${balanceCoins(currentBalance(bale.tg_id))} سکه`);
check("سکهٔ تلگرام سر جایش است", balanceCoins(currentBalance(tg.tg_id)) === 30);

// ورود دوباره باید همان حساب را بدهد، نه حساب تازه
const again = resolveIdentity({ platform: "bale", platformUserId: SAME });
check("ورود دوبارهٔ بله همان حساب است", again.tg_id === bale.tg_id);
check("هر حساب یک هویت دارد", identitiesOf(bale.tg_id).length === 1);

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
