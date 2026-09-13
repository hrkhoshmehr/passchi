import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import type { AnalysisReport } from "../analysis/schema.js";
import type { TimeSegment } from "../audio/ffmpeg.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  tg_id        INTEGER PRIMARY KEY,
  name         TEXT,
  username     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- اعتبار به تومان (تا ۲۰۲۶-۰۹-۱۴ ثانیهٔ صوت؛ مهاجرت پایین‌تر)
  credit_toman INTEGER NOT NULL DEFAULT 0,
  total_spent_toman INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_flags (
  tg_id      INTEGER PRIMARY KEY REFERENCES users(tg_id) ON DELETE CASCADE,
  -- جلسهٔ رایگانِ «فقط رونوشت» یک بار در عمر هر کاربر است
  free_used  INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS courses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id        INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  professor    TEXT,
  -- واژگان تخصصی انباشته‌شده از جلسات قبل، ورودی پارامتر context سونیوکس
  terms_json   TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tg_id, name)
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  tg_id         INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  course_id     INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  status        TEXT NOT NULL,            -- queued|preprocess|stt|analyze|pdf|done|error|cancelled
  title         TEXT,
  session_date  TEXT,
  original_file TEXT,
  original_ms   INTEGER NOT NULL DEFAULT 0,
  billed_ms     INTEGER NOT NULL DEFAULT 0,
  silence_ms    INTEGER NOT NULL DEFAULT 0,
  time_map_json TEXT,
  report_json   TEXT,
  notes_md      TEXT,
  transcript_txt TEXT,
  pdf_path      TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(tg_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_course ON sessions(course_id, created_at DESC);
`);

/**
 * مهاجرت‌های افزایشی. CREATE TABLE IF NOT EXISTS ستون جدید اضافه نمی‌کند،
 * پس ستون‌های بعدی باید جداگانه و به‌صورت idempotent اضافه شوند.
 */
for (const [column, ddl] of [
  ["audio_chat_id", "ALTER TABLE sessions ADD COLUMN audio_chat_id INTEGER"],
  ["audio_message_id", "ALTER TABLE sessions ADD COLUMN audio_message_id INTEGER"],
  ["download_route", "ALTER TABLE sessions ADD COLUMN download_route TEXT"],
  // مسیر PDF رونوشت — چون نمایشگرِ فایل متنی روی گوشیِ بله متن فارسی را
  // ناخوانا نشان می‌دهد و PDF قلم و رمزگذاری را با خودش می‌برد.
  ["transcript_pdf", "ALTER TABLE sessions ADD COLUMN transcript_pdf TEXT"],
  ["transcript_srt", "ALTER TABLE sessions ADD COLUMN transcript_srt TEXT"],
  // شناسهٔ فایل در تلگرام: ارسال دوباره به کسی که به جلسه می‌پیوندد رایگان و
  // فوری است، و بدون آن لینک‌های زمانی برای او کار نمی‌کنند.
  ["audio_file_id", "ALTER TABLE sessions ADD COLUMN audio_file_id TEXT"],
  ["share_enabled", "ALTER TABLE sessions ADD COLUMN share_enabled INTEGER NOT NULL DEFAULT 0"],
  // تعداد تقریبیِ کلاس که مالک هنگام روشن‌کردن اشتراک انتخاب می‌کند؛ سهمِ ثابتِ
  // هر نفر از همین درمی‌آید. NULL یعنی هنوز انتخاب نشده — پیش‌فرض SHARE_TARGET.
  ["share_target", "ALTER TABLE sessions ADD COLUMN share_target INTEGER"],
  // free_trial | full | free_transcript — حالت اجرای جلسه.
  //
  // `free_transcript` حالت رایگانِ *قدیمی* است: فقط رونوشت، بدون تحلیل. دیگر
  // تولید نمی‌شود ولی سطرهای قبلی در پایگاه‌داده همین مقدار را دارند و واقعاً
  // تحلیلی ندارند، پس مقدار باید بماند تا تاریخچه درست رفتار کند.
  ["mode", "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'"],
  // شناسهٔ پیام صوت در کانال بایگانی. گزارش بعداً **ریپلای همین پیام** فرستاده
  // می‌شود، پس بدون نگه‌داشتنش گزارش از صوتش جدا می‌افتد.
  ["archive_message_id", "ALTER TABLE sessions ADD COLUMN archive_message_id INTEGER"],
  // صوتی که گزارشِ این جلسه به آن آویزان است، و چتی که در آن نشسته.
  //
  // بخش‌بندی زمانی پشت دکمه رفته و شاید هفته‌ها بعد زده شود؛ بدون این دو، آن
  // پیام دیگر ریپلایِ صوت نیست و زمان‌هایش از لینکِ پخش می‌افتند — یعنی همان
  // قابلیتی که کل ترتیبِ تحویل برایش چیده شده.
  //
  // **جوابِ یک پرسش، برای هر دو مسیر.** آپلود در ربات یعنی صوت را خودِ کاربر
  // فرستاده (`audio_message_id`)، و آپلود در مینی‌اپ یعنی `deliverToBot` خودش
  // فرستاده؛ ولی هر دو همین‌جا می‌نویسند و همه از همین‌جا می‌خوانند. اگر هر
  // مسیر میدان خودش را داشت، دکمه در یکی از دو مسیر بی‌صدا زمان‌هایش را
  // می‌باخت — و `audio_message_id` که برای جلسهٔ مینی‌اپ همیشه تهی است دقیقاً
  // همین را می‌کرد.
  //
  // چت هم لازم است نه فقط پیام: عضوی که جلسه با او تقسیم شده دکمه را در چتِ
  // *خودش* می‌زند، جایی که آن شمارهٔ پیام یا نیست یا پیامِ دیگری است.
  ["delivered_chat_id", "ALTER TABLE sessions ADD COLUMN delivered_chat_id INTEGER"],
  ["delivered_audio_message_id", "ALTER TABLE sessions ADD COLUMN delivered_audio_message_id INTEGER"],
] as const) {
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(ddl);
}

db.exec(`
CREATE TABLE IF NOT EXISTS credit_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         INTEGER NOT NULL,
  delta_toman   INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  session_id    TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(tg_id, id DESC);

CREATE TABLE IF NOT EXISTS session_members (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tg_id      INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  paid_toman INTEGER NOT NULL DEFAULT 0,
  -- بخشی از سهم که با اعتبارِ هدیه داده شد؛ بودجهٔ هفتگی روی جمعِ همین است
  gift_toman INTEGER NOT NULL DEFAULT 0,
  role       TEXT NOT NULL,
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, tg_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON session_members(tg_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS topups (
  id            TEXT PRIMARY KEY,
  tg_id         INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  package_id    TEXT NOT NULL,
  -- اعتباری که با واریز می‌آید (قیمت به‌علاوهٔ هدیهٔ پکیج)
  credit_toman  INTEGER NOT NULL,
  price_toman   INTEGER NOT NULL,
  status        TEXT NOT NULL,            -- awaiting_receipt|pending|approved|rejected
  receipt_file_id TEXT,
  decided_by    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_topups_user ON topups(tg_id, created_at DESC);
`);

/**
 * ستون‌های درگاه — افزایشی، چون جدول شارژ پیش از درگاه ساخته شده بود.
 *
 * `track_id` شناسهٔ پیگیری زیبال است (وضعیت `awaiting_payment`)؛
 * `ref_number` شمارهٔ مرجع بانکی پس از تأیید. سفارش کارت‌به‌کارت هر دو را
 * خالی دارد.
 */
for (const [column, ddl] of [
  ["track_id", "ALTER TABLE topups ADD COLUMN track_id TEXT"],
  ["ref_number", "ALTER TABLE topups ADD COLUMN ref_number TEXT"],
] as const) {
  const cols = db.prepare("PRAGMA table_info(topups)").all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(ddl);
}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_topups_track ON topups(track_id);

-- کد هدیه: ادمین سکه می‌سازد و لینکش را می‌دهد؛ گیرنده با زدن روی لینک
-- سکه‌ها را برمی‌دارد.
--
-- ستون max_uses تفاوت «هدیه به یک نفر» و «کد کلاسی» را می‌سازد و همان یک ستون
-- هر دو را پوشش می‌دهد: هدیهٔ شخصی یعنی max_uses = 1.
CREATE TABLE IF NOT EXISTS gifts (
  code        TEXT PRIMARY KEY,
  toman       INTEGER NOT NULL,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_by  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- تاریخ ISO؛ NULL یعنی بی‌انقضا
  expires_at  TEXT,
  -- کدی که هنوز خرج نشده را می‌شود باطل کرد
  revoked     INTEGER NOT NULL DEFAULT 0
);

-- سطرِ «چه کسی کدام کد را برداشت». کلید مرکب همان چیزی است که جلوی برداشتِ
-- دوبارهٔ یک کد توسط یک نفر را می‌گیرد — نه یک بررسیِ if در دست‌کد.
CREATE TABLE IF NOT EXISTS gift_claims (
  code       TEXT NOT NULL REFERENCES gifts(code) ON DELETE CASCADE,
  tg_id      INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  toman      INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, tg_id)
);
CREATE INDEX IF NOT EXISTS idx_claims_user ON gift_claims(tg_id, claimed_at DESC);

-- انتقال سکه بین دو کاربر، از راه لینک.
--
-- فرستنده معمولاً شناسهٔ داخلیِ گیرنده را **ندارد** — همان مشکلی که دستور /gift
-- برای ادمین حل کرد. پس جهت برعکس می‌شود: فرستنده لینک می‌سازد و گیرنده با
-- زدن رویش خودش را معرفی می‌کند.
--
-- ⚠️ اینجا سکه‌ای کنار گذاشته **نمی‌شود**. کسر در لحظهٔ برداشتن انجام می‌شود
-- و در همان تراکنشِ ثبتِ برداشت. با کنارگذاشتن (escrow) باید مسیر انصراف و
-- انقضا و برگشت هم می‌آمد، و هر کدام یک پنجرهٔ تازه برای گم‌شدن سکه است.
-- بهایش این است که لینکِ ساخته‌شده تضمین نیست: اگر فرستنده تا زمان برداشت
-- سکه‌هایش را خرج کند، برداشت رد می‌شود. متنِ لینک همین را می‌گوید.
CREATE TABLE IF NOT EXISTS coin_transfers (
  code       TEXT PRIMARY KEY,
  from_id    INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  coins      INTEGER NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- «این لینک را چه کسی برداشت». کلید روی خودِ ستون code است نه روی جفتِ
-- (code, tg_id): برخلاف کد هدیه، انتقال ظرفیتی ندارد و **یک** بار برداشته
-- می‌شود. پس دوبار-برداشتن را همین کلید غیرممکن می‌کند، نه یک بررسیِ if —
-- حتی وقتی دو نفر همزمان روی یک لینک بزنند.
CREATE TABLE IF NOT EXISTS coin_transfer_claims (
  code       TEXT PRIMARY KEY REFERENCES coin_transfers(code) ON DELETE CASCADE,
  tg_id      INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  coins      INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON coin_transfers(from_id, created_at DESC);
-- آخرین جزوه‌ای که کاربر خواست بردارد و سکه کم آورد؛ بعد از شارژ همان پیشنهاد می‌شود.
CREATE TABLE IF NOT EXISTS pending_joins (
  tg_id      INTEGER PRIMARY KEY REFERENCES users(tg_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- خرید گروهی: هزینهٔ یک جلسه پیش از پردازش، برابر میان چند نفر.
--
-- تا پرشدن هیچ سکه‌ای خرج نمی‌شود؛ سهم هر نفر فقط رزرو است و سطرش در
-- group_buy_seats است. پر که شد کار شروع می‌شود، و اگر تا expires_at پر
-- نشد همهٔ رزروها برمی‌گردند. origin می‌گوید جلسه پس از انقضا به کدام
-- وضعیت برگردد: ربات منتظر شارژ، مینی‌اپ آپلودِ تأییدنشده.
CREATE TABLE IF NOT EXISTS group_buys (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id       INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  seats          INTEGER NOT NULL,
  seat_sec       INTEGER NOT NULL,
  cost_sec       INTEGER NOT NULL,
  origin         TEXT NOT NULL,
  -- open | started | done | failed | expired | cancelled
  status         TEXT NOT NULL,
  -- آنچه مالک در پایان واقعاً داد؛ مبنای سقفِ برگشتِ شریک‌شدنِ پس از تحویل
  owner_paid_sec INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_group_buys_open ON group_buys(status, expires_at);

-- هر نفر یک سطر. reserved_sec برای مالک می‌تواند بیش از یک سهم باشد، وقتی
-- «بقیه‌اش رو خودم می‌دم» را زده. gift_sec بخشی از رزرو است که با سکهٔ
-- هدیه داده شده؛ سقفِ هفتگی روی جمعِ همین ستون است.
CREATE TABLE IF NOT EXISTS group_buy_seats (
  session_id   TEXT NOT NULL REFERENCES group_buys(session_id) ON DELETE CASCADE,
  tg_id        INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  reserved_sec INTEGER NOT NULL,
  gift_sec     INTEGER NOT NULL DEFAULT 0,
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, tg_id)
);

-- اولین صوتِ رایگان (billing/free-file.ts): یک سطر برای هر حساب، و هر محتوای
-- صوت هم فقط یک بار. fingerprint همان هشِ کشِ رونویسی است. سکهٔ واریزی در
-- credit_ledger با reason = free_file است؛ اینجا فقط دروازه و سقفِ هفتگی.
CREATE TABLE IF NOT EXISTS free_files (
  tg_id       INTEGER PRIMARY KEY REFERENCES users(tg_id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  granted_toman INTEGER NOT NULL,
  fallback    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_free_files_audio ON free_files(fingerprint);
CREATE INDEX IF NOT EXISTS idx_free_files_at ON free_files(created_at);
`);

/**
 * **مهاجرتِ یک‌بارهٔ واحدِ پول: ثانیه و سکه ← تومان (۲۰۲۶-۰۹-۱۴).**
 *
 * ستون‌ها تغییرِ نام می‌دهند و مقدارها در **همان** تراکنش ضرب می‌شوند؛ نشانهٔ
 * «هنوز مهاجرت نشده» خودِ ستونِ قدیمیِ `users.credit_sec` است، پس دوبار اجرا
 * نمی‌شود. نرخ همان نرخِ روزِ تبدیل است: هر دقیقه ۱٬۵۰۰ تومان، یعنی هر ثانیه ۲۵
 * و هر سکه (یک دقیقه) ۱٬۵۰۰.
 *
 * `balance_after` هم ضرب می‌شود تا تاریخچهٔ دفتر با موجودیِ تازه بخواند. جدول‌های
 * بازنشسته (`group_buys`، `coin_transfers`) دست نمی‌خورند؛ فقط خوانده می‌شوند.
 */
function columnsOf(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name);
}
if (columnsOf("users").includes("credit_sec")) {
  const PER_SEC = 25;
  const PER_COIN = 1_500;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE users RENAME COLUMN credit_sec TO credit_toman;
      ALTER TABLE users RENAME COLUMN total_used_sec TO total_spent_toman;
      UPDATE users SET credit_toman = credit_toman * ${PER_SEC}, total_spent_toman = total_spent_toman * ${PER_SEC};
      ALTER TABLE credit_ledger RENAME COLUMN delta_sec TO delta_toman;
      UPDATE credit_ledger SET delta_toman = delta_toman * ${PER_SEC}, balance_after = balance_after * ${PER_SEC};
      ALTER TABLE session_members RENAME COLUMN paid_sec TO paid_toman;
      UPDATE session_members SET paid_toman = paid_toman * ${PER_SEC};
      ALTER TABLE topups RENAME COLUMN coins TO credit_toman;
      UPDATE topups SET credit_toman = credit_toman * ${PER_COIN};
      ALTER TABLE gifts RENAME COLUMN coins TO toman;
      UPDATE gifts SET toman = toman * ${PER_COIN};
      ALTER TABLE gift_claims RENAME COLUMN coins TO toman;
      UPDATE gift_claims SET toman = toman * ${PER_COIN};
    `);
    if (columnsOf("free_files").includes("granted_sec")) {
      db.exec(`
        ALTER TABLE free_files RENAME COLUMN granted_sec TO granted_toman;
        UPDATE free_files SET granted_toman = granted_toman * ${PER_SEC};
      `);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
if (!columnsOf("session_members").includes("gift_toman")) {
  db.exec("ALTER TABLE session_members ADD COLUMN gift_toman INTEGER NOT NULL DEFAULT 0");
}


/**
 * آمار کلی برای `/stats` — «چند نفر ربات را استارت کردند».
 *
 * دو عدد جدا گزارش می‌شود و این عمدی است: **ثبت‌نام** و **استفاده**. هرکس
 * `/start` بزند یک ردیف در `users` می‌گیرد، حتی اگر هیچ‌وقت صوتی نفرستد. اگر
 * فقط عدد اول را نشان بدهیم، رشدِ توخالی را با رشد واقعی اشتباه می‌گیریم.
 *
 * شمارش سکو از `identities` می‌آید نه از `users`، چون `users.tg_id` امروز
 * شناسهٔ داخلی است و دیگر نمی‌گوید کاربر از کجا آمده. یک کاربر می‌تواند چند
 * هویت داشته باشد، پس `DISTINCT user_id` — وگرنه کسی که از دو سکو آمده دو بار
 * شمرده می‌شود و جمعِ سکوها از کل بیشتر درمی‌آید.
 */
export interface Overview {
  users: number;
  usersToday: number;
  users7d: number;
  byPlatform: Array<{ platform: string; users: number }>;
  activeUsers: number;
  sessions: number;
  sessionsDone: number;
}

export function overview(): Overview {
  const one = (sql: string): number =>
    Number((db.prepare(sql).get() as unknown as { n: number } | undefined)?.n ?? 0);

  return {
    users: one(`SELECT COUNT(*) AS n FROM users`),
    usersToday: one(`SELECT COUNT(*) AS n FROM users WHERE date(created_at) = date('now')`),
    users7d: one(`SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now', '-7 days')`),
    byPlatform: db
      .prepare(
        `SELECT platform, COUNT(DISTINCT user_id) AS users
           FROM identities GROUP BY platform ORDER BY users DESC`,
      )
      .all() as unknown as Array<{ platform: string; users: number }>,
    activeUsers: one(`SELECT COUNT(DISTINCT tg_id) AS n FROM sessions`),
    sessions: one(`SELECT COUNT(*) AS n FROM sessions`),
    sessionsDone: one(`SELECT COUNT(*) AS n FROM sessions WHERE status = 'done'`),
  };
}
// ─── users ───────────────────────────────────────────────────────────────────

export interface UserRow {
  tg_id: number;
  name: string | null;
  username: string | null;
  credit_toman: number;
  total_spent_toman: number;
}

export function upsertUser(tgId: number, name: string | null, username: string | null): UserRow {
  db.prepare(
    `INSERT INTO users (tg_id, name, username) VALUES (?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name, username = excluded.username`,
  ).run(tgId, name, username);
  return getUser(tgId)!;
}

export function getUser(tgId: number): UserRow | null {
  return (db.prepare(`SELECT * FROM users WHERE tg_id = ?`).get(tgId) as unknown as UserRow | undefined) ?? null;
}

// ─── سهمیهٔ رایگان ───────────────────────────────────────────────────────────
//
// یک بار در عمرِ هر کاربر: یک جلسهٔ «فقط رونوشت». پرچمش جدا از جدول users
// نگه داشته می‌شود تا با /forget و پاک‌کردن جلسات، از نو زنده نشود.

export function freeRunUsed(tgId: number): boolean {
  const row = db.prepare(`SELECT free_used FROM user_flags WHERE tg_id = ?`).get(tgId) as unknown as
    | { free_used: number }
    | undefined;
  return Boolean(row?.free_used);
}

export function markFreeRunUsed(tgId: number): void {
  db.prepare(
    `INSERT INTO user_flags (tg_id, free_used, used_at) VALUES (?, 1, datetime('now'))
     ON CONFLICT(tg_id) DO UPDATE SET free_used = 1, used_at = datetime('now')`,
  ).run(tgId);
}

// ─── courses ─────────────────────────────────────────────────────────────────

export interface CourseRow {
  id: number;
  tg_id: number;
  name: string;
  professor: string | null;
  terms_json: string;
}

export function listCourses(tgId: number): CourseRow[] {
  return db.prepare(`SELECT * FROM courses WHERE tg_id = ? ORDER BY name`).all(tgId) as unknown as CourseRow[];
}

export function getCourse(id: number): CourseRow | null {
  return (db.prepare(`SELECT * FROM courses WHERE id = ?`).get(id) as unknown as CourseRow | undefined) ?? null;
}

export function createCourse(tgId: number, name: string, professor: string | null): CourseRow {
  db.prepare(
    `INSERT INTO courses (tg_id, name, professor) VALUES (?, ?, ?)
     ON CONFLICT(tg_id, name) DO UPDATE SET professor = COALESCE(excluded.professor, courses.professor)`,
  ).run(tgId, name, professor);
  return db.prepare(`SELECT * FROM courses WHERE tg_id = ? AND name = ?`).get(tgId, name) as unknown as CourseRow;
}

export function courseTerms(c: CourseRow): string[] {
  try {
    const v = JSON.parse(c.terms_json) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * واژگان تازهٔ هر جلسه به بانک اصطلاحات درس اضافه می‌شود و در جلسهٔ بعد
 * به‌عنوان context به Soniox داده می‌شود — دقتِ درس با هر جلسه بالا می‌رود.
 */
export function mergeCourseTerms(courseId: number, newTerms: string[]): string[] {
  const c = getCourse(courseId);
  if (!c) return [];
  const set = new Set(courseTerms(c));
  for (const t of newTerms) {
    const v = t.trim();
    if (v.length > 1 && v.length < 60) set.add(v);
  }
  // سقف: فهرست خیلی بلند خودش نویز می‌شود
  const merged = [...set].slice(-400);
  db.prepare(`UPDATE courses SET terms_json = ? WHERE id = ?`).run(JSON.stringify(merged), courseId);
  return merged;
}

// ─── sessions ────────────────────────────────────────────────────────────────

/**
 * `awaiting_credit` یعنی فایل گرفته شده و سالم روی دیسک است، ولی اعتبار
 * کاربر کفاف نمی‌داد. جلسه زنده می‌ماند تا پس از شارژ ادامه پیدا کند — نه
 * `error` است (چیزی خراب نشده) نه `queued` (در صفی نیست).
 *
 * `awaiting_confirm` همان حالت است با یک تفاوت: اعتبار **هست** و فقط منتظر
 * «بله»ی کاربریم. فایل روی دیسک است و هیچ سکه‌ای هنوز رزرو نشده.
 *
 * هیچ‌کدام از این دو در صف نیستند، پس `orphanedQueued` سراغشان نمی‌رود.
 *
 * `awaiting_group` یعنی خرید گروهیِ باز: سهمِ چند نفر **رزرو** شده و منتظر
 * بقیه‌ایم. عمداً وضعیتِ جداست، چون هر جایی که «رزروِ بی‌تسویه» را آویزان
 * می‌شمارد (`danglingReservations`) یا «`queued`ِ بی‌رزرو» را آپلودِ
 * تأییدنشده (`orphanedQueued`، `GET /api/uploads/pending`) باید از آن بگذرد.
 */
export type SessionStatus =
  | "queued" | "awaiting_credit" | "awaiting_confirm" | "awaiting_group"
  | "preprocess" | "stt" | "analyze" | "pdf"
  | "done" | "error" | "cancelled";

export interface SessionRow {
  id: string;
  tg_id: number;
  course_id: number | null;
  status: SessionStatus;
  title: string | null;
  session_date: string | null;
  original_file: string | null;
  original_ms: number;
  billed_ms: number;
  silence_ms: number;
  time_map_json: string | null;
  report_json: string | null;
  notes_md: string | null;
  transcript_txt: string | null;
  pdf_path: string | null;
  transcript_pdf: string | null;
  transcript_srt: string | null;
  cost_usd: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  audio_chat_id: number | null;
  audio_message_id: number | null;
  download_route: string | null;
  audio_file_id: string | null;
  share_enabled: number;
  share_target: number | null;
  mode: SessionMode;
  archive_message_id: number | null;
  delivered_chat_id: number | null;
  delivered_audio_message_id: number | null;
}

/**
 * `full` — جلسهٔ کامل با سکه.
 * `free_trial` — اجرای رایگان یک‌باره: فقط رونوشت، با سقف مدت.
 * `free_transcript` — نام قدیمیِ همان حالت رایگان. دیگر تولید نمی‌شود ولی
 *   سطرهای قبلیِ پایگاه‌داده این مقدار را دارند.
 */
export type SessionMode = "free_trial" | "full" | "free_transcript";

/** جلسه‌ای که تحلیل ندارد و فقط رونوشت دارد — هر دو نامِ حالت رایگان. */
export function isTranscriptOnly(mode: SessionMode): boolean {
  return mode === "free_trial" || mode === "free_transcript";
}

export function createSession(id: string, tgId: number, courseId: number | null): void {
  db.prepare(`INSERT INTO sessions (id, tg_id, course_id, status) VALUES (?, ?, ?, 'queued')`).run(
    id, tgId, courseId,
  );
}

/**
 * جلسه‌هایی که فایلشان گرفته شده ولی منتظر شارژ مانده‌اند — تازه‌ترین اول.
 *
 * پس از تأیید شارژ صدا زده می‌شود تا به کاربر بگوییم فایلش هنوز هست، به‌جای
 * «صوتتو بفرست» که او را به فرستادن دوبارهٔ همان فایل می‌کشاند.
 */
export function awaitingCreditSessions(tgId: number): SessionRow[] {
  return db
    .prepare(
      `SELECT * FROM sessions
        WHERE tg_id = ? AND status = 'awaiting_credit' AND original_file IS NOT NULL
        ORDER BY created_at DESC LIMIT 5`,
    )
    .all(tgId) as unknown as SessionRow[];
}

/**
 * جزوهٔ هم‌کلاسی که کاربر خواست بردارد و سکه کم آورد.
 *
 * بعد از شارژ، ربات به‌جای «صوت کلاستو بفرست» همان جزوه را پیشنهاد می‌دهد؛
 * کسی که برای برداشتنِ جزوه شارژ کرده، دنبالِ آپلود نیامده. فقط آخرین خواسته
 * نگه داشته می‌شود و با یک بار پیشنهاد پاک می‌شود.
 */
export function rememberPendingJoin(tgId: number, sessionId: string): void {
  db.prepare(
    `INSERT INTO pending_joins (tg_id, session_id) VALUES (?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET session_id = excluded.session_id, created_at = datetime('now')`,
  ).run(tgId, sessionId);
}

export function takePendingJoin(tgId: number, maxAgeDays = 7): string | null {
  const row = db
    .prepare(`SELECT session_id FROM pending_joins WHERE tg_id = ? AND created_at > datetime('now', ?)`)
    .get(tgId, `-${maxAgeDays} days`) as unknown as { session_id: string } | undefined;
  db.prepare(`DELETE FROM pending_joins WHERE tg_id = ?`).run(tgId);
  return row?.session_id ?? null;
}

/**
 * شرطِ SQL برای «این جلسه هیچ سکهٔ رزروشدهٔ بازی ندارد».
 *
 * پیش‌تر ملاک «هیچ سطری در دفتر ندارد» بود. خرید گروهیِ مینی‌اپ که پر نشود
 * سکه‌هایش برمی‌گردد و جلسه به `queued` برمی‌گردد تا مالک خودش بپردازد — ولی
 * سطرهای رزرو و برگشتش در دفتر مانده. با ملاکِ قدیمی همان فایل دیگر هرگز به
 * او پیشنهاد نمی‌شد. ملاکِ درست خالصِ رزرو و برگشت است، و نبودنِ تسویه.
 */
export function unreservedSql(alias: string): string {
  return (
    `COALESCE((SELECT SUM(x.delta_toman) FROM credit_ledger x WHERE x.session_id = ${alias}.id ` +
    `AND x.reason IN ('reserve', 'refund')), 0) >= 0 ` +
    `AND NOT EXISTS (SELECT 1 FROM credit_ledger x WHERE x.session_id = ${alias}.id AND x.reason = 'commit')`
  );
}

/** تازه‌ترین آپلودِ مینی‌اپ که هنوز تأیید نشده — همان ملاکِ `GET /api/uploads/pending`. */
export function pendingWebUploadId(tgId: number): string | null {
  const row = db
    .prepare(
      `SELECT s.id AS id, s.original_file AS file FROM sessions s
        WHERE s.tg_id = ? AND s.status = 'queued' AND s.download_route = 'web'
          AND s.original_file IS NOT NULL
          AND ${unreservedSql("s")}
        ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(tgId) as unknown as { id: string; file: string } | undefined;
  return row && fs.existsSync(row.file) ? row.id : null;
}

export function getSession(id: string): SessionRow | null {
  return (db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as unknown as SessionRow | undefined) ?? null;
}

/**
 * صوتی که گزارشِ این جلسه **در چتِ یک عضو** به آن آویزان است.
 *
 * ستون‌های `delivered_*` روی خودِ جلسه فقط یک چت را نگه می‌دارند — چتِ مالک.
 * هم‌کلاسی‌ای که جلسه را گرفته، صوت را در چتِ *خودش* با شناسهٔ پیامِ دیگری
 * می‌گیرد، و وقتی بعداً دکمهٔ «کلاس دقیقه‌به‌دقیقه» را می‌زند، آن پیام باید
 * ریپلایِ همان صوت باشد وگرنه زمان‌هایش لینکِ پخش نمی‌شوند. همان پرسش، یک
 * پاسخ برای هر گیرنده — پس کنارِ عضویتش نوشته می‌شود.
 *
 * مهاجرت اینجاست و نه بالای فایل، چون جدولِ `session_members` در بلوکِ دومِ
 * طرحواره ساخته می‌شود و `ALTER` پیش از آن روی جدولِ ناموجود می‌افتاد.
 */
for (const [column, ddl] of [
  ["delivered_chat_id", "ALTER TABLE session_members ADD COLUMN delivered_chat_id INTEGER"],
  [
    "delivered_audio_message_id",
    "ALTER TABLE session_members ADD COLUMN delivered_audio_message_id INTEGER",
  ],
] as const) {
  const cols = db.prepare("PRAGMA table_info(session_members)").all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(ddl);
}

export function setMemberDelivery(
  sessionId: string,
  tgId: number,
  chatId: number,
  audioMessageId: number,
): void {
  db.prepare(
    `UPDATE session_members SET delivered_chat_id = ?, delivered_audio_message_id = ?
      WHERE session_id = ? AND tg_id = ?`,
  ).run(chatId, audioMessageId, sessionId, tgId);
}

export function memberDelivery(
  sessionId: string,
  tgId: number,
): { chatId: number | null; audioMessageId: number | null } | null {
  const row = db
    .prepare(
      `SELECT delivered_chat_id AS chatId, delivered_audio_message_id AS audioMessageId
         FROM session_members WHERE session_id = ? AND tg_id = ?`,
    )
    .get(sessionId, tgId) as unknown as { chatId: number | null; audioMessageId: number | null } | undefined;
  return row ?? null;
}

/**
 * فهرستِ «📚 جلسه‌های من» — جلسه‌هایی که فرستاده **و** جلسه‌هایی که گرفته.
 *
 * `listSessions` فقط مالکیت را می‌بیند و همان‌طور می‌ماند: `/forget` و `/cancel`
 * و حدسِ درس به آن تکیه دارند و نباید به جلسهٔ کسِ دیگری دست بزنند. ولی برای
 * *دیدن*، هم‌کلاسی‌ای که سکه داده و جلسه را گرفته بود هیچ راهی جز تایپِ
 * `/shared` نداشت؛ جزوه‌ای که بابتش پرداخته بود از منو نامرئی بود.
 *
 * `joined` یعنی از راهِ عضویت آمده، نه مالکیت. ترتیب با لحظهٔ **گرفتن** است
 * برای عضو و لحظهٔ فرستادن برای مالک — جلسه‌ای که دیروز گرفتی باید بالای
 * فهرست باشد حتی اگر هم‌کلاسی‌ات هفتهٔ پیش فرستاده باشدش. نقشِ `owner` در
 * `session_members` کنار گذاشته می‌شود تا جلسهٔ خودت دو بار نیاید.
 */
export function listHistory(
  tgId: number,
  limit = 10,
  offset = 0,
): Array<SessionRow & { joined: number }> {
  return db
    .prepare(
      `SELECT s.*, CASE WHEN s.tg_id = ? THEN 0 ELSE 1 END AS joined
         FROM sessions s
         LEFT JOIN session_members m
           ON m.session_id = s.id AND m.tg_id = ? AND m.role = 'member'
        WHERE s.tg_id = ? OR m.session_id IS NOT NULL
        ORDER BY COALESCE(m.joined_at, s.created_at) DESC
        LIMIT ? OFFSET ?`,
    )
    .all(tgId, tgId, tgId, limit, offset) as unknown as Array<SessionRow & { joined: number }>;
}

/** شمارِ همان فهرست — برای صفحه‌بندی. */
export function countHistory(tgId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM sessions s
         LEFT JOIN session_members m
           ON m.session_id = s.id AND m.tg_id = ? AND m.role = 'member'
        WHERE s.tg_id = ? OR m.session_id IS NOT NULL`,
    )
    .get(tgId, tgId) as unknown as { n: number };
  return row.n;
}

export function listSessions(tgId: number, limit = 10, offset = 0): SessionRow[] {
  return db
    .prepare(
      `SELECT * FROM sessions WHERE tg_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(tgId, limit, offset) as unknown as SessionRow[];
}

/**
 * جلسه‌هایی که منتظر تصمیمِ کاربرند — تأییدنشده یا منتظر شارژ.
 *
 * برای محدودکردنِ صف‌کردنِ بی‌پایانِ فایل به کار می‌رود: هر کدام یک سطر
 * پایگاه‌داده و چند پیام است، و آنی که به شارژ رسیده یک فایلِ دانلودشده هم
 * روی دیسک دارد.
 */
export function pendingSessions(tgId: number): SessionRow[] {
  return db
    .prepare(
      `SELECT * FROM sessions
       WHERE tg_id = ? AND status IN ('awaiting_confirm','awaiting_credit')
       ORDER BY created_at DESC`,
    )
    .all(tgId) as unknown as SessionRow[];
}

/** شمار کل جلسه‌های کاربر — برای صفحه‌بندی. */
export function countSessions(tgId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE tg_id = ?`)
    .get(tgId) as unknown as { n: number };
  return row.n;
}

type Updatable = Partial<
  Pick<
    SessionRow,
    | "status" | "title" | "session_date" | "original_file" | "original_ms" | "billed_ms"
    | "silence_ms" | "time_map_json" | "report_json" | "notes_md" | "transcript_txt"
    | "pdf_path" | "transcript_pdf" | "transcript_srt" | "cost_usd" | "error" | "finished_at" | "course_id"
    | "audio_chat_id" | "audio_message_id" | "download_route"
    | "audio_file_id" | "share_enabled" | "share_target" | "mode" | "archive_message_id"
    | "delivered_chat_id" | "delivered_audio_message_id"
  >
>;

export function updateSession(id: string, patch: Updatable): void {
  const keys = Object.keys(patch) as Array<keyof Updatable>;
  if (keys.length === 0) return;
  const sql = `UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  const values = keys.map((k) => patch[k] as string | number | null);
  db.prepare(sql).run(...values, id);
}

export function sessionReport(s: SessionRow): AnalysisReport | null {
  if (!s.report_json) return null;
  try {
    return JSON.parse(s.report_json) as AnalysisReport;
  } catch {
    return null;
  }
}

export function sessionTimeMap(s: SessionRow): TimeSegment[] {
  if (!s.time_map_json) return [];
  try {
    return JSON.parse(s.time_map_json) as TimeSegment[];
  } catch {
    return [];
  }
}

/** فایل‌های صوتی قدیمی‌تر از KEEP_AUDIO_DAYS برای پاک‌سازی */
/**
 * صوت‌هایی که وقتشان گذشته و باید از دیسک بروند.
 *
 * ⚠️ **جلسه‌های معلق هم شمرده می‌شوند.** پیش‌تر فقط `done`/`error`/`cancelled`
 * جارو می‌شدند، پس جلسه‌ای که منتظر شارژ یا منتظر تأییدِ کاربر مانده بود
 * صوتش را **برای همیشه** روی دیسک نگه می‌داشت — هیچ مسیری هرگز برنمی‌داشتش.
 * با آمدنِ قدمِ تأیید، تعداد این جلسه‌ها بیشتر هم می‌شود.
 *
 * همان پنجرهٔ نگهداری برایشان کافی است: تا آن روز کاربر فرصت شارژ و تأیید
 * داشته و پس از آن، مثل هر جلسهٔ دیگری، فایل خام دلیلی برای ماندن ندارد.
 */
export function expiredAudio(days: number): Array<{ id: string; original_file: string }> {
  return db
    .prepare(
      `SELECT id, original_file FROM sessions
       WHERE original_file IS NOT NULL
         AND status IN ('done','error','cancelled','awaiting_credit','awaiting_confirm')
         AND created_at < datetime('now', ?)`,
    )
    .all(`-${days} days`) as unknown as Array<{ id: string; original_file: string }>;
}

/** حذف کامل یک جلسه و عضویت‌هایش. برگشت‌ناپذیر. */
export function purgeSession(id: string): void {
  db.prepare(`DELETE FROM session_members WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function clearAudioPath(id: string): void {
  db.prepare(`UPDATE sessions SET original_file = NULL WHERE id = ?`).run(id);
}

// ─── شارژ (کارت‌به‌کارت) ─────────────────────────────────────────────────────

/**
 * دو مسیر، یک جدول:
 *
 *   کارت‌به‌کارت:  awaiting_receipt → pending → approved | rejected
 *   درگاه:         awaiting_payment → approved | rejected
 */
export type TopupStatus = "awaiting_receipt" | "awaiting_payment" | "pending" | "approved" | "rejected";

export interface TopupRow {
  id: string;
  tg_id: number;
  package_id: string;
  credit_toman: number;
  price_toman: number;
  status: TopupStatus;
  receipt_file_id: string | null;
  decided_by: number | null;
  created_at: string;
  decided_at: string | null;
  track_id: string | null;
  ref_number: string | null;
}

export function createTopup(
  id: string,
  tgId: number,
  packageId: string,
  creditToman: number,
  priceToman: number,
  status: "awaiting_receipt" | "awaiting_payment" = "awaiting_receipt",
): TopupRow {
  db.prepare(
    `INSERT INTO topups (id, tg_id, package_id, credit_toman, price_toman, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, tgId, packageId, creditToman, priceToman, status);
  return getTopup(id)!;
}

export function getTopup(id: string): TopupRow | null {
  return (db.prepare(`SELECT * FROM topups WHERE id = ?`).get(id) as unknown as TopupRow | undefined) ?? null;
}

export function getTopupByTrackId(trackId: string): TopupRow | null {
  return (
    (db.prepare(`SELECT * FROM topups WHERE track_id = ?`).get(trackId) as unknown as TopupRow | undefined) ??
    null
  );
}

export function setTopupTrackId(id: string, trackId: string): void {
  db.prepare(`UPDATE topups SET track_id = ? WHERE id = ?`).run(trackId, id);
}

/**
 * سفارشِ درگاهی را «پرداخت‌شده» می‌کند — **یک بار**.
 *
 * دو راه به تأیید می‌رسند و می‌توانند همزمان باشند: بازگشت از درگاه و دکمهٔ
 * «بررسی پرداخت» در ربات. هر دو `verify` می‌زنند و هر دو «معتبر» می‌گیرند
 * (بار دوم با کد ۲۰۱). اگر دروازه در دست‌کد بود، هر دو سکه واریز می‌کردند.
 *
 * پس دروازه همین `UPDATE … WHERE status = 'awaiting_payment'` است: SQLite
 * نوشتن را سریال می‌کند و فقط یکی `changes = 1` می‌گیرد. صداکننده **فقط**
 * وقتی `true` گرفت سکه واریز می‌کند.
 */
export function claimTopupPaid(id: string, refNumber: string | null): boolean {
  const r = db
    .prepare(
      `UPDATE topups SET status = 'approved', ref_number = COALESCE(?, ref_number),
         decided_at = datetime('now')
       WHERE id = ? AND status = 'awaiting_payment'`,
    )
    .run(refNumber, id);
  return Number(r.changes) === 1;
}

/**
 * آخرین سفارشی که منتظر رسید است.
 *
 * کاربر رسید را به‌صورت یک عکسِ ساده می‌فرستد، بدون اینکه چیزی به آن پیوست
 * باشد که بگوید مال کدام سفارش است. پس اتصال از روی «آخرین سفارشِ باز» انجام
 * می‌شود — همان مدلی که کاربر هم در ذهن دارد.
 */
export function openTopup(tgId: number): TopupRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM topups WHERE tg_id = ? AND status = 'awaiting_receipt'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tgId) as unknown as TopupRow | undefined) ?? null
  );
}

export function setTopupStatus(
  id: string,
  status: TopupStatus,
  patch: { receiptFileId?: string; decidedBy?: number } = {},
): void {
  db.prepare(
    `UPDATE topups SET status = ?,
       receipt_file_id = COALESCE(?, receipt_file_id),
       decided_by = COALESCE(?, decided_by),
       decided_at = CASE WHEN ? IN ('approved','rejected') THEN datetime('now') ELSE decided_at END
     WHERE id = ?`,
  ).run(status, patch.receiptFileId ?? null, patch.decidedBy ?? null, status, id);
}

export function listTopups(tgId: number, limit = 10): TopupRow[] {
  return db
    .prepare(`SELECT * FROM topups WHERE tg_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(tgId, limit) as unknown as TopupRow[];
}

export function pendingTopups(limit = 20): TopupRow[] {
  return db
    .prepare(`SELECT * FROM topups WHERE status = 'pending' ORDER BY created_at LIMIT ?`)
    .all(limit) as unknown as TopupRow[];
}

// ─── کدهای هدیه ──────────────────────────────────────────────────────────────

export interface GiftRow {
  code: string;
  toman: number;
  max_uses: number;
  note: string | null;
  created_by: number;
  created_at: string;
  expires_at: string | null;
  revoked: number;
}

export function createGift(opt: {
  code: string;
  toman: number;
  maxUses: number;
  note?: string | null;
  createdBy: number;
  expiresAt?: string | null;
}): GiftRow {
  db.prepare(
    `INSERT INTO gifts (code, toman, max_uses, note, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opt.code, opt.toman, opt.maxUses, opt.note ?? null, opt.createdBy, opt.expiresAt ?? null);
  return getGift(opt.code)!;
}

export function getGift(code: string): GiftRow | null {
  return (
    (db.prepare(`SELECT * FROM gifts WHERE code = ?`).get(code) as unknown as GiftRow | undefined) ??
    null
  );
}

export function giftUses(code: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM gift_claims WHERE code = ?`)
    .get(code) as unknown as { n: number };
  return row.n;
}

export function giftClaimedBy(code: string, tgId: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM gift_claims WHERE code = ? AND tg_id = ?`).get(code, tgId));
}

export function revokeGift(code: string): boolean {
  const g = getGift(code);
  if (!g || g.revoked) return false;
  db.prepare(`UPDATE gifts SET revoked = 1 WHERE code = ?`).run(code);
  return true;
}

/**
 * ثبت برداشت — و تنها دروازهٔ واقعیِ «هر کد، هر نفر، یک بار».
 *
 * بررسی‌کردن و بعد نوشتن در دو گام، پنجره‌ای باز می‌گذارد که در آن دو کلیکِ
 * همزمان روی یک لینکِ یک‌بارمصرف هر دو رد می‌شوند. پس شمردن و درج در **یک**
 * تراکنش انجام می‌شود و کلید مرکبِ جدول، تکرار را غیرممکن می‌کند نه محتمل.
 *
 * `false` یعنی این کد برای این کاربر مصرف نشد؛ صدازننده نباید سکه واریز کند.
 */
export function claimGift(code: string, tgId: number, toman: number): boolean {
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const g = db.prepare(`SELECT * FROM gifts WHERE code = ?`).get(code) as unknown as
      | GiftRow
      | undefined;
    if (!g || g.revoked) {
      db.prepare("ROLLBACK").run();
      return false;
    }
    if (g.expires_at && new Date(g.expires_at).getTime() < Date.now()) {
      db.prepare("ROLLBACK").run();
      return false;
    }
    const used = (
      db.prepare(`SELECT COUNT(*) AS n FROM gift_claims WHERE code = ?`).get(code) as unknown as {
        n: number;
      }
    ).n;
    if (used >= g.max_uses) {
      db.prepare("ROLLBACK").run();
      return false;
    }
    db.prepare(`INSERT INTO gift_claims (code, tg_id, toman) VALUES (?, ?, ?)`).run(code, tgId, toman);
    db.prepare("COMMIT").run();
    return true;
  } catch {
    // درجِ تکراری (همین کاربر قبلاً برداشته) هم دقیقاً همین‌جا می‌افتد.
    db.prepare("ROLLBACK").run();
    return false;
  }
}

/** کدهای ساخته‌شده، تازه‌ترین اول — برای فهرست ادمین. */
export function listGifts(limit = 20): Array<GiftRow & { used: number }> {
  return db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM gift_claims c WHERE c.code = g.code) AS used
       FROM gifts g ORDER BY g.created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<GiftRow & { used: number }>;
}

