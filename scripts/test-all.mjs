/**
 * همهٔ آزمون‌های سریع، با محیط درستِ هرکدام.
 *
 * دو آزمون (`gift` و `identity`) روی پایگاه‌دادهٔ واقعی می‌نویسند و اگر روی
 * `DATA_DIR` پیش‌فرض اجرا شوند، بار دوم روی بازماندهٔ بار اول قرمز می‌شوند —
 * قرمزی‌ای که ربطی به کد ندارد و وقت می‌گیرد تا معلوم شود کاذب است. اینجا
 * هرکدام مسیر تازهٔ خودش را می‌گیرد و بعد پاک می‌شود.
 *
 * اجرا: node scripts/test-all.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** آزمون‌هایی که به پایگاه‌دادهٔ تازه نیاز دارند. */
const NEEDS_DB = new Set(["gift", "identity"]);

const tests = [
  "keyboards",
  "platform-detect",
  "miniapp-detect",
  "bale-plain",
  "history-page",
  "app-send",
  "no-external",
  "confirm-flow",
  "admin-platform",
  "gift",
  "identity",
];

const tmpRoot = path.join("data", `tmp-test-${process.pid}`);
let failed = 0;

for (const name of tests) {
  const env = { ...process.env };
  if (NEEDS_DB.has(name)) env.DATA_DIR = path.join(tmpRoot, name);

  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", `scripts/test-${name}.mjs`],
    { env, encoding: "utf8" },
  );

  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} test-${name}`);
  // خروجی فقط وقتی چاپ می‌شود که لازم باشد — وگرنه شکستِ واقعی زیر صدها خط سبز گم می‌شود.
  if (!ok) console.log(((r.stdout || "") + (r.stderr || "")).trimEnd().split("\n").slice(-25).join("\n"));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(failed === 0 ? "\nهمه سبز ✅" : `\n${failed} آزمون شکست خورد ❌`);
process.exit(failed === 0 ? 0 : 1);
