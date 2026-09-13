/**
 * اولین صوتِ رایگان — دروازه‌ها، سقف‌ها، و دفتر.
 *
 * ۱) حسابِ تازه پیشنهادِ ۱۲۰ دقیقه می‌گیرد؛ گرفتن سکه‌اش را با سطرِ `free_file` واریز می‌کند.
 * ۲) همان حساب بار دوم رد می‌شود.
 * ۳) همان **محتوای** صوت با حسابِ دیگر رد می‌شود و سکه‌ای نمی‌گیرد.
 * ۴) فایلِ بلندتر فقط تا سقف؛ فایلِ خیلی کوتاه دست‌کم یک دقیقه (کفِ رزرو).
 * ۵) سقفِ هفتگی پر ⇒ پیشنهاد ۳۰ دقیقه، نه خاموش؛ ردیف‌های قدیمی‌تر از هفته شمرده نمی‌شوند.
 * ۶) پرچمِ خاموش ⇒ نه پیشنهاد نه گرفتن.
 * ۷) صفحهٔ فایلِ اول: رایگان بالا، بی خرید گروهی.
 * ۸) دفتر با موجودی می‌خواند.
 *
 * اجرا: DATA_DIR=./data/tmp-free node --import tsx scripts/test-free-file.mjs
 */
process.env.BOT_TOKEN ||= "111:aaa";
process.env.FREE_FIRST_FILE = "true";
process.env.FREE_FIRST_FILE_PER_WEEK = "3";
process.env.FREE_FIRST_FILE_MAX_MIN = "120";
process.env.FREE_FALLBACK_MIN = "30";
process.env.GROUP_BUY = "true";

const { db, upsertUser, getUser } = await import("../src/db/index.ts");
const { claimFreeFile, freeFileOffer } = await import("../src/billing/free-file.ts");
const { config } = await import("../src/config.ts");
const S = await import("../src/bot/strings.ts");
const { firstFileKeyboard } = await import("../src/bot/index.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

let next = 7_700_000;
const user = () => {
  const id = ++next;
  upsertUser(id, `f${id}`, null);
  return id;
};
const bal = (id) => getUser(id).credit_sec;
const rows = (id) => db.prepare(`SELECT * FROM credit_ledger WHERE tg_id = ? AND reason = 'free_file'`).all(id);

// ─── ۱ و ۲) یک بار برای هر حساب ──────────────────────────────────────────────
const A = user();
check("حسابِ تازه پیشنهادِ ۱۲۰ دقیقه‌ای می‌گیرد", JSON.stringify(freeFileOffer(A)) === '{"minutes":120,"fallback":false}', JSON.stringify(freeFileOffer(A)));
let c = claimFreeFile({ tgId: A, sessionId: "s-a1", fingerprint: "fpA", durationSec: 5400 });
check("فایلِ ۹۰ دقیقه‌ای کامل رایگان شد", c.ok && c.grantedSec === 5400, JSON.stringify(c));
check("همان‌قدر سکه به حساب آمد", bal(A) === 5400, String(bal(A)));
check("با سطرِ free_file و شناسهٔ جلسه", rows(A).length === 1 && rows(A)[0].session_id === "s-a1");
check("دیگر پیشنهادی ندارد", freeFileOffer(A) === null);
c = claimFreeFile({ tgId: A, sessionId: "s-a2", fingerprint: "fpA2", durationSec: 600 });
check("بار دوم رد می‌شود: used", !c.ok && c.reason === "used", JSON.stringify(c));
check("و سکه‌ای اضافه نشد", bal(A) === 5400 && rows(A).length === 1);

// ─── ۳) یک صوت، یک بار ───────────────────────────────────────────────────────
const B = user();
c = claimFreeFile({ tgId: B, sessionId: "s-b1", fingerprint: "fpA", durationSec: 5400 });
check("همان صوت با حسابِ دیگر رد می‌شود: audio_used", !c.ok && c.reason === "audio_used", JSON.stringify(c));
check("حسابِ دوم سکه‌ای نگرفت", bal(B) === 0 && rows(B).length === 0);
check("ولی رایگانش هنوز برای صوتِ خودش باز است", freeFileOffer(B) !== null);

// ─── ۴) سقف و کف ────────────────────────────────────────────────────────────
const C = user();
c = claimFreeFile({ tgId: C, sessionId: "s-c1", fingerprint: "fpC", durationSec: 150 * 60 });
check("فایلِ ۱۵۰ دقیقه‌ای فقط تا ۱۲۰ دقیقه", c.ok && c.grantedSec === 7200, JSON.stringify(c));
const D = user();
c = claimFreeFile({ tgId: D, sessionId: "s-d1", fingerprint: "fpD", durationSec: 20 });
check("فایلِ ۲۰ ثانیه‌ای یک دقیقه می‌گیرد (کفِ رزرو)", c.ok && c.grantedSec === 60, JSON.stringify(c));

// ─── ۵) سقفِ هفتگی ───────────────────────────────────────────────────────────
// تا اینجا سه رایگان (A، C، D) — سقفِ آزمون سه است.
const E = user();
check("سقف پر ⇒ پیشنهادِ ۳۰ دقیقه، نه خاموش", JSON.stringify(freeFileOffer(E)) === '{"minutes":30,"fallback":true}', JSON.stringify(freeFileOffer(E)));
c = claimFreeFile({ tgId: E, sessionId: "s-e1", fingerprint: "fpE", durationSec: 5400 });
check("و گرفتنش فقط ۳۰ دقیقه واریز می‌کند", c.ok && c.grantedSec === 1800 && c.fallback, JSON.stringify(c));
db.prepare(`UPDATE free_files SET created_at = datetime('now', '-8 days')`).run();
const F = user();
check("رایگان‌های قدیمی‌تر از یک هفته شمرده نمی‌شوند", JSON.stringify(freeFileOffer(F)) === '{"minutes":120,"fallback":false}', JSON.stringify(freeFileOffer(F)));

// ─── ۶) پرچم ─────────────────────────────────────────────────────────────────
config.FREE_FIRST_FILE = false;
check("پرچمِ خاموش ⇒ پیشنهادی نیست", freeFileOffer(F) === null);
c = claimFreeFile({ tgId: F, sessionId: "s-f1", fingerprint: "fpF", durationSec: 600 });
check("پرچمِ خاموش ⇒ گرفتن رد می‌شود: off", !c.ok && c.reason === "off" && bal(F) === 0, JSON.stringify(c));
config.FREE_FIRST_FILE = true;

// ─── ۷) صفحهٔ فایلِ اول ──────────────────────────────────────────────────────
{
  const rich = firstFileKeyboard("ab01", true).inline_keyboard;
  const poor = firstFileKeyboard("ab01", false).inline_keyboard;
  const all = [...rich.flat(), ...poor.flat()].map((b) => b.callback_data);
  check("رایگان دکمهٔ اولِ ردیفِ اول است", rich[0][0].callback_data === "ff:ab01" && poor[0][0].callback_data === "ff:ab01");
  check("با سکهٔ کافی: شروع با سکه و بی‌خیال", rich[1].map((b) => b.callback_data).join(" ") === "go:ab01 nogo:ab01", rich[1].map((b) => b.callback_data).join(" "));
  check("بی سکهٔ کافی: پرداخت همین فایل و شارژ", poor[1].map((b) => b.callback_data).join(" ") === "pf:ab01 topup", poor[1].map((b) => b.callback_data).join(" "));
  check("خرید گروهی روی فایلِ اول نیست", !all.some((d) => d.startsWith("gb")), all.join(" "));

  const long = S.firstFileMessage(150 * 60, 0, { minutes: 120 });
  check("پیامِ فایلِ بلند سهمِ پولی را می‌گوید", long.includes("۳۰ سکه") && long.includes("بقیه"), long);
  const short = S.firstFileMessage(60 * 60, 0, { minutes: 120 });
  check("پیامِ فایلِ کوتاه‌تر از سقف چیزی از پول نمی‌گوید", !short.includes("بقیه"));
  check("پیام می‌گوید یک بار برای هر حساب", short.includes("فقط یه باره"));
  check("پیامِ فال‌بک می‌گوید چرا کوتاه‌تر است", S.freeFileGrantedMessage(1800, true).includes("این هفته"));
}

// ─── ۹) از دکمه تا دفتر، روی رباتِ جعلی ─────────────────────────────────────
//
// فایلِ ۱۵۰ دقیقه‌ای و حسابِ بی‌سکه: رایگان ۱۲۰ دقیقه واریز می‌شود و بقیه
// «سکه‌ات کمه» با «پرداخت همین فایل» می‌گیرد — پیش از هر `startJob`، پس خط
// لولهٔ واقعی راه نمی‌افتد.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { bot } = await import("../src/bot/index.ts");
  const { setNotifyApis } = await import("../src/bot/notify.ts");
  const { createSession, updateSession, getSession } = await import("../src/db/index.ts");
  const { resolveIdentity } = await import("../src/db/identity.ts");

  const botInfo = {
    id: 1, is_bot: true, first_name: "passchi", username: "passchi",
    can_join_groups: true, can_read_all_group_messages: false,
    supports_inline_queries: false, can_connect_to_business_account: false, has_main_web_app: false,
  };
  bot.botInfo = botInfo;
  let calls = [];
  let mid = 300;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === "getMe") return { ok: true, result: botInfo };
    if (method.startsWith("answer") || method.startsWith("edit") || method.startsWith("delete")) return { ok: true, result: true };
    return { ok: true, result: { message_id: ++mid, date: 0, chat: { id: payload.chat_id, type: "private" } } };
  });
  setNotifyApis(bot.api, null);
  let uidN = 0;
  const press = async (data, fromId) => {
    calls = [];
    await bot.handleUpdate({
      update_id: ++uidN,
      callback_query: {
        id: String(uidN), from: { id: fromId, is_bot: false, first_name: "u" }, chat_instance: "ci", data,
        message: { message_id: 10, date: 0, chat: { id: fromId, type: "private" }, from: botInfo, text: "…" },
      },
    });
    return calls;
  };
  const texts = (cs) => cs.filter((c) => c.method === "sendMessage").map((c) => c.payload.text).join("\n---\n");
  const btns = (cs) => cs.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat() ?? []).map((b) => b.callback_data);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "passchi-free-"));
  const PID = 77_990_001;
  const G = resolveIdentity({ platform: "telegram", platformUserId: String(PID), name: "تازه" }).tg_id;
  const mk = (sid, min, content) => {
    const f = path.join(tmp, `${sid}.m4a`);
    fs.writeFileSync(f, content);
    createSession(sid, G, null);
    updateSession(sid, { status: "awaiting_credit", original_ms: min * 60_000, original_file: f, mode: "full" });
    return sid;
  };

  const S1 = mk("feed0000feed0001", 150, "audio-G-1");
  let cs = await press(`ff:${S1}`, PID);
  check("دکمهٔ رایگان ۱۲۰ دقیقه واریز کرد", getUser(G).credit_sec === 7200, String(getUser(G).credit_sec));
  check("خبرِ رایگان به دانشجو رسید", texts(cs).includes("رایگان برای همین فایل"), texts(cs));
  check("برای ۳۰ دقیقهٔ بقیه «پرداخت همین فایل» آمد", btns(cs).includes(`pf:${S1}`), btns(cs).join(" "));
  check("خرید گروهی روی فایلِ اول پیشنهاد نشد", !btns(cs).some((d) => d?.startsWith("gb")));
  check("جلسه منتظرِ شارژ ماند و کاری شروع نشد", getSession(S1).status === "awaiting_credit" && !texts(cs).includes("آماده"), getSession(S1).status);

  cs = await press(`ff:${S1}`, PID);
  check("زدنِ دوباره: «قبلاً گرفتی» و سکه‌ای اضافه نشد", texts(cs).includes("قبلاً گرفتی") && getUser(G).credit_sec === 7200, texts(cs));

  const S2 = mk("feed0000feed0002", 10, "audio-G-2");
  updateSession(S2, { status: "done" });
  cs = await press(`ff:${S2}`, PID);
  check("روی فایلی که کارش شروع شده، دکمهٔ رایگان کاری نمی‌کند", cs.some((c) => c.method === "answerCallbackQuery" && c.payload.text?.includes("شروع شده")) && getUser(G).credit_sec === 7200);

  const OTHER = 77_990_002;
  resolveIdentity({ platform: "telegram", platformUserId: String(OTHER), name: "غریبه" });
  cs = await press(`ff:${S1}`, OTHER);
  check("غریبه روی فایلِ دیگری رایگان نمی‌گیرد", cs.some((c) => c.payload?.text?.includes("مال تو نیست")));

  // ─── ۱۰) مینی‌اپ: precheck و confirm با رایگان، روی سرورِ HTTP واقعی ─────────
  //
  // سرور مدت را خودش با ffprobe می‌سنجد، پس صوتِ واقعیِ دودقیقه‌ای ساخته می‌شود
  // و سقفِ رایگان برای همین بخش یک دقیقه: رایگان واریز می‌شود، بقیه کم است و
  // `startJob` پیش از هر پردازشی ۴۰۲ می‌دهد.
  const { spawnSync } = await import("node:child_process");
  const { createWebServer } = await import("../src/web/server.ts");
  const { createSessionToken } = await import("../src/web/auth.ts");
  const { FFMPEG } = await import("../src/audio/ffmpeg.ts");
  const wav = path.join(tmp, "two-min.ogg");
  const ff = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "120", "-c:a", "libopus", "-b:a", "8k", wav]);
  check("صوتِ آزمایشیِ دودقیقه‌ای ساخته شد", ff.status === 0, String(ff.stderr));

  const W = resolveIdentity({ platform: "telegram", platformUserId: "77990003", name: "وب" }).tg_id;
  const token = createSessionToken(W, "telegram");
  const server = createWebServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, tok = token) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    let r = await post("/api/sessions/precheck", { durationSec: 9000 });
    check("precheck برای حسابِ بی‌سکه ولی رایگان‌دار ۴۰۲ نمی‌دهد", r.status === 200 && r.body.freeFile?.minutes === 120, JSON.stringify(r));
    r = await post("/api/sessions/precheck", { durationSec: 9000 }, createSessionToken(G, "telegram"));
    check("precheck برای کسی که رایگانش را گرفته همان ۴۰۲ قدیمی", r.status === 402, JSON.stringify(r));

    config.FREE_FIRST_FILE_MAX_MIN = 1;
    const SW = "feed0000feed0003";
    createSession(SW, W, null);
    updateSession(SW, { status: "queued", original_file: wav, download_route: "web", mode: "full" });
    r = await post(`/api/sessions/${SW}/confirm`, { free: true });
    check("confirm با رایگان: رایگان واریز شد و برای بقیه ۴۰۲", r.status === 402 && getUser(W).credit_sec === 60, `${JSON.stringify(r)} · ${getUser(W).credit_sec}`);
    check("ردیفِ رایگان برای همین جلسه ثبت شد", db.prepare(`SELECT session_id FROM free_files WHERE tg_id = ?`).get(W)?.session_id === SW);
    r = await post(`/api/sessions/${SW}/confirm`, { free: true });
    check("confirm دوباره با رایگان: ۴۰۹ با دلیلِ used، بی واریزِ دوباره", r.status === 409 && r.body.freeRefused === "used" && getUser(W).credit_sec === 60, JSON.stringify(r));
  } finally {
    config.FREE_FIRST_FILE_MAX_MIN = 120;
    await new Promise((ok) => server.close(ok));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── ۸) دفتر با موجودی ──────────────────────────────────────────────────────
{
  const drift = db
    .prepare(
      `SELECT u.tg_id, u.credit_sec, COALESCE(SUM(l.delta_sec), 0) AS sum
         FROM users u LEFT JOIN credit_ledger l ON l.tg_id = u.tg_id
        WHERE u.tg_id > 7700000 GROUP BY u.tg_id HAVING u.credit_sec != sum`,
    )
    .all();
  check("جمعِ دفتر برای هر حساب با موجودی می‌خواند", drift.length === 0, JSON.stringify(drift));
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
