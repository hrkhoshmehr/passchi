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

/** نسبت هم‌پوشانی توکن‌های نقل‌قول با یک پنجرهٔ متن (۰..۱) */
export function containmentScore(quote: string, haystackNorm: string): number {
  const q = normalizeFa(quote);
  if (!q) return 0;
  if (haystackNorm.includes(q)) return 1;
  const qt = q.split(" ");
  if (qt.length === 0) return 0;
  let hit = 0;
  for (const t of qt) if (t.length > 1 && haystackNorm.includes(t)) hit++;
  return hit / qt.length;
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
