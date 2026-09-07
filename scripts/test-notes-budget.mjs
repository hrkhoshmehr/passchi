/**
 * بودجهٔ کلمهٔ جزوه باید واقعاً به پاس دوم برسد.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * قاعدهٔ «هر ده دقیقه تدریس، چهارصد کلمه» ماه‌ها در پرامپت بود و رعایت
 * نمی‌شد — روی یک کلاس ۹۴ دقیقه‌ای جزوه‌ها ۱۴۰۰ تا ۱۹۰۰ کلمه درمی‌آمدند در
 * حالی که قاعده ۲۹۲۰ می‌خواست. علتش این بود که اسکلتِ پاس دوم اصلاً
 * `chapters` نداشت، پس مدل هیچ‌وقت نمی‌دانست کلاس چند دقیقه تدریس داشته و
 * آن ضرب را روی عددی نادانسته انجام می‌داد.
 *
 * و چرا دیده نشد: `notes-check` سنجهٔ خودش را داشت («۱۲ کلمه بر دقیقهٔ
 * کلاس») که یک‌سومِ خواسته بود، پس به همان جزوه‌های لاغر «✅ سالم» می‌داد.
 *
 * پس اینجا دو چیز آزموده می‌شود: بودجه درست حساب شود، و بخش‌های غیردرسی
 * سهم نگیرند.
 *
 * اجرا: npx tsx scripts/test-notes-budget.mjs
 */
const { notesBudget } = await import("../src/analysis/analyze.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const min = (m) => m * 60_000;
const chapters = [
  { title: "معرفی درس", kind: "teaching", start_ms: 0, end_ms: min(14) },
  { title: "حضور و غیاب", kind: "admin", start_ms: min(14), end_ms: min(20) },
  { title: "تعریف عقد", kind: "teaching", start_ms: min(20), end_ms: min(40) },
  { title: "خاطرهٔ سربازی", kind: "offtopic", start_ms: min(40), end_ms: min(50) },
  { title: "پرسش و پاسخ", kind: "qa", start_ms: min(50), end_ms: min(65) },
  { title: "قطعی برق", kind: "technical", start_ms: min(65), end_ms: min(65.5) },
];

const budget = notesBudget(chapters);

check("فقط بخش‌های درسی سهم دارند", budget.length === 3, `${budget.length} بخش`);
check(
  "هیچ بخش غیردرسی نیامده",
  !budget.some((b) => ["admin", "offtopic", "technical", "break"].includes(b.kind)),
);
check("پرسش و پاسخ سهم دارد", budget.some((b) => b.kind === "qa"));

const floors = Object.fromEntries(budget.map((b) => [b.title, b.floor]));
check("۱۴ دقیقه ⇒ ۵۶۰ کلمه", floors["معرفی درس"] === 560, String(floors["معرفی درس"]));
check("۲۰ دقیقه ⇒ ۸۰۰ کلمه", floors["تعریف عقد"] === 800, String(floors["تعریف عقد"]));
check("۱۵ دقیقه ⇒ ۶۰۰ کلمه", floors["پرسش و پاسخ"] === 600, String(floors["پرسش و پاسخ"]));

const total = budget.reduce((s, b) => s + b.floor, 0);
check("جمع کف درست است", total === 1960, String(total));

// بخشِ زیر یک دقیقه سهمی ندارد — وگرنه جدول پر از سطرِ صفر می‌شود
check(
  "بخش کوتاه‌تر از یک دقیقه کنار می‌رود",
  notesBudget([{ title: "تک‌جمله", kind: "teaching", start_ms: 0, end_ms: 30_000 }]).length === 0,
);

// کلاسی که هیچ بخش درسی ندارد نباید جدولِ خالی بسازد
check("کلاس بی‌بخشِ درسی بودجه‌ای ندارد", notesBudget([]).length === 0);

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
