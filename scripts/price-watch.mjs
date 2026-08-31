/**
 * دیدبان قیمت مدل.
 *
 * قیمت‌گذاری ما روی یک عدد بنا شده — هزینهٔ هر ساعت صوت — و آن عدد به قیمت
 * مدلی وابسته است که هر روز ممکن است عوض شود. بدون این دیدبان، گران‌شدن مدل
 * فقط وقتی معلوم می‌شود که صورتحساب رسیده باشد و ماه‌ها زیر قیمت فروخته باشیم.
 *
 * قیمت زندهٔ OpenRouter را می‌گیرد، هزینهٔ هر ساعت را با آن دوباره حساب
 * می‌کند، و می‌گوید حاشیهٔ هر پکیج کجا می‌رود. با `--notify` نتیجه را در
 * صورت افت حاشیه برای ادمین تلگرام هم می‌فرستد.
 *
 * اجرا: node scripts/price-watch.mjs [--notify]
 */
import {
  COINS_PER_MINUTE, COST_PER_COIN_TOMAN, LLM_COST_PER_HOUR_USD, MODEL_PRICE_BASELINE, PACKAGES,
  STT_COST_PER_HOUR_USD, USD_TOMAN,
} from "../src/billing/coins.ts";
import { config } from "../src/config.ts";

const MIN_MARGIN = 2.0;
const fa = (n) => Math.round(n).toLocaleString("fa-IR");
const models = config.OPENROUTER_MODEL.split(",").map((m) => m.trim()).filter(Boolean);

const res = await fetch("https://openrouter.ai/api/v1/models", {
  headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
});
if (!res.ok) {
  console.error(`فهرست مدل‌ها گرفته نشد: ${res.status}`);
  process.exit(2);
}
const { data } = await res.json();

/**
 * نسبت گران‌شدن، محافظه‌کارانه: بیشینهٔ نسبتِ ورودی و خروجی.
 *
 * نسبت واقعی به ترکیب توکن‌های ما بستگی دارد، ولی گرفتنِ بدترینِ دو نسبت،
 * ما را از سمت امن خطا نگه می‌دارد.
 */
function ratioOf(m) {
  const inp = Number(m.pricing?.prompt ?? 0) * 1e6;
  const out = Number(m.pricing?.completion ?? 0) * 1e6;
  return {
    inp,
    out,
    ratio: Math.max(inp / MODEL_PRICE_BASELINE.in, out / MODEL_PRICE_BASELINE.out),
  };
}

const COINS_PER_HOUR = 60 * COINS_PER_MINUTE;

const primaryId = models[0];
const primary = data.find((m) => m.id === primaryId);
if (!primary) {
  console.error(`❌ مدل اصلی «${primaryId}» دیگر روی OpenRouter نیست — زنجیرهٔ جایگزین را بررسی کن.`);
  process.exit(1);
}

const { inp, out, ratio } = ratioOf(primary);
const llmNow = LLM_COST_PER_HOUR_USD * ratio;
const hourNow = STT_COST_PER_HOUR_USD + llmNow;
// سومین جای همان باگ: تقسیم بر هفت از دورانِ «هفت سکه در هر دقیقه» مانده
// بود و هزینهٔ هر سکه را یک‌هفتم نشان می‌داد ⇒ حاشیهٔ ×۱۱٫۸ به‌جای ×۲٫۴.
const coinCostNow = (hourNow / COINS_PER_HOUR) * USD_TOMAN;

console.log(`مدل اصلی: ${primaryId}`);
console.log(`  قیمت پایه: ورودی ${MODEL_PRICE_BASELINE.in} · خروجی ${MODEL_PRICE_BASELINE.out}`);
console.log(`  قیمت امروز: ورودی ${inp.toFixed(3)} · خروجی ${out.toFixed(3)} ⇒ ضریب ×${ratio.toFixed(2)}`);
console.log(`  هزینهٔ هر ساعت: $${hourNow.toFixed(3)} (پایه $${(STT_COST_PER_HOUR_USD + LLM_COST_PER_HOUR_USD).toFixed(3)})`);
console.log(`  هزینهٔ هر سکه: ${coinCostNow.toFixed(1)} تومان (پایه ${COST_PER_COIN_TOMAN.toFixed(1)})\n`);

let worst = Infinity;
for (const p of PACKAGES) {
  const margin = p.price / p.coins / coinCostNow;
  worst = Math.min(worst, margin);
  console.log(`  پکیج ${String(p.coins).padStart(5)} · حاشیه ×${margin.toFixed(2)}${margin < MIN_MARGIN ? "  ⚠️" : ""}`);
}

/** مدل چند برابر گران‌تر شود تا حاشیه به کف برسد. */
const worstPkg = PACKAGES.reduce((a, b) => (a.price / a.coins < b.price / b.coins ? a : b));
const maxCoinCost = worstPkg.price / worstPkg.coins / MIN_MARGIN;
const maxHour = (maxCoinCost / USD_TOMAN) * COINS_PER_HOUR;
const headroom = (maxHour - STT_COST_PER_HOUR_USD) / LLM_COST_PER_HOUR_USD;

const breakEvenHour = (worstPkg.price / worstPkg.coins / USD_TOMAN) * COINS_PER_HOUR;
const breakEven = (breakEvenHour - STT_COST_PER_HOUR_USD) / LLM_COST_PER_HOUR_USD;

console.log(`\nتا کف حاشیهٔ ×${MIN_MARGIN}، قیمت مدل می‌تواند تا ×${headroom.toFixed(1)} گران شود.`);
console.log(`تا نقطهٔ سربه‌سر — جایی که واقعاً ضرر می‌دهیم — تا ×${breakEven.toFixed(1)}.`);
console.log(`(چون ${Math.round((STT_COST_PER_HOUR_USD / (STT_COST_PER_HOUR_USD + LLM_COST_PER_HOUR_USD)) * 100)}٪ هزینه رونویسی است نه مدل — و آن دست OpenRouter نیست.)`);

console.log("\nجایگزین‌های زنجیره، به همان مقیاس:");
for (const id of models.slice(1)) {
  const m = data.find((x) => x.id === id);
  if (!m) { console.log(`  ${id.padEnd(30)} ❌ دیگر موجود نیست`); continue; }
  const r = ratioOf(m);
  const hour = STT_COST_PER_HOUR_USD + LLM_COST_PER_HOUR_USD * r.ratio;
  console.log(`  ${id.padEnd(30)} ×${r.ratio.toFixed(2)} ⇒ $${hour.toFixed(3)} بر ساعت`);
}

const ok = worst >= MIN_MARGIN;
console.log(ok ? "\n✅ حاشیه سالم است." : `\n❌ حاشیه زیر کف ×${MIN_MARGIN} رفته.`);

if (!ok && process.argv.includes("--notify") && config.BOT_TOKEN && config.ADMIN_IDS.length) {
  const text =
    `⚠️ <b>هشدار قیمت مدل</b>\n\n` +
    `<code>${primaryId}</code> حالا ×${ratio.toFixed(2)} قیمت پایه است.\n` +
    `هزینهٔ هر ساعت صوت: $${hourNow.toFixed(3)} · هر سکه ${fa(coinCostNow)} تومان\n` +
    `کمترین حاشیه: ×${worst.toFixed(2)} (کف ×${MIN_MARGIN})\n\n` +
    `یا مدل را عوض کن، یا <code>PACKAGES</code> را.`;
  for (const admin of config.ADMIN_IDS) {
    await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: admin, text, parse_mode: "HTML" }),
    }).catch(() => {});
  }
  console.log("هشدار برای ادمین فرستاده شد.");
}

process.exit(ok ? 0 : 1);
