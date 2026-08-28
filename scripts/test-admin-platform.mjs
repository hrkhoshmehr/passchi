/**
 * ادمین‌بودن باید روی هر سکو درست تشخیص داده شود.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * `isAdmin` شناسهٔ خامِ `ctx.from.id` را با `ADMIN_IDS` مقایسه می‌کرد و
 * `ADMIN_IDS` شناسه‌های تلگرام‌اند. روی بله شناسهٔ کاربر عدد دیگری است، پس
 * هیچ ادمینی روی بله ادمین شناخته نمی‌شد و `/gift` و بقیهٔ دستورهای مدیریتی
 * **بی‌صدا** هیچ کاری نمی‌کردند — نه خطا، نه پیام، فقط `return`.
 *
 * و چرا فهرست جداست: یک عدد در دو سکو دو نفر متفاوت‌اند. اگر هر دو فهرست
 * یکی می‌شد، یک شناسهٔ بله می‌توانست تصادفاً با شناسهٔ تلگرامِ کس دیگری
 * برابر شود و به او دسترسی ادمین بدهد.
 *
 * اجرا: npx tsx scripts/test-admin-platform.mjs
 */
import fs from "node:fs";

const readLf = (p) => fs.readFileSync(p, "utf8").split("\r\n").join("\n");
const index = readLf("src/bot/index.ts");
const conf = readLf("src/config.ts");
const topup = readLf("src/bot/topup.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

check("BALE_ADMIN_IDS در پیکربندی هست", /BALE_ADMIN_IDS: z/.test(conf));
check("isAdmin به‌جای عدد، Context می‌گیرد", /function isAdmin\(ctx: Context\)/.test(index));
check(
  "فهرست ادمین بر اساس سکو انتخاب می‌شود",
  /platformOf\(ctx\) === "bale" \? config\.BALE_ADMIN_IDS : config\.ADMIN_IDS/.test(index),
);

// هیچ صدازننده‌ای نباید هنوز شناسهٔ خام بدهد
const rawCalls = index.match(/isAdmin\(ctx\.from[^)]*\)/g) ?? [];
check("هیچ صدازننده‌ای شناسهٔ خام نمی‌دهد", rawCalls.length === 0, rawCalls.join(" "));

// همهٔ دستورهای مدیریتی باید محافظت‌شده بمانند
const guards = (index.match(/if \(!isAdmin\(ctx\)\)/g) ?? []).length;
check("همهٔ دستورهای مدیریتی محافظ دارند", guards >= 7, `${guards} مورد`);

// خبررسانی هدیه باید از رباتِ درست برود
check(
  "خبر هدیه به ادمین بله از ربات بله می‌رود",
  /BALE_ADMIN_IDS\.map\(\(id\) => \[baleBot\?\.api/.test(index),
);
check("خبر شارژ هم فهرست همان سکو را می‌گیرد", /isBale\(api\) \? config\.BALE_ADMIN_IDS/.test(topup));

// لینک هدیه باید دامنهٔ درست بگیرد
const gift = readLf("src/bot/gift.ts");
check("لینک هدیه در بله ble.ir می‌شود", /isBale\(api\) \? "ble\.ir" : "t\.me"/.test(gift));

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
