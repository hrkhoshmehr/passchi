import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

function pkgDir(pkg: string): string {
  // مسیر ریشهٔ پکیج را از روی package.json آن پیدا می‌کنیم
  return path.dirname(require_.resolve(`${pkg}/package.json`));
}

function dataUri(file: string): string {
  return `data:font/woff2;base64,${fs.readFileSync(file).toString("base64")}`;
}

let cached: string | null = null;

/**
 * تمام فونت‌ها به‌صورت data URI داخل CSS جاسازی می‌شوند.
 * دلیل: صفحه از یک فایل موقت با پروتکل file:// باز می‌شود و Chromium
 * بارگذاری فونت از مسیرهای نسبی file:// را ناپایدار مدیریت می‌کند.
 * مجموع حجم حدود ۳۷۰ کیلوبایت است که برای یک بار رندر ناچیز است.
 */
export function buildFontCss(): string {
  if (cached) return cached;

  const vazir = path.join(pkgDir("vazirmatn"), "fonts", "webfonts", "Vazirmatn[wght].woff2");
  const katexDir = path.join(pkgDir("katex"), "dist");
  const katexCssPath = path.join(katexDir, "katex.min.css");

  let katexCss = fs.readFileSync(katexCssPath, "utf8");
  // فقط woff2 را نگه می‌داریم و به data URI تبدیل می‌کنیم؛ بقیهٔ فرمت‌ها حذف می‌شوند
  katexCss = katexCss.replace(
    /url\(fonts\/(KaTeX_[A-Za-z-]+)\.woff2\)\s*format\("woff2"\)(\s*,\s*url\([^)]+\)\s*format\("[^"]+"\))*/g,
    (_m, name: string) => {
      const f = path.join(katexDir, "fonts", `${name}.woff2`);
      if (!fs.existsSync(f)) return `url()`;
      return `url(${dataUri(f)}) format("woff2")`;
    },
  );

  cached = `
@font-face {
  font-family: "Vazirmatn";
  src: url(${dataUri(vazir)}) format("woff2-variations");
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
${katexCss}
`;
  return cached;
}
