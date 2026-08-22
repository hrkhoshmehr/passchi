/**
 * ترمیم خروجی مدل‌های ضعیف پیش از اعتبارسنجی با zod.
 *
 * مدل‌های رایگان `response_format` را جدی نمی‌گیرند و همیشه به یک شکل خطا
 * نمی‌کنند. آنچه روی خروجی واقعی دیده شد:
 *
 * • کلیدهای nullable را **حذف** می‌کنند به‌جای اینکه `null` بگذارند
 *   (`glossary[].english` غایب بود، نه null).
 * • آرایهٔ رشته را آرایهٔ آبجکت می‌دهند (`open_questions` شد `[{question: "…"}]`).
 * • فیلد اختیاری آخر شیء را کلاً جا می‌اندازند (`next_session_hint`).
 *
 * این ماژول همین انحراف‌ها را صاف می‌کند و بعد zod تصمیم می‌گیرد. کاری که
 * **نمی‌کند**: ساختن محتوا. اگر نکته‌ای نقل‌قول ندارد، همین‌جا حذف می‌شود تا
 * دروازهٔ راستی‌آزمایی دور زده نشود.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** آبجکتی که باید رشته می‌بود را به رشته تبدیل می‌کند. */
function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isObj(v)) {
    for (const key of ["question", "text", "content", "value", "title", "q", "item", "note"]) {
      const inner = v[key];
      if (typeof inner === "string" && inner.trim()) return inner;
    }
  }
  return null;
}

function stringArray(v: unknown): string[] {
  return arr(v)
    .map(asString)
    .filter((s): s is string => Boolean(s && s.trim()));
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return fallback;
}

const SPEAKERS = new Set(["استاد", "دانشجو", "نامشخص"]);

function evidence(v: unknown): Obj | null {
  if (!isObj(v)) return null;
  const quote = asString(v.quote ?? v.text);
  if (!quote || quote.trim().length < 4) return null;
  const speaker = asString(v.speaker) ?? "نامشخص";
  return {
    quote,
    at_ms: num(v.at_ms ?? v.start_ms ?? v.time_ms),
    speaker: SPEAKERS.has(speaker) ? speaker : "نامشخص",
  };
}

const KP_KINDS = new Set(["exam", "emphasis", "homework", "deadline"]);
const ACTION_KINDS = new Set([
  "attendance", "quiz", "homework", "deadline", "exam_info",
  "grading", "makeup_class", "class_cancelled", "other",
]);
const SEGMENT_KINDS = new Set(["teaching", "qa", "admin", "offtopic", "technical", "break"]);

/**
 * آیا این خروجی آن‌قدر خالی است که نباید به‌عنوان «تحلیل» تحویل داده شود؟
 *
 * لایهٔ ترمیم هر شکلی را قبول می‌کند و آن را با مقدار پیش‌فرض پر می‌کند. خطرش
 * این است که یک پاسخِ عملاً خالی، شکلاً معتبر شود و کاربر گزارشی ببیند که
 * هیچ‌چیز در آن نیست. اندازه‌گیری واقعی: مدل رایگان روی همین صوت هفت سرفصل
 * درست داد ولی سرخط، خلاصه و نکات را کلاً جا انداخت — نتیجه‌ای که «موفق»
 * به نظر می‌رسید و نبود.
 */
export function isDegenerate(a: Obj): string | null {
  const headline = typeof a.headline === "string" ? a.headline.trim() : "";
  const recap = typeof a.class_recap === "string" ? a.class_recap.trim().length : 0;
  const topics = Array.isArray(a.topics) ? a.topics.length : 0;
  const chapters = Array.isArray(a.chapters) ? a.chapters.length : 0;

  if (!headline && recap < 40) return "مدل سرخط و روایت کلاس را تولید نکرد";
  if (topics === 0 && chapters === 0) return "مدل نه سرفصلی داد نه بخش‌بندی زمانی";
  return null;
}

export function repairAnalysis(input: unknown): Obj {
  const r = isObj(input) ? input : {};

  return {
    session_title: asString(r.session_title) ?? "جلسهٔ کلاس",
    course_guess: asString(r.course_guess),
    headline: asString(r.headline) ?? "",
    // مدل ضعیف گاهی به‌جای پاراگراف، آرایهٔ بولت می‌دهد — به یک پاراگراف چسبانده می‌شود
    class_recap: asString(r.class_recap) ?? stringArray(r.student_summary ?? r.summary).join(" "),

    chapters: arr(r.chapters ?? r.timeline)
      .filter(isObj)
      .map((c) => ({
        start_ms: num(c.start_ms),
        end_ms: num(c.end_ms),
        kind: SEGMENT_KINDS.has(String(c.kind)) ? c.kind : "teaching",
        title: asString(c.title ?? c.label) ?? "",
        parts: arr(c.parts)
          .filter(isObj)
          .map((p) => ({ at_ms: num(p.at_ms ?? p.start_ms), label: asString(p.label ?? p.title) ?? "" }))
          .filter((p) => p.label),
      }))
      .filter((c) => c.end_ms > c.start_ms),

    professor_actions: arr(r.professor_actions)
      .filter(isObj)
      .map((a) => ({
        action: ACTION_KINDS.has(String(a.action)) ? a.action : "other",
        happened: Boolean(a.happened),
        detail: asString(a.detail) ?? "",
        evidence: evidence(a.evidence),
      })),

    // نکتهٔ بدون نقل‌قول همین‌جا می‌افتد — دروازهٔ راستی‌آزمایی نباید دور زده شود
    key_points: arr(r.key_points)
      .filter(isObj)
      .map((k) => ({
        kind: KP_KINDS.has(String(k.kind)) ? k.kind : "emphasis",
        title: asString(k.title) ?? "",
        detail: asString(k.detail) ?? "",
        due: asString(k.due),
        evidence: evidence(k.evidence),
      }))
      .filter((k) => k.evidence !== null && k.title),

    topics: arr(r.topics)
      .filter(isObj)
      .map((t) => ({
        title: asString(t.title) ?? "",
        start_ms: num(t.start_ms),
        end_ms: num(t.end_ms),
        summary: asString(t.summary) ?? "",
        terms: stringArray(t.terms),
      }))
      .filter((t) => t.title),

    glossary: arr(r.glossary)
      .filter(isObj)
      .map((g) => ({
        term: asString(g.term) ?? "",
        english: asString(g.english ?? g.en),
        definition: asString(g.definition) ?? "",
      }))
      .filter((g) => g.term),

    open_questions: stringArray(r.open_questions),
    next_session_hint: asString(r.next_session_hint),
  };
}
