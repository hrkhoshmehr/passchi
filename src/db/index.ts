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
  -- اعتبار بر حسب ثانیهٔ صوت؛ واحد طبیعی چون هزینه با مدت می‌آید نه با حجم
  credit_sec   INTEGER NOT NULL DEFAULT 0,
  total_used_sec INTEGER NOT NULL DEFAULT 0
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
] as const) {
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(ddl);
}

db.exec(`
CREATE TABLE IF NOT EXISTS credit_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         INTEGER NOT NULL,
  delta_sec     INTEGER NOT NULL,
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
  paid_sec   INTEGER NOT NULL DEFAULT 0,
  role       TEXT NOT NULL,
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, tg_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON session_members(tg_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS topups (
  id            TEXT PRIMARY KEY,
  tg_id         INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  package_id    TEXT NOT NULL,
  coins         INTEGER NOT NULL,
  price_toman   INTEGER NOT NULL,
  status        TEXT NOT NULL,            -- awaiting_receipt|pending|approved|rejected
  receipt_file_id TEXT,
  decided_by    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_topups_user ON topups(tg_id, created_at DESC);

-- کد هدیه: ادمین سکه می‌سازد و لینکش را می‌دهد؛ گیرنده با زدن روی لینک
-- سکه‌ها را برمی‌دارد.
--
-- ستون max_uses تفاوت «هدیه به یک نفر» و «کد کلاسی» را می‌سازد و همان یک ستون
-- هر دو را پوشش می‌دهد: هدیهٔ شخصی یعنی max_uses = 1.
CREATE TABLE IF NOT EXISTS gifts (
  code        TEXT PRIMARY KEY,
  coins       INTEGER NOT NULL,
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
  coins      INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, tg_id)
);
CREATE INDEX IF NOT EXISTS idx_claims_user ON gift_claims(tg_id, claimed_at DESC);
`);

// ─── users ───────────────────────────────────────────────────────────────────

export interface UserRow {
  tg_id: number;
  name: string | null;
  username: string | null;
  credit_sec: number;
  total_used_sec: number;
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

export function addCredit(tgId: number, seconds: number): void {
  db.prepare(`UPDATE users SET credit_sec = credit_sec + ? WHERE tg_id = ?`).run(seconds, tgId);
}

export function consumeCredit(tgId: number, seconds: number): void {
  db.prepare(
    `UPDATE users SET credit_sec = MAX(0, credit_sec - ?), total_used_sec = total_used_sec + ? WHERE tg_id = ?`,
  ).run(seconds, seconds, tgId);
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
 */
export type SessionStatus =
  | "queued" | "awaiting_credit" | "awaiting_confirm" | "preprocess" | "stt" | "analyze" | "pdf"
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

export function getSession(id: string): SessionRow | null {
  return (db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as unknown as SessionRow | undefined) ?? null;
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

export type TopupStatus = "awaiting_receipt" | "pending" | "approved" | "rejected";

export interface TopupRow {
  id: string;
  tg_id: number;
  package_id: string;
  coins: number;
  price_toman: number;
  status: TopupStatus;
  receipt_file_id: string | null;
  decided_by: number | null;
  created_at: string;
  decided_at: string | null;
}

export function createTopup(
  id: string,
  tgId: number,
  packageId: string,
  coins: number,
  priceToman: number,
): TopupRow {
  db.prepare(
    `INSERT INTO topups (id, tg_id, package_id, coins, price_toman, status)
     VALUES (?, ?, ?, ?, ?, 'awaiting_receipt')`,
  ).run(id, tgId, packageId, coins, priceToman);
  return getTopup(id)!;
}

export function getTopup(id: string): TopupRow | null {
  return (db.prepare(`SELECT * FROM topups WHERE id = ?`).get(id) as unknown as TopupRow | undefined) ?? null;
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
  coins: number;
  max_uses: number;
  note: string | null;
  created_by: number;
  created_at: string;
  expires_at: string | null;
  revoked: number;
}

export function createGift(opt: {
  code: string;
  coins: number;
  maxUses: number;
  note?: string | null;
  createdBy: number;
  expiresAt?: string | null;
}): GiftRow {
  db.prepare(
    `INSERT INTO gifts (code, coins, max_uses, note, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opt.code, opt.coins, opt.maxUses, opt.note ?? null, opt.createdBy, opt.expiresAt ?? null);
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
export function claimGift(code: string, tgId: number, coins: number): boolean {
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
    db.prepare(`INSERT INTO gift_claims (code, tg_id, coins) VALUES (?, ?, ?)`).run(code, tgId, coins);
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
