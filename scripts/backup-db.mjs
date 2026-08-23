/**
 * پشتیبان‌گیری از پایگاه‌داده.
 *
 * این فایل دفتر کل مالی است: چه کسی چقدر پرداخت کرده، چقدر سکه دارد، و چه
 * جلسه‌ای را خریده. کپی‌کردن ساده‌اش با `cp` امن نیست چون دیتابیس در حالت
 * WAL باز است و ممکن است نیمه‌کاره گرفته شود؛ پس از `backup()` خودِ SQLite
 * استفاده می‌شود که تراکنش‌ها را محترم می‌شمارد و روی دیتابیسِ درحال‌استفاده
 * هم درست کار می‌کند.
 *
 * روزی یک بار از کران اجرا می‌شود و چهارده نسخهٔ آخر را نگه می‌دارد.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { config } from "../src/config.ts";

const KEEP = 14;
const dir = path.join(config.dataDir, "backups");
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 10);
const dest = path.join(dir, `kharkhoon-${stamp}.db`);

const db = new DatabaseSync(config.dbPath, { readOnly: true });
await backup(db, dest);
db.close();

const size = (fs.statSync(dest).size / 1024).toFixed(0);
console.log(`پشتیبان گرفته شد: ${dest} (${size} کیلوبایت)`);

// نسخه‌های قدیمی‌تر از سقف نگهداری پاک می‌شوند
const old = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith("kharkhoon-") && f.endsWith(".db"))
  .sort()
  .slice(0, -KEEP);
for (const f of old) {
  fs.unlinkSync(path.join(dir, f));
  console.log(`حذف نسخهٔ قدیمی: ${f}`);
}
