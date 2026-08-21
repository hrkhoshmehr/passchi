import { chat, extractJson } from "../src/analysis/openrouter.js";
import { config } from "../src/config.js";

const model = process.argv[2] || config.OPENROUTER_MODEL;
console.log("مدل:", model);

const t0 = Date.now();
const r = await chat(
  [
    { role: "system", content: "تو دستیار درسی یک دانشجوی ایرانی هستی. فقط فارسی جواب بده." },
    {
      role: "user",
      content:
        "این تکه از رونوشت یک کلاس است:\n\n" +
        "[00:12:30] استاد: سری سه رو بردارید تا شنبه تحویل بدید\n" +
        "[00:14:02] استاد: این تیپ سوال سطح تراز تو میان‌ترم هست\n\n" +
        'یک JSON با این شکل بده: {"points":[{"kind":"...","title":"...","quote":"...","at_ms":0}]}. ' +
        "quote باید عین جمله باشد.",
    },
  ],
  { model, maxTokens: 1500 },
);

console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} ثانیه · ورودی ${r.inputTokens} · خروجی ${r.outputTokens} توکن`);
console.log("مدل واقعی:", r.model);
console.log("\nخروجی خام:\n" + r.text.slice(0, 700));
try {
  console.log("\nJSON استخراج‌شده:", JSON.stringify(extractJson(r.text), null, 1).slice(0, 500));
} catch (e) {
  console.log("\n⚠️ استخراج JSON ناموفق:", String(e).slice(0, 200));
}
