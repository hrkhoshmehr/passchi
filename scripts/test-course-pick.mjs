/**
 * انتخاب و ساختِ درس، از داخل مینی‌اپ.
 *
 * باگی که این آزمون نگه می‌دارد: انتخابگر درس با `hidden` شروع می‌شد و فقط
 * وقتی `courses.length > 0` بود باز می‌شد. یعنی کاربر تازه — که هیچ درسی
 * ندارد — هرگز آن را نمی‌دید، و تنها راه ساختن درس رفتن به ربات بود. ولی
 * یادگیری اصطلاح‌های تخصصی فقط وقتی کار می‌کند که جلسه به درسی وصل باشد،
 * پس عملاً برای هیچ‌کس کار نمی‌کرد.
 *
 * اجرا: npx tsx scripts/test-course-pick.mjs
 */
import fs from "node:fs";

const readLf = (p) => fs.readFileSync(p, "utf8").split("\r\n").join("\n");
const html = readLf("public/app.html");
const js = readLf("public/app.js");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ─── نشانه‌گذاری ─────────────────────────────────────────────────────────────

check(
  "انتخابگر درس از ابتدا پنهان نیست",
  /<div id="course-pick">/.test(html),
  (html.match(/<div id="course-pick"[^>]*>/) ?? ["پیدا نشد"])[0],
);
check("فرم ساخت درس وجود دارد", html.includes('id="course-new"'));
check("فرم ساخت از ابتدا بسته است", /id="course-new" class="hidden"/.test(html));
for (const id of ["course-name", "course-prof", "course-save", "course-cancel", "course-err"]) {
  check(`عنصر ${id} هست`, html.includes(`id="${id}"`));
}

// ─── رفتار ──────────────────────────────────────────────────────────────────

check("گزینهٔ «درس جدید» در انتخابگر ساخته می‌شود", js.includes('value="new"'));
check("ساختن درس به سرور POST می‌شود", /"\/api\/courses",\s*\{\s*\n?\s*method: "POST"/.test(js));
check("درس تازه پس از ساخته‌شدن انتخاب می‌ماند", /loadCourses\(course\.id\)/.test(js));
check("اسم خالی رد می‌شود", /if \(!name\) return fail/.test(js));

// مهم‌ترین: `new` یک شناسه نیست و نباید به سرور برود
check(
  "مقدار «new» به‌عنوان شناسهٔ درس فرستاده نمی‌شود",
  /picked === "new" \? "" : picked/.test(js),
);

// ─── قرارداد با سرور ────────────────────────────────────────────────────────
//
// اپ `{ course: { id } }` می‌خواند؛ اگر سرور شکل پاسخ را عوض کند، درس تازه
// بی‌صدا انتخاب نمی‌شود و کاربر صوتش را بی‌درس می‌فرستد.
const server = readLf("src/web/server.ts");
check(
  "پاسخ سرور همان شکلی است که اپ می‌خواند",
  /json\(res, 200, \{ course: \{ id: c\.id/.test(server),
);

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
