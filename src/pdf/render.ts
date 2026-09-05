import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { type Browser } from "puppeteer";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { buildHtml, type NoteDocument } from "./template.js";
import { toFaDigits } from "../util/time.js";

let browserPromise: Promise<Browser> | null = null;

/**
 * مرورگر یک بار ساخته و بازاستفاده می‌شود — ولی باید از مرگش هم برگردد.
 *
 * بدون شنوندهٔ `disconnected`، اگر کرومیوم یک بار به‌خاطر کمبود حافظه کشته
 * شود، این متغیر همچنان به یک مرورگرِ مرده اشاره می‌کند و از آن لحظه **هر**
 * جزوه‌ای تا ری‌استارتِ سرویس شکست می‌خورد. روی یک سرور کوچک که هم‌زمان
 * ffmpeg هم اجرا می‌کند، این اتفاق فرضی نیست.
 */
function getBrowser(): Promise<Browser> {
  browserPromise ??= puppeteer
    .launch({
      headless: true,
      ...(process.env.PUPPETEER_EXECUTABLE_PATH
        ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
        : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
    })
    .then((b) => {
      b.on("disconnected", () => {
        logger.warn("مرورگر رندر قطع شد — دفعهٔ بعد از نو ساخته می‌شود");
        browserPromise = null;
      });
      return b;
    })
    .catch((e: unknown) => {
      browserPromise = null; // وگرنه یک شکستِ گذرا برای همیشه کش می‌شود
      throw e;
    });
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const b = await browserPromise;
  browserPromise = null;
  await b.close().catch(() => {});
}

export async function renderPdf(doc: NoteDocument, outFile: string): Promise<string> {
  return htmlToPdf(buildHtml(doc), outFile);
}

/**
 * هر HTML ای را با همان تنظیماتِ چاپِ جزوه به PDF تبدیل می‌کند.
 *
 * از دلِ `renderPdf` بیرون کشیده شد چون حالا رونوشت هم PDF می‌شود
 * (`pdf/transcript.ts`) و آن تنظیمات — انتظار برای آماده‌شدن قلم، حاشیه‌ها،
 * شمارهٔ صفحه — نباید در دو جا نگه‌داری شوند.
 */
export async function htmlToPdf(html: string, outFile: string): Promise<string> {
  // صفحه از یک فایل موقت باز می‌شود تا رفتار چاپ Chromium پایدار باشد
  const htmlFile = outFile.replace(/\.pdf$/i, "") + ".html";
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(htmlFile, html, "utf8");

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "networkidle0", timeout: 120_000 });
    await page.evaluateHandle("document.fonts.ready");
    await page.pdf({
      path: outFile,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: `<div style="width:100%;font-size:8px;color:#9aa1ab;text-align:center;
        font-family:sans-serif;padding-top:6px;">
        <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
      margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
      timeout: 180_000,
    });
  } finally {
    await page.close().catch(() => {});
    if (!process.env.KEEP_HTML) await fs.unlink(htmlFile).catch(() => {});
  }

  const stat = await fs.stat(outFile);
  logger.info({ outFile, kb: Math.round(stat.size / 1024) }, "pdf rendered");
  return outFile;
}

/** نام فایل امن برای تلگرام */
export function pdfFileName(courseName: string | null, sessionTitle: string, index?: number): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\n\r]/g, "").trim().slice(0, 50);
  const parts = [clean(courseName ?? "جزوه"), clean(sessionTitle)];
  if (index !== undefined) parts.push(`جلسه ${toFaDigits(index)}`);
  return `${parts.filter(Boolean).join(" — ")}.pdf`;
}

export { config as _config };
