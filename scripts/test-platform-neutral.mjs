/**
 * پیام‌های مشترک نباید نام یک سکو را ببرند.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * دست‌کدها عمداً یکی‌اند و همان متن به هر دو سکو می‌رود. پس هر جمله‌ای که
 * «تلگرام» بگوید، برای کاربر بله **غلط** است — و او دقیقاً همان کسی است که
 * کمتر به او فکر می‌شود.
 *
 * دو نمونهٔ واقعی که کاربر گزارش کرد:
 *   • «می‌تونی تلگرامو ببندی، نتیجه همین‌جا میاد» — در بله دیده می‌شد.
 *   • «هر فایل صوتی یا ویس تلگرام» — در راهنمای بله.
 *
 * استثناها صریح‌اند: صفحهٔ ورودِ سایت واقعاً هر دو دکمه را دارد و باید
 * نامشان را ببرد.
 *
 * اجرا: npx tsx scripts/test-platform-neutral.mjs
 */
import fs from "node:fs";

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/**
 * فقط رشته‌های واقعی سنجیده می‌شوند، نه توضیحات.
 *
 * توضیحِ کد **باید** بتواند بگوید «در بله چنین است» — آن‌ها را هم گرفتن،
 * آزمون را به دشمنِ مستندسازی تبدیل می‌کند.
 */
function stringsOf(file) {
  const src = fs.readFileSync(file, "utf8").split("\r\n").join("\n");
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/^[ \t]*\/\/.*$/gm, "");
  return noLine;
}

// پیام‌هایی که به هر دو سکو می‌روند
const SHARED = [
  "src/bot/strings.ts",
  "src/bot/menu.ts",
  "src/bot/demo.ts",
  "src/bot/deliver.ts",
  "src/bot/share.ts",
];

for (const f of SHARED) {
  const body = stringsOf(f);
  const hits = [];
  for (const m of body.matchAll(/[^\n]*تلگرام[^\n]*/g)) hits.push(m[0].trim().slice(0, 70));
  check(`${f} نام سکو را نمی‌برد`, hits.length === 0, hits.join(" | "));
}

// ─── دکمهٔ «برگرد به ربات» ──────────────────────────────────────────────────
//
// این همان چیزی است که کاربر گزارش کرد: در بله زد و تلگرام باز شد.
const js = fs.readFileSync("public/app.js", "utf8").split("\r\n").join("\n");
check(
  "سکوی نشست از پاسخ سرور گرفته می‌شود",
  /platformOfSession = res\.platform \?\? platform/.test(js),
);
check(
  "لینک بازگشت از سکوی نشست می‌آید",
  /url = \(platformOfSession && bots\[platformOfSession\]\) \|\| null/.test(js),
);
check(
  "به تلگرام برنمی‌گردد وقتی سکو نامعلوم است",
  !/bots\[[^\]]*\]\s*\|\|\s*bots\.telegram/.test(js),
);
check("سکو در localStorage می‌ماند", /passchi_platform/.test(js));

const server = fs.readFileSync("src/web/server.ts", "utf8");
check("سرور سکوی پذیرفته‌شده را برمی‌گرداند", /user: \{ name: user\.name[\s\S]{0,600}?\n\s*platform,/.test(server));

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
