/**
 * سقف بازپرداخت را روی دفتر کل واقعی می‌سنجد، نه روی فرمول.
 *
 * ده نفر یکی‌یکی به یک جلسهٔ ۹۰ دقیقه‌ای می‌پیوندند و بعد بررسی می‌شود که
 * مالک بیش از سقف پس نگرفته باشد و مجموع سکه‌های جمع‌شده از هزینهٔ جلسه کمتر
 * نشده باشد. اجرا: DATA_DIR=./data/tmp-share node scripts/test-sharing.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser } = await import("../src/db/index.ts");
const { grant, currentBalance } = await import("../src/billing/ledger.ts");
const { joinSession, registerOwner, setShareEnabled, members } = await import("../src/billing/sharing.ts");
const { REFUND_CAP_PCT, SHARE_TARGET, balanceCoins, coinsToSec, costCoins } = await import(
  "../src/billing/coins.ts"
);

const CLASS_SEC = 90 * 60;
const SESSION = "testsession01";
const OWNER = 5_000_001;

upsertUser(OWNER, "مالک", null);
db.prepare(
  `INSERT OR REPLACE INTO sessions (id, tg_id, status, original_ms, share_enabled, mode)
   VALUES (?, ?, 'done', ?, 1, 'full')`,
).run(SESSION, OWNER, CLASS_SEC * 1000);
db.prepare(`DELETE FROM session_members WHERE session_id = ?`).run(SESSION);
setShareEnabled(SESSION, true);
registerOwner(SESSION, OWNER, CLASS_SEC);

const classCoins = costCoins(CLASS_SEC);
console.log(`جلسهٔ ${classCoins} سکه‌ای · سقف بازگشت ${Math.round(REFUND_CAP_PCT * 100)}٪\n`);

for (let i = 2; i <= SHARE_TARGET; i++) {
  const joiner = 5_000_000 + i;
  upsertUser(joiner, `عضو ${i}`, null);
  grant(joiner, coinsToSec(700), "grant");
  const r = joinSession(SESSION, joiner);
  const owner = members(SESSION).find((m) => m.role === "owner");
  console.log(
    `${String(i).padStart(2)} نفر · سهم تازه‌وارد ${String(costCoins(r.shareSec)).padStart(3)} سکه` +
      ` · مالک روی ${String(costCoins(owner.paid_sec)).padStart(3)} سکه مانده` +
      ` · تا حالا ${String(classCoins - costCoins(owner.paid_sec)).padStart(3)} سکه پس گرفته`,
  );
}

const list = members(SESSION);
const owner = list.find((m) => m.role === "owner");
const ownerPaid = costCoins(owner.paid_sec);
const refunded = classCoins - ownerPaid;
const collected = list.reduce((sum, m) => sum + costCoins(m.paid_sec), 0);
const cap = Math.ceil(classCoins * REFUND_CAP_PCT);

console.log(`\nمالک ${refunded} سکه پس گرفت (سقف ${cap})`);
console.log(`مجموع جمع‌آوری‌شده از ${list.length} نفر: ${collected} سکه · هزینهٔ جلسه: ${classCoins} سکه`);
console.log(`موجودی نهایی مالک: ${balanceCoins(currentBalance(OWNER))} سکه`);

let bad = 0;
if (refunded > cap) { console.log(`❌ بازگشت از سقف رد شد`); bad++; }
if (collected < classCoins) { console.log(`❌ کمتر از هزینهٔ جلسه جمع شد`); bad++; }
console.log(bad === 0 ? "\n✅ سقف رعایت شد و پلتفرم زیر هزینه نرفت." : `\n${bad} خطا`);
process.exit(bad === 0 ? 0 : 1);
