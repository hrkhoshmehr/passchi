/**
 * منوی اصلی — پاسخ به این پرسش که «حالا چیکار کنم؟»
 *
 * ربات قبلاً فقط با دستور کار می‌کرد و کاربرِ تازه پس از /start یک پیام
 * خوش‌آمد می‌دید و بس. هر چیزی جز «فایل بفرست» عملاً نامرئی بود، چون کسی
 * فهرست دستورها را باز نمی‌کند.
 *
 * پس صفحه‌کلیدِ ثابتِ پایین چت: همیشه دیده می‌شود، لمس‌کردنی است، و اسمِ
 * فارسیِ هر کار روی دکمه نوشته شده. دستورها همچنان کار می‌کنند — منو
 * جایگزینشان نیست، فقط نمایانشان می‌کند.
 */

import { InlineKeyboard, Keyboard } from "grammy";
import { config } from "../config.js";
import {
  COINS_PER_MINUTE, PACKAGES, SHARE_TARGET, classesFor, coinsAsMinutes, fmtCoins, fmtToman,
} from "../billing/coins.js";
import { toFaDigits } from "../util/time.js";

export const BTN = {
  send: "🎧 صوت بفرستم",
  history: "📚 جلسه‌های من",
  account: "🪙 حساب و سکه‌ها",
  courses: "📘 درس‌های من",
  how: "❓ چطور کار می‌کنه",
  support: "👤 پشتیبانی",
} as const;

export const mainKeyboard = new Keyboard()
  .text(BTN.send).text(BTN.history).row()
  .text(BTN.account).text(BTN.courses).row()
  .text(BTN.how).text(BTN.support)
  .resized()
  .persistent();

/** برچسب دکمه → کاری که باید انجام شود. برای مسیریابی پیام‌های متنی. */
export type MenuAction = keyof typeof BTN;

export function menuActionOf(text: string): MenuAction | null {
  const t = text.trim();
  for (const [key, label] of Object.entries(BTN)) {
    if (t === label) return key as MenuAction;
  }
  return null;
}

// ─── متن صفحه‌ها ────────────────────────────────────────────────────────────

/** هدیهٔ شروع، به سکه — همان چیزی که در اولین دیدار واریز می‌شود. */
export const TRIAL_COINS = config.FREE_TRIAL_COINS;

export const WELCOME = `سلام 👋 من خرخوانم.

صوت کلاستو بفرست، بهت می‌گم توش چی گذشت و چی به درد امتحان می‌خوره.

<b>سه قدم، تمام:</b>
۱⃣ صوت کلاسو همین‌جا بفرست (ویس یا فایل)
۲⃣ چند دقیقه صبر کن
۳⃣ خلاصه، نکات امتحانی، و جزوهٔ PDF رو بگیر

🎁 <b>اولین صوتت رایگانه</b> — تا ${toFaDigits(config.FREE_TRANSCRIPT_MINUTES)} دقیقه‌شو کلمه‌به‌کلمه برات پیاده می‌کنم، مهمون من.
🪙 ${fmtCoins(TRIAL_COINS)} هم تو حسابت گذاشتم که بتونی جزوهٔ اشتراکی یه هم‌کلاسیو برداری.

<i>از دکمه‌های پایین استفاده کن، یا همین الان یه صوت بفرست.</i>`;

export const HOW_IT_WORKS = `<b>❓ چطور کار می‌کنه</b>

<b>۱ — می‌شنوم</b>
کل صوت کلاس کلمه‌به‌کلمه متن می‌شود، با مهر زمانی روی هر جمله. حرف استاد از حرف دانشجو جدا می‌ماند.

<b>۲ — تمیز می‌کنم</b>
متن خامِ شنیداری پر از غلط است: اسم فرمول‌ها، اصطلاح‌های تخصصی، عددها. این‌ها اصلاح می‌شوند و هرچه از درس‌های قبلیِ خودت یاد گرفته‌ام اینجا به کار می‌آید — برای همین هر جلسه از جلسهٔ قبل دقیق‌تر است.

<b>۳ — درمی‌آورم</b>
بعد کل متن خوانده می‌شود و این‌ها بیرون می‌آید:
• <b>کلاس چه خبر بود</b> — چند خط، انگار یک هم‌کلاسی برایت تعریف کند
• هرچه استاد گفت «در امتحان می‌آید» یا رویش تأکید کرد، با عین جمله‌اش
• تکلیف‌ها با جزئیات و مهلت، کوییز، حضور و غیاب، کلاس جبرانی
• <b>بخش‌بندی کلاس</b> — کجا درس داد، کجا حاشیه رفت، کجا سؤال و جواب بود، با زمانش

<b>۴ — می‌نویسم</b>
آخرش یک جزوهٔ کامل PDF، مرتب و قابل چاپ.

<b>چقدرش رایگان است</b>
اولین صوت هر کسی رایگان <b>پیاده</b> می‌شود — تا ${toFaDigits(config.FREE_TRANSCRIPT_MINUTES)} دقیقه. یعنی مرحلهٔ اول از این چهار مرحله. سه مرحلهٔ بعد سکه می‌خواهد، چون هزینهٔ واقعی همان‌جاست.

<b>و چطور تقریباً مجانی می‌شود</b>
یک جلسه یک بار پردازش می‌شود. جزوه‌اش را که برای بچه‌های کلاس بفرستی، هرکس برش دارد سهم همه کمتر می‌شود و مابه‌التفاوت به تو برمی‌گردد — با ${toFaDigits(SHARE_TARGET)} نفر، حدود ۹۰٪ سکه‌هایت را پس گرفته‌ای.

<b>یک قاعده که رعایت می‌کنم</b>
هر نکته‌ای که به‌عنوان «حرف استاد» نقل می‌کنم، عیناً در صوت گفته شده. اگر نتوانم جمله را در صوت پیدا کنم، آن نکته را حذف می‌کنم نه اینکه حدس بزنم.

<i>روی دقیقه‌ها که بزنی، صوت از همان‌جا پخش می‌شود (روی موبایل).</i>`;

export function supportMessage(): string {
  const lines = ["<b>👤 پشتیبانی</b>", ""];
  if (config.SUPPORT_USERNAME) {
    lines.push(`هر سؤال، مشکل، یا پیشنهادی داری به @${config.SUPPORT_USERNAME} پیام بده.`);
  } else {
    lines.push("فعلاً راه ارتباطی مستقیمی تنظیم نشده. مشکلت را همین‌جا بنویس تا بررسی شود.");
  }
  lines.push(
    "",
    "<i>اگر پردازش جلسه‌ای ناموفق بود، سکه‌ات خودکار برگشته — قبل از پیام‌دادن حسابت را ببین.</i>",
  );
  return lines.join("\n");
}

export function supportKeyboard(): InlineKeyboard | undefined {
  if (!config.SUPPORT_USERNAME) return undefined;
  return new InlineKeyboard().url("پیام به پشتیبانی", `https://t.me/${config.SUPPORT_USERNAME}`);
}

// ─── حساب و شارژ ────────────────────────────────────────────────────────────

export function packagesKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PACKAGES) {
    kb.text(
      `${fmtCoins(p.coins)} — ${fmtToman(p.price)}${p.tag ? ` · ${p.tag}` : ""}`,
      `buy:${p.id}`,
    ).row();
  }
  return kb;
}

export function packagesMessage(): string {
  const out = ["<b>🪙 شارژ حساب</b>", "", `هر دقیقه صوت ${toFaDigits(COINS_PER_MINUTE)} سکه خرج دارد.`, ""];
  for (const p of PACKAGES) {
    const classes = classesFor(p.coins);
    const worth = classes >= 1 ? `${toFaDigits(classes)} کلاس ۹۰ دقیقه‌ای` : coinsAsMinutes(p.coins);
    out.push(
      `• <b>${fmtCoins(p.coins)}</b> — ${fmtToman(p.price)}` +
        `${p.tag ? ` · ${p.tag}` : ""}\n  <i>${worth}</i>`,
    );
  }
  out.push(
    "",
    `💰 <b>قبل از خرید اینو بدون:</b> لازم نیست خرج کلاس رو تنها بدی. بعد از هر تحلیل یه دکمه ` +
      `می‌بینی که جزوه رو برای بچه‌های کلاس می‌فرسته. هرکی برش داره سهم همه کمتر می‌شه و ` +
      `مابه‌التفاوتش برمی‌گرده به حسابت — با ${toFaDigits(SHARE_TARGET)} نفر، حدود <b>۹۰٪</b> سکه‌هات برمی‌گرده.`,
    "",
    "پکیجت رو از دکمه‌های پایین انتخاب کن.",
  );
  return out.join("\n");
}
