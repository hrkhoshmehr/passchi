import fs from "node:fs/promises";
import path from "node:path";
import {
  FetchHttpClient,
  SONIOX_API_BASE_URL,
  SonioxNodeClient,
  segmentTranscript,
  type TranscriptSegment,
  type TranscriptToken,
  type TranscriptionContext,
  type TranscriptionStatus,
} from "@soniox/node";
import { config, requireKey } from "../config.js";
import { logger } from "../util/logger.js";

export type { TranscriptSegment, TranscriptToken, TranscriptionContext };

/**
 * تایم‌اوت پیش‌فرض SDK سی ثانیه است — برای یک درخواست REST معمولی منطقی،
 * ولی آپلود یک فایل صوتی چند ده مگابایتی روی اتصال کند همان‌جا می‌شکند.
 * اولین اجرای واقعی دقیقاً همین‌جا خورد: خطای تایم‌اوت روی POST /v1/files.
 */
const HTTP_TIMEOUT_MS = 45 * 60_000;

let _client: SonioxNodeClient | null = null;
function client(): SonioxNodeClient {
  const apiKey = requireKey("SONIOX_API_KEY");
  _client ??= new SonioxNodeClient({
    api_key: apiKey,
    // کلاینت سفارشی هیچ‌چیز را از SonioxNodeClient به ارث نمی‌برد — نه آدرس
    // پایه و نه هدر احراز هویت. هر دو باید صریح داده شوند، وگرنه یکی
    // ERR_INVALID_URL می‌دهد و دیگری ۴۰۱.
    http_client: new FetchHttpClient({
      base_url: SONIOX_API_BASE_URL,
      default_headers: { Authorization: `Bearer ${apiKey}` },
      default_timeout_ms: HTTP_TIMEOUT_MS,
    }),
  });
  return _client;
}

export interface TranscribeParams {
  /** فایل پیش‌پردازش‌شده‌ای که آپلود می‌شود */
  filePath: string;
  /**
   * زبان‌های محتمل. برای کلاس فارسی همیشه fa و en را با هم می‌دهیم:
   * سخنرانی فنی فارسی مدام به انگلیسی سوییچ می‌کند و این بزرگ‌ترین منبع خطاست.
   */
  languageHints?: string[];
  /**
   * واژگان و بافت درس. مهم‌ترین اهرم دقت است — نام استاد، عنوان درس،
   * و اصطلاحات تخصصی که در جلسات قبل استخراج شده‌اند.
   */
  context?: TranscriptionContext;
  clientReferenceId?: string;
  onStatus?: (status: TranscriptionStatus) => void;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  tokens: TranscriptToken[];
  text: string;
  audioDurationMs: number;
  /** زبان‌هایی که در فایل تشخیص داده شد */
  languages: string[];
  /** پاسخ خام — برای ذخیره روی دیسک تا لازم نباشد دوباره پول بدهیم */
  raw: { transcription: unknown; transcript: unknown };
}

export async function transcribe(p: TranscribeParams): Promise<TranscribeResult> {
  const file = await fs.readFile(p.filePath);

  const transcription = await client().stt.transcribe({
    model: config.SONIOX_MODEL,
    file,
    filename: path.basename(p.filePath),
    language_hints: p.languageHints ?? ["fa", "en"],
    enable_speaker_diarization: true,
    enable_language_identification: true,
    ...(p.context ? { context: p.context } : {}),
    ...(p.clientReferenceId ? { client_reference_id: p.clientReferenceId } : {}),
    timeout_ms: HTTP_TIMEOUT_MS,
    wait: true,
    fetch_transcript: true,
    // نه فایل و نه رکورد رونویسی روی سرور Soniox نمی‌ماند
    cleanup: ["file", "transcription"],
    wait_options: {
      interval_ms: 3_000,
      timeout_ms: 90 * 60_000,
      on_status_change: (status) => p.onStatus?.(status),
      ...(p.signal ? { signal: p.signal } : {}),
    },
    ...(p.signal ? { signal: p.signal } : {}),
  });

  if (transcription.status === "error") {
    throw new Error(
      `رونویسی ناموفق بود: ${transcription.error_message ?? transcription.error_type ?? "نامشخص"}`,
    );
  }

  const transcript = transcription.transcript;
  if (!transcript) throw new Error("رونویسی کامل شد اما متنی برنگشت.");

  const tokens = transcript.tokens ?? [];
  const languages = [...new Set(tokens.map((t) => t.language).filter((l): l is string => !!l))];

  logger.info(
    { tokens: tokens.length, durationMs: transcription.audio_duration_ms, languages },
    "soniox transcription done",
  );

  return {
    tokens,
    text: transcript.text ?? "",
    audioDurationMs: transcription.audio_duration_ms ?? 0,
    languages,
    raw: { transcription: transcription.toJSON(), transcript },
  };
}

/** گروه‌بندی توکن‌ها بر اساس گوینده (از ابزار خود SDK) */
export function segmentsBySpeaker(tokens: TranscriptToken[]): TranscriptSegment[] {
  return segmentTranscript(tokens, { group_by: ["speaker"] });
}
