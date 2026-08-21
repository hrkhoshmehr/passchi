import { z } from "zod";

/**
 * شاهد (منبع).
 *
 * نقل‌قول عمداً کوتاه است: خواننده می‌خواهد در یک نگاه ببیند استاد چه گفته،
 * نه اینکه یک پاراگراف بخواند. متن کامل در رونوشت هست و زمانش هم اینجاست.
 */
export const Evidence = z.object({
  quote: z
    .string()
    .describe("کوتاه‌ترین بریدهٔ عیناً نقل‌شده که ادعا را ثابت کند — حداکثر ۱۵ کلمه."),
  at_ms: z.number().int().describe("زمان شروع همان جمله بر حسب میلی‌ثانیه."),
  speaker: z.enum(["استاد", "دانشجو", "نامشخص"]),
});
export type Evidence = z.infer<typeof Evidence>;

export const SegmentKind = z.enum([
  "teaching", // تدریس محتوای درسی
  "qa", // پرسش و پاسخ
  "admin", // حضور و غیاب، نمره، اطلاعیه
  "offtopic", // حاشیه
  "technical", // مشکل فنی
  "break", // استراحت یا وقفه
]);
export type SegmentKind = z.infer<typeof SegmentKind>;

export const TimelineSegment = z.object({
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  kind: SegmentKind,
  label: z.string().describe("حداکثر ۶ کلمه"),
});

export const ProfessorAction = z.object({
  action: z.enum([
    "attendance",
    "quiz",
    "homework",
    "deadline",
    "exam_info",
    "grading",
    "makeup_class",
    "class_cancelled",
    "other",
  ]),
  happened: z.boolean(),
  detail: z.string().describe("یک جملهٔ کوتاه. توضیح اضافه نده."),
  evidence: Evidence.nullable(),
});

/**
 * نکته‌ای که به قبولی در امتحان مربوط است.
 *
 * دامنه عمداً باریک شده. «هر چیز مهمی که استاد گفت» تبدیل می‌شود به فهرستی
 * بلند که کسی نمی‌خواندش. فقط چیزی وارد می‌شود که اگر دانشجو ندانَد، در
 * امتحان یا نمره‌اش اثر می‌گذارد.
 */
export const KeyPoint = z.object({
  kind: z.enum([
    "exam", // استاد گفته در امتحان می‌آید
    "emphasis", // روی این تأکید کرده — نشانهٔ غیرمستقیم امتحان
    "homework", // تکلیف
    "deadline", // مهلت
  ]),
  title: z.string().describe("حداکثر ۸ کلمه — همان چیزی که دانشجو باید بخواند"),
  due: z.string().nullable().describe("مهلت، عیناً همان‌طور که استاد گفته. اگر نگفته null."),
  evidence: Evidence.describe("اجباری — نکتهٔ بدون نقل‌قول اصلاً برنگردانده نشود."),
});

/** سرفصل: عنوان و دقیقه. جزئیاتش در جزوه می‌آید، نه اینجا. */
export const Topic = z.object({
  title: z.string().describe("حداکثر ۸ کلمه"),
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  /** برای ساخت جزوه لازم است، ولی در پیام تلگرام نمایش داده نمی‌شود */
  summary: z.string().describe("یک جمله"),
  terms: z.array(z.string()),
});

export const GlossaryEntry = z.object({
  term: z.string(),
  english: z.string().nullable(),
  definition: z.string().describe("یک جمله"),
});

export const ClassAnalysis = z.object({
  session_title: z.string().describe("عنوان جلسه، حداکثر ۸ کلمه"),
  course_guess: z.string().nullable(),
  headline: z.string().describe("یک جمله: در این کلاس چه گذشت"),
  student_summary: z
    .array(z.string())
    .describe("۳ تا ۵ بولت کوتاه، هرکدام حداکثر یک خط. این «کلاس در یک نگاه» است."),
  timeline: z.array(TimelineSegment).describe("پوشش پیوسته از ابتدا تا انتهای صوت"),
  professor_actions: z.array(ProfessorAction),
  key_points: z.array(KeyPoint),
  topics: z.array(Topic),
  glossary: z.array(GlossaryEntry),
  open_questions: z.array(z.string()).describe("بخش نامفهوم صوت یا سؤال بی‌جواب"),
  next_session_hint: z.string().nullable(),
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

export interface AnalysisReport extends Omit<ClassAnalysis, "key_points" | "professor_actions"> {
  key_points: Array<Omit<z.infer<typeof KeyPoint>, "evidence"> & { evidence: VerifiedEvidence }>;
  professor_actions: Array<
    Omit<z.infer<typeof ProfessorAction>, "evidence"> & { evidence: VerifiedEvidence | null }
  >;
  /** درصدهای *محاسبه‌شده* از خط زمانی — نه حدس مدل */
  composition: TimelineStats[];
  silenceMs: number;
  droppedCitations: number;
}
