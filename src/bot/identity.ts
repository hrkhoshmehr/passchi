/**
 * پل بین «کاربرِ گفت‌وگو» و «کاربرِ پایگاه‌داده».
 *
 * جدا از `bot/index.ts` نگه داشته شده تا `share.ts` و `topup.ts` هم بتوانند
 * صدایش بزنند بدون اینکه به آن فایلِ بزرگ وابسته شوند — که وابستگی حلقوی
 * می‌ساخت، چون خودِ `index.ts` هر دوی آن‌ها را وارد می‌کند.
 */

import type { Api, Context } from "grammy";
import { findIdentity, resolveIdentity, type Platform } from "../db/identity.js";

/**
 * `Api` ربات بله، اگر پیکربندی شده باشد.
 *
 * با `setBaleApi` از `bot/index.ts` پر می‌شود. اگر مستقیم وارد می‌شد،
 * `index` و این فایل هم‌دیگر را وارد می‌کردند.
 */
let baleApi: Api | null = null;

/**
 * توکن ربات بله — ملاکِ واقعیِ تشخیص.
 *
 * **چرا توکن و نه خودِ شیء:** grammY برای *هر آپدیت* یک `Api` تازه می‌سازد
 * (`bot.js`: `const api = new Api(this.token, …)` پیش از ساختن `Context`).
 * پس `ctx.api` هرگز همان شیئی نیست که `setBaleApi` گرفته، و مقایسهٔ
 * `ctx.api === baleApi` **همیشه** نادرست بود؛ یعنی هر کاربر بله «تلگرام»
 * تشخیص داده می‌شد.
 *
 * این باگ بی‌صدا بود چون هر دو سکو یک مجموعه دست‌کد دارند و متن‌ها درست
 * می‌رفتند (پاک‌سازی HTML روی خودِ `api` نشسته، نه روی `platformOf`). فقط
 * جاهایی می‌شکست که رفتار باید فرق می‌کرد — و آنجا هم خطا بلعیده می‌شد.
 *
 * توکن روی نمونه‌های تازه دست‌نخورده می‌ماند، پس مقایسه‌اش پایدار است.
 */
let baleToken: string | null = null;

export function setBaleApi(api: Api | null): void {
  baleApi = api;
  baleToken = api?.token ?? null;
}

export function platformOf(ctx: Context): Platform {
  return isBale(ctx.api) ? "bale" : "telegram";
}

/**
 * همان تشخیص، ولی از روی خودِ `Api`.
 *
 * جایی لازم است که `Context` در دست نیست — مثل ساختن لینک، که فقط `api`
 * می‌گیرد ولی باید بداند دامنه‌اش `t.me` است یا `ble.ir`.
 */
export function isBale(api: Api): boolean {
  if (!baleToken) return false;
  // مقایسهٔ شیء اول می‌آید چون ارزان است و برای خودِ `baleBot.api` درست است.
  return api === baleApi || api.token === baleToken;
}

/**
 * شناسهٔ داخلی کاربرِ این گفت‌وگو — کلیدی که به پایگاه‌داده می‌رود.
 *
 * برای تلگرام همان `ctx.from.id` است (پس داده‌های موجود دست‌نخورده‌اند)، و
 * برای بله شناسه‌ای از فضای جدا. اگر هویت هنوز ساخته نشده باشد، ساخته
 * می‌شود — پس این تابع همیشه عدد برمی‌گرداند.
 */
export function uid(ctx: Context): number {
  const from = ctx.from!;
  const platform = platformOf(ctx);
  const known = findIdentity(platform, String(from.id));
  if (known) return known.user_id;
  return resolveIdentity({
    platform,
    platformUserId: String(from.id),
    name: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
    username: from.username ?? null,
  }).tg_id;
}
