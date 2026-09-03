import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import {
  analyze,
  buildKeepRegions,
  detectEdgeSilence,
  encode,
  measureSampled,
  probe,
  TimeMap,
  type AudioInfo,
  type Interval,
  type LoudnormMeasure,
  type SampledMeasurement,
} from "./ffmpeg.js";

/** سقف تعداد برش‌ها — بالاتر از این، رشتهٔ فیلتر ffmpeg غیرعملی می‌شود. */
const MAX_CUTS = 300;

/** زیر این مقدار، برشِ لبه‌ها ارزش پیچیدگی نگاشت زمان را ندارد. */
const MIN_EDGE_TRIM_SEC = 20;

/** فرمت‌هایی که Soniox مستقیم می‌پذیرد. */
const SONIOX_FORMATS = new Set([
  "aac", "amr", "amr_nb", "amr_wb", "flac", "mp3", "opus", "vorbis", "wav", "pcm_s16le", "aac_latm",
]);

/** فشرده‌سازی‌های بدون اتلاف یا بدون فشرده‌سازی — همیشه ارزش ترنسکد دارند. */
const UNCOMPRESSED = new Set(["flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_u8", "alac"]);

/**
 * آیا اصلاً ارزش دارد این فایل را دوباره رمزگذاری کنیم؟
 *
 * برای یک mp3 مونوی ۴۰ کیلوبیتی ۵۰ دقیقه‌ای، ترنسکد حدود ۹۰ ثانیه پردازنده
 * می‌گیرد تا ۱۸٪ حجم کم کند — و یک نسل افت کیفیت اضافه می‌کند. Soniox خودش
 * mp3 را می‌پذیرد و هزینه‌اش بر اساس مدت است نه حجم، پس این معامله ضرر است.
 *
 * ترنسکد وقتی می‌ارزد که منبع واقعاً بزرگ باشد: wav، flac، یا استریوی
 * پرببیت‌ریت. آن‌جا فشرده‌سازی ۱۰ تا ۴۰ برابری است، نه ۱٫۲ برابری.
 */
function shouldTranscode(info: AudioInfo): { transcode: boolean; reason: string } {
  /**
   * ویدیو همیشه ترنسکد می‌شود — پیش از هر بررسی دیگری.
   *
   * `probe` با `-select_streams a:0` صدا زده می‌شود، پس `codec` صوتِ **داخل**
   * ظرف است نه خود ظرف. یک mp4 کلاس آنلاین با صدای aac از بررسی زیر سربلند
   * بیرون می‌آمد («aac را Soniox می‌پذیرد») و کل فایل با جریان ویدیو آپلود
   * می‌شد — صدها مگابایت تصویر که هیچ‌کس نمی‌خواهد، روی اینترنتی که همین
   * حالا هم گلوگاه است.
   *
   * حالا که کلاس آنلاین لینک ضبط می‌فرستد، این مسیر مسیرِ رایج است نه حاشیه.
   */
  if (info.hasVideo) {
    return { transcode: true, reason: "منبع ویدیوست؛ فقط جریان صدا برداشته می‌شود" };
  }
  if (!SONIOX_FORMATS.has(info.codec)) {
    return { transcode: true, reason: `فرمت ${info.codec} را Soniox مستقیم نمی‌پذیرد` };
  }
  if (UNCOMPRESSED.has(info.codec)) {
    return { transcode: true, reason: "منبع بدون اتلاف است؛ فشرده‌سازی چند ده برابر حجم را کم می‌کند" };
  }
  const kbps = info.bitRate > 0 ? info.bitRate / 1000 : Infinity;
  if (kbps > 64) {
    return { transcode: true, reason: `بیت‌ریت منبع ${Math.round(kbps)} کیلوبیت است` };
  }
  if (info.channels > 1 && kbps > 48) {
    return { transcode: true, reason: "منبع استریو با بیت‌ریت بالاست؛ مونوکردن نصفش می‌کند" };
  }
  if (info.sampleRate > 0 && info.sampleRate < 8000) {
    return { transcode: true, reason: "نرخ نمونه‌برداری منبع خیلی پایین است" };
  }
  return {
    transcode: false,
    reason: `منبع از قبل ${Math.round(kbps)} کیلوبیت ${info.channels === 1 ? "مونو" : "استریو"} است — رمزگذاری دوباره فقط یک نسل افت کیفیت اضافه می‌کند`,
  };
}

export type QualityLevel = "good" | "fair" | "poor";

export interface QualityReport {
  level: QualityLevel;
  /**
   * گسترهٔ بلندی طبق EBU R128. این SNR **نیست** — فقط می‌گوید بخش‌های آرام و
   * بلندِ گفتار چقدر فاصله دارند. کیفیت رونویسی از این قابل پیش‌بینی نیست.
   */
  loudnessRangeDb: number | null;
  /** بلندی گفتار، گیت‌شده طبق EBU R128 */
  speechLufs: number | null;
  /** اوج واقعی؛ بالای صفر یعنی منبع از قبل بریده شده */
  truePeakDb: number | null;
  clipping: boolean;
  tooQuiet: boolean;
  warnings: string[];
  notes: string[];
}

export interface PreprocessResult {
  processedFile: string;
  originalFile: string;
  source: AudioInfo;
  timeMap: TimeMap;
  originalDurationMs: number;
  /** مدتی که واقعاً به Soniox می‌رود (مبنای هزینه) */
  billedDurationMs: number;
  savedMs: number;
  outSizeBytes: number;
  quality: QualityReport;
  steps: string[];
  /** میلی‌ثانیهٔ صرف‌شده در ffmpeg — برای اینکه بدانیم پیش‌پردازش خودش چقدر می‌ارزد */
  elapsedMs: number;
  /** اگر false باشد، فایل اصلی دست‌نخورده به Soniox می‌رود */
  transcoded: boolean;
}

function assessQuality(m: SampledMeasurement, info: AudioInfo): QualityReport {
  const warnings: string[] = [];
  const notes: string[] = [];

  // بلندی گفتار از input_i گرفته می‌شود نه mean_volume: دومی سکوت‌ها را هم در
  // میانگین می‌آورد. input_i گیت‌شده است (EBU R128) و فقط گفتار را می‌سنجد.
  const speechLufs = m.loudnorm ? Number(m.loudnorm.input_i) : m.meanVolumeDb;
  const truePeakDb = m.loudnorm ? Number(m.loudnorm.input_tp) : m.maxVolumeDb;

  // گسترهٔ بلندی (LRA) — فاصلهٔ بخش‌های آرام تا بلندِ *گفتار*. این نسبت سیگنال
  // به نویز نیست و قبلاً اشتباهاً به‌جای آن استفاده می‌شد. اندازه‌گیری روی صوت
  // واقعی نشان داد چقدر گمراه‌کننده است: LRA برابر ۷٫۴ بود و هشدار «کیفیت
  // پایین» داد، ولی همان فایل با میانگین اطمینان ۰٫۹۸۵ رونویسی شد.
  // از هیچ اندازه‌گیری صوتیِ پیش از رونویسی نمی‌شود کیفیت متن را حدس زد؛
  // معیار واقعی، اطمینان خود مدل است که پس از رونویسی می‌آید.
  const loudnessRangeDb = m.loudnorm ? Number(m.loudnorm.input_lra) : null;

  const clipping = truePeakDb !== null && Number.isFinite(truePeakDb) && truePeakDb > -0.3;
  const tooQuiet = speechLufs !== null && Number.isFinite(speechLufs) && speechLufs < -34;

  if (clipping)
    warnings.push("سیگنال در منبع بریده (clipping) شده — بلندترین قسمت‌ها اعوجاج دارند.");
  if (tooQuiet)
    warnings.push("سطح گفتار خیلی پایین است — گوشی احتمالاً داخل کیف یا دور از استاد بوده.");
  if (info.sampleRate > 0 && info.sampleRate < 12000)
    warnings.push("نرخ نمونه‌برداری منبع پایین است؛ دقت تشخیص کلمات فنی کمتر خواهد بود.");
  if (info.bitRate > 0 && info.bitRate < 16000)
    warnings.push("بیت‌ریت منبع خیلی پایین است؛ کیفیت متن استخراجی محدود می‌شود.");

  if (m.sampledSilenceRatio > 0.4)
    notes.push("بخش زیادی از نمونه‌ها سکوت بود — شاید ضبط جای اشتباهی روشن مانده.");
  if (loudnessRangeDb !== null && loudnessRangeDb > 14)
    notes.push("اختلاف بلندی بخش‌های مختلف زیاد است — احتمالاً میکروفون جابه‌جا شده.");

  // فقط چیزهایی که واقعاً اندازه گرفته‌ایم سطح را تعیین می‌کنند
  const level: QualityLevel = clipping && tooQuiet ? "poor" : warnings.length > 0 ? "fair" : "good";

  return { level, loudnessRangeDb, speechLufs, truePeakDb, clipping, tooQuiet, warnings, notes };
}

/**
 * خط لولهٔ پیش‌پردازش.
 *
 * این طراحی نتیجهٔ اندازه‌گیری روی صوت کلاس واقعی است، نه فرض:
 *
 * • **حذف سکوت هزینه را کم نمی‌کند.** روی یک ضبط ۵۰ دقیقه‌ای واقعی، آستانهٔ
 *   ۳۵- دسی‌بل فقط ۰٫۵٪ سکوت پیدا کرد و حتی آستانهٔ تهاجمی ۱۸- دسی‌بل ۳٫۴٪.
 *   بلندترین سکوت کل فایل ۳٫۱ ثانیه بود. کلاس درس نویز زمینهٔ پیوسته دارد و
 *   هیچ‌وقت واقعاً ساکت نمی‌شود. تنها حالتی که ارزش دارد، سکوت ابتدا و
 *   انتهای فایل است (ضبط زودتر روشن یا دیرتر خاموش شده) و همان هم فقط دو سر
 *   فایل اسکن می‌شود.
 *
 * • **اسکن کامل فایل نمی‌ارزد.** یک پاس تحلیل روی ۵۰ دقیقه صوت حدود یک دقیقه
 *   پردازنده می‌برد تا چیزی پیدا کند که ۰٫۰۴ سنت صرفه دارد. سطوح سیگنال از
 *   سه پنجرهٔ یک‌دقیقه‌ای نمونه‌برداری می‌شوند.
 *
 * • **نویزگیری طیفی انجام نمی‌شود.** مدل‌های امروزی ASR روی صوت نویزی آموزش
 *   دیده‌اند؛ نویزگیری اعوجاجی می‌سازد که خطا را بالا می‌برد.
 *
 * پس کاری که واقعاً اینجا انجام می‌شود: مونو ۱۶ کیلوهرتز کردن، فیلتر پایین‌گذر،
 * جلوگیری از بریدگی، و فشرده‌سازی — که هیچ‌کدام هزینهٔ Soniox را کم نمی‌کنند
 * ولی فایل را از سقف تلگرام رد می‌کنند و آپلود را سریع.
 */
export async function preprocess(inputFile: string, jobId: string): Promise<PreprocessResult> {
  const t0 = Date.now();
  const steps: string[] = [];
  const source = await probe(inputFile);

  if (source.durationMs <= 0) throw new Error("مدت فایل صوتی قابل تشخیص نیست.");
  if (source.durationMs > config.MAX_AUDIO_MINUTES * 60_000)
    throw new Error(`فایل طولانی‌تر از سقف مجاز (${config.MAX_AUDIO_MINUTES} دقیقه) است.`);

  const highpassHz = 80;
  const analyzeOpts = {
    highpassHz,
    silenceThresholdDb: config.SILENCE_THRESHOLD_DB,
    silenceMinDurationSec: config.SILENCE_MIN_DURATION,
  };

  // ── سنجش کیفیت، نمونه‌ای ───────────────────────────────────────────────
  const measured = await measureSampled(inputFile, source.durationMs, analyzeOpts);
  const quality = assessQuality(measured, source);
  steps.push(`سنجش سطح سیگنال روی ${measured.windows} پنجرهٔ نمونه`);

  // ── سکوت ───────────────────────────────────────────────────────────────
  let keepRegions: Interval[] | null = null;

  if (config.SILENCE_TRIM === "full") {
    // اسکن کامل — گران است و فقط برای ضبط‌هایی می‌ارزد که واقعاً وقفهٔ طولانی دارند
    const a = await analyze(inputFile, source.durationMs, analyzeOpts);
    const ratio = (a.totalSilenceSec * 1000) / source.durationMs;
    if (ratio * 100 >= config.SILENCE_MIN_GAIN_PCT) {
      keepRegions = buildKeepRegions(
        source.durationMs / 1000,
        a.silences,
        config.SILENCE_PAD_MS / 1000,
        MAX_CUTS,
      );
      steps.push(`اسکن کامل: ${Math.round(ratio * 100)}٪ سکوت حذف شد`);
    } else {
      steps.push(`اسکن کامل: فقط ${Math.round(ratio * 100)}٪ سکوت — برشی انجام نشد`);
    }
  } else if (config.SILENCE_TRIM === "edges") {
    const edge = await detectEdgeSilence(inputFile, source.durationMs, analyzeOpts);
    const pad = config.SILENCE_PAD_MS / 1000;
    const start = edge.leadingSec > MIN_EDGE_TRIM_SEC ? Math.max(0, edge.leadingSec - pad) : 0;
    const endCut =
      edge.trailingSec > MIN_EDGE_TRIM_SEC ? Math.max(0, edge.trailingSec - pad) : 0;
    const end = source.durationMs / 1000 - endCut;
    if (start > 0 || endCut > 0) {
      keepRegions = [{ startSec: start, endSec: end }];
      steps.push(
        `برش لبه‌ها: ${Math.round(start)} ثانیه از ابتدا، ${Math.round(endCut)} ثانیه از انتها`,
      );
    } else {
      steps.push("لبه‌های فایل سکوت طولانی نداشتند — برشی انجام نشد");
    }
  }

  // ── آیا اصلاً ترنسکد لازم است؟ ─────────────────────────────────────────
  const decision = shouldTranscode(source);
  if (!decision.transcode && !keepRegions) {
    steps.push(`بدون ترنسکد — ${decision.reason}`);
    const result: PreprocessResult = {
      processedFile: inputFile,
      originalFile: inputFile,
      source,
      timeMap: TimeMap.identity(),
      originalDurationMs: source.durationMs,
      billedDurationMs: source.durationMs,
      savedMs: 0,
      outSizeBytes: source.sizeBytes,
      quality,
      steps,
      elapsedMs: Date.now() - t0,
      transcoded: false,
    };
    logger.info(
      { jobId, reason: decision.reason, elapsedSec: Math.round(result.elapsedMs / 1000) },
      "preprocess skipped transcode",
    );
    return result;
  }
  steps.push(`ترنسکد لازم است — ${decision.reason}`);

  // ── انتخاب بیت‌ریت ─────────────────────────────────────────────────────
  // منبعی که از قبل بیت‌ریت پایینی دارد را بالاتر رمزگذاری نکن؛ نسل دوم
  // فشرده‌سازی فقط کیفیت را بدتر می‌کند بدون اینکه چیزی به دست بیاید.
  const targetKbps = Number(String(config.AUDIO_BITRATE).replace(/k$/i, ""));
  const srcKbps = source.bitRate > 0 ? source.bitRate / 1000 : Infinity;
  const bitrate = srcKbps < targetKbps ? `${Math.max(12, Math.round(srcKbps))}k` : config.AUDIO_BITRATE;

  // ── نرمال‌سازی بلندی ───────────────────────────────────────────────────
  // مدل‌های ASR ورودی را داخلاً نرمال می‌کنند، پس loudnorm برای دقت لازم نیست.
  // تنها دلیل نگه‌داشتنش اینجا جلوگیری از بریدگی در ترنسکد است: وقتی منبع
  // اوج واقعی بالای صفر دارد، رمزگذاری دوباره اعوجاج را بدتر می‌کند.
  const loudnorm: LoudnormMeasure | null = quality.clipping || quality.tooQuiet ? measured.loudnorm : null;
  if (loudnorm) {
    steps.push(
      quality.clipping
        ? "نرمال‌سازی بلندی برای جلوگیری از بریدگی بیشتر در رمزگذاری"
        : "نرمال‌سازی بلندی برای جبران سطح پایین ضبط",
    );
  }

  const outFile = path.join(config.workDir, `${jobId}.processed.ogg`);
  await fs.mkdir(path.dirname(outFile), { recursive: true });

  const enc = await encode(inputFile, outFile, {
    sampleRate: config.AUDIO_SAMPLE_RATE,
    bitrate,
    highpassHz,
    loudnorm,
    keepRegions,
  });
  steps.push(`مونو ${config.AUDIO_SAMPLE_RATE / 1000} کیلوهرتز، Opus با ${bitrate}`);

  const result: PreprocessResult = {
    processedFile: enc.outFile,
    originalFile: inputFile,
    source,
    timeMap: enc.timeMap,
    originalDurationMs: source.durationMs,
    billedDurationMs: enc.outDurationMs,
    savedMs: Math.max(0, source.durationMs - enc.outDurationMs),
    outSizeBytes: enc.outSizeBytes,
    quality,
    steps,
    elapsedMs: Date.now() - t0,
    transcoded: true,
  };

  logger.info(
    {
      jobId,
      from: `${source.codec} ${Math.round(source.sizeBytes / 1024)}KB`,
      to: `opus ${Math.round(enc.outSizeBytes / 1024)}KB`,
      savedSec: Math.round(result.savedMs / 1000),
      quality: quality.level,
      elapsedSec: Math.round(result.elapsedMs / 1000),
    },
    "preprocess done",
  );

  return result;
}
