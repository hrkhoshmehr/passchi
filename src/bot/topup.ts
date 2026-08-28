/**
 * شارژ حساب با کارت‌به‌کارت.
 *
 * درگاه پرداختی در کار نیست، پس زنجیره این است: کاربر پکیج را انتخاب می‌کند،
 * ربات شمارهٔ کارت و مبلغ *دقیق* را می‌دهد، کاربر عکس رسید را می‌فرستد، و
 * ادمین با یک دکمه تأیید یا رد می‌کند. سکه فقط پس از تأیید واریز می‌شود.
 *
 * دو تصمیم که عمدی‌اند:
 *
 * • **سفارش پیش از پرداخت ساخته می‌شود، نه بعدش.** بدون سطر سفارش، عکسِ رسیدی
 *   که می‌رسد معلوم نیست بابت چه مبلغی است و ادمین باید حدس بزند.
 *
 * • **اتصال رسید به سفارش از روی «آخرین سفارشِ باز» است.** کاربر عکس را خالی
 *   می‌فرستد و هیچ شناسه‌ای همراهش نیست؛ خواستن کد سفارش از او، یک قدم اضافه
 *   است که نیمی از آدم‌ها همان‌جا رها می‌کنند.
 */

import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Api, type Context } from "grammy";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { escapeHtml } from "../util/text.js";
import { isBale } from "./identity.js";
import { coinsToSec, findPackage, fmtBalance, fmtCoins, fmtToman } from "../billing/coins.js";
import { grant } from "../billing/ledger.js";
import {
  createTopup, getTopup, getUser, openTopup, setTopupStatus, type TopupRow,
} from "../db/index.js";
import { uid } from "./identity.js";
import { notifyUser } from "./notify.js";

const orderId = () => randomBytes(4).toString("hex");

export function paymentConfigured(): boolean {
  return Boolean(config.CARD_NUMBER);
}

/** کاربر پکیج را انتخاب کرد: سفارش ساخته می‌شود و دستور پرداخت داده می‌شود. */
export function beginTopup(tgId: number, packageId: string): { text: string; keyboard: InlineKeyboard } | null {
  const p = findPackage(packageId);
  if (!p) return null;

  // سفارشِ بازِ قبلی بسته می‌شود: اتصال رسید از روی «آخرین سفارش باز» است و
  // دو سفارشِ همزمان یعنی نصف احتمال اینکه رسید به مبلغ درست بچسبد.
  const stale = openTopup(tgId);
  if (stale) setTopupStatus(stale.id, "rejected", { decidedBy: tgId });

  const t = createTopup(orderId(), tgId, p.id, p.coins, p.price);
  const holder = config.CARD_HOLDER ? `\nبه نام: <b>${escapeHtml(config.CARD_HOLDER)}</b>` : "";

  return {
    text: [
      `🧾 <b>سفارش</b> <code>${t.id}</code>`,
      "",
      `${fmtCoins(p.coins)} — مبلغ <b>${fmtToman(p.price)}</b>`,
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
  await notifyAdmins(ctx.api, { ...t, receipt_file_id: fileId, status: "pending" });
  return true;
}

async function notifyAdmins(api: Api, t: TopupRow): Promise<void> {
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

/** تصمیم ادمین. تنها جایی که سکهٔ خریداری‌شده واریز می‌شود. */
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
    grant(t.tg_id, coinsToSec(t.coins), "topup");
    const balance = getUser(t.tg_id)?.credit_sec ?? 0;
    await notifyUser(
      t.tg_id,
      `🪙 <b>${fmtCoins(t.coins)}</b> به حسابت اضافه شد!\n\n` +
        `موجودی جدیدت: <b>${fmtBalance(balance)}</b>\n\nصوت کلاستو بفرست 🎧`,
    );
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

export function cancelTopup(topupId: string, tgId: number): boolean {
  const t = getTopup(topupId);
  if (!t || t.tg_id !== tgId || t.status !== "awaiting_receipt") return false;
  setTopupStatus(topupId, "rejected", { decidedBy: tgId });
  return true;
}
