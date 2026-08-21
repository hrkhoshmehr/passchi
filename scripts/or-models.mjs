import { config } from "../src/config.js";
const res = await fetch("https://openrouter.ai/api/v1/models", {
  headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
});
const { data } = await res.json();
const free = data.filter(
  (m) => Number(m.pricing?.prompt ?? 1) === 0 && Number(m.pricing?.completion ?? 1) === 0,
);
free.sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
console.log(`${free.length} مدل رایگان، مرتب بر اساس طول بافت:\n`);
for (const m of free.slice(0, 30)) {
  console.log(
    `${String(m.context_length ?? 0).padStart(8)}  ${String(m.top_provider?.max_completion_tokens ?? "?").padStart(7)} out  ${m.id}`,
  );
}
