/**
 * وزیرمتن را محلی می‌کند تا صفحه به گوگل وابسته نباشد.
 *
 * **چرا:** `fonts.googleapis.com` در ایران بدون فیلترشکن یا کند است یا اصلاً
 * جواب نمی‌دهد، و آن `<link>` در `<head>` **رندر را بلوک می‌کند** — یعنی
 * کاربر تا وقتی مرورگر از انتظار ناامید نشود صفحهٔ سفید می‌بیند. کاربر بله
 * دقیقاً همان کسی است که فیلترشکن ندارد.
 *
 * فقط دو زیرمجموعه گرفته می‌شود: عربی (که فارسی داخلش است) و لاتین. سه
 * زیرمجموعهٔ دیگرِ گوگل (`latin-ext` و…) برای این رابط استفاده‌ای ندارند و
 * فقط حجم اضافه‌اند.
 *
 * اجرا: node scripts/fetch-font.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const CSS_URL =
  "https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;700;800&display=swap";

// بدون این، گوگل نسخهٔ `ttf` برای مرورگرهای قدیمی می‌دهد که چند برابر بزرگ‌تر است.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** فارسی در محدودهٔ عربی است؛ لاتین برای عددها و کلمه‌های انگلیسی لازم است. */
const WANTED = ["U+0600-06FF", "U+0000-00FF"];

const outDir = path.join("public", "fonts");
await fs.mkdir(outDir, { recursive: true });

const css = await (await fetch(CSS_URL, { headers: { "user-agent": UA } })).text();

// هر بلوک `@font-face` جداگانه بررسی می‌شود تا فقط زیرمجموعه‌های لازم بمانند.
const blocks = css.split("@font-face").slice(1).map((b) => `@font-face${b.split("}")[0]}}`);

const kept = [];
let n = 0;
for (const block of blocks) {
  if (!WANTED.some((r) => block.includes(r))) continue;

  const url = block.match(/url\((https:\/\/[^)]+)\)/)?.[1];
  const weight = block.match(/font-weight:\s*(\d+)/)?.[1] ?? "400";
  if (!url) continue;

  const subset = block.includes("U+0600-06FF") ? "arabic" : "latin";
  const name = `vazirmatn-${weight}-${subset}.woff2`;
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  await fs.writeFile(path.join(outDir, name), bytes);
  n++;
  console.log(`${name.padEnd(34)} ${(bytes.length / 1024).toFixed(1)} KB`);

  kept.push(block.replace(/url\(https:\/\/[^)]+\)/, `url(/fonts/${name})`));
}

await fs.writeFile(path.join(outDir, "vazirmatn.css"), kept.join("\n\n") + "\n", "utf8");
console.log(`\n${n} فایل فونت + vazirmatn.css`);
