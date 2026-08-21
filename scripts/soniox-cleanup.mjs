/** فقط فایل‌هایی که *این پروژه* آپلود کرده پاک می‌شوند — بقیه دست نمی‌خورند. */
import { config } from "../src/config.js";
const key = config.SONIOX_API_KEY;
const h = { Authorization: `Bearer ${key}` };
const res = await fetch("https://api.soniox.com/v1/files?limit=100", { headers: h });
const { files } = await res.json();
const mine = files.filter((f) => (f.client_reference_id ?? "").startsWith("example."));
if (mine.length === 0) { console.log("چیزی برای پاک‌کردن نیست."); process.exit(0); }
for (const f of mine) {
  const d = await fetch(`https://api.soniox.com/v1/files/${f.id}`, { method: "DELETE", headers: h });
  console.log(`${d.ok ? "پاک شد" : "ناموفق " + d.status}: ${f.filename} (${Math.round(f.size/1024/1024)}MB) ref=${f.client_reference_id}`);
}
