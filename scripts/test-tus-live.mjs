/**
 * آپلودِ tus — سرتاسری، روی سرورِ زنده و از پشتِ تونلِ واقعی.
 *
 * **چرا زنده و نه جعلی:** درسی که در این پروژه سه بار تکرار شد این است که
 * جعلیِ آپلود همیشه از تولید *درست‌تر* درمی‌آید و باگ را می‌پوشاند — یک بار
 * پرچمِ `a+`، یک بار بررسیِ کامل‌بودن در شاخهٔ تکراری، یک بار پنجرهٔ مسابقهٔ
 * `prog`. tus حالا **مسیرِ پیش‌فرضِ** آپلود است و تا امروز هیچ آزمونی نداشت،
 * پس این یکی عمداً چیزی را mock نمی‌کند: همان HTTPای را می‌زند که مرورگر
 * می‌زند، به همان دامنه‌ای که کاربر می‌بیند.
 *
 * **دام‌هایی که مخصوصاً می‌سنجد:**
 *   • `Location` باید **نسبی** باشد. پشتِ NSIN مبدأ خودش را `http` می‌بیند،
 *     پس آدرسِ مطلق یعنی PATCHِ کلاینتِ https به ریدایرکت بخورد و بدنه بپرد.
 *   • ازسرگیری پس از قطعِ وسطِ PATCH — همان چیزی که کلِ دلیلِ وجودِ tus است.
 *   • بدنهٔ JSON روی PATCHِ نهایی (خلافِ سختگیریِ پروتکل، ولی `app.js` رویش
 *     حساب می‌کند: بی آن، «آپلود کامل شد ولی پاسخی نگرفتیم»).
 *   • مدت از ffprobe بیاید نه از ادعای کلاینت — قیمت روی همین عدد است.
 *
 * **باید روی خودِ سرور اجرا شود:** هم به پایگاه‌داده نیاز دارد (ساختِ توکن و
 * راستی‌آزماییِ جلسه) هم به شبکه‌ای که به دامنه می‌رسد.
 *
 * اجرا:  node --experimental-sqlite --import tsx scripts/test-tus-live.mjs
 *        BASE=https://passchi.ir  (پیش‌فرض؛ برای دورزدنِ CDN عوضش کن)
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import { createSessionToken } from "../src/web/auth.js";
import { db } from "../src/db/index.js";
import { config } from "../src/config.js";
import { run, FFMPEG } from "../src/audio/ffmpeg.js";

const BASE = process.env.BASE ?? "https://passchi.ir";
const U = new URL(BASE);
const mod = U.protocol === "https:" ? https : http;

let bad = 0;
function ok(label, cond, detail) {
  if (!cond) bad++;
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond && detail) console.log(`   ${detail}`);
}

// ─── ابزارِ HTTP ────────────────────────────────────────────────────────────

/**
 * یک درخواست. `killAfter` یعنی بعد از این تعداد بایت سوکت را عمداً بکش —
 * همان کاری که وب‌ویوی بله وسطِ آپلود با ما می‌کند.
 */
function req(method, pathname, { headers = {}, body = null, killAfter = null } = {}) {
  return new Promise((resolve, reject) => {
    const agent = new (U.protocol === "https:" ? https.Agent : http.Agent)({ keepAlive: false });
    const r = mod.request(
      {
        method,
        hostname: U.hostname,
        port: U.port || (U.protocol === "https:" ? 443 : 80),
        path: pathname,
        agent,
        headers,
        rejectUnauthorized: false,
        timeout: 120_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          agent.destroy();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", (e) => {
      agent.destroy();
      // قطعِ عمدی خطا نیست، خودِ آزمون است
      if (killAfter !== null) resolve({ killed: true, err: e.message });
      else reject(e);
    });

    if (body && killAfter !== null) {
      // تا `killAfter` بفرست، بعد وسطِ کار سوکت را بکش
      r.write(body.subarray(0, killAfter));
      setTimeout(() => r.destroy(new Error("قطعِ عمدی")), 300);
    } else if (body) {
      r.end(body);
    } else {
      r.end();
    }
  });
}

const TUS = { "Tus-Resumable": "1.0.0" };
const meta = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k} ${Buffer.from(String(v), "utf8").toString("base64")}`)
    .join(",");

// ─── آماده‌سازی ─────────────────────────────────────────────────────────────

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tus-live-"));
const AUDIO = path.join(dir, "clip.mp3");
const WANT_SEC = 35;

// صوتِ واقعی لازم است: سرور مدت را با ffprobe می‌سنجد، نه از ادعای کلاینت.
{
  const r = await run(FFMPEG, [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `sine=f=440:d=${WANT_SEC}`,
    "-ac", "1", "-b:a", "128k", AUDIO,
  ]);
  if (r.code !== 0) {
    console.log("ساختِ صوتِ آزمون شکست:", r.stderr.slice(-500));
    process.exit(1);
  }
}
const FILE = await fsp.readFile(AUDIO);
const SIZE = FILE.length;

// دو کاربرِ آزمون: یکی پولدار، یکی ته‌کشیده (برای پرچمِ `enough`).
const RICH = 999004001;
const POOR = 999004002;
const made = [];
function mkUser(id, creditSec) {
  db.prepare(`INSERT OR REPLACE INTO users (tg_id, credit_sec) VALUES (?, ?)`).run(id, creditSec);
  const t = createSessionToken(id, "telegram");
  made.push(id);
  return t;
}
const richTok = mkUser(RICH, 999_999);
const poorTok = mkUser(POOR, 5); // ۵ ثانیه اعتبار، خیلی کمتر از ۳۵ ثانیه
const auth = (t) => ({ Authorization: `Bearer ${t}` });

console.log(`مقصد: ${BASE}   فایل: ${(SIZE / 1024).toFixed(0)}KB / ${WANT_SEC}s\n`);

const createdSessions = [];

// ─── ۱) OPTIONS: preflight باید PATCH و Authorization را اجازه دهد ──────────
{
  const r = await req("OPTIONS", "/api/tus", {
    headers: {
      Origin: "https://web.bale.ai",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization,tus-resumable,upload-offset",
    },
  });
  ok("OPTIONS پاسخ می‌دهد", r.status === 204 || r.status === 200, `status ${r.status}`);
  const allowM = String(r.headers["access-control-allow-methods"] ?? "");
  const allowH = String(r.headers["access-control-allow-headers"] ?? "").toLowerCase();
  ok("preflight متدِ PATCH را اجازه می‌دهد", /PATCH/i.test(allowM), allowM || "(هدر نیامد)");
  /**
   * بی این، مرورگر توکن را در PATCH **نمی‌فرستد** و مینی‌اپِ بله که داخلِ
   * iframe است اصلاً نمی‌تواند آپلود کند — و چون preflight بی‌صدا رد می‌شود،
   * در لاگِ سرور هیچ ردی از آپلودِ ناموفق نمی‌ماند.
   */
  ok("و هدرِ Authorization را اجازه می‌دهد", allowH.includes("authorization"), allowH || "(هدر نیامد)");
  ok("نسخهٔ tus اعلام می‌شود", Boolean(r.headers["tus-version"] || r.headers["tus-resumable"]));
}

// ─── ۲) دروازهٔ احراز هویت ──────────────────────────────────────────────────
{
  const noTok = await req("POST", "/api/tus", {
    headers: { ...TUS, "Upload-Length": String(SIZE) },
  });
  ok("POST بدونِ توکن رد می‌شود", noTok.status === 401, `status ${noTok.status}`);

  const badTok = await req("POST", "/api/tus", {
    headers: { ...TUS, ...auth("not-a-real-token"), "Upload-Length": String(SIZE) },
  });
  ok("POST با توکنِ جعلی رد می‌شود", badTok.status === 401, `status ${badTok.status}`);
  ok(
    "و پیامِ خطا فارسیِ قابل‌فهم است",
    /نشست|منقضی|وارد/.test(badTok.body),
    badTok.body.slice(0, 120),
  );
}

// ─── ۳) ساختِ آپلود: Location باید نسبی باشد ────────────────────────────────
let loc;
{
  const r = await req("POST", "/api/tus", {
    headers: {
      ...TUS,
      ...auth(richTok),
      "Upload-Length": String(SIZE),
      "Upload-Metadata": meta({ ext: "mp3", duration: String(WANT_SEC), filename: "clip.mp3" }),
    },
  });
  ok("POST آپلود می‌سازد", r.status === 201, `status ${r.status} — ${r.body.slice(0, 200)}`);
  loc = r.headers.location;
  ok("Location داده شد", Boolean(loc), String(loc));

  /**
   * **دامِ تونل.** پشتِ NSIN مبدأ درخواست را `http` می‌بیند؛ آدرسِ مطلق یعنی
   * `http://passchi.ir/api/tus/<id>` که کلاینتِ https رویش ریدایرکت می‌خورد و
   * **بدنهٔ PATCH وسطِ ریدایرکت می‌پرد**. نسبی این را از ریشه حذف می‌کند.
   */
  ok(
    "Location نسبی است نه مطلق (وگرنه PATCH به ریدایرکت می‌خورد)",
    typeof loc === "string" && loc.startsWith("/api/tus/"),
    String(loc),
  );
}

// ─── ۴) HEAD روی آپلودِ تازه ────────────────────────────────────────────────
{
  const r = await req("HEAD", loc, { headers: { ...TUS, ...auth(richTok) } });
  ok("HEAD پاسخ می‌دهد", r.status === 200, `status ${r.status}`);
  ok("و offset صفر است", r.headers["upload-offset"] === "0", String(r.headers["upload-offset"]));
  ok(
    "و طولِ اعلام‌شده درست است",
    r.headers["upload-length"] === String(SIZE),
    `${r.headers["upload-length"]} به‌جای ${SIZE}`,
  );
}

// ─── ۵) قطعِ وسطِ PATCH، بعد ازسرگیری — قلبِ ماجرا ─────────────────────────
{
  const half = Math.floor(SIZE / 2);
  const killed = await req("PATCH", loc, {
    headers: {
      ...TUS,
      ...auth(richTok),
      "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
      "Content-Length": String(half),
    },
    body: FILE.subarray(0, half),
    killAfter: Math.floor(half / 3),
  });
  ok("PATCH وسطِ راه قطع شد (شبیه‌سازیِ وب‌ویو)", killed.killed === true || killed.status >= 400);

  const h = await req("HEAD", loc, { headers: { ...TUS, ...auth(richTok) } });
  const landed = Number(h.headers["upload-offset"] ?? -1);
  ok("HEAD بعد از قطعی می‌گوید تا کجا رسیده", landed >= 0, String(h.headers["upload-offset"]));

  /**
   * ادعای اصلی: آنچه پیش از قطعی رسیده باید **بماند**. اگر روزی این صفر شود،
   * یعنی برگشته‌ایم به همان «از اول شروع کن» که روی اینترنتِ موبایلِ ایران چند
   * ده مگابایت را بی‌نتیجه می‌سوزاند.
   */
  ok("و آنچه رسیده بود از بین نرفت", landed > 0, `offset = ${landed}`);
  ok("و از کلِ فایل بیشتر نیست", landed < SIZE, `${landed} از ${SIZE}`);

  // از همان‌جا ادامه بده، در دو تکه، تا چندتکه‌بودن هم سنجیده شود
  let off = landed;
  const STEP = Math.max(1, Math.ceil((SIZE - off) / 2));
  let lastRes = null;
  while (off < SIZE) {
    const end = Math.min(off + STEP, SIZE);
    const slice = FILE.subarray(off, end);
    lastRes = await req("PATCH", loc, {
      headers: {
        ...TUS,
        ...auth(richTok),
        "Upload-Offset": String(off),
        "Content-Type": "application/offset+octet-stream",
        "Content-Length": String(slice.length),
      },
      body: slice,
    });
    if (end < SIZE) {
      ok(
        `تکهٔ میانی (${off}→${end}) پذیرفته شد`,
        lastRes.status === 204,
        `status ${lastRes.status} — ${lastRes.body.slice(0, 200)}`,
      );
      ok(
        "و offset جلو رفت",
        lastRes.headers["upload-offset"] === String(end),
        `${lastRes.headers["upload-offset"]} به‌جای ${end}`,
      );
    }
    off = end;
  }

  // ─── ۶) پاسخِ نهایی باید بدنهٔ JSON داشته باشد ────────────────────────────
  ok("PATCHِ نهایی ۲۰۰ می‌دهد نه ۲۰۴", lastRes.status === 200, `status ${lastRes.status}`);
  let payload = {};
  try {
    payload = JSON.parse(lastRes.body || "{}");
  } catch {
    /* پایین قرمز می‌شود */
  }
  /**
   * `app.js` روی همین بدنه حساب می‌کند؛ نبودش یعنی کاربر «آپلود کامل شد ولی
   * پاسخی نگرفتیم» می‌گیرد در حالی که فایلش سالم روی دیسک است.
   */
  ok("و بدنهٔ JSON دارد", Boolean(payload.sessionId), lastRes.body.slice(0, 200));
  if (payload.sessionId) createdSessions.push(payload.sessionId);

  /**
   * مدت باید از **ffprobe** بیاید نه از `duration`ی که کلاینت ادعا کرده —
   * `duration`ِ مرورگر روی فایلِ کامل‌بافرنشده صفر یا غلط است و قیمت روی این
   * عدد بسته می‌شود.
   */
  ok(
    "مدت از ffprobe درآمده و درست است",
    Math.abs((payload.durationSec ?? 0) - WANT_SEC) <= 1,
    `${payload.durationSec} به‌جای ~${WANT_SEC}`,
  );
  ok("قیمت برگشت", typeof payload.costCoins === "number" && payload.costCoins > 0, String(payload.costCoins));
  ok("موجودی برگشت", typeof payload.haveCoins === "number", String(payload.haveCoins));
  ok("و کاربرِ پولدار اعتبارِ کافی دارد", payload.enough === true, String(payload.enough));

  // ─── ۷) جلسه واقعاً ساخته شد و فایل سرِ جایش است ──────────────────────────
  const s = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(payload.sessionId);
  ok("جلسه در پایگاه‌داده ساخته شد", Boolean(s), payload.sessionId);
  if (s) {
    ok("و مالکش همان کاربر است", s.tg_id === RICH, `tg_id = ${s.tg_id}`);
    ok("و در حالتِ صف است (سکه‌ای کم نشده)", s.status === "queued", String(s.status));
    ok("و فایلِ صوت روی دیسک است", Boolean(s.original_file) && fs.existsSync(s.original_file), String(s.original_file));
    if (s.original_file && fs.existsSync(s.original_file)) {
      /**
       * اندازه مدرکِ سلامت نیست ولی **نابرابری** مدرکِ خرابی است: فایلی که
       * چند بایت کم دارد یعنی جایی از مسیرِ تکه‌ها بایت گم کرده.
       */
      ok(
        "و بایت‌به‌بایت همان فایلِ فرستاده‌شده است",
        fs.readFileSync(s.original_file).equals(FILE),
        `${fs.statSync(s.original_file).size} به‌جای ${SIZE}`,
      );
    }
  }

  // ─── ۸) پاک‌سازیِ سایدکار و پوشهٔ کارِ tus ─────────────────────────────────
  const id = loc.split("/").pop();
  const tusDir = path.join(config.workDir, "tus");
  ok(
    "فایلِ دادهٔ tus از پوشهٔ کار بیرون رفت",
    !fs.existsSync(path.join(tusDir, id)),
    path.join(tusDir, id),
  );
  /**
   * FileStore کنارِ هر آپلود یک `<id>.json` می‌گذارد. `finalize` فقط فایلِ داده
   * را `rename` می‌کند، پس بی پاک‌سازیِ صریح این سایدکارها تلنبار می‌شوند.
   */
  ok(
    "و سایدکارِ متادیتا هم پاک شد",
    !fs.existsSync(path.join(tusDir, `${id}.json`)),
    path.join(tusDir, `${id}.json`),
  );

  // ─── ۹) HEAD روی آپلودِ تمام‌شده دیگر پیدا نمی‌شود ────────────────────────
  const gone = await req("HEAD", loc, { headers: { ...TUS, ...auth(richTok) } });
  ok("HEAD روی آپلودِ بسته‌شده ۴۰۴ می‌دهد", gone.status === 404, `status ${gone.status}`);
}

// ─── ۱۰) کاربرِ بی‌پول: آپلود می‌شود ولی `enough` دروغ نمی‌گوید ─────────────
{
  const c = await req("POST", "/api/tus", {
    headers: {
      ...TUS,
      ...auth(poorTok),
      "Upload-Length": String(SIZE),
      "Upload-Metadata": meta({ ext: "mp3", duration: String(WANT_SEC) }),
    },
  });
  const l = c.headers.location;
  const r = await req("PATCH", l, {
    headers: {
      ...TUS,
      ...auth(poorTok),
      "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
      "Content-Length": String(SIZE),
    },
    body: FILE,
  });
  let p = {};
  try {
    p = JSON.parse(r.body || "{}");
  } catch {
    /* پایین قرمز می‌شود */
  }
  if (p.sessionId) createdSessions.push(p.sessionId);
  ok("کاربرِ بی‌اعتبار هم آپلودش تمام می‌شود", r.status === 200 && Boolean(p.sessionId), `status ${r.status}`);
  /**
   * سکه اینجا کم نمی‌شود (آن کارِ `confirm` است)، ولی `enough` باید **راست**
   * بگوید وگرنه کلاینت صفحهٔ تأیید را نشان می‌دهد و کاربر ته خط می‌فهمد.
   */
  ok("ولی `enough` نادرست برمی‌گردد", p.enough === false, String(p.enough));
  ok("و قیمت بیشتر از موجودی است", (p.costCoins ?? 0) > (p.haveCoins ?? 0), `${p.costCoins} > ${p.haveCoins}`);
}

// ─── ۱۱) فایلی که صوت نیست باید رد شود، نه اینکه جلسه بسازد ────────────────
{
  const junk = Buffer.alloc(4096, 0x41);
  const c = await req("POST", "/api/tus", {
    headers: { ...TUS, ...auth(richTok), "Upload-Length": String(junk.length), "Upload-Metadata": meta({ ext: "mp3" }) },
  });
  const r = await req("PATCH", c.headers.location, {
    headers: {
      ...TUS,
      ...auth(richTok),
      "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
      "Content-Length": String(junk.length),
    },
    body: junk,
  });
  ok("فایلِ غیرصوتی رد می‌شود", r.status === 400, `status ${r.status} — ${r.body.slice(0, 150)}`);
  ok("و دلیلش گفته می‌شود", /مدت|صوتی/.test(r.body), r.body.slice(0, 150));
  let p = {};
  try {
    p = JSON.parse(r.body || "{}");
  } catch {
    /* ok */
  }
  ok("و جلسه‌ای ساخته نمی‌شود", !p.sessionId, String(p.sessionId));
}

// ─── ۱۲) سقفِ اندازه پیش از فرستادنِ بایت گرفته می‌شود ─────────────────────
{
  const huge = 600 * 1024 * 1024; // بالاتر از MAX_UPLOAD_BYTES = ۵۰۰ مگابایت
  const r = await req("POST", "/api/tus", {
    headers: { ...TUS, ...auth(richTok), "Upload-Length": String(huge) },
  });
  /**
   * ۴۱۳ روی خودِ POST یعنی کاربر **پیش از** مصرفِ یک بایت از اینترنتِ موبایلش
   * جواب می‌گیرد؛ اگر اینجا ۲۰۱ بدهد، نیم‌گیگابایت می‌رود و بعد رد می‌شود.
   */
  ok("فایلِ بزرگ‌تر از سقف همان اول رد می‌شود", r.status === 413, `status ${r.status}`);
}

// ─── ۱۳) آپلودِ کاربرِ دیگر باید کاملاً بسته باشد ──────────────────────────
//
// **این بخش یک رخنهٔ واقعی را گرفت (۲۰۲۶-۰۹-۰۳).** توکنِ معتبر کافی بود:
// کاربر B تکهٔ آخرِ آپلودِ نیمه‌کارهٔ کاربر A را فرستاد، و جلسه — با صوتِ A —
// به نامِ **B** ساخته شد (`durationSec: 30`, `sessionId` در پاسخِ خودِ B).
// یعنی ضبطِ کلاسِ یک نفر، با رونوشت و جزوه‌اش، به حسابِ دیگری می‌نشست.
// `DELETE` هم باز بود: هر کسی می‌توانست آپلودِ در جریانِ دیگری را نابود کند.
{
  const half = Math.floor(SIZE / 2);

  const c = await req("POST", "/api/tus", {
    headers: {
      ...TUS,
      ...auth(richTok),
      "Upload-Length": String(SIZE),
      "Upload-Metadata": meta({ ext: "mp3", duration: String(WANT_SEC) }),
    },
  });
  const victim = c.headers.location;
  await req("PATCH", victim, {
    headers: {
      ...TUS,
      ...auth(richTok),
      "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
      "Content-Length": String(half),
    },
    body: FILE.subarray(0, half),
  });

  // کاربرِ بی‌پول در بخشِ ۱۰ یک جلسهٔ **قانونی** ساخته؛ معیار «تازه اضافه
  // نشدن» است نه «صفر بودن».
  const before = db.prepare(`SELECT count(*) c FROM sessions WHERE tg_id = ?`).get(POOR).c;

  const peek = await req("HEAD", victim, { headers: { ...TUS, ...auth(poorTok) } });
  ok("کاربرِ دیگر offsetِ آپلودِ این یکی را نمی‌بیند", peek.status === 404, `status ${peek.status}`);

  /**
   * جدی‌ترینِ سه‌تا: تمام‌کردنِ آپلودِ دیگری. اگر این سبز نباشد، صوتِ قربانی
   * با شناسهٔ جلسهٔ مهاجم برمی‌گردد.
   */
  const steal = await req("PATCH", victim, {
    headers: {
      ...TUS,
      ...auth(poorTok),
      "Upload-Offset": String(half),
      "Content-Type": "application/offset+octet-stream",
      "Content-Length": String(SIZE - half),
    },
    body: FILE.subarray(half),
  });
  ok("و نمی‌تواند آپلودش را تمام کند", steal.status === 404, `status ${steal.status}`);
  let sp = {};
  try {
    sp = JSON.parse(steal.body || "{}");
  } catch {
    /* بدنهٔ غیرJSON یعنی رد شده — همان که می‌خواهیم */
  }
  if (sp.sessionId) createdSessions.push(sp.sessionId);
  ok("و جلسه‌ای به نامِ او ساخته نمی‌شود", !sp.sessionId, `sessionId = ${sp.sessionId}`);

  const after = db.prepare(`SELECT count(*) c FROM sessions WHERE tg_id = ?`).get(POOR).c;
  ok("و در پایگاه‌داده هم جلسه‌ای به نامش اضافه نشد", after === before, `${before} → ${after}`);

  // نابودکردنِ آپلودِ دیگری هم باید بسته باشد
  const nuke = await req("DELETE", victim, { headers: { ...TUS, ...auth(poorTok) } });
  ok("و نمی‌تواند آپلودش را حذف کند", nuke.status === 404, `status ${nuke.status}`);

  const alive = await req("HEAD", victim, { headers: { ...TUS, ...auth(richTok) } });
  ok(
    "و آپلودِ قربانی پس از این حمله هنوز سرِ جایش است",
    alive.status === 200 && Number(alive.headers["upload-offset"]) === half,
    `status ${alive.status}, offset ${alive.headers["upload-offset"]}`,
  );

  // مالکِ واقعی همچنان می‌تواند کارش را بکند
  const own = await req("DELETE", victim, { headers: { ...TUS, ...auth(richTok) } });
  ok("ولی مالکِ واقعی می‌تواند", own.status === 204, `status ${own.status}`);
}

// ─── ۱۴) با خودِ کتابخانهٔ کلاینت، همان‌طور که `app.js` صدایش می‌زند ────────
//
// بالا HTTPِ خام بود؛ اینجا `tus-js-client` واقعی است — همان چیزی که مرورگر
// اجرا می‌کند. **چرا لازم است:** قراردادی که `app.js` رویش حساب می‌کند
// «`JSON.parse(payload.lastResponse.getBody()).sessionId`» است، و آن قرارداد
// از دو طرف می‌تواند بشکند: سرور بدنه ندهد، یا کتابخانه بدنهٔ PATCHِ نهایی را
// دور بیندازد. هیچ آزمونِ سمتِ سروری این را نمی‌گیرد.
{
  const tus = await import("tus-js-client");
  const CHUNK = 128 * 1024; // کوچک، تا حتماً چندتکه شود
  const out = await new Promise((resolve) => {
    const up = new tus.Upload(FILE, {
      endpoint: `${BASE}/api/tus`,
      chunkSize: CHUNK,
      uploadSize: SIZE,
      metadata: { ext: "mp3", duration: String(WANT_SEC), filename: "clip.mp3" },
      headers: { Authorization: `Bearer ${richTok}` },
      retryDelays: [0, 1000, 3000],
      onError: (err) => resolve({ error: err.message }),
      onSuccess: (payload) => {
        // عیناً همان چند خطی که در `uploadViaTus` هست
        let data = {};
        try {
          data = JSON.parse(payload.lastResponse.getBody() || "{}");
        } catch {
          /* پایین قرمز می‌شود */
        }
        resolve({ data });
      },
    });
    up.start();
  });

  ok("آپلود با کتابخانهٔ واقعیِ کلاینت تمام شد", !out.error, out.error);
  const d = out.data ?? {};
  if (d.sessionId) createdSessions.push(d.sessionId);
  /**
   * اگر این قرمز شود، کاربر دقیقاً پیامِ «آپلود کامل شد ولی پاسخی نگرفتیم» را
   * می‌گیرد در حالی که فایلش سالم روی دیسک نشسته — همان بن‌بستی که یک بار
   * روی مسیرِ دست‌ساز افتاد.
   */
  ok("و کلاینت `sessionId` را از بدنهٔ پاسخِ آخر می‌خواند", Boolean(d.sessionId), JSON.stringify(d));
  ok(
    "و مدتِ همان فایل را می‌گیرد",
    Math.abs((d.durationSec ?? 0) - WANT_SEC) <= 1,
    `${d.durationSec} به‌جای ~${WANT_SEC}`,
  );
  if (d.sessionId) {
    const s = db.prepare(`SELECT tg_id FROM sessions WHERE id = ?`).get(d.sessionId);
    ok("و جلسه به نامِ همان کاربر ثبت شد", s?.tg_id === RICH, `tg_id = ${s?.tg_id}`);
  }
}

// ─── پاک‌سازی ───────────────────────────────────────────────────────────────
for (const sid of createdSessions) {
  const s = db.prepare(`SELECT original_file FROM sessions WHERE id = ?`).get(sid);
  if (s?.original_file) await fsp.unlink(s.original_file).catch(() => {});
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
}
for (const id of made) {
  db.prepare(`DELETE FROM web_sessions WHERE user_id = ?`).run(id);
  db.prepare(`DELETE FROM sessions WHERE tg_id = ?`).run(id);
  db.prepare(`DELETE FROM users WHERE tg_id = ?`).run(id);
}
fs.rmSync(dir, { recursive: true, force: true });

console.log(bad === 0 ? "\n🎉 همه سبز" : `\n💥 ${bad} مورد قرمز`);
process.exit(bad === 0 ? 0 : 1);
