/**
 * شبیه‌سازی تقسیم هزینه — روی یک دیتابیس موقت، بدون دست‌زدن به دادهٔ واقعی.
 */
import { db, createSession, updateSession, upsertUser, getUser } from "../src/db/index.js";
import { grant, currentBalance, history, totalShareRefunds } from "../src/billing/ledger.js";
import { fairShare, joinSession, registerOwner, setShareEnabled, shareStatus, members } from "../src/billing/sharing.js";
import { fmtDuration, toFaDigits } from "../src/util/time.js";

const SID = "simtest01";
const OWNER = 900000001;
const JOINERS = [900000002, 900000003, 900000004, 900000005, 900000006];
const COST_SEC = 3000; // ۵۰ دقیقه، دقیقاً مثل صوت نمونه

// ── پاک‌سازی اجرای قبلی ────────────────────────────────────────────────────
db.exec(`DELETE FROM session_members WHERE session_id = '${SID}'`);
db.exec(`DELETE FROM sessions WHERE id = '${SID}'`);
for (const id of [OWNER, ...JOINERS]) {
  db.exec(`DELETE FROM credit_ledger WHERE tg_id = ${id}`);
  db.exec(`DELETE FROM users WHERE tg_id = ${id}`);
}

// ── آماده‌سازی ─────────────────────────────────────────────────────────────
upsertUser(OWNER, "فرستنده", null);
grant(OWNER, COST_SEC, "grant");
createSession(SID, OWNER, null);
updateSession(SID, { status: "done", title: "جلسهٔ نمونه", original_ms: COST_SEC * 1000 });
setShareEnabled(SID, true);

// فرستنده کل هزینه را داده
db.prepare(`UPDATE users SET credit_sec = 0 WHERE tg_id = ?`).run(OWNER);
db.prepare(
  `INSERT INTO credit_ledger (tg_id, delta_sec, balance_after, reason, session_id) VALUES (?, ?, 0, 'reserve', ?)`,
).run(OWNER, -COST_SEC, SID);
registerOwner(SID, OWNER, COST_SEC);

for (const id of JOINERS) {
  upsertUser(id, `دانشجو ${id % 10}`, null);
  grant(id, 3600, "grant");
}

const row = (n, share, ownerBal, refunded) =>
  `${String(toFaDigits(n)).padStart(3)}  ${fmtDuration(share * 1000).padStart(16)}  ` +
  `${fmtDuration(ownerBal * 1000).padStart(16)}  ${fmtDuration(refunded * 1000).padStart(16)}`;

console.log(`هزینهٔ جلسه: ${fmtDuration(COST_SEC * 1000)}  ·  کف سهم: ${fmtDuration(90 * 1000)}\n`);
console.log("نفر   سهم هر نفر        اعتبار فرستنده     پس‌گرفتهٔ فرستنده");
console.log("─".repeat(70));
console.log(row(1, COST_SEC, currentBalance(OWNER), 0));

for (const id of JOINERS) {
  const r = joinSession(SID, id);
  console.log(row(r.memberCount, r.shareSec, currentBalance(OWNER), totalShareRefunds(OWNER)));
}

// ── راستی‌آزمایی ───────────────────────────────────────────────────────────
console.log("\n── بررسی درستی ──");
const list = members(SID);
const collected = list.reduce((a, m) => a + m.paid_sec, 0);
console.log(`مجموع پرداختی همه:      ${fmtDuration(collected * 1000)}`);
console.log(`هزینهٔ واقعی جلسه:       ${fmtDuration(COST_SEC * 1000)}`);
console.log(`اختلاف (سود گردکردن):    ${collected - COST_SEC} ثانیه`);

const ownerRefund = totalShareRefunds(OWNER);
console.log(`\nفرستنده پس گرفت:        ${fmtDuration(ownerRefund * 1000)}`);
console.log(`سقف مجاز (آنچه داده):    ${fmtDuration(COST_SEC * 1000)}`);
console.log(ownerRefund <= COST_SEC ? "✅ فرستنده سود نکرد" : "❌ فرستنده بیش از پرداختی‌اش گرفت");

const allEqual = list.every((m) => m.paid_sec === list[0].paid_sec);
console.log(allEqual ? "✅ سهم همه برابر است" : "❌ سهم‌ها نابرابرند");

// ── تراز دفتر کل ──────────────────────────────────────────────────────────
console.log("\n── تراز دفتر کل ──");
let allOk = true;
for (const id of [OWNER, ...JOINERS]) {
  const rows = history(id, 100);
  const sum = rows.reduce((a, r) => a + r.delta_sec, 0);
  const bal = currentBalance(id);
  const ok = sum === bal;
  allOk &&= ok;
  console.log(`  ${id}  دفتر ${String(sum).padStart(6)}  موجودی ${String(bal).padStart(6)}  ${ok ? "✅" : "❌"}`);
}
console.log(allOk ? "✅ دفتر کل با موجودی‌ها می‌خواند" : "❌ ناترازی");

console.log("\n── دفتر فرستنده ──");
for (const r of history(OWNER, 10).reverse()) {
  console.log(`  ${String(r.delta_sec).padStart(7)}  →  ${String(r.balance_after).padStart(6)}  ${r.reason}${r.note ? ` (${r.note})` : ""}`);
}

// پاک‌سازی
db.exec(`DELETE FROM session_members WHERE session_id = '${SID}'`);
db.exec(`DELETE FROM sessions WHERE id = '${SID}'`);
for (const id of [OWNER, ...JOINERS]) {
  db.exec(`DELETE FROM credit_ledger WHERE tg_id = ${id}`);
  db.exec(`DELETE FROM users WHERE tg_id = ${id}`);
}
