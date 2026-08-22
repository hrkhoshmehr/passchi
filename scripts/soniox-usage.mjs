import { config } from "../src/config.js";
const h = { Authorization: `Bearer ${config.SONIOX_API_KEY}` };
for (const p of ["/v1/usage/summary", "/v1/usage-summary", "/v1/usage"]) {
  const r = await fetch("https://api.soniox.com" + p, { headers: h }).catch(() => null);
  if (r?.ok) { console.log(p, "→", (await r.text()).slice(0, 600)); break; }
  console.log(p, "→", r?.status ?? "خطا");
}
