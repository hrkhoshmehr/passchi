/**
 * بعد از شارژ، کاربر به همان کاری برمی‌گردد که برایش شارژ کرد — لایهٔ داده.
 *
 * پیش از این، ربات بعد از هر شارژ فقط فایلِ منتظرِ داخلِ خودِ ربات را می‌دید؛
 * هم‌کلاسی‌ای که برای برداشتنِ جزوه شارژ کرده بود و دانشجویی که از صفحهٔ
 * آپلود فرستاده بود، هر دو «صوت کلاستو بفرست» می‌گرفتند.
 */
const { upsertUser, createSession, db, rememberPendingJoin, takePendingJoin, pendingWebUploadId } =
  await import("../src/db/index.ts");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

let bad = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) bad++;
};

const U = 9400001;
const OWNER = 9400002;
upsertUser(U, "آزمون", null);
upsertUser(OWNER, "مالک", null);

// ─── جزوهٔ هم‌کلاسی ─────────────────────────────────────────────────────────
const shared = "0e0000000001";
createSession(shared, OWNER, null);
rememberPendingJoin(U, shared);
check("خواستهٔ پیوستن نگه داشته شد", takePendingJoin(U) === shared);
check("بعد از یک بار پیشنهاد پاک شد", takePendingJoin(U) === null);

rememberPendingJoin(U, shared);
db.prepare("UPDATE pending_joins SET created_at = datetime('now', '-8 days') WHERE tg_id = ?").run(U);
check("خواستهٔ کهنه‌تر از هفت روز پیشنهاد نمی‌شود", takePendingJoin(U) === null);

// ─── آپلودِ منتظرِ مینی‌اپ ─────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "passchi-cont-"));
const file = path.join(tmp, "a.m4a");
fs.writeFileSync(file, "x");
const web = "0e0000000002";
createSession(web, U, null);
db.prepare("UPDATE sessions SET status = 'queued', download_route = 'web', original_file = ? WHERE id = ?").run(file, web);
check("آپلودِ منتظرِ مینی‌اپ پیدا می‌شود", pendingWebUploadId(U) === web);
check("آپلودِ بقیه برای این کاربر پیدا نمی‌شود", pendingWebUploadId(OWNER) === null);
fs.rmSync(file);
check("بی‌فایل پیشنهاد نمی‌شود", pendingWebUploadId(U) === null);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
