/**
 * سنجهٔ **فراخوانی و دقت** روی نکته‌ها، با مجموعهٔ طلایی.
 *
 * ## چرا این سنجه لازم شد
 *
 * `stability-check` می‌گوید ده اجرا چقدر شبیه هم‌اند، ولی نمی‌گوید جوابشان
 * **درست** است یا نه — ده اجرای یکدست و یکدست‌غلط، سبز می‌گیرد. و
 * `notes-check` جزوه را می‌سنجد نه نکته‌ها را. پس تا امروز سؤالِ اصلیِ محصول
 * («آیا آن کتابی که استاد چهار دقیقه اسمش را برد، به دانشجو رسید؟») هیچ
 * جوابِ عددی نداشت و هر بار با خواندنِ خروجی و حافظه جواب داده می‌شد.
 *
 * اینجا چهار عدد درمی‌آید:
 *
 * • **فراخوانی** — چند مورد از `expected` در نکته‌های تأییدشده هست. این
 *   عددِ اصلی است: هرچه از قلم بیفتد، دانشجو هرگز نمی‌بیندش.
 * • **نقض** — چند مورد از `forbidden` ظاهر شد. عددِ دقت.
 * • **پایداری** — جاکاردِ مجموعهٔ نکته‌ها بین اجراها. نوسان یعنی رسیدنِ یک
 *   واقعیت به دانشجو به قرعه بستگی دارد.
 * • **لنگرِ سرفصل** — هیچ سرفصلی نباید در ۱۰٪ آخر بیفتد مگر واقعاً آنجا
 *   باشد. همان باگی که سرفصلِ دقیقهٔ ۱۴ را به دقیقهٔ ۸۲ می‌برد.
 *
 * ## هزینه
 *
 * هر اجرا یک فراخوانِ کاملِ پاس اول است، و اجرای اول جزوه هم می‌سازد. روی
 * کلاس ۹۴ دقیقه‌ای حدود ۰٫۰۱۵ دلار برای پاس اول و چند برابرش برای جزوه.
 * **عمداً در `test-all` نیست.**
 *
 * ## اجرا (روی سرور — از لپ‌تاپ به مدل نمی‌رسیم)
 *
 *     ssh root@91.107.246.90
 *     cd /opt/kharkhoon
 *     npx tsx scripts/eval-keypoints.mjs            # همهٔ فایل‌های golden، ۳ اجرا
 *     npx tsx scripts/eval-keypoints.mjs 1          # یک اجرا (سریع و ارزان)
 *     npx tsx scripts/eval-keypoints.mjs golden/<هش>.json 2
 *
 * خروجی: خلاصهٔ خوانا روی ترمینال، و JSON کامل در `eval-out/`.
 */
import fs from "node:fs";
import path from "node:path";
import { buildTranscript } from "../src/stt/transcript.ts";
import { analyzeClass, notesBudget } from "../src/analysis/analyze.ts";
import { containmentScore, normalizeFa } from "../src/util/text.ts";
import { fmtClock } from "../src/util/time.ts";

const GOLDEN_DIR = "golden";
const CACHE_DIR = path.join("data", "cache");
const OUT_DIR = "eval-out";

// ── ورودی ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isNum = (s) => /^\d+$/.test(s ?? "");
const files = args.filter((a) => !isNum(a));
const RUNS = Number(args.find(isNum) ?? 3);

const goldenFiles = files.length
  ? files
  : fs
      .readdirSync(GOLDEN_DIR)
      .filter((n) => n.endsWith(".json"))
      .map((n) => path.join(GOLDEN_DIR, n));

if (goldenFiles.length === 0) {
  console.error(`هیچ فایل طلایی‌ای نیست. golden/README.md را ببین.`);
  process.exit(1);
}

/**
 * کش را از روی **هَشِ نام فایل طلایی** پیدا می‌کند.
 *
 * قرارداد در `golden/README.md` آمده: نام فایل طلایی همان هش کش است. با
 * این کار نه مسیر دستی لازم است و نه یک فایل طلایی می‌تواند بی‌صدا به کشِ
 * اشتباهی وصل شود.
 */
function findCache(goldenPath) {
  const hash = path.basename(goldenPath, ".json");
  const names = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : [];
  const hit = names.find((n) => n.includes(`.${hash}.`) && n.endsWith(".soniox.json"));
  return hit ? path.join(CACHE_DIR, hit) : null;
}

/**
 * آیا این نکتهٔ تأییدشده، همان موردِ طلایی است؟
 *
 * دو شرط: نوع بخورد، و نقل‌قول بریدهٔ طلایی را در بر بگیرد. شرط دوم
 * سخاوتمندانه است (`containmentScore ≥ ۰٫۷۵`) چون مدل هر بار از همان جمله
 * بریدهٔ کمی متفاوتی برمی‌دارد و ما داریم **واقعیت** را می‌سنجیم نه انتخابِ
 * دقیقِ کلمات.
 *
 * `obligation` فقط وقتی سنجیده می‌شود که فایل طلایی گفته باشد — چون برای
 * نوع‌های دیگر معنا ندارد و همیشه `required` است.
 */
function matches(kp, want) {
  if (kp.kind !== want.kind) return false;
  if (want.obligation && (kp.obligation ?? "required") !== want.obligation) return false;
  const quote = normalizeFa(kp.evidence?.quote ?? "");
  const frag = normalizeFa(want.quote_fragment);
  if (!quote || !frag) return false;
  if (` ${quote} `.includes(` ${frag} `)) return true;
  return containmentScore(want.quote_fragment, quote) >= 0.75;
}

/** آیا این بریدهٔ ممنوع در نکته‌ها ظاهر شده؟ */
function appears(keyPoints, forbidden) {
  const frag = normalizeFa(forbidden.quote_fragment);
  return keyPoints.some((kp) => {
    const quote = normalizeFa(kp.evidence?.quote ?? "");
    if (!quote) return false;
    if (` ${quote} `.includes(` ${frag} `)) return true;
    return containmentScore(forbidden.quote_fragment, quote) >= 0.75;
  });
}

/** جاکارد دو مجموعه — سنجهٔ پایداری بین دو اجرا. */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** امضای یک نکته، برای مقایسهٔ بین اجراها. */
const signature = (kp) => `${kp.kind}|${normalizeFa(kp.evidence?.quote ?? "").slice(0, 60)}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const all = [];
let anyFailure = false;

for (const goldenPath of goldenFiles) {
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
  const cachePath = findCache(goldenPath);
  const name = path.basename(goldenPath, ".json");

  console.log(`\n${"═".repeat(72)}`);
  console.log(`${golden.session ?? name}`);
  console.log(`${"═".repeat(72)}`);

  if (!cachePath) {
    console.log(`⏭️ کشِ این جلسه روی این ماشین نیست (دنبال *.${name}.soniox.json در ${CACHE_DIR})`);
    continue;
  }

  const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const transcript = buildTranscript(raw.transcript.tokens, {
    toOriginal: (ms) => ms,
    skippedMs: 0,
  });
  const durationMs = raw.transcription?.audio_duration_ms ?? 0;

  const meta = {
    courseName: null,
    professorName: null,
    sessionDate: null,
    originalDurationMs: durationMs,
    silenceMs: 0,
    speakerSummary: "نامشخص",
    qualityNote: "",
  };

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    /**
     * فقط **اجرای اول** جزوه می‌سازد.
     *
     * جزوه گران‌ترین و کندترین بخش است و برای سنجهٔ نکته‌ها لازم نیست. ولی
     * کاملاً هم نمی‌شود کنارش گذاشت: کفِ طول و `unsupportedMentions` تنها
     * جایی هستند که پاس دوم را می‌سنجند.
     */
    const skipNotes = i > 0;
    const t0 = Date.now();
    const out = await analyzeClass(transcript, meta, { skipNotes });
    const seconds = Math.round((Date.now() - t0) / 1000);
    const kp = out.report.key_points;

    const found = golden.expected.map((w) => ({
      ...w,
      hit: kp.some((k) => matches(k, w)),
    }));
    const violated = golden.forbidden.filter((f) => appears(kp, f));

    // لنگرِ سرفصل: هیچ سرفصلی نباید در ۱۰٪ آخر بیفتد مگر واقعاً آنجا باشد
    const tailStart = durationMs * 0.9;
    const lateTopics = out.report.topics.filter((t) => t.start_ms >= tailStart);

    const words = out.notesMarkdown ? out.notesMarkdown.split(/\s+/).filter(Boolean).length : 0;
    const floor = notesBudget(out.report.chapters).reduce((s, c) => s + c.floor, 0);

    runs.push({
      run: i + 1,
      seconds,
      usd: out.usage.estimatedUsd,
      keyPointCount: kp.length,
      signatures: kp.map(signature),
      recall: found.filter((f) => f.hit).length,
      recallTotal: golden.expected.length,
      missed: found.filter((f) => !f.hit).map((f) => `[${f.kind}] ${f.quote_fragment}`),
      violations: violated.map((f) => f.quote_fragment),
      chapters: out.report.chapters.length,
      topics: out.report.topics.map((t) => ({ title: t.title, at: fmtClock(t.start_ms, true) })),
      lateTopics: lateTopics.map((t) => t.title),
      dropped: {
        unverified: out.report.droppedUnverified,
        importance: out.report.droppedImportance,
      },
      notes: skipNotes ? null : { words, floor, pct: floor ? Math.round((words / floor) * 100) : null },
      unsupportedMentions: skipNotes ? null : out.unsupportedMentions,
    });

    const r = runs[runs.length - 1];
    console.log(
      `\n── اجرا ${r.run}/${RUNS} · ${r.seconds} ثانیه · $${r.usd.toFixed(4)} ` +
        `· نکته ${r.keyPointCount} · بخش ${r.chapters}`,
    );
    console.log(
      `   فراخوانی ${r.recall}/${r.recallTotal}` +
        (r.violations.length ? ` · ⚠️ نقض ${r.violations.length}` : " · نقض ۰"),
    );
    for (const k of kp) {
      const mark = golden.forbidden.some((f) => appears([k], f)) ? "⛔" : "•";
      console.log(`   ${mark} [${k.kind}] ${k.title} ← «${(k.evidence?.quote ?? "").slice(0, 60)}»`);
    }
    for (const m of r.missed) console.log(`   ❌ از قلم افتاد: ${m}`);
    if (r.lateTopics.length) console.log(`   ⚠️ سرفصل در ۱۰٪ آخر: ${r.lateTopics.join("، ")}`);
    if (r.notes) {
      console.log(`   جزوه: ${r.notes.words} کلمه در برابر کفِ ${r.notes.floor} (٪${r.notes.pct})`);
      if (r.unsupportedMentions?.length) {
        console.log(`   ⚠️ ادعای بی‌ریشه در جزوه: ${r.unsupportedMentions.join("، ")}`);
      }
    }
  }

  // ── جمع‌بندی این جلسه ──────────────────────────────────────────────────
  const recallPct = golden.expected.length
    ? Math.round(
        (runs.reduce((s, r) => s + r.recall, 0) / (golden.expected.length * runs.length)) * 100,
      )
    : 100;
  const violations = runs.reduce((s, r) => s + r.violations.length, 0);

  let stability = 1;
  if (runs.length > 1) {
    const pairs = [];
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        pairs.push(jaccard(new Set(runs[i].signatures), new Set(runs[j].signatures)));
      }
    }
    stability = pairs.reduce((a, b) => a + b, 0) / pairs.length;
  }

  const usd = runs.reduce((s, r) => s + r.usd, 0);
  console.log(`\n${"─".repeat(72)}`);
  console.log(
    `فراخوانی ٪${recallPct}` +
      (golden.expected.length === 0 ? " (فهرست طلایی خالی — یعنی نباید چیزی ساخته شود)" : "") +
      ` · نقض ${violations} · پایداری ${stability.toFixed(2)}` +
      ` · نکته ${runs.map((r) => r.keyPointCount).join("/")} · $${usd.toFixed(4)}`,
  );

  if (recallPct < 100 || violations > 0) anyFailure = true;
  all.push({ golden: name, session: golden.session, recallPct, violations, stability, usd, runs });
}

const outPath = path.join(OUT_DIR, `eval-${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify({ runs: RUNS, results: all }, null, 2), "utf8");

console.log(`\n${"═".repeat(72)}`);
for (const r of all) {
  console.log(
    `${r.recallPct === 100 && r.violations === 0 ? "✅" : "⚠️"} ${r.session ?? r.golden} — ` +
      `فراخوانی ٪${r.recallPct} · نقض ${r.violations} · پایداری ${r.stability.toFixed(2)}`,
  );
}
console.log(`\nهزینهٔ کل: $${all.reduce((s, r) => s + r.usd, 0).toFixed(4)}`);
console.log(`JSON: ${outPath}`);

/**
 * کدِ خروج **صفر** می‌ماند حتی وقتی فراخوانی کامل نیست.
 *
 * این یک سنجه است نه یک آزمون: قرار است اعدادش خوانده و مقایسه شوند، نه
 * اینکه یک خط CI را قرمز کند. قرمزکردنش وسوسه می‌کند که مجموعهٔ طلایی را
 * آسان‌تر کنیم تا سبز شود — دقیقاً برعکسِ کاری که باید بکند.
 */
if (anyFailure) console.log("\n⚠️ فراخوانی کامل نیست یا نقضی هست — بالا را بخوان.");
