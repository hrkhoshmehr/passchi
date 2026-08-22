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
  // شناسهٔ فایل در تلگرام: ارسال دوباره به کسی که به جلسه می‌پیوندد رایگان و
  // فوری است، و بدون آن لینک‌های زمانی برای او کار نمی‌کنند.
  ["audio_file_id", "ALTER TABLE sessions ADD COLUMN audio_file_id TEXT"],
  ["share_enabled", "ALTER TABLE sessions ADD COLUMN share_enabled INTEGER NOT NULL DEFAULT 0"],
  // free_transcript | full — جلسهٔ رایگان فقط رونوشت دارد و تحلیلی ندارد،
  // پس تاریخچه و دکمه‌هایش باید فرق کنند.
  ["mode", "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'"],
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

export type SessionStatus =
  | "queued" | "preprocess" | "stt" | "analyze" | "pdf" | "done" | "error" | "cancelled";

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
  cost_usd: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  audio_chat_id: number | null;
  audio_message_id: number | null;
  download_route: string | null;
  audio_file_id: string | null;
  share_enabled: number;
  mode: SessionMode;
}

export type SessionMode = "free_transcript" | "full";

export function createSession(id: string, tgId: number, courseId: number | null): void {
  db.prepare(`INSERT INTO sessions (id, tg_id, course_id, status) VALUES (?, ?, ?, 'queued')`).run(
    id, tgId, courseId,
  );
}

export function getSession(id: string): SessionRow | null {
  return (db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as unknown as SessionRow | undefined) ?? null;
}

export function listSessions(tgId: number, limit = 10): SessionRow[] {
  return db
    .prepare(`SELECT * FROM sessions WHERE tg_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(tgId, limit) as unknown as SessionRow[];
}

type Updatable = Partial<
  Pick<
    SessionRow,
    | "status" | "title" | "session_date" | "original_file" | "original_ms" | "billed_ms"
    | "silence_ms" | "time_map_json" | "report_json" | "notes_md" | "transcript_txt"
    | "pdf_path" | "cost_usd" | "error" | "finished_at" | "course_id"
    | "audio_chat_id" | "audio_message_id" | "download_route"
    | "audio_file_id" | "share_enabled" | "mode"
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
export function expiredAudio(days: number): Array<{ id: string; original_file: string }> {
  return db
    .prepare(
      `SELECT id, original_file FROM sessions
       WHERE original_file IS NOT NULL
         AND status IN ('done','error','cancelled')
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
