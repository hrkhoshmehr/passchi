import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { fmtDuration } from "./util/time.js";
import { preprocess } from "./audio/preprocess.js";
import { TimeMap, trimTo } from "./audio/ffmpeg.js";
import { transcribe } from "./stt/soniox.js";
import { lookup as cacheLookup, store as cacheStore, type CachedTranscript } from "./stt/cache.js";
import { buildTranscript, renderPlain, renderSrt, toTurns } from "./stt/transcript.js";
import { analyzeClass, type SessionMeta } from "./analysis/analyze.js";
import { renderPdf, pdfFileName } from "./pdf/render.js";
import { renderTranscriptPdf } from "./pdf/transcript.js";
import type { AnalysisReport } from "./analysis/schema.js";
import {
  courseTerms, getCourse, mergeCourseTerms, updateSession,
  type CourseRow, type SessionMode, type SessionStatus,
} from "./db/index.js";

export type Stage =
  | { stage: "preprocess"; detail?: string }
  | { stage: "stt"; detail?: string }
  | { stage: "analyze"; detail?: string }
  | { stage: "pdf"; detail?: string };

export interface PipelineInput {
  sessionId: string;
  audioFile: string;
  course: CourseRow | null;
  sessionDate: string | null;
  makePdf: boolean;
  /**
   * `free_trial` اجرای رایگانِ یک‌بارهٔ کاربر تازه است: فقط رونویسی، با سقف
   * مدت (`limitMs`). نه تحلیل، نه جزوه، نه تماسی با مدل زبانی.
   *
   * کارش سنجیدن **دقت صوت به متن** روی صوت خودِ کاربر است. نمایشِ تحلیل
   * کار تور نمونه است (`bot/demo.ts`)، نه این.
   */
  mode: SessionMode;
  /** سقف مدتی که رونویسی می‌شود؛ مازادش بریده می‌شود. */
  limitMs?: number;
  onProgress: (s: Stage) => void;
  signal?: AbortSignal;
}

export interface PipelineOutput {
  /** فقط وقتی null است که تحلیل انجام نشده باشد (حالت رایگانِ قدیمی). */
  report: AnalysisReport | null;
  notesMarkdown: string;
  pdfPath: string | null;
  pdfName: string | null;
  transcriptPath: string;
  /** نسخهٔ PDF رونوشت؛ `null` اگر ساختش شکست خورد. */
  transcriptPdfPath: string | null;
  /** فایل زیرنویس زمان‌دار؛ `null` اگر نوشتنش شکست خورد. */
  transcriptSrtPath: string | null;
  /** متن رونوشت، برای وقتی که پیام مستقیماً از آن ساخته می‌شود */
  transcriptText: string;
  originalDurationMs: number;
  /** اگر به‌خاطر سقف رایگان بریده شد، چقدر از فایل رونویسی نشد */
  skippedMs: number;
  billedDurationMs: number;
  savedMs: number;
  costUsd: number;
  qualityWarnings: string[];
  preprocessSteps: string[];
  /** اگر جزوه ساخته نشد، دلیلش — تحلیل همچنان کامل است */
  notesError: string | null;
}

function setStatus(id: string, status: SessionStatus): void {
  updateSession(id, { status });
}

export async function runPipeline(inp: PipelineInput): Promise<PipelineOutput> {
  const { sessionId } = inp;

  // ── ۱) پیش‌پردازش ───────────────────────────────────────────────────────
  setStatus(sessionId, "preprocess");
  inp.onProgress({ stage: "preprocess" });
  const pre = await preprocess(inp.audioFile, sessionId);

  updateSession(sessionId, {
    original_file: pre.originalFile,
    original_ms: pre.originalDurationMs,
    billed_ms: pre.billedDurationMs,
    silence_ms: Math.max(0, pre.originalDurationMs - pre.billedDurationMs),
    time_map_json: JSON.stringify(pre.timeMap.toJSON()),
  });

  inp.onProgress({
    stage: "preprocess",
    detail:
      pre.savedMs > 0
        ? `${fmtDuration(pre.savedMs)} سکوت حذف شد — همین‌قدر از هزینه کم می‌شود`
        : "بدون حذف سکوت",
  });

  // ── ۲) رونویسی ──────────────────────────────────────────────────────────
  setStatus(sessionId, "stt");
  inp.onProgress({ stage: "stt" });

  const terms = inp.course ? courseTerms(inp.course) : [];
  const contextText = inp.course
    ? `درس «${inp.course.name}»${inp.course.professor ? ` با استاد ${inp.course.professor}` : ""}. سخنرانی دانشگاهی به زبان فارسی با اصطلاحات تخصصی انگلیسی.`
    : "سخنرانی دانشگاهی به زبان فارسی با اصطلاحات تخصصی انگلیسی.";

  /**
   * برش سقف رایگان.
   *
   * روی فایلِ *پردازش‌شده* انجام می‌شود نه فایل اصلی: فایل اصلی باید دست‌نخورده
   * بماند تا دکمه‌های زمان و کلیپ‌ها کار کنند، و تا اگر کاربر بعداً سکه خرید،
   * تحلیل کامل روی کل جلسه اجرا شود.
   */
  let sttFile = pre.processedFile;
  let skippedMs = 0;
  if (inp.limitMs && pre.originalDurationMs > inp.limitMs) {
    skippedMs = pre.originalDurationMs - inp.limitMs;
    // پسوند باید همان پسوند ورودی بماند: برش با `-c copy` انجام می‌شود و
    // ffmpeg ظرف خروجی را از روی پسوند انتخاب می‌کند — mp3 داخل ogg نمی‌رود.
    sttFile = path.join(config.workDir, `${sessionId}.limited${path.extname(pre.processedFile) || ".ogg"}`);
    await trimTo(pre.processedFile, sttFile, inp.limitMs);
    inp.onProgress({
      stage: "preprocess",
      detail: `رایگان تا ${fmtDuration(inp.limitMs)} — بقیهٔ فایل تحلیل نمی‌شود`,
    });
  }

  /**
   * اگر عین همین فایل قبلاً رونویسی شده، دوباره پول نمی‌دهیم.
   *
   * کلید کش فایل *اصلی* است نه فایل پردازش‌شده — همان چیزی که کاربر فرستاده.
   * اجرای بریده‌شده کلید خودش را دارد، وگرنه رونوشتِ ۳۰ دقیقه‌ای به‌جای
   * رونوشت کل جلسه تحویل داده می‌شد.
   */
  const cacheKey = sttFile === pre.processedFile ? inp.audioFile : sttFile;
  const cached = await cacheLookup(cacheKey);
  let stt: CachedTranscript;

  if (cached) {
    stt = cached;
    inp.onProgress({ stage: "stt", detail: "از کش خوانده شد — هزینه‌ای نداشت" });
  } else {
    const fresh = await transcribe({
      filePath: sttFile,
      languageHints: ["fa", "en"],
      context: { text: contextText, ...(terms.length ? { terms } : {}) },
      clientReferenceId: sessionId,
      onStatus: (s) => inp.onProgress({ stage: "stt", detail: s }),
      ...(inp.signal ? { signal: inp.signal } : {}),
    });
    await cacheStore(cacheKey, fresh.raw, {
      source: pre.source,
      originalDurationMs: pre.originalDurationMs,
      billedDurationMs: pre.billedDurationMs,
      savedMs: pre.savedMs,
      quality: pre.quality,
      steps: pre.steps,
      transcoded: pre.transcoded,
      timeMap: pre.timeMap.toJSON(),
    });
    stt = fresh;
  }

  const built = buildTranscript(stt.tokens, pre.timeMap);
  if (built.utterances.length === 0) throw new Error("هیچ گفتاری در فایل تشخیص داده نشد.");

  const transcriptPath = path.join(config.outDir, `${sessionId}.transcript.txt`);
  await fs.mkdir(config.outDir, { recursive: true });
  const transcriptText = renderPlain(built);
  await fs.writeFile(transcriptPath, transcriptText, "utf8");
  updateSession(sessionId, { transcript_txt: transcriptText.slice(0, 1_000_000) });

  /**
   * نسخهٔ PDF رونوشت — نسخه‌ای که واقعاً روی گوشی خوانده می‌شود.
   *
   * `.txt` سالم است و رمزگذاری‌اش هم صریح اعلام می‌شود، ولی نمایشگرِ سکو روی
   * موبایل نه آن اعلام را می‌خواند و نه BOM را؛ جزئیاتش در `pdf/transcript.ts`.
   * PDF قلم و رمزگذاری را داخل خودش می‌برد، پس دستِ نمایشگر باز نیست.
   *
   * شکستش مسیر را نمی‌شکند: رونوشتِ متنی همچنان هست و بقیهٔ خط لوله ادامه
   * می‌دهد. یک PDF نساخته‌شده بهتر از جلسه‌ای است که کلاً شکست بخورد.
   */
  let transcriptPdfPath: string | null = null;
  try {
    const out = path.join(config.outDir, `${sessionId}.transcript.pdf`);
    await renderTranscriptPdf(
      {
        sessionTitle: "رونوشت کامل جلسه",
        courseName: inp.course?.name ?? null,
        sessionDate: inp.sessionDate,
        turns: toTurns(built),
      },
      out,
    );
    transcriptPdfPath = out;
    updateSession(sessionId, { transcript_pdf: out });
  } catch (e) {
    logger.warn({ sessionId, err: String(e) }, "transcript pdf failed");
  }

  /**
   * فایل زیرنویس — همان اطلاعاتی که از PDF برداشته شد.
   *
   * جدا نگه داشته می‌شود چون دو کارِ متفاوت‌اند: PDF برای خواندن، SRT برای
   * پیداکردنِ یک لحظه یا سوارکردن روی ویدیوی ضبط‌شده.
   */
  let transcriptSrtPath: string | null = null;
  try {
    const out = path.join(config.outDir, `${sessionId}.transcript.srt`);
    await fs.writeFile(out, renderSrt(built), "utf8");
    transcriptSrtPath = out;
    updateSession(sessionId, { transcript_srt: out });
  } catch (e) {
    logger.warn({ sessionId, err: String(e) }, "transcript srt failed");
  }

  // فایل پردازش‌شده دیگر لازم نیست — فقط فایل اصلی برای کلیپ‌ها می‌ماند
  // فقط وقتی ترنسکد شده باشد فایل موقتی وجود دارد. اگر ترنسکد نشده،
  // processedFile خودِ فایل اصلی کاربر است و پاک‌کردنش یعنی از دست دادن
  // مرجع نقل‌قول‌ها و کلیپ‌ها.
  if (pre.transcoded) await fs.unlink(pre.processedFile).catch(() => {});
  if (sttFile !== pre.processedFile) await fs.unlink(sttFile).catch(() => {});

  /**
   * اجرای رایگان همین‌جا تمام می‌شود.
   *
   * عمداً *بعد* از رونویسی و *قبل* از تحلیل. سهمیهٔ رایگان یک کار مشخص دارد:
   * کاربر با گوش خودش بسنجد **صوت به متن** چقدر دقیق است — اصطلاح تخصصی درسش،
   * لهجهٔ استادش، کیفیت ضبط گوشی‌اش. اینها را فقط روی صوت خودش می‌شود فهمید.
   *
   * اینکه خروجی تحلیل چه شکلی است سؤال دیگری است و جواب دیگری دارد: تور
   * نمونه در `bot/demo.ts` که یک جلسهٔ واقعیِ از پیش پردازش‌شده را نشان
   * می‌دهد. پس لازم نیست برای *نشان‌دادنِ* تحلیل، تحلیلِ رایگان بدهیم.
   */
  if (inp.mode === "free_trial") {
    updateSession(sessionId, {
      title: "رونوشت جلسه",
      session_date: inp.sessionDate,
      status: "done",
      finished_at: new Date().toISOString(),
    });
    logger.info({ sessionId, skippedMs }, "free transcript done");
    return {
      report: null,
      notesMarkdown: "",
      pdfPath: null,
      pdfName: null,
      transcriptPath,
    transcriptPdfPath,
    transcriptSrtPath,
      transcriptText,
      originalDurationMs: pre.originalDurationMs,
      skippedMs,
      billedDurationMs: pre.billedDurationMs,
      savedMs: pre.savedMs,
      costUsd: 0,
      qualityWarnings: pre.quality.warnings,
      preprocessSteps: pre.steps,
      notesError: null,
    };
  }

  // ── ۳) تحلیل ────────────────────────────────────────────────────────────
  setStatus(sessionId, "analyze");
  inp.onProgress({ stage: "analyze" });

  const speakerSummary = built.speakers
    .map((s) => `${s.role === "نامشخص" ? `گوینده ${s.speakerId}` : s.role} (${fmtDuration(s.speechMs)})`)
    .join("، ");

  /**
   * وقتی نقش‌ها معلوم نشد، **هم به مدل بگو هم به کاربر**.
   *
   * `transcript.ts` عمداً نقش نمی‌دهد وقتی هیچ‌کس غالب نیست. ولی سکوت کافی
   * نیست: مدل با دیدن «گوینده ۱» و «گوینده ۲» ممکن است باز هم خودش حدس
   * بزند کدام استاد است و همان وارونگی را از راه دیگری بسازد. پس صریح
   * ممنوع می‌شود.
   */
  const rolesUnknown = built.speakers.length > 1 && built.speakers.every((s) => s.role === "نامشخص");
  const speakerNote = rolesUnknown
    ? `${speakerSummary} — ⚠️ نقش گوینده‌ها مشخص نیست: حرف بین چند نفر تقسیم شده و هیچ‌کدام غالب نبوده. ` +
      `هیچ‌کدام را «استاد» یا «دانشجو» ننام و در خروجی هم با همان «گوینده ۱/۲» به آنها اشاره کن.`
    : speakerSummary;

  const qualityNote =
    pre.quality.level === "good"
      ? "خوب"
      : `${pre.quality.level === "fair" ? "متوسط" : "ضعیف"} — ${pre.quality.warnings.join(" ") || "بدون جزئیات"}` +
        (built.lowConfidenceRatio > 0.15
          ? ` حدود ${Math.round(built.lowConfidenceRatio * 100)}٪ از کلمات با اطمینان پایین تشخیص داده شده‌اند.`
          : "");

  const meta: SessionMeta = {
    courseName: inp.course?.name ?? null,
    professorName: inp.course?.professor ?? null,
    sessionDate: inp.sessionDate,
    originalDurationMs: pre.originalDurationMs,
    silenceMs: Math.max(0, pre.originalDurationMs - pre.billedDurationMs),
    speakerSummary: speakerNote,
    qualityNote,
  };

  const analysis = await analyzeClass(built, meta, { skipNotes: !inp.makePdf });

  updateSession(sessionId, {
    title: analysis.report.session_title,
    session_date: inp.sessionDate,
    report_json: JSON.stringify(analysis.report),
    notes_md: analysis.notesMarkdown || null,
    cost_usd: analysis.usage.estimatedUsd,
  });

  // بانک اصطلاحات درس را برای جلسهٔ بعد غنی کن
  if (inp.course) {
    const newTerms = [
      ...analysis.report.topics.flatMap((t) => t.terms),
      ...analysis.report.glossary.flatMap((g) => [g.term, g.english].filter((x): x is string => !!x)),
    ];
    mergeCourseTerms(inp.course.id, newTerms);
  }

  // ── ۴) جزوهٔ PDF ────────────────────────────────────────────────────────
  let pdfPath: string | null = null;
  let pdfName: string | null = null;
  if (inp.makePdf && analysis.notesMarkdown) {
    setStatus(sessionId, "pdf");
    inp.onProgress({ stage: "pdf" });
    pdfPath = path.join(config.outDir, `${sessionId}.pdf`);
    await renderPdf(
      {
        courseName: inp.course?.name ?? null,
        professorName: inp.course?.professor ?? null,
        sessionDate: inp.sessionDate,
        sessionTitle: analysis.report.session_title,
        durationMs: pre.originalDurationMs,
        report: analysis.report,
        notesMarkdown: analysis.notesMarkdown,
        generatedAt: new Date(),
      },
      pdfPath,
    );
    pdfName = pdfFileName(inp.course?.name ?? null, analysis.report.session_title);
    updateSession(sessionId, { pdf_path: pdfPath });
  }

  updateSession(sessionId, { status: "done", finished_at: new Date().toISOString() });
  logger.info({ sessionId, costUsd: analysis.usage.estimatedUsd.toFixed(3) }, "pipeline done");

  return {
    report: analysis.report,
    notesMarkdown: analysis.notesMarkdown,
    pdfPath,
    pdfName,
    transcriptPath,
    transcriptPdfPath,
    transcriptSrtPath,
    transcriptText,
    originalDurationMs: pre.originalDurationMs,
    skippedMs,
    billedDurationMs: pre.billedDurationMs,
    savedMs: pre.savedMs,
    costUsd: analysis.usage.estimatedUsd,
    /**
     * هشدارِ نقشِ نامعلوم **جلوتر از** هشدارهای کیفیت می‌آید، چون گزارش فقط
     * اولین مورد را به کاربر نشان می‌دهد و این یکی مهم‌تر از نویزِ ضبط است.
     */
    qualityWarnings: rolesUnknown
      ? [
          "نتونستم مطمئن بشم کدوم گوینده استاده — حرف‌ها بین چند نفر تقسیم شده بود، پس به‌جای «استاد» نوشتم «گوینده ۱» و «گوینده ۲».",
          ...pre.quality.warnings,
        ]
      : pre.quality.warnings,
    preprocessSteps: pre.steps,
    notesError: analysis.notesError,
  };
}

export { TimeMap, getCourse };
