import { db } from "../src/db/index.js";
const rows = db.prepare("SELECT original_ms, cost_usd, notes_md FROM sessions WHERE status='done' AND cost_usd > 0").all();
console.log("جلسات با هزینهٔ ثبت‌شده:", rows.length);
let totMin = 0, totUsd = 0;
for (const r of rows) {
  const min = r.original_ms / 60000;
  totMin += min; totUsd += Number(r.cost_usd);
  console.log(`  ${min.toFixed(0)} دقیقه → $${Number(r.cost_usd).toFixed(4)} LLM ${r.notes_md ? "(با جزوه)" : "(بدون جزوه)"}`);
}
if (rows.length) {
  console.log(`\nمیانگین LLM به ازای هر دقیقه صوت: $${(totUsd/totMin).toFixed(5)}`);
  console.log(`یعنی برای ۹۰ دقیقه: $${((totUsd/totMin)*90).toFixed(4)}`);
}
