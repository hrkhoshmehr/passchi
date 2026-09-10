import type { TranscriptToken } from "@soniox/node";
import { TimeMap } from "../audio/ffmpeg.js";
import { fmtClock } from "../util/time.js";
import { normalizeFa, containmentScore, tokens } from "../util/text.js";

export type SpeakerRole = "استاد" | "دانشجو" | "نامشخص";

export interface Utterance {
  index: number;
  /** زمان‌ها همیشه روی فایل *اصلی* هستند تا نقل‌قول‌ها قابل مراجعه باشند */
  startMs: number;
  endMs: number;
  speakerId: string;
  role: SpeakerRole;
  text: string;
  /** میانگین اطمینان مدل روی این پاره‌گفتار (۰..۱) */
  confidence: number;
  normalized: string;
}

export interface SpeakerStats {
  speakerId: string;
  role: SpeakerRole;
  speechMs: number;
  turns: number;
  words: number;
}

export interface BuiltTranscript {
  utterances: Utterance[];
  speakers: SpeakerStats[];
  totalSpeechMs: number;
  words: number;
  /** نسبت متنی که مدل با اطمینان پایین برگردانده (۰..۱) */
  lowConfidenceRatio: number;
}

const GAP_BREAK_MS = 1_500;
const MAX_UTTERANCE_CHARS = 700;

/**
 * پاره‌گفتارِ کوتاه‌تر از این، پاره‌گفتار نیست — تکه‌ای است که موتور رونویسی
 * وسط یک جمله بریده.
 *
 * ## چرا چسباندنشان لازم شد
 *
 * سونیوکس هر مکثِ کوتاه را مرز می‌گیرد، پس یک جملهٔ پیوستهٔ استاد به دو سه
 * تکه خرد می‌شود. روی کلاس ۹۴ دقیقه‌ای حقوق مدنی، ۸۲ پاره‌گفتار از ۳۱۲ زیر
 * چهل نویسه بودند. بهایش مستقیم روی راستی‌آزمایی افتاد: نقل‌قولِ «مباحث
 * مربوط به این ترم، از ماده ۱۸۳ شروع می‌شه. از ماده ۱۸۳ لغایت ماده ۳۰۰»
 * روی مرز دو تکه افتاده بود و نمرهٔ ۰٫۸۰ می‌گرفت — نه رد می‌شد و نه واقعاً
 * تطبیق کامل بود، و کافی بود مدل یک کلمه دیگر هم نقل کند تا کل نکته بیفتد.
 *
 * قید «همان گوینده» جدی است: تکهٔ کوتاهی که گویندهٔ دیگری گفته، حرفِ خودش
 * است و چسباندنش یعنی نسبت‌دادنِ حرفِ دانشجو به استاد.
 */
const MIN_UTTERANCE_CHARS = 30;

interface RawUtterance {
  startMs: number;
  endMs: number;
  speakerId: string;
  text: string;
  confSum: number;
  confN: number;
}

/**
 * تکه‌های ریز را به پاره‌گفتار قبلیِ **همان گوینده** می‌چسباند.
 *
 * اطمینان وزنی به‌روز می‌شود (نه میانگینِ میانگین‌ها): تکهٔ سه‌کلمه‌ای نباید
 * اطمینانِ یک پاره‌گفتار پنجاه‌کلمه‌ای را نصف کند.
 */
function glueTiny(rows: RawUtterance[]): RawUtterance[] {
  const out: RawUtterance[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.speakerId === r.speakerId && r.text.length < MIN_UTTERANCE_CHARS) {
      prev.text = `${prev.text} ${r.text}`.replace(/\s+/g, " ").trim();
      prev.endMs = Math.max(prev.endMs, r.endMs);
      prev.confSum += r.confSum;
      prev.confN += r.confN;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

export function buildTranscript(tokens: TranscriptToken[], timeMap: TimeMap): BuiltTranscript {
  const rows: RawUtterance[] = [];

  let cur: {
    startMs: number;
    endMs: number;
    speakerId: string;
    parts: string[];
    confSum: number;
    confN: number;
  } | null = null;

  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join("").replace(/\s+/g, " ").trim();
    if (text) {
      rows.push({
        startMs: cur.startMs,
        endMs: cur.endMs,
        speakerId: cur.speakerId,
        text,
        confSum: cur.confSum,
        confN: cur.confN,
      });
    }
    cur = null;
  };

  for (const t of tokens) {
    const speakerId = t.speaker ?? "?";
    const startMs = timeMap.toOriginal(t.start_ms ?? 0);
    const endMs = timeMap.toOriginal(t.end_ms ?? t.start_ms ?? 0);

    const shouldBreak =
      !cur ||
      cur.speakerId !== speakerId ||
      startMs - cur.endMs > GAP_BREAK_MS ||
      cur.parts.join("").length > MAX_UTTERANCE_CHARS;

    if (shouldBreak) {
      flush();
      cur = { startMs, endMs, speakerId, parts: [], confSum: 0, confN: 0 };
    }
    cur!.parts.push(t.text);
    cur!.endMs = Math.max(cur!.endMs, endMs);
    cur!.confSum += t.confidence ?? 1;
    cur!.confN += 1;
  }
  flush();

  const utterances: Utterance[] = glueTiny(rows).map((r, i) => ({
    index: i,
    startMs: r.startMs,
    endMs: r.endMs,
    speakerId: r.speakerId,
    role: "نامشخص" as SpeakerRole,
    text: r.text,
    confidence: r.confN > 0 ? r.confSum / r.confN : 1,
    normalized: normalizeFa(r.text),
  }));

  // ── نقش گوینده‌ها ────────────────────────────────────────────────────────
  // فرض: در یک کلاس درس، پرحرف‌ترین گوینده استاد است. برای سخنرانی معمول
  // این فرض بسیار قوی است (معمولاً بالای ۷۰٪ زمان گفتار).
  const byId = new Map<string, SpeakerStats>();
  for (const u of utterances) {
    const s = byId.get(u.speakerId) ?? {
      speakerId: u.speakerId,
      role: "نامشخص" as SpeakerRole,
      speechMs: 0,
      turns: 0,
      words: 0,
    };
    s.speechMs += Math.max(0, u.endMs - u.startMs);
    s.turns += 1;
    s.words += u.text.split(/\s+/).filter(Boolean).length;
    byId.set(u.speakerId, s);
  }

  const speakers = [...byId.values()].sort((a, b) => b.speechMs - a.speechMs);
  const totalSpeechMs = speakers.reduce((a, s) => a + s.speechMs, 0);
  if (speakers[0]) {
    /**
     * **پرحرف‌ترین گوینده فقط وقتی استاد است که واقعاً غالب باشد.**
     *
     * قاعدهٔ قبلی «سهم بالای ۴۰٪» بود، و آن دروازه **از نظر ریاضی هرگز
     * بسته نمی‌شد**: با n گوینده، سهمِ پرحرف‌ترین همیشه دست‌کم ۱/n است، پس
     * برای یک جلسهٔ دونفره همیشه ≥۵۰٪ و همیشه از ۴۰٪ رد می‌شد. یعنی دقیقاً
     * همان حالتی که دروازه برایش ساخته شده بود، تنها حالتی بود که نمی‌گرفت.
     *
     * پنجم سپتامبر ۲۰۲۶ نتیجه‌اش دیده شد: جلسه‌ای دونفره با تقسیم ۵۱ به ۴۹،
     * که در آن **دانشجو** چند صد کاراکتر بیشتر حرف زده بود و برچسب «استاد»
     * گرفت. کل رونوشت وارونه شد و گزارش هم همان وارونگی را تکرار کرد —
     * «استاد مسئله را مطرح کرد» در حالی که دانشجو مطرحش کرده بود.
     *
     * این یک جملهٔ اشتباه نبود؛ برچسبِ هر پاره‌گفتار غلط بود و مدل هم چاره‌ای
     * جز باور کردنش نداشت.
     *
     * قاعدهٔ تازه دو شرط دارد و هر دو باید برقرار باشند:
     *
     * • **سهم مطلق** — دست‌کم ۶۰٪ کل گفتار. سخنرانی کلاسی معمولاً بالای ۷۰٪
     *   است، پس این کف سخاوتمندانه است.
     * • **فاصله از نفر دوم** — دست‌کم دو برابر. این همان شرطی است که حالت
     *   دونفرهٔ متعادل را می‌گیرد و قاعدهٔ قبلی نداشت.
     *
     * وقتی برقرار نباشد هیچ‌کس نقش نمی‌گیرد و همه «گوینده N» می‌مانند. خروجی
     * از این بابت لاغرتر می‌شود، ولی **نگفتن از غلط گفتن بهتر است**: کاربری
     * که می‌بیند نقش‌ها معلوم نیست خودش می‌فهمد، ولی کاربری که «استاد» را
     * وارونه می‌خواند هیچ راهی برای فهمیدنش ندارد.
     */
    const share = totalSpeechMs > 0 ? speakers[0].speechMs / totalSpeechMs : 0;
    const runnerUp = speakers[1]?.speechMs ?? 0;
    const dominant = share >= 0.6 && (runnerUp === 0 || speakers[0].speechMs >= runnerUp * 2);
    speakers[0].role = dominant ? "استاد" : "نامشخص";
    for (const s of speakers.slice(1)) s.role = dominant ? "دانشجو" : "نامشخص";
  }
  const roleOf = new Map(speakers.map((s) => [s.speakerId, s.role]));
  for (const u of utterances) u.role = roleOf.get(u.speakerId) ?? "نامشخص";

  const words = speakers.reduce((a, s) => a + s.words, 0);
  const lowConfWords = utterances
    .filter((u) => u.confidence < 0.6)
    .reduce((a, u) => a + u.text.split(/\s+/).filter(Boolean).length, 0);

  return {
    utterances,
    speakers,
    totalSpeechMs,
    words,
    lowConfidenceRatio: words > 0 ? lowConfWords / words : 0,
  };
}

/**
 * رونوشتی که به مدل داده می‌شود: هر خط با مهر زمانی و نقش گوینده.
 * مهر زمانی لازم است تا مدل بتواند برای هر نکته «منبع» بدهد.
 */
/**
 * رونوشت برای مدل — با زمان به **هر دو شکل**: ساعتی و میلی‌ثانیه.
 *
 * چرا میلی‌ثانیه هم می‌آید: اسکیمای خروجی میلی‌ثانیه می‌خواهد، ولی اگر مدل
 * فقط `[00:01:42]` ببیند باید خودش ضرب کند و همان‌جا خطا می‌سازد. روی یک
 * کلاس ۹۴ دقیقه‌ای نتیجه‌اش فاجعه بود: تمام رویدادها به ده دقیقهٔ اول
 * فشرده شدند («معرفی منابع» شد ۰۰:۲۷ در حالی که واقعاً ۰۱:۴۲ بود) و بخش
 * آخر ۸۶ دقیقه طول کشید. مدل زمان‌ها را *حدس* می‌زد نه اینکه از رونوشت
 * بردارد.
 *
 * با آمدن عدد آماده، کار مدل از «حساب‌کردن» به «کپی‌کردن» تبدیل می‌شود.
 *
 * ⚠️ این خروجی در هر دو پاس بایت‌به‌بایت یکسان می‌ماند و بخشی از بلوکِ
 * کش‌شونده است — تغییرش کش را باطل می‌کند.
 */
export function renderForModel(t: BuiltTranscript): string {
  const lines: string[] = [];
  for (const u of t.utterances) {
    const uncertain = u.confidence < 0.55 ? " ⟨کیفیت پایین⟩" : "";
    const who = u.role === "نامشخص" ? `گوینده ${u.speakerId}` : `${u.role}${u.role === "دانشجو" ? ` ${u.speakerId}` : ""}`;
    lines.push(`[${fmtClock(u.startMs, true)} | ${u.startMs}ms] ${who}${uncertain}: ${u.text}`);
  }
  return lines.join("\n");
}

/** رونوشت ساده برای فایل خروجی .txt */
export function renderPlain(t: BuiltTranscript): string {
  return t.utterances
    .map((u) => `[${fmtClock(u.startMs, true)}] ${u.role === "نامشخص" ? `گوینده ${u.speakerId}` : u.role}: ${u.text}`)
    .join("\n\n");
}

/**
 * زمان شروع یک سرفصل را از خود رونوشت پیدا می‌کند.
 *
 * چرا لازم است: زمانی که مدل برای سرفصل می‌دهد قابل اعتماد نیست. روی یک
 * سخنرانی ۵۰ دقیقه‌ای، مدل ارزان هر نُه سرفصل را در دوازده دقیقهٔ اول
 * گذاشت. نقل‌قول‌ها این مشکل را ندارند چون `verifyQuote` زمانشان را از
 * رونوشت می‌گیرد؛ سرفصل‌ها هم باید همان مسیر را بروند.
 *
 * ## چرا «بیشینهٔ سراسری» جواب نداد
 *
 * نسخهٔ قبلی روی تک‌تک پاره‌گفتارها بیشینه می‌گرفت و تا رسیدن به نمرهٔ ۰٫۶
 * جلو می‌رفت. ولی پاره‌گفتارها کوتاه‌اند: هیچ‌کدام هر پنج اصطلاحِ یک سرفصل
 * را ندارند، پس آن آستانه عملاً هرگز نمی‌خورد و حلقه تا آخر رونوشت می‌رفت —
 * و آنجا یک پاره‌گفتارِ بلندِ جمع‌بندیِ آخرِ کلاس که تصادفاً چند اصطلاح را
 * کنار هم دارد برنده می‌شد.
 *
 * روی کلاس ۹۴ دقیقه‌ای حقوق مدنی نتیجه‌اش این بود: «محدوده درس و تعریف
 * عقد» که واقعاً دقیقهٔ ۱۴ گفته شده بود به دقیقهٔ ۸۲ رفت، و چون هر سرفصل
 * باید از قبلی جلوتر باشد، سه سرفصل بعدی هم با آبشارِ «قبلی + ۴۵ ثانیه»
 * پشتش چیده شدند: ۸۴، ۸۶، ۸۷. یعنی کلِ نیمهٔ دوم فهرست عددهای ساختگی
 * بودند که هیچ‌کدام روی صوت نمی‌افتادند — و کاربر رویشان می‌زند.
 *
 * ## قاعدهٔ تازه: چگالیِ **وزنی** روی پنجرهٔ لغزان
 *
 * پنجره سه پاره‌گفتار است، چون یک اصطلاح ممکن است در یک پاره‌گفتار گفته
 * شود و اصطلاح بعدی در پاره‌گفتار بعدی. زمانِ خروجی همیشه شروعِ **اولین**
 * پاره‌گفتارِ پنجره است، یعنی جایی که موضوع باز می‌شود.
 *
 * و وزن، چون شمارشِ خام روی درسی که تمام‌وقت دربارهٔ «عقد» است کار نمی‌کند:
 * اصطلاح‌های عمومیِ سرفصل («درس»، «عقد»، «توافق») در سراسر همان کلاس صدها
 * بار می‌آیند و هر پنجره‌ای را به آستانه می‌رسانند، در حالی که «ماده ۱۸۳» و
 * «ماده ۳۰۰» — که واقعاً می‌گویند این سرفصل کجاست — شش بار و یک بار. پس هر
 * اصطلاح به نسبتِ **نادر بودنش** ارزش دارد.
 *
 * اصطلاحی که در کل رونوشت اصلاً نیامده از سنجه **بیرون** می‌رود، نه اینکه
 * وزنِ سنگین بگیرد: چنین اصطلاحی بازنویسیِ خودِ مدل است نه حرفِ استاد
 * («محدوده» در همان سرفصل)، و نگه‌داشتنش مخرج را چنان بالا می‌برد که هیچ
 * پنجره‌ای هرگز به آستانه نمی‌رسد.
 *
 * سه پله، به ترتیب:
 *
 *   ۱) **نزدیکِ حدسِ مدل.** ±۱۰ دقیقه حول `start_ms`، اولین پنجره‌ای که به
 *      آستانه می‌رسد. حدسِ مدل دور انداختنی نیست — خطایش معمولاً چند دقیقه
 *      است نه یک ساعت — و همین محدودکردن، اصطلاحِ تکرارشونده را از جایی که
 *      دوباره گفته شده جدا می‌کند.
 *   ۲) **کلِ رونوشت از سرفصل قبلی به بعد.** «اولین» پنجره، چون سرفصل جایی
 *      شروع می‌شود که اولین بار مطرح شده، نه جایی که بیشترین تکرار را دارد.
 *      اگر این پنجره از پنجرهٔ نزدیک **قوی‌تر** باشد، همین برنده است — یعنی
 *      حدسِ مدل فقط تا وقتی مقدم است که چیزی بهتر جای دیگری نباشد. بی این
 *      قید، حدسِ پرتِ مدل یک تطبیقِ ضعیفِ محلی را به تطبیقِ قویِ واقعی
 *      ترجیح می‌داد.
 *   ۳) **همان حدسِ مدل**، بریده به بازهٔ معتبر و نه عقب‌تر از سرفصل قبلی.
 *      این پله عمداً «قبلی + ۴۵ ثانیه» **نیست**: عددِ ساختگی‌ای که وانمود
 *      می‌کند سرفصل‌ها پشت هم آمده‌اند، از یک حدسِ صادقانه بدتر است.
 */

/** پهنای پنجرهٔ لغزان — سه پاره‌گفتار، حدود بیست تا سی ثانیه گفتار. */
const TOPIC_WINDOW = 3;
/** سهمِ لازم از وزنِ کلِ اصطلاح‌ها تا پنجره «همان سرفصل» حساب شود. */
const TOPIC_HIT_SCORE = 0.5;
/** شعاعِ گشتن حول حدسِ مدل، پیش از اینکه کل رونوشت را بگردیم. */
const TOPIC_NEAR_MS = 10 * 60_000;

export function anchorTopics(
  t: BuiltTranscript,
  topics: Array<{ title: string; terms: string[]; start_ms: number }>,
  durationMs: number,
): number[] {
  const us = t.utterances;

  const anchors: number[] = [];
  let floorIdx = 0;

  for (const topic of topics) {
    /**
     * اصطلاح‌های سرفصل **عبارت‌اند، نه کلمه**.
     *
     * شکستنِ term به توکن، سنجه را رقیق می‌کرد: «ماده ۱۸۳» و «ماده ۳۰۰»
     * می‌شدند سه نشانهٔ «ماده»، «۱۸۳»، «۳۰۰» که «ماده» را در هر جای رونوشت
     * پیدا می‌کردند. با عبارت، نشانه همان چیزی است که استاد گفته. عنوانِ
     * سرفصل هنوز توکن می‌شود، چون عنوان جمله است نه اصطلاح.
     */
    const candidates = [
      ...new Set([...tokens(topic.title), ...topic.terms.map((x) => normalizeFa(x))]),
    ].filter((w) => w.length > 2);

    // اصطلاحی که هرگز گفته نشده، بازنویسیِ مدل است نه حرفِ استاد — بیرون
    const needles: { text: string; weight: number }[] = [];
    for (const n of candidates) {
      const df = us.reduce((a, u) => a + (u.normalized.includes(n) ? 1 : 0), 0);
      if (df === 0) continue;
      // وزنِ معکوسِ بسامد: اصطلاحِ نادر می‌گوید سرفصل کجاست، اصطلاح عمومی نه
      needles.push({ text: n, weight: Math.log(us.length / (1 + df)) });
    }
    const totalWeight = needles.reduce((a, n) => a + n.weight, 0);

    const windowScore = (i: number): number => {
      if (totalWeight <= 0) return 0;
      let hay = "";
      for (let k = i; k < Math.min(us.length, i + TOPIC_WINDOW); k++) hay += ` ${us[k]!.normalized}`;
      let hit = 0;
      for (const n of needles) if (hay.includes(n.text)) hit += n.weight;
      return hit / totalWeight;
    };

    /** اولین پنجره در [from, to) که به آستانه می‌رسد، با نمره‌اش. */
    const firstHit = (from: number, to: number): { idx: number; score: number } => {
      for (let i = Math.max(0, from); i < Math.min(us.length, to); i++) {
        const s = windowScore(i);
        if (s >= TOPIC_HIT_SCORE) return { idx: i, score: s };
      }
      return { idx: -1, score: 0 };
    };

    // پلهٔ ۱ — نزدیکِ حدسِ مدل. مرزها روی **اندیس** حساب می‌شوند چون پنجره
    // اندیسی است؛ زمانِ هر پاره‌گفتار معیارِ «داخل بازه بودن» است.
    let nearFrom = us.length;
    let nearTo = 0;
    for (let i = 0; i < us.length; i++) {
      if (Math.abs(us[i]!.startMs - topic.start_ms) > TOPIC_NEAR_MS) continue;
      nearFrom = Math.min(nearFrom, i);
      nearTo = Math.max(nearTo, i + 1);
    }
    const near = nearTo > nearFrom ? firstHit(Math.max(nearFrom, floorIdx), nearTo) : { idx: -1, score: 0 };

    // پلهٔ ۲ — از سرفصل قبلی تا آخر رونوشت. قوی‌تر بودن، بر نزدیک بودن مقدم است.
    const global = near.idx >= 0 && near.score >= 1 ? near : firstHit(floorIdx, us.length);
    const hit = near.idx >= 0 && near.score >= global.score ? near.idx : global.idx;

    // سرفصل اول همیشه از ابتدای جلسه است. واژه‌های عنوانی مثل «مرور مباحث
    // گذشته» در سراسر رونوشت تکرار می‌شوند و تطبیق را به وسط فایل می‌برند.
    if (anchors.length === 0) {
      anchors.push(0);
      if (hit >= 0) floorIdx = hit;
      continue;
    }

    const prev = anchors[anchors.length - 1]!;
    // پلهٔ ۳ — حدسِ خودِ مدل، فقط بریده به بازهٔ معتبر
    let at = hit >= 0 ? us[hit]!.startMs : Math.max(prev, Math.min(topic.start_ms, durationMs));

    // یکتایی و ترتیب: دو سرفصل نمی‌توانند یک زمان بگیرند. این فقط یک تکانِ
    // یک‌ثانیه‌ای است، نه آبشارِ ۴۵ ثانیه‌ایِ قبلی که فهرست را می‌ساخت.
    if (at <= prev) at = Math.min(durationMs, prev + MIN_TOPIC_GAP_MS);
    anchors.push(Math.min(durationMs, at));
    if (hit >= 0) floorIdx = hit;
  }
  return anchors;
}

/**
 * کمینه فاصلهٔ دو سرفصل پیاپی — فقط برای **یکتایی**، نه برای چیدنِ فهرست.
 *
 * پیش‌تر ۴۵ ثانیه بود و همان عدد بود که وقتی لنگر پیدا نمی‌شد، فهرست را به
 * یک آبشارِ ساختگی تبدیل می‌کرد («۸۲، ۸۴، ۸۶، ۸۷»). حالا لنگرِ پیدانشده
 * همان حدسِ مدل را نگه می‌دارد و این عدد فقط جلوی دو زمانِ یکسان را می‌گیرد.
 */
const MIN_TOPIC_GAP_MS = 1_000;

export interface QuoteMatch {
  ok: boolean;
  score: number;
  /** زمان تصحیح‌شده بر اساس جایی که نقل‌قول واقعاً پیدا شد */
  atMs: number;
  role: SpeakerRole;
  /** متن دقیق پاره‌گفتاری که نقل‌قول در آن پیدا شد */
  utteranceText: string;
  /**
   * همان تکه‌ای از نقل‌قولِ مدل که واقعاً تأیید شد.
   *
   * معمولاً خودِ نقل‌قول است. فرق می‌کند وقتی مدل چند خط رونوشت را با «…»
   * به هم دوخته باشد؛ آن‌وقت فقط بلندترین تکه تأیید می‌شود و **همان** به
   * کاربر نشان داده می‌شود، نه جملهٔ دوخته‌شده. چیزی که تأیید نشده نباید در
   * جای «عین حرف استاد» بنشیند.
   */
  matchedQuote: string;
}

/** نقل‌قولی که مدل از چند خط رونوشت به هم دوخته: «…» یا «...» وسطش هست. */
const STITCH = /\s*(?:…|\.\.\.)\s*/;

/**
 * بیشترین سکوتی که هنوز «همان جمله» است.
 *
 * پنجره‌های دو و سه‌تایی فقط روی پاره‌گفتارهایی بسته می‌شوند که با فاصله‌ای
 * کمتر از این پشت هم آمده‌اند. `GAP_BREAK_MS` (۱٫۵ ثانیه) مرزِ ساختنِ
 * پاره‌گفتار است؛ اینجا سخاوتمندانه‌تر است چون مکثِ وسط جمله را هم باید
 * بپوشاند، ولی نه آن‌قدر که دو حرفِ جدا را یکی کند.
 */
const WINDOW_GAP_MS = 5_000;

/**
 * تأیید نقل‌قول: بررسی می‌کند جمله‌ای که مدل به‌عنوان «حرف استاد» برگردانده
 * واقعاً در رونوشت هست یا نه — و اگر هست، زمانش را از خود رونوشت می‌گیرد
 * نه از عددی که مدل حدس زده. بدون این مرحله، «ذکر منبع» بی‌ارزش است.
 */
export function verifyQuote(t: BuiltTranscript, quote: string, hintMs?: number): QuoteMatch {
  const q = normalizeFa(quote);
  const fail: QuoteMatch = {
    ok: false, score: 0, atMs: hintMs ?? 0, role: "نامشخص", utteranceText: "", matchedQuote: quote,
  };
  if (q.length < 8) return fail;

  const take = (score: number, owner: Utterance): QuoteMatch => ({
    ok: score >= 0.75,
    score,
    atMs: owner.startMs,
    role: owner.role,
    utteranceText: owner.text,
    matchedQuote: quote,
  });

  // گذر اول: تک‌تک پاره‌گفتارها. اگر نقل‌قول کامل داخل یکی باشد، زمانش
  // دقیقاً همان است — و همین حالت اکثریت قاطع موارد را می‌گیرد.
  let best: QuoteMatch = fail;
  for (const u of t.utterances) {
    const score = containmentScore(q, u.normalized);
    if (score > best.score) best = take(score, u);
    if (best.score === 1) return best;
  }
  /**
   * نمرهٔ کامل نگرفت؟ پنجره‌ها **همیشه** اجرا می‌شوند، نه فقط وقتی گذر اول
   * رد شده باشد.
   *
   * پیش‌تر شرطی بودند و نتیجه‌اش این بود که نقل‌قولی که روی مرز افتاده با
   * نمرهٔ ۰٫۸۰ «تأییدشده» می‌ماند و همان‌جا برمی‌گشت، در حالی که پنجرهٔ
   * دوتایی همان جمله را کامل پیدا می‌کرد. چون چسباندن پاره‌گفتارها فقط
   * می‌تواند نمره را بالا ببرد، اجرای همیشگی هزینه‌ای جز چند میلی‌ثانیه ندارد.
   */

  /**
   * گذر دوم و سوم: پنجرهٔ دوتایی و سه‌تایی، برای نقل‌قولی که روی مرزِ
   * پاره‌گفتارها افتاده.
   *
   * مالکِ زمان، آن پاره‌گفتاری است که **بیشترین سهم** را از نقل‌قول دارد —
   * نه لزوماً اولی، وگرنه زمانِ گزارش‌شده به پاره‌گفتارِ قبلی می‌چسبد.
   *
   * پنجرهٔ سه‌تایی بعداً اضافه شد چون دوتایی کافی نبود: روی کلاس حقوق مدنی،
   * جملهٔ «مباحث مربوط به این ترم، از ماده ۱۸۳ شروع می‌شه. از ماده ۱۸۳ لغایت
   * ماده ۳۰۰» روی سه تکه پخش شده بود و بهترین نمره‌اش ۰٫۸۰ می‌ماند.
   */
  const windowPass = (width: number) => {
    for (let i = 0; i + width <= t.utterances.length; i++) {
      const win = t.utterances.slice(i, i + width);
      /**
       * پنجره فقط روی گفتارِ **پیوسته** بسته می‌شود.
       *
       * بی این قید، دو پاره‌گفتارِ ده دقیقه دور از هم به هم چسبانده می‌شدند و
       * جمله‌ای که مدل از دو جای کلاس سرِ هم کرده بود «تأیید» می‌شد — دقیقاً
       * همان چیزی که این دروازه برای جلوگیری از آن هست. جمله‌ای که روی مرزِ
       * یک مکثِ کوتاه افتاده باشد از این قید رد می‌شود؛ جمله‌ای که روی مرزِ
       * یک سکوتِ ده‌ثانیه‌ای افتاده باشد، اصلاً یک جمله نبوده.
       */
      let contiguous = true;
      for (let k = 1; k < win.length; k++) {
        if (win[k]!.startMs - win[k - 1]!.endMs > WINDOW_GAP_MS) { contiguous = false; break; }
      }
      if (!contiguous) continue;
      const score = containmentScore(q, win.map((u) => u.normalized).join(" "));
      if (score > best.score) {
        let owner = win[0]!;
        let ownerScore = -1;
        for (const u of win) {
          const s = containmentScore(q, u.normalized);
          if (s > ownerScore) { ownerScore = s; owner = u; }
        }
        best = take(score, owner);
      }
    }
  };

  windowPass(2);
  if (best.score < 1) windowPass(3);

  /**
   * ⚠️ اینجا یک «نجاتِ مرزی» بود و برداشته شد.
   *
   * قاعده‌اش این بود: اگر نمره بین ۰٫۶ و ۰٫۷۵ بماند ولی زمانی که مدل داده به
   * زمانِ بهترین تطبیق نزدیک باشد، نکته تأیید شود. مشکلش این است که آن زمان
   * را **خودِ مدل** تولید کرده، از رونوشتی که هر خطش با زمان دقیق برچسب
   * خورده و پرامپت هم صریح یادش داده عدد را کپی کند. یعنی مدل هر دو طرفِ
   * «تأیید متقابل» را می‌نوشت و آستانهٔ واقعی ۰٫۶ بود نه ۰٫۷۵ — در حالی که
   * مستندات عدد دوم را قطعی اعلام کرده بود.
   *
   * روی هفده نقل‌قولِ واقعیِ ذخیره‌شده هیچ‌کدام به این نجات نیاز نداشتند
   * (کمترین نمره ۰٫۸۹ بود)، پس برداشتنش چیزی از فراخوانی کم نکرد.
   */
  if (best.ok) return best;

  /**
   * نقل‌قولِ **دوخته‌شده**: مدل چند خط رونوشت را با «…» به هم چسبانده.
   *
   * شایع‌ترین شکلِ شکستِ راستی‌آزمایی است — مخصوصاً وقتی می‌خواهد فهرستی
   * (مثلاً نام چند کتاب) را کامل کند. جملهٔ دوخته‌شده در هیچ پاره‌گفتاری پیدا
   * نمی‌شود، پس **کلِ نکته** حذف می‌شد، در حالی که هر تکه‌اش واقعاً گفته شده
   * بود.
   *
   * راه‌حل: بلندترین تکه راستی‌آزمایی می‌شود و زمان هم روی همان می‌نشیند. و
   * مهم‌تر: `matchedQuote` همان تکه می‌شود، پس چیزی که به کاربر به‌عنوان «عین
   * حرف استاد» نشان داده می‌شود دقیقاً همان چیزی است که تأیید شده — نه جملهٔ
   * دوخته‌شده. باقیِ حرف در `detail` نکته هست و از دست نمی‌رود.
   */
  if (STITCH.test(quote)) {
    const parts = quote
      .split(STITCH)
      .map((p) => p.trim())
      .filter((p) => normalizeFa(p).length >= 8)
      .sort((a, b) => normalizeFa(b).length - normalizeFa(a).length);

    for (const part of parts) {
      const m = verifyQuote(t, part, hintMs);
      if (m.ok) return { ...m, matchedQuote: part };
    }
  }

  return best;
}

/**
 * نامی که در خروجی‌های انسانی برای یک گوینده به کار می‌رود.
 *
 * وقتی نقش معلوم نشده «گوینده ۱» می‌آید نه «استاد» — دلیلش در قاعدهٔ نقش‌دهی
 * بالای همین فایل است.
 */
function speakerLabel(u: Utterance): string {
  return u.role === "نامشخص" ? `گوینده ${u.speakerId}` : u.role;
}

/** یک نوبتِ حرف: چند پاره‌گفتارِ پشت سر همِ یک نفر، به هم چسبیده. */
export interface Turn {
  who: string;
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * پاره‌گفتارها را به **نوبت‌های حرف** تبدیل می‌کند.
 *
 * موتور رونویسی هر جا مکث ببیند پاره‌گفتار تازه می‌سازد، پس حرفِ پیوستهٔ یک
 * استاد به ده‌ها تکهٔ کوتاه خرد می‌شود. برای مدل خوب است (هر تکه مهر زمانی
 * دقیق دارد) ولی برای خواندن فاجعه است: خواننده دویست خطِ بریده می‌بیند
 * به‌جای چند بندِ پیوسته.
 *
 * پس تا وقتی گوینده عوض نشده، تکه‌ها به هم می‌چسبند — بریدن فقط جایی است که
 * واقعاً کسی وسط حرف آمده.
 */
export function toTurns(t: BuiltTranscript): Turn[] {
  const out: Turn[] = [];
  for (const u of t.utterances) {
    const who = speakerLabel(u);
    const last = out[out.length - 1];
    if (last && last.who === who) {
      last.text += ` ${u.text}`;
      last.endMs = u.endMs;
    } else {
      out.push({ who, startMs: u.startMs, endMs: u.endMs, text: u.text });
    }
  }
  return out;
}

/** `hh:mm:ss,mmm` — قالبی که SRT می‌خواهد. */
function srtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(Math.floor(t / 3_600_000))}:${p(Math.floor((t % 3_600_000) / 60_000))}:` +
    `${p(Math.floor((t % 60_000) / 1000))},${p(t % 1000, 3)}`
  );
}

/**
 * رونوشت به قالب زیرنویس (SRT).
 *
 * **این فایلِ «کدام ثانیه چه گفته شد» است.** جای مهر زمانی در متنِ خواندنی
 * نیست؛ آنجا فقط سد راه است. ولی خودِ اطلاعات ارزش دارد — برای پیداکردن یک
 * لحظه، یا برای سوارکردن روی ویدیوی ضبط‌شدهٔ کلاس.
 *
 * SRT انتخاب شد نه یک متنِ زمان‌دارِ خودمانی، چون هر پخش‌کننده‌ای می‌فهمدش و
 * با این حال یک فایل متنیِ ساده هم هست که مستقیم می‌شود خواندش.
 *
 * اینجا از پاره‌گفتارها استفاده می‌شود نه از نوبت‌ها: زیرنویسی که سه دقیقه
 * روی صفحه بماند به درد نمی‌خورد.
 */
export function renderSrt(t: BuiltTranscript): string {
  return t.utterances
    .map(
      (u, i) =>
        `${i + 1}\n${srtTime(u.startMs)} --> ${srtTime(u.endMs)}\n${speakerLabel(u)}: ${u.text}\n`,
    )
    .join("\n");
}
