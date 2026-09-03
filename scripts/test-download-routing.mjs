/**
 * مسیریابی دانلود فایل، به تفکیک سکو.
 *
 * **باگی که این آزمون برای آن نوشته شد:** `download.ts` آدرس و توکن را از
 * `config.TELEGRAM_*` می‌خواند، در حالی که `getFile` روی `ctx.api` صدا زده
 * می‌شد. برای کاربر بله یعنی `file_path` را از بله می‌گرفتیم و بعد همان را با
 * توکن تلگرام از سرور تلگرام می‌خواستیم — ۴۰۴، هربار، برای هر فایل. یک کاربر
 * پول داد و شش بار تلاش کرد و هیچ‌وقت نتوانست حتی یک فایل بفرستد.
 *
 * چرا لاگ هم نجاتش نداد: پیام خطا می‌گفت «یه بار دیگه بفرست» و «حجمش زیاده»؛
 * هیچ‌کدام ربطی به علت نداشت، پس نه کاربر فهمید نه ما.
 *
 * دو بخش دارد:
 *   • بخش خالص — بدون شبکه، همیشه اجرا می‌شود.
 *   • بخش زنده — اگر `BALE_BOT_TOKEN` و `BALE_ADMIN_IDS` باشند، یک فایل واقعی
 *     آپلود و دوباره دانلود می‌شود. تنها راهِ گرفتن این خانواده از باگ همین
 *     رفت‌وبرگشت واقعی است؛ ماک از اول همان فرضِ غلط را تکرار می‌کند.
 *
 * اجرا: npx tsx scripts/test-download-routing.mjs
 */
/**
 * `.env` **پیش از** مقادیر جایگزین بار می‌شود.
 *
 * `dotenv` متغیری را که از قبل ست باشد بازنویسی نمی‌کند، پس اگر اول
 * `BALE_BOT_TOKEN` را روی مقدار ساختگی بگذاریم، توکن واقعی دیگر خوانده
 * نمی‌شود و بخش زنده **همیشه** بی‌صدا رد می‌شود — یعنی آزمونی که برای گرفتن
 * این باگ نوشته شده، روی سرور هرگز اجرا نمی‌شود و سبزیِ آن بی‌معنی است.
 */
await import("dotenv/config");
process.env.BOT_TOKEN ||= "telegram-token-for-test";
process.env.BALE_BOT_TOKEN ||= "bale-token-for-test";

const { setBaleApi, isBale } = await import("../src/bot/identity.ts");
const { downloadLimitFor, FileTooLargeError } = await import("../src/bot/download.ts");
const { config } = await import("../src/config.ts");

let bad = 0;
function ok(label, cond, detail) {
  if (!cond) bad++;
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond && detail) console.log(`   ${detail}`);
}

// ─── بخش خالص ───────────────────────────────────────────────────────────────

// شبیه‌سازی همان چیزی که grammY می‌سازد: برای هر آپدیت یک `Api` تازه با همان
// توکن. اگر تشخیص سکو روی برابریِ *شیء* بنشیند، اینجا می‌شکند — همان باگی که
// یک بار افتاد و در `identity.ts` مفصل توضیح داده شده.
const baleApi = { token: config.BALE_BOT_TOKEN };
const freshBaleApi = { token: config.BALE_BOT_TOKEN };
const tgApi = { token: config.BOT_TOKEN };

setBaleApi(baleApi);

ok("خودِ نمونهٔ بله شناخته می‌شود", isBale(baleApi));
ok("نمونهٔ تازهٔ بله هم شناخته می‌شود (grammY هر آپدیت یکی می‌سازد)", isBale(freshBaleApi));
ok("تلگرام با بله اشتباه نمی‌شود", !isBale(tgApi));

const MB = 1024 * 1024;
ok(
  "سقف بله ۵۰ مگابایت است",
  downloadLimitFor(baleApi) === 50 * MB,
  `گرفتیم ${downloadLimitFor(baleApi) / MB} مگابایت`,
);
ok(
  "سقف تلگرام با بله یکی نیست",
  downloadLimitFor(tgApi) !== downloadLimitFor(baleApi),
  "اگر یکی باشد یعنی مسیر سکو دوباره نادیده گرفته شده",
);

// خطا باید سقف را حمل کند، وگرنه پیام نمی‌تواند عدد بدهد و دوباره به همان
// «حجمش زیاده»ی بی‌معنی برمی‌گردیم.
const err = new FileTooLargeError(60 * MB, 50 * MB);
ok("خطای حجم، اندازه و سقف را با خود می‌برد", err.sizeBytes === 60 * MB && err.limitBytes === 50 * MB);

// ─── بخش زنده ───────────────────────────────────────────────────────────────

const liveToken = config.BALE_BOT_TOKEN;
const admin = config.BALE_ADMIN_IDS?.[0];
const live = liveToken && liveToken !== "bale-token-for-test" && admin;

if (!live) {
  console.log("\n⏭️  بخش زندهٔ بله رد شد (BALE_BOT_TOKEN یا BALE_ADMIN_IDS نیست).");
} else {
  const ROOT = config.BALE_API_ROOT.replace(/\/+$/, "");
  console.log("\n── رفت‌وبرگشت واقعی با بله ──");

  // فایل کوچکِ ساختگی؛ محتوایش مهم نیست، فقط باید بایت‌به‌بایت برگردد.
  const payload = Buffer.alloc(64 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const B = `----test${Date.now().toString(36)}`;
  const body = Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${admin}\r\n`),
    Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="document"; filename="routing-test.bin"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    payload,
    Buffer.from(`\r\n--${B}--\r\n`),
  ]);

  const sent = await fetch(`${ROOT}/bot${liveToken}/sendDocument`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${B}` },
    body: new Uint8Array(body),
  }).then((r) => r.json());

  ok("آپلود آزمایشی به بله رفت", sent.ok === true, sent.description);

  if (sent.ok) {
    const media = sent.result.document ?? sent.result.audio;

    // اندازهٔ آپدیت درست است — و همین است که `declaredSize` از آن می‌آید.
    ok(
      "اندازهٔ اعلام‌شده در آپدیت درست است",
      media.file_size === payload.length,
      `گرفتیم ${media.file_size}، انتظار ${payload.length}`,
    );

    const gf = await fetch(
      `${ROOT}/bot${liveToken}/getFile?file_id=${encodeURIComponent(media.file_id)}`,
    ).then((r) => r.json());
    ok("getFile جواب داد", gf.ok === true, JSON.stringify(gf).slice(0, 200));

    if (gf.ok) {
      /**
       * **`getFile.file_size` روی بله دروغ می‌گوید.** برای یک فایل ۳۰
       * مگابایتی عدد `85` برگرداند. این آزمون آن را «خطا» نمی‌شمارد چون
       * رفتار خودِ بله است و ما تغییرش نمی‌دهیم — فقط اگر روزی درست شد
       * می‌خواهیم بدانیم، و مهم‌تر اینکه یادآوری کند هیچ‌جا به آن تکیه نکنیم.
       */
      if (gf.result.file_size !== payload.length) {
        console.log(
          `ℹ️  getFile.file_size همچنان غیرقابل‌اعتماد است ` +
            `(${gf.result.file_size} به‌جای ${payload.length}) — به آن تکیه نکن.`,
        );
      }

      // آدرسِ درست: همان که `originOf` می‌سازد.
      const good = await fetch(`${ROOT}/file/bot${liveToken}/${gf.result.file_path}`);
      const bytes = Buffer.from(await good.arrayBuffer());
      ok("دانلود از آدرسِ بله ۲۰۰ داد", good.status === 200, `HTTP ${good.status}`);
      ok(
        "بایت‌ها سالم برگشتند",
        bytes.length === payload.length && bytes.equals(payload),
        `گرفتیم ${bytes.length} بایت، انتظار ${payload.length}`,
      );

      /**
       * و همان درخواست روی سرور تلگرام — یعنی دقیقاً کاری که کد قبلی می‌کرد.
       * باید **شکست بخورد**. اگر روزی این ۲۰۰ بدهد یعنی فرضِ ما عوض شده و
       * باید دوباره نگاه کنیم.
       */
      const wrong = await fetch(
        `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${gf.result.file_path}`,
      ).catch(() => null);
      ok(
        "آدرس تلگرام برای فایل بله شکست می‌خورد (باگ اصلی)",
        !wrong || !wrong.ok,
        `انتظار خطا داشتیم ولی HTTP ${wrong?.status} گرفتیم`,
      );
    }

    // پاک‌سازی: پیام آزمایشی در چت ادمین نماند.
    await fetch(`${ROOT}/bot${liveToken}/deleteMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: admin, message_id: sent.result.message_id }),
    }).catch(() => {});
  }
}

console.log(bad === 0 ? "\n🎉 همه سبز" : `\n💥 ${bad} مورد قرمز`);
process.exit(bad === 0 ? 0 : 1);
