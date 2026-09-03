/**
 * سقف بازگشت و «رایگان بعد از سقف» را روی دفتر کل واقعی می‌سنجد، نه روی فرمول.
 *
 * پانزده نفر یکی‌یکی به یک جلسهٔ ۹۰ دقیقه‌ای می‌پیوندند و بررسی می‌شود که
 * مالک دقیقاً تا سقف (نصفِ هزینه) پس گرفته باشد، بعد از آن برداشتن رایگان
 * باشد، و هیچ‌وقت بیشتر از هزینهٔ جلسه از کسی جمع نشده باشد.
 * اجرا: DATA_DIR=./data/tmp-share node scripts/test-sharing.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser } = await import("../src/db/index.ts");
const { grant, currentBalance } = await import("../src/billing/ledger.ts");
const { joinSession, registerOwner, setShareEnabled, setShareTarget, members } = await import(
  "../src/billing/sharing.ts"
);
const { REFUND_CAP_PCT, balanceCoins, coinsToSec, costCoins, shareBack } = await import(
  "../src/billing/coins.ts"
);

const CLASS_SEC = 90 * 60;
const SESSION = "testsession01";
const OWNER = 5_000_001;
const TARGET = 10;
const JOINERS = 15;

upsertUser(OWNER, "مالک", null);
db.prepare(
  `INSERT OR REPLACE INTO sessions (id, tg_id, status, original_ms, share_enabled, share_target, mode)
   VALUES (?, ?, 'done', ?, 1, ?, 'full')`,
).run(SESSION, OWNER, CLASS_SEC * 1000, TARGET);
db.prepare(`DELETE FROM session_members WHERE session_id = ?`).run(SESSION);
setShareEnabled(SESSION, true);
setShareTarget(SESSION, TARGET);
registerOwner(SESSION, OWNER, CLASS_SEC);

const classCoins = costCoins(CLASS_SEC);
const { seat, cap } = shareBack(CLASS_SEC, TARGET);
console.log(
  `جلسهٔ ${classCoins} سکه‌ای · «${TARGET} نفر» ⇒ سهم هر نفر ${seat} سکه · سقف بازگشت ${cap} سکه\n`,
);

let freeFrom = 0;
for (let i = 1; i <= JOINERS; i++) {
  const joiner = 5_000_100 + i;
  upsertUser(joiner, `عضو ${i}`, null);
  grant(joiner, coinsToSec(700), "grant");
  const r = joinSession(SESSION, joiner);
  const owner = members(SESSION).find((m) => m.role === "owner");
  if (r.free && !freeFrom) freeFrom = i;
  console.log(
    `${String(i).padStart(2)} · ${r.free ? "رایگان        " : `کسر ${String(costCoins(r.chargedSec)).padStart(2)} سکه`}` +
      ` · مالک روی ${String(costCoins(owner.paid_sec)).padStart(3)} سکه مانده` +
      ` · تا حالا ${String(classCoins - costCoins(owner.paid_sec)).padStart(2)} سکه پس گرفته` +
      `${r.capJustReached ? "  ← سقف پر شد" : ""}`,
  );
}

const list = members(SESSION);
const owner = list.find((m) => m.role === "owner");
const refunded = classCoins - costCoins(owner.paid_sec);
const collected = list.reduce((sum, m) => sum + costCoins(m.paid_sec), 0);

console.log(`\nمالک ${refunded} سکه پس گرفت (سقف ${cap})`);
console.log(`اولین برداشتِ رایگان: نفر ${freeFrom || "—"}`);
console.log(`مجموع جمع‌آوری‌شده از ${list.length} نفر: ${collected} سکه · هزینهٔ جلسه: ${classCoins} سکه`);
console.log(`موجودی نهایی مالک: ${balanceCoins(currentBalance(OWNER))} سکه`);

let bad = 0;
if (refunded > cap) { console.log(`❌ بازگشت از سقف رد شد`); bad++; }
if (refunded !== cap) { console.log(`❌ بازگشت به سقف نرسید (${refunded} ≠ ${cap})`); bad++; }
if (collected < classCoins) { console.log(`❌ کمتر از هزینهٔ جلسه جمع شد`); bad++; }
if (collected > classCoins) { console.log(`❌ بیشتر از هزینهٔ جلسه جمع شد — پلتفرم از تازه‌واردها برداشت`); bad++; }
if (!freeFrom) { console.log(`❌ هیچ برداشتی رایگان نشد`); bad++; }
console.log(
  bad === 0
    ? `\n✅ مالک دقیقاً نصف را پس گرفت، بعدش رایگان شد، و پلتفرم نه زیر هزینه رفت نه بالاتر.`
    : `\n${bad} خطا`,
);
process.exit(bad === 0 ? 0 : 1);
