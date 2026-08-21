import { config } from "../src/config.js";
const key = config.SONIOX_API_KEY;
const res = await fetch("https://api.soniox.com/v1/files?limit=50", {
  headers: { Authorization: `Bearer ${key}` },
});
const { files } = await res.json();
console.log(`${files.length} فایل روی سرور:`);
for (const f of files) {
  console.log(`  ${f.id}  ${String(Math.round(f.size / 1024 / 1024)).padStart(3)}MB  ${f.filename}  ${f.created_at}`);
}
console.log("\nرونویسی‌ها:");
const r2 = await fetch("https://api.soniox.com/v1/transcriptions?limit=20", {
  headers: { Authorization: `Bearer ${key}` },
});
const t = await r2.json();
for (const x of t.transcriptions ?? []) {
  console.log(`  ${x.id}  ${x.status}  ${x.audio_duration_ms ?? "-"}ms  ${x.filename}`);
}
if (!(t.transcriptions ?? []).length) console.log("  (هیچ — یعنی هنوز چیزی حساب نشده)");
