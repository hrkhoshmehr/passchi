/**
 * صفحه‌بندی فهرست جلسه‌ها.
 *
 * پیش‌تر فهرست، برای هر جلسه یک پیام جدا می‌فرستاد؛ ده جلسه یعنی ده پیام پشت
 * سر هم. حالا یک پیام دکمه‌ای است و این آزمون می‌سنجد که برش صفحه‌ها درست
 * باشد: هیچ جلسه‌ای تکرار نشود، هیچ‌کدام جا نیفتد، و صفحهٔ بیرون از بازه
 * خطا ندهد.
 *
 * اجرا: DATA_DIR=./data/tmp-hist npx tsx scripts/test-history-page.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser, listSessions, countSessions } = await import("../src/db/index.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const USER = 7_100_001;
upsertUser(USER, "کاربر آزمایشی", null);
db.prepare(`DELETE FROM sessions WHERE tg_id = ?`).run(USER);

// نوزده جلسه: عمداً مضرب هشت نیست تا صفحهٔ آخرِ ناقص هم سنجیده شود.
const TOTAL = 19;
for (let i = 0; i < TOTAL; i++) {
  db.prepare(
    `INSERT INTO sessions (id, tg_id, status, title, created_at, mode)
     VALUES (?, ?, 'done', ?, datetime('now', ?), 'full')`,
  ).run(`h${String(i).padStart(4, "0")}`, USER, `جلسهٔ ${i}`, `-${TOTAL - i} minutes`);
}

check("شمار کل درست است", countSessions(USER) === TOTAL, String(countSessions(USER)));

const PAGE = 8;
const pages = Math.ceil(TOTAL / PAGE);
check("تعداد صفحه‌ها", pages === 3, String(pages));

// همهٔ صفحه‌ها را بردار و کنار هم بگذار
const seen = [];
for (let p = 0; p < pages; p++) {
  const rows = listSessions(USER, PAGE, p * PAGE);
  const expected = p < pages - 1 ? PAGE : TOTAL - (pages - 1) * PAGE;
  check(`صفحهٔ ${p + 1} اندازهٔ درست دارد`, rows.length === expected, `${rows.length} از ${expected}`);
  seen.push(...rows.map((r) => r.id));
}

check("هیچ جلسه‌ای جا نیفتاد", seen.length === TOTAL, String(seen.length));
check("هیچ جلسه‌ای تکرار نشد", new Set(seen).size === TOTAL, String(new Set(seen).size));

// ترتیب باید نزولی بماند — تازه‌ترین اول
const titles = seen.map((id) => Number(id.slice(1)));
const descending = titles.every((n, i) => i === 0 || titles[i - 1] > n);
check("ترتیب از تازه به قدیم است", descending);

// صفحهٔ بیرون از بازه نباید خطا بدهد
check("صفحهٔ خالی خطا نمی‌دهد", listSessions(USER, PAGE, 99 * PAGE).length === 0);

// پاک‌سازی
db.prepare(`DELETE FROM sessions WHERE tg_id = ?`).run(USER);
db.prepare(`DELETE FROM users WHERE tg_id = ?`).run(USER);

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
