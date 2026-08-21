import MarkdownIt from "markdown-it";
import katex from "katex";
import { buildFontCss } from "./assets.js";
import { escapeHtml } from "../util/text.js";
import { fmtClock, fmtDuration, toFaDigits } from "../util/time.js";
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

const KIND_LABEL: Record<string, string> = {
  teaching: "تدریس",
  qa: "پرسش و پاسخ",
  admin: "امور کلاس",
  offtopic: "حاشیه",
  technical: "مشکل فنی",
  break: "سکوت و وقفه",
};

const KIND_COLOR: Record<string, string> = {
  teaching: "var(--teach)",
  qa: "var(--qa)",
  admin: "var(--admin)",
  offtopic: "var(--off)",
  technical: "var(--tech)",
  break: "var(--brk)",
};

const KP_LABEL: Record<string, string> = {
  exam: "در امتحان می‌آید",
  emphasis: "تأکید استاد",
  homework: "تکلیف",
  deadline: "مهلت",
};

function compositionBar(r: AnalysisReport): string {
  const rows = r.composition.filter((c) => c.pct > 0);
  if (rows.length === 0) return "";
  const bar = rows
    .map(
      (c) =>
        `<span class="seg" style="width:${c.pct}%;background:${KIND_COLOR[c.kind] ?? "#999"}" title="${
          KIND_LABEL[c.kind] ?? c.kind
        }"></span>`,
    )
    .join("");
  const legend = rows
    .map(
      (c) =>
        `<li><i style="background:${KIND_COLOR[c.kind] ?? "#999"}"></i>${
          KIND_LABEL[c.kind] ?? c.kind
        } — <b>${toFaDigits(c.pct)}٪</b> <span class="dim">(${fmtDuration(c.ms)})</span></li>`,
    )
    .join("");
  return `<div class="bar">${bar}</div><ul class="legend">${legend}</ul>`;
}

function evidenceHtml(e: { quote: string; at_ms: number; speaker: string } | null): string {
  if (!e) return "";
  return `<div class="ev">«${escapeHtml(e.quote)}»<span class="ts">${e.speaker} · ${toFaDigits(
    fmtClock(e.at_ms, true),
  )}</span></div>`;
}

function keyPointsHtml(r: AnalysisReport): string {
  if (r.key_points.length === 0) return `<p class="dim">نکتهٔ امتحانیِ دارای منبعِ تأییدشده‌ای پیدا نشد.</p>`;
  const order: Record<string, number> = { exam: 0, deadline: 1, homework: 2, emphasis: 3 };
  const sorted = [...r.key_points].sort(
    (a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.evidence.at_ms - b.evidence.at_ms,
  );
  return sorted
    .map(
      (k) => `<div class="kp kp-${k.kind}">
  <div class="kp-h"><span class="tag">${KP_LABEL[k.kind] ?? k.kind}</span><b>${escapeHtml(k.title)}</b>${
    k.due ? `<span class="due">مهلت: ${escapeHtml(k.due)}</span>` : ""
  }</div>
  ${evidenceHtml(k.evidence)}
</div>`,
    )
    .join("");
}

function actionsHtml(r: AnalysisReport): string {
  const labels: Record<string, string> = {
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
  return `<table class="acts"><thead><tr><th>مورد</th><th>وضعیت</th><th>توضیح</th></tr></thead><tbody>${r.professor_actions
    .map(
      (a) => `<tr class="${a.happened ? "yes" : "no"}">
    <td>${labels[a.action] ?? a.action}</td>
    <td>${a.happened ? "✔ انجام شد" : "— نشانه‌ای نبود"}</td>
    <td>${escapeHtml(a.detail)}${evidenceHtml(a.evidence)}</td>
  </tr>`,
    )
    .join("")}</tbody></table>`;
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

export function buildHtml(doc: NoteDocument): string {
  const r = doc.report;
  const body = renderMath(md.render(normalizeListMarkers(doc.notesMarkdown || "_جزوه‌ای تولید نشد._")));
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
.tldr{margin:0;padding-right:1.1em}
.tldr li{margin:.45em 0}

/* ── نوار ترکیب زمانی ─────────────────────────────────── */
.bar{display:flex;height:16px;border-radius:8px;overflow:hidden;margin:1em 0 .7em;
  border:1px solid var(--line)}
.bar .seg{display:block;height:100%}
.legend{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:.35em 1.3em;font-size:9.5pt}
.legend li{display:flex;align-items:center;gap:.45em}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}

/* ── عناوین ──────────────────────────────────────────── */
h1,h2,h3,h4{line-height:1.6;font-weight:700;break-after:avoid}
h2{font-size:15pt;margin:1.9em 0 .6em;padding-bottom:.3em;border-bottom:2px solid var(--line)}
h3{font-size:12.5pt;margin:1.4em 0 .4em;color:#22303c}
h4{font-size:11pt;margin:1.1em 0 .3em}
p{margin:.55em 0}
ul,ol{padding-right:1.3em;margin:.5em 0}
ol{list-style-type:persian}
li{margin:.3em 0}
blockquote{margin:.9em 0;padding:.7em 1em;background:#fffbea;border-right:3px solid #d69e2e;
  border-radius:4px;font-size:10pt}
blockquote p{margin:.2em 0}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;background:#f4f6f8;
  padding:.1em .35em;border-radius:3px;direction:ltr;display:inline-block}
pre{background:#f4f6f8;padding:.8em 1em;border-radius:6px;overflow-x:auto;direction:ltr;text-align:left}
pre code{background:none;padding:0}
hr{border:none;border-top:1px solid var(--line);margin:1.6em 0}

table{width:100%;border-collapse:collapse;margin:.9em 0;font-size:9.8pt;break-inside:avoid}
th,td{border:1px solid var(--line);padding:.5em .65em;text-align:right;vertical-align:top}
th{background:#f7f9fb;font-weight:600;color:#3d4852}

/* ── کارت‌های نکته ────────────────────────────────────── */
.kp{border:1px solid var(--line);border-right-width:3px;border-radius:5px;
  padding:.75em .9em;margin:.7em 0;break-inside:avoid}
.kp-exam{border-right-color:#e53e3e}
.kp-emphasis{border-right-color:var(--admin)}
.kp-homework{border-right-color:var(--qa)}
.kp-deadline{border-right-color:#dd6b20}
.kp-h{display:flex;align-items:center;gap:.6em;flex-wrap:wrap;margin-bottom:.25em}
.kp p{margin:.2em 0;font-size:10pt}
.tag{font-size:8.5pt;background:#eef1f5;color:#4a5568;padding:.15em .55em;border-radius:99px;font-weight:600}
.due{font-size:9pt;color:#c05621;font-weight:600}

.ev{margin-top:.5em;padding:.5em .7em;background:#f7f9fb;border-radius:4px;
  font-size:9.5pt;color:#3d4852;line-height:1.8}
.ev .ts{display:block;margin-top:.25em;font-size:8.5pt;color:var(--dim);
  font-variant-numeric:tabular-nums;unicode-bidi:isolate}
.ts,.clock{unicode-bidi:isolate}

.pre{border:1px solid var(--line);border-radius:5px;padding:.75em .9em;margin:.7em 0;break-inside:avoid}
.pre-h{display:flex;align-items:baseline;gap:.7em;margin-bottom:.2em}
.sig{font-size:8.5pt;color:var(--dim)}

.acts td:first-child{width:22%;font-weight:600}
.acts td:nth-child(2){width:20%;white-space:nowrap}
.acts tr.no td{color:var(--dim)}
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

  <h3>در یک نگاه</h3>
  <ul class="tldr">${r.student_summary.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>

  <h3>ترکیب زمانی کلاس</h3>
  ${compositionBar(r)}
  <p class="dim">سهم سکوت و وقفه با اندازه‌گیری مستقیم سیگنال صوتی به دست آمده؛ تقسیم بقیهٔ زمان بر پایهٔ تحلیل محتوای رونوشت است.</p>

  <h3>استاد در این جلسه چه کرد</h3>
  ${actionsHtml(r)}
</section>

<section class="section">
  <h2>برای امتحان</h2>
  <p class="dim">هر مورد با عین جملهٔ استاد و زمانش در فایل صوتی. آنچه نقل‌قولش در رونوشت تأیید نشد، حذف شده است.</p>
  ${keyPointsHtml(r)}
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
