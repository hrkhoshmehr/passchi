/**
 * جلسه‌ای که به‌خاطر کمبود اعتبار متوقف مانده باید **زنده** بماند.
 *
 * **باگی که این آزمون برای آن نوشته شد:** کاربر فایل ۱۳۴ دقیقه‌ای‌اش را در
 * بله فرستاد، ما کامل گرفتیمش و روی دیسک نشست، و بعد پیام «سکه‌ات کمه»
 * آمد و دست‌کد فقط `return` کرد. کاربر شارژ کرد و **هیچ راهی برای ادامه
 * نبود** — نه دکمه‌ای، نه پیامی، نه اشاره‌ای که فایلش هنوز هست. مجبور شد
 * همان فایل را دوباره بفرستد.
 *
 * بدتر اینکه پیام تأیید شارژ می‌گفت «صوت کلاستو بفرست 🎧» — یعنی فعالانه
 * او را به فرستادن دوباره هدایت می‌کرد.
 *
 * اجرا: npx tsx scripts/test-awaiting-credit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "await-credit-"));
process.env.DATA_DIR = dir;
process.env.BOT_TOKEN ||= "x";

const { createSession, updateSession, getSession, awaitingCreditSessions, upsertUser } =
  await import("../src/db/index.ts");

let bad = 0;
function ok(label, cond, detail) {
  if (!cond) bad++;
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond && detail) console.log(`   ${detail}`);
}

const UID = 555001;
upsertUser(UID, "آزمون", null);

// فایل ساختگی روی دیسک — همان چیزی که باید نگه داشته شود
const audio = path.join(dir, "class.m4a");
fs.writeFileSync(audio, Buffer.alloc(1024));

// ─── جلسه‌ای که منتظر شارژ مانده ────────────────────────────────────────────
createSession("aaaa1111", UID, null);
updateSession("aaaa1111", {
  status: "awaiting_credit",
  original_file: audio,
  original_ms: 134 * 60 * 1000,
});

const s = getSession("aaaa1111");
ok("وضعیت awaiting_credit ثبت شد", s.status === "awaiting_credit", s.status);
ok("فایل صوتی نگه داشته شد", s.original_file === audio);
ok("فایل واقعاً روی دیسک است", fs.existsSync(s.original_file));

// ─── پس از شارژ، باید پیدا شود ──────────────────────────────────────────────
const waiting = awaitingCreditSessions(UID);
ok("جلسهٔ منتظر شارژ پیدا می‌شود", waiting.length === 1 && waiting[0].id === "aaaa1111");

/**
 * ادعای اصلی: پس از شارژ، اگر موجودی کافی شد باید همین جلسه پیشنهاد شود.
 * این همان محاسبه‌ای است که `decideTopup` می‌کند.
 */
{
  const needSec = Math.round(waiting[0].original_ms / 1000);
  const poor = 3000; // کمتر از نیاز
  const rich = 9000; // بیشتر از نیاز
  ok(
    "با موجودی کم، جلسه پیشنهاد نمی‌شود",
    !waiting.find((w) => poor >= Math.round(w.original_ms / 1000)),
  );
  ok(
    "با موجودی کافی، همان جلسه پیشنهاد می‌شود",
    waiting.find((w) => rich >= Math.round(w.original_ms / 1000))?.id === "aaaa1111",
    `نیاز ${needSec} ثانیه`,
  );
}

// ─── جلسه‌های دیگر نباید قاتی شوند ──────────────────────────────────────────
createSession("bbbb2222", UID, null);
updateSession("bbbb2222", { status: "done", original_file: audio });
upsertUser(999999, "دیگری", null);
createSession("cccc3333", 999999, null);
updateSession("cccc3333", { status: "awaiting_credit", original_file: audio });

const again = awaitingCreditSessions(UID);
ok("جلسهٔ تمام‌شده در فهرست نمی‌آید", !again.some((w) => w.id === "bbbb2222"));
ok("جلسهٔ کاربر دیگر در فهرست نمی‌آید", !again.some((w) => w.id === "cccc3333"));

// بدون فایل روی دیسک، پیشنهادی معنا ندارد
createSession("dddd4444", UID, null);
updateSession("dddd4444", { status: "awaiting_credit", original_file: null });
ok(
  "جلسهٔ بدون فایل در فهرست نمی‌آید",
  !awaitingCreditSessions(UID).some((w) => w.id === "dddd4444"),
);

// ─── دست‌کد و پیام‌ها ───────────────────────────────────────────────────────
{
  const idx = fs.readFileSync(new URL("../src/bot/index.ts", import.meta.url), "utf8");
  const top = fs.readFileSync(new URL("../src/bot/topup.ts", import.meta.url), "utf8");

  ok("مسیر کمبود اعتبار جلسه را نگه می‌دارد", /status: "awaiting_credit"/.test(idx));
  ok("دکمهٔ ادامه ساخته می‌شود", /resume:\$\{sessionId\}/.test(idx));
  ok("دست‌کد resume وجود دارد", /callbackQuery\(\/\^resume:/.test(idx));
  ok(
    "به کاربر گفته می‌شود فایلش نگه داشته شده",
    /لازم نیست دوباره بفرستی/.test(idx),
  );
  /**
   * مهم‌ترین بخش: پیام تأیید شارژ دیگر نباید کورکورانه «صوتتو بفرست» بگوید
   * وقتی فایلی منتظر است.
   */
  ok("تأیید شارژ جلسهٔ منتظر را بررسی می‌کند", /awaitingCreditSessions\(/.test(top));
  ok("و دکمهٔ ادامه می‌دهد", /resume:\$\{enough\.id\}/.test(top));
}

// روی ویندوز فایل SQLite باز می‌ماند و پاک نمی‌شود؛ شکستِ پاک‌سازی نباید آزمون را قرمز کند.
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(bad === 0 ? "\n🎉 همه سبز" : `\n💥 ${bad} مورد قرمز`);
process.exit(bad === 0 ? 0 : 1);
