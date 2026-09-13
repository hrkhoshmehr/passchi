/**
 * شارژ حساب — درگاه زیبال، و کارت‌به‌کارت به‌عنوان پشتیبان.
 *
 * ## مسیر درگاه (از ۲۰۲۶-۰۹-۰۹)
 *
 * کاربر پکیج را انتخاب می‌کند → سفارش ساخته و در زیبال ثبت می‌شود → دکمهٔ
 * «پرداخت» به صفحهٔ درگاه می‌برد → درگاه کاربر را به
 * `/pay/zibal/callback` برمی‌گرداند → سرور `verify` می‌زند → سکه واریز و
 * به کاربر در ربات خبر داده می‌شود.
 *
 * دو تصمیم که عمدی‌اند:
 *
 * • **بازگشت از درگاه مدرک نیست؛ `verify` مدرک است.** آدرس بازگشت را هرکسی
 *   می‌تواند با `success=1` باز کند. `settleTopup` تنها راهِ واریز است و
 *   همیشه از درگاه می‌پرسد.
 *
 * • **دکمهٔ «بررسی پرداخت» در ربات هست، چون بازگشت همیشه اتفاق نمی‌افتد.**
 *   کاربر بعد از پرداخت مرورگر را می‌بندد، یا CDN لحظه‌ای ۵۰۲ می‌دهد، و
 *   پولی که رفته سکه نشده. همان `settleTopup` از ربات هم صدا می‌شود؛ واریزِ
 *   دوباره را `claimTopupPaid` در پایگاه‌داده می‌گیرد، نه دست‌کد.
 *
 * ## مسیر کارت‌به‌کارت (وقتی درگاه تنظیم نیست)
 *
 * ربات شمارهٔ کارت و مبلغ *دقیق* را می‌دهد، کاربر عکس رسید را می‌فرستد، و
 * ادمین با یک دکمه تأیید یا رد می‌کند. سفارش پیش از پرداخت ساخته می‌شود تا
 * رسید بی‌شناسه به «آخرین سفارشِ باز» بچسبد.
 */

import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Api, type Context } from "grammy";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { escapeHtml } from "../util/text.js";
import { isBale } from "./identity.js";
import {
  coinsToSec, findPackage, fmtBalance, fmtCoins, fmtToman, type CoinPackage,
} from "../billing/coins.js";
import { grant } from "../billing/ledger.js";
import { ZibalError, zibalConfigured, zibalRequest, zibalVerify } from "../billing/zibal.js";
import {
  awaitingCreditSessions, claimTopupPaid, createTopup, getSession, getTopup, getTopupByTrackId, getUser,
  pendingWebUploadId, takePendingJoin,
  openTopup, setTopupStatus, setTopupTrackId, type TopupRow,
} from "../db/index.js";
import { uid } from "./identity.js";
import { notifyAdmins, notifyUser } from "./notify.js";
import { APP_NAME } from "./menu.js";
import { isMember } from "../billing/sharing.js";
import { groupJoinable } from "../billing/group-buy.js";
import { GROUP_CB, groupBuyEnabled, groupSizesFor } from "./group-buy.js";
import * as S from "./strings.js";

const orderId = () => randomBytes(4).toString("hex");

export function gatewayConfigured(): boolean {
  return zibalConfigured();
}

export function paymentConfigured(): boolean {
  return gatewayConfigured() || Boolean(config.CARD_NUMBER);
}

export interface TopupStart {
  text: string;
  keyboard: InlineKeyboard;
  /** لینک درگاه — فقط در مسیر درگاه؛ مینی‌اپ همین را باز می‌کند */
  payUrl?: string;
  id: string;
}

/**
 * کاربر پکیج را انتخاب کرد.
 *
 * اگر درگاه تنظیم است، سفارش در زیبال ثبت می‌شود و لینک پرداخت برمی‌گردد.
 * اگر زیبال جواب نداد (شبکه، IP مجاز نبودن، مرچنت غیرفعال) و کارت هم هست،
 * به کارت‌به‌کارت می‌افتد تا کاربری که پول در دست دارد بی‌راه نماند؛ وگرنه
 * پرتاب می‌کند و صداکننده پیام خطا می‌دهد.
 */
export async function beginTopup(tgId: number, packageId: string): Promise<TopupStart | null> {
  const p = findPackage(packageId);
  if (!p) return null;

  if (gatewayConfigured()) {
    try {
      return await beginGateway(tgId, p);
    } catch (e) {
      logger.error({ tgId, pkg: p.id, err: String(e) }, "zibal request failed");
      if (!config.CARD_NUMBER) throw e;
    }
  }
  return beginCard(tgId, p);
}

async function beginGateway(tgId: number, p: CoinPackage): Promise<TopupStart> {
  const t = createTopup(orderId(), tgId, p.id, p.coins, p.price, "awaiting_payment");
  const { trackId, payUrl } = await zibalRequest({
    amountToman: p.price,
    orderId: t.id,
    description: `${APP_NAME} — ${p.title} (${fmtCoins(p.coins)})`,
  });
  setTopupTrackId(t.id, String(trackId));

  return {
    id: t.id,
    payUrl,
    text: [
      `🧾 <b>${escapeHtml(p.title)}</b> — ${fmtCoins(p.coins)}`,
      `مبلغ: <b>${fmtToman(p.price)}</b>`,
      "",
      // کاربرِ تلگرام تقریباً همیشه فیلترشکن روشن دارد و درگاهِ بانکیِ ایران آی‌پیِ
      // خارجی را معمولاً رد می‌کند؛ بی این جمله او فقط صفحهٔ خطای بانک را می‌بیند و
      // نمی‌داند چرا.
      "روی «💳 پرداخت» بزن تا صفحهٔ بانک باز شه. اگه فیلترشکن روشنه، اول خاموشش کن؛ درگاه بانک با فیلترشکن معمولاً باز نمیشه.",
      "پول که رفت، سکه‌ها خودش میاد و همین‌جا خبرت می‌کنم.",
      "",
      "<i>پرداخت کردی و خبری نشد؟ «🔄 بررسی پرداخت» رو بزن.</i>",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .url("💳 پرداخت", payUrl)
      .row()
      .text("🔄 بررسی پرداخت", `pcheck:${t.id}`)
      .text("انصراف", `bcancel:${t.id}`),
  };
}

function beginCard(tgId: number, p: CoinPackage): TopupStart {
  // سفارشِ بازِ قبلی بسته می‌شود: اتصال رسید از روی «آخرین سفارش باز» است و
  // دو سفارشِ همزمان یعنی نصف احتمال اینکه رسید به مبلغ درست بچسبد.
  const stale = openTopup(tgId);
  if (stale) setTopupStatus(stale.id, "rejected", { decidedBy: tgId });

  const t = createTopup(orderId(), tgId, p.id, p.coins, p.price);
  const holder = config.CARD_HOLDER ? `\nبه نام: <b>${escapeHtml(config.CARD_HOLDER)}</b>` : "";

  return {
    id: t.id,
    text: [
      `🧾 <b>سفارش</b> <code>${t.id}</code>`,
      "",
      `${escapeHtml(p.title)} — ${fmtCoins(p.coins)} — مبلغ <b>${fmtToman(p.price)}</b>`,
      "",
      "مبلغ را به این کارت واریز کن:",
      `<code>${escapeHtml(config.CARD_NUMBER)}</code>${holder}`,
      "",
      "بعدش <b>عکس رسید</b> را همین‌جا بفرست. تا نیم‌ساعت بررسی می‌شود و سکه‌ها به حسابت می‌آید.",
      "",
      "<i>مبلغ را دقیقاً همین‌قدر بفرست — تطبیق رسید با همین عدد انجام می‌شود.</i>",
    ].join("\n"),
    keyboard: new InlineKeyboard().text("انصراف", `bcancel:${t.id}`),
  };
}

// ─── تسویه با درگاه ─────────────────────────────────────────────────────────

export type SettleOutcome =
  /** همین حالا تأیید و واریز شد */
  | "credited"
  /** پیش‌تر واریز شده بود — پیام موفقیت، بدون واریز دوباره */
  | "already"
  /** درگاه می‌گوید پرداخت نشده یا کاربر لغو کرده */
  | "unpaid"
  /** سفارش پیدا نشد یا مال این کاربر نیست */
  | "unknown"
  /** زیبال جواب نداد */
  | "error";

export interface SettleResult {
  outcome: SettleOutcome;
  topup: TopupRow | null;
  /** توضیح کوتاه برای صفحهٔ بازگشت یا toast — همیشه قابل نمایش به کاربر */
  detail: string;
}

/**
 * تنها راهِ واریز سکهٔ درگاهی.
 *
 * `topup` را با شناسهٔ سفارش یا شناسهٔ پیگیری زیبال پیدا می‌کند، از درگاه
 * می‌پرسد، و اگر معتبر بود یک بار واریز می‌کند.
 *
 * **این تابع هیچ‌وقت سفارش را نمی‌بندد**، و این عمدی است. پیش‌تر گزینهٔ
 * `closeIfUnpaid` داشت که بازگشت با `success=0` صدایش می‌زد. ولی آدرس بازگشت
 * بی‌احراز است و `trackId` عددی پشت‌سرهم: هرکسی با شمردنِ trackIdها
 * می‌توانست سفارشِ بازِ یک غریبه را، پیش از آنکه پرداخت کند، ببندد. آن غریبه
 * بعد پرداخت می‌کرد، پولش می‌رفت، و نه بازگشت و نه «بررسی پرداخت» سکه‌ای
 * نمی‌دادند — چون هر دو روی سفارشِ بسته متوقف می‌شوند.
 *
 * تسویه ولی بی‌خطر است که بی‌احراز بماند: `verify` مدرک است و
 * `claimTopupPaid` واریزِ دوباره را می‌گیرد؛ بدترین کارِ یک غریبه این است که
 * سکهٔ صاحبِ سفارش را زودتر به حساب خودِ صاحبش بریزد.
 *
 * بستنِ سفارشِ پرداخت‌نشده فقط از مسیر احرازشده است (`cancelTopup`، دکمهٔ
 * «انصراف» در ربات). سفارشی که کسی نبندد در `awaiting_payment` می‌ماند؛ این
 * بی‌ضرر است چون نه به رسید کارت‌به‌کارت می‌چسبد (`openTopup` فقط
 * `awaiting_receipt` را می‌بیند) و نه جایی به‌عنوان بدهی شمرده می‌شود.
 */
export async function settleTopup(
  ref: { topupId?: string; trackId?: string },
): Promise<SettleResult> {
  const t = ref.topupId ? getTopup(ref.topupId) : ref.trackId ? getTopupByTrackId(ref.trackId) : null;
  if (!t || !t.track_id) return { outcome: "unknown", topup: null, detail: "این سفارش پیدا نشد." };

  if (t.status === "approved") return { outcome: "already", topup: t, detail: "این سفارش قبلاً تسویه شده." };
  if (t.status !== "awaiting_payment") {
    return { outcome: "unpaid", topup: t, detail: "این سفارش بسته شده. یک سفارش تازه بساز." };
  }

  let v;
  try {
    v = await zibalVerify(t.track_id);
  } catch (e) {
    logger.error({ topup: t.id, err: String(e) }, "zibal verify failed");
    return {
      outcome: "error",
      topup: t,
      detail: "درگاه جواب نداد. اگر پرداخت کردی نگران نباش — چند دقیقهٔ دیگر «بررسی پرداخت» را بزن.",
    };
  }

  if (!v.paid) {
    logger.info({ topup: t.id, result: v.result, status: v.status }, "zibal: unpaid");
    return { outcome: "unpaid", topup: t, detail: `پرداخت انجام نشد (${v.message}).` };
  }

  /**
   * مبلغ هم سنجیده می‌شود. درگاه با همان مبلغی که فرستادیم می‌سازد، پس
   * اختلاف یعنی چیزی جای دیگری غلط است — لاگ می‌شود ولی جلوی واریز را
   * نمی‌گیرد، چون پولِ کاربر واقعاً رفته و نگه‌داشتنش بدتر است.
   */
  if (v.amountToman != null && v.amountToman !== t.price_toman) {
    logger.warn({ topup: t.id, expected: t.price_toman, got: v.amountToman }, "zibal amount mismatch");
  }

  if (!claimTopupPaid(t.id, v.refNumber)) {
    return { outcome: "already", topup: getTopup(t.id), detail: "این سفارش قبلاً تسویه شده." };
  }

  await creditTopup(t);
  logger.info({ topup: t.id, tgId: t.tg_id, coins: t.coins, ref: v.refNumber }, "topup paid via zibal");
  void notifyAdmins(
    `💳 <b>شارژ آنلاین</b>\n` +
      `${fmtCoins(t.coins)} — ${fmtToman(t.price_toman)}\n` +
      `کاربر: ${escapeHtml(getUser(t.tg_id)?.name ?? String(t.tg_id))} — <code>${t.tg_id}</code>\n` +
      `مرجع: <code>${escapeHtml(v.refNumber ?? "—")}</code>`,
  );
  return { outcome: "credited", topup: getTopup(t.id), detail: `${fmtCoins(t.coins)} به حسابت اضافه شد.` };
}

/**
 * واریز سکه و خبر به کاربر — مشترک بین تأیید ادمین و تأیید درگاه.
 *
 * اگر فایلی منتظر شارژ مانده، **همان را یادآوری کن** نه «صوتتو بفرست».
 * کاربری که فایل ۱۳۰ دقیقه‌ای‌اش را فرستاده و پیام «سکه‌ات کمه» گرفته، بعد
 * از شارژ همین پیام را می‌دید و گمان می‌کرد باید از نو بفرستد — و می‌فرستاد.
 * در حالی که فایلش سالم روی دیسک بود.
 */
async function creditTopup(t: TopupRow): Promise<void> {
  grant(t.tg_id, coinsToSec(t.coins), "topup");
  const balance = getUser(t.tg_id)?.credit_sec ?? 0;
  const head =
    `🪙 <b>${fmtCoins(t.coins)}</b> به حسابت اضافه شد!\n\n` + `موجودی جدیدت: <b>${fmtBalance(balance)}</b>\n\n`;

  /**
   * بعد از شارژ، کاربر را به **همان کاری** برگردان که برایش شارژ کرد.
   *
   * سه حالت، به این ترتیب: فایلی که در خودِ ربات فرستاده و سکه کم آورده؛ جزوهٔ
   * هم‌کلاسی که خواسته بود بردارد؛ فایلی که از صفحهٔ آپلود فرستاده. پیش از این
   * فقط حالتِ اول دیده می‌شد و دو نفرِ دیگر «صوت کلاستو بفرست» می‌گرفتند —
   * کسی که برای جزوهٔ هم‌کلاسی آمده بود، و کسی که فایلش همان‌جا منتظر بود.
   */
  const waiting = awaitingCreditSessions(t.tg_id);
  const enough = waiting.find((s) => balance >= Math.round(s.original_ms / 1000));
  if (enough) {
    await notifyUser(t.tg_id, head + `<b>فایلی که فرستاده بودی هنوز اینجاست.</b> بزن تا ادامه بدم 👇`, {
      reply_markup: new InlineKeyboard().text("▶️ ادامهٔ همون فایل", `resume:${enough.id}`),
    });
    return;
  }

  const wantedId = takePendingJoin(t.tg_id);
  const wanted = wantedId ? getSession(wantedId) : null;
  if (wanted && wanted.status === "done" && !isMember(wanted.id, t.tg_id)) {
    await notifyUser(t.tg_id, head + S.PENDING_JOIN_AFTER_TOPUP, {
      reply_markup: new InlineKeyboard().text(S.PENDING_JOIN_BTN, `jdo:${wanted.id}`),
    });
    return;
  }
  // همان خواسته، برای خرید گروهی‌ای که هنوز باز است و جا دارد.
  if (wanted && wanted.status === "awaiting_group" && groupJoinable(wanted.id, t.tg_id)) {
    await notifyUser(t.tg_id, head + S.PENDING_GROUP_AFTER_TOPUP, {
      reply_markup: new InlineKeyboard().text(S.GROUP_BTN.join, `${GROUP_CB.join}:${wanted.id}`),
    });
    return;
  }

  // فایلش هنوز منتظر است و برای کل فایل کم دارد، ولی سهمِ یک خرید گروهی را دارد.
  // بی این، مالکی که فقط برای سهمِ خودش شارژ کرده بود دیگر راهی به همان گروه نداشت.
  const groupable = groupBuyEnabled()
    ? waiting.find((s) => groupSizesFor(Math.round(s.original_ms / 1000), balance).length > 0)
    : undefined;
  if (groupable) {
    await notifyUser(t.tg_id, head + S.PENDING_GROUP_OPEN_AFTER_TOPUP, {
      reply_markup: new InlineKeyboard().text(S.GROUP_BTN.group, `${GROUP_CB.open}:${groupable.id}`),
    });
    return;
  }

  if (pendingWebUploadId(t.tg_id)) {
    await notifyUser(t.tg_id, head + S.PENDING_WEB_UPLOAD_AFTER_TOPUP, {});
    return;
  }

  await notifyUser(t.tg_id, head + "صوت کلاستو بفرست 🎧", {});
}

// ─── کارت‌به‌کارت ───────────────────────────────────────────────────────────

/**
 * عکسی رسیده و کاربر سفارشِ باز دارد.
 *
 * برمی‌گرداند که آیا عکس به‌عنوان رسید مصرف شد یا نه، تا فرستادن یک عکس
 * معمولی بی‌ربط، پاسخ اشتباه نگیرد.
 */
export async function receiveReceipt(ctx: Context, fileId: string): Promise<boolean> {
  const tgId = uid(ctx);
  const t = openTopup(tgId);
  if (!t) return false;

  setTopupStatus(t.id, "pending", { receiptFileId: fileId });
  await ctx.reply(
    `✅ رسید سفارش <code>${t.id}</code> رسید.\n\n` +
      `${fmtCoins(t.coins)} به‌محض تأیید به حسابت اضافه می‌شود. خبرش را همین‌جا می‌دهم.`,
    { parse_mode: "HTML" },
  );
  await notifyAdminsReceipt(ctx.api, { ...t, receipt_file_id: fileId, status: "pending" });
  return true;
}

async function notifyAdminsReceipt(api: Api, t: TopupRow): Promise<void> {
  const u = getUser(t.tg_id);
  const who = [u?.name, u?.username ? `@${u.username}` : null].filter(Boolean).join(" ");
  const caption = [
    "🧾 <b>درخواست شارژ</b>",
    "",
    `سفارش: <code>${escapeHtml(t.id)}</code>`,
    `کاربر: ${escapeHtml(who || String(t.tg_id))} — <code>${t.tg_id}</code>`,
    `پکیج: ${fmtCoins(t.coins)} — ${fmtToman(t.price_toman)}`,
    `موجودی فعلی: ${fmtBalance(u?.credit_sec ?? 0)}`,
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("✅ تأیید", `tok:${t.id}`)
    .text("❌ رد", `trej:${t.id}`);

  /**
   * ادمین‌های همین سکو، نه فهرست تلگرام برای همه.
   *
   * برخلاف خبرِ هدیه که فقط متن است، اینجا `receipt_file_id` در کار است و
   * شناسهٔ فایل به سکویی که آپلود شده گره خورده — پس پیام باید از همان
   * `api` برود، و مقصدش هم باید شناسهٔ همان سکو باشد.
   */
  const admins = isBale(api) ? config.BALE_ADMIN_IDS : config.ADMIN_IDS;
  if (admins.length === 0) {
    logger.warn({ topup: t.id }, "درخواست شارژ رسید ولی فهرست ادمینِ این سکو خالی است");
  }
  for (const admin of admins) {
    try {
      if (!t.receipt_file_id) {
        await api.sendMessage(admin, caption, { parse_mode: "HTML", reply_markup: kb });
        continue;
      }
      // رسید ممکن است عکس باشد یا فایلِ تصویری؛ اگر sendPhoto نپذیرفت، همان
      // شناسه به‌عنوان سند فرستاده می‌شود تا ادمین بدون رسید تصمیم نگیرد.
      await api
        .sendPhoto(admin, t.receipt_file_id, { caption, parse_mode: "HTML", reply_markup: kb })
        .catch(() =>
          api.sendDocument(admin, t.receipt_file_id!, { caption, parse_mode: "HTML", reply_markup: kb }),
        );
    } catch (e) {
      logger.warn({ admin, err: String(e) }, "notify admin failed");
    }
  }
}

export interface DecisionResult {
  /** پاسخ کوتاهی که به ادمین نشان داده می‌شود */
  toast: string;
  /** متن به‌روزشدهٔ زیر عکس رسید، تا دو ادمین یک سفارش را دوباره تأیید نکنند */
  adminNote?: string;
}

/** تصمیم ادمین دربارهٔ رسید کارت‌به‌کارت. */
export async function decide(
  api: Api,
  topupId: string,
  adminId: number,
  approved: boolean,
): Promise<DecisionResult> {
  const t = getTopup(topupId);
  if (!t) return { toast: "این سفارش پیدا نشد." };
  if (t.status !== "pending") {
    return { toast: `این سفارش قبلاً ${t.status === "approved" ? "تأیید" : "بسته"} شده.` };
  }

  setTopupStatus(topupId, approved ? "approved" : "rejected", { decidedBy: adminId });

  if (approved) {
    await creditTopup(t);
    logger.info({ topup: topupId, tgId: t.tg_id, coins: t.coins }, "topup approved");
    return { toast: "تأیید شد و سکه واریز شد.", adminNote: `✅ تأیید شد — ${fmtCoins(t.coins)}` };
  }

  await notifyUser(
    t.tg_id,
    `❌ رسید سفارش <code>${t.id}</code> تأیید نشد.\n\n` +
      (config.SUPPORT_USERNAME
        ? `اگر فکر می‌کنی اشتباهی شده به @${config.SUPPORT_USERNAME} پیام بده.`
        : "دوباره تلاش کن یا با پشتیبانی تماس بگیر."),
  );
  logger.info({ topup: topupId }, "topup rejected");
  return { toast: "رد شد.", adminNote: "❌ رد شد" };
}

/** انصراف کاربر — برای هر دو مسیر، تا وقتی که پرداختی ثبت نشده. */
export function cancelTopup(topupId: string, tgId: number): boolean {
  const t = getTopup(topupId);
  if (!t || t.tg_id !== tgId) return false;
  if (t.status !== "awaiting_receipt" && t.status !== "awaiting_payment") return false;
  setTopupStatus(topupId, "rejected", { decidedBy: tgId });
  return true;
}

export { ZibalError };
