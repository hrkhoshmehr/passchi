import MarkdownIt from "markdown-it";
import katex from "katex";
import { buildFontCss } from "./assets.js";
import { escapeHtml } from "../util/text.js";
import { fmtDuration, toFaDigits } from "../util/time.js";
import type { AnalysisReport } from "../analysis/schema.js";

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });

/**
 * markdown-it فقط ارقام لاتین را به‌عنوان نشانهٔ لیست شماره‌دار می‌شناسد.
 * مدل معمولاً «۱.» می‌نویسد و آن‌وقت کل لیست به یک پاراگراف چسبیده تبدیل می‌شود.
 * اینجا فقط نشانهٔ ابتدای خط را به لاتین برمی‌گردانیم؛ شماره‌ها با
 * list-style-type: persian دوباره فارسی نمایش داده می‌شوند.
 */
function normalizeListMarkers(src: string): string {
  const FA = "۰۱۲۳۴۵۶۷۸۹";
  const AR = "٠١٢٣٤٥٦٧٨٩";
  return src.replace(/^(\s*)([۰-۹٠-٩]+)([.)])\s/gm, (_m, indent: string, num: string, dot: string) => {
    const latin = [...num]
      .map((ch) => {
        const i = FA.indexOf(ch);
        if (i >= 0) return String(i);
        const j = AR.indexOf(ch);
        return j >= 0 ? String(j) : ch;
      })
      .join("");
    return `${indent}${latin}${dot} `;
  });
}

/** $...$ و $$...$$ را با KaTeX رندر می‌کند (سمت سرور، بدون جاوااسکریپت در صفحه). */
function renderMath(html: string): string {
  const render = (tex: string, display: boolean) => {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" });
    } catch {
      return `<code>${escapeHtml(tex)}</code>`;
    }
  };
  return html
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => render(tex.trim(), true))
    .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_m, pre: string, tex: string) => pre + render(tex.trim(), false));
}

export interface NoteDocument {
  courseName: string | null;
  professorName: string | null;
  sessionDate: string | null;
  sessionTitle: string;
  durationMs: number;
  report: AnalysisReport;
  notesMarkdown: string;
  generatedAt: Date;
}

function glossaryHtml(r: AnalysisReport): string {
  if (r.glossary.length === 0) return "";
  return `<table class="gloss"><thead><tr><th>اصطلاح</th><th>معادل</th><th>تعریف</th></tr></thead><tbody>${r.glossary
    .map(
      (g) =>
        `<tr><td><b>${escapeHtml(g.term)}</b></td><td dir="ltr">${escapeHtml(
          g.english ?? "—",
        )}</td><td>${escapeHtml(g.definition)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

/**
 * نقل‌قول‌های «نکتهٔ امتحانی» را از نقل‌قول معمولی جدا می‌کند.
 *
 * جزوه دیگر بخش جداگانه‌ای برای امتحان ندارد — نکته همان‌جا می‌آید که مبحثش
 * آمده. برای اینکه چشم در یک صفحهٔ پر از متن پیدایش کند، فقط رنگش فرق می‌کند.
 * markdown-it کلاسی روی blockquote نمی‌گذارد، پس روی خروجی‌اش برچسب می‌زنیم.
 */
function markHighlights(html: string): string {
  return html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (m, inner: string) => {
    if (inner.includes("در امتحان می‌آید")) return `<blockquote class="exam">${inner}</blockquote>`;
    if (inner.includes("تأکید استاد")) return `<blockquote class="emph">${inner}</blockquote>`;
    return m;
  });
}

export function buildHtml(doc: NoteDocument): string {
  const r = doc.report;
  const body = markHighlights(
    renderMath(md.render(normalizeListMarkers(doc.notesMarkdown || "_جزوه‌ای تولید نشد._"))),
  );
  const fa = (n: string | number) => toFaDigits(n);

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.sessionTitle)}</title>
<style>
${buildFontCss()}

:root{
  --ink:#161a1d; --dim:#6b7280; --line:#e3e6ea; --paper:#fff;
  --accent:#1f6feb; --accent-soft:#eef4ff;
  --teach:#2f855a; --qa:#3182ce; --admin:#d69e2e; --off:#e53e3e; --tech:#805ad5; --brk:#a0aec0;
}
@page { size: A4; margin: 18mm 16mm 20mm; }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:"Vazirmatn",system-ui,sans-serif; font-weight:400;
  color:var(--ink); background:var(--paper);
  font-size:10.5pt; line-height:1.95; text-align:justify;
  font-variant-numeric: proportional-nums;
}
/* حاشیهٔ @page فقط هنگام چاپ اعمال می‌شود؛ پیش‌نمایش HTML حاشیهٔ خودش را لازم دارد */
@media screen { html body { max-width: 210mm; margin: 0 auto; padding: 18mm 16mm; } }

/* KaTeX در بافت RTL بدون این دو خط آینه می‌شود: کل رابطه از راست به چپ
   چیده می‌شود و مثلاً ∇f به f∇ تبدیل می‌شود. isolate جریان دوجهته را قطع می‌کند. */
.katex{font-size:1.02em;direction:ltr;unicode-bidi:isolate;text-align:left}
.katex-display{margin:.9em 0;direction:ltr;unicode-bidi:isolate;text-align:center}
.katex-display>.katex{display:block;text-align:center}

/* ── جلد ─────────────────────────────────────────────── */
.cover{ break-after:page; padding-top:22mm }
.cover .kicker{color:var(--accent);font-weight:700;letter-spacing:.02em;font-size:11pt}
.cover h1{font-size:26pt;line-height:1.4;margin:.25em 0 .1em;font-weight:800}
.cover h2{font-size:13pt;font-weight:500;color:var(--dim);margin:0 0 1.6em}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:.5em 1.5em;margin:1.4em 0;
  border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:1em 0}
.meta div{font-size:10pt}
.meta b{color:var(--dim);font-weight:500;margin-left:.4em}

.headline{background:var(--accent-soft);border-right:3px solid var(--accent);
  padding:1em 1.2em;border-radius:4px;font-size:12pt;font-weight:600;margin:1.4em 0}
.recap{font-size:11pt;line-height:2.05;margin:.6em 0 1.2em}

/* ── عناوین ──────────────────────────────────────────── */
h1,h2,h3,h4{line-height:1.6;font-weight:700;break-after:avoid}
h2{font-size:15pt;margin:1.9em 0 .6em;padding-bottom:.3em;border-bottom:2px solid var(--line)}
h3{font-size:12.5pt;margin:1.4em 0 .4em;color:#22303c}
h4{font-size:11pt;margin:1.1em 0 .3em}
p{margin:.55em 0}
ul,ol{padding-right:1.3em;margin:.5em 0}
ol{list-style-type:persian}
li{margin:.3em 0}
blockquote{margin:.9em 0;padding:.7em 1em;background:#f7f9fb;border-right:3px solid var(--line);
  border-radius:4px;font-size:10pt}
/* نکتهٔ امتحانی قرمز است و تأکید استاد کهربایی — تنها دو چیزی که در جزوه
   حق دارند از متن بیرون بزنند. */
blockquote.exam{background:#fff5f5;border-right-color:#e53e3e}
blockquote.exam strong{color:#c53030}
blockquote.emph{background:#fffbea;border-right-color:#d69e2e}
blockquote.emph strong{color:#975a16}
blockquote p{margin:.2em 0}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;background:#f4f6f8;
  padding:.1em .35em;border-radius:3px;direction:ltr;display:inline-block}
pre{background:#f4f6f8;padding:.8em 1em;border-radius:6px;overflow-x:auto;direction:ltr;text-align:left}
pre code{background:none;padding:0}
hr{border:none;border-top:1px solid var(--line);margin:1.6em 0}

table{width:100%;border-collapse:collapse;margin:.9em 0;font-size:9.8pt;break-inside:avoid}
th,td{border:1px solid var(--line);padding:.5em .65em;text-align:right;vertical-align:top}
th{background:#f7f9fb;font-weight:600;color:#3d4852}

/* ── جدول واژه‌نامه ───────────────────────────────────── */
.gloss td:first-child{width:24%}
.gloss td:nth-child(2){width:24%;direction:ltr;text-align:left;font-size:9.2pt}

.dim{color:var(--dim);font-size:9.5pt}
.section{break-before:page}
.note{margin-top:2.4em;padding-top:.8em;border-top:1px solid var(--line);
  font-size:8.5pt;color:var(--dim);line-height:1.8}
</style>
</head>
<body>

<section class="cover">
  <div class="kicker">جزوهٔ جلسه — تولیدشده از صوت کلاس</div>
  <h1>${escapeHtml(doc.sessionTitle)}</h1>
  <h2>${escapeHtml(doc.courseName ?? r.course_guess ?? "درس نامشخص")}</h2>

  <div class="meta">
    <div><b>استاد:</b>${escapeHtml(doc.professorName ?? "نامشخص")}</div>
    <div><b>تاریخ جلسه:</b>${escapeHtml(doc.sessionDate ?? "نامشخص")}</div>
    <div><b>مدت صوت:</b>${fmtDuration(doc.durationMs)}</div>
    <div><b>سرفصل‌ها:</b>${fa(r.topics.length)} بخش</div>
  </div>

  <div class="headline">${escapeHtml(r.headline)}</div>

  <h3>کلاس چطور گذشت</h3>
  <p class="recap">${escapeHtml(r.class_recap)}</p>
  <p class="dim">حضور و غیاب، تکلیف‌ها، مهلت‌ها و خبرهای کلاس در پیام‌های تلگرام آمده‌اند و اینجا تکرار نمی‌شوند؛ این جزوه فقط محتوای درس است. نکته‌های امتحانی داخل متن، با رنگ متفاوت مشخص شده‌اند.</p>
</section>

<section class="section">
  ${body}
</section>

${
  r.glossary.length
    ? `<section><h2>واژه‌نامهٔ این جلسه</h2>${glossaryHtml(r)}</section>`
    : ""
}

${
  r.open_questions.length
    ? `<section><h2>نکات باز</h2><ul>${r.open_questions
        .map((q) => `<li>${escapeHtml(q)}</li>`)
        .join("")}</ul></section>`
    : ""
}

<p class="note">
این جزوه به‌صورت خودکار از رونوشت صوت کلاس ساخته شده و ممکن است خطا داشته باشد؛ جای دفتر و کتاب مرجع را نمی‌گیرد.
${r.droppedCitations > 0 ? `${fa(r.droppedCitations)} مورد به دلیل تأیید نشدن نقل‌قول حذف شد.` : ""}
تولید: ${escapeHtml(doc.generatedAt.toLocaleDateString("fa-IR"))}
</p>

</body>
</html>`;
}
