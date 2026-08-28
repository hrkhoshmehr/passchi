/**
 * هیچ چیزِ رندر-بلوک‌کننده‌ای نباید از بیرونِ ایران بیاید.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * مینی‌اپ در `<head>` دو چیز داشت که هر دو رندر را بلوک می‌کردند:
 *
 *   • `fonts.googleapis.com` — شیت فونت
 *   • `telegram.org/js/telegram-web-app.js` — ۱۱۶ کیلوبایت
 *
 * هر دو در ایران بدون فیلترشکن باز نمی‌شوند. مرورگر تا رسیدنِ مهلتِ شبکه
 * منتظر می‌ماند و کاربر صفحهٔ سفید می‌بیند — و کاربر بله دقیقاً همان کسی
 * است که فیلترشکن ندارد. اسکریپت تلگرام هم برای او اصلاً به کار نمی‌آمد.
 *
 * اجرا: npx tsx scripts/test-no-external.mjs
 */
import fs from "node:fs";

const readLf = (p) => fs.readFileSync(p, "utf8").split("\r\n").join("\n");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/** میزبان‌هایی که در ایران قابل اتکا نیستند. */
const BLOCKED = ["fonts.googleapis.com", "fonts.gstatic.com", "telegram.org", "cdn.jsdelivr.net", "unpkg.com"];

for (const page of ["public/app.html", "public/index.html"]) {
  const html = readLf(page);

  // هر `<link rel=stylesheet>` رندر را بلوک می‌کند، پس هیچ‌کدام نباید بیرونی باشد.
  const links = html.match(/<link[^>]+rel=["']?stylesheet[^>]*>/g) ?? [];
  const externalLink = links.filter((l) => BLOCKED.some((h) => l.includes(h)));
  check(`${page}: شیت سبک بیرونی ندارد`, externalLink.length === 0, externalLink.join(" "));

  // `<script src>` بدون `async`/`defer` تجزیهٔ صفحه را متوقف می‌کند.
  const blocking = (html.match(/<script[^>]+src=[^>]*>/g) ?? []).filter(
    (s) => !/\basync\b|\bdefer\b/.test(s) && BLOCKED.some((h) => s.includes(h)),
  );
  check(`${page}: اسکریپت بیرونیِ بلوک‌کننده ندارد`, blocking.length === 0, blocking.join(" "));
}

// ─── فونت واقعاً محلی باشد ──────────────────────────────────────────────────
check("شیت فونت محلی هست", fs.existsSync("public/fonts/vazirmatn.css"));
const css = fs.existsSync("public/fonts/vazirmatn.css") ? readLf("public/fonts/vazirmatn.css") : "";
check("شیت فونت به gstatic اشاره نمی‌کند", !css.includes("gstatic.com"));
check(
  "همهٔ فایل‌های فونتِ نام‌برده موجودند",
  (css.match(/url\(\/fonts\/([^)]+)\)/g) ?? []).every((u) =>
    fs.existsSync("public/fonts/" + u.slice("url(/fonts/".length, -1)),
  ),
);
check("وزن‌های لازم هست", ["400", "600", "700", "800"].every((w) => css.includes(`font-weight: ${w}`)));
check(
  "app.html فونت محلی را بار می‌کند",
  readLf("public/app.html").includes('href="/fonts/vazirmatn.css"'),
);

// اسکریپت تلگرام فقط وقتی که نشانهٔ تلگرام باشد، و بدون بلوک‌کردن
const app = readLf("public/app.html");
check("اسکریپت تلگرام شرطی بار می‌شود", app.includes('indexOf("tgWebApp")'));
check("و به‌صورت async", /s\.async = true/.test(app));

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
