import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { type Browser } from "puppeteer";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { buildHtml, type NoteDocument } from "./template.js";
import { toFaDigits } from "../util/time.js";

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  browserPromise ??= puppeteer.launch({
    headless: true,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
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
  const html = buildHtml(doc);
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
