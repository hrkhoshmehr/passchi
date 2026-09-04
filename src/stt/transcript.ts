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

export function buildTranscript(tokens: TranscriptToken[], timeMap: TimeMap): BuiltTranscript {
  const utterances: Utterance[] = [];

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
      utterances.push({
        index: utterances.length,
        startMs: cur.startMs,
        endMs: cur.endMs,
        speakerId: cur.speakerId,
        role: "نامشخص",
        text,
        confidence: cur.confN > 0 ? cur.confSum / cur.confN : 1,
        normalized: normalizeFa(text),
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
    const share = totalSpeechMs > 0 ? speakers[0].speechMs / totalSpeechMs : 0;
    // اگر پرحرف‌ترین گوینده کمتر از ۴۰٪ حرف زده، نقش‌دهی مطمئن نیست
    speakers[0].role = share >= 0.4 ? "استاد" : "نامشخص";
    for (const s of speakers.slice(1)) s.role = speakers[0].role === "استاد" ? "دانشجو" : "نامشخص";
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
 * روش: واژه‌های عنوان و اصطلاحات سرفصل را در پاره‌گفتارها می‌شماریم و اولین
 * جایی را که چگالی‌شان بالاست برمی‌داریم — با این قید که از سرفصل قبلی
 * جلوتر باشد، تا ترتیب زمانی حفظ شود.
 */
export function anchorTopics(
  t: BuiltTranscript,
  topics: Array<{ title: string; terms: string[]; start_ms: number }>,
  durationMs: number,
): number[] {
  const anchors: number[] = [];
  let floorIdx = 0;

  for (const topic of topics) {
    const needles = [...tokens(topic.title), ...topic.terms.flatMap((x) => tokens(x))].filter(
      (w) => w.length > 2,
    );

    let bestIdx = -1;
    let bestScore = 0;
    for (let i = floorIdx; i < t.utterances.length; i++) {
      const hay = t.utterances[i]!.normalized;
      let hits = 0;
      for (const n of needles) if (hay.includes(n)) hits++;
      const score = needles.length ? hits / needles.length : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
      // به‌محض رسیدن به تطبیق قوی متوقف شو — اولین جایی که موضوع مطرح
      // می‌شود مهم است، نه جایی که بیشترین تکرار را دارد
      if (score >= 0.6) break;
    }

    // سرفصل اول همیشه از ابتدای جلسه است. واژه‌های عنوانی مثل «مرور مباحث
    // گذشته» در سراسر رونوشت تکرار می‌شوند و تطبیق را به وسط فایل می‌برند.
    if (anchors.length === 0) {
      anchors.push(0);
      if (bestIdx >= 0 && bestScore >= 0.25) floorIdx = bestIdx;
      continue;
    }

    const prev = anchors[anchors.length - 1]!;
    let at =
      bestIdx >= 0 && bestScore >= 0.25 ? t.utterances[bestIdx]!.startMs : Math.max(prev, topic.start_ms);

    // دو سرفصل نمی‌توانند یک زمان بگیرند؛ فهرستی که همه‌اش یک عدد است بی‌فایده است
    if (at <= prev + MIN_TOPIC_GAP_MS) at = Math.min(durationMs, prev + MIN_TOPIC_GAP_MS);
    anchors.push(Math.min(durationMs, at));
    if (bestIdx >= 0 && bestScore >= 0.25) floorIdx = bestIdx;
  }
  return anchors;
}

/** کمینه فاصلهٔ دو سرفصل پیاپی. */
const MIN_TOPIC_GAP_MS = 45_000;

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
  if (best.ok) return best;

  // گذر دوم: پنجرهٔ دوتایی، برای نقل‌قولی که روی مرز دو پاره‌گفتار افتاده.
  // مالکِ زمان، آن پاره‌گفتاری است که سهم بیشتری از نقل‌قول را دارد —
  // نه لزوماً اولی، وگرنه زمانِ گزارش‌شده به پاره‌گفتار قبلی می‌چسبد.
  for (let i = 0; i < t.utterances.length - 1; i++) {
    const a = t.utterances[i]!;
    const b = t.utterances[i + 1]!;
    const score = containmentScore(q, `${a.normalized} ${b.normalized}`);
    if (score > best.score) {
      const owner = containmentScore(q, a.normalized) >= containmentScore(q, b.normalized) ? a : b;
      best = take(score, owner);
    }
  }

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
