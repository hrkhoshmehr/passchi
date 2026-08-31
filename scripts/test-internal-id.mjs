/**
 * شناسهٔ **داخلی** همه‌جا، نه `ctx.from.id` خام.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * سفارش شارژ با `beginTopup(ctx.from.id, …)` ساخته می‌شد ولی
 * `receiveReceipt` با `uid(ctx)` دنبالش می‌گشت. روی تلگرام این دو **برابرند**
 * پس همه‌چیز درست به نظر می‌رسید؛ روی بله شناسهٔ داخلی از فضای دیگری می‌آید
 * و سفارش گم می‌شد. کاربر پکیج را انتخاب می‌کرد، رسید پرداخت می‌فرستاد، و
 * جواب می‌گرفت «این عکسه 🤔 من فایل صوتی می‌خوام» — پول داده بود و ربات
 * وانمود می‌کرد سفارشی در کار نیست.
 *
 * همین اشتباه در چند جای دیگر هم بود: `s.tg_id !== ctx.from.id` به کاربر
 * بله می‌گفت جلسهٔ **خودش** مال او نیست، و `startJob` سکه را از شناسهٔ
 * اشتباه کم می‌کرد.
 *
 * ## چرا آزمونِ رفتاری کافی نیست
 *
 * روی تلگرام هر دو مسیر یک عدد می‌دهند، پس آزمونی که رفتار را بسنجد سبز
 * می‌شود چه باگ باشد چه نباشد. تنها چیزی که واقعاً جلویش را می‌گیرد این است
 * که **خودِ متن کد** بررسی شود: در `bot/index.ts` هیچ `ctx.from.id` خامی
 * نباید بماند.
 *
 * اجرا: npx tsx scripts/test-internal-id.mjs
 */
import fs from "node:fs";

const readLf = (p) => fs.readFileSync(p, "utf8").split("\r\n").join("\n");
const src = readLf("src/bot/index.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/**
 * خطوطی که `ctx.from.id` دارند، بیرون از توضیحات.
 *
 * توضیحات عمداً مستثنا هستند: دقیقاً همان‌جا توضیح داده شده که چرا این کار
 * غلط است، و آن متن باید بماند.
 */
const offenders = [];
/** فقط خطوطِ کد — برای بررسی‌های مشخصِ پایین، که نباید توضیحات را بگیرند. */
const codeLines = [];
let inBlockComment = false;
src.split("\n").forEach((line, i) => {
  const t = line.trim();
  if (inBlockComment) {
    if (t.includes("*/")) inBlockComment = false;
    return;
  }
  if (t.startsWith("/*")) {
    if (!t.includes("*/")) inBlockComment = true;
    return;
  }
  if (t.startsWith("*") || t.startsWith("//")) return;
  codeLines.push(line);
  if (/ctx\.from!?\.id/.test(line)) offenders.push(`${i + 1}: ${t.slice(0, 90)}`);
});

check(
  "هیچ ctx.from.id خامی در bot/index.ts نمانده",
  offenders.length === 0,
  offenders.join(" | "),
);

// ─── جاهایی که باگ واقعاً رخ داد، به‌صورت مشخص ──────────────────────────────
//
// بررسی کلی بالا کافی است، ولی این چند خط نامشان برده می‌شود تا اگر روزی
// کسی همان‌ها را برگرداند، پیام آزمون بگوید کدام مسیر شکسته.
check("سفارش شارژ با شناسهٔ داخلی ساخته می‌شود", /beginTopup\(uid\(ctx\)/.test(src));
check("لغو سفارش با شناسهٔ داخلی", /cancelTopup\(ctx\.match!\[1\]!, uid\(ctx\)\)/.test(src));
// روی خطوطِ کد سنجیده می‌شود نه کل فایل: توضیحِ همین باگ عیناً همان رشته را
// دارد و باید بماند.
check(
  "مالکیت جلسه با شناسهٔ داخلی سنجیده می‌شود",
  !codeLines.some((l) => /s\.tg_id !== ctx\.from/.test(l)),
);
check("startJob شناسهٔ داخلی می‌گیرد", /const userId = uid\(ctx\);/.test(src));

// ─── و همان قاعده در مسیرِ رسید، که طرف دیگر ماجرا بود ───────────────────────
const topup = readLf("src/bot/topup.ts");
check("receiveReceipt همچنان از uid استفاده می‌کند", /const tgId = uid\(ctx\)/.test(topup));

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
