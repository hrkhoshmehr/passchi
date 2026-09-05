import { randomBytes } from "node:crypto";

/**
 * نرمال‌سازی متن فارسی برای «تطبیق نقل‌قول».
 * هدف: تشخیص اینکه جمله‌ای که مدل به‌عنوان نقل‌قول برگردانده، واقعاً در رونوشت هست یا نه.
 */
const MAP: Record<string, string> = {
  "ي": "ی", "ك": "ک", "ﮐ": "ک", "ۀ": "ه", "ة": "ه", "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
  "ؤ": "و", "ئ": "ی", "٪": "%", "،": ",", "؛": ";", "؟": "?", "«": '"', "»": '"',
  "ٔ": "", "ٰ": "",
};

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export function normalizeFa(input: string): string {
  let s = input.normalize("NFKC");
  s = s.replace(/[ً-ْٰـ]/g, ""); // اعراب و کشیده
  // نیم‌فاصله باید *حذف* شود نه تبدیل به فاصله: رونوشت خودکار گاهی «می‌خونم»
  // می‌نویسد و مدل «میخونم» نقل می‌کند. با حذف، هر دو به یک رشته می‌رسند.
  s = s.replace(/‌/g, "");
  s = s.replace(/[​‍-‏‪-‮⁦-⁩]/g, " "); // کنترل‌های جهت
  s = s.replace(/./g, (ch) => {
    if (MAP[ch] !== undefined) return MAP[ch];
    const fa = FA_DIGITS.indexOf(ch);
    if (fa >= 0) return String(fa);
    const ar = AR_DIGITS.indexOf(ch);
    if (ar >= 0) return String(ar);
    return ch;
  });
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " "); // نقطه‌گذاری را دور بریز
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function tokens(s: string): string[] {
  const n = normalizeFa(s);
  return n ? n.split(" ") : [];
}

/**
 * بلندترین زیردنبالهٔ مشترک بین دو آرایهٔ توکن — تطبیقِ **ترتیب‌دار**.
 * مقایسه برابریِ کامل توکن است، نه زیررشته.
 */
function lcsLength(a: string[], b: string[]): number {
  // فقط دو ردیف نگه داشته می‌شود؛ برای پاره‌گفتارهای کوتاه کاملاً کافی است.
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length]!;
}

/**
 * چند جفتِ **مجاورِ** نقل‌قول، در متن هم مجاور و به همان ترتیب آمده‌اند.
 *
 * یک توکنِ فاصله تحمل می‌شود (`MAX_GAP`)، چون رونوشتِ خودکار گاهی کلمهٔ پرکننده
 * («خب»، «یعنی») را نگه می‌دارد که مدل در نقل‌قول نیاورده. بیشتر از آن دیگر
 * «همان جمله» نیست.
 */
function adjacencyRatio(qt: string[], ht: string[]): number {
  const MAX_GAP = 2;
  const pairs = qt.length - 1;
  if (pairs <= 0) return ht.includes(qt[0]!) ? 1 : 0;

  const at = new Map<string, number[]>();
  ht.forEach((t, i) => {
    const list = at.get(t);
    if (list) list.push(i);
    else at.set(t, [i]);
  });

  let hit = 0;
  for (let k = 0; k < pairs; k++) {
    const first = at.get(qt[k]!);
    const second = at.get(qt[k + 1]!);
    if (!first || !second) continue;
    if (first.some((i) => second.some((j) => j > i && j - i <= MAX_GAP))) hit++;
  }
  return hit / pairs;
}

/**
 * چقدر این نقل‌قول واقعاً همان جمله‌ای است که در متن گفته شده (۰..۱).
 *
 * ## چرا شمارشِ کلمه کافی نیست
 *
 * نسخهٔ اول فقط می‌شمرد چند کلمهٔ نقل‌قول *جایی* در متن پیدا می‌شود — بدون
 * ترتیب، بدون مجاورت، و با `includes` که زیررشته را هم قبول می‌کرد. نتیجه
 * روی یک نمونهٔ واقعی:
 *
 *     پاره‌گفتار: «…این قسمت رو که گفتم توی جزوه هست و از اون فصل هم یه چیزایی میاد»
 *     نقل‌قول جعلی: «این رو که گفتم از اون فصل توی امتحان میاد»  →  ۰٫۹۰، پذیرفته
 *
 * کلمهٔ «امتحان» هرگز گفته نشده بود و تنها کلمهٔ ناموفق هم همان بود — یعنی
 * دقیقاً همان کلمه‌ای که کل ادعا رویش سوار است. `includes` هم «علم» را داخل
 * «معلم» پیدا می‌کرد.
 *
 * ## قاعدهٔ فعلی
 *
 * کمینهٔ دو سنجه، تا هیچ‌کدام به‌تنهایی نتواند نمره را بالا ببرد:
 *
 * • **ترتیب** — نسبت بلندترین زیردنبالهٔ مشترک. جابه‌جایی کلمه‌ها را می‌گیرد.
 * • **مجاورت** — نسبت جفت‌های مجاور. کلمهٔ *افزوده* را می‌گیرد، که سنجهٔ اول
 *   تنبیهش نمی‌کند.
 *
 * روی همان نمونهٔ جعلی: ترتیب ۰٫۸۰ ولی مجاورت ۰٫۵۶ → رد.
 */
export function containmentScore(quote: string, haystackNorm: string): number {
  const q = normalizeFa(quote);
  if (!q) return 0;
  // مرزِ کلمه لازم است، وگرنه «علم» داخل «معلم» نمرهٔ کامل می‌گیرد.
  if (` ${haystackNorm} `.includes(` ${q} `)) return 1;
  const qt = q.split(" ").filter(Boolean);
  if (qt.length === 0) return 0;
  const ht = haystackNorm.split(" ").filter(Boolean);
  if (ht.length === 0) return 0;

  const order = lcsLength(qt, ht) / qt.length;
  if (order === 0) return 0;
  return Math.min(order, adjacencyRatio(qt, ht));
}

/** بریدن متن برای پیام تلگرام (سقف ۴۰۹۶ کاراکتر) */
export function chunkMessage(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > limit) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * HTML را به متن ساده برمی‌گرداند — برای سکویی که قالب‌بندی ندارد.
 *
 * بله `parse_mode` را می‌پذیرد ولی **نادیده می‌گیرد**: نه HTML، نه Markdown، و
 * نه `entities`. آزمونش این بود که همان متن با تگ‌های دست‌نخورده در پاسخ
 * `sendMessage` برمی‌گشت. یعنی کاربر بله عیناً `<b>` را می‌دید.
 *
 * پس تگ‌ها حذف می‌شوند نه اینکه رها شوند. ترتیب کار مهم است: اول تگ‌ها
 * برداشته می‌شوند و **بعد** موجودیت‌ها باز می‌گردند، وگرنه متنی که کاربر
 * نوشته و شامل `&lt;b&gt;` است به یک تگ واقعی تبدیل می‌شود و باز هم حذف
 * می‌گردد — یعنی محتوای کاربر بی‌صدا ناپدید می‌شود.
 */
export function htmlToPlain(s: string): string {
  return s
    // <br> و </p> مرز خط‌اند؛ بدون این، بندها به هم می‌چسبند.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // `&amp;` آخر از همه، وگرنه `&amp;lt;` دو مرحله باز می‌شود و `<` می‌دهد.
    .replace(/&amp;/g, "&");
}

/**
 * شناسهٔ کوتاه جلسه — دوازده رقم شانزده‌شانزدهی.
 *
 * پیش‌تر داخل `bot/index.ts` تعریف شده بود؛ با آمدن مسیر وب که آن هم جلسه
 * می‌سازد، به اینجا آمد تا هر دو از یک فضای شناسه استفاده کنند.
 */
export function shortId(): string {
  return randomBytes(6).toString("hex");
}

/**
 * رونوشت به شکل بایت‌های یک فایل `.txt` — با علامت ترتیب بایت.
 *
 * محتوا فارسی است و UTF-8، ولی فایلِ متنی خودش **نمی‌گوید** با چه رمزگذاری‌ای
 * نوشته شده؛ هر نمایشگری باید حدس بزند. حدس‌زن‌های دسکتاپ خوب‌اند و حدس‌زن‌های
 * موبایل نه — همان‌جا که فایل به یک برنامهٔ دلخواهِ سیستم سپرده می‌شود و آن
 * برنامه ممکن است رمزگذاری پیش‌فرضِ سیستم را بردارد و متن را به هم بریزد.
 *
 * سه بایتِ `EF BB BF` اول فایل آن حدس را حذف می‌کند. در هر نمایشگرِ امروزی
 * نامرئی است، پس هزینه‌ای ندارد.
 *
 * ⚠️ این فقط **اعلامِ رمزگذاری** را درست می‌کند. اگر گوشی اصلاً برنامه‌ای
 * برای باز کردن `text/plain` نداشته باشد، فایل باز نمی‌شود و این کمکی
 * نمی‌کند — آن مسئلهٔ جداست.
 */
export function transcriptBytes(text: string): Buffer {
  // بایت‌ها صریح نوشته می‌شوند نه با خودِ کاراکتر: یک نویسهٔ نامرئی در کد،
  // اولین چیزی است که در ویرایش بعدی بی‌سر و صدا گم می‌شود.
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
}
