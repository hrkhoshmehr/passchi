/**
 * راه‌اندازی نباید پیش از `bot.start()` منتظرِ بله بماند.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * ۲۰۲۶-۰۹-۱۴ بله از سرور در دسترس نبود (اتصال در SYN-SENT). `src/index.ts`
 * پیش از `bot.start()` روی `resolveBotLinks` و `baleStatus` (هر دو `getMe` بله)
 * `await` داشت، پس ربات تلگرام هم هیچ پیامی نمی‌گرفت. قطعیِ یک سکو، هر دو را
 * خواباند.
 *
 * اجرا: node scripts/test-boot-order.mjs
 */
import fs from "node:fs";

const src = fs.readFileSync("src/index.ts", "utf8").split("\r\n").join("\n");
const links = fs.readFileSync("src/bot/links.ts", "utf8").split("\r\n").join("\n");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const start = src.indexOf("await bot.start(");
check("bot.start پیدا شد", start > 0);
const before = src.slice(0, start);

check("پیش از bot.start هیچ await روی resolveBotLinks نیست", !/await\s+resolveBotLinks/.test(before));
check("پیش از bot.start هیچ await روی baleStatus نیست", !/await\s+baleStatus/.test(before));
// فقط سطح بالای فایل؛ `await` داخلِ بدنهٔ `baleStatus` راه‌اندازی را نگه نمی‌دارد.
check("پیش از bot.start هیچ await سطح‌بالایی روی baleBot نیست", !/^await\s+baleBot/m.test(before));
check("بلهٔ خودش هم بی await شروع می‌شود", /^void startBaleWithRetry\(\);/m.test(before));
// خطای شبکه را خودِ grammY دوباره تلاش می‌کند؛ ولی ۴۰۱/۴۰۹ را پرتاب می‌کند و polling می‌ایستد.
check(
  "شروعِ بله پس از شکست دوباره تلاش می‌کند",
  /async function startBaleWithRetry[\s\S]*for \(let attempt[\s\S]*baleBot\.start\([\s\S]*catch[\s\S]*setTimeout/.test(before),
);
check(
  "آدرس تلگرام به پاسخِ بله گره نخورده (هر سکو جدا پر می‌شود)",
  /telegram\?\.getMe\(\)\.then/.test(links) && /bale\?\.getMe\(\)\.then/.test(links),
);

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
