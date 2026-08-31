/**
 * فرمول‌های جزوه باید سالم رندر شوند، نه اینکه به متنِ زشت تبدیل شوند.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * ترتیب `renderMath(md.render(...))` بود: مارک‌داون **اول** متن را دست‌کاری
 * می‌کرد و بعد KaTeX می‌خواست همان را بخواند. دو چیز خراب می‌شد:
 *
 *   ۱) `>` به `&gt;` تبدیل می‌شد، پس `T_g > T_bulk` دیگر ریاضیِ معتبر نبود.
 *   ۲) `\text` را مارک‌داون یک escape می‌دید و به **کاراکتر tab** تبدیل
 *      می‌کرد، پس `\text{bulk}` می‌شد «‹tab›ext{bulk}».
 *
 * کاربر در PDF چیزی مثل `}T_g &lt; T_{g,\text{bulk}(` می‌دید — و چون
 * `throwOnError: false` بود، KaTeX پرتاب نمی‌کرد و همان خرابی را
 * **به‌عنوان خروجی سالم** رندر می‌کرد. یعنی نه خطایی بود نه لاگی.
 *
 * اجرا: npx tsx scripts/test-pdf-math.mjs
 */
const { buildHtml } = await import("../src/pdf/template.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const emptyReport = {
  glossary: [], key_points: [], chapters: [], topics: [], open_questions: [],
  assignments: [], professor_actions: [], class_recap: "", composition: [],
  silenceMs: 0, droppedCitations: 0,
};

const build = (markdown) =>
  buildHtml({
    courseName: null, professorName: null, sessionDate: null,
    sessionTitle: "آزمون", durationMs: 3_600_000, generatedAt: new Date(),
    report: emptyReport, notesMarkdown: markdown,
  });

// ─── ۱) عملگر مقایسه داخل ریاضی ─────────────────────────────────────────────
//
// همان جمله‌ای که در جزوهٔ واقعی خراب شد.
{
  const html = build("نانوذرات باعث می‌شود ($T_g > T_{g,\\text{bulk}}$).");
  check("عملگر بزرگ‌تر به &gt; تبدیل نشده", !/katex[^<]{0,300}&amp;gt;/.test(html));
  check("KaTeX واقعاً رندر کرده", html.includes("katex"), "");
  // `mrel` کلاسی است که KaTeX روی عملگر رابطه‌ای می‌گذارد
  check("عملگر رابطه‌ای در خروجی هست", html.includes("mrel"));
  check("نگهدارنده جا نمانده", !/KATEXPLACEHOLDER/.test(html));
}

// ─── ۲) دستورهای TeX که با \t و \n شروع می‌شوند ─────────────────────────────
//
// خطرناک‌ترین‌ها: مارک‌داون آن‌ها را کاراکتر کنترلی می‌بیند.
{
  const html = build("مقدار $\\text{bulk}$ و $\\theta$ و خط $\\newline$ اینجا.");
  check("کاراکتر tab وارد خروجی نشده", !html.includes("\t"), "");
  check("متن \\text به‌درستی رندر شد", !/&amp;gt;|\\text\{/.test(html.replace(/<[^>]+>/g, "")));
}

// ─── ۳) فرمول نمایشی ($$) ───────────────────────────────────────────────────
{
  const html = build("معادلهٔ فاکس:\n\n$$\\frac{1}{T_g} = \\frac{w_1}{T_{g1}} + \\frac{w_2}{T_{g2}}$$\n");
  check("فرمول نمایشی رندر شد", html.includes("katex-display"));
  check("کسر ساخته شد", html.includes("frac") || html.includes("mfrac") || html.includes("vlist"));
}

// ─── ۴) متن معمولی نباید آسیب ببیند ─────────────────────────────────────────
//
// مارک‌داون باید کار خودش را بکند؛ محافظت از ریاضی نباید آن را بشکند.
{
  const html = build("# عنوان\n\nمتن **پررنگ** و *کج* و `کد`.\n\n- یک\n- دو\n");
  check("عنوان مارک‌داون کار می‌کند", html.includes("<h1"));
  check("پررنگ کار می‌کند", html.includes("<strong>"));
  check("لیست کار می‌کند", html.includes("<li>"));
  // و علامت بزرگ‌تر در متنِ عادی باید همچنان escape شود — این امنیت است.
  const plain = build("مقایسه: 5 > 3 و <script>alert(1)</script>");
  check("HTML خام در متن عادی اجرا نمی‌شود", !plain.includes("<script>alert"));
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
