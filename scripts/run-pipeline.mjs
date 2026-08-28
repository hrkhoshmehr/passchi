/** اجرای کامل خط لوله روی یک فایل، بدون تلگرام. */
import { randomBytes } from "node:crypto";
import { upsertUser, createSession, getSession } from "../src/db/index.js";
import { runPipeline } from "../src/pipeline.js";
import { closeBrowser } from "../src/pdf/render.js";
import { fmtDuration } from "../src/util/time.js";
import { config } from "../src/config.js";

const file = process.argv[2] ?? "example.mp3";
const makePdf = !process.argv.includes("--no-pdf");
// ‎--free همان مسیر «اجرای رایگان» را می‌رود: فقط رونویسی، بدون تماس با مدل
const free = process.argv.includes("--free");
const id = randomBytes(6).toString("hex");
const TEST_USER = 900000099;

upsertUser(TEST_USER, "تست محلی", null);
createSession(id, TEST_USER, null);

console.log(`جلسه ${id} · فایل ${file} · جزوه: ${makePdf ? "بله" : "خیر"}`);
console.log(`تحلیل: ${config.ANALYSIS_PROVIDER} · جزوه: ${config.NOTES_PROVIDER}\n`);

const t0 = Date.now();
try {
  const out = await runPipeline({
    sessionId: id, audioFile: file, course: null,
    sessionDate: new Date().toLocaleDateString("fa-IR"),
    makePdf: makePdf && !free,
    mode: free ? "free_trial" : "full",
    // `--free` فقط برای آزمون دستیِ مسیرِ سقف‌دار است؛ محصول دیگر اجرای
    // رایگان ندارد، پس عدد اینجا ثابت است نه از پیکربندی.
    ...(free ? { limitMs: 15 * 60_000 } : {}),
    onProgress: (s) => console.log(`  [${s.stage}] ${s.detail ?? ""}`),
  });

  if (!out.report) {
    console.log(`\nرونوشت: ${out.transcriptPath} (${out.transcriptText.length} کاراکتر)`);
    console.log(`رونویسی‌نشده: ${fmtDuration(out.skippedMs)}`);
    process.exit(0);
  }

  const r = out.report;
  console.log(`\n${"═".repeat(64)}`);
  console.log(`عنوان: ${r.session_title}`);
  console.log(`درس حدسی: ${r.course_guess ?? "—"}`);
  console.log(`\nسرخط: ${r.headline}`);
  console.log(`\nکلاس چه خبر بود:\n  ${r.class_recap}`);
  console.log("\nترکیب زمانی:");
  for (const c of r.composition) console.log(`  ${c.kind.padEnd(10)} ${String(c.pct).padStart(5)}٪  ${fmtDuration(c.ms)}`);
  console.log(`\nاستاد چه کرد (${r.professor_actions.filter(a=>a.happened).length} مورد تأییدشده):`);
  for (const a of r.professor_actions) console.log(`  ${a.happened ? "✔" : "—"} ${a.action}: ${a.detail}`);
  console.log(`\nنکات با منبع تأییدشده: ${r.key_points.length} (${r.droppedCitations} مورد حذف شد)`);
  for (const k of r.key_points) {
    console.log(`  [${k.kind}] ${k.title}`);
    const words = k.evidence.quote.trim().split(/\s+/).length;
    console.log(`     «${k.evidence.quote}» @${Math.round(k.evidence.at_ms / 1000)}s (${words} کلمه)`);
  }
  console.log(`\nسرفصل‌ها: ${r.topics.length}`);
  for (const t of r.topics) console.log(`  ${Math.round(t.start_ms / 60000)}دق — ${t.title}`);

  console.log("\n── پیام تلگرام که کاربر می‌بیند ──");
  const { recapMessage, extractedMessage, timelineMessage } = await import("../src/bot/strings.js");
  const msgs = [
    recapMessage({
      report: r, courseName: null, sessionDate: null,
      durationMs: out.originalDurationMs, savedMs: 0, qualityWarnings: out.qualityWarnings,
    }),
    extractedMessage(r),
    timelineMessage(r, true),
  ];
  for (const m of msgs) {
    console.log(m.replace(/<[^>]+>/g, ""));
    console.log("\n─────\n");
  }
  console.log(
    `[طول پیام‌ها: ${msgs.map((m) => m.length).join(" + ")} = ${msgs.reduce((a, m) => a + m.length, 0)} کاراکتر]`,
  );


  console.log(`\nواژه‌نامه: ${r.glossary.length} · نکات باز: ${r.open_questions.length}`);
  console.log(`\nجزوه: ${out.notesMarkdown.length} کاراکتر`);
  console.log(`PDF: ${out.pdfPath ?? "ساخته نشد"}`);
  console.log(`هزینهٔ برآوردی: $${out.costUsd.toFixed(4)}`);
  console.log(`زمان کل: ${((Date.now()-t0)/1000).toFixed(0)} ثانیه`);
} catch (e) {
  console.error("\n❌ شکست:", e instanceof Error ? e.message : String(e));
  console.error(e);
} finally {
  await closeBrowser();
}
