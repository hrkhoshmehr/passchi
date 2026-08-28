/**
 * شبیه‌سازی چرخهٔ اقتصادی، نه فقط حاشیهٔ یک فروش.
 *
 * حاشیهٔ هر پکیج به‌تنهایی گمراه‌کننده است، چون بازپرداختِ اشتراک سکه‌های
 * خریداری‌شده را به فرستنده برمی‌گرداند و او دوباره خرجشان می‌کند. با نرخ
 * بازگشت r، هر خریدِ یک‌باره در نهایت **۱/(۱−r)** برابرِ خودش پردازش می‌خرد:
 * با r=۰٫۹ یعنی ده برابر، در حالی که حاشیهٔ ما سه برابر است.
 *
 * و بازپرداخت از جیب کسانی می‌آید که می‌پیوندند — که اگر حساب تازه باشند،
 * سهمشان را با سکهٔ *هدیه* می‌دهند. یعنی پولی وارد نشده ولی سکهٔ واقعیِ
 * فرستنده برگشته است.
 *
 * دو سناریوی سوءاستفاده جدا مدل می‌شوند، چون دفاعشان فرق می‌کند.
 */
import {
  COST_PER_COIN_TOMAN, PACKAGES, REFUND_CAP_PCT, SHARE_TARGET, USD_TOMAN, costCoins,
} from "../src/billing/coins.ts";
import { config } from "../src/config.ts";

const fa = (n) => Math.round(n).toLocaleString("fa-IR");
const CLASS_MIN = 90;
const K = costCoins(CLASS_MIN * 60); // سکهٔ یک کلاس ۹۰ دقیقه‌ای
const sessionCost = K * COST_PER_COIN_TOMAN;

/** اجرای رایگانِ یک حساب تازه فقط Soniox خرج دارد — بدون مدل. */
const SONIOX_HOUR_USD = 0.1;
// اجرای رایگان حذف شد؛ هزینهٔ کاربر تازه حالا فقط سکهٔ هدیهٔ ثبت‌نام است.
const freeRunCost = 0;

const share = Math.ceil(K / SHARE_TARGET);
const ownerFloor = Math.ceil(K * (1 - REFUND_CAP_PCT));
const refundPerCycle = K - Math.max(share, ownerFloor);

console.log("فرض‌ها");
console.log(`  کلاس ${CLASS_MIN} دقیقه‌ای: ${fa(K)} سکه · هزینهٔ پردازش ${fa(sessionCost)} تومان`);
console.log(`  هدیهٔ شروع: ${config.FREE_TRIAL_COINS} سکه · سهم هر نفر از این کلاس: ${share} سکه`);
console.log(`  رونویسی رایگان: حذف شد`);
console.log(`  سقف بازگشت: ${Math.round(REFUND_CAP_PCT * 100)}٪ ⇒ هر جلسه ${fa(refundPerCycle)} سکه برمی‌گردد\n`);

/**
 * چند جلسه با یک خرید می‌شود گرفت، وقتی هر جلسه بخشی از سکه‌ها برمی‌گردد.
 * `freeRunsPerCycle` تعداد حساب‌های تازه‌ای است که علاوه بر پیوستن، سهمیهٔ
 * اجرای رایگانشان را هم می‌سوزانند.
 */
function simulate(pkg, freeRunsPerCycle) {
  let coins = pkg.coins;
  let cost = 0;
  let cycles = 0;
  while (coins >= K && cycles < 200) {
    cycles++;
    coins -= K - refundPerCycle;
    cost += sessionCost + freeRunsPerCycle * freeRunCost;
  }
  return { cycles, cost, profit: pkg.price - cost };
}

function report(title, freeRuns) {
  console.log(title);
  let worst = Infinity;
  for (const p of PACKAGES) {
    const r = simulate(p, freeRuns);
    worst = Math.min(worst, r.profit);
    console.log(
      `  ${r.profit >= 0 ? "✅" : "❌"} پکیج ${String(p.coins).padStart(5)} ·` +
        ` ${fa(p.price).padStart(9)} درآمد · ${fa(r.cost).padStart(9)} هزینه ·` +
        ` ${String(r.cycles).padStart(3)} جلسه ⇒ ${r.profit >= 0 ? "سود" : "زیان"} ${fa(Math.abs(r.profit))} تومان`,
    );
  }
  console.log();
  return worst;
}

// سناریوی اصلی: حساب‌های تازه فقط می‌پیوندند. برای فرستنده هیچ سودی ندارد که
// آن‌ها صوت هم بفرستند، پس همین مسیرِ کم‌اصطکاکِ سوءاستفاده است.
const a = report(
  `سناریوی ۱ — فرستنده هر جلسه ${SHARE_TARGET - 1} حساب تازه می‌آورد که فقط می‌پیوندند و هرگز خرید نمی‌کنند`,
  0,
);

// سناریوی دوم: همان حساب‌ها سهمیهٔ اجرای رایگانشان را هم می‌سوزانند. این
// دیگر «سوءاستفاده از بازپرداخت» نیست بلکه سوءاستفاده از لایهٔ رایگان است و
// دفاعش قیمت‌گذاری نیست — اصطکاکِ شمارهٔ تلفن تلگرام است.
const b = report(
  `سناریوی ۲ — همان حساب‌ها اجرای رایگانشان را هم می‌سوزانند (سوءاستفاده از لایهٔ رایگان)`,
  SHARE_TARGET - 1,
);

console.log("حالت واقعی — همان ده هم‌کلاسی هر هفته، اجرای رایگان فقط یک بار");
for (const p of PACKAGES) {
  const r = simulate(p, 0);
  const once = (SHARE_TARGET - 1) * freeRunCost;
  const profit = r.profit - once;
  console.log(
    `  ${profit >= 0 ? "✅" : "❌"} پکیج ${String(p.coins).padStart(5)} ⇒ سود ${fa(profit)} تومان` +
      ` (${r.cycles} جلسه، ${SHARE_TARGET - 1} حساب تازه)`,
  );
}

console.log("\nنرخ بازگشتِ سربه‌سر برای هر پکیج (بدون احتساب لایهٔ رایگان)");
for (const p of PACKAGES) {
  const m = p.price / p.coins / COST_PER_COIN_TOMAN;
  console.log(`  پکیج ${String(p.coins).padStart(5)} · حاشیه ×${m.toFixed(2)} ⇒ سقف بازگشت ${Math.round((1 - 1 / m) * 100)}٪`);
}

if (a < 0) {
  console.error("\n❌ سناریوی ۱ زیان‌ده است — سقف بازگشت باید پایین‌تر بیاید.");
  process.exit(1);
}
console.log(
  a >= 0 && b >= 0
    ? "\n✅ هر دو سناریو سودده‌اند."
    : "\n✅ سناریوی بازپرداخت امن است. سناریوی ۲ زیان‌ده می‌ماند و دفاعش قیمت نیست؛ پایین‌تر در README.",
);
