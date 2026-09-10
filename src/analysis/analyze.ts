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
  MAX_KEY_POINTS,
  keyPointRank,
} from "./schema.js";
import { SYSTEM_COMMON, TASK_ANALYSIS, TASK_NOTES, transcriptBlock } from "./prompts.js";
import { cached, chat as orChat, extractJson } from "./openrouter.js";
import { isDegenerate, repairAnalysis } from "./repair.js";
import { transcriptText as transcriptNormalized, unsupportedMentions } from "./notes-check.js";

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
  /**
   * نام‌ها، عددها و تاریخ‌هایی که در جزوه آمده‌اند ولی در رونوشت نیستند.
   *
   * فعلاً فقط گزارش می‌شود و چیزی حذف نمی‌شود — دلیلش در `notes-check.ts`
   * آمده. فهرست خالی حالت عادی و مطلوب است.
   */
  unsupportedMentions: string[];
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
    // بافت فقط برای دروازه‌هاست و هیچ‌جا چاپ نمی‌شود — توضیحش در schema.ts
    context: m.ok ? m.utteranceText : "",
  };
}

/**
 * نشانه‌های «این یک فرضِ خیالی است»، و «و من این کار را نمی‌کنم».
 *
 * ## چرا این دروازه لازم شد
 *
 * روی همان کلاس حقوق مدنی، استاد دقیقهٔ ۱۳:۰۷ می‌گوید: «مثلاً فرض کن بگیم
 * آقا هر کی قانون همراهش نباشه، دو نمره کم می‌کنم مثلاً. **خب این زشته
 * دیگه.** … من دارم توصیه می‌کنم.» یعنی یک قاعدهٔ نمره‌دهی را مطرح می‌کند تا
 * ردش کند.
 *
 * تکهٔ وسطش — «هر کی قانون همراهش نباشه، دو نمره کم می‌کنم» — یک نقل‌قولِ
 * کاملاً واقعی است: در رونوشت هست، عیناً همان کلمات، و کلمهٔ «نمره» هم دارد.
 * پس هر دو دروازهٔ قبلی را بی‌خطر رد می‌کند و به‌عنوان قاعدهٔ نمره‌دهی به
 * دانشجو می‌رسد — با ذکر دقیقه، که ظاهرِ مستند هم به آن می‌دهد.
 *
 * پرامپت این نمونه را **عیناً** به‌عنوان مثالِ «جهت جمله را وارونه نکن»
 * دارد و باز هم برگشت. علتش روشن است: مدل باید جمله‌ای را نیاورد که خودش
 * راست است؛ چیزی که وارونه‌اش می‌کند در جملهٔ بعدی است، نه در نقل‌قول. پس
 * تصمیم به کد آمد، جایی که بافت در دسترس است.
 *
 * دامنه عمداً به `grading` و `logistics` و `homework` محدود است: فقط
 * نوع‌هایی که یک **قاعده** اعلام می‌کنند. تأکیدِ درسی یا معرفیِ منبع، حتی
 * اگر وسط یک مثالِ فرضی گفته شده باشد، همچنان واقعیت است.
 */
const HYPOTHETICAL_MARKERS = ["فرض کن", "فرض کنید", "فرض بفرمایید", "مثلا بگیم", "مثلا بگم"].map(
  (m) => normalizeFa(m),
);

const HYPOTHETICAL_REJECTIONS = [
  "این کار رو نمیکنم", "این کارو نمیکنم", "نمیکنم", "زشته", "زشت است", "نمیگم",
].map((m) => normalizeFa(m));

export function isRejectedHypothetical(context: string): boolean {
  const c = normalizeFa(context);
  if (!c) return false;
  const at = HYPOTHETICAL_MARKERS.map((m) => c.indexOf(m)).filter((i) => i >= 0);
  if (at.length === 0) return false;
  const from = Math.min(...at);
  // نفی باید **بعد از** فرض بیاید؛ «نمی‌کنم»ی که قبلش گفته شده ربطی به این
  // فرض ندارد و با ندیدنِ ترتیب، هر پاره‌گفتارِ بلندی از دروازه می‌افتاد.
  const after = c.slice(from);
  return HYPOTHETICAL_REJECTIONS.some((r) => after.includes(r));
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
  // «اینو بدانید» هم‌خانوادهٔ «یاد بگیر» و «بلد باش» است و جا افتاده بود.
  "بدان",
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
  /**
   * «یه» و «تره» — دو صرفِ محاوره‌ای که روی دادهٔ واقعی گیر افتادند.
   *
   * استاد گفت «درس بسیار **مهمیه**، از همهٔ مدنی‌ها **مهم‌تره**» — صریح‌ترین
   * جملهٔ اهمیت در کل آن جلسه — و دروازه ردش کرد و نکته حذف شد. «ی» و «تر»
   * در فهرست بودند ولی شکلِ گفتاریِ «مهم + یه» و «مهم + تره» نه. یعنی
   * دروازه فقط فارسیِ نوشتاری را می‌دید، در حالی که ورودی‌اش رونوشتِ حرفِ
   * شفاهی است.
   */
  "یه", "تره", "ترینه",
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
  "مطالعه بفرمایید", "نگاه بکنید", "نگاه کنید", "نگاهی بندازید", "نگاه بندازید", "حل کنید", "حل بکنید", "تمرین",
  "ترجمه کنید", "تحقیق کنید", "آماده کنید", "بنویسید", "جواب بدید", "جواب بدهید",
  /**
   * صورت‌های **مضارع اخباری** — «تهیه می‌کنید»، نه «تهیه کنید».
   *
   * فارسیِ کلاس، درخواست را با فعل امری نمی‌گوید؛ با خبر می‌گوید: «فرض بر
   * اینه که شما این دو تا کتاب رو تهیه می‌کنید و مطالعه می‌کنید». روی دادهٔ
   * واقعی همین جمله تکلیفِ اصلیِ آن جلسه بود و چون فهرست فقط صورتِ امری را
   * داشت، برچسبِ تکلیف نمی‌گرفت و چک‌لیست می‌گفت «تکلیفی نداد».
   */
  "تهیه میکنید", "مطالعه میکنید", "میخونید", "میخوانید", "حل میکنید",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

/**
 * «خواستم» در برابر «پیشنهاد می‌کنم» — تصمیم روی خودِ نقل‌قول، نه روی برداشت.
 *
 * ## چرا این تصمیم به کد آمد
 *
 * شدتِ درخواست تنها جایی است که مدل هر بار می‌تواند صادقانه جور دیگری
 * قضاوت کند: «فلان کتاب رو بخونید خوبه» برای یک اجرا تکلیف است و برای اجرای
 * بعدی توصیه. و بهایش کوچک نیست — چک‌لیست به دانشجو **قطعی** می‌گوید «تکلیف
 * داد»، پس یک توصیه که تیک بخورد او را می‌فرستد سراغ کاری که استاد نخواسته،
 * و شاید کارِ واقعی را جا بیندازد. با این دو فهرست، ده اجرا روی یک نقل‌قول
 * ده جواب یکسان می‌دهد.
 */
const DUTY_MARKERS = [
  "باید", "حتما", "موظف", "اجباری", "الزامی", "ازتون میخوام", "میخوام که",
  "تحویل بدید", "تحویل بدهید", "نمره داره", "نمره دارد",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

const ADVISORY_MARKERS = [
  "پیشنهاد میکنم", "پیشنهاد من", "توصیه میکنم", "توصیه من",
  "بهتره", "بهتر است", "خوبه", "خوب است", "بد نیست", "ضرری نداره",
  "میتونید", "میتوانید", "اختیاری", "اگه دوست داشتید", "اگر دوست داشتید",
  "اگه خواستید", "اگر خواستید",
  /**
   * «سعی بفرمایید» و «هر کی خواست» — نرم‌کننده‌هایی که فهرست نداشت.
   *
   * «سعی کنید یکی دو تا از این کتاب‌ها رو بخونید» یک پیشنهاد است، ولی چون
   * فعل امری دارد و هیچ نرم‌کننده‌ای در فهرست نبود، پیش‌فرضِ «اجباری» رویش
   * می‌نشست و در چک‌لیست تیکِ **قطعیِ** «تکلیف داد» می‌گرفت.
   *
   * ولی `DUTY_MARKERS` همچنان مقدم است و این عمدی است: «سعی کنید **حتماً**
   * تا جلسهٔ بعد بخونید» یک درخواست است، نه پیشنهاد. سکوت یک تکلیف را به
   * توصیه تبدیل نمی‌کند، ولی یک کلمهٔ الزامی توصیه را به تکلیف برمی‌گرداند.
   */
  "سعی بفرمایید", "سعی کنید", "علاقه مند", "هر کی خواست", "هر کس خواست",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

/**
 * پیش‌فرض «اجباری» است و این عمدی است: فعل امریِ بی‌نرم‌کننده («فصل سه رو
 * بخونید») واقعاً درخواست است. فقط وقتی به توصیه تنزل می‌کند که خودِ استاد
 * کلمهٔ نرم‌کننده را گفته باشد و هیچ کلمهٔ الزامی کنارش نباشد — یعنی سکوت
 * هرگز یک تکلیفِ واقعی را به توصیه تبدیل نمی‌کند.
 */
export function obligationOf(quote: string): "required" | "recommended" {
  const words = normalizeFa(quote).split(" ").filter(Boolean);
  if (hasHint(words, DUTY_MARKERS)) return "required";
  return hasHint(words, ADVISORY_MARKERS) ? "recommended" : "required";
}

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
 * سه دستهٔ تازه، با نشانه‌های عمداً **تنگ**.
 *
 * وسوسه این بود که «کتاب» را نشانهٔ منبع بگذاریم؛ ولی «کتاب» در همین دو درس
 * ۳۹۱ بار آمده و بیشترش وسط تدریس است («در کتاب خدا باید دنبالش بگردید»).
 * چنین نشانه‌ای هر تأکیدِ درسی را به «منبع» تبدیل می‌کرد. پس فقط کلماتی
 * می‌مانند که *معرفیِ منبع* بودن را خودشان می‌گویند: منبع، مرجع، رفرنس،
 * انتشارات.
 *
 * همین منطق برای تصحیح: «اشتباه» به‌تنهایی کافی نیست، چون استاد اشتباهِ
 * دانشجو را هم نقد می‌کند. دنبال جمله‌ای هستیم که استاد حرفِ **خودش** را پس
 * بگیرد — «اشتباه گفتم»، «تصحیح می‌کنم».
 */
const SYLLABUS_HINTS = [
  "سرفصل", "محدوده", "لغایت", "تا اخر فصل", "این ترم میخونیم",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

/**
 * نشانه‌های **مرز** — چیزی که یک «محدوده» را از یک معرفیِ کلی جدا می‌کند.
 *
 * عمداً از خودِ حرف‌اضافه‌ها ساخته شده و نه از موضوع: هر محدوده‌ای که استاد
 * واقعاً اعلام کند یکی از این‌ها را دارد («از ۱۸۳ تا ۳۰۰»، «تا آخر فصل
 * چهار»، «باب دوم»). جملهٔ «درس‌مون حقوق مدنی ۳ هست» هیچ‌کدام را ندارد و
 * دقیقاً همان چیزی است که این فهرست باید بیندازد.
 */
const RANGE_HINTS = [
  "از", "تا", "لغایت", "فصل", "ماده", "باب", "بخش",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

const RESOURCE_HINTS = [
  "منبع", "منابع", "مرجع", "رفرنس", "انتشارات", "جزوه",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

const CONTACT_HINTS = [
  "ایمیل", "واتساپ", "دفترم", "اتاقم", "ساعت حضور", "شماره تماس",
  "دستیار", "تی ای", "پیام بدید", "پیام بدهید",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

/**
 * «تصحیح» به‌تنهایی اینجا نیست، و این عمدی است: تصحیحِ اوراق یک موضوعِ
 * نمره‌ای است، نه پس‌گرفتنِ حرف. نشانه‌ها فقط جمله‌هایی‌اند که استاد در آنها
 * حرفِ **خودش** را باطل می‌کند.
 */
const CORRECTION_HINTS = [
  "اشتباه گفتم", "غلط گفتم", "پس میگیرم", "پس می گیرم",
  "حرفمو اصلاح", "درستش اینه", "درستش این است",
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

/**
 * **یک نکته می‌تواند بیش از یک ردیفِ چک‌لیست را روشن کند.**
 *
 * نگاشتِ بالا یک‌به‌یک است و همان‌جا می‌ماند، ولی سه ردیف از چک‌لیست هیچ
 * نوعِ متناظری در نکته‌ها ندارند و به همین دلیل تقریباً همیشه «انجام نشد»
 * می‌مانند:
 *
 * • `exam_info` — نکتهٔ «میان‌ترم ۸ نمره داره و از چهار فصل اول میاد»
 *   برچسبِ `grading` می‌گیرد (چون دربارهٔ نمره است و نمره در فهرست انتخاب
 *   نوع بالاتر از امتحان است)، پس فقط `grading` را روشن می‌کند و چک‌لیست
 *   به دانشجو می‌گوید «دربارهٔ امتحان چیزی نگفت» — در حالی که همان‌جا
 *   تاریخ و بارم و محدودهٔ امتحان نوشته شده.
 * • `class_cancelled` و `makeup_class` — هر دو زیر `logistics` می‌نشینند
 *   و `logistics` اصلاً در نگاشت نیست.
 *
 * پس ردیف‌های دوم از روی **خودِ نقل‌قولِ تأییدشده** روشن می‌شوند، نه از روی
 * برچسب. هیچ ادعای تازه‌ای ساخته نمی‌شود: جمله‌ای که «کلاس نداریم» دارد،
 * همین حالا در فهرستِ نکته‌ها با ذکر دقیقه به دانشجو نشان داده می‌شود.
 */
const EXAM_WORDS = ["امتحان", "میان ترم", "پایان ترم", "کوییز"].map((m) =>
  normalizeFa(m).split(" ").filter(Boolean),
);
const CANCEL_WORDS = ["کلاس نداریم", "تشکیل نمیشود", "تشکیل نمی شود", "لغو", "تعطیل"].map((m) =>
  normalizeFa(m).split(" ").filter(Boolean),
);
const MAKEUP_WORDS = ["جبرانی"].map((m) => normalizeFa(m).split(" ").filter(Boolean));

export function checklistExtras(kind: string, quote: string): string[] {
  const words = normalizeFa(quote).split(" ").filter(Boolean);
  const out: string[] = [];
  if (kind === "grading" && hasHint(words, EXAM_WORDS)) out.push("exam_info");
  if (kind === "logistics") {
    if (hasHint(words, CANCEL_WORDS)) out.push("class_cancelled");
    if (hasHint(words, MAKEUP_WORDS)) out.push("makeup_class");
  }
  return out;
};


export function classifyKeyPointKind(
  quote: string,
  title: string,
):
  | "homework"
  | "grading"
  | "logistics"
  | "correction"
  | "contact"
  | "syllabus"
  | "resource"
  | null {
  const words = normalizeFa(`${title} ${quote}`).split(" ").filter(Boolean);
  // ترتیب = اولویت. تکلیف اول است چون کاری که دانشجو باید انجام دهد از هر
  // برچسب دیگری کاربردی‌تر است: «این کتاب رو تهیه کنید» هم نشانهٔ تکلیف دارد
  // هم نشانهٔ منبع، و تکلیف بردنش درست‌تر است.
  if (hasHint(words, HOMEWORK_HINTS)) return "homework";
  // تصحیح **پیش از** نمره می‌آید: عنوانِ نکته اغلب کلمهٔ «تصحیح» را دارد و
  // آن کلمه در نشانه‌های نمره هم هست (تصحیح اوراق)، پس اگر نمره جلوتر باشد
  // «جلسهٔ پیش اشتباه گفتم» برچسبِ «نمره و بارم» می‌گیرد.
  if (hasHint(words, CORRECTION_HINTS)) return "correction";
  if (hasHint(words, GRADING_HINTS)) return "grading";
  if (hasHint(words, LOGISTICS_HINTS)) return "logistics";
  if (hasHint(words, CONTACT_HINTS)) return "contact";
  if (hasHint(words, SYLLABUS_HINTS)) return "syllabus";
  if (hasHint(words, RESOURCE_HINTS)) return "resource";
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
      /**
       * «مهم نیست» ادعای اهمیت نیست — **چهار** توکن بعدی را نگاه کن.
       *
       * دو توکن کافی نبود، چون فارسیِ گفتاری بین نشانه و نفی چیز می‌گذارد:
       * «این قسمت اصلاً برای شما مهم **نیست**»، «این تو امتحانِ ما اصلاً
       * **نمیاد**». هر دو از دروازه رد می‌شدند و وارونهٔ حرف استاد به دانشجو
       * می‌رسید. چهار توکن، جایی است که دیگر نفی به همان نشانه برنمی‌گردد.
       */
      if ([1, 2, 3, 4].some((k) => isNegation(words[last + k]))) continue;
      /**
       * «شب امتحان» نشانهٔ امتحان نیست.
       *
       * پرکاربردترین نصیحتِ استادها همین است — «شب امتحان موقع یاد گرفتن
       * درس نیست» — و چون کلمهٔ «امتحان» در آن هست، از دروازه رد می‌شد و
       * به‌عنوان نکتهٔ تأکید به دانشجو می‌رسید. پرامپت این جمله را دو جا
       * عیناً به‌عنوان نمونهٔ «نصیحت، نه نکته» آورده و باز هم برگشت، پس
       * قرینه به کد آمد: قرینهٔ «شب»، ادعای امتحانی‌بودن را باطل می‌کند.
       */
      if (words[i] === "امتحان" && words[i - 1] === "شب") continue;
      return true;
    }
  }
  return false;
}

/**
 * «این **درس** مهمه» تأکید درسی نیست — تأکید روی خودِ درس است.
 *
 * ## چرا این دروازه به کد آمد
 *
 * `emphasis` باید بگوید **کدام مبحث** مهم است. ولی استادها اول ترم دربارهٔ
 * اهمیتِ خودِ درس حرف می‌زنند و آن جمله‌ها همهٔ نشانه‌های اهمیت را دارند:
 * «درس مدنی ۳ شاید مهم‌ترین درس دوره کارشناسی‌تونه»، «لذا درس، درس بسیار
 * مهمیه»، «این درس رو باید بدانید، باید یاد بگیرید».
 *
 * هر سه از `statesImportance` رد می‌شوند و باید هم رد شوند — واقعاً ادعای
 * اهمیت‌اند. ولی هیچ‌کدام به دانشجوی غایب چیزی نمی‌گویند: نه مبحثی را نام
 * می‌برند و نه کاری از آن‌ها درمی‌آید. همان «پرکردنِ الکیِ فهرست» که پرامپت
 * بدترین کارِ ممکن می‌داندش.
 *
 * یک دور پرامپت با همین نمونه‌ها صریح شد و **بی‌اثر بود** — روی سنجه، نقض
 * در یک اجرا از سه اجرا سر جایش ماند و در اجرای سوم با نقل‌قولِ دیگری از
 * همان جنس برگشت. پس همان مسیرِ همیشگیِ این پروژه: تصمیم به کد.
 *
 * ## قاعده
 *
 * دو شرط، و شرط دوم است که جلوی حریص‌شدن را می‌گیرد:
 *
 * ۱) یک کلمهٔ **سطحِ درس** (درس، کلاس، ترم، رشته، واحد) تا چهار توکن پیش از
 *    نشانهٔ اهمیت آمده باشد — یعنی موضوعِ جمله همان است، نه یک مبحث.
 * ۲) و در کلِ نقل‌قول **هیچ نامِ مبحثی** نباشد. «این قسمت از درس خیلی مهمه»
 *    کلمهٔ «درس» را دارد ولی دربارهٔ یک قسمت است، پس می‌ماند.
 */
/**
 * «ترم» عمداً **نیست**: رونویسی خودکار «میان‌ترم» را گاهی «میان ترم» می‌نویسد
 * و آن‌وقت جملهٔ «اینو خوب یاد بگیرید، تو میان ترم هست» — که پیش‌بینی‌کننده‌ترین
 * نکتهٔ ممکن است — سطحِ درس حساب می‌شد و حذف می‌گردید.
 */
const COURSE_WORDS = new Set(["درس", "کلاس", "رشته", "واحد", "درسها", "کلاسها"]);

const TOPIC_WORDS = new Set([
  "قسمت", "مبحث", "فصل", "ماده", "قضیه", "فرمول", "بحث", "تعریف", "قاعده",
  "نکته", "مسئله", "مساله", "باب", "اصل", "شرط", "عنصر", "رابطه", "مثال",
  "تقسیم", "بند", "تبصره", "قانون", "جدول", "نمودار", "اینجا",
]);

/**
 * فقط نشانه‌های **ستایشِ عمومی**، نه کلِ `IMPORTANCE_MARKERS`.
 *
 * فهرست کامل کلماتی مثل «لازم»، «امتحان» و «بارم» را هم دارد و هر سه اینجا
 * خطرناک‌اند. «لازم» روی دادهٔ واقعی گیر افتاد: در «توی این درس، **عقد لازم**
 * و جایز خیلی مهمه» یک اصطلاح حقوقی است نه ادعای ضرورت، و چون «درس» چند
 * توکن قبلش بود، یک تأکیدِ کاملاً مبحثی حذف می‌شد.
 *
 * و «امتحان» و «نمره» از جنسِ دیگری‌اند: «امتحانِ این درس سخته» ادعای
 * ستایشِ درس نیست، خبری از امتحان است و این دروازه کارش نیست.
 */
const COURSE_PRAISE_MARKERS = [
  "مهم", "اهمیت", "یاد بگیر", "یادبگیر", "بدان", "بلد باش", "جدی بگیر", "کلیدی", "اساسی",
].map((m) => normalizeFa(m).split(" ").filter(Boolean));

export function isCourseLevelImportance(quote: string): boolean {
  const words = normalizeFa(quote).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  // شرط ۲ اول بررسی می‌شود چون ارزان‌تر است و بیشترِ موارد را همان‌جا نگه می‌دارد
  if (words.some((w) => TOPIC_WORDS.has(w))) return false;

  for (const marker of COURSE_PRAISE_MARKERS) {
    for (let i = 0; i + marker.length <= words.length; i++) {
      let hit = true;
      for (let k = 0; k < marker.length - 1; k++) {
        if (words[i + k] !== marker[k]) { hit = false; break; }
      }
      if (!hit) continue;
      if (!matchesMarkerToken(words[i + marker.length - 1]!, marker[marker.length - 1]!)) continue;
      for (let back = 1; back <= 4; back++) {
        const w = words[i - back];
        if (w !== undefined && COURSE_WORDS.has(w)) return true;
      }
    }
  }
  return false;
}

/**
 * بودجهٔ کلمهٔ هر بخش را **حساب‌شده** به پاس دوم می‌دهد.
 *
 * ## چرا در کد و نه در پرامپت
 *
 * قاعدهٔ «هر ده دقیقه تدریس، چهارصد کلمه» ماه‌ها در پرامپت بود و رعایت
 * نمی‌شد: روی یک کلاس ۹۴ دقیقه‌ای با ۷۳ دقیقه تدریس، جزوه‌ها بین ۱۴۰۰ تا
 * ۱۹۰۰ کلمه درمی‌آمدند در حالی که قاعده ۲۹۲۰ می‌خواست. افزودنِ «طولت را
 * بسنج» به پرامپت هیچ اثری نداشت.
 *
 * دلیلش این بود که رسیدن به آن عدد از مدل **حساب** می‌خواست، و اسکلتی که
 * به پاس دوم می‌رفت اصلاً `chapters` نداشت — یعنی داده‌ای که این حساب روی
 * آن انجام شود در دسترسش نبود. حالا جدولِ آماده می‌رود: هر بخش، مدتش، و
 * کفِ کلمه‌اش.
 *
 * بخش‌هایی که درس نیستند صفر می‌گیرند و اصلاً در جدول نمی‌آیند، پس کلاسی
 * که نصفش حاشیه بوده جریمه نمی‌شود.
 */
const NOTES_WORDS_PER_MIN = 40;

/**
 * بخش‌هایی که در جزوه سهم دارند، با مدت و کفِ کلمه‌شان.
 *
 * `qa` هم می‌آید: پرسش و پاسخ دربارهٔ همان درس است و استاد در جوابش مطلب
 * می‌گوید. آنچه سهم ندارد `admin` و `offtopic` و `technical` و `break` است —
 * هرکدام kind خودشان را دارند، پس لازم نیست حدس بزنیم.
 *
 * **صادرشده تا `scripts/notes-check.mjs` هم از همین تابع بخواند.** سنجهٔ
 * جدا همان چیزی بود که این باگ را پنهان کرد: پرامپت چهل کلمه بر دقیقهٔ
 * تدریس می‌خواست و سنجه دوازده کلمه بر دقیقهٔ کلاس را کافی می‌دانست، پس
 * جزوه‌ای که یک‌سومِ خواسته بود «✅ سالم» می‌گرفت.
 */
export function notesBudget(
  chapters: ClassAnalysis["chapters"],
): { title: string; kind: string; minutes: number; floor: number; startMs: number; endMs: number }[] {
  return chapters
    .filter((c) => c.kind === "teaching" || c.kind === "qa")
    .map((c) => ({
      title: c.title,
      kind: c.kind,
      // بازه هم برمی‌گردد چون دستورِ گسترش باید بگوید کجای رونوشت را دوباره بخواند
      startMs: c.start_ms,
      endMs: c.end_ms,
      minutes: Math.max(0, c.end_ms - c.start_ms) / 60_000,
    }))
    .filter((c) => c.minutes >= 1)
    .map((c) => ({ ...c, floor: Math.round(c.minutes * NOTES_WORDS_PER_MIN) }));
}

/**
 * آیا جزوه آن‌قدر از کف عقب است که ارزش یک فراخوان دوم را داشته باشد؟
 *
 * ## چرا این تصمیم تابعِ جدا شد
 *
 * چون یک **قضاوتِ اقتصادی** است، نه یک آستانهٔ سلیقه‌ای: هر فراخوان دوم چند
 * سنت هزینه دارد و چند ده ثانیه به انتظارِ کاربر اضافه می‌کند. با تابعِ
 * جدا و صادرشده، آزمون می‌تواند مرزها را بسنجد بی‌آنکه به مدل زنگ بزند.
 *
 * ۸۰٪ انتخاب شد نه ۱۰۰٪: شمارشِ کلمهٔ ما با تخمینِ مدل یکی نیست و جزوه‌ای
 * که ۹۵٪ کف را نوشته واقعاً کامل است. زیر ۸۰٪ دیگر «تخمین» نیست — یعنی
 * بخش‌هایی خلاصه شده‌اند.
 *
 * کفِ صفر (کلاسی که هیچ بخش درسی نداشته) هرگز گسترش نمی‌خواهد، وگرنه یک
 * جلسهٔ تماماً اداری هم یک فراخوان اضافه می‌گرفت.
 */
export function needsExpansion(words: number, floor: number): boolean {
  if (floor <= 0) return false;
  return words < floor * 0.8;
}

function budgetBlock(chapters: ClassAnalysis["chapters"]): string {
  const rows = notesBudget(chapters);
  if (rows.length === 0) return "";

  const total = rows.reduce((s, c) => s + c.floor, 0);
  const lines = rows.map(
    (c) => `- ${c.title} (${c.kind}) — ${Math.round(c.minutes)} دقیقه — کف ${c.floor} کلمه`,
  );

  /**
   * بازه‌های غیردرسی **صریح** گفته می‌شوند، نه اینکه فقط از جدول غایب باشند.
   *
   * غیبت از جدول یک اطلاعِ منفی است و مدل آن را نمی‌بیند: نتیجه‌اش این بود
   * که چهارده دقیقهٔ اولِ کلاس — که معرفی درس و منابع بود، نه تدریس — در
   * جزوه به‌صورت یک سرفصلِ کامل بازسازی می‌شد، و همان مطالبی که در پیام
   * ربات با ذکر دقیقه آمده‌اند دوباره در جزوه تکرار می‌شدند.
   *
   * با آمدنِ بازه و عنوان و دلیل، دستور از «اینجا چیزی ننویس» به یک واقعیتِ
   * قابلِ بررسی تبدیل می‌شود.
   */
  const skipped = chapters
    .filter((c) => c.kind !== "teaching" && c.kind !== "qa")
    .filter((c) => c.end_ms > c.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms)
    .map(
      (c) =>
        `${fmtClock(c.start_ms, true)} تا ${fmtClock(c.end_ms, true)} (${KIND_FA[c.kind] ?? c.kind}: ${c.title.trim() || "بی‌عنوان"})`,
    );

  const skippedLine = skipped.length
    ? `\n\nاین بازه‌ها درس نبوده‌اند و در جزوه نمی‌آیند: ${skipped.join("، ")}.`
    : "";

  return `### بودجهٔ کلمهٔ هر بخش

این جدول از روی مدت واقعی بخش‌های همین کلاس حساب شده است. عددها **کف**‌اند نه سقف:

${lines.join("\n")}

جمع: دست‌کم ${total} کلمه. بخش‌هایی که درس نبوده‌اند (اطلاعیه، حاشیه، مشکل فنی، وقفه) اینجا نیامده‌اند و در جزوه هم نمی‌آیند.${skippedLine}`;
}

/** نام فارسیِ نوع بخش — برای همان جملهٔ «این بازه‌ها درس نبوده‌اند». */
const KIND_FA: Record<string, string> = {
  admin: "اطلاعیه",
  offtopic: "حاشیه",
  technical: "مشکل فنی",
  break: "وقفه",
};

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
  let droppedHypothetical = 0;
  let droppedEmptySyllabus = 0;
  let droppedCourseLevel = 0;
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
    /**
     * تأکید روی **خودِ درس**، نه روی یک مبحث — توضیح کاملش بالای
     * `isCourseLevelImportance` آمده. فقط `emphasis` را می‌گیرد: نکتهٔ `exam`
     * ادعای دیگری دارد («در امتحان می‌آید») و جمله‌ای مثل «این درس امتحانش
     * سخته» هرچه باشد، خبری از امتحان است.
     */
    if (fixed === "emphasis" && isCourseLevelImportance(ev.quote)) {
      droppedCourseLevel++;
      logger.info(
        { title: kp.title, quote: ev.quote },
        "تأکید روی خودِ درس بود نه روی مبحث — نکته حذف شد",
      );
      continue;
    }
    /**
     * فرضی که استاد **همان‌جا ردش کرد**، قاعده نیست.
     *
     * فقط روی نوع‌هایی که یک قاعده اعلام می‌کنند اعمال می‌شود؛ تأکید درسی یا
     * معرفی منبع حتی وسط یک مثالِ فرضی هم واقعیت است. قرینه در **بافت**
     * است نه در نقل‌قول، و به همین دلیل هیچ دروازهٔ قبلی نمی‌توانست بگیردش.
     */
    if (
      (fixed === "grading" || fixed === "logistics" || fixed === "homework") &&
      isRejectedHypothetical(ev.context ?? "")
    ) {
      droppedHypothetical++;
      logger.info(
        { title: kp.title, kind: fixed, quote: ev.quote },
        "فرضِ ردشده — استاد همان‌جا این قاعده را رد کرد، نکته حذف شد",
      );
      continue;
    }
    /**
     * نکتهٔ «محدودهٔ درس» که نقل‌قولش هیچ مرزی ندارد، محدوده‌ای اعلام نکرده.
     *
     * روی دادهٔ واقعی، `syllabus` جایی شد که مدل جمله‌های معرفیِ کلی را در آن
     * می‌ریخت — «درس‌مون حقوق مدنی ۳ هست»، «الزامات خارج از قرارداد موضوع
     * مدنی ۴ است». هیچ‌کدام نمی‌گویند این ترم از کجا تا کجاست، و هر دو در
     * عنوان و سرخطِ جلسه هم هستند؛ اینجا فقط فهرست را رقیق می‌کنند.
     *
     * محدودهٔ واقعی همیشه یک مرز دارد: «از … تا …»، «لغایت»، شمارهٔ فصل یا
     * ماده یا باب. اگر هیچ‌کدام در نقل‌قول نیست، ادعای محدوده در کار نیست.
     */
    if (fixed === "syllabus" && !hasHint(normalizeFa(ev.quote).split(" ").filter(Boolean), RANGE_HINTS)) {
      droppedEmptySyllabus++;
      logger.info({ title: kp.title, quote: ev.quote }, "نکتهٔ محدودهٔ درس بدون مرز — حذف شد");
      continue;
    }
    // شدت فقط برای تکلیف معنا دارد؛ بقیهٔ نوع‌ها گزارشِ واقعیت‌اند نه درخواست.
    const obligation = fixed === "homework" ? obligationOf(ev.quote) : "required";
    keyPoints.push({ ...kp, kind: fixed, obligation, evidence: ev });
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
   * تکراری‌زدایی و سقف هشت — **در کد، بعد از هر دو دروازه**.
   *
   * سقف تا امروز در پرامپت بود و نتیجه‌اش این: وقتی نُه نامزد وجود داشت،
   * اینکه کدام هشت‌تا بماند سلیقهٔ همان اجرا بود و دو اجرا روی یک صوت دو
   * فهرست می‌دادند. حالا انتخاب با همان ترتیبی است که در پیام چاپ می‌شود،
   * یعنی فوری‌ترین‌ها می‌مانند و انتخاب تکرارپذیر است.
   */
  /**
   * چند نکتهٔ `resource` به **یک** نکته تبدیل می‌شوند.
   *
   * ## چرا این هم به کد آمد
   *
   * پرامپت صریح می‌گوید «اگر چند کتاب را پشت هم نام برد، همه را در detail
   * همان یک نکته بیاور، نه یک نکته برای هر کتاب». روی سنجهٔ واقعی، یک اجرا
   * از سه اجرا **پنج** نکتهٔ منبع داد — یکی برای هر کتابی که استاد نام برده
   * بود.
   *
   * بهایش دوتاست و هر دو دیده شد:
   *
   * • **سقف هشت را می‌بلعد.** پنج ردیفِ منبع یعنی سه جای باقی‌مانده برای
   *   تکلیف و محدوده و کتاب قانون — و همان‌جا چیزی که دانشجو واقعاً لازم
   *   دارد بیرون می‌افتد.
   * • **پایداری را می‌کُشد.** بین سه اجرا، فهرست نکته‌ها جاکاردِ ۰٫۱۵ گرفت و
   *   بیشترِ این نوسان از همین بود: اجرایی پنج ردیفِ منبع، اجرایی دو.
   *
   * ادغام چیزی از دست نمی‌دهد: عنوانِ ردیف‌های بعدی به `detail` همان نکتهٔ
   * اول می‌چسبد، و نقل‌قولِ تأییدشده همان اولی می‌ماند — یعنی چیزی که به‌عنوان
   * «عین حرف استاد» چاپ می‌شود همچنان راستی‌آزمایی شده است.
   *
   * فقط `resource`: بقیهٔ نوع‌ها می‌توانند چند موردِ واقعاً متمایز باشند
   * («کتاب قانون بیارید» و «جلسهٔ بعد کلاس نداریم» هر دو logistics‌اند و
   * ادغامشان یعنی گم‌کردنِ یکی).
   */
  const resources = keyPoints.filter((k) => k.kind === "resource");
  let merged = keyPoints;
  if (resources.length > 1) {
    const head = resources[0]!;
    const extras = resources
      .slice(1)
      .map((k) => (k.detail.trim() ? `${k.title.trim()}: ${k.detail.trim()}` : k.title.trim()))
      .filter(Boolean);
    head.detail = [head.detail.trim(), ...extras].filter(Boolean).join(" ");
    const drop = new Set(resources.slice(1));
    merged = keyPoints.filter((k) => !drop.has(k));
    logger.info(
      { from: resources.length, titles: resources.map((r) => r.title) },
      "چند نکتهٔ منبع به یک نکته ادغام شد",
    );
  }

  const seen = new Set<string>();
  const deduped = merged.filter((k) => {
    const key = `${k.kind}|${k.evidence.at_ms}|${normalizeFa(k.evidence.quote)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const capped =
    deduped.length <= MAX_KEY_POINTS
      ? deduped
      : [...deduped]
          .sort(
            (a, b) =>
              keyPointRank(a.kind, a.obligation) - keyPointRank(b.kind, b.obligation) ||
              a.evidence.at_ms - b.evidence.at_ms,
          )
          .slice(0, MAX_KEY_POINTS);
  if (capped.length < keyPoints.length) {
    logger.debug(
      { from: keyPoints.length, to: capped.length },
      "نکته‌های تکراری یا مازاد بر سقف حذف شدند",
    );
  }

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

  for (const kp of capped) {
    // توصیه تیکِ «تکلیف داد» نمی‌گیرد: آن تیک قطعی است و دانشجو آن را کارِ
    // واجب می‌خواند. خودِ نکته سر جایش می‌ماند و با برچسبِ توصیه دیده می‌شود.
    if (kp.kind === "homework" && kp.obligation === "recommended") continue;
    const primary = KIND_TO_ACTION[kp.kind];
    const actions = [...(primary ? [primary] : []), ...checklistExtras(kp.kind, kp.evidence.quote)];
    for (const action of actions) {
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
  }

  /**
   * واژه‌نامه: ورودی‌های هم‌معنا با هم ادغام می‌شوند.
   *
   * مدل یک اصطلاح را دو بار می‌آورد وقتی استاد دو بار تعریفش کرده — یک بار
   * «عقد» و یک بار «عقد (contract)» — و جدولِ واژه‌نامه در PDF دو ردیف با
   * یک عنوان می‌گیرد. کلید، صورتِ نرمال‌شدهٔ اصطلاح **یا** معادل انگلیسی
   * است، چون گاهی همان اصطلاح با دو املای فارسی می‌آید ولی معادلش یکی است.
   *
   * ردیفِ اول می‌ماند و از ردیف‌های بعدی فقط چیزی برداشته می‌شود که ردیف
   * اول نداشته (معادل انگلیسیِ غایب، تعریفِ خالی) — یعنی ادغام چیزی را از
   * دست نمی‌دهد.
   */
  const glossary: ClassAnalysis["glossary"] = [];
  const glossaryAt = new Map<string, number>();
  for (const g of parsed.glossary) {
    const keys = [normalizeFa(g.term), g.english ? `en:${normalizeFa(g.english)}` : ""].filter(Boolean);
    const hitKey = keys.find((k) => glossaryAt.has(k));
    if (hitKey !== undefined) {
      const row = glossary[glossaryAt.get(hitKey)!]!;
      if (!row.english && g.english) row.english = g.english;
      if (!row.definition.trim() && g.definition.trim()) row.definition = g.definition;
      for (const k of keys) if (!glossaryAt.has(k)) glossaryAt.set(k, glossaryAt.get(hitKey)!);
      continue;
    }
    for (const k of keys) glossaryAt.set(k, glossary.length);
    glossary.push({ ...g });
  }
  if (glossary.length < parsed.glossary.length) {
    logger.debug(
      { from: parsed.glossary.length, to: glossary.length },
      "ورودی‌های تکراری واژه‌نامه ادغام شدند",
    );
  }

  const report: AnalysisReport = {
    ...parsed,
    glossary,
    key_points: capped,
    professor_actions: professorActions,
    composition: computeComposition(parsed.chapters, meta.originalDurationMs, meta.silenceMs),
    silenceMs: meta.silenceMs,
    droppedCitations:
      droppedUnverified +
      droppedImportance +
      droppedHypothetical +
      droppedEmptySyllabus +
      droppedCourseLevel +
      demotedActions,
    droppedUnverified,
    droppedImportance,
    demotedActions,
  };

  let notesMarkdown = "";
  let notesError: string | null = null;
  let unsupportedList: string[] = [];
  /**
   * مصرفِ پاس دوم به‌صورت **فهرست** نگه داشته می‌شود، نه یک متغیرِ جمع‌شونده.
   *
   * چون ممکن است دو فراخوان باشد (جزوه، و فراخوانِ گسترشش) و جمع‌زدن داخل
   * یک closure باعث می‌شود TypeScript متغیر را همچنان `null` بداند — یعنی
   * هزینه بی‌صدا صفر گزارش شود. با فهرست، جمع در همان جایی انجام می‌شود که
   * خوانده می‌شود.
   */
  const notesUsages: Anthropic.Usage[] = [];
  const addUsage = (u: Anthropic.Usage) => { notesUsages.push(u); };
  const sumUsage = (pick: (u: Anthropic.Usage) => number | null | undefined): number =>
    notesUsages.reduce((a, u) => a + (pick(u) ?? 0), 0);

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
     *
     * ## چرا نکته‌ها به دو فهرست تقسیم شدند
     *
     * دستورِ جزوه می‌گوید «منبعِ دو کادرِ 🎯 و ⚑ فقط اسکلت است». ولی اسکلت
     * **همهٔ** نکته‌ها را می‌داد — تکلیف، مهلت، منبع، ترتیب کلاس — و مدل
     * وقتی فهرستی از ده نکته می‌بیند که بالایش نوشته «کادرها را از اینجا
     * بردار»، برای آن‌ها هم کادر می‌سازد. نتیجه‌اش دقیقاً همان چیزی بود که
     * جزوه نباید باشد: «⚑ تأکید استاد — کتاب قانون رو سر جلسه بیارید»، در
     * حالی که همان جمله چند پیام بالاتر با ذکر دقیقه به دانشجو رسیده و
     * دستورِ جزوه صریح گفته امور کلاس اینجا تکرار نشوند.
     *
     * پس `boxable` فقط `exam` و `emphasis` است — همان دو نوعی که کادر
     * دارند — و بقیه در `other_points` می‌آیند با **فقط** نوع و عنوان: مدل
     * باید بداند این‌ها گفته شده‌اند تا در متن دوباره کشفشان نکند، ولی
     * نقل‌قولی در دست نداشته باشد که داخل کادر بگذارد.
     */
    const boxable = keyPoints
      .filter((k) => k.kind === "exam" || k.kind === "emphasis")
      .map((k) => ({
        kind: k.kind,
        title: k.title,
        detail: k.detail,
        quote: k.evidence.quote,
        /**
         * `at_clock` فیلدِ خام نیست — اینجا ساخته می‌شود چون جزوه ساعت
         * می‌خواهد (`⟨HH:MM:SS⟩`) و اسکلت فقط میلی‌ثانیه دارد. بدون آن،
         * دستورِ «زمان را از اسکلت بردار» به `⟨102300⟩` در PDF می‌رسید،
         * و قاعدهٔ ۸ سیستم هم صریح تبدیل‌کردن را ممنوع کرده است.
         */
        at_clock: fmtClock(k.evidence.at_ms, true),
      }));

    const otherPoints = keyPoints
      .filter((k) => k.kind !== "exam" && k.kind !== "emphasis")
      .map((k) => ({ kind: k.kind, title: k.title }));

    const skeleton = `### تحلیل ساختاریافتهٔ همین جلسه\n\n\`\`\`json\n${JSON.stringify(
      {
        topics: parsed.topics,
        boxable,
        other_points: otherPoints,
        glossary: report.glossary,
        open_questions: parsed.open_questions,
      },
      null,
      1,
    )}\n\`\`\`\n\n${budgetBlock(parsed.chapters)}`;

    logger.info({ provider: config.NOTES_PROVIDER }, "analysis pass 2 (جزوه)");

    /**
     * یک فراخوانِ جزوه — با یا بدون دستورِ گسترش.
     *
     * `system` و بلوکِ رونوشت در هر دو فراخوان **بایت‌به‌بایت** یکسان‌اند، پس
     * فراخوان دوم فقط به نرخِ خواندنِ کش حساب می‌شود؛ دستورِ گسترش که چند صد
     * توکن است بعد از مرزِ کش می‌آید و آن مرز را نمی‌شکند.
     */
    const runNotes = async (extra: string | null): Promise<string> => {
      const task = extra ? `${TASK_NOTES}\n\n${extra}` : TASK_NOTES;
      if (config.NOTES_PROVIDER === "openrouter") {
        // کش روشن است: رونوشت دوباره فرستاده می‌شود ولی به نرخ خواندنِ کش.
        const res = await orChat(
          [
            { role: "system", content: SYSTEM_COMMON },
            // همان بلوکِ بایت‌به‌بایتِ پاس اول ⇒ اینجا به نرخ خواندنِ کش حساب
            // می‌شود، نه نرخ ورودی کامل.
            {
              role: "user",
              content: [cached(transcriptText), { type: "text", text: `${task}\n\n${skeleton}` }],
            },
          ],
          { model: config.OPENROUTER_NOTES_MODEL || config.OPENROUTER_MODEL, maxTokens: 32_000 },
        );
        addUsage(fakeUsage(res.inputTokens, res.outputTokens));
        openRouterUsd += res.costUsd;
        return stripFence(res.text);
      }
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
              { type: "text", text: task },
              { type: "text", text: skeleton },
            ],
          },
        ],
      });
      const final = await stream.finalMessage();
      addUsage(final.usage);
      return final.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    };

    notesMarkdown = await runNotes(null);

    /**
     * **یک** فراخوانِ دومِ گسترش، اگر جزوه از کف عقب مانده باشد.
     *
     * ## چرا در کد و نه در پرامپت
     *
     * جدولِ بودجه ماه‌هاست به مدل می‌رسد و بندِ «پیش از تحویل طولت را بسنج»
     * هم در دستورِ جزوه هست. باز هم جزوه‌ها زیر کف درمی‌آیند، و دلیلش
     * ساختاری است نه بی‌دقتی: مدل وقتی متن را نوشت دیگر برنمی‌گردد بازنویسی
     * کند — «بررسی پیش از تحویل» برای او یعنی یک نگاهِ سطحی، نه بازنویسیِ
     * کامل. تنها چیزی که واقعاً بازش می‌گرداند این است که جزوهٔ نوشته‌شده را
     * جلویش بگذاریم و بگوییم کدام بخش‌ها کم آمده‌اند.
     *
     * سه قید که هزینه را مهار می‌کنند:
     *
     * • **فقط یک بار.** حلقهٔ باز یعنی هزینهٔ بی‌سقف روی کلاسی که واقعاً
     *   حرفی برای گفتن ندارد.
     * • **فقط اگر بلندتر شد.** فراخوان دوم می‌تواند جزوه را *کوتاه‌تر* کند
     *   (مدل خلاصه‌اش می‌کند تا «تمیزتر» شود) و آن‌وقت خرج کرده‌ایم که خروجی
     *   بدتر شود. نتیجهٔ بدتر دور ریخته می‌شود.
     * • **بخش‌های عقب‌مانده با بازهٔ زمانی** نام برده می‌شوند، تا مدل بداند
     *   کجای رونوشت را دوباره باید بخواند.
     */
    const budget = notesBudget(parsed.chapters);
    const floor = budget.reduce((s, c) => s + c.floor, 0);
    const wordsOf = (md: string) => md.split(/\s+/).filter(Boolean).length;
    const before = wordsOf(notesMarkdown);

    if (needsExpansion(before, floor)) {
      /**
       * کدام بخش‌ها عقب‌اند؟ سرفصل‌های جزوه روی بخش‌های جدول نمی‌افتند، پس
       * نمی‌شود بخش‌به‌بخش شمرد. به‌جایش بخش‌هایی که بزرگ‌ترین کف را دارند
       * اول نام برده می‌شوند — همان‌جا که بیشترین جای خالی هست.
       */
      const short = [...budget]
        .sort((a, b) => b.floor - a.floor)
        .map(
          (c) =>
            `«${c.title}» — کف ${c.floor} کلمه — بازهٔ ${fmtClock(c.startMs, true)} تا ${fmtClock(c.endMs, true)}`,
        );

      const expandTask = `جزوهٔ فعلی این است:

${notesMarkdown}

این جزوه ${before} کلمه شد، در حالی که کفِ مجموعِ بخش‌های درسی ${floor} کلمه است. این بخش‌ها از کفشان عقب‌اند:

${short.map((s) => `- ${s}`).join("\n")}

فقط همین بخش‌ها را با جزئیات رونوشت گسترش بده و **کل جزوه را کامل برگردان** — از تیتر اول تا آخرین سرفصل، نه فقط بخش‌های اضافه‌شده. چیزی از جزوهٔ فعلی حذف نکن.

و راهِ رسیدن به این عدد فقط برداشتنِ چیزی است که در رونوشت هست و در جزوه نیست: کدام مثال، کدام عدد، کدام استدلال، کدام جزئیاتی که استاد برشمرد. جملهٔ توضیحیِ خودت اضافه نکن، مطلبی را با عبارت دیگر تکرار نکن، و مقدمه‌چینی نکن — هر سه از جزوهٔ کوتاه بدتراند.`;

      const expanded = await runNotes(expandTask);
      const after = wordsOf(expanded);
      logger.info(
        { before, after, floor, replaced: after > before },
        "جزوه از کف عقب بود — فراخوان گسترش",
      );
      if (after > before) notesMarkdown = expanded;
    }

    /**
     * نام‌ها و عددهایی که در جزوه هستند ولی در رونوشت نیستند — فقط **هشدار**.
     *
     * چیزی حذف نمی‌شود و این عمدی است: سنجه هنوز روی دادهٔ واقعی کالیبره
     * نشده و حذفِ خودکار می‌تواند نامی را ببرد که استاد واقعاً گفته و
     * رونویسیِ خودکار غلط نوشته. اول باید در لاگ دیده شود چه چیزی و چقدر
     * گیر می‌افتد.
     */
    unsupportedList = unsupportedMentions(notesMarkdown, transcriptNormalized(transcript.utterances));
    if (unsupportedList.length) {
      logger.warn(
        { mentions: unsupportedList },
        "نام یا عددی در جزوه هست که در رونوشت نیست — احتمالاً از دانشِ خودِ مدل آمده",
      );
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
      // دو فراخوان هم که باشد (جزوه و گسترشش)، جمعِ هر دو گزارش می‌شود
      pass2Calls: notesUsages.length,
      pass2Cache: notesUsages.length
        ? {
            write: sumUsage((u) => u.cache_creation_input_tokens),
            read: sumUsage((u) => u.cache_read_input_tokens),
          }
        : null,
      dropped: {
        unverified: droppedUnverified,
        importance: droppedImportance,
        hypothetical: droppedHypothetical,
        emptySyllabus: droppedEmptySyllabus,
        courseLevel: droppedCourseLevel,
        actions: demotedActions,
      },
    },
    "analysis done",
  );

  const analysisCost = config.ANALYSIS_PROVIDER === "openrouter" ? 0 : costOf(config.ANALYSIS_MODEL, usage1);
  const notesCost =
    notesUsages.length === 0 || config.NOTES_PROVIDER === "openrouter"
      ? 0
      : notesUsages.reduce((a, u) => a + costOf(config.NOTES_MODEL, u), 0);

  return {
    report,
    notesMarkdown,
    notesError,
    unsupportedMentions: unsupportedList,
    usage: {
      inputTokens: (usage1.input_tokens ?? 0) + sumUsage((u) => u.input_tokens),
      outputTokens: (usage1.output_tokens ?? 0) + sumUsage((u) => u.output_tokens),
      cacheWriteTokens:
        (usage1.cache_creation_input_tokens ?? 0) + sumUsage((u) => u.cache_creation_input_tokens),
      cacheReadTokens:
        (usage1.cache_read_input_tokens ?? 0) + sumUsage((u) => u.cache_read_input_tokens),
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
