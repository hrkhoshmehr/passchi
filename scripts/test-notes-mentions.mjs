/**
 * ادعاهای جزوه که در رونوشت ریشه ندارند.
 *
 * ## چرا این آزمون هست
 *
 * نکته‌ها و چک‌لیست هرکدام دروازهٔ راستی‌آزمایی دارند؛ **جزوه ندارد** — در
 * حالی که بزرگ‌ترین خروجی محصول است و همان چیزی است که کاربر نگه می‌دارد و
 * فوروارد می‌کند. شکلِ شکست هم قابل پیش‌بینی است: مدل نامِ ناقصی را که استاد
 * گفته «کامل» می‌کند، چون آن نام را می‌داند.
 *
 * دستهٔ «نباید گیر بیفتد» اینجا مهم‌تر از دستهٔ دیگر است: هشداری که پر از
 * نویز باشد خوانده نمی‌شود، و آن‌وقت هشدارِ واقعی هم دیده نمی‌شود.
 *
 * اجرا: npx tsx scripts/test-notes-mentions.mjs
 */
import { unsupportedMentions, transcriptText } from "../src/analysis/notes-check.ts";

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ── نامِ کامل‌شده ─────────────────────────────────────────────────────────
//
// استاد «دکتر صفایی» گفته و جزوه «دکتر سید علی صفایی» نوشته. یک کلمه‌اش
// گفته شده، ولی ادعا تازه است — دانشجو دنبال کتابی می‌گردد که با آن نام
// چاپ نشده.
{
  const transcript = transcriptText([
    { text: "منبع دوم کتاب حقوق مدنی ۳ دکتر صفایی است که دکتر کاتوزیان هم بهش ارجاع میده." },
  ]);
  const got = unsupportedMentions(
    "## منابع\n\nکتاب **دکتر سید علی صفایی** منبع اصلی است. **دکتر کاتوزیان** هم همین را می‌گوید.",
    transcript,
  );
  check("نامِ کامل‌شده گیر افتاد", got.includes("سید علی صفایی"), JSON.stringify(got));
  check("نامی که واقعاً گفته شده گیر نیفتاد", !got.includes("کاتوزیان"), JSON.stringify(got));
}

// ── عدد و تاریخ ──────────────────────────────────────────────────────────
{
  const transcript = transcriptText([
    { text: "مباحث این ترم از ماده ۱۸۳ لغایت ماده ۳۰۰ است." },
  ]);
  const got = unsupportedMentions(
    "این ترم از ماده ۱۸۳ تا ماده ۳۰۰ است و امتحان ۱۴۰۵/۰۹/۲۰ برگزار می‌شود؛ ماده ۲۲۵ هم مهم است.",
    transcript,
  );
  check("عددِ گفته‌نشده گیر افتاد", got.includes("225"), JSON.stringify(got));
  check("تاریخِ گفته‌نشده گیر افتاد", got.some((g) => g.includes("1405")), JSON.stringify(got));
  check("عددِ گفته‌شده گیر نیفتاد", !got.includes("183") && !got.includes("300"), JSON.stringify(got));
}

// ── چیزهایی که نباید گیر بیفتند ──────────────────────────────────────────
{
  const transcript = transcriptText([{ text: "استاد گفت که این بحث خیلی مهم است و باید دقت کنید." }]);
  const got = unsupportedMentions("استاد گفت که این بحث مهم است.\n\nدو نکته داشت.", transcript);
  check("«استاد گفت» نامِ ادعایی نساخت", got.length === 0, JSON.stringify(got));
}
{
  // عددِ داخل فرمول و بلوکِ کد از جای دیگرِ همان جزوه آمده — هشدار تکراری نسازد
  const transcript = transcriptText([{ text: "رابطه ساده است." }]);
  const got = unsupportedMentions("متن.\n\n```tree\n۱۲۳۴\n```\n\n$$x = 9876$$\n", transcript);
  check("عددِ داخل فرمول و بلوک کد شمرده نشد", got.length === 0, JSON.stringify(got));
}
{
  // جزوهٔ خالی هیچ ادعایی ندارد
  check("جزوهٔ خالی هشدار نمی‌دهد", unsupportedMentions("", "هر چیزی").length === 0);
}
{
  // مرزِ کلمه: «۱۸۳» نباید داخل «۱۸۳۰» پیدا شود و ادعا را توجیه کند
  const transcript = transcriptText([{ text: "عدد هزار و هشتصد و سی یعنی ۱۸۳۰." }]);
  const got = unsupportedMentions("ماده ۱۸۳ مهم است.", transcript);
  check("زیررشتهٔ عددی ادعا را توجیه نمی‌کند", got.includes("183"), JSON.stringify(got));
}
{
  // ولی **نام** با فاصلهٔ جابه‌جا همان نام است: رونویسی خودکار دقیقاً همین‌جا
  // بی‌ثبات است و هفت هشدارِ کاذب از یک جلسه از همین درآمد.
  const transcript = transcriptText([{ text: "مرحوم ملا حسین قلی همدانی این را می‌فرماید." }]);
  const got = unsupportedMentions("مرحوم ملا حسینقلی همدانی این را می‌فرماید.", transcript);
  check("نامِ سرِهم‌نوشته ادعای تازه حساب نمی‌شود", got.length === 0, JSON.stringify(got));
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
