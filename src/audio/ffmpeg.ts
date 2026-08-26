import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { logger } from "../util/logger.js";

export const FFMPEG = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** سیگنالی که پروسه را کشت — برای assertion فِیل شدن ffmpeg برابر SIGABRT است */
  signal?: string | null;
}

/** بعضی بیلدهای ffmpeg (از جمله ffmpeg-static ویندوز) بدون libsoxr کامپایل شده‌اند. */
let soxrAvailable: boolean | null = null;
export async function hasSoxr(): Promise<boolean> {
  if (soxrAvailable !== null) return soxrAvailable;
  try {
    const { stdout, stderr } = await run(FFMPEG, ["-hide_banner", "-version"], 20_000);
    soxrAvailable = /--enable-libsoxr/.test(stdout + stderr);
  } catch {
    soxrAvailable = false;
  }
  return soxrAvailable;
}

export function run(bin: string, args: string[], timeoutMs = 30 * 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    // stderr برای فایل‌های طولانی بزرگ می‌شود؛ فقط انتهایش را نگه می‌داریم
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    /**
     * سیگنال هم مهم است، نه فقط کد خروج.
     *
     * وقتی ffmpeg با assertion می‌میرد (`Assertion ... failed`)، SIGABRT
     * می‌گیرد و `code` برابر `null` می‌شود. اگر فقط به `code ?? -1` نگاه
     * کنیم، خطا گرفته می‌شود ولی *دلیلش* در پیام گم می‌شود و لاگ فقط
     * انبوهی از خط‌های پیشرفتِ ffmpeg را نشان می‌دهد.
     */
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, signal: signal ?? null });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// probe
// ─────────────────────────────────────────────────────────────────────────────

export interface AudioInfo {
  durationMs: number;
  sampleRate: number;
  channels: number;
  /** بیت‌ریت جریان صوتی (bps) — برای بعضی فرمت‌ها ممکن است صفر باشد */
  bitRate: number;
  codec: string;
  formatName: string;
  sizeBytes: number;
}

export async function probe(file: string): Promise<AudioInfo> {
  const { code, stdout, stderr } = await run(
    FFPROBE,
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format", "-show_streams",
      "-select_streams", "a:0",
      file,
    ],
    120_000,
  );
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.slice(-500)}`);
  const j = JSON.parse(stdout) as {
    streams?: Array<Record<string, string>>;
    format?: Record<string, string>;
  };
  const st = j.streams?.[0];
  if (!st) throw new Error("هیچ جریان صوتی در فایل پیدا نشد.");
  const fmt = j.format ?? {};
  const durationSec = Number(st.duration || fmt.duration || 0);
  return {
    durationMs: Math.round(durationSec * 1000),
    sampleRate: Number(st.sample_rate || 0),
    channels: Number(st.channels || 1),
    bitRate: Number(st.bit_rate || fmt.bit_rate || 0),
    codec: st.codec_name ?? "unknown",
    formatName: fmt.format_name ?? "unknown",
    sizeBytes: Number(fmt.size || 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// پاس تحلیل (فقط دیکد و اندازه‌گیری — بدون رمزگذاری)
// ─────────────────────────────────────────────────────────────────────────────

export interface Interval {
  startSec: number;
  endSec: number;
}

export interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export interface AnalysisResult {
  /** بازه‌های سکوت، اندازه‌گیری‌شده پس از نرمال‌سازی بلندی */
  silences: Interval[];
  totalSilenceSec: number;
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  loudnorm: LoudnormMeasure | null;
}

export interface AnalyzeOptions {
  highpassHz: number;
  silenceThresholdDb: number;
  silenceMinDurationSec: number;
}

export async function analyze(
  file: string,
  durationMs: number,
  opt: AnalyzeOptions,
): Promise<AnalysisResult> {
  return analyzeWindow(file, 0, durationMs / 1000, durationMs, opt);
}

/**
 * همان تحلیل، ولی فقط روی یک پنجرهٔ زمانی.
 *
 * `-ss` قبل از `-i` یعنی جست‌وجوی ورودی: ffmpeg مستقیم به آن نقطه می‌پرد و
 * بقیهٔ فایل اصلاً دیکد نمی‌شود. یک پاس کامل روی صوت ۵۰ دقیقه‌ای حدود یک
 * دقیقه طول می‌کشد؛ سه پنجرهٔ یک‌دقیقه‌ای چند ثانیه.
 */
export async function analyzeWindow(
  file: string,
  startSec: number,
  windowSec: number,
  durationMs: number,
  opt: AnalyzeOptions,
): Promise<AnalysisResult> {
  const af = [
    `highpass=f=${opt.highpassHz}`,
    "volumedetect",
    "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    `silencedetect=n=${opt.silenceThresholdDb}dB:d=${opt.silenceMinDurationSec}`,
  ].join(",");

  const args = ["-hide_banner", "-nostdin", "-vn"];
  if (startSec > 0) args.push("-ss", startSec.toFixed(2));
  args.push("-i", file);
  if (windowSec < durationMs / 1000) args.push("-t", windowSec.toFixed(2));
  args.push("-af", af, "-f", "null", "-");

  const { code, stderr } = await run(FFMPEG, args);
  if (code !== 0) throw new Error(`ffmpeg analyze failed: ${stderr.slice(-800)}`);

  const silences: Interval[] = [];
  let pendingStart: number | null = null;
  for (const m of stderr.matchAll(/silence_start:\s*(-?[\d.]+)|silence_end:\s*(-?[\d.]+)/g)) {
    if (m[1] !== undefined) pendingStart = Math.max(0, Number(m[1]));
    else if (m[2] !== undefined && pendingStart !== null) {
      silences.push({ startSec: pendingStart, endSec: Number(m[2]) });
      pendingStart = null;
    }
  }
  // سکوتی که تا انتهای پنجره ادامه داشته
  if (pendingStart !== null) {
    silences.push({ startSec: pendingStart, endSec: Math.min(windowSec, durationMs / 1000) });
  }
  // زمان‌ها نسبت به شروع پنجره‌اند؛ به مبدأ فایل برگردانده می‌شوند
  if (startSec > 0) {
    for (const s of silences) {
      s.startSec += startSec;
      s.endSec += startSec;
    }
  }

  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);

  let loudnorm: LoudnormMeasure | null = null;
  const jsonStart = stderr.lastIndexOf("{");
  if (jsonStart >= 0) {
    const jsonEnd = stderr.indexOf("}", jsonStart);
    if (jsonEnd > jsonStart) {
      try {
        loudnorm = JSON.parse(stderr.slice(jsonStart, jsonEnd + 1)) as LoudnormMeasure;
      } catch {
        /* اندازه‌گیری loudnorm اختیاری است */
      }
    }
  }

  return {
    silences,
    totalSilenceSec: silences.reduce((a, s) => a + (s.endSec - s.startSec), 0),
    meanVolumeDb: mean?.[1] !== undefined ? Number(mean[1]) : null,
    maxVolumeDb: max?.[1] !== undefined ? Number(max[1]) : null,
    loudnorm,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// اندازه‌گیری نمونه‌ای
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_WINDOW_SEC = 60;

export interface SampledMeasurement {
  loudnorm: LoudnormMeasure | null;
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  /** نسبت سکوت در پنجره‌های نمونه — تعمیم‌پذیر به کل فایل، نه دقیق */
  sampledSilenceRatio: number;
  windows: number;
}

/**
 * سطح سیگنال و کیفیت را از چند پنجرهٔ نمونه می‌سنجد، نه از کل فایل.
 *
 * چرا: یک پاس کامل روی ۵۰ دقیقه صوت حدود یک دقیقه پردازنده می‌خورد. سه پنجرهٔ
 * یک‌دقیقه‌ای همان اعداد را با خطای ناچیز می‌دهند و چند ثانیه طول می‌کشند.
 * چیزی که از اینجا می‌خواهیم — بلندی گفتار، بریدگی، کف نویز — در طول یک
 * جلسهٔ ضبط‌شده با یک دستگاه ثابت تقریباً ثابت است.
 */
export async function measureSampled(
  file: string,
  durationMs: number,
  opt: AnalyzeOptions,
): Promise<SampledMeasurement> {
  const durationSec = durationMs / 1000;
  // ابتدا/میانه/انتها — با کمی فاصله از لبه‌ها تا سکوت شروع و پایان را نگیرد
  const starts =
    durationSec <= SAMPLE_WINDOW_SEC * 4
      ? [0]
      : [durationSec * 0.15, durationSec * 0.5, durationSec * 0.8].map((s) =>
          Math.min(s, durationSec - SAMPLE_WINDOW_SEC),
        );

  const results = await Promise.all(
    starts.map((s) =>
      analyzeWindow(file, s, SAMPLE_WINDOW_SEC, durationMs, opt).catch(() => null),
    ),
  );
  const ok = results.filter((r): r is AnalysisResult => r !== null);
  if (ok.length === 0) throw new Error("اندازه‌گیری صوت ناموفق بود.");

  const avg = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const loud = ok.map((r) => r.loudnorm).filter((l): l is LoudnormMeasure => l !== null);

  return {
    // بدترین حالت را برای اوج نگه می‌داریم: اگر یک پنجره بریدگی داشت، فایل بریدگی دارد
    loudnorm: loud.length
      ? {
          ...loud[0]!,
          input_i: String(avg(loud.map((l) => Number(l.input_i))) ?? loud[0]!.input_i),
          input_tp: String(Math.max(...loud.map((l) => Number(l.input_tp)))),
          input_lra: String(avg(loud.map((l) => Number(l.input_lra))) ?? loud[0]!.input_lra),
        }
      : null,
    meanVolumeDb: avg(ok.map((r) => r.meanVolumeDb)),
    maxVolumeDb: ok.length ? Math.max(...ok.map((r) => r.maxVolumeDb ?? -100)) : null,
    sampledSilenceRatio:
      ok.reduce((a, r) => a + r.totalSilenceSec, 0) / (ok.length * SAMPLE_WINDOW_SEC),
    windows: ok.length,
  };
}

export interface EdgeSilence {
  leadingSec: number;
  trailingSec: number;
}

/**
 * سکوت ابتدا و انتهای فایل.
 *
 * این تنها حالتی است که حذف سکوت واقعاً صرفه دارد: دانشجو ضبط را چند دقیقه
 * قبل از شروع کلاس روشن می‌کند یا یادش می‌رود ببندد. سکوت *بین* جملات در یک
 * کلاس واقعی تقریباً وجود ندارد — کف نویز پیوسته است.
 *
 * فقط دو سر فایل اسکن می‌شوند، نه همه‌اش.
 */
export async function detectEdgeSilence(
  file: string,
  durationMs: number,
  opt: AnalyzeOptions,
  probeSec = 300,
): Promise<EdgeSilence> {
  const durationSec = durationMs / 1000;
  const window = Math.min(probeSec, durationSec / 2);
  if (window < 5) return { leadingSec: 0, trailingSec: 0 };

  const [head, tail] = await Promise.all([
    analyzeWindow(file, 0, window, durationMs, opt).catch(() => null),
    analyzeWindow(file, durationSec - window, window, durationMs, opt).catch(() => null),
  ]);

  let leadingSec = 0;
  const first = head?.silences[0];
  if (first && first.startSec < 0.5) leadingSec = first.endSec;

  let trailingSec = 0;
  const last = tail?.silences.at(-1);
  if (last && last.endSec >= durationSec - 0.5) trailingSec = durationSec - last.startSec;

  return { leadingSec, trailingSec };
}

// ─────────────────────────────────────────────────────────────────────────────
// نگاشت زمان: پس از حذف سکوت، زمان‌های رونوشت باید به فایل اصلی برگردند
// ─────────────────────────────────────────────────────────────────────────────

export interface TimeSegment {
  /** بازه در فایل اصلی */
  origStartMs: number;
  origEndMs: number;
  /** همان بازه در فایل پردازش‌شده */
  newStartMs: number;
  newEndMs: number;
}

export class TimeMap {
  constructor(readonly segments: TimeSegment[]) {}

  static identity(): TimeMap {
    return new TimeMap([]);
  }

  static fromJSON(segments: TimeSegment[] | null | undefined): TimeMap {
    return new TimeMap(segments ?? []);
  }

  /** زمان در فایل پردازش‌شده → زمان در فایل اصلی */
  toOriginal(newMs: number): number {
    const segs = this.segments;
    if (segs.length === 0) return newMs;
    let lo = 0;
    let hi = segs.length - 1;
    const last = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segs[mid]!;
      if (newMs < s.newStartMs) hi = mid - 1;
      // بازه‌ها نیم‌باز [start, end) هستند: newEndMs یک قطعه دقیقاً برابر
      // newStartMs قطعهٔ بعدی است و بدون این شرط، مرز همیشه به قطعهٔ قبلی
      // نسبت داده می‌شود — یعنی به اندازهٔ کل سکوت حذف‌شده خطای زمانی.
      else if (newMs >= s.newEndMs && mid < last) lo = mid + 1;
      else if (newMs > s.newEndMs) lo = mid + 1;
      else return s.origStartMs + (newMs - s.newStartMs);
    }
    const clamped = Math.min(Math.max(lo, 0), segs.length - 1);
    const s = segs[clamped]!;
    return newMs <= s.newStartMs ? s.origStartMs : s.origEndMs;
  }

  toJSON(): TimeSegment[] {
    return this.segments;
  }
}

/** از بازه‌های سکوت، بازه‌های «نگه‌داشتنی» می‌سازد؛ هر برش حاشیهٔ امن دو طرفه دارد. */
export function buildKeepRegions(
  durationSec: number,
  silences: Interval[],
  padSec: number,
  maxCuts: number,
): Interval[] {
  const cuts: Interval[] = [];
  for (const s of silences) {
    const a = s.startSec + padSec;
    const b = s.endSec - padSec;
    if (b - a > 0.4) cuts.push({ startSec: a, endSec: b });
  }
  // سقف تعداد برش‌ها: رشتهٔ فیلتر ffmpeg نباید بی‌نهایت بلند شود
  let kept = cuts;
  if (cuts.length > maxCuts) {
    kept = [...cuts]
      .sort((x, y) => y.endSec - y.startSec - (x.endSec - x.startSec))
      .slice(0, maxCuts)
      .sort((x, y) => x.startSec - y.startSec);
  }

  const regions: Interval[] = [];
  let cursor = 0;
  for (const c of kept) {
    if (c.startSec > cursor) regions.push({ startSec: cursor, endSec: c.startSec });
    cursor = Math.max(cursor, c.endSec);
  }
  if (cursor < durationSec) regions.push({ startSec: cursor, endSec: durationSec });
  return regions.filter((r) => r.endSec - r.startSec > 0.2);
}

// ─────────────────────────────────────────────────────────────────────────────
// پاس رمزگذاری
// ─────────────────────────────────────────────────────────────────────────────

export interface EncodeOptions {
  sampleRate: number;
  bitrate: string;
  highpassHz: number;
  loudnorm: LoudnormMeasure | null;
  keepRegions: Interval[] | null;
}

export interface EncodeResult {
  outFile: string;
  timeMap: TimeMap;
  outDurationMs: number;
  outSizeBytes: number;
}

function encodeArgs(
  input: string,
  output: string,
  chain: string[],
  opt: EncodeOptions,
): string[] {
  return [
    "-hide_banner", "-nostdin", "-vn", "-y",
    "-i", input,
    "-af", chain.join(","),
    "-ac", "1",
    "-ar", String(opt.sampleRate),
    "-c:a", "libopus",
    "-b:a", opt.bitrate,
    "-vbr", "on",
    "-application", "voip",
    "-map_metadata", "-1",
    output,
  ];
}

/** خط assertion را از انبوه خط‌های پیشرفت بیرون می‌کشد. */
function assertionOf(stderr: string): string | null {
  return /Assertion .* failed at [^\s]+/.exec(stderr)?.[0] ?? null;
}

/**
 * پیام خطای خوانا.
 *
 * `stderr` ffmpeg برای یک فایل بلند هزاران خط `size=… time=… bitrate=…` دارد
 * و بریدن ساده‌ی انتهایش، دلیل واقعی را زیر همان زباله‌ها دفن می‌کند — دقیقاً
 * همان چیزی که یک بار به کاربر نشان داده شد. پس اول دنبال خط assertion
 * می‌گردیم و خط‌های پیشرفت را دور می‌ریزیم.
 */
function encodeError(res: RunResult): Error {
  const assertion = assertionOf(res.stderr);
  const meaningful = res.stderr
    .split(/[\r\n]+/)
    .filter((l) => l.trim() && !/^\s*(size|frame)=/.test(l))
    .slice(-6)
    .join("\n");
  const why = assertion ?? (meaningful || "بدون جزئیات");
  return new Error(`ffmpeg encode failed${res.signal ? ` (${res.signal})` : ""}: ${why}`);
}

export async function encode(
  input: string,
  output: string,
  opt: EncodeOptions,
): Promise<EncodeResult> {
  const chain: string[] = [`highpass=f=${opt.highpassHz}`];

  // پاس دوم loudnorm با مقادیر اندازه‌گیری‌شده → نرمال‌سازی خطی، بدون پمپاژ نویز زمینه
  if (opt.loudnorm) {
    const m = opt.loudnorm;
    chain.push(
      "loudnorm=I=-16:TP=-1.5:LRA=11" +
        `:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
        `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
        `:offset=${m.target_offset}:linear=true:print_format=summary`,
    );
  } else {
    chain.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  }

  const timeSegments: TimeSegment[] = [];
  if (opt.keepRegions && opt.keepRegions.length > 0) {
    const expr = opt.keepRegions
      .map((r) => `between(t,${r.startSec.toFixed(3)},${r.endSec.toFixed(3)})`)
      .join("+");
    // نقل‌قول تکی اجباری است: عبارت between(...) خودش کاما دارد و بدون آن،
    // پارسر فیلترگراف ffmpeg رشته را سر همان کاما می‌شکند.
    chain.push(`aselect='${expr}'`, "asetpts=N/SR/TB");

    let acc = 0;
    for (const r of opt.keepRegions) {
      const dur = (r.endSec - r.startSec) * 1000;
      timeSegments.push({
        origStartMs: Math.round(r.startSec * 1000),
        origEndMs: Math.round(r.endSec * 1000),
        newStartMs: Math.round(acc),
        newEndMs: Math.round(acc + dur),
      });
      acc += dur;
    }
  }

  const soxr = await hasSoxr();
  chain.push(`aresample=${opt.sampleRate}${soxr ? ":resampler=soxr" : ""}`);

  let res = await run(FFMPEG, encodeArgs(input, output, chain, opt));

  /**
   * تلاش دوم بدون `loudnorm` — دور زدن یک باگ خودِ ffmpeg.
   *
   * ffmpeg 7.0 روی بعضی فایل‌های AAC وسط کار با
   * `Assertion best_input >= 0 failed at ffmpeg_filter.c` می‌میرد. عاملش
   * `loudnorm` است: یک فیلتر پویا که وقتی به ناپیوستگی مهر زمانی می‌رسد
   * برنامه‌ریز فیلتر را به حالتی می‌برد که هیچ ورودی‌ای «بهترین» نیست.
   * روی یک کلاس واقعی ۸۵ دقیقه‌ای، همیشه حوالی دقیقهٔ ۴۳ رخ می‌داد.
   *
   * نرمال‌سازی بلندی **خوب** است ولی ضروری نیست: بدون آن رونویسی کمی
   * افت می‌کند، در حالی که با شکست، کاربر هیچ چیز نمی‌گیرد. پس اگر پاس
   * اول با سیگنال مُرد، همان زنجیره بدون loudnorm دوباره اجرا می‌شود.
   *
   * فقط روی مرگ با سیگنال یا اثر انگشتِ همین assertion انجام می‌شود، نه هر
   * خطایی — فایل واقعاً خراب باید همچنان شکست بخورد، نه اینکه دو بار وقت
   * بگیرد و بعد شکست بخورد.
   */
  if ((res.signal || /Assertion .* failed/.test(res.stderr)) && opt.loudnorm !== undefined) {
    const fallback = chain.filter((f) => !f.startsWith("loudnorm"));
    logger.warn(
      { signal: res.signal, hint: assertionOf(res.stderr) },
      "encode crashed; retrying without loudnorm",
    );
    res = await run(FFMPEG, encodeArgs(input, output, fallback, opt));
  }

  if (res.code !== 0 || res.signal) throw encodeError(res);

  const info = await probe(output);
  const stat = await fs.stat(output);
  logger.debug({ outDurationMs: info.durationMs, size: stat.size }, "encode done");

  return {
    outFile: output,
    timeMap: new TimeMap(timeSegments),
    outDurationMs: info.durationMs,
    outSizeBytes: stat.size,
  };
}

/**
 * بریدن ابتدای فایل تا سقف مشخص — بدون رمزگذاری دوباره.
 *
 * برای اجرای رایگان لازم است: صوت را نمی‌شود نصفه‌کاره به سرویس رونویسی داد
 * و پول کل فایل را نداد. `-c copy` یعنی این کار عملاً هزینهٔ زمانی ندارد.
 */
export async function trimTo(input: string, output: string, maxMs: number): Promise<string> {
  const { code, stderr } = await run(FFMPEG, [
    "-hide_banner", "-nostdin", "-vn", "-y",
    "-i", input,
    "-t", (maxMs / 1000).toFixed(3),
    "-c", "copy",
    output,
  ]);
  if (code !== 0) throw new Error(`ffmpeg trim failed: ${stderr.slice(-400)}`);
  return output;
}

/** بریدن یک تکهٔ کوتاه از فایل «اصلی» برای دکمهٔ «شنیدن این لحظه» */
export async function extractClip(
  input: string,
  output: string,
  atMs: number,
  durationSec = 30,
  leadSec = 4,
): Promise<string> {
  const start = Math.max(0, atMs / 1000 - leadSec);
  const { code, stderr } = await run(
    FFMPEG,
    [
      "-hide_banner", "-nostdin", "-vn", "-y",
      "-ss", start.toFixed(2),
      "-t", String(durationSec),
      "-i", input,
      "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11",
      "-ac", "1", "-ar", "24000",
      "-c:a", "libopus", "-b:a", "24k", "-application", "voip",
      "-map_metadata", "-1",
      output,
    ],
    180_000,
  );
  if (code !== 0) throw new Error(`ffmpeg clip failed: ${stderr.slice(-400)}`);
  return output;
}
