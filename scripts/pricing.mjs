/**
 * بررسی قیمت‌گذاری: هزینهٔ تمام‌شده، حاشیهٔ هر پکیج، و قیمت یک کلاس واقعی.
 *
 * بعد از هر تغییری در `PACKAGES` یا در فرض‌های هزینه اجرا شود. خروجی‌اش
 * جواب این سؤال است: «آیا هنوز داریم سود می‌کنیم؟»
 */
import {
  COINS_PER_MINUTE, COST_PER_AUDIO_HOUR_USD, COST_PER_COIN_TOMAN, PACKAGES, SHARE_TARGET,
  USD_TOMAN, classesFor, costCoins, shareBack,
} from "../src/billing/coins.ts";

const MIN_MARGIN = 2.0;
const fa = (n) => n.toLocaleString("fa-IR", { maximumFractionDigits: 0 });

console.log("فرض‌های هزینه");
console.log(`  هر ساعت صوت: $${COST_PER_AUDIO_HOUR_USD.toFixed(2)}`);
console.log(`  نرخ دلار: ${fa(USD_TOMAN)} تومان`);
console.log(`  نرخ سکه: هر دقیقه ${COINS_PER_MINUTE} سکه`);
console.log(`  ⇒ هزینهٔ هر سکه برای ما: ${COST_PER_COIN_TOMAN.toFixed(1)} تومان\n`);

let worst = Infinity;
const base = PACKAGES[0].price / PACKAGES[0].coins;

console.log("پکیج‌ها");
for (const p of PACKAGES) {
  const perCoin = p.price / p.coins;
  const margin = perCoin / COST_PER_COIN_TOMAN;
  const discount = Math.round((1 - perCoin / base) * 100);
  worst = Math.min(worst, margin);
  console.log(
    `  ${String(p.coins).padStart(5)} سکه · ${String(fa(p.price)).padStart(9)} تومان` +
      ` · هر سکه ${perCoin.toFixed(0)} تومان` +
      ` · حاشیه ×${margin.toFixed(2)}` +
      ` · تخفیف ${discount}٪` +
      ` · ${classesFor(p.coins)} کلاس ۹۰ دقیقه‌ای`,
  );
}

console.log("\nیک کلاس ۹۰ دقیقه‌ای");
const classCoins = costCoins(90 * 60);
const { seat, cap } = shareBack(90 * 60, SHARE_TARGET);
for (const p of PACKAGES) {
  const price = (classCoins * p.price) / p.coins;
  const each = (seat * p.price) / p.coins;
  const back = Math.round((cap / classCoins) * 100);
  console.log(
    `  با پکیج ${p.coins}: ${fa(price)} تومان تنها` +
      ` — یا ${fa(each)} تومان برای هر یک از ${SHARE_TARGET} نفر (سهمِ ثابت، تا ${back}٪ برگشت به مالک)`,
  );
}

console.log(`\nکف حاشیه: ×${worst.toFixed(2)} (حداقل قابل قبول: ×${MIN_MARGIN})`);
if (worst < MIN_MARGIN) {
  console.error("❌ یک پکیج زیر کف حاشیه است.");
  process.exit(1);
}
console.log("✅ همهٔ پکیج‌ها بالای کف حاشیه‌اند.");
