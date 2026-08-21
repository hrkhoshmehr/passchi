/**
 * کش رونویسی، کلیدخورده روی محتوای فایل.
 *
 * دو کاربرد دارد و هر دو واقعی‌اند:
 *
 * • **توسعه.** تست کردن ربات با یک صوت نمونه نباید هر بار پول بدهد. با کش،
 *   بار اول هزینه دارد و بعد از آن رایگان است.
 *
 * • **تولید.** اگر دو دانشجو عین یک فایل را بفرستند — که دقیقاً همان چیزی است
 *   که در گروه درس اتفاق می‌افتد — دو بار هزینه نمی‌دهیم. کلید، هش محتواست
 *   نه نام فایل، پس تغییر نام یا فوروارد هم همان کش را می‌خورد.
 *
 * کش روی فایل *اصلی* کلید می‌خورد نه فایل پیش‌پردازش‌شده: پیش‌پردازش خودش
 * ممکن است بین نسخه‌ها عوض شود، ولی چیزی که کاربر فرستاده همان است.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { TranscriptToken } from "@soniox/node";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

export interface CachedTranscript {
  tokens: TranscriptToken[];
  text: string;
  audioDurationMs: number;
  languages: string[];
}

const cacheDir = path.join(config.dataDir, "cache");

/**
 * هش کل محتوای فایل.
 *
 * وسوسه‌کننده است که فقط سر و ته فایل خوانده شود، ولی آن‌وقت هش این ماژول با
 * هشی که اسکریپت‌های کش‌ساز می‌نویسند یکی نمی‌شود و کش هیچ‌وقت نمی‌خورد —
 * دقیقاً همان اشتباهی که یک بار مرتکبش شدیم. یک هش، یک تعریف.
 * روی فایل ۱۵ مگابایتی حدود ۵۰ میلی‌ثانیه طول می‌کشد.
 */
export async function fingerprint(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

async function findFile(digest: string): Promise<string | null> {
  const names = await fs.readdir(cacheDir).catch(() => []);
  const match = names.find((n) => n.includes(`.${digest}.`) && n.endsWith(".soniox.json"));
  return match ? path.join(cacheDir, match) : null;
}

export async function lookup(filePath: string): Promise<CachedTranscript | null> {
  if (!config.STT_CACHE) return null;
  const digest = await fingerprint(filePath).catch(() => null);
  if (!digest) return null;

  const file = await findFile(digest);
  if (!file) return null;

  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
      transcript?: { tokens?: TranscriptToken[]; text?: string };
      transcription?: { audio_duration_ms?: number };
    };
    const tokens = raw.transcript?.tokens ?? [];
    if (tokens.length === 0) return null;
    const languages = [...new Set(tokens.map((t) => t.language).filter((l): l is string => !!l))];
    logger.info({ file: path.basename(file), tokens: tokens.length }, "رونویسی از کش خوانده شد");
    return {
      tokens,
      text: raw.transcript?.text ?? "",
      audioDurationMs: raw.transcription?.audio_duration_ms ?? 0,
      languages,
    };
  } catch (e) {
    logger.warn({ file, err: String(e) }, "cache read failed");
    return null;
  }
}

export async function store(
  filePath: string,
  raw: { transcription: unknown; transcript: unknown },
  preprocess: unknown,
): Promise<void> {
  if (!config.STT_CACHE) return;
  const digest = await fingerprint(filePath).catch(() => null);
  if (!digest) return;
  const base = `${path.basename(filePath, path.extname(filePath))}.${digest}`;
  await fs.mkdir(cacheDir, { recursive: true });
  await fs
    .writeFile(
      path.join(cacheDir, `${base}.soniox.json`),
      JSON.stringify({ savedAt: new Date().toISOString(), preprocess, ...raw }, null, 2),
      "utf8",
    )
    .catch((e: unknown) => logger.warn({ err: String(e) }, "cache write failed"));
}
