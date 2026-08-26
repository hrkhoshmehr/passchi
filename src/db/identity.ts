/**
 * هویت چندسکویی — یک نفر، چند راه ورود.
 *
 * تا پیش از این، «کاربر» یعنی `users.tg_id`: یک عدد که مستقیماً شناسهٔ تلگرام
 * بود. با آمدن بله و مرورگر، آن فرض دیگر درست نیست ولی **ستون نباید عوض شود**:
 * جلسه‌ها، دفتر کل، عضویت‌ها و درس‌ها همه با کلید خارجی به آن وصل‌اند و تغییر
 * نامش یعنی مهاجرت هر جدول.
 *
 * پس `users.tg_id` می‌ماند و معنایش عوض می‌شود: **شناسهٔ داخلی کاربر**. برای
 * کاربر تلگرامی این همان شناسهٔ تلگرام است — پس هیچ سطر موجودی جابه‌جا
 * نمی‌شود و کاربران فعلی دست‌نخورده‌اند. برای بله و مرورگر، شناسهٔ داخلی از
 * یک دنبالهٔ جدا گرفته می‌شود که با فضای شناسهٔ تلگرام هم‌پوشانی ندارد.
 *
 * جدول `identities` نگاشت `(platform, platform_user_id) → user_id` را نگه
 * می‌دارد. چون کلیدش مرکب است، یک نفر می‌تواند چند راه ورود به یک حساب داشته
 * باشد — همان چیزی که «اتصال حساب» را بعداً ممکن می‌کند بدون مهاجرت دیگری.
 */

import { db, getUser, type UserRow } from "./index.js";

export type Platform = "telegram" | "bale" | "web";

db.exec(`
CREATE TABLE IF NOT EXISTS identities (
  platform          TEXT    NOT NULL,
  platform_user_id  TEXT    NOT NULL,
  user_id           INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  -- شمارهٔ موبایل فقط برای ورود وب معنا دارد؛ برای بقیه NULL می‌ماند
  phone             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
`);

/**
 * شمارهٔ موبایل **یکتا نیست** و عمداً یکتا نیست.
 *
 * نسخهٔ اول یک ایندکس یکتا روی `phone` داشت، با این فکر که «هر شماره یک
 * حساب». ولی دقیقاً همان مسیری را می‌شکست که شماره برایش هست: کاربری که در
 * بله شماره‌اش را داده و بعد از وب با همان شماره وارد می‌شود، باید هویت
 * *دومی* بگیرد که به **همان** کاربر اشاره کند — و آن درج با قید یکتایی
 * برخورد می‌کرد و کل ورود را می‌انداخت. (این را آزمون گرفت، نه بازبینی.)
 *
 * قید درست روی `user_id` است نه روی سطر هویت: یک شماره به یک کاربر می‌رسد،
 * ولی می‌تواند روی چند سطرِ هویتِ همان کاربر تکرار شود.
 *
 * ایندکس یکتای قدیمی روی پایگاه‌داده‌هایی که زودتر ساخته شده‌اند باقی مانده و
 * `CREATE INDEX IF NOT EXISTS` جایش را نمی‌گیرد، پس صریح حذف می‌شود.
 */
for (const i of db.prepare(`PRAGMA index_list(identities)`).all() as unknown as Array<{
  name: string;
  unique: number;
}>) {
  if (i.unique && i.name === "idx_identities_phone") db.exec(`DROP INDEX ${i.name}`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_identities_phone ON identities(phone) WHERE phone IS NOT NULL`,
);

/**
 * دنبالهٔ شناسهٔ داخلی برای کاربران غیرتلگرامی.
 *
 * دو قید هم‌زمان باید برقرار باشد و بازهٔ ممکن را باریک می‌کنند:
 *
 * ۱. **بالاتر از هر شناسهٔ تلگرامی.** تلگرام گفته شناسه‌ها تا ۲^۵۲ رشد
 *    می‌کنند (امروز حدود ۱۰ رقم‌اند). زیر آن یعنی روزی یک کاربر بله روی
 *    حساب یک کاربر تلگرامی بیفتد.
 *
 * ۲. **پایین‌تر از `Number.MAX_SAFE_INTEGER` (۲^۵۳−۱).** این قید در عمل
 *    کشف شد: نسخهٔ اول دقیقاً روی ۲^۵۳ بود و `node:sqlite` سرِ اولین ورود
 *    وب با «Value is too large to be represented as a JavaScript number»
 *    شکست. درایور عددی بزرگ‌تر از محدودهٔ امن را به `number` تبدیل نمی‌کند،
 *    و چون کل کد پایه روی `number` است، هیچ ارزش‌گذاری‌ای این را نجات
 *    نمی‌داد.
 *
 * پس پایه روی ۲^۵۲ گذاشته شده: بالای فضای تلگرام، و با فاصلهٔ ۲^۵۲ تا سقف
 * امن — یعنی چهار هزار تریلیون شناسهٔ ممکن، که هرگز تمام نمی‌شود.
 */
const INTERNAL_ID_BASE = 4_503_599_627_370_496; // 2^52

db.exec(`
CREATE TABLE IF NOT EXISTS internal_id_seq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function nextInternalId(): number {
  const row = db.prepare(`INSERT INTO internal_id_seq DEFAULT VALUES RETURNING id`).get() as unknown as {
    id: number;
  };
  return INTERNAL_ID_BASE + row.id;
}

export interface IdentityRow {
  platform: Platform;
  platform_user_id: string;
  user_id: number;
  phone: string | null;
}

export function findIdentity(platform: Platform, platformUserId: string): IdentityRow | null {
  return (
    (db
      .prepare(`SELECT * FROM identities WHERE platform = ? AND platform_user_id = ?`)
      .get(platform, platformUserId) as unknown as IdentityRow | undefined) ?? null
  );
}

/**
 * حسابی که این شماره به آن تعلق دارد.
 *
 * چون شماره می‌تواند روی چند سطر هویتِ یک کاربر بنشیند، ترتیب صریح است:
 * **قدیمی‌ترین** سطر برنده است. بدون این ترتیب، نتیجه به ترتیب دلخواه
 * SQLite وابسته می‌شد و ورود بعدی ممکن بود به حساب دیگری برسد.
 */
export function findByPhone(phone: string): IdentityRow | null {
  return (
    (db
      .prepare(`SELECT * FROM identities WHERE phone = ? ORDER BY created_at, rowid LIMIT 1`)
      .get(phone) as unknown as IdentityRow | undefined) ?? null
  );
}

/**
 * هویت را پیدا کن یا بساز، و سطر `users` متناظرش را برگردان.
 *
 * برای تلگرام، شناسهٔ داخلی **همان** شناسهٔ تلگرام است. این عمدی است و شرطِ
 * سازگاری با گذشته: کاربری که سال‌هاست با ربات کار کرده، سطر `users` و
 * جلسه‌ها و سکه‌هایش سر جایش می‌ماند و فقط یک سطر `identities` برایش ساخته
 * می‌شود که به خودش اشاره می‌کند.
 */
export function resolveIdentity(opt: {
  platform: Platform;
  platformUserId: string;
  name?: string | null;
  username?: string | null;
  phone?: string | null;
}): UserRow {
  const { platform, platformUserId } = opt;
  const existing = findIdentity(platform, platformUserId);

  if (existing) {
    db.prepare(
      `UPDATE identities SET last_seen_at = datetime('now'), phone = COALESCE(?, phone)
       WHERE platform = ? AND platform_user_id = ?`,
    ).run(opt.phone ?? null, platform, platformUserId);
    db.prepare(
      `UPDATE users SET name = COALESCE(?, name), username = COALESCE(?, username) WHERE tg_id = ?`,
    ).run(opt.name ?? null, opt.username ?? null, existing.user_id);
    return getUser(existing.user_id)!;
  }

  /**
   * ورود با شماره‌ای که قبلاً از راه دیگری دیده شده، **به همان حساب** وصل
   * می‌شود نه به حسابی تازه. کاربری که در تلگرام شماره‌اش را داده و بعد در
   * وب همان شماره را وارد می‌کند، یک نفر است و باید سکه‌هایش را ببیند.
   */
  const byPhone = opt.phone ? findByPhone(opt.phone) : null;
  const userId =
    byPhone?.user_id ?? (platform === "telegram" ? Number(platformUserId) : nextInternalId());

  db.prepare(
    `INSERT INTO users (tg_id, name, username) VALUES (?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET
       name = COALESCE(excluded.name, users.name),
       username = COALESCE(excluded.username, users.username)`,
  ).run(userId, opt.name ?? null, opt.username ?? null);

  db.prepare(
    `INSERT INTO identities (platform, platform_user_id, user_id, phone) VALUES (?, ?, ?, ?)`,
  ).run(platform, platformUserId, userId, opt.phone ?? null);

  return getUser(userId)!;
}

/** سکوهایی که یک حساب از آن‌ها وارد شده — برای صفحهٔ حساب کاربری. */
export function identitiesOf(userId: number): IdentityRow[] {
  return db
    .prepare(`SELECT * FROM identities WHERE user_id = ? ORDER BY created_at`)
    .all(userId) as unknown as IdentityRow[];
}

/**
 * شمارهٔ موبایل ایرانی را به شکل متعارف `989xxxxxxxxx` درمی‌آورد.
 *
 * یک شماره را کاربر به چند شکل می‌نویسد (`0912…`، `+98912…`، `98912…`، و با
 * ارقام فارسی). اگر خام ذخیره شود، همان آدم با دو نوشتنِ متفاوت دو حساب
 * می‌گیرد — و چون شمارهٔ کلیدِ یکتاسازی حساب‌هاست، این یعنی سکه‌هایش گم شود.
 */
export function normalizePhone(input: string): string | null {
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  const ar = "٠١٢٣٤٥٦٧٨٩";
  let s = input
    .trim()
    .replace(/[۰-۹]/g, (d) => String(fa.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ar.indexOf(d)))
    .replace(/[\s\-()]/g, "");

  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("00")) s = s.slice(2);
  if (s.startsWith("0")) s = "98" + s.slice(1);
  if (s.startsWith("9") && s.length === 10) s = "98" + s;

  return /^989\d{9}$/.test(s) ? s : null;
}
