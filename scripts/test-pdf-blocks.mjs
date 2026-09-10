/**
 * ابزارهای دیداریِ جزوه: پنج کادر رنگی، درختِ دسته‌بندی و زنجیرهٔ فرایند.
 *
 * ## چرا آزمون لازم دارند
 *
 * هر سه بی‌صدا خراب می‌شوند. کادر از روی **برچسبِ داخلش** رنگ می‌گیرد، پس
 * یک نیم‌فاصلهٔ جابه‌جا یعنی کادر به نقل‌قولِ خاکستریِ معمولی تبدیل می‌شود و
 * هیچ خطایی هم نمی‌دهد. درخت و زنجیره بلوکِ کد هستند، پس اگر رندرِ سفارشی
 * اجرا نشود، مارک‌داون همان متن خام را داخل <pre> چاپ می‌کند — باز هم بی‌خطا.
 *
 * و برعکسش هم مهم است: کلمهٔ «مثال» یا «تعریف» در وسطِ یک نقل‌قولِ عادی
 * نباید رنگش را عوض کند. برچسب یعنی چیزی که مدل عمداً اولِ کادر گذاشته.
 *
 * اجرا: npx tsx scripts/test-pdf-blocks.mjs
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

// ─── ۱) پنج کادر، پنج رنگ ───────────────────────────────────────────────────
{
  const html = build(
    [
      "> 🎯 **در امتحان می‌آید** — «فصل سه را بخوانید» ⟨00:10:00⟩",
      "",
      "> ⚑ **تأکید استاد** — «این پایهٔ ترم است» ⟨00:12:00⟩",
      "",
      "> ℹ️ **خارج از کلاس** — توضیح کوتاه.",
      "",
      "> 📘 **تعریف** — عقد: توافق دو اراده.",
      "",
      "> 🧩 **مثال** — استاد فروش خودرو را مثال زد.",
    ].join("\n"),
  );
  for (const kind of ["exam", "emph", "outside", "def", "example"]) {
    check(`کادر ${kind} برچسب خورد`, html.includes(`<blockquote class="${kind}">`));
    check(`رنگ ${kind} در CSS هست`, html.includes(`blockquote.${kind}{`));
  }
}

// ─── ۲) برچسب باید اولِ کادر باشد، نه هر جای متن ────────────────────────────
{
  const html = build("> استاد یک **مثال** هم زد و بعد ادامه داد.\n");
  check(
    "کلمهٔ «مثال» وسط نقل‌قول کادر سبز نمی‌سازد",
    !html.includes('<blockquote class="example">'),
  );
  check("نقل‌قول عادی دست‌نخورده ماند", html.includes("<blockquote>"));
}

// ─── ۳) درختِ دسته‌بندی ─────────────────────────────────────────────────────
{
  const html = build("```tree\nعقد\n  لازم\n    بیع\n  جایز\n```\n");
  check("بلوک درخت رندر شد", html.includes('<div class="tree">'));
  check("به <pre> برنگشت", !/<pre>[\s\S]*عقد/.test(html));
  // ریشه یک گره است و «لازم» و «جایز» زیرِ آن، نه هم‌ردیفش
  const tree = /<div class="tree">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  check("ریشه یکی است", (tree.match(/^<ul><li>/) ?? []).length === 1);
  check("تودرتویی ساخته شد", (tree.match(/<ul>/g) ?? []).length >= 3);
  check("همهٔ گره‌ها آمدند", ["عقد", "لازم", "بیع", "جایز"].every((t) => tree.includes(t)));
  check("خط‌های اتصال در CSS هستند", html.includes(".tree ul ul>li::before"));
}

// ─── ۴) زنجیرهٔ فرایند ──────────────────────────────────────────────────────
{
  const html = build("```flow\nایجاب → قبول → عقد\n```\n");
  check("بلوک زنجیره رندر شد", html.includes('<div class="flow">'));
  check("سه گره ساخته شد", (html.match(/class="flow-node"/g) ?? []).length === 3);
  // در متن راست‌به‌چپ «بعدی» سمت چپ است، پس پیکان هم به چپ می‌رود
  check("پیکان به چپ است", (html.match(/class="flow-arrow">←</g) ?? []).length === 2);
}

// ─── ۵) بلوکِ خراب نباید ناپدید شود ─────────────────────────────────────────
//
// اگر مدل بلوک را خالی بگذارد، خروجی باید به بلوک کدِ معمولی برگردد نه اینکه
// مطلب بی‌صدا از جزوه حذف شود.
{
  const html = build("```flow\n```\n\nمتن بعدی.\n");
  check("بلوک خالی جزوه را نمی‌شکند", html.includes("متن بعدی"));
  check("div زنجیرهٔ خالی ساخته نشد", !html.includes('<div class="flow">'));
}

// ─── ۶) زبانِ ناشناخته همان بلوک کد می‌ماند ─────────────────────────────────
{
  const html = build("```python\nprint(1)\n```\n");
  check("بلوک کد معمولی دست‌نخورده ماند", /<pre>/.test(html) && html.includes("print(1)"));
}

// ─── ۷) کادرِ بدون «>» هم باید کادر شود ─────────────────────────────────────
//
// مدل باید سه چیز را با هم درست کند: شکلک، برچسبِ حرف‌به‌حرف، و `> ` سرِ خط.
// سومی از همه بیشتر می‌افتد، چون دو تای دیگر «محتوا»یند و این یکی فقط نحو —
// و شکستش بی‌صداست: خط یک پاراگراف عادی می‌شود و نکتهٔ امتحانی وسط متن گم.
{
  const html = build("⚑ **تأکید استاد** — «این پایهٔ ترم است» ⟨00:04:10⟩\n");
  check("خطِ بدون «>» به کادر تأکید تبدیل شد", html.includes('<blockquote class="emph">'));
}
{
  const html = build("🎯 **در امتحان می‌آید** — «فصل سه» ⟨00:04:10⟩\n\nℹ️ **خارج از کلاس** — توضیح.\n");
  check("کادر امتحان بدون «>»", html.includes('<blockquote class="exam">'));
  check("کادر «خارج از کلاس» بدون «>»", html.includes('<blockquote class="outside">'));
}
// ولی خطِ عادی نباید نقل‌قول شود
{
  const html = build("این یک پاراگراف **معمولی** است.\n");
  check("پاراگراف عادی نقل‌قول نشد", !html.includes("<blockquote"));
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
