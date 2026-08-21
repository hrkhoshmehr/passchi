import { z } from "zod";

/**
 * شاهد (منبع) — ستون فقرات کل محصول.
 * هیچ نکته‌ای بدون نقل‌قول عیناً از صوت به دانشجو نشان داده نمی‌شود.
 */
export const Evidence = z.object({
  quote: z.string().describe("عین جملهٔ گفته‌شده، کلمه‌به‌کلمه از رونوشت. بازنویسی یا خلاصه ممنوع."),
  at_ms: z.number().int().describe("زمان شروع آن جمله بر حسب میلی‌ثانیه، طبق مهر زمانی رونوشت."),
  speaker: z.enum(["استاد", "دانشجو", "نامشخص"]),
});
export type Evidence = z.infer<typeof Evidence>;

export const SegmentKind = z.enum([
  "teaching", // تدریس محتوای درسی
  "qa", // پرسش و پاسخ مرتبط با درس
  "admin", // امور کلاس: حضور و غیاب، نمره، اطلاعیه، تاریخ امتحان
  "offtopic", // حاشیه، خاطره، گفت‌وگوی نامرتبط
  "technical", // مشکل فنی: ویدئوپروژکتور، صدا، اینترنت
  "break", // استراحت یا وقفهٔ طولانی
]);
export type SegmentKind = z.infer<typeof SegmentKind>;

export const TimelineSegment = z.object({
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  kind: SegmentKind,
  label: z.string().describe("عنوان کوتاه فارسی، حداکثر ۶ کلمه"),
});

export const ProfessorAction = z.object({
  action: z.enum([
    "attendance", // حضور و غیاب
    "quiz", // کوییز یا آزمونک
    "homework", // تکلیف
    "deadline", // مهلت
    "exam_info", // اطلاعات امتحان
    "grading", // صحبت دربارهٔ نمره و بارم
    "makeup_class", // کلاس جبرانی
    "class_cancelled", // لغو جلسه
    "resource", // معرفی منبع، کتاب، لینک
    "other",
  ]),
  happened: z.boolean(),
  detail: z.string(),
  evidence: Evidence.nullable(),
});

export const KeyPoint = z.object({
  kind: z.enum([
    "homework", // تکلیف
    "exam_hint", // نکتهٔ امتحانی
    "emphasis", // تأکید صریح استاد
    "deadline", // مهلت زمانی
    "resource", // منبع معرفی‌شده
    "warning", // هشدار (اشتباه رایج، دام)
  ]),
  title: z.string().describe("حداکثر ۱۰ کلمه"),
  detail: z.string(),
  due: z.string().nullable().describe("مهلت به‌صورت متنی، دقیقاً همان‌طور که استاد گفته. اگر نگفته null."),
  importance: z.number().int().min(1).max(3),
  evidence: Evidence.describe("اجباری — نکته‌ای که نقل‌قول ندارد اصلاً نباید برگردانده شود."),
});

export const Topic = z.object({
  title: z.string(),
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  summary: z.string().describe("۲ تا ۴ جمله"),
  subpoints: z.array(z.string()),
  /** واژه‌های کلیدی این بخش، برای ساخت واژه‌نامه و بافت جلسات بعدی */
  terms: z.array(z.string()),
});

export const AssumedKnowledge = z.object({
  concept: z.string(),
  signal: z
    .enum(["explicit", "implicit"])
    .describe("explicit یعنی استاد صریحاً گفته «می‌دانید»؛ implicit یعنی بدون تعریف به کار برده."),
  why: z.string().describe("چرا این را پیش‌فرض گرفته‌شده می‌دانیم"),
  evidence: Evidence.nullable(),
  quick_explainer: z.string().describe("۲ تا ۴ جمله که همان پیش‌نیاز را جبران کند"),
  suggested_search: z.string().describe("عبارتی که دانشجو برای مطالعهٔ بیشتر جست‌وجو کند"),
});

export const GlossaryEntry = z.object({
  term: z.string(),
  english: z.string().nullable(),
  definition: z.string().describe("یک تا دو جمله"),
});

export const ClassAnalysis = z.object({
  session_title: z.string().describe("عنوان این جلسه، حداکثر ۸ کلمه"),
  course_guess: z.string().nullable().describe("نام درس اگر از محتوا قابل تشخیص است"),
  headline: z.string().describe("یک جمله: در این کلاس چه گذشت"),
  student_summary: z.array(z.string()).describe("۴ تا ۷ بولت برای دانشجویی که کلاس نبوده"),
  timeline: z.array(TimelineSegment).describe("پوشش پیوسته و بدون هم‌پوشانی از ابتدا تا انتهای صوت"),
  professor_actions: z.array(ProfessorAction),
  key_points: z.array(KeyPoint),
  topics: z.array(Topic),
  assumed_knowledge: z.array(AssumedKnowledge),
  glossary: z.array(GlossaryEntry),
  open_questions: z.array(z.string()).describe("چیزهایی که مبهم ماند یا صوت نامفهوم بود"),
  next_session_hint: z.string().nullable().describe("اگر استاد دربارهٔ جلسهٔ بعد چیزی گفته"),
});
export type ClassAnalysis = z.infer<typeof ClassAnalysis>;

// ── نتیجهٔ نهایی پس از راستی‌آزمایی ───────────────────────────────────────

export interface VerifiedEvidence extends Evidence {
  verified: boolean;
  score: number;
}

export interface TimelineStats {
  kind: SegmentKind;
  ms: number;
  pct: number;
}

export interface AnalysisReport extends Omit<ClassAnalysis, "key_points" | "professor_actions" | "assumed_knowledge"> {
  key_points: Array<Omit<z.infer<typeof KeyPoint>, "evidence"> & { evidence: VerifiedEvidence }>;
  professor_actions: Array<
    Omit<z.infer<typeof ProfessorAction>, "evidence"> & { evidence: VerifiedEvidence | null }
  >;
  assumed_knowledge: Array<
    Omit<z.infer<typeof AssumedKnowledge>, "evidence"> & { evidence: VerifiedEvidence | null }
  >;
  /** درصدهای *محاسبه‌شده* از خط زمانی — نه حدس مدل */
  composition: TimelineStats[];
  /** سکوت واقعی اندازه‌گیری‌شده توسط ffmpeg */
  silenceMs: number;
  droppedCitations: number;
}
