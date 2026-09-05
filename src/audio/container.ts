/**
 * پسوندِ درستِ یک فایل صوتی — از روی خودِ بایت‌ها، نه از روی نامش.
 *
 * ## چرا لازم شد
 *
 * فایلی که از بله می‌آید هیچ پسوندی ندارد: `file_path` روی بله خودِ `file_id`
 * است، پس `download.ts` اسمش را `.bin` می‌گذارد. بعد `deliver.ts` همان فایل
 * را با نام `«عنوان».mp3` می‌فرستاد، در حالی که محتوایش Ogg بود.
 *
 * تلگرام پسوند را باور می‌کند. نتیجه روی سرور آزموده شد — همان فایلِ Ogg:
 *
 *   • با نام `.bin`  → پیام از نوع audio، `mime: audio/mpeg`، **مدت صفر**
 *   • با نام `.mp3`  → همان، باز هم مدت صفر
 *   • با نام `.ogg`  → پیام صوتیِ درست، `mime: audio/ogg`، مدت ۴۹ ثانیه
 *
 * و **مدت صفر یعنی هیچ‌چیز کار نمی‌کند**: نه پخش، نه جابه‌جایی روی نوار، و
 * نه زمان‌های داخل گزارش — چون تلگرام زمان را فقط وقتی به لینکِ پخش تبدیل
 * می‌کند که پیامِ صوتیِ ریپلای‌شده مدت داشته باشد.
 *
 * ## چرا امضای بایتی و نه ffprobe
 *
 * ffprobe جواب دقیق‌تری می‌دهد ولی یک پروسهٔ جدید است و اینجا در مسیرِ تحویل
 * صدا زده می‌شود. چند بایت اول برای تشخیصِ ظرف کافی است؛ ظرف هم دقیقاً همان
 * چیزی است که تلگرام از پسوند می‌فهمد.
 */
import fs from "node:fs";

/** ظرف‌هایی که در عمل از بله، تلگرام، مینی‌اپ و لینک می‌رسند. */
const SIGNATURES: Array<{ ext: string; test: (b: Buffer) => boolean }> = [
  { ext: ".ogg", test: (b) => b.subarray(0, 4).toString("latin1") === "OggS" },
  { ext: ".flac", test: (b) => b.subarray(0, 4).toString("latin1") === "fLaC" },
  {
    ext: ".wav",
    test: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE",
  },
  { ext: ".webm", test: (b) => b.subarray(0, 4).toString("hex") === "1a45dfa3" },
  // `ftyp` در بایت ۴ تا ۸؛ زیرقالبش (m4a، mp4، 3gp) برای تلگرام فرقی ندارد و
  // همه با `.m4a` به‌درستی پخش می‌شوند.
  { ext: ".m4a", test: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" },
  { ext: ".mp3", test: (b) => b.subarray(0, 3).toString("latin1") === "ID3" },
  // فریمِ خامِ MPEG بدون برچسب ID3
  { ext: ".mp3", test: (b) => b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 },
];

/**
 * پسوندی که باید موقع فرستادن روی این فایل بگذاریم.
 *
 * اگر هیچ امضایی نخورد `.mp3` برمی‌گردد — نه چون حدسِ خوبی است، بلکه چون
 * رفتار قبلی همین بود و نباید بدترش کنیم.
 */
export function audioExt(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return SIGNATURES.find((s) => s.test(head))?.ext ?? ".mp3";
  } catch {
    return ".mp3";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
