/**
 * مقایسهٔ مدل‌ها روی **کلاس واقعی**، با همان پرامپت‌ها و همان اسکیمای تولید.
 *
 * چرا اینجا و نه با `run-pipeline`: رونویسی دوباره نه لازم است نه ارزان.
 * توکن‌های Soniox در `data/cache/*.soniox.json` هستند، پس رونوشت عیناً
 * بازسازی می‌شود و تنها متغیرِ آزمایش، خودِ مدل می‌ماند.
 *
 * هزینه از `usage.cost` خودِ OpenRouter می‌آید نه از ضرب‌وتقسیم ما — چون
 * مسیریابی به ارائه‌دهنده‌های مختلف قیمت را عوض می‌کند.
 *
 * اجرا (روی سرور، چون شبکهٔ ایران به OpenRouter نمی‌رسد):
 *   node --import tsx scripts/model-ab.mjs <cacheFile> <model1,model2,...>
 */
import fs from "node:fs";
import path from "node:path";

const { buildTranscript, renderForModel, verifyQuote } = await import("../src/stt/transcript.ts");
const { TimeMap } = await import("../src/audio/ffmpeg.ts");
const { chat, extractJson } = await import("../src/analysis/openrouter.ts");
const P = await import("../src/analysis/prompts.ts");
const { ClassAnalysis } = await import("../src/analysis/schema.ts");
const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
const { repairAnalysis } = await import("../src/analysis/repair.ts");
const format = zodOutputFormat(ClassAnalysis);

const cacheFile = process.argv[2];
const models = (process.argv[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!cacheFile || models.length === 0) {
  console.error("usage: model-ab.mjs <cacheFile> <model1,model2,...>");
  process.exit(1);
}

const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));

/**
 * ساختار کش: `transcript.tokens` توکن‌های خام و `preprocess.timeMap` نگاشت
 * زمانی همان اجرا.
 *
 * نگاشتِ **ذخیره‌شده** استفاده می‌شود نه `identity`: اگر سکوت حذف شده باشد،
 * زمان‌های توکن روی فایل پیش‌پردازش‌شده‌اند و بدون نگاشت، همهٔ مهرهای زمانی
 * جابه‌جا می‌شوند — یعنی آزمایش، مدل‌ها را با رونوشتی می‌سنجید که تولید
 * هرگز نمی‌بیند.
 */
const durationMs = cached.preprocess?.originalDurationMs ?? cached.transcription?.audio_duration_ms ?? 0;
const t = buildTranscript(cached.transcript.tokens, TimeMap.fromJSON(cached.preprocess?.timeMap));
const rendered = renderForModel(t);
const meta = `مدت: ${Math.round(durationMs / 60000)} دقیقه`;
const transcriptText = P.transcriptBlock(meta, rendered);

console.log(`فایل: ${path.basename(cacheFile)}`);
console.log(`رونوشت: ${rendered.length} نویسه · ${t.utterances.length} پاره‌گفتار · ${Math.round(durationMs / 60000)} دقیقه\n`);

/** نقل‌قول‌هایی که واقعاً در رونوشت پیدا می‌شوند — سنجهٔ اصلیِ توهم. */
function quoteScore(report) {
  const quotes = [];
  for (const k of report.key_points ?? []) if (k.evidence?.quote) quotes.push(k.evidence.quote);
  for (const a of report.assignments ?? []) if (a.evidence?.quote) quotes.push(a.evidence.quote);
  let ok = 0;
  // `verifyQuote` آبجکت برمی‌گرداند نه بولین — `.ok` همان آستانهٔ ۰٫۷۵ تولید است.
  for (const q of quotes) if (verifyQuote(t, q).ok) ok++;
  return { total: quotes.length, ok };
}

const results = [];

for (const model of models) {
  console.log(`\n${"═".repeat(60)}\n▶ ${model}\n${"═".repeat(60)}`);
  const row = { model };
  try {
    // ── پاس ۱: تحلیل ساختاریافته ───────────────────────────────────────────
    let t0 = Date.now();
    const r1 = await chat(
      [
        { role: "system", content: P.SYSTEM_COMMON },
        { role: "user", content: `${transcriptText}\n\n${P.TASK_ANALYSIS}` },
      ],
      { model, jsonSchema: format.schema, schemaName: "class_analysis", maxTokens: 32000 },
    );
    row.p1Sec = ((Date.now() - t0) / 1000).toFixed(1);
    row.p1In = r1.inputTokens;
    row.p1Out = r1.outputTokens;
    row.p1Cost = r1.costUsd;

    const report = repairAnalysis(extractJson(r1.text));
    row.recapWords = (report.class_recap ?? "").split(/\s+/).filter(Boolean).length;
    row.keyPoints = (report.key_points ?? []).length;
    row.chapters = (report.chapters ?? []).length;
    row.assignments = (report.assignments ?? []).length;
    const q = quoteScore(report);
    row.quotes = `${q.ok}/${q.total}`;
    row.quoteRate = q.total ? q.ok / q.total : null;

    /**
     * زمان‌ها باید در بازهٔ صوت باشند — همان خطایی که qwen داشت.
     *
     * ⚠️ سرفصل‌ها `start_ms`/`end_ms` دارند نه `at_ms`؛ فقط `parts` داخلشان
     * `at_ms` دارد. نسخهٔ اول اینجا `at_ms` می‌خواند، هیچ عددی پیدا نمی‌کرد،
     * و برای **هر سه مدل** «زمان خراب» گزارش می‌داد — یعنی سنجه‌ای که قرار
     * بود مدل بد را بگیرد، همه را یکسان بد نشان می‌داد.
     */
    const times = [];
    for (const c of report.chapters ?? []) {
      for (const k of [c.start_ms, c.end_ms]) if (typeof k === "number") times.push(k);
      for (const p of c.parts ?? []) if (typeof p.at_ms === "number") times.push(p.at_ms);
    }
    row.timeMax = times.length ? Math.max(...times) : 0;
    row.timeSane = times.length ? row.timeMax <= durationMs * 1.05 : null;

    console.log(`پاس ۱: ${row.p1Sec}s · ${row.p1In}→${row.p1Out} توکن · $${row.p1Cost.toFixed(5)}`);
    console.log(`  روایت ${row.recapWords} کلمه · ${row.keyPoints} نکته · ${row.chapters} سرفصل · ${row.assignments} تکلیف`);
    console.log(`  نقل‌قول تأییدشده: ${row.quotes}${row.quoteRate !== null ? ` (${Math.round(row.quoteRate * 100)}٪)` : ""}`);
    console.log(`  بیشینهٔ زمان: ${Math.round(row.timeMax / 60000)}د از ${Math.round(durationMs / 60000)}د ${row.timeSane ? "✅" : "⚠️ خارج از بازه"}`);

    // ── پاس ۲: جزوه ────────────────────────────────────────────────────────
    //
    // اسکلت عیناً همان چیزی است که `analyze.ts` می‌سازد — اگر شکلش فرق کند،
    // آزمایش دیگر آنچه را که در تولید اجرا می‌شود نمی‌سنجد.
    const skeleton = `### تحلیل ساختاریافتهٔ همین جلسه\n\n\`\`\`json\n${JSON.stringify(
      {
        topics: report.topics,
        key_points: report.key_points,
        glossary: report.glossary,
        open_questions: report.open_questions,
      },
      null,
      1,
    )}\n\`\`\``;

    t0 = Date.now();
    const r2 = await chat(
      [
        { role: "system", content: P.SYSTEM_COMMON },
        { role: "user", content: `${transcriptText}\n\n${P.TASK_NOTES}\n\n${skeleton}` },
      ],
      { model, maxTokens: 32000 },
    );
    row.p2Sec = ((Date.now() - t0) / 1000).toFixed(1);
    row.p2In = r2.inputTokens;
    row.p2Out = r2.outputTokens;
    row.p2Cost = r2.costUsd;
    row.notesChars = r2.text.length;
    row.notesRatio = r2.text.length / rendered.length;

    console.log(`پاس ۲: ${row.p2Sec}s · ${row.p2In}→${row.p2Out} توکن · $${row.p2Cost.toFixed(5)}`);
    console.log(`  جزوه: ${row.notesChars} نویسه (${(row.notesRatio * 100).toFixed(1)}٪ رونوشت)`);

    row.totalCost = row.p1Cost + row.p2Cost;
    row.totalSec = Number(row.p1Sec) + Number(row.p2Sec);
    console.log(`مجموع: $${row.totalCost.toFixed(5)} · ${row.totalSec.toFixed(0)}s`);

    // نمونهٔ متن برای قضاوت کیفیت فارسی
    fs.writeFileSync(
      `/tmp/ab-${model.replace(/[^a-z0-9]/gi, "_")}-recap.txt`,
      `=== روایت کلاس ===\n${report.class_recap}\n\n=== جزوه (۲۰۰۰ نویسهٔ اول) ===\n${r2.text.slice(0, 2000)}`,
      "utf8",
    );
  } catch (e) {
    row.error = String(e).slice(0, 200);
    console.log(`❌ ${row.error}`);
  }
  results.push(row);
}

console.log(`\n\n${"═".repeat(60)}\nخلاصه\n${"═".repeat(60)}`);
for (const r of results) {
  if (r.error) { console.log(`${r.model}: ❌ ${r.error}`); continue; }
  console.log(
    `${r.model}\n  هزینه $${r.totalCost.toFixed(5)} · ${r.totalSec.toFixed(0)}s · نقل‌قول ${r.quotes} · جزوه ${(r.notesRatio * 100).toFixed(1)}٪ · روایت ${r.recapWords} کلمه · زمان ${r.timeSane ? "سالم" : "خراب"}`,
  );
}
fs.writeFileSync("/tmp/ab-results.json", JSON.stringify(results, null, 2), "utf8");
console.log("\nجزئیات: /tmp/ab-results.json · نمونه‌های متن: /tmp/ab-*-recap.txt");
