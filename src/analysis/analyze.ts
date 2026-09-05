import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { fmtClock, fmtDuration, pct } from "../util/time.js";
import type { BuiltTranscript } from "../stt/transcript.js";
import { anchorTopics, renderForModel, verifyQuote } from "../stt/transcript.js";
import { normalizeFa } from "../util/text.js";
import {
  ClassAnalysis,
  type AnalysisReport,
  type Evidence,
  type SegmentKind,
  type TimelineStats,
  type VerifiedEvidence,
} from "./schema.js";
import { SYSTEM_COMMON, TASK_ANALYSIS, TASK_NOTES, transcriptBlock } from "./prompts.js";
import { cached, chat as orChat, extractJson } from "./openrouter.js";
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
    /**
     * نقل‌قولِ نمایش‌داده‌شده همان چیزی است که **تأیید شد**، نه لزوماً آنچه
     * مدل نوشت. فرقشان وقتی است که مدل چند خط را با «…» به هم دوخته باشد؛
     * آن‌وقت فقط تکهٔ تأییدشده می‌ماند. نشان‌دادنِ متنِ تأییدنشده در جای «عین
     * حرف استاد» دقیقاً همان چیزی است که این دروازه برای جلوگیری از آن هست.
     */
    quote: m.ok ? m.matchedQuote : e.quote,
    at_ms: m.ok ? m.atMs : e.at_ms,
    speaker: m.ok && m.role !== "نامشخص" ? m.role : e.speaker,
    verified: m.ok,
    score: Math.round(m.score * 100) / 100,
  };
}

/**
 * نشانه‌های زبانیِ «استاد گفت این مهم است».
 *
 * فهرست عمداً از عبارت‌های *صریح* ساخته شده، نه هر کلمه‌ای که بوی اهمیت
 * می‌دهد. با `normalizeFa` مقایسه می‌شود، پس نیم‌فاصله و «ي» عربی و اعراب
 * مانعش نمی‌شوند.
 */
const IMPORTANCE_MARKERS = [
  "امتحان", "میان ترم", "میانترم", "پایان ترم", "پایانترم", "کوییز", "نمره", "سوال میاد",
  "مهم", "اهمیت", "حتما", "یاد بگیر", "یادبگیر", "بلد باش", "حفظ کن", "دقت کن",
  "توجه کن", "یادداشت کن", "تاکید", "فراموش نکن", "کلیدی", "اساسی", "جدی بگیر",
  // دستهٔ دوم: جمله‌هایی که اهمیت را می‌رسانند بدون آنکه کلمهٔ «مهم» را
  // داشته باشند — «سر جلسه ازتون می‌پرسم»، «قطعاً میاد»، «علامت بزنید».
  // بی این‌ها دروازه نکته‌های درست را هم می‌انداخت.
  "میپرسم", "بپرسم", "لازم", "قطعا", "صددرصد", "علامت بزن", "خط بکش", "تمرکز", "بارم",
  // «هر ترم سؤال می‌دم» پیش‌بینی‌کننده‌ترین جملهٔ ممکن است و می‌افتاد، چون
  // فقط صورتِ «سوال میاد» در فهرست بود. صرف‌های فعلی هم باید بیایند.
  "سوال میدم", "سوال بدم", "سوال میارم", "میارم تو امتحان", "امتحانی",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

/**
 * پایانه‌هایی که کلمه را عوض نمی‌کنند، فقط صرفش می‌کنند.
 *
 * لازم است چون نشانه‌ها ریشه‌اند نه شکلِ کامل: «یاد بگیر» باید «یاد بگیرید» را
 * بگیرد و «مهم» باید «مهمه» و «مهم‌ترین» را. ولی «ان» عمداً **نیست** — با آن،
 * «مهمان» هم نشانهٔ اهمیت حساب می‌شد.
 */
const INFLECTIONS = [
  "", "ه", "ی", "یی", "تر", "ترین", "ید", "ند", "یم", "م", "د", "ت", "ها", "های",
  // ضمیرهای ملکیِ چسبان — «بارمش بالاست»، «تمرکزتون رو بذارید». بدون این‌ها
  // نشانه فقط شکلِ خشکِ کلمه را می‌گرفت، در حالی که استاد محاوره حرف می‌زند.
  "ش", "تون", "شون", "مون", "تان", "شان",
  // رابطهٔ محاوره‌ای: «۸ نمره‌ست»، «لازمست». بی این، بارم‌بندی صریح هم رد می‌شد.
  "ست",
];

/** نفیِ بلافاصله‌ای که ادعا را وارونه می‌کند: «این اصلا مهم نیست». */
const NEGATIONS = new Set(["نیست", "نیستش", "نیستند", "نبود", "نداره", "ندارد", "نه", "نمیاد"]);

function isNegation(token: string | undefined): boolean {
  return token !== undefined && (NEGATIONS.has(token) || token.startsWith("نمی"));
}

/** آیا توکنِ متن، همان نشانه است یا صرفِ آن؟ */
function matchesMarkerToken(word: string, marker: string): boolean {
  if (!word.startsWith(marker)) return false;
  const tail = word.slice(marker.length);
  return INFLECTIONS.includes(tail);
}

/**
 * نکته‌ای که مدل `emphasis` زده ولی محتوایش دربارهٔ نمره یا ترتیب کلاس است.
 *
 * مدل نوع را از **لحن** انتخاب می‌کند نه از محتوا: «کتاب قانون رو حتماً سر
 * جلسه داشته باشید» را چون «حتماً» دارد `emphasis` می‌زند، در حالی که این
 * یک وظیفهٔ عملی است نه یک مبحث درسی. دو بار پرامپت را صریح‌تر کردیم و باز
 * همین شد، پس تصمیم به کد آمد.
 *
 * چرا مهم است: دانشجو در فهرست دنبال «چه کاری باید بکنم» می‌گردد و برچسب
 * «تأکید استاد» او را به آن نمی‌رساند. برچسبِ درست، پیدا کردنش را آسان
 * می‌کند.
 *
 * ترتیب بررسی اهمیت دارد — تکلیف پیش از همه، چون «این کتاب رو تهیه کنید و
 * تا امتحان بخونید» هر سه نشانه را دارد ولی کاری که دانشجو باید انجام دهد
 * از هر برچسب دیگری کاربردی‌تر است. بعد نمره، بعد ترتیب کلاس.
 */
const HOMEWORK_HINTS = [
  "تهیه کنید", "تهیه بکنید", "تهیه بفرمایید", "بخرید", "بخونید", "بخوانید", "مطالعه کنید",
  "مطالعه بفرمایید", "نگاه بکنید", "نگاه کنید", "حل کنید", "حل بکنید", "تمرین",
  "ترجمه کنید", "تحقیق کنید", "آماده کنید", "بنویسید", "جواب بدید", "جواب بدهید",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

const GRADING_HINTS = [
  "نمره", "بارم", "نمرات", "تصحیح", "مردود", "قبولی", "پاس کردن",
  "تستی", "تشریحی", "کتاب باز",
  // «میان ترم» و «پایان ترم» عمداً **نیستند**: اشارهٔ زمانی‌اند، نه ادعای
  // نمره. با آنها «چون در پایان ترم ممکنه متضرر بشید» برچسبِ «نمره و بارم»
  // می‌گرفت، در حالی که یک کلمه دربارهٔ نمره نمی‌گوید. جمله‌ای که واقعاً
  // دربارهٔ بارمِ میان‌ترم باشد، کلمهٔ «نمره» یا «بارم» را هم دارد.
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

const LOGISTICS_HINTS = [
  "همراه", "بیارید", "بیاورید", "سر جلسه", "سر کلاس", "کلاس بعد", "جلسه بعد",
  "کلاس نداریم", "تشکیل نمیشود", "تشکیل نمی شود", "جبرانی", "لغو", "تعطیل",
  "ساعت کلاس", "سامانه", "ثبت نام", "تحویل بدید", "تحویل بدهید",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

/**
 * تطبیق روی **مرز توکن**، نه زیررشته.
 *
 * نسخهٔ اول `includes` می‌زد و نتیجه‌اش این بود که «چون در پایان ترم ممکنه
 * خودتون متضرر بشید» برچسبِ «نمره و بارم» می‌گرفت — چون «پایان ترم» زیررشتهٔ
 * آن است، در حالی که جمله یک کلمه دربارهٔ نمره نمی‌گوید. همان اشتباهی که یک
 * بار در دروازهٔ اهمیت («مهم» داخل «مهمان») رفع شد و اینجا مانده بود.
 */
function hasHint(words: string[], hints: string[][]): boolean {
  for (const hint of hints) {
    for (let i = 0; i + hint.length <= words.length; i++) {
      let hit = true;
      for (let k = 0; k < hint.length - 1; k++) {
        if (words[i + k] !== hint[k]) { hit = false; break; }
      }
      if (hit && matchesMarkerToken(words[i + hint.length - 1]!, hint[hint.length - 1]!)) return true;
    }
  }
  return false;
}

export function classifyKeyPointKind(
  quote: string,
  title: string,
): "homework" | "grading" | "logistics" | null {
  const words = normalizeFa(`${title} ${quote}`).split(" ").filter(Boolean);
  if (hasHint(words, HOMEWORK_HINTS)) return "homework";
  if (hasHint(words, GRADING_HINTS)) return "grading";
  if (hasHint(words, LOGISTICS_HINTS)) return "logistics";
  return null;
}

/**
 * آیا این نقل‌قول *خودش* ادعای «مهم است» را ثابت می‌کند؟
 *
 * دروازهٔ دوم است، بعد از اینکه ثابت شد جمله واقعاً در صوت گفته شده. مدل
 * می‌تواند جمله‌ای کاملاً واقعی نقل کند و رویش برچسب «تأکید استاد» بزند در
 * حالی که آن جمله فقط ادامهٔ درس بوده — و این بدترین حالت است، چون هم
 * ظاهرِ مستند دارد و هم دانشجو را به‌سمت مطلبی می‌فرستد که استاد هیچ‌وقت
 * مهمش ندانسته. پس ادعای اهمیت باید در خودِ کلمات استاد باشد، نه در تفسیر.
 *
 * ## چرا مقایسه دیگر زیررشته‌ای نیست
 *
 * نسخهٔ اول `includes` می‌زد، پس «مهم» را داخل «مهمان» و «مهمونی» هم پیدا
 * می‌کرد و «این اصلاً مهم نیست» را هم تأیید اهمیت می‌شمرد. هر سه را روی کد
 * واقعی دیدیم. حالا تطبیق روی **مرزِ توکن** است، با پایانه‌های مجاز، و نفیِ
 * بلافاصله ادعا را باطل می‌کند.
 */
export function statesImportance(quote: string): boolean {
  const words = normalizeFa(quote).split(" ").filter(Boolean);
  if (words.length === 0) return false;

  for (const marker of IMPORTANCE_MARKERS) {
    for (let i = 0; i + marker.length <= words.length; i++) {
      // همهٔ توکن‌های نشانه جز آخری باید عین هم باشند؛ آخری می‌تواند صرف شود.
      let hit = true;
      for (let k = 0; k < marker.length - 1; k++) {
        if (words[i + k] !== marker[k]) { hit = false; break; }
      }
      if (!hit) continue;
      const last = i + marker.length - 1;
      if (!matchesMarkerToken(words[last]!, marker[marker.length - 1]!)) continue;
      // «مهم نیست» ادعای اهمیت نیست — دو توکن بعدی را نگاه کن.
      if (isNegation(words[last + 1]) || isNegation(words[last + 2])) continue;
      return true;
    }
  }
  return false;
}

function computeComposition(
  chapters: ClassAnalysis["chapters"],
  originalDurationMs: number,
  silenceMs: number,
): TimelineStats[] {
  const byKind = new Map<SegmentKind, number>();
  let total = 0;
  for (const s of chapters) {
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

/** سقف زیربخش‌های هر بخش — بیشتر از این، فهرستِ بازشده هم خوانده نمی‌شود. */
const MAX_PARTS = 6;

/** n عضو با فاصلهٔ یکنواخت از یک آرایه، شامل اولی و آخری. */
function evenSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = (items.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => items[Math.round(i * step)]!);
}

/**
 * مرزهای بخش‌ها را قابل‌اتکا می‌کند.
 *
 * مرز بخش تنها عددی است که کاربر برای «از کجا گوش بدهم» به آن نگاه می‌کند،
 * ولی همان چیزی است که مدل بیشتر از همه در آن خطا می‌کند: روی یک صوت
 * پنجاه‌دقیقه‌ای، بخش‌هایی دیده شد که شروعشان ۰۰:۲۹ و ۰۱:۳۹ بود در حالی که
 * زیربخش‌هایشان درست روی دقیقهٔ ۷ و ۱۳ می‌افتادند — یعنی مدل مقیاس را برای
 * بخش‌ها اشتباه گرفته بود ولی برای نقطه‌ها نه.
 *
 * پس مرزها بازسازی می‌شوند، نه فقط محدود:
 *
 *   ۱) هر بخشی که زیربخش دارد، دست‌کم تا اولین زیربخشش عقب می‌آید،
 *   ۲) بخش‌ها بر اساس شروع مرتب می‌شوند،
 *   ۳) پایان هر بخش، شروع بخش بعدی است — و آخری تا ته صوت.
 *
 * نتیجه: پوششی پیوسته از صفر تا انتهای فایل، بدون همپوشانی و بدون حفره،
 * حتی وقتی مدل اعداد بی‌ربط داده باشد.
 */
function normalizeChapters(
  chapters: ClassAnalysis["chapters"],
  durationMs: number,
): ClassAnalysis["chapters"] {
  const clamp = (ms: number) => Math.min(Math.max(0, Math.round(ms)), durationMs);

  const rows = chapters
    .map((c) => {
      const parts = c.parts
        .filter((p) => p.at_ms < durationMs && p.label.trim())
        .map((p) => ({ ...p, at_ms: clamp(p.at_ms) }))
        .sort((x, y) => x.at_ms - y.at_ms);
      // مدل سقف تعداد زیربخش را جدی نمی‌گیرد — روی یک جلسه شانزده‌تا داد. با
      // نمونه‌گیری یکنواخت بریده می‌شود تا آخرِ بخش هم پوشش خودش را نگه دارد.
      const trimmed = evenSample(parts, MAX_PARTS);
      const firstPart = trimmed[0]?.at_ms;
      const start = firstPart === undefined ? clamp(c.start_ms) : Math.min(clamp(c.start_ms), firstPart);
      return { ...c, start_ms: start, end_ms: clamp(c.end_ms), parts: trimmed };
    })
    .filter((c) => c.title.trim() || c.parts.length)
    .sort((a, b) => a.start_ms - b.start_ms);

  if (rows.length === 0) return [];

  rows[0]!.start_ms = 0;
  for (let i = 0; i < rows.length; i++) {
    rows[i]!.end_ms = i + 1 < rows.length ? rows[i + 1]!.start_ms : durationMs;
  }
  // بخشی که پس از پیوسته‌سازی طولش صفر شد، دو بخش با شروع یکسان بوده‌اند
  const out = rows.filter((c) => c.end_ms > c.start_ms);
  warnIfCompressed(out, durationMs);
  return out;
}

/**
 * هشدار وقتی مدل زمان‌ها را حدس زده، نه از رونوشت برداشته.
 *
 * نشانه‌اش این است که همهٔ نقطه‌های اعلام‌شده در ابتدای صوت جمع شده‌اند و
 * بخش آخر بی‌قواره دراز است. این حالت را روی یک کلاس ۹۴ دقیقه‌ای دیدیم:
 * تمام رویدادها زیر ده دقیقه بودند و بخش پایانی ۸۶ دقیقه شد.
 *
 * موذی بودنش از این است که `normalizeChapters` بخش آخر را تا ته صوت کش
 * می‌دهد، پس خروجی *سالم به نظر می‌رسد* — پوشش کامل است و هیچ حفره‌ای
 * نیست — در حالی که همهٔ زمان‌ها غلط‌اند.
 *
 * اینجا فقط لاگ می‌شود و چیزی حذف نمی‌شود: زمان‌های تقریبی هنوز از هیچ
 * بهترند، ولی باید در لاگ دیده شوند تا اگر مدل یا پرامپت پس رفت بفهمیم.
 */
function warnIfCompressed(chapters: ClassAnalysis["chapters"], durationMs: number): void {
  if (durationMs <= 0) return;

  /**
   * **کم‌بودنِ تعداد بخش هم یک شکست است، نه فقط فشردگی.**
   *
   * اسکیما چهار تا شش بخش می‌خواهد، ولی هیچ‌جا کف نداشت. روی همان کلاس ۹۴
   * دقیقه‌ای یک اجرا **دو** بخش داد — بخش دومش ۷۹ دقیقه — و چون پوشش کامل
   * بود و حفره نداشت، از هیچ بررسی‌ای رد نمی‌شد. برای کاربری که می‌خواهد
   * فقط بیست دقیقهٔ خاصی را گوش بدهد، «بخشی به طول ۷۹ دقیقه» یعنی همان
   * نداشتنِ بخش‌بندی.
   *
   * اینجا هم فقط لاگ می‌شود: بخش‌بندیِ درشت از نبودنش بهتر است، ولی باید
   * دیده شود. دمای پایین و ترتیب تازهٔ اسکیما این را روی صفر از هشت آوردند؛
   * این خط همان است که می‌گوید اگر برگشت.
   */
  const MIN_CHAPTERS = 3;
  if (chapters.length > 0 && chapters.length < MIN_CHAPTERS && durationMs > 20 * 60_000) {
    logger.warn(
      { chapters: chapters.length, durationMs },
      "بخش‌های خیلی کم برای این مدت — بخش‌بندی عملاً بی‌فایده است",
    );
  }

  if (chapters.length < 2) return;
  const lastStart = chapters[chapters.length - 1]!.start_ms;
  const covered = lastStart / durationMs;
  // شروعِ بخش آخر زیر ۲۵٪ مدت یعنی همهٔ مرزها در ابتدای فایل فشرده شده‌اند
  if (covered < 0.25) {
    logger.warn(
      { chapters: chapters.length, lastStartMs: lastStart, durationMs, coveredPct: Math.round(covered * 100) },
      "زمان‌بندی بخش‌ها در ابتدای صوت فشرده شده — احتمالاً مدل زمان‌ها را حدس زده",
    );
  }
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
    chapters: normalizeChapters(a.chapters, durationMs),
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
        // رونوشت بلوکِ کش‌شونده است و در هر دو پاس عیناً یکسان می‌رود؛ دستور
        // که کوتاه است **بعد** از آن می‌آید تا مرزِ کش را نشکند.
        { role: "user", content: [cached(transcriptText), { type: "text", text: TASK_ANALYSIS }] },
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
  /**
   * سه شمارنده، نه یکی.
   *
   * پیش‌تر هر سه علتِ حذف یک عدد را بالا می‌بردند، و نتیجه‌اش این بود که
   * وقتی روی دادهٔ واقعی پرسیدیم «کدام دروازه دارد نکته‌ها را می‌کشد؟»
   * جوابی نداشتیم و مجبور شدیم حدس بزنیم. تفکیک، ابزارِ تصمیمِ بعدی است.
   */
  let droppedUnverified = 0;
  let droppedImportance = 0;
  let demotedActions = 0;
  const keyPoints: AnalysisReport["key_points"] = [];
  for (const kp of parsed.key_points) {
    const ev = verifyEvidence(transcript, kp.evidence);
    if (!ev || !ev.verified) {
      droppedUnverified++;
      logger.debug({ title: kp.title, score: ev?.score }, "نقل‌قول تأیید نشد — نکته حذف شد");
      continue; // بدون منبعِ تأییدشده، نکته نمایش داده نمی‌شود
    }
    /**
     * دروازهٔ تأکید فقط برای `exam` و `emphasis` است، و عمداً.
     *
     * آن دو یک **ادعای تفسیری** دارند: «استاد این را مهم دانست». چنین ادعایی
     * باید در خودِ کلمات استاد ثابت شود، وگرنه مدل هر جمله‌ای را «تأکید»
     * برچسب می‌زند.
     *
     * ولی `grading`، `logistics`، `homework` و `deadline` ادعای تفسیری
     * ندارند؛ **گزارش واقعیت‌اند**. «امتحان ۱۲ نمره است» یا «جلسهٔ بعد کلاس
     * نداریم» با کلمهٔ «مهم» گفته نمی‌شوند و اگر این دروازه رویشان اعمال شود،
     * دقیقاً همان چیزهایی حذف می‌شوند که دانشجوی غایب بیشتر از همه می‌خواهد.
     * برای آنها همان دروازهٔ اول — «جمله واقعاً گفته شده» — کافی است.
     */
    /**
     * تصحیح نوع بر پایهٔ محتوا — **پیش از** دروازه، و این ترتیب عمدی است.
     *
     * قبلاً بعد از دروازه بود، با این استدلال که «نکته نتواند با تغییر
     * برچسب از دروازه فرار کند». ولی استدلال وارونه بود: نکته‌ای که واقعاً
     * تکلیف است **باید** فرار کند، چون اصلاً ادعای تأکید نمی‌کند. دروازه
     * برای محافظت از ادعای «استاد گفت مهم است» ساخته شده؛ وقتی برچسب عوض
     * شد، آن ادعا دیگر در کار نیست.
     *
     * بهای ترتیب قبلی روی دادهٔ واقعی دیده شد: «کتاب رو تهیه بکنید و به
     * تدریج بخونید» نشانهٔ اهمیت ندارد، پس سرِ دروازه کشته می‌شد و هرگز به
     * تصحیح نمی‌رسید — و چک‌لیست به دانشجو می‌گفت «تکلیفی نداد».
     */
    const fixed = kp.kind === "emphasis" ? (classifyKeyPointKind(ev.quote, kp.title) ?? kp.kind) : kp.kind;
    if (fixed !== kp.kind) {
      logger.debug({ title: kp.title, from: kp.kind, to: fixed }, "نوع نکته بر پایهٔ محتوا تصحیح شد");
    }
    if ((fixed === "exam" || fixed === "emphasis") && !statesImportance(ev.quote)) {
      droppedImportance++;
      logger.debug({ title: kp.title, quote: kp.evidence.quote }, "نقل‌قول ادعای تأکید را ثابت نمی‌کند");
      continue;
    }
    keyPoints.push({ ...kp, kind: fixed, evidence: ev });
  }

  const professorActions = parsed.professor_actions.map((a) => {
    const ev = verifyEvidence(transcript, a.evidence);
    if (a.happened && (!ev || !ev.verified)) {
      demotedActions++;
      // ادعای «انجام شد» بدون شاهد تأییدشده به «نامعلوم» تنزل می‌کند
      return { ...a, happened: false, detail: `${a.detail} (شاهد تأیید نشد)`, evidence: null };
    }
    return { ...a, evidence: ev };
  });

  /**
   * چک‌لیست را با نکته‌های **تأییدشده** آشتی بده.
   *
   * پرامپت این را می‌خواهد («جواب منفی فقط وقتی مجاز است که در فهرست نکته‌ها
   * هیچ موردی از آن نوع نباشد») ولی تا امروز هیچ‌چیز اجرایش نمی‌کرد، و در
   * پنج جلسهٔ واقعی نتیجه‌اش این شد: چک‌لیست گفت «تکلیفی نداد» در حالی که
   * در همان خروجی یک موردِ تأییدشده می‌گفت استاد خواسته کتاب قانون را تهیه
   * کنند.
   *
   * این تطبیق هیچ ادعای تازه‌ای نمی‌سازد — فقط نکته‌ای که **قبلاً از هر دو
   * دروازه گذشته** را به چک‌لیست می‌رساند. و چون منفیِ چک‌لیست به دانشجو
   * قطعی نشان داده می‌شود («تکلیفی نداد»، نه «چیزی پیدا نکردم»)، همین
   * تطبیق است که آن قطعیت را قابل دفاع می‌کند.
   */
  const KIND_TO_ACTION: Record<string, string> = {
    homework: "homework",
    deadline: "deadline",
    grading: "grading",
    exam: "exam_info",
  };
  for (const kp of keyPoints) {
    const action = KIND_TO_ACTION[kp.kind];
    if (!action) continue;
    const existing = professorActions.find((a) => a.action === action);
    if (existing?.happened) continue;
    if (existing) {
      logger.info({ action, title: kp.title }, "چک‌لیست با نکتهٔ تأییدشده آشتی داده شد");
      existing.happened = true;
      existing.detail = kp.title;
      existing.evidence = kp.evidence;
    } else {
      professorActions.push({
        action: action as (typeof parsed.professor_actions)[number]["action"],
        happened: true,
        detail: kp.title,
        evidence: kp.evidence,
      });
    }
  }

  const report: AnalysisReport = {
    ...parsed,
    key_points: keyPoints,
    professor_actions: professorActions,
    composition: computeComposition(parsed.chapters, meta.originalDurationMs, meta.silenceMs),
    silenceMs: meta.silenceMs,
    droppedCitations: droppedUnverified + droppedImportance + demotedActions,
    droppedUnverified,
    droppedImportance,
    demotedActions,
  };

  let notesMarkdown = "";
  let notesError: string | null = null;
  let usage2: Anthropic.Usage | null = null;

  if (!opts.skipNotes) {
   try {
    /**
     * اسکلت با نکته‌های **تأییدشده** ساخته می‌شود، نه خروجی خام مدل.
     *
     * پیش‌تر `parsed.key_points` می‌رفت، یعنی هر نکته‌ای که دروازهٔ راستی‌آزمایی
     * یا دروازهٔ تأکید حذفش کرده بود، از در پشتی به جزوه برمی‌گشت — و جزوه
     * همان چیزی است که کاربر نگه می‌دارد و برای گروه درس فوروارد می‌کند.
     * یعنی پیام تلگرام به دروازه‌ها احترام می‌گذاشت و بزرگ‌ترین خروجیِ محصول
     * نه.
     */
    const skeleton = `### تحلیل ساختاریافتهٔ همین جلسه\n\n\`\`\`json\n${JSON.stringify(
      {
        topics: parsed.topics,
        /**
         * `at_clock` فیلدِ خام نیست — اینجا ساخته می‌شود چون جزوه ساعت
         * می‌خواهد (`⟨HH:MM:SS⟩`) و اسکلت فقط میلی‌ثانیه دارد. بدون آن،
         * دستورِ «زمان را از اسکلت بردار» به `⟨102300⟩` در PDF می‌رسید،
         * و قاعدهٔ ۸ سیستم هم صریح تبدیل‌کردن را ممنوع کرده است.
         */
        key_points: keyPoints.map((k) => ({
          ...k,
          evidence: { ...k.evidence, at_clock: fmtClock(k.evidence.at_ms, true) },
        })),
        glossary: parsed.glossary,
        open_questions: parsed.open_questions,
      },
      null,
      1,
    )}\n\`\`\``;

    logger.info({ provider: config.NOTES_PROVIDER }, "analysis pass 2 (جزوه)");

    if (config.NOTES_PROVIDER === "openrouter") {
      // کش روشن است: رونوشت دوباره فرستاده می‌شود ولی به نرخ خواندنِ کش.
      const res = await orChat(
        [
          { role: "system", content: SYSTEM_COMMON },
          // همان بلوکِ بایت‌به‌بایتِ پاس اول ⇒ اینجا به نرخ خواندنِ کش حساب
          // می‌شود، نه نرخ ورودی کامل.
          {
            role: "user",
            content: [cached(transcriptText), { type: "text", text: `${TASK_NOTES}\n\n${skeleton}` }],
          },
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
      dropped: { unverified: droppedUnverified, importance: droppedImportance, actions: demotedActions },
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

/**
 * مدل‌های رایگان گاهی کل جزوه را داخل بلوک کد می‌گذارند.
 *
 * شاخهٔ دوم برای بلوکِ **بسته‌نشده** است: اگر خروجی به سقف توکن بخورد،
 * جزوه وسط بلوک قطع می‌شود و ``` پایانی هرگز نمی‌آید. آن‌وقت markdown-it
 * کل جزوه را یک بلوک کدِ چپ‌به‌راست رندر می‌کند و PDF از دست می‌رود — یعنی
 * یک قطعِ کوچک به خرابیِ کامل تبدیل می‌شود.
 */
function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  if (m?.[1] !== undefined) return m[1].trim();
  const open = /^```(?:markdown|md)?\s*\n([\s\S]*)$/.exec(t);
  if (open?.[1] !== undefined && !open[1].includes("```")) return open[1].trim();
  return t;
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
