import type { AnalysisReport } from "../analysis/schema.js";
import { config } from "../config.js";
import { chunkMessage, escapeHtml } from "../util/text.js";
import { fmtClockLink, fmtDuration, toFaDigits } from "../util/time.js";
import {
  balanceCoins, coinsAsMinutesIfUseful, costCoins,
  fmtBalance, fmtCoins, fmtCoinsWithToman, fmtCost, RATE_LINE, shareBack,
} from "../billing/coins.js";
import { BTN } from "./menu.js";

export const chunk = chunkMessage;

export const HELP = `<b>چیکار می‌کنم</b>
دیگه لازم نیست سر کلاس جزوه بنویسی. صوت کلاستو می‌گیرم، بهت می‌دم:
• 📋 خلاصهٔ کلاس در یک نگاه
• 📌 حضور و غیاب، کوییز، تکلیف با مهلت
• 🎯 هرچی به امتحان می‌خوره، با عین حرف استاد و دقیقه‌ش
• 🕘 بخش‌بندی کلاس با زمان
• 📕 جزوهٔ کامل PDF
• 📄 رونوشت کلمه‌به‌کلمه با مهر زمانی

<b>چی بفرستم</b>
صوت، ویس یا ویدیو — همین‌جا بفرست.
<b>بالای ۵۰ مگ؟</b> از «${BTN.app}» بفرست؛ تا ۵۰۰ مگ می‌گیرم.
<b>لینک؟</b> فقط لینک <b>مستقیم فایل</b> (که به mp3/mp4/m4a ختم میشه). لینک صفحهٔ ضبط جلسه یا یوتیوب و آپارات نمیشه.
گوشیو بذار رو میز نه تو کیف — نزدیک‌بودن مهم‌تر از گرون‌بودن گوشیه.

<b>سکه‌ها</b>
با سکه کار می‌کنه: <b>هر سکه یه دقیقه صوت</b>. از «${BTN.account}» موجودیت رو می‌بینی و شارژ می‌کنی.

<b>خرجش با هم‌کلاسیا نصف میشه</b>
یه جلسه یه بار پردازش میشه. سهم هر هم‌کلاسی ثابته و سکه‌ش برمی‌گرده به تو، تا نصفِ هزینه؛ بعدش برای بقیه رایگانه. بعد هر تحلیل دکمه‌شو می‌بینی.

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

<b>بازبینی کیفیت</b> — یه نسخه از صوت و تحلیلش تو یه بایگانی خصوصی می‌مونه که فقط تیم خودمون می‌بینه، برای بررسی کیفیت و رفع اشکال. جای عمومی منتشر نمی‌شه.

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
  grading: "💯 نمره و بارم",
  logistics: "📣 حواست باشه",
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

  /**
   * فقط هشدار کیفیت ضبط — چون کاربر می‌تواند دفعهٔ بعد کاری برایش بکند.
   *
   * شمارِ نکته‌های حذف‌شده (`droppedCitations`) عمداً **نمایش داده نمی‌شود**.
   * برای ما معیار مهمی است و در لاگ می‌ماند، ولی برای دانشجو فقط یک عدد
   * نگران‌کننده است دربارهٔ سازوکاری که نمی‌شناسد: «۶ نکته حذف شد» یعنی چه؟
   * یعنی ربات خراب است؟ یعنی چیزی را از دست داده‌ام؟ هیچ‌کدام — یعنی دروازه
   * کار خودش را کرده و همان چیزی که می‌ماند قابل اتکاست. حرف‌زدن از آن،
   * اعتماد را کم می‌کند نه زیاد.
   */
  if (i.qualityWarnings.length) {
    out.push("");
    out.push(`<i>ℹ️ ${escapeHtml(i.qualityWarnings[0]!)}</i>`);
  }

  return out.join("\n");
}

/** مواردی که همیشه گفته می‌شود انجام شد یا نشد — چون «نشد» هم خبر است. */
const CORE_ACTIONS = ["attendance", "quiz", "exam_info", "homework"] as const;

/**
 * جملهٔ «انجام نشد» برای هر کار.
 *
 * قبلاً یک «نه» خشک بود و قبل‌تر «نشانه‌ای پیدا نکردم». هر دو بد بودند:
 * اولی خبر را نمی‌رساند و دومی تردید ما را به دانشجو منتقل می‌کرد. دانشجویی
 * که کلاس نبوده دقیقاً همین چهار سؤال را دارد و جواب باید **قطعی** باشد،
 * وگرنه باز باید از یکی بپرسد — یعنی محصول کارش را نکرده.
 *
 * پشتوانهٔ این قطعیت واقعی است: کل رونوشت خوانده شده و هر ادعا از دروازهٔ
 * راستی‌آزمایی نقل‌قول رد شده. پس «کوییز نگرفت» یک نتیجه است، نه یک حدس.
 */
const ACTION_NEGATIVE: Record<string, string> = {
  attendance: "حضور و غیاب نکرد",
  quiz: "کوییز نگرفت",
  exam_info: "دربارهٔ امتحان چیزی نگفت",
  homework: "تکلیفی نداد",
  deadline: "مهلتی تعیین نکرد",
  grading: "دربارهٔ نمره و بارم صحبتی نکرد",
  makeup_class: "کلاس جبرانی اعلام نکرد",
  class_cancelled: "جلسه‌ای را لغو نکرد",
};

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
    const negative = ACTION_NEGATIVE[key] ?? `${label} نداشت`;
    // نبودنِ کلید در خروجی مدل هم یعنی «اتفاق نیفتاد»: کل رونوشت خوانده شده
    // و اگر رخ داده بود ثبت می‌شد. پس همان جملهٔ قطعی، نه یک حالت سومِ مبهم.
    if (a?.happened) {
      out.push(`✅ <b>${label}</b>${a.detail ? ` — ${escapeHtml(a.detail)}` : ""}`);
    } else {
      out.push(`⬜️ ${negative}`);
    }
  }
  /**
   * بقیهٔ مواردی که واقعاً اتفاق افتاده‌اند: کلاس جبرانی، نمره، لغو جلسه…
   *
   * این‌ها فقط وقتی به‌عنوان یک خط چک‌لیست می‌آیند که **در نکته‌ها نیامده
   * باشند**. از وقتی `grading` و `logistics` به نکته‌ها اضافه شدند، همان
   * واقعیت می‌تواند دو جا بنشیند: یک بار خشک و بی‌جزئیات اینجا، یک بار با
   * نقل‌قول و دقیقه آنجا. نسخهٔ پایینی همیشه بهتر است، پس بالایی کنار
   * می‌رود.
   */
  /**
   * رشتهٔ خالی نباید وارد این مجموعه شود.
   *
   * نسخهٔ قبلی هر نکتهٔ غیرِ logistics/grading را به «» نگاشت می‌کرد و همان
   * «» را داخل مجموعه می‌گذاشت. پایین‌تر هر کاری که در `ACTION_TO_KIND`
   * نبود هم به «» می‌رسید — یعنی به‌محض وجود یک نکتهٔ تکلیف در فهرست،
   * موردِ «سایر» پوشش‌داده‌شده حساب می‌شد و بی‌صدا حذف. دقیقاً همان چیزی که
   * می‌خواستیم رفعش کنیم، از یک نگاشتِ پیش‌فرض برمی‌گشت.
   */
  const coveredByPoints = new Set<string>(
    r.key_points.filter((k) => k.kind === "logistics" || k.kind === "grading").map((k) => k.kind),
  );
  const ACTION_TO_KIND: Record<string, string> = {
    grading: "grading",
    makeup_class: "logistics",
    class_cancelled: "logistics",
  };
  for (const a of r.professor_actions) {
    if (CORE_ACTIONS.includes(a.action as (typeof CORE_ACTIONS)[number])) continue;
    if (!a.happened) continue;
    const kind = ACTION_TO_KIND[a.action];
    if (kind && coveredByPoints.has(kind)) continue;
    /**
     * «سایر» هم چاپ می‌شود، و این عوض شد.
     *
     * پیش‌تر بی‌صدا کنار می‌رفت، و مدل از آن به‌عنوان درِ فرار استفاده می‌کرد:
     * در پنج جلسهٔ واقعی، «استاد بر لزوم تهیهٔ کتاب قانون تأکید کرد» در
     * «سایر» نشست و ناپدید شد، در حالی که چک‌لیست بالای همان پیام می‌گفت
     * «تکلیفی نداد». هر چیزی که شاهد تأییدشده دارد باید به دانشجو برسد —
     * برچسبِ نامناسب دلیلِ حذف نیست.
     */
    const label = a.action === "other" ? "نکتهٔ دیگر" : (ACTION_LABEL[a.action] ?? a.action);
    out.push(`✅ <b>${label}</b>${a.detail ? ` — ${escapeHtml(a.detail)}` : ""}`);
  }

  const points = sortedKeyPoints(r);
  /**
   * فهرست خالی باید **توضیح داده شود**، نه اینکه فقط نباشد.
   *
   * سخت‌گیری راستی‌آزمایی یعنی «هیچ نکته‌ای» نتیجهٔ کاملاً محتملی است و برای
   * آن جلسه هم درست است. ولی کاربری که سکه داده و فهرست خالی می‌بیند فرض
   * می‌کند ربات کار نکرده، نه اینکه استاد نکته‌ای نگفته. تفاوت این دو را
   * فقط ما می‌دانیم، پس باید بگوییم.
   */
  if (!points.length) {
    out.push("");
    out.push("🎯 <b>این جلسه نکتهٔ خاصی نداشت.</b>");
    out.push(
      "<i>کل کلاس رو گوش دادم؛ استاد نه از امتحان و نمره گفت، نه تکلیفی داد، " +
        "نه تصمیم تازه‌ای اعلام کرد. فقط درس داد.</i>",
    );
  }
  if (points.length) {
    out.push("");
    out.push("<b>نکته‌ها</b>");
    for (const k of points) {
      out.push("");
      /**
       * زمان **بیرون از** نقل‌قول بازشونده می‌آید.
       *
       * پیش‌تر ته همان بلوکِ جمع‌شونده بود، و تلگرام داخلِ نقل‌قول زمان را به
       * لینکِ پخش تبدیل نمی‌کند — پس هیچ‌کدام از این زمان‌ها زدنی نبودند، در
       * حالی که کلِ ارزشِ «عین حرف استاد، دقیقهٔ فلان» همین است که بشود
       * شنیدش. حالا کنارِ عنوان است، بی‌قالب و در خطِ خودش.
       */
      out.push(
        `${KP_LABEL[k.kind] ?? "•"} <b>${escapeHtml(k.title)}</b>` +
          (k.due ? ` — مهلت: ${escapeHtml(k.due)}` : ""),
      );
      out.push(fmtClockLink(k.evidence.at_ms));
      const inner: string[] = [];
      if (k.detail.trim()) inner.push(escapeHtml(k.detail.trim()));
      inner.push(`«${escapeHtml(trimQuote(k.evidence.quote))}»`);
      out.push(`<blockquote expandable>${inner.join("\n\n")}</blockquote>`);
    }
  }

  return out.join("\n");
}

/**
 * ترتیب نمایش، بر اساس «چقدر فوری است».
 *
 * اول چیزهایی که مهلت یا اقدام دارند (امتحان، مهلت، تکلیف، کاری که باید
 * بکند)، بعد اطلاعات نمره، و آخر تأکیدهای درسی که فوریت ندارند و برای
 * وقت مطالعه‌اند.
 */
function sortedKeyPoints(r: AnalysisReport) {
  const order: Record<string, number> = {
    exam: 0, deadline: 1, homework: 2, logistics: 3, grading: 4, emphasis: 5,
  };
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
 *
 * ## چرا زمان از کنارِ عنوان برداشته شد و نقل‌قول بازشونده رفت
 *
 * دو چیز خراب بود و هر دو را کاربر روی خروجی واقعی دید.
 *
 * **یک: زمان دوبار می‌آمد.** سرِ عنوانِ بخش `00:00` بود و اولین ریزه‌کاریِ
 * همان بخش هم `00:00` — چون ریزه‌کاریِ اول عملاً از شروعِ همان بخش است. یک
 * عدد، دو بار، پشت سر هم.
 *
 * **دو: فقط اولین زمان در تلگرام زدنی بود.** ریزه‌کاری‌ها داخل
 * `blockquote expandable` بودند و تلگرام داخلِ نقل‌قول زمان را به لینکِ پخش
 * تبدیل نمی‌کند. یعنی همان چیزی که این پیام برایش ساخته شده — «بیست دقیقهٔ
 * خاصی را گوش بده» — برای همهٔ بخش‌ها جز اولی کار نمی‌کرد.
 *
 * پس حالا عنوان زمان ندارد و زمان‌ها **خطِ ساده و بی‌قالب** زیر عنوان
 * می‌آیند: نه نقل‌قول، نه پررنگ، نه کج. زمان اولِ خط است، که مطمئن‌ترین جا
 * برای تشخیصِ تلگرام است.
 *
 * بهایش این است که پیام بلندتر می‌شود — ریزه‌کاری‌ها دیگر جمع نمی‌شوند. آن
 * جمع‌شدن ارزشش را داشت وقتی زمان‌ها کار می‌کردند؛ حالا که نمی‌کردند، خودِ
 * قابلیت مهم‌تر از کوتاهیِ پیام است.
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
      `${KIND_EMOJI[c.kind] ?? "▫️"} <b>${escapeHtml(title)}</b>` +
        (span >= 60_000 ? ` · <i>${fmtDuration(span)}</i>` : ""),
    );

    /**
     * زیر هر عنوان دست‌کم **یک** زمانِ زدنی باید باشد، وگرنه آن بخش راهِ
     * ورودی ندارد. اگر ریزه‌کاری‌ای نبود یا اولینش خیلی دیرتر از شروعِ بخش
     * بود، خودِ شروعِ بخش هم می‌آید.
     */
    const parts = c.parts.filter((p) => p.label.trim());
    const lines = parts.map((p) => `${fmtClockLink(p.at_ms)}  ${escapeHtml(p.label.trim())}`);
    if (!parts.length) {
      lines.unshift(`${fmtClockLink(c.start_ms)}  شروع این بخش`);
    } else if (parts[0]!.at_ms - c.start_ms > 60_000) {
      lines.unshift(`${fmtClockLink(c.start_ms)}  شروع این بخش`);
    }
    out.push(...lines);
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
  }\n\n<i>می‌تونی ببندیش — نتیجه همین‌جا توی ربات برات میاد.</i>`;
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
/**
 * صفحهٔ حساب.
 *
 * خطوط خالی **بین گروه‌ها** گذاشته می‌شوند نه داخلشان، چون هر سه سطر آمار
 * اختیاری‌اند: کاربر تازه هیچ‌کدام را ندارد و اگر خط خالی از قبل نوشته شده
 * باشد، دو خط خالی پشت‌سرهم می‌افتد. `join` روی گروه‌های ناخالی، این را
 * ساختاری حل می‌کند به‌جای اینکه به ترتیب `push`ها بند باشد.
 *
 * معادلِ دقیقه‌ایِ موجودی هم با نرخ ۱ حذف می‌شود — عینِ همان عدد است.
 */
export function accountMessage(i: AccountInput): string {
  const coins = balanceCoins(i.creditSec);
  const asTime = coinsAsMinutesIfUseful(coins);

  const stats: string[] = [];
  if (i.sessionCount > 0) stats.push(`📚 ${toFaDigits(i.sessionCount)} جلسه فرستاده‌ای`);
  if (i.usedSec > 0) stats.push(`💸 تا حالا ${fmtCost(i.usedSec)} خرج کرده‌ای`);
  if (i.refundedSec > 0) stats.push(`💰 ${fmtCost(i.refundedSec)} از اشتراک‌گذاری برگشته بهت`);

  const groups = [
    ["🪙 <b>حساب من</b>"],
    [
      `موجودی: <b>${fmtCoins(coins)}</b>`,
      ...(asTime ? [`<i>یعنی حدود ${asTime}</i>`] : []),
    ],
    ...(stats.length ? [stats] : []),
    [`<i>${RATE_LINE}.</i>`],
  ];
  return groups.map((g) => g.join("\n")).join("\n\n");
}

/** پیام «سکه کم است» — همه‌جا یک شکل، و همیشه با راه خروج. */
/**
 * تأیید پیش از خرج‌کردن سکه.
 *
 * ## چرا این سؤال، برخلاف دو سؤالِ حذف‌شده، می‌ماند
 *
 * پیش‌تر بین «فایل را فرستادم» و «کار شروع شد» دو سؤال بود — کدام درس، و
 * جزوه می‌خواهی یا نه — و هر دو حذف شدند چون کاربر تازه‌وارد جوابشان را
 * **نمی‌داند** و هر سؤال یک جای رهاکردن است.
 *
 * این سؤال از آن جنس نیست: جوابش را کاربر می‌داند، و موضوعش پولِ خودش است.
 * بدون آن، فرستادنِ یک فایل ۹۰ دقیقه‌ای یعنی ۹۰ سکه کسر شود بی‌آنکه کسی
 * پرسیده باشد — و کاربر عدد را اولین بار در صورت‌حساب ببیند.
 *
 * موجودیِ پس از کسر هم نوشته می‌شود، چون سؤال بعدیِ همه همان است.
 */
export function confirmCostMessage(neededSec: number, balanceSec: number): string {
  const after = Math.max(0, balanceSec - neededSec);
  return [
    "فایلت رسید ✅",
    "",
    `مدت: <b>${toFaDigits(fmtDuration(neededSec * 1000))}</b>`,
    `هزینه: <b>${fmtCoinsWithToman(costCoins(neededSec))}</b>`,
    `موجودی الان: <b>${fmtBalance(balanceSec)}</b> · بعدش: <b>${fmtBalance(after)}</b>`,
    "",
    "<i>شروع کنم؟</i>",
  ].join("\n");
}

export function lowBalanceMessage(neededSec: number, balanceSec: number): string {
  return [
    "سکه‌هات کم میاد 😅",
    "",
    `این کار <b>${fmtCoinsWithToman(costCoins(neededSec))}</b> می‌خواد ولی ` +
      `<b>${fmtBalance(balanceSec)}</b> داری.`,
    "",
    `از «${BTN.account}» شارژ کن.`,
  ].join("\n");
}

/**
 * پیشنهاد پس از اجرای رایگان.
 *
 * کاربر همین الان دیده که چقدر دقیق می‌شنویم — و آن سؤال جواب گرفته. سؤال
 * بعدی‌اش «حالا از این متن چی درمیاد؟» است، که تور نمونه پس از `/start`
 * جوابش را داده. پس اینجا فهرست را **کوتاه** یادآوری می‌کنیم و می‌رویم سر
 * قیمت؛ تکرار کاملِ فهرست فقط پیام را طولانی می‌کند.
 *
 * قیمت با معادل تومانی می‌آید: «۶۳۰ سکه» به‌تنهایی یعنی یک کلیک دیگر تا
 * صفحهٔ شارژ برای فهمیدن عدد واقعی، و همان کلیک جایی است که آدم‌ها می‌روند.
 */
export function upsellMessage(costSec: number): string {
  const { cap } = shareBack(costSec);
  return [
    "☝️ <b>این متنِ خام کلاسته.</b> دیدی چقدر دقیق می‌شنوم؟",
    "",
    "حالا با سکه، از همین متن اینا رو درمی‌آرم — همونایی که اول کار نمونه‌شو دیدی:",
    "",
    "📋 خلاصهٔ کلاس · 📌 حضور و غیاب، کوییز، تکلیف",
    "🎯 نکته‌های امتحانی با عین جملهٔ استاد · 🕘 بخش‌بندی کلاس",
    "📕 جزوهٔ کامل PDF",
    "",
    `تحلیل کامل همین جلسه: <b>${fmtCoinsWithToman(costCoins(costSec))}</b>`,
    "",
    `💰 <b>ولی لازم نیست همه‌شو خودت بدی.</b> جزوه رو برای بچه‌های کلاس بفرست — ` +
      `هر کی برش داره سکه‌ش برمی‌گرده به حساب تو، تا نصفِ هزینه (<b>${fmtCoins(cap)}</b>) جبران شه. ` +
      `بعدش برای بقیه رایگانه.`,
  ].join("\n");
}

/** پیام پایانی هر جلسهٔ کامل: چقدر رفت، چقدر مانده، و چطور برمی‌گردد. */
export function settlementMessage(costSec: number, balanceSec: number): string {
  const { cap } = shareBack(costSec);
  return [
    `تمومه ✅ این جلسه <b>${fmtCost(costSec)}</b> شد و <b>${fmtBalance(balanceSec)}</b> برات مونده.`,
    "",
    `جزوه رو با هم‌کلاسیا تقسیم کن: هر کی برش داره سکه‌ش برمی‌گرده به حساب تو، ` +
      `تا نصفِ هزینه (<b>${fmtCoins(cap)}</b>) جبران شه. بعدش برای بقیه رایگانه 👇`,
  ].join("\n");
}

/**
 * پرسشِ «چند نفر؟» پیش از ساختنِ لینکِ دعوت.
 *
 * سهمِ ثابتِ هر نفر از همین انتخاب درمی‌آید، پس عمداً ساده و کوتاه است.
 * گزینهٔ «۱ نفر» یعنی همان یک نفر نصفِ هزینه را می‌دهد و کامل به مالک
 * برمی‌گردد.
 */
export function shareTargetPrompt(costSec: number): string {
  const { cap } = shareBack(costSec, 1);
  return [
    "برای چند نفر دیگه می‌خوای بفرستی؟",
    "",
    `<i>سهم هر نفر از همین‌جا معلوم می‌شه. با «۱ نفر»، همون یک نفر نصفِ هزینه ` +
      `(${fmtCoins(cap)}) رو می‌ده و کامل برمی‌گرده به تو.</i>`,
  ].join("\n");
}
