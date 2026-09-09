/**
 * درگاه پرداخت زیبال — لایهٔ نازک روی سه فراخوانی.
 *
 *   request  ⇒ trackId     (سفارش را در درگاه می‌سازد)
 *   start    ⇒ آدرس صفحهٔ پرداخت، که کاربر به آن می‌رود
 *   verify   ⇒ آیا واقعاً پرداخت شده؟ — و **تنها** مدرکِ واریز سکه
 *
 * قاعده‌ای که این فایل نگه می‌دارد: **پارامترهای بازگشت (`success=1`) مدرک
 * نیستند.** آدرس بازگشت را هرکسی می‌تواند با هر مقداری باز کند. سکه فقط
 * پس از `verify` واریز می‌شود، و `verify` هم دو حالتِ «موفق» دارد: `100`
 * (همین حالا تأیید شد) و `201` (قبلاً تأیید شده). دومی یعنی کاربر دو بار
 * برگشته یا دکمهٔ «بررسی پرداخت» را زده — پس *پرداخت* معتبر است ولی
 * *واریز دوباره* نه. تصمیم دربارهٔ آن در لایهٔ سفارش گرفته می‌شود
 * (`claimTopupPaid`)، نه اینجا.
 *
 * مبلغ‌ها در زیبال **ریال**‌اند؛ همهٔ جاهای دیگرِ این پروژه تومان. تبدیل
 * فقط همین‌جا انجام می‌شود.
 *
 * سنجیده‌شده در ۲۰۲۶-۰۹-۰۹: مرچنت آزمایشی `zibal` از ایران و از سرور
 * (آلمان) هر دو `result: 100` می‌دهد؛ مرچنت واقعی از لپ‌تاپ `115 — invalid
 * IP` و از سرور `100`. یعنی پنل، IP را محدود می‌کند و آزمون از ایران
 * گمراه‌کننده است — همان درسِ استقرار.
 */

import { config } from "../config.js";

const BASE = "https://gateway.zibal.ir";

/** پیام‌های فارسی برای کدهایی که واقعاً پیش می‌آیند. */
const RESULT_FA: Record<number, string> = {
  100: "موفق",
  102: "مرچنت یافت نشد",
  103: "مرچنت غیرفعال است",
  104: "مرچنت نامعتبر است",
  105: "مبلغ کمتر از حداقل است",
  106: "آدرس بازگشت نامعتبر است",
  113: "مبلغ بیش از سقف تراکنش است",
  115: "IP سرور در پنل زیبال مجاز نیست",
  201: "قبلاً تأیید شده",
  202: "پرداخت نشده یا ناموفق",
  203: "شناسهٔ پیگیری نامعتبر است",
};

export function zibalResultText(result: number, message?: string): string {
  return RESULT_FA[result] ?? message ?? `کد ${result}`;
}

export class ZibalError extends Error {
  constructor(
    readonly result: number,
    message: string,
  ) {
    super(message);
    this.name = "ZibalError";
  }
}

export function zibalConfigured(): boolean {
  return Boolean(config.ZIBAL_MERCHANT && config.PUBLIC_URL);
}

/** آدرسی که درگاه پس از پرداخت کاربر را به آن برمی‌گرداند. */
export function zibalCallbackUrl(): string {
  return `${config.PUBLIC_URL.replace(/\/+$/, "")}/pay/zibal/callback`;
}

export function zibalStartUrl(trackId: number | string): string {
  return `${BASE}/start/${trackId}`;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchant: config.ZIBAL_MERCHANT, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new ZibalError(-res.status, `زیبال ${res.status} داد`);
  return (await res.json()) as T;
}

export interface ZibalRequestResult {
  trackId: number;
  payUrl: string;
}

/**
 * ساخت سفارش در درگاه. `orderId` همان شناسهٔ سفارشِ ماست تا در پنل زیبال
 * هم قابل پیگیری باشد.
 */
export async function zibalRequest(opt: {
  amountToman: number;
  orderId: string;
  description: string;
  mobile?: string;
}): Promise<ZibalRequestResult> {
  const r = await post<{ result: number; message?: string; trackId?: number }>("/v1/request", {
    amount: opt.amountToman * 10,
    callbackUrl: zibalCallbackUrl(),
    orderId: opt.orderId,
    description: opt.description,
    ...(opt.mobile ? { mobile: opt.mobile } : {}),
  });
  if (r.result !== 100 || !r.trackId) {
    throw new ZibalError(r.result, zibalResultText(r.result, r.message));
  }
  return { trackId: r.trackId, payUrl: zibalStartUrl(r.trackId) };
}

export interface ZibalVerifyResult {
  /** پرداخت معتبر است (۱۰۰ یا ۲۰۱) */
  paid: boolean;
  /** ۲۰۱ — پیش‌تر تأیید شده بود؛ واریزِ دوباره ممنوع */
  alreadyVerified: boolean;
  result: number;
  message: string;
  /** مبلغ به تومان، آن‌طور که درگاه گزارش می‌دهد */
  amountToman: number | null;
  refNumber: string | null;
  cardNumber: string | null;
  /** کد وضعیت زیبال: ۱ پرداخت و تأییدشده، ۲ پرداخت‌شده، ۳ لغو توسط کاربر، … */
  status: number | null;
}

export async function zibalVerify(trackId: number | string): Promise<ZibalVerifyResult> {
  const r = await post<{
    result: number;
    message?: string;
    amount?: number;
    refNumber?: number | string | null;
    cardNumber?: string | null;
    status?: number;
  }>("/v1/verify", { trackId: Number(trackId) });
  const paid = r.result === 100 || r.result === 201;
  return {
    paid,
    alreadyVerified: r.result === 201,
    result: r.result,
    message: zibalResultText(r.result, r.message),
    amountToman: typeof r.amount === "number" ? Math.round(r.amount / 10) : null,
    refNumber: r.refNumber == null ? null : String(r.refNumber),
    cardNumber: r.cardNumber ?? null,
    status: typeof r.status === "number" ? r.status : null,
  };
}
