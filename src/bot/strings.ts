import type { AnalysisReport } from "../analysis/schema.js";
import { chunkMessage, escapeHtml } from "../util/text.js";
import { fmtClock, fmtClockLink, fmtDuration, toFaDigits } from "../util/time.js";
import {
  COINS_PER_MINUTE, SHARE_TARGET, balanceCoins, coinsAsMinutes, fmtBalance, fmtCoins, fmtCost, shareBack,
} from "../billing/coins.js";
import { BTN } from "./menu.js";

export const chunk = chunkMessage;

export const HELP = `<b>چیکار می‌کنم</b>
صوت کلاستو می‌گیرم، بهت می‌دم:
• خلاصهٔ کلاس در یک نگاه
• هرچی به امتحان می‌خوره، با عین حرف استاد و دقیقه‌ش
• جزوهٔ کامل PDF

<b>چی بفرستم</b>
هر فایل صوتی یا ویس تلگرام. گوشیو بذار رو میز نه تو کیف — نزدیک‌بودن مهم‌تر از گرون‌بودن گوشیه.

<b>سکه‌ها</b>
اولین صوتت رایگان پیاده میشه. بعدش هر دقیقه صوت ${toFaDigits(COINS_PER_MINUTE)} سکه. از «${BTN.account}» موجودیت رو می‌بینی و شارژ می‌کنی.

<b>یه ترفند</b>
رو دقیقه‌ها که بزنی، صوت از همون‌جا پخش میشه. (رو موبایل؛ تو دسکتاپ کار نمی‌کنه.)

<b>خرجش با هم‌کلاسیا نصف میشه</b>
یه جلسه یه بار پردازش میشه. هرکی دیگه هم برداره، سهم همه کمتر میشه و سکه‌هات برمی‌گرده. بعد هر تحلیل دکمه‌شو می‌بینی.

<b>دستورا</b>
/history جلسه‌های قبلی
/credit حساب و سکه‌ها
/course ثبت درس
/privacy دادهٔ من
/forget پاک‌کردن داده‌هام`;

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
 * پیام ۱ — «کلاس چه خبر بود».
 *
 * این اولین چیزی است که دانشجو می‌بیند و باید همان جوابی باشد که از یک
 * هم‌کلاسی می‌گیرد: یک پاراگراف روایی، نه گزارش و نه بولت. فهرست‌ها و
 * جدول‌ها در پیام‌های بعدی می‌آیند؛ اینجا فقط قصهٔ کلاس است.
 */
export function recapMessage(i: OverviewInput): string {
  const r = i.report;
  const out: string[] = [];

  out.push(`📋 <b>${escapeHtml(r.session_title)}</b>`);
  const sub = [i.courseName ?? r.course_guess, fmtDuration(i.durationMs)]
    .filter(Boolean)
    .map((s) => escapeHtml(String(s)))
    .join(" · ");
  if (sub) out.push(`<i>${sub}</i>`);

  out.push("");
  out.push(escapeHtml(r.class_recap || r.headline));

  if (r.next_session_hint) {
    out.push("");
    out.push(`▶️ <b>جلسهٔ بعد:</b> ${escapeHtml(r.next_session_hint)}`);
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

/** مواردی که همیشه گفته می‌شود انجام شد یا نشد — چون «نشد» هم خبر است. */
const CORE_ACTIONS = ["attendance", "quiz", "exam_info", "homework"] as const;

/**
 * پیام ۲ — آنچه از کلاس استخراج شد.
 *
 * دو بخش دارد. اول یک چک‌لیست کوتاه: حضور و غیاب گرفت یا نه، کوییز داد یا نه.
 * پاسخ منفی هم می‌آید، چون دانشجویی که کلاس نبوده دقیقاً همین را می‌پرسد و
 * سکوتِ ما را «یعنی نگرفت» یا «یعنی نفهمیدی» نمی‌شود تفسیر کرد.
 *
 * بعد نکات، هرکدام با یک نقل‌قول تأییدشده. تفصیل هر نکته داخل «نقل‌قول
 * بازشونده» می‌رود: تلگرام آن را جمع‌شده نشان می‌دهد و کاربر خودش بازش
 * می‌کند — پس هشت نکتهٔ مفصل هم پیام را به دیوار متن تبدیل نمی‌کند.
 */
export function extractedMessage(r: AnalysisReport): string {
  const out = ["📌 <b>چی از کلاس درآوردم</b>", ""];

  const byAction = new Map(r.professor_actions.map((a) => [a.action, a]));
  for (const key of CORE_ACTIONS) {
    const a = byAction.get(key);
    const label = ACTION_LABEL[key] ?? key;
    if (!a) {
      out.push(`▫️ ${label} — <i>نشانه‌ای پیدا نکردم</i>`);
    } else if (a.happened) {
      out.push(`✅ <b>${label}</b>${a.detail ? ` — ${escapeHtml(a.detail)}` : ""}`);
    } else {
      out.push(`⬜️ ${label} — نه`);
    }
  }
  // بقیهٔ مواردی که واقعاً اتفاق افتاده‌اند: کلاس جبرانی، نمره، لغو جلسه…
  for (const a of r.professor_actions) {
    if (CORE_ACTIONS.includes(a.action as (typeof CORE_ACTIONS)[number])) continue;
    if (!a.happened || a.action === "other") continue;
    out.push(`✅ <b>${ACTION_LABEL[a.action] ?? a.action}</b>${a.detail ? ` — ${escapeHtml(a.detail)}` : ""}`);
  }

  const points = sortedKeyPoints(r);
  if (points.length) {
    out.push("");
    out.push("<b>نکته‌ها</b>");
    for (const k of points) {
      out.push("");
      out.push(
        `${KP_LABEL[k.kind] ?? "•"} <b>${escapeHtml(k.title)}</b>` +
          (k.due ? ` — مهلت: ${escapeHtml(k.due)}` : ""),
      );
      const inner: string[] = [];
      if (k.detail.trim()) inner.push(escapeHtml(k.detail.trim()));
      inner.push(`«${escapeHtml(trimQuote(k.evidence.quote))}» ${fmtClockLink(k.evidence.at_ms)}`);
      out.push(`<blockquote expandable>${inner.join("\n\n")}</blockquote>`);
    }
  }

  return out.join("\n");
}

function sortedKeyPoints(r: AnalysisReport) {
  const order: Record<string, number> = { exam: 0, deadline: 1, homework: 2, emphasis: 3 };
  return [...r.key_points].sort(
    (a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.evidence.at_ms - b.evidence.at_ms,
  );
}

const KIND_EMOJI: Record<string, string> = {
  teaching: "📘",
  qa: "🙋",
  admin: "📋",
  offtopic: "💬",
  technical: "🔌",
  break: "⏸",
};

/**
 * پیام ۳ — کلاس به چند بخش.
 *
 * دو سطح، و این تفکیک عمدی است. سطح اول چند خط است و در یک نگاه خوانده
 * می‌شود: کاربر می‌خواهد بفهمد کدام بیست دقیقه را می‌تواند رد کند، نه اینکه
 * سی ردیف بخواند. ریزه‌کاری هر بخش داخل «نقل‌قول بازشونده» جمع می‌ماند تا
 * فقط کسی که همان بخش را می‌خواهد گوش بدهد بازش کند.
 *
 * از `chapters` ساخته می‌شود نه از `topics`، چون کل صوت را می‌پوشاند —
 * حاشیه و خاطره و مشکل فنی هم جای خودشان را دارند.
 *
 * پیام باید ریپلای پیام صوت باشد تا تلگرام زمان‌ها را به لینک پخش تبدیل کند؛
 * بدون آن، همین متن فقط یک فهرست عدد است.
 */
export function timelineMessage(r: AnalysisReport, linkable: boolean): string {
  const rows = [...r.chapters].sort((a, b) => a.start_ms - b.start_ms);
  if (rows.length === 0) return "";

  const out = ["🕘 <b>کلاس به چه بخش‌هایی گذشت</b>"];
  if (linkable) out.push("<i>رو هر زمان بزنی، صوت از همون‌جا پخش میشه.</i>");

  for (const c of rows) {
    const title = c.title.trim() || KIND_LABEL[c.kind] || c.kind;
    const span = Math.max(0, c.end_ms - c.start_ms);
    out.push("");
    out.push(
      `${fmtClockLink(c.start_ms)}  ${KIND_EMOJI[c.kind] ?? "▫️"} <b>${escapeHtml(title)}</b>` +
        (span >= 60_000 ? ` · <i>${fmtDuration(span)}</i>` : ""),
    );
    const parts = c.parts.filter((p) => p.label.trim());
    if (parts.length) {
      out.push(
        `<blockquote expandable>${parts
          .map((p) => `${fmtClockLink(p.at_ms)}  ${escapeHtml(p.label.trim())}`)
          .join("\n")}</blockquote>`,
      );
    }
  }

  const bar = compositionBar(r);
  if (bar) {
    out.push("");
    out.push(bar);
  }
  return out.join("\n");
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

export interface AccountInput {
  creditSec: number;
  usedSec: number;
  refundedSec: number;
  sessionCount: number;
}

/**
 * صفحهٔ حساب.
 *
 * موجودی، خرج، و برگشتی — همه به سکه. معادلِ دقیقه‌ای فقط زیر موجودی می‌آید،
 * چون عددِ سکه به‌تنهایی به کاربر نمی‌گوید چند جلسه می‌تواند بفرستد.
 */
export function accountMessage(i: AccountInput): string {
  const coins = balanceCoins(i.creditSec);
  const out = [
    "🪙 <b>حساب من</b>",
    "",
    `موجودی: <b>${fmtCoins(coins)}</b>`,
    `<i>یعنی حدود ${coinsAsMinutes(coins)}</i>`,
    "",
  ];
  if (i.sessionCount > 0) out.push(`📚 ${toFaDigits(i.sessionCount)} جلسه فرستاده‌ای`);
  if (i.usedSec > 0) out.push(`💸 تا حالا ${fmtCost(i.usedSec)} خرج کرده‌ای`);
  if (i.refundedSec > 0) out.push(`💰 ${fmtCost(i.refundedSec)} از اشتراک‌گذاری برگشته بهت`);
  out.push("", `<i>هر دقیقه صوت ${toFaDigits(COINS_PER_MINUTE)} سکه.</i>`);
  return out.join("\n");
}

/** پیام «سکه کم است» — همه‌جا یک شکل، و همیشه با راه خروج. */
export function lowBalanceMessage(neededSec: number, balanceSec: number): string {
  return [
    "سکه‌هات کم میاد 😅",
    "",
    `این کار <b>${fmtCost(neededSec)}</b> می‌خواد ولی <b>${fmtBalance(balanceSec)}</b> داری.`,
    "",
    `از «${BTN.account}» شارژ کن.`,
  ].join("\n");
}

/**
 * پیشنهاد پس از اجرای رایگان.
 *
 * سه چیز را کنار هم می‌گذارد چون تصمیم کاربر به هر سه بستگی دارد: چه چیزی
 * نگرفته، چقدر خرج دارد، و چطور می‌تواند تقریباً همه‌اش را پس بگیرد.
 */
export function upsellMessage(costSec: number): string {
  const { share, back, pct } = shareBack(costSec);
  return [
    "این فقط <b>متن خام</b> کلاس بود. با سکه، اینا رو هم می‌گیری:",
    "",
    "📋 <b>کلاس چه خبر بود</b> — خلاصهٔ چندخطی، انگار یه هم‌کلاسی برات تعریف کنه",
    "📌 <b>حضور و غیاب، کوییز، تکلیف</b> — با مهلت و عین جملهٔ استاد",
    "🎯 <b>نکته‌های امتحانی</b> — هرچی استاد گفت «تو امتحان میاد»، با دقیقه‌ش",
    "🕘 <b>بخش‌بندی کلاس</b> — کجا درس داد، کجا حاشیه رفت (رو زمان بزنی صوت پخش میشه)",
    "📕 <b>جزوهٔ PDF</b> — محتوای درس، مرتب و قابل چاپ",
    "",
    `تحلیل کامل همین جلسه: <b>${fmtCost(costSec)}</b>`,
    "",
    `💰 <b>ولی لازم نیست همه‌شو خودت بدی.</b> جزوه رو برای بچه‌های کلاس بفرست — ` +
      `اگه ${toFaDigits(SHARE_TARGET)} نفر برش دارن، سهم هرکس ${fmtCoins(share)} میشه و ` +
      `<b>${fmtCoins(back)}</b> (یعنی ${toFaDigits(pct)}٪) برمی‌گرده به حسابت.`,
  ].join("\n");
}

/** پیام پایانی هر جلسهٔ کامل: چقدر رفت، چقدر مانده، و چطور برمی‌گردد. */
export function settlementMessage(costSec: number, balanceSec: number): string {
  const { share, back, pct } = shareBack(costSec);
  return [
    `تمومه ✅ این جلسه <b>${fmtCost(costSec)}</b> شد و <b>${fmtBalance(balanceSec)}</b> برات مونده.`,
    "",
    `اگه ${toFaDigits(SHARE_TARGET)} نفر از بچه‌های کلاس هم برش دارن، سهم هرکس ` +
      `${fmtCoins(share)} میشه و <b>${fmtCoins(back)}</b> از سکه‌هات (${toFaDigits(pct)}٪) ` +
      `برمی‌گرده به حسابت 👇`,
  ].join("\n");
}
