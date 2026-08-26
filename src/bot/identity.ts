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

export function setBaleApi(api: Api | null): void {
  baleApi = api;
}

export function platformOf(ctx: Context): Platform {
  return baleApi && ctx.api === baleApi ? "bale" : "telegram";
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
