/**
 * بررسی قیمت‌گذاری: هزینهٔ تمام‌شده، حاشیهٔ هر پکیج، و قیمت یک کلاس واقعی.
 *
 * بعد از هر تغییری در `PACKAGES`، `TOMAN_PER_MINUTE` یا فرض‌های هزینه اجرا شود.
 * حاشیه **پس از کارمزد درگاه** است (`packageMargin`) و هدیهٔ پکیج را هم حساب
 * می‌کند؛ عددِ پیش از کارمزد فقط برای مقایسه کنارش می‌آید.
 *
 * اجرا: node --import tsx scripts/pricing.mjs
 */
import {
  COST_PER_AUDIO_HOUR_USD, COST_PER_MINUTE_TOMAN, GATEWAY_FEE_MAX_TOMAN, GATEWAY_FEE_MIN_TOMAN,
  GATEWAY_FEE_PCT, GATEWAY_FEE_VAT, MIN_MARGIN, MIN_TOPUP_TOMAN, PACKAGES, SHARE_COUNTS, TOMAN_PER_MINUTE,
  USD_TOMAN, fileTopup, gatewayFeeToman, packageMargin, priceOf, shareCap, shareSeat,
} from "../src/billing/money.ts";

const fa = (n) => Math.round(n).toLocaleString("fa-IR");

console.log("فرض‌های هزینه");
console.log(`  هر ساعت صوت: $${COST_PER_AUDIO_HOUR_USD.toFixed(2)} · نرخ دلار ${fa(USD_TOMAN)} تومان`);
console.log(`  هزینهٔ هر دقیقه برای ما: ${COST_PER_MINUTE_TOMAN.toFixed(1)} تومان · قیمتِ فروشِ هر دقیقه: ${fa(TOMAN_PER_MINUTE)} تومان`);
console.log(
  `  کارمزد درگاه: ${GATEWAY_FEE_PCT * 100}٪، کف ${fa(GATEWAY_FEE_MIN_TOMAN)} و سقف ${fa(GATEWAY_FEE_MAX_TOMAN)} تومان،` +
    ` +${GATEWAY_FEE_VAT * 100}٪ مالیات\n`,
);

let worst = Infinity;
console.log("پکیج‌ها (حاشیه پس از کارمزد، با هدیه)");
for (const p of PACKAGES) {
  const margin = packageMargin(p);
  worst = Math.min(worst, margin);
  const perMinute = p.price / (p.credit / TOMAN_PER_MINUTE);
  console.log(
    `  ${p.id} · ${fa(p.price).padStart(9)} تومان ⇒ اعتبار ${fa(p.credit).padStart(9)}` +
      ` · کارمزد ${fa(gatewayFeeToman(p.price))} · هر دقیقه عملاً ${fa(perMinute)} تومان · حاشیه ×${margin.toFixed(2)}`,
  );
}

const minFile = fileTopup(0);
const fileMargin = packageMargin(minFile);
worst = Math.min(worst, fileMargin);
console.log(`\n«پرداخت همین فایل» با کمترین مبلغ (${fa(MIN_TOPUP_TOMAN)}): حاشیه ×${fileMargin.toFixed(2)}`);

console.log("\nیک کلاس ۹۰ دقیقه‌ای");
const cls = priceOf(90 * 60);
console.log(`  قیمت: ${fa(cls)} تومان`);
for (const n of SHARE_COUNTS) {
  console.log(`  ${fa(n)} نفر: سهم هر نفر ${fa(shareSeat(cls, n))} · برگشتیِ صاحب جلسه تا ${fa(shareCap(cls, n))}`);
}

console.log(`\nکف حاشیه پس از کارمزد: ×${worst.toFixed(2)} (حداقل قابل قبول: ×${MIN_MARGIN})`);
if (worst < MIN_MARGIN) {
  console.error("❌ یک پکیج یا پرداختِ فایل زیر کف حاشیه است.");
  process.exit(1);
}
console.log("✅ همه بالای کف حاشیه‌اند.");
