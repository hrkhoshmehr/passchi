import type { AnalysisReport } from "../analysis/schema.js";
import { chunkMessage, escapeHtml } from "../util/text.js";
import { fmtClock, fmtClockLink, fmtDuration, toFaDigits } from "../util/time.js";

export const chunk = chunkMessage;

export const WELCOME = `<b>خرخوان</b> — دستیار درسی

صوت کلاست را بفرست، در چند دقیقه اینها را می‌گیری:

📋 <b>تحلیل جلسه</b> — در یک نگاه بفهم کلاس چه خبر بوده: زمان صرف چه شد، استاد چه اعلام کرد، تکلیفی داد یا نه.
🎯 <b>نکات با ذکر منبع</b> — هر تکلیف، مهلت و نکتهٔ امتحانی با <i>عین جملهٔ استاد</i>. روی زمانش بزنی، صوت از همان‌جا پخش می‌شود.
🧩 <b>پیش‌نیازها</b> — چیزهایی که استاد فرض کرد بلدی و توضیح نداد، با جبران کوتاه هرکدام.
📕 <b>جزوهٔ کامل PDF</b> — بازسازی درس، نه خلاصه؛ با فرمول، مثال‌های حل‌شده و واژه‌نامه.

<b>دو قدم تا شروع</b>
۱. با /course درست را ثبت کن — اسم درس و استاد. این کار دقت تشخیص اصطلاحات تخصصی را واقعاً بالا می‌برد و با هر جلسه بهتر هم می‌شود.
۲. فایل صوتی کلاس را بفرست.

<b>هزینه را تقسیم کن</b>
یک جلسه یک بار پردازش می‌شود. اگر هم‌کلاسی‌هایت هم بردارند، سهم هرکس کمتر می‌شود و مابه‌التفاوت به تو برمی‌گردد. بعد از هر تحلیل دکمه‌اش را می‌بینی.

/help راهنمای کامل · /credit اعتبار · /privacy دادهٔ من`;

export const HELP = `<b>راهنما</b>

<b>چه چیزی بفرستم</b>
فایل صوتی (mp3، m4a، ogg، wav، aac) یا ویس تلگرام. اگر گوشی‌ات ضبط‌کنندهٔ جداگانه دارد، همان بهتر است چون کیفیتش بالاتر است.

<b>سه چیز که کیفیت را زیاد می‌کند</b>
• گوشی را روی میز بگذار، نه داخل کیف. فاصله مهم‌ترین عامل است، نه گران‌بودن گوشی.
• ردیف جلوتر بهتر از ردیف آخر.
• اگر ضبطت خیلی بلند یا خیلی آرام باشد، قبل از خرج‌کردن اعتبارت بهت می‌گویم.

<b>زمان‌های قابل کلیک</b>
نتایج به‌صورت ریپلای همان پیام صوتی می‌آیند. روی هر زمان که بزنی، صوت از همان لحظه پخش می‌شود. این روی موبایل کار می‌کند؛ در تلگرام دسکتاپ زمان‌ها متن ساده می‌مانند.

<b>اعتبار چطور حساب می‌شود</b>
بر اساس <i>مدت</i> صوت، نه حجم فایل. اگر کاری شکست بخورد، اعتبار رزروشده کامل برمی‌گردد.

<b>تقسیم هزینه با هم‌کلاسی‌ها</b>
بعد از هر تحلیل، دکمهٔ اشتراک‌گذاری می‌گیری و یک پیام دعوت که در گروه درس فوروارد می‌کنی. هر کسی که از آن لینک بیاید، سهم همه کمتر می‌شود و اختلافش به قبلی‌ها برمی‌گردد. سقف بازگشت همان چیزی است که خودت داده‌ای — از این نمی‌شود درآمد ساخت، فقط می‌شود هزینه را صفر کرد.

<b>دستورها</b>
/course ثبت درس · /courses فهرست درس‌ها
/history جلسات من · /shared جلسات اشتراکی
/credit اعتبار · /privacy دادهٔ من
/cancel لغو کار جاری`;

export const PRIVACY = `<b>با دادهٔ تو چه می‌شود</b>

<b>فایل صوتی</b>
روی سرور نگه داشته می‌شود تا وقتی که دکمه‌های «شنیدن این لحظه» کار کنند، و بعد خودکار پاک می‌شود. با /forget هر وقت خواستی زودتر پاکش کن.

<b>سرویس تشخیص گفتار</b>
صوت برای رونویسی به Soniox فرستاده می‌شود و بلافاصله پس از گرفتن متن، هم فایل و هم رکورد رونویسی از سرور آن‌ها حذف می‌شود.

<b>رونوشت و تحلیل</b>
در پایگاه دادهٔ ربات می‌مانند تا بتوانی بعداً دوباره بازشان کنی. با /forget پاک می‌شوند.

<b>صدای بقیه</b>
پرسش دانشجوها هم در ضبط هست. ربات فقط <i>نقش</i> را نگه می‌دارد — استاد یا دانشجو — و هیچ تلاشی برای تشخیص اینکه کدام دانشجو حرف زده نمی‌کند.

<b>چیزی که باید خودت حواست باشد</b>
ضبط کلاس در بعضی دانشگاه‌ها و برای بعضی اساتید اجازه می‌خواهد. مسئولیت ضبط و اشتراک‌گذاری با خود توست. اگر جلسه‌ای را اشتراکی می‌کنی، محتوایش به همهٔ کسانی می‌رسد که لینک را دارند.`;

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
  resource: "معرفی منبع",
  other: "سایر",
};

export const KP_LABEL: Record<string, string> = {
  homework: "📝 تکلیف",
  exam_hint: "🎯 نکتهٔ امتحانی",
  emphasis: "⚑ تأکید استاد",
  deadline: "⏳ مهلت",
  resource: "📚 منبع",
  warning: "⚠️ هشدار",
};

/** نوار ترکیب زمانی با کاراکترهای بلوکی — در تلگرام بدون تصویر خوانا است */
function compositionBar(r: AnalysisReport, width = 24): string {
  const rows = r.composition.filter((c) => c.pct > 0);
  if (rows.length === 0) return "";
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

export function overviewMessage(i: OverviewInput): string {
  const r = i.report;
  const out: string[] = [];

  out.push(`📋 <b>${escapeHtml(r.session_title)}</b>`);
  const sub = [i.courseName ?? r.course_guess, i.sessionDate, fmtDuration(i.durationMs)]
    .filter(Boolean)
    .map((s) => escapeHtml(String(s)))
    .join(" · ");
  if (sub) out.push(`<i>${sub}</i>`);
  out.push("");
  out.push(escapeHtml(r.headline));
  out.push("");

  out.push("<b>در یک نگاه</b>");
  for (const s of r.student_summary) out.push(`• ${escapeHtml(s)}`);
  out.push("");

  const bar = compositionBar(r);
  if (bar) {
    out.push("<b>ترکیب زمانی کلاس</b>");
    out.push(bar);
    out.push("");
  }

  out.push("<b>استاد در این جلسه چه کرد</b>");
  const happened = r.professor_actions.filter((a) => a.happened);
  const notHappened = r.professor_actions.filter((a) => !a.happened);
  for (const a of happened) {
    out.push(`✔ <b>${ACTION_LABEL[a.action] ?? a.action}</b> — ${escapeHtml(a.detail)}`);
  }
  if (notHappened.length) {
    out.push(
      `➖ نشانه‌ای نبود از: ${notHappened.map((a) => ACTION_LABEL[a.action] ?? a.action).join("، ")}`,
    );
  }

  if (r.next_session_hint) {
    out.push("");
    out.push(`▶️ <b>جلسهٔ بعد:</b> ${escapeHtml(r.next_session_hint)}`);
  }

  const notes: string[] = [];
  if (i.savedMs > 60_000) notes.push(`${fmtDuration(i.savedMs)} سکوت پیش از پردازش حذف شد`);
  if (i.qualityWarnings.length) notes.push(i.qualityWarnings[0]!);
  if (r.droppedCitations > 0)
    notes.push(`${toFaDigits(r.droppedCitations)} نکته چون نقل‌قولش در صوت تأیید نشد حذف شد`);
  if (notes.length) {
    out.push("");
    out.push(`<i>ℹ️ ${escapeHtml(notes.join(" · "))}</i>`);
  }

  return out.join("\n");
}

/**
 * همهٔ نکات در یک پیام.
 *
 * قبلاً هر نکته پیام جدا بود تا دکمهٔ کلیپ خودش را داشته باشد و نتیجه سیل پیام
 * می‌شد. حالا که این پیام ریپلایِ خودِ صوت است، تلگرام زمان‌ها را لینک پخش
 * می‌کند و دکمه لازم نیست. دو شرط برای لینک‌شدن: ارقام لاتین، و بیرون از
 * هر تگ قالب‌بندی.
 */
export function keyPointsMessage(r: AnalysisReport, linkable: boolean): string {
  if (r.key_points.length === 0) return "";
  const sorted = [...r.key_points].sort(
    (a, b) => b.importance - a.importance || a.evidence.at_ms - b.evidence.at_ms,
  );
  const out = [
    `🎯 <b>${toFaDigits(sorted.length)} نکته با ذکر منبع</b>`,
    linkable
      ? "<i>روی زمان هر نکته بزن تا صوت از همان لحظه پخش شود.</i>"
      : "<i>هر نکته با عین جملهٔ گفته‌شده و زمانش در فایل.</i>",
    "",
  ];
  for (const k of sorted) {
    const stars = "❗".repeat(Math.max(0, k.importance - 1));
    out.push(`${KP_LABEL[k.kind] ?? "•"} <b>${escapeHtml(k.title)}</b> ${stars}`.trim());
    out.push(escapeHtml(k.detail));
    if (k.due) out.push(`⏳ <b>مهلت:</b> ${escapeHtml(k.due)}`);
    out.push(`<blockquote>«${escapeHtml(k.evidence.quote)}»</blockquote>`);
    out.push(`${escapeHtml(k.evidence.speaker)} — ${fmtClockLink(k.evidence.at_ms)}`);
    out.push("");
  }
  return out.join("\n");
}

export function assumedMessage(r: AnalysisReport): string {
  if (r.assumed_knowledge.length === 0) return "";
  const out = [
    "🧩 <b>پیش‌نیازهایی که استاد فرض کرده بلدی</b>",
    "<i>چیزهایی که بدون تعریف به کار برد یا صریح گفت «می‌دانید». اگر اینها را نداری، بقیهٔ درس لنگ می‌ماند.</i>",
    "",
  ];
  for (const a of r.assumed_knowledge) {
    out.push(`<b>${escapeHtml(a.concept)}</b> <i>(${a.signal === "explicit" ? "صریح گفت" : "بدون تعریف به کار برد"})</i>`);
    out.push(escapeHtml(a.quick_explainer));
    if (a.evidence) {
      out.push(`<blockquote>«${escapeHtml(a.evidence.quote)}»</blockquote>`);
      out.push(`⏱ ${fmtClockLink(a.evidence.at_ms)}`);
    }
    out.push(`🔎 <code>${escapeHtml(a.suggested_search)}</code>`);
    out.push("");
  }
  return out.join("\n");
}

export function topicsMessage(r: AnalysisReport): string {
  if (r.topics.length === 0) return "";
  const out = ["📚 <b>خلاصهٔ درسی — سرفصل‌های این جلسه</b>", ""];
  for (const t of r.topics) {
    out.push(`<b>${escapeHtml(t.title)}</b> — ${fmtClockLink(t.start_ms)}`);
    out.push(escapeHtml(t.summary));
    for (const s of t.subpoints.slice(0, 6)) out.push(`  ‹ ${escapeHtml(s)}`);
    out.push("");
  }
  if (r.open_questions.length) {
    out.push("<b>نکات باز</b>");
    for (const q of r.open_questions) out.push(`• ${escapeHtml(q)}`);
  }
  return out.join("\n");
}

/**
 * فهرست فصل‌های صوت — نقشهٔ پیمایش.
 *
 * ارزان‌ترین قابلیت کل محصول: خط زمانی که مدل همین حالا تولید می‌کند، به‌صورت
 * فهرستی از زمان‌های لینک‌پذیر. دانشجویی که فقط دنبال یک بخش است، مستقیم
 * می‌پرد همان‌جا و لازم نیست نود دقیقه صوت را جلو و عقب کند.
 */
export function outlineMessage(r: AnalysisReport): string {
  if (r.timeline.length === 0) return "";
  const out = [
    "🗺 <b>نقشهٔ صوت</b>",
    "<i>روی هر زمان بزن تا از همان‌جا پخش شود.</i>",
    "",
  ];
  for (const s of r.timeline) {
    const icon = KIND_CHAR[s.kind] ?? "▪";
    out.push(`${fmtClockLink(s.start_ms)}  ${icon} ${escapeHtml(s.label)}`);
  }
  return out.join("\n");
}

export function progressMessage(
  stage: "queue" | "preprocess" | "stt" | "analyze" | "pdf",
  detail?: string,
): string {
  const stages: Array<[string, string]> = [
    ["preprocess", "آماده‌سازی صوت"],
    ["stt", "تبدیل گفتار به متن"],
    ["analyze", "تحلیل جلسه"],
    ["pdf", "ساخت جزوه"],
  ];
  const order = stages.map(([k]) => k);
  const cur = order.indexOf(stage);
  const lines = stages.map(([k, label], idx) => {
    if (cur < 0) return `⏳ ${label}`;
    if (idx < cur) return `✅ ${label}`;
    if (idx === cur) return `⏳ <b>${label}</b>${detail ? ` — <i>${escapeHtml(detail)}</i>` : ""}`;
    return `▫️ ${label}`;
  });
  return `<b>در حال پردازش…</b>\n\n${lines.join("\n")}\n\n<i>می‌توانی پنجره را ببندی؛ نتیجه همین‌جا می‌آید.</i>`;
}

export function creditMessage(creditSec: number, usedSec: number): string {
  return [
    "<b>اعتبار شما</b>",
    "",
    `⏱ باقی‌مانده: <b>${fmtDuration(creditSec * 1000)}</b> صوت`,
    `📊 مصرف‌شده تا الان: ${fmtDuration(usedSec * 1000)}`,
    "",
    "<i>اعتبار بر اساس مدت صوت حساب می‌شود، نه حجم فایل. سکوت‌های حذف‌شده هم از اعتبارت کم نمی‌شوند.</i>",
  ].join("\n");
}
