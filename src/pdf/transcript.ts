/**
 * رونوشتِ خواندنی — بدون مهر زمانی، و پیوسته تا جایی که کسی حرف را نبرد.
 *
 * ## چرا PDF و نه فایل متنی
 *
 * رونوشت همیشه یک `.txt` سالمِ UTF-8 بوده و مسیرِ رسیدنش هم سالم است. روی
 * بله آزموده شد: هر پنج ترکیبِ ممکن — با BOM و بی BOM، با
 * `application/octet-stream` و با `text/plain; charset=utf-8`، با نام فارسی
 * و لاتین — همگی با `mime: text/plain; charset=utf-8` ثبت شدند. یعنی فایل
 * درست است و رمزگذاری‌اش هم **صریح اعلام شده**، و باز هم روی گوشی ناخوانا
 * بود. نمایشگرِ سکو نه آن اعلام را می‌خواند و نه BOM را.
 *
 * PDF این را دور می‌زند چون **قلم و رمزگذاری هر دو داخل خودِ فایل سفر
 * می‌کنند**: همان وزیرمتنی که در جزوه جاسازی می‌شود.
 *
 * ## چرا بدون زمان
 *
 * این فایل برای *خواندن* است، و دانشجو نمی‌خواهد بداند ثانیهٔ ۹۴۷ چه گفته
 * شد؛ می‌خواهد حرف استاد را پشت سر هم بخواند. مهر زمانی روی هر خط، متن را
 * به یک جدولِ بریده‌بریده تبدیل می‌کرد که چشم رویش نمی‌ماند.
 *
 * آن اطلاعات از بین نمی‌رود — به فایل زیرنویس (`renderSrt`) می‌رود، که کارش
 * دقیقاً همین است.
 *
 * ## چرا پیوسته
 *
 * موتور رونویسی با هر مکث پاره‌گفتار تازه می‌سازد، پس یک سخنرانیِ پیوسته به
 * صدها تکه خرد می‌شود. `toTurns` آنها را دوباره به هم می‌چسباند و فقط جایی
 * می‌بُرد که واقعاً گوینده عوض شده باشد.
 */
import { buildFontCss } from "./assets.js";
import { escapeHtml } from "../util/text.js";
import { htmlToPdf } from "./render.js";
import type { Turn } from "../stt/transcript.js";

/**
 * نوبتِ بلند به بند شکسته می‌شود.
 *
 * یک استاد می‌تواند بیست دقیقه بی‌وقفه حرف بزند؛ آن نوبت اگر یک بلوکِ
 * دوهزارکلمه‌ای بماند همان‌قدر نخواندنی است که تکه‌تکه بودن. پس در مرزِ
 * **جمله** بند تازه می‌گیرد — نه وسط جمله، و نه با شکستنِ خودِ نوبت: گوینده
 * یکی است و فقط نفَسِ خواندن جدا می‌شود.
 */
const PARA_CHARS = 900;

function paragraphs(text: string): string[] {
  const sentences = text.split(/(?<=[.؟!…])\s+/);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length > PARA_CHARS) {
      out.push(buf);
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function turnsHtml(turns: Turn[]): string {
  return turns
    .map((t) => {
      const paras = paragraphs(t.text.trim()).filter(Boolean);
      if (!paras.length) return "";
      // نام گوینده فقط روی بند اول می‌آید؛ تکرارش روی هر بند یعنی همان
      // شلوغی‌ای که با حذف مهر زمانی از آن فرار کردیم.
      return (
        `<section class="turn">` +
        paras
          .map((p, i) =>
            i === 0
              ? `<p><span class="who">${escapeHtml(t.who)}</span>${escapeHtml(p)}</p>`
              : `<p>${escapeHtml(p)}</p>`,
          )
          .join("") +
        `</section>`
      );
    })
    .join("\n");
}

export interface TranscriptDoc {
  sessionTitle: string;
  courseName: string | null;
  sessionDate: string | null;
  turns: Turn[];
}

export function buildTranscriptHtml(doc: TranscriptDoc): string {
  const sub = [doc.courseName, doc.sessionDate].filter(Boolean).map((s) => escapeHtml(s!)).join(" · ");
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head><meta charset="utf-8"><title>${escapeHtml(doc.sessionTitle)}</title>
<style>
${buildFontCss()}
@page { size: A4; margin: 18mm 16mm 20mm; }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Vazirmatn",system-ui,sans-serif;font-weight:400;color:#1a202c;
  background:#fff;font-size:11pt;line-height:2.05;text-align:justify}
@media screen { html body { max-width:210mm; margin:0 auto; padding:18mm 16mm; } }
h1{font-size:16pt;margin:0 0 2px;font-weight:700;text-align:right}
.sub{color:#718096;font-size:9.5pt;margin:0 0 16px;text-align:right}
hr{border:0;border-top:1px solid #e2e8f0;margin:0 0 18px}
/* فاصلهٔ بین نوبت‌ها بیشتر از بین بندهاست: مرزِ «کسی حرف را برید» باید
   از مرزِ «نفس تازه» پررنگ‌تر دیده شود. */
.turn{margin:0 0 14px}
.turn p{margin:0 0 8px}
.who{font-weight:700;color:#2f855a}
.who::after{content:"، "}
</style></head>
<body>
<h1>${escapeHtml(doc.sessionTitle)}</h1>
${sub ? `<p class="sub">${sub}</p>` : ""}
<hr>
${turnsHtml(doc.turns)}
</body></html>`;
}

export async function renderTranscriptPdf(doc: TranscriptDoc, outFile: string): Promise<string> {
  return htmlToPdf(buildTranscriptHtml(doc), outFile);
}
