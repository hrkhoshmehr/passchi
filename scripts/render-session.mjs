/**
 * جزوهٔ یک جلسهٔ ذخیره‌شده را دوباره از دیتابیس رندر می‌کند — بدون هزینهٔ مدل.
 *
 * برای مقایسهٔ ظاهرِ قالب لازم است: متنِ جزوه ثابت می‌ماند و فقط قالب عوض
 * می‌شود، پس هر تفاوتی در PDF واقعاً از قالب آمده نه از یک اجرای تازهٔ مدل.
 *
 *   npx tsx scripts/render-session.mjs <session-id> <out.pdf> [notes.md]
 *
 * آرگومان سوم اگر بیاید، جزوه از آن فایل مارک‌داون خوانده می‌شود نه از
 * دیتابیس — برای دیدنِ متنِ تازه با همان اسکلتِ قدیمی.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { renderPdf } from "../src/pdf/render.ts";
import { closeBrowser } from "../src/pdf/render.ts";

const [id, out, mdFile] = process.argv.slice(2);
if (!id || !out) {
  console.error("npx tsx scripts/render-session.mjs <session-id> <out.pdf> [notes.md]");
  process.exit(1);
}

const db = new DatabaseSync("data/kharkhoon.db");
const s = db.prepare("select * from sessions where id = ?").get(id);
if (!s) { console.error("جلسه پیدا نشد:", id); process.exit(1); }

await renderPdf(
  {
    courseName: null,
    professorName: null,
    sessionDate: s.session_date ?? null,
    sessionTitle: s.title ?? "جلسه",
    durationMs: s.original_ms ?? 0,
    report: JSON.parse(s.report_json),
    notesMarkdown: mdFile ? fs.readFileSync(mdFile, "utf8") : (s.notes_md ?? ""),
    generatedAt: new Date(),
  },
  out,
);
await closeBrowser();
console.log("✅", out);
