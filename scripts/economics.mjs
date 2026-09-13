/**
 * شبیه‌سازی چرخهٔ اقتصادی شریک‌شدن، نه فقط حاشیهٔ یک فروش — به تومان.
 *
 * قاعدهٔ امروز: صاحب جلسه کلِ قیمت را می‌دهد و هر هم‌کلاسی سهمش را، تا جایی که
 * صاحب جلسه فقط سهمِ خودش را داده باشد. اگر هم‌کلاسی‌ها واقعی‌اند و با اعتبارِ
 * **خریداری‌شده** می‌آیند، پولشان واقعاً وارد شده و هیچ زیانی نیست. خطر فقط
 * حساب‌های ساختگی است که با **هدیه** سهم می‌دهند: پولی وارد نشده ولی اعتبارِ
 * واقعیِ صاحب جلسه برگشته و دوباره خرج می‌شود.
 *
 * دو دفاع: هدیهٔ شروع برای هر حساب یک بار است، و جمعِ سهم‌های هدیه‌ای در هفته
 * سقف دارد (`SHARE_GIFT_TOMAN_PER_WEEK`). این اسکریپت بدترین حالتِ هفته را
 * می‌سنجد: کلِ سقف با حساب‌های ساختگی خرج شود.
 *
 * اجرا: node --import tsx scripts/economics.mjs
 */
import { COST_PER_MINUTE_TOMAN, TOMAN_PER_MINUTE, priceOf, shareCap, shareSeat } from "../src/billing/money.ts";
import { config } from "../src/config.ts";

const fa = (n) => Math.round(n).toLocaleString("fa-IR");
const cls = priceOf(90 * 60);
const ourCost = (toman) => (toman / TOMAN_PER_MINUTE) * COST_PER_MINUTE_TOMAN;

console.log("فرض‌ها");
console.log(`  کلاس ۹۰ دقیقه‌ای: ${fa(cls)} تومان · هزینهٔ پردازشش برای ما ${fa(ourCost(cls))} تومان`);
console.log(`  هدیهٔ شروعِ هر حساب: ${fa(config.FREE_TRIAL_TOMAN)} تومان`);
console.log(`  سقف هفتگیِ سهم‌های هدیه‌ای: ${fa(config.SHARE_GIFT_TOMAN_PER_WEEK)} تومان\n`);

for (const people of [2, 5, 10]) {
  const seat = shareSeat(cls, people);
  const cap = shareCap(cls, people);
  console.log(`${people} نفر: سهم ${fa(seat)} · صاحب جلسه تا ${fa(cap)} پس می‌گیرد و فقط ${fa(cls - cap)} می‌دهد`);
}

/**
 * بدترین هفته: کلِ سقفِ هدیه با حساب‌های ساختگی خرج شود. هر تومانِ آن به اعتبارِ
 * واقعیِ یک صاحب جلسه تبدیل می‌شود و دوباره پردازش می‌خرد — یعنی هزینهٔ ما همان
 * مقدار دقیقه است، بی درآمد.
 */
const weeklyLeak = ourCost(config.SHARE_GIFT_TOMAN_PER_WEEK);
console.log(`\nبدترین هفته (همهٔ سقف با حساب ساختگی): هزینهٔ پردازشِ بی‌درآمد ≈ ${fa(weeklyLeak)} تومان`);
const accounts = Math.ceil(config.SHARE_GIFT_TOMAN_PER_WEEK / Math.max(1, config.FREE_TRIAL_TOMAN));
console.log(`  برای رسیدن به آن دست‌کم ${fa(accounts)} حسابِ ساختگیِ تازه لازم است (هر کدام یک هدیه).`);
console.log("\n✅ سقف هفتگی مهارِ این نشتی است؛ اگر لاگ «gift budget» زیاد دیدی، سقف را پایین بیاور.");
