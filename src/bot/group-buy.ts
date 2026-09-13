/**
 * خرید گروهی — آنچه به پیام و سکو مربوط است.
 *
 * پول و قاعده‌ها در `billing/group-buy.ts`اند؛ اینجا فقط اینکه چه کسی چه
 * پیامی بگیرد و کار از کجا شروع شود. ربات و مینی‌اپ هر دو از همین‌جا
 * می‌گذرند، تا «باز کردنِ گروه» دو پیاده‌سازی نداشته باشد.
 *
 * ## چرا شروعِ کار از `jobs/service` است، نه از `startJob` ربات
 *
 * گروه با زدنِ **آخرین هم‌کلاسی** پر می‌شود، در چتِ او و روی سکوی او. مسیرِ
 * ربات پیشرفت و نتیجه را به همان `ctx` می‌فرستد — یعنی نتیجهٔ مالک به چتِ
 * آن هم‌کلاسی می‌رفت. سرویس از هیچ چتی خبر ندارد؛ پیشرفت با `liveMessage` و
 * نتیجه با `deliverToBot` به کانالِ خودِ مالک می‌رود، همان کاری که مینی‌اپ
 * از قبل می‌کند.
 */

import fs from "node:fs";
import { InlineKeyboard, type Api } from "grammy";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { getCourse, getSession, getUser } from "../db/index.js";
import { InsufficientCredit } from "../billing/ledger.js";
import {
  GROUP_BUY_HOURS, GROUP_SIZES, GroupBuyRefused, cancelGroupBuy, createGroupBuy, expireGroupBuys,
  groupProgress, groupSeat, groupSeats, joinGroupBuy, lockGroupBuy, ownerPaysRest,
  type ClosedGroup, type GroupOrigin, type GroupProgress, type RefusalReason,
} from "../billing/group-buy.js";
import { startJob as serviceStartJob, type JobSpec } from "../jobs/service.js";
import { deliverToBot } from "./deliver.js";
import { deliveryChannel, liveMessage, notifyUser } from "./notify.js";
import { archiveAudio, archiveFailure, archiveReport, audioCaption } from "./archive.js";
import { startLink } from "./share.js";
import * as S from "./strings.js";

/** پیشوندِ `/start` لینکِ دعوتِ خرید گروهی. */
export const GROUP_START_PREFIX = "p_";

/**
 * پیشوندهای کال‌بک — کوتاه، چون `callback_data` بیش از ۶۴ بایت نیست.
 *
 * gb: انتخابِ «با هم‌کلاسیا بخریم» · gbn: اندازه · gbx: برگشت به دو گزینه ·
 * gbj: «هستم» · gbr: «بقیه‌اش رو خودم می‌دم» · gbl: دوباره پیامِ گروه ·
 * gbg: گرفتنِ نتیجه برای هم‌کلاسی
 */
export const GROUP_CB = {
  open: "gb",
  size: "gbn",
  back: "gbx",
  join: "gbj",
  rest: "gbr",
  link: "gbl",
  get: "gbg",
} as const;

export function groupBuyEnabled(): boolean {
  return config.GROUP_BUY;
}

export function groupSizeKeyboard(sessionId: string, costSec: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const n of GROUP_SIZES) {
    kb.text(
      S.groupSizeLabel(n, groupSeat(costSec, n).seatCoins, config.FREE_TRIAL_COINS),
      `${GROUP_CB.size}:${sessionId}:${n}`,
    ).row();
  }
  return kb.text(S.GROUP_BTN.cancel, `${GROUP_CB.back}:${sessionId}`);
}

export function payRestKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard().text(S.GROUP_BTN.payRest, `${GROUP_CB.rest}:${sessionId}`);
}

export async function groupInviteText(api: Api, p: GroupProgress): Promise<string> {
  return S.groupInviteMessage({
    durationMs: p.costSec * 1000,
    seats: p.seats,
    seatCoins: p.seatCoins,
    giftCoins: config.FREE_TRIAL_COINS,
    link: await startLink(api, `${GROUP_START_PREFIX}${p.sessionId}`),
  });
}

/**
 * دعوت و خطِ زیرش را به مالک بفرست.
 *
 * `target` برای ربات است که همان چت را دارد؛ بی آن (مینی‌اپ) کانالِ تحویلِ
 * خودِ مالک. `false` یعنی مالک هیچ رباتی ندارد که دعوت به آن برسد.
 */
export async function sendGroupInvite(
  sessionId: string,
  target?: { api: Api; chatId: number },
): Promise<boolean> {
  const p = groupProgress(sessionId);
  if (!p) return false;
  const ch = target ?? deliveryChannel(p.ownerId);
  if (!ch) return false;
  await ch.api.sendMessage(ch.chatId, await groupInviteText(ch.api, p), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  await ch.api.sendMessage(ch.chatId, S.groupInviteTail(p.filled, p.seats), {
    parse_mode: "HTML",
    reply_markup: payRestKeyboard(sessionId),
  });
  return true;
}

export type Short = { ok: false; reason: "short"; seatSec: number; balanceSec: number };
export type Refused = { ok: false; reason: RefusalReason };

/** ترجمهٔ دو خطای دامنه به نتیجهٔ ساده؛ هر خطای دیگری واقعاً خطاست. */
function asOutcome(e: unknown): Short | Refused {
  if (e instanceof GroupBuyRefused) return { ok: false, reason: e.reason };
  if (e instanceof InsufficientCredit) {
    return { ok: false, reason: "short", seatSec: e.needed, balanceSec: e.balance };
  }
  throw e;
}

/** بازکردنِ گروه — همان راه برای ربات و مینی‌اپ. */
export function openGroup(o: {
  sessionId: string;
  ownerId: number;
  costSec: number;
  people: number;
  origin: GroupOrigin;
}): { ok: true; progress: GroupProgress } | Short | Refused {
  try {
    return { ok: true, progress: createGroupBuy(o) };
  } catch (e) {
    return asOutcome(e);
  }
}

/** وابستگی‌هایی که آزمون جایشان را می‌گیرد تا خط لولهٔ واقعی اجرا نشود. */
export interface StartDeps {
  startJob?: (spec: JobSpec) => void;
}

/** هم‌کلاسی «هستم» زد. اگر همین ورود گروه را پر کرد، کار شروع می‌شود. */
export async function joinGroup(
  sessionId: string,
  tgId: number,
  deps: StartDeps = {},
): Promise<{ ok: true; progress: GroupProgress; started: boolean } | Short | Refused> {
  let progress: GroupProgress;
  try {
    progress = joinGroupBuy(sessionId, tgId).progress;
  } catch (e) {
    return asOutcome(e);
  }
  const started = progress.full ? await startGroup(sessionId, deps) : false;
  if (!started) {
    await notifyUser(progress.ownerId, S.groupProgressMessage(progress.filled, progress.seats), {
      reply_markup: payRestKeyboard(sessionId),
    }).catch(() => {});
  }
  return { ok: true, progress: groupProgress(sessionId)!, started };
}

/** «بقیه‌اش رو خودم می‌دم، شروع کن». */
export async function payRestAndStart(
  sessionId: string,
  ownerId: number,
  deps: StartDeps = {},
): Promise<{ ok: true; started: boolean } | Short | Refused> {
  try {
    ownerPaysRest(sessionId, ownerId);
  } catch (e) {
    return asOutcome(e);
  }
  return { ok: true, started: await startGroup(sessionId, deps) };
}

function participants(sessionId: string): { owner: number; members: number[] } {
  const seats = groupSeats(sessionId);
  return {
    owner: seats.find((s) => s.role === "owner")!.tg_id,
    members: seats.filter((s) => s.role === "member").map((s) => s.tg_id),
  };
}

/**
 * گروهِ پر را قفل کن و کار را راه بینداز.
 *
 * `false` یعنی شروع نشد: یا گروه هنوز پر نیست، یا کسی زودتر شروعش کرد (دو
 * ورودِ همزمان روی آخرین جا)، یا فایل دیگر روی دیسک نیست — که آن‌وقت گروه
 * لغو و سکهٔ همه برگردانده می‌شود، چون کاری برای شروع نمانده.
 */
export async function startGroup(sessionId: string, deps: StartDeps = {}): Promise<boolean> {
  const s = getSession(sessionId);
  const p = groupProgress(sessionId);
  if (!s || !p || p.status !== "open" || !p.full) return false;

  if (!s.original_file || !fs.existsSync(s.original_file)) {
    const closed = cancelGroupBuy(sessionId);
    if (closed) await notifyClosed(closed, () => S.GROUP_FAILED_MEMBER, S.GROUP_FAILED_OWNER);
    logger.warn({ sessionId }, "group buy full but audio file is gone — refunded");
    return false;
  }
  if (!lockGroupBuy(sessionId)) return false;

  const { owner, members } = participants(sessionId);
  const audioFile = s.original_file;
  const run = deps.startJob ?? serviceStartJob;
  // آزمون رباتی ندارد و پیامِ زنده بی کانال خودش بی‌اثر است؛ ولی ساختنش را
  // هم به آزمون تحمیل نمی‌کنیم.
  const live = deps.startJob ? null : liveMessage(owner);

  await notifyUser(owner, S.GROUP_STARTED_OWNER).catch(() => {});
  for (const m of members) await notifyUser(m, S.GROUP_STARTED_MEMBER).catch(() => {});

  // آپلودِ مینی‌اپ تا تأیید بایگانی نمی‌شود؛ برای گروه، «پر شدن» همان تأیید است.
  // صوتِ ربات پیش‌تر، سرِ دریافت یا سرِ بازکردنِ گروه، به کانال رفته است.
  if (p.origin === "web" && !s.archive_message_id && !deps.startJob) {
    const u = getUser(owner);
    void archiveAudio(
      sessionId,
      { path: audioFile },
      audioCaption({
        sender: { tgId: owner, name: u?.name ?? null, username: u?.username ?? null },
        mode: "full",
        durationMs: p.costSec * 1000,
        sessionId,
        courseName: s.course_id ? (getCourse(s.course_id)?.name ?? null) : null,
        origin: "web",
      }),
      p.costSec,
    );
  }

  run({
    sessionId,
    userId: owner,
    audioFile,
    courseId: s.course_id,
    declaredDurationSec: p.costSec,
    mode: "full",
    groupBuy: true,
    onProgress: (st) => void live?.update(S.progressMessage(st.stage, st.detail)),
    onDone: async (out) => {
      const done = getSession(sessionId);
      if (done && out.report && !deps.startJob) {
        void archiveReport(done, out.report, done.course_id ? (getCourse(done.course_id)?.name ?? null) : null);
      }
      await live?.finish();
      if (done) {
        await deliverToBot(owner, done).catch((e: unknown) =>
          logger.warn({ sessionId, err: String(e) }, "group buy owner delivery failed"),
        );
      }
      /**
       * نتیجهٔ هم‌کلاسی‌ها **پشتِ دکمه**، نه یک‌باره.
       *
       * تحویلِ کامل صوت و خلاصه و جزوه است؛ فرستادنش همین حالا به چتی که
       * شاید دو روز پیش «هستم» زده، یعنی آپلودِ ده‌ها مگابایت برای کسی که
       * شاید اصلاً نگاه نکند. دکمه همان `deliverSession`ِ جزوهٔ شریکی را صدا
       * می‌زند، و جلسه همین حالا هم در «📚 جلسه‌های من» اوست.
       */
      for (const m of members) {
        await notifyUser(m, S.groupReadyMessage(done?.title ?? null), {
          reply_markup: new InlineKeyboard().text(S.GROUP_BTN.get, `${GROUP_CB.get}:${sessionId}`),
        }).catch(() => {});
      }
    },
    onError: async (message) => {
      const failed = getSession(sessionId);
      if (failed && !deps.startJob) void archiveFailure(failed, message);
      await live?.finish();
      await notifyUser(owner, S.GROUP_FAILED_OWNER).catch(() => {});
      for (const m of members) await notifyUser(m, S.GROUP_FAILED_MEMBER).catch(() => {});
    },
  });
  return true;
}

/** یک خبر به هر نفرِ گروهی که بسته شد. */
async function notifyClosed(
  closed: ClosedGroup,
  member: () => string,
  ownerText: string,
  ownerExtra: Record<string, unknown> = {},
): Promise<void> {
  for (const x of closed.participants) {
    const text = x.role === "owner" ? ownerText : member();
    await notifyUser(x.tgId, text, x.role === "owner" ? ownerExtra : {}).catch(() => {});
  }
}

/**
 * گروه‌های منقضی: سکه‌ها برمی‌گردند و به هر نفر یک جمله گفته می‌شود.
 *
 * از جاروی صوت صدا زده می‌شود و **پرچم را نمی‌سنجد**: اگر قابلیت خاموش شد
 * و گروهی باز مانده بود، سکه‌اش نباید تا ابد رزرو بماند.
 */
export async function expireGroupsAndNotify(now = new Date()): Promise<number> {
  const closed = expireGroupBuys(now);
  for (const c of closed) {
    await notifyClosed(
      c,
      () => S.groupExpiredMessage("member", c.origin, GROUP_BUY_HOURS),
      S.groupExpiredMessage("owner", c.origin, GROUP_BUY_HOURS),
      c.origin === "bot"
        ? { reply_markup: new InlineKeyboard().text(S.GROUP_BTN.resume, `go:${c.sessionId}`) }
        : {},
    );
  }
  return closed.length;
}
