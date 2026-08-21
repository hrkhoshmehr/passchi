import { config } from "../src/config.js";
const key = config.SONIOX_API_KEY;
console.log("کلید:", key ? `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} کاراکتر)` : "نیست");
const t0 = Date.now();
try {
  const res = await fetch("https://api.soniox.com/v1/files?limit=1", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  console.log(`وضعیت: ${res.status} در ${((Date.now() - t0) / 1000).toFixed(1)} ثانیه`);
  console.log("پاسخ:", body.slice(0, 300));
} catch (e) {
  console.log(`خطا پس از ${((Date.now() - t0) / 1000).toFixed(1)} ثانیه:`, String(e).slice(0, 300));
  if (e.cause) console.log("علت:", String(e.cause).slice(0, 300));
}
