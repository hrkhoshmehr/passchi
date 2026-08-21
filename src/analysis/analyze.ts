import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { fmtClock, fmtDuration, pct } from "../util/time.js";
import type { BuiltTranscript } from "../stt/transcript.js";
import { anchorTopics, renderForModel, verifyQuote } from "../stt/transcript.js";
import {
  ClassAnalysis,
  type AnalysisReport,
  type Evidence,
  type SegmentKind,
  type TimelineStats,
  type VerifiedEvidence,
} from "./schema.js";
import { SYSTEM_COMMON, TASK_ANALYSIS, TASK_NOTES, transcriptBlock } from "./prompts.js";
import { chat as orChat, extractJson } from "./openrouter.js";
import { isDegenerate, repairAnalysis } from "./repair.js";

const client = new Anthropic({
  ...(config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : {}),
  timeout: 25 * 60_000,
  maxRetries: 3,
});

export interface SessionMeta {
  courseName?: string | null;
  professorName?: string | null;
  sessionDate?: string | null;
  originalDurationMs: number;
  silenceMs: number;
  speakerSummary: string;
  qualityNote: string;
}

export interface AnalyzeOutput {
  report: AnalysisReport;
  notesMarkdown: string;
  /**
   * اگر ساخت جزوه شکست خورده باشد، دلیلش اینجاست و `notesMarkdown` خالی است.
   * تحلیل از بین نمی‌رود: پاس اول گران‌ترین و ارزشمندترین بخش کار است و
   * نباید به‌خاطر در دسترس نبودن مدلِ پاس دوم دور ریخته شود.
   */
  notesError: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    estimatedUsd: number;
  };
}

function metaLines(m: SessionMeta): string {
  return [
    `درس: ${m.courseName ?? "نامشخص"}`,
    `استاد: ${m.professorName ?? "نامشخص"}`,
    `تاریخ: ${m.sessionDate ?? "نامشخص"}`,
    `مدت صوت اصلی: ${fmtDuration(m.originalDurationMs)} (${m.originalDurationMs} میلی‌ثانیه)`,
    `سکوت اندازه‌گیری‌شده: ${fmtDuration(m.silenceMs)}`,
    `گوینده‌ها: ${m.speakerSummary}`,
    `کیفیت ضبط: ${m.qualityNote}`,
  ].join("\n");
}

/** قیمت‌های Claude Opus 5 و Sonnet 5 برای برآورد هزینه (دلار بر یک میلیون توکن). */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function costOf(model: string, u: Anthropic.Usage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5"]!;
  const inTok = u.input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const outTok = u.output_tokens ?? 0;
  return (
    (inTok * p.in + cacheWrite * p.in * 1.25 + cacheRead * p.in * 0.1 + outTok * p.out) / 1_000_000
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function verifyEvidence(t: BuiltTranscript, e: Evidence | null): VerifiedEvidence | null {
  if (!e) return null;
  const m = verifyQuote(t, e.quote, e.at_ms);
  return {
    quote: e.quote,
    at_ms: m.ok ? m.atMs : e.at_ms,
    speaker: m.ok && m.role !== "نامشخص" ? m.role : e.speaker,
    verified: m.ok,
    score: Math.round(m.score * 100) / 100,
  };
}

function computeComposition(
  timeline: ClassAnalysis["timeline"],
  originalDurationMs: number,
  silenceMs: number,
): TimelineStats[] {
  const byKind = new Map<SegmentKind, number>();
  let total = 0;
  for (const s of timeline) {
    const ms = Math.max(0, Math.min(s.end_ms, originalDurationMs) - Math.max(0, s.start_ms));
    if (ms <= 0) continue;
    byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + ms);
    total += ms;
  }

  // سکوت اندازه‌گیری‌شده است (ffmpeg)؛ تقسیمِ باقی‌ماندهْ مدل‌شده است.
  const speechMs = Math.max(0, originalDurationMs - silenceMs);
  const rows: TimelineStats[] = [];
  if (total > 0) {
    for (const [kind, ms] of byKind) {
      const scaled = (ms / total) * speechMs;
      rows.push({ kind, ms: Math.round(scaled), pct: pct(scaled, originalDurationMs) });
    }
  }
  rows.sort((a, b) => b.ms - a.ms);
  if (silenceMs > 0) {
    rows.push({ kind: "break", ms: silenceMs, pct: pct(silenceMs, originalDurationMs) });
  }
  return rows;
}

/**
 * زمان‌های بیرون از مدت صوت را اصلاح می‌کند.
 *
 * مدل گاهی زمانی می‌سازد که در فایل وجود ندارد — روی یک صوت ۵۰ دقیقه‌ای
 * سرفصلی با شروع ۷۱ دقیقه دیده شد. چنین زمانی فقط عدد غلط نیست: کاربر
 * رویش می‌زند و صوت جایی نمی‌رود، و کل قرارداد «ذکر منبع» زیر سؤال می‌رود.
 * سرفصلی که شروعش بیرون از فایل است حذف می‌شود، بقیه به بازهٔ معتبر می‌آیند.
 */
function clampTimes(a: ClassAnalysis, durationMs: number): ClassAnalysis {
  const clamp = (ms: number) => Math.min(Math.max(0, Math.round(ms)), durationMs);
  return {
    ...a,
    timeline: a.timeline
      .map((s) => ({ ...s, start_ms: clamp(s.start_ms), end_ms: clamp(s.end_ms) }))
      .filter((s) => s.end_ms > s.start_ms),
    topics: a.topics
      .filter((t) => t.start_ms < durationMs)
      .map((t) => ({ ...t, start_ms: clamp(t.start_ms), end_ms: clamp(t.end_ms) })),
    key_points: a.key_points.map((k) => ({
      ...k,
      evidence: { ...k.evidence, at_ms: clamp(k.evidence.at_ms) },
    })),
    professor_actions: a.professor_actions.map((p) => ({
      ...p,
      evidence: p.evidence ? { ...p.evidence, at_ms: clamp(p.evidence.at_ms) } : null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeClass(
  transcript: BuiltTranscript,
  meta: SessionMeta,
  opts: { skipNotes?: boolean } = {},
): Promise<AnalyzeOutput> {
  const rendered = renderForModel(transcript);
  const transcriptText = transcriptBlock(metaLines(meta), rendered);
  // این بلوک باید در هر دو پاس بایت‌به‌بایت یکسان بماند تا کش بخورد
  const cachedBlock: Anthropic.TextBlockParam = {
    type: "text",
    text: transcriptText,
    cache_control: { type: "ephemeral", ttl: "1h" },
  };

  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: SYSTEM_COMMON }];

  logger.info(
    {
      chars: rendered.length,
      utterances: transcript.utterances.length,
      provider: config.ANALYSIS_PROVIDER,
    },
    "analysis pass 1",
  );

  let parsed: ClassAnalysis;
  let usage1: Anthropic.Usage;
  let openRouterUsd = 0;

  if (config.ANALYSIS_PROVIDER === "openrouter") {
    const format = zodOutputFormat(ClassAnalysis);
    const res = await orChat(
      [
        { role: "system", content: SYSTEM_COMMON },
        { role: "user", content: `${transcriptText}\n\n${TASK_ANALYSIS}` },
      ],
      {
        model: config.OPENROUTER_ANALYSIS_MODEL || config.OPENROUTER_MODEL,
        maxTokens: 32_000,
        jsonSchema: format.schema,
        schemaName: "class_analysis",
      },
    );
    // مدل‌های رایگان response_format را جدی نمی‌گیرند: کلیدهای nullable را
    // حذف می‌کنند و گاهی آرایهٔ رشته را آرایهٔ آبجکت می‌دهند. اول ترمیم،
    // بعد اعتبارسنجی — تا خطای شکلی کل کار را نیندازد.
    const repaired = repairAnalysis(extractJson(res.text));
    const degenerate = isDegenerate(repaired);
    if (degenerate) {
      throw new Error(
        `تحلیل قابل استفاده نبود: ${degenerate}. مدل ${res.model} برای این کار ضعیف است.`,
      );
    }
    parsed = ClassAnalysis.parse(repaired);
    usage1 = fakeUsage(res.inputTokens, res.outputTokens);
    openRouterUsd += res.costUsd;
  } else {
    const pass1 = await client.messages.parse({
      model: config.ANALYSIS_MODEL,
      max_tokens: 32_000,
      system,
      thinking: { type: "adaptive" },
      output_config: {
        effort: config.ANALYSIS_EFFORT,
        format: zodOutputFormat(ClassAnalysis),
      },
      messages: [{ role: "user", content: [cachedBlock, { type: "text", text: TASK_ANALYSIS }] }],
    });
    if (!pass1.parsed_output) throw new Error("تحلیل ساختاریافته برنگشت — خروجی مدل با اسکیما نخواند.");
    parsed = pass1.parsed_output;
    usage1 = pass1.usage;
  }

  // زمان‌های بیرون از فایل پیش از هر کار دیگری اصلاح می‌شوند
  parsed = clampTimes(parsed, meta.originalDurationMs);

  // زمان سرفصل‌ها از رونوشت گرفته می‌شود، نه از حدس مدل — همان قاعده‌ای که
  // برای نقل‌قول‌ها به کار می‌رود، چون هر دو به کاربر به‌عنوان «منبع» نشان
  // داده می‌شوند و باید واقعاً روی صوت بیفتند.
  const topicAnchors = anchorTopics(transcript, parsed.topics, meta.originalDurationMs);
  parsed = {
    ...parsed,
    topics: parsed.topics.map((t, i) => ({ ...t, start_ms: topicAnchors[i] ?? t.start_ms })),
  };

  // ── راستی‌آزمایی نقل‌قول‌ها ────────────────────────────────────────────
  let dropped = 0;
  const keyPoints: AnalysisReport["key_points"] = [];
  for (const kp of parsed.key_points) {
    const ev = verifyEvidence(transcript, kp.evidence);
    if (!ev || !ev.verified) {
      dropped++;
      logger.debug({ title: kp.title, score: ev?.score }, "نقل‌قول تأیید نشد — نکته حذف شد");
      continue; // بدون منبعِ تأییدشده، نکته نمایش داده نمی‌شود
    }
    keyPoints.push({ ...kp, evidence: ev });
  }

  const professorActions = parsed.professor_actions.map((a) => {
    const ev = verifyEvidence(transcript, a.evidence);
    if (a.happened && (!ev || !ev.verified)) {
      dropped++;
      // ادعای «انجام شد» بدون شاهد تأییدشده به «نامعلوم» تنزل می‌کند
      return { ...a, happened: false, detail: `${a.detail} (شاهد تأیید نشد)`, evidence: null };
    }
    return { ...a, evidence: ev };
  });

  const report: AnalysisReport = {
    ...parsed,
    key_points: keyPoints,
    professor_actions: professorActions,
    composition: computeComposition(parsed.timeline, meta.originalDurationMs, meta.silenceMs),
    silenceMs: meta.silenceMs,
    droppedCitations: dropped,
  };

  let notesMarkdown = "";
  let notesError: string | null = null;
  let usage2: Anthropic.Usage | null = null;

  if (!opts.skipNotes) {
   try {
    const skeleton = `### تحلیل ساختاریافتهٔ همین جلسه\n\n\`\`\`json\n${JSON.stringify(
      {
        topics: parsed.topics,
        key_points: parsed.key_points,
        glossary: parsed.glossary,
        open_questions: parsed.open_questions,
      },
      null,
      1,
    )}\n\`\`\``;

    logger.info({ provider: config.NOTES_PROVIDER }, "analysis pass 2 (جزوه)");

    if (config.NOTES_PROVIDER === "openrouter") {
      // اینجا کشی در کار نیست: رونوشت کامل دوباره فرستاده می‌شود.
      const res = await orChat(
        [
          { role: "system", content: SYSTEM_COMMON },
          { role: "user", content: `${transcriptText}\n\n${TASK_NOTES}\n\n${skeleton}` },
        ],
        { model: config.OPENROUTER_NOTES_MODEL || config.OPENROUTER_MODEL, maxTokens: 32_000 },
      );
      notesMarkdown = stripFence(res.text);
      usage2 = fakeUsage(res.inputTokens, res.outputTokens);
      openRouterUsd += res.costUsd;
    } else {
      // بلوک کش‌شده و system عیناً تکرار می‌شوند → رونوشت دوباره هزینه نمی‌شود
      const stream = client.messages.stream({
        model: config.NOTES_MODEL,
        max_tokens: 64_000,
        system,
        thinking: { type: "adaptive" },
        output_config: { effort: config.ANALYSIS_EFFORT },
        messages: [
          {
            role: "user",
            content: [
              cachedBlock,
              { type: "text", text: TASK_NOTES },
              { type: "text", text: skeleton },
            ],
          },
        ],
      });
      const final = await stream.finalMessage();
      usage2 = final.usage;
      notesMarkdown = final.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    }
   } catch (e) {
      // پاس اول تمام شده و گزارش آماده است. اگر مدلِ جزوه در دسترس نبود،
      // همان گزارش تحویل داده می‌شود؛ دور ریختنش یعنی دور ریختن گران‌ترین بخش کار.
      notesError = e instanceof Error ? e.message : String(e);
      logger.warn({ err: notesError }, "ساخت جزوه شکست خورد — تحلیل حفظ شد");
   }
  }

  logger.info(
    {
      pass1Cache: { write: usage1.cache_creation_input_tokens, read: usage1.cache_read_input_tokens },
      pass2Cache: usage2
        ? { write: usage2.cache_creation_input_tokens, read: usage2.cache_read_input_tokens }
        : null,
      dropped,
    },
    "analysis done",
  );

  const analysisCost = config.ANALYSIS_PROVIDER === "openrouter" ? 0 : costOf(config.ANALYSIS_MODEL, usage1);
  const notesCost =
    !usage2 || config.NOTES_PROVIDER === "openrouter" ? 0 : costOf(config.NOTES_MODEL, usage2);

  return {
    report,
    notesMarkdown,
    notesError,
    usage: {
      inputTokens: (usage1.input_tokens ?? 0) + (usage2?.input_tokens ?? 0),
      outputTokens: (usage1.output_tokens ?? 0) + (usage2?.output_tokens ?? 0),
      cacheWriteTokens:
        (usage1.cache_creation_input_tokens ?? 0) + (usage2?.cache_creation_input_tokens ?? 0),
      cacheReadTokens: (usage1.cache_read_input_tokens ?? 0) + (usage2?.cache_read_input_tokens ?? 0),
      estimatedUsd: analysisCost + notesCost + openRouterUsd,
    },
  };
}

/** مدل‌های رایگان گاهی کل جزوه را داخل بلوک کد می‌گذارند. */
function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  return (m?.[1] ?? t).trim();
}

/** شکل Usage آنتروپیک، پر شده از شمارش OpenRouter — تا بقیهٔ کد یک مسیر بماند. */
function fakeUsage(inputTokens: number, outputTokens: number): Anthropic.Usage {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  } as Anthropic.Usage;
}

export { fmtClock };
