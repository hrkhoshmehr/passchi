import type { AnalysisReport } from "../analysis/schema.js";
import { chunkMessage, escapeHtml } from "../util/text.js";
import { fmtClock, fmtClockLink, fmtDuration, toFaDigits } from "../util/time.js";

export const chunk = chunkMessage;

export const WELCOME = `سلام 👋

صوت کلاستو بفرست، بهت می‌گم توش چی گذشت و چی به درد امتحان می‌خوره.

🎁 <b>۹۰ دقیقه</b> مهمون منی.

همین الان یه فایل صوتی بفرست — بقیه‌ش با من.`;

export const HELP = `<b>چیکار می‌کنم</b>
صوت کلاسو می‌گیرم، بهت می‌دم:
• خلاصهٔ کلاس در یک نگاه
• هرچی به امتحان می‌خوره، با عین حرف استاد و دقیقه‌ش
• جزوهٔ کامل PDF

<b>چی بفرستم</b>
هر فایل صوتی یا ویس تلگرام. گوشیو بذار رو میز نه تو کیف — نزدیک‌بودن مهم‌تر از گرون‌بودن گوشیه.

<b>یه ترفند</b>
رو دقیقه‌ها که بزنی، صوت از همون‌جا پخش میشه. (رو موبایل؛ تو دسکتاپ کار نمی‌کنه.)

<b>خرجش با هم‌کلاسیا نصف میشه</b>
یه جلسه یه بار پردازش میشه. هرکی دیگه هم برداره، سهم همه کمتر میشه و پولت برمی‌گرده. بعد هر تحلیل دکمه‌شو می‌بینی.

<b>دستورا</b>
/history جلسه‌های قبلی
/credit اعتبارم
/course ثبت درس
/privacy دادهٔ من`;

export const PRIVACY = `<b>با دادت چیکار می‌کنم</b>

<b>صوت</b> — چند روز نگهش می‌دارم که دکمه‌های زمان کار کنن، بعد خودکار پاک میشه.

<b>سرویس تبدیل گفتار</b> — صوت میره برای رونویسی، و بلافاصله بعدش از سرورشون پاک میشه.

<b>رونوشت و تحلیل</b> — می‌مونه که بعداً بازش کنی. با /forget پاکش کن.

<b>صدای بقیه</b> — سؤال بچه‌ها هم تو ضبطه. فقط نقش رو نگه می‌دارم (استاد یا دانشجو)، اسم کسی رو تشخیص نمی‌دم.

<b>حواست باشه</b> — ضبط کلاس تو بعضی دانشگاه‌ها اجازه می‌خواد. مسئولیتش با خودته. جلسه‌ای که اشتراکی می‌کنی، به همهٔ کسایی که لینکو دارن می‌رسه.`;

const KIND_LABEL: Record<string, string> = {
  teaching: "تدریس",
  qa: "پرسش و پاسخ",
  admin: "امور کلاس",
  offtopic: "حاشیه",
  technical: "مشکل فنی",
  break: "سکوت و وقفه",
};

const KIND_CHAR: Record<string, string> = {
  teaching: "█",
  qa: "▓",
  admin: "▒",
  offtopic: "░",
  technical: "▚",
  break: "·",
};

const ACTION_LABEL: Record<string, string> = {
  attendance: "حضور و غیاب",
  quiz: "کوییز",
  homework: "تکلیف",
  deadline: "مهلت",
  exam_info: "اطلاعات امتحان",
  grading: "نمره و بارم",
  makeup_class: "کلاس جبرانی",
  class_cancelled: "لغو جلسه",
  other: "سایر",
};

export const KP_LABEL: Record<string, string> = {
  exam: "🎯 در امتحان می‌آید",
  emphasis: "⚑ تأکید استاد",
  homework: "📝 تکلیف",
  deadline: "⏳ مهلت",
};

/** نوار ترکیب زمانی با کاراکترهای بلوکی — در تلگرام بدون تصویر خوانا است */
function compositionBar(r: AnalysisReport, width = 24): string {
  const rows = r.composition.filter((c) => c.pct > 0);
  // یک دستهٔ صددرصدی نموداری ندارد که نشان بدهد — فقط جا می‌گیرد
  if (rows.length < 2) return "";
  let bar = "";
  for (const c of rows) {
    const n = Math.max(1, Math.round((c.pct / 100) * width));
    bar += (KIND_CHAR[c.kind] ?? "▪").repeat(n);
  }
  const legend = rows
    .map((c) => `${KIND_CHAR[c.kind] ?? "▪"} ${KIND_LABEL[c.kind] ?? c.kind} ${toFaDigits(Math.round(c.pct))}٪`)
    .join(" · ");
  return `<code>${bar.slice(0, width + 4)}</code>\n${legend}`;
}

export interface OverviewInput {
  report: AnalysisReport;
  courseName: string | null;
  sessionDate: string | null;
  durationMs: number;
  savedMs: number;
  qualityWarnings: string[];
}

/**
 * «کلاس در یک نگاه» — پیام اصلی.
 *
 * نسخهٔ قبلی پنج پیام بلند می‌فرستاد و کسی تا آخرش را نمی‌خواند. حالا همه‌چیزِ
 * لازم در یک پیام است: چه گذشت، استاد چه کرد، چه سرفصل‌هایی گفته شد.
 * سرفصل‌ها فقط عنوان و دقیقه‌اند — تفصیلشان در جزوه است.
 */
export function overviewMessage(i: OverviewInput): string {
  const r = i.report;
  const out: string[] = [];

  out.push(`📋 <b>${escapeHtml(r.session_title)}</b>`);
  const sub = [i.courseName ?? r.course_guess, fmtDuration(i.durationMs)]
    .filter(Boolean)
    .map((s) => escapeHtml(String(s)))
    .join(" · ");
  if (sub) out.push(`<i>${sub}</i>`);

  out.push("");
  for (const s of r.student_summary) out.push(`• ${escapeHtml(s)}`);

  // «other» تقریباً همیشه نویز است («استاد با دعا شروع کرد») و به نمره ربطی ندارد
  const happened = r.professor_actions.filter((a) => a.happened && a.action !== "other");
  if (happened.length) {
    out.push("");
    for (const a of happened) {
      out.push(`✔ <b>${ACTION_LABEL[a.action] ?? a.action}</b> — ${escapeHtml(a.detail)}`);
    }
  }

  if (r.topics.length) {
    out.push("");
    out.push("<b>مباحث</b>");
    for (const t of r.topics) {
      out.push(`${fmtClockLink(t.start_ms)}  ${escapeHtml(t.title)}`);
    }
  }

  if (r.next_session_hint) {
    out.push("");
    out.push(`▶️ <b>جلسهٔ بعد:</b> ${escapeHtml(r.next_session_hint)}`);
  }

  const bar = compositionBar(r);
  if (bar) {
    out.push("");
    out.push(bar);
  }

  if (i.qualityWarnings.length || r.droppedCitations > 0) {
    const notes: string[] = [];
    if (i.qualityWarnings.length) notes.push(i.qualityWarnings[0]!);
    if (r.droppedCitations > 0)
      notes.push(`${toFaDigits(r.droppedCitations)} نکته بدون منبع تأییدشده حذف شد`);
    out.push("");
    out.push(`<i>ℹ️ ${escapeHtml(notes.join(" · "))}</i>`);
  }

  return out.join("\n");
}

/**
 * نکات امتحانی و تکالیف — تنها پیام دوم.
 *
 * فقط چیزهایی که روی نمره اثر دارند. هر مورد یک خط عنوان و یک خط نقل‌قول
 * کوتاه با زمان. نقل‌قول بلند اینجا نمی‌آید؛ متن کامل در رونوشت و جزوه است.
 */
export function keyPointsMessage(r: AnalysisReport, linkable: boolean): string {
  if (r.key_points.length === 0) return "";
  const order: Record<string, number> = { exam: 0, deadline: 1, homework: 2, emphasis: 3 };
  const sorted = [...r.key_points].sort(
    (a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.evidence.at_ms - b.evidence.at_ms,
  );

  const out = ["🎯 <b>اینا به درد امتحان می‌خوره</b>"];
  if (linkable) out.push("<i>رو زمان بزنی، صوت از همون‌جا پخش میشه.</i>");
  out.push("");

  // وقتی همهٔ موارد از یک نوع‌اند، تکرار برچسب در هر خط فقط جا می‌گیرد
  const mixed = new Set(sorted.map((k) => k.kind)).size > 1;

  for (const k of sorted) {
    const label = mixed || k.kind !== "emphasis" ? `${KP_LABEL[k.kind] ?? "•"} ` : "▫️ ";
    out.push(`${label}<b>${escapeHtml(k.title)}</b>${k.due ? ` — مهلت: ${escapeHtml(k.due)}` : ""}`);
    out.push(`«${escapeHtml(trimQuote(k.evidence.quote))}» ${fmtClockLink(k.evidence.at_ms)}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** نقل‌قول بلند را کوتاه می‌کند — مدل گاهی سقف را رعایت نمی‌کند. */
function trimQuote(q: string, maxWords = 18): string {
  const w = q.trim().split(/\s+/);
  return w.length <= maxWords ? q.trim() : w.slice(0, maxWords).join(" ") + " …";
}

/**
 * نوار پیشرفت.
 *
 * کاربر منتظر است و هیچ‌چیز بدتر از سکوت نیست، ولی چک‌لیست چهارمرحله‌ای هم
 * لازم نیست — فقط باید بداند کار دارد پیش می‌رود و چقدر مانده.
 */
export function progressMessage(
  stage: "queue" | "preprocess" | "stt" | "analyze" | "pdf",
  detail?: string,
): string {
  const label: Record<string, string> = {
    queue: "تو صفه",
    preprocess: "دارم صوتو آماده می‌کنم",
    stt: "دارم گوش می‌دم",
    analyze: "دارم تحلیل می‌کنم",
    pdf: "دارم جزوه رو می‌نویسم",
  };
  const step: Record<string, number> = { preprocess: 1, stt: 2, analyze: 3, pdf: 4 };
  const n = step[stage] ?? 0;
  const dots = "●".repeat(n) + "○".repeat(4 - n);

  return `${dots}  ${label[stage] ?? "دارم کار می‌کنم"}…${
    detail ? `\n<i>${escapeHtml(detail)}</i>` : ""
  }\n\n<i>می‌تونی تلگرامو ببندی، نتیجه همین‌جا میاد.</i>`;
}

export function creditMessage(creditSec: number, usedSec: number, refundedSec = 0): string {
  const out = [`⏱ <b>${fmtDuration(creditSec * 1000)}</b> اعتبار داری.`];
  if (usedSec > 0) out.push(`تا حالا ${fmtDuration(usedSec * 1000)} مصرف کردی.`);
  if (refundedSec > 0) {
    out.push(`💰 ${fmtDuration(refundedSec * 1000)} هم از اشتراک‌گذاری برگشته بهت.`);
  }
  out.push("");
  out.push("<i>حساب بر اساس مدت صوته، نه حجم فایل.</i>");
  return out.join("\n");
}
