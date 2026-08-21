import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { fmtDuration } from "./util/time.js";
import { preprocess } from "./audio/preprocess.js";
import { TimeMap } from "./audio/ffmpeg.js";
import { transcribe } from "./stt/soniox.js";
import { lookup as cacheLookup, store as cacheStore, type CachedTranscript } from "./stt/cache.js";
import { buildTranscript, renderPlain } from "./stt/transcript.js";
import { analyzeClass, type SessionMeta } from "./analysis/analyze.js";
import { renderPdf, pdfFileName } from "./pdf/render.js";
import type { AnalysisReport } from "./analysis/schema.js";
import {
  courseTerms, getCourse, mergeCourseTerms, updateSession,
  type CourseRow, type SessionStatus,
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
  onProgress: (s: Stage) => void;
  signal?: AbortSignal;
}

export interface PipelineOutput {
  report: AnalysisReport;
  notesMarkdown: string;
  pdfPath: string | null;
  pdfName: string | null;
  transcriptPath: string;
  originalDurationMs: number;
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

  // اگر عین همین فایل قبلاً رونویسی شده، دوباره پول نمی‌دهیم
  const cached = await cacheLookup(inp.audioFile);
  let stt: CachedTranscript;

  if (cached) {
    stt = cached;
    inp.onProgress({ stage: "stt", detail: "از کش خوانده شد — هزینه‌ای نداشت" });
  } else {
    const fresh = await transcribe({
      filePath: pre.processedFile,
      languageHints: ["fa", "en"],
      context: { text: contextText, ...(terms.length ? { terms } : {}) },
      clientReferenceId: sessionId,
      onStatus: (s) => inp.onProgress({ stage: "stt", detail: s }),
      ...(inp.signal ? { signal: inp.signal } : {}),
    });
    await cacheStore(inp.audioFile, fresh.raw, {
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

  // فایل پردازش‌شده دیگر لازم نیست — فقط فایل اصلی برای کلیپ‌ها می‌ماند
  // فقط وقتی ترنسکد شده باشد فایل موقتی وجود دارد. اگر ترنسکد نشده،
  // processedFile خودِ فایل اصلی کاربر است و پاک‌کردنش یعنی از دست دادن
  // مرجع نقل‌قول‌ها و کلیپ‌ها.
  if (pre.transcoded) await fs.unlink(pre.processedFile).catch(() => {});

  // ── ۳) تحلیل ────────────────────────────────────────────────────────────
  setStatus(sessionId, "analyze");
  inp.onProgress({ stage: "analyze" });

  const speakerSummary = built.speakers
    .map((s) => `${s.role === "نامشخص" ? `گوینده ${s.speakerId}` : s.role} (${fmtDuration(s.speechMs)})`)
    .join("، ");

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
    speakerSummary,
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
    originalDurationMs: pre.originalDurationMs,
    billedDurationMs: pre.billedDurationMs,
    savedMs: pre.savedMs,
    costUsd: analysis.usage.estimatedUsd,
    qualityWarnings: pre.quality.warnings,
    preprocessSteps: pre.steps,
    notesError: analysis.notesError,
  };
}

export { TimeMap, getCourse };
