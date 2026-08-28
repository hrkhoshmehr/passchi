/**
 * تجزیهٔ آرگومان‌های `/gift` — با همان کدی که ربات اجرا می‌کند.
 *
 * منطق از `bot/index.ts` بیرون کشیده و اجرا می‌شود، نه کپی؛ اگر آن حلقه عوض
 * شود و این مسیر بشکند، آزمون همان لحظه قرمز می‌شود.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * `/gift ۵۰` با رقم فارسی، بی‌صدا به «یادداشت» می‌افتاد: کد با ۲۰ سکهٔ
 * پیش‌فرض ساخته می‌شد و هیچ خطایی هم داده نمی‌شد. ادمین این دستور را از روی
 * موبایل با صفحه‌کلید فارسی می‌زند، پس این حالتِ نادری نیست.
 *
 * اجرا: npx tsx scripts/test-gift-parse.mjs
 */
import fs from "node:fs";

const src = fs.readFileSync("src/bot/index.ts", "utf8").split("\r\n").join("\n");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ─── حلقهٔ تجزیه را از خودِ منبع بردار ──────────────────────────────────────
const begin = src.indexOf("  for (const raw of parts) {");
const end = src.indexOf("\n  }", begin);
if (begin < 0 || end < 0) {
  console.log("❌ حلقهٔ تجزیهٔ /gift در index.ts پیدا نشد");
  process.exit(1);
}
// تنها حاشیه‌نویسی تایپ داخل حلقه همین است؛ `new Function` جاوااسکریپت
// می‌خواهد نه تایپ‌اسکریپت.
const loop = src.slice(begin, end + 4).replace(/let m: RegExpMatchArray \| null;/, "let m;");

const DEFAULT_GIFT_COINS = 20;
const body = `
  const parts = (arg ?? "").trim().split(/\\s+/).filter(Boolean);
  let coins = null, maxUses = 1, days = null;
  const words = [];
${loop}
  return { coins: coins ?? ${DEFAULT_GIFT_COINS}, maxUses, days, note: words.join(" ") || null };
`;
const parse = new Function("arg", body);

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ─── حالت‌های مستند ─────────────────────────────────────────────────────────
check("بدون آرگومان → ۲۰ سکه، یک‌بارمصرف",
  eq(parse(""), { coins: 20, maxUses: 1, days: null, note: null }));
check("مقدار تنها",
  eq(parse("50"), { coins: 50, maxUses: 1, days: null, note: null }));
check("مقدار و ظرفیت",
  eq(parse("20 x10"), { coins: 20, maxUses: 10, days: null, note: null }));
check("مقدار و ظرفیت و مهلت",
  eq(parse("20 x10 7d"), { coins: 20, maxUses: 10, days: 7, note: null }));
check("یادداشت",
  eq(parse("20 برای رضا"), { coins: 20, maxUses: 1, days: null, note: "برای رضا" }));
check("ترتیب آزاد است",
  eq(parse("x10 20"), { coins: 20, maxUses: 10, days: null, note: null }));
check("همه با هم",
  eq(parse("100 x5 30d کمپین"), { coins: 100, maxUses: 5, days: 30, note: "کمپین" }));
check("جداکنندهٔ هزارگان",
  eq(parse("1,000"), { coins: 1000, maxUses: 1, days: null, note: null }));

// ─── همان باگ ───────────────────────────────────────────────────────────────
check("رقم فارسی مقدار است، نه یادداشت",
  eq(parse("۵۰"), { coins: 50, maxUses: 1, days: null, note: null }),
  JSON.stringify(parse("۵۰")));
check("ظرفیت با رقم فارسی",
  eq(parse("۲۰ x۱۰"), { coins: 20, maxUses: 10, days: null, note: null }),
  JSON.stringify(parse("۲۰ x۱۰")));
check("مهلت با رقم فارسی",
  eq(parse("۲۰ ۷d"), { coins: 20, maxUses: 1, days: 7, note: null }),
  JSON.stringify(parse("۲۰ ۷d")));
check("جداکنندهٔ فارسی هزارگان",
  eq(parse("۱٬۰۰۰"), { coins: 1000, maxUses: 1, days: null, note: null }),
  JSON.stringify(parse("۱٬۰۰۰")));

// ─── حالت‌هایی که باید رد شوند ──────────────────────────────────────────────
// خودِ دستور صفر و منفی را رد می‌کند؛ اینجا فقط تجزیه سنجیده می‌شود.
check("صفر همان صفر خوانده می‌شود تا دستور ردش کند", parse("0").coins === 0);
check("رد صفر در دستور هست", /if \(coins <= 0 \|\| maxUses <= 0\)/.test(src));

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
