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

/** یک نقطهٔ داخل یک بخش: «دقیقهٔ ۱۲، حل تمرین دوم». */
export const ChapterPart = z.object({
  at_ms: z.number().int(),
  label: z.string().describe("حداکثر ۸ کلمه"),
});

/**
 * بخش‌های درشتِ کلاس.
 *
 * نسخهٔ قبلی خط زمانی ریز می‌داد — گاهی سی ردیف — و کسی سی ردیف را نمی‌خواند.
 * حالا چند بخش درشت که در یک نگاه دیده می‌شوند، و ریزه‌کاری هرکدام داخل
 * `parts` جمع می‌شود تا فقط اگر کاربر خواست بازش کند.
 */
export const Chapter = z.object({
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  kind: SegmentKind,
  title: z.string().describe("حداکثر ۶ کلمه — این بخش دربارهٔ چه بود"),
  parts: z
    .array(ChapterPart)
    .describe("۰ تا ۵ نقطهٔ داخل همین بخش، به ترتیب زمان. بخش کوتاه لازم نیست زیربخش داشته باشد."),
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
 * چیزی که دانشجو **باید بداند**.
 *
 * دامنه عمداً باریک است، ولی نه باریک‌تر از واقعیت. معیار این است: اگر
 * دانشجو این را نداند، یا نمره‌اش کم می‌شود یا سرِ جلسهٔ بعد غافلگیر می‌شود.
 *
 * دو نوع آخر بعداً اضافه شدند چون بیرون ماندنشان یک شکاف واقعی بود:
 * «بارم امتحان ۱۲ نمره است» یا «جلسهٔ بعد کلاس تشکیل نمی‌شود» دقیقاً همان
 * چیزهایی‌اند که دانشجوی غایب می‌پرسد، ولی جایی برای نشستن نداشتند.
 */
export const KeyPoint = z.object({
  kind: z.enum([
    "exam", // استاد گفته در امتحان می‌آید
    "emphasis", // آخرین گزینه: مبحثی *درسی* که استاد صریحاً گفته مهم است
    "homework", // هر کاری بیرون از کلاس: تمرین، خواندن فصل، تهیه و مطالعهٔ منبع
    "deadline", // مهلت
    "grading", // بارم، روش نمره‌دهی، سهم حضور و کوییز و پروژه
    "logistics", // ترتیبِ خودِ کلاس: چه همراه بیاور، ساعت عوض شد، جلسهٔ بعد نیست
  ]),
  title: z.string().describe("حداکثر ۸ کلمه — همان چیزی که دانشجو باید بخواند"),
  detail: z
    .string()
    .describe(
      "توضیح کامل همین مورد بر پایهٔ چیزی که در کلاس گفته شد: دقیقاً چه باید بکند، " +
        "کدام بخش یا کدام تمرین، با چه شرطی. دو تا چهار جمله. اگر جزئیاتی گفته نشده، رشتهٔ خالی.",
    ),
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
  class_recap: z
    .string()
    .describe(
      "تعریف‌کردن کلاس برای هم‌کلاسیِ غایب، با لحن دوستانه و روایی: چهار تا هفت جمله " +
        "که به ترتیب بگوید کلاس چطور گذشت. یک پاراگراف پیوسته، بدون بولت و بدون تیتر.",
    ),
  /**
   * ترتیب فیلدها اینجا **معنا دارد** و اتفاقی نیست.
   *
   * مدل با `response_format` به همان ترتیبی می‌نویسد که در اسکیما آمده. وقتی
   * `chapters` پنجمین فیلد بود، مدل باید مرزهای زمانی یک کلاس ۹۴ دقیقه‌ای را
   * بدهد پیش از آنکه فرصت کرده باشد کل رونوشت را ببیند — و نتیجه‌اش همان
   * خطای «همهٔ مرزها زیر ده دقیقه» بود که در سه اجرا از هشت تکرار شد.
   *
   * حالا `topics` جلوتر می‌آید: مدل اول سرفصل‌ها را به ترتیب زمانی می‌شمارد
   * (که مجبورش می‌کند تا انتهای رونوشت برود) و بعد از روی همان‌ها بخش‌های
   * درشت را می‌بُرد.
   *
   * و به همین دلیل `professor_actions` **بعد از** `key_points` آمد.
   * پیش‌تر جلوتر بود، یعنی مدل به «تکلیف نداد» متعهد می‌شد پیش از آنکه به
   * فهرست نکته‌ها برسد و همان‌جا تکلیف را پیدا کند. در پنج جلسهٔ واقعی
   * دقیقاً همین شد: چک‌لیست گفت «تکلیفی نداد» و چند خط پایین‌تر یک موردِ
   * تأییدشده می‌گفت استاد خواسته کتاب قانون را تهیه کنند. حالا چک‌لیست
   * **جمع‌بندیِ** چیزی است که مدل همین الان نوشته، نه یک حدس مستقل.
   */
  topics: z.array(Topic),
  chapters: z
    .array(Chapter)
    .describe("۴ تا ۶ بخش درشت که پشت سر هم کل صوت را بپوشانند؛ بخش آخر باید در نیمهٔ دوم صوت شروع شود"),
  key_points: z.array(KeyPoint),
  professor_actions: z.array(ProfessorAction),
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
  /** تفکیکِ همان عدد، برای اینکه بشود فهمید کدام دروازه چه چیزی را کشت. */
  droppedUnverified: number;
  droppedImportance: number;
  demotedActions: number;
}
