/**
 * صوت نمونهٔ تور را یک بار به هر سکو می‌فرستد و `file_id`اش را چاپ می‌کند.
 *
 * چرا دستی و نه خودکار: فایل ۱۶ مگابایت است و جای یک باینری با این اندازه در
 * تاریخچهٔ git نیست. یک بار فرستاده می‌شود، شناسه‌اش در `.env` می‌نشیند، و از
 * آن به بعد تور فقط همان ارجاع را می‌فرستد — بی‌آنکه فایل روی سرور لازم باشد.
 *
 * مقصد، **چتِ خودِ ربات** است (`getMe().id`): پیام جایی دیده نمی‌شود ولی
 * شناسه ساخته می‌شود. فرستادن به کانال بایگانی هم کار می‌کرد، ولی آنجا
 * محتوای کاربران است و شلوغش نمی‌کنیم.
 *
 * ⚠️ شناسه به توکن ربات گره خورده. با عوض‌شدن توکن، دوباره اجرا کن.
 *
 * اجرا:
 *   node --import tsx scripts/upload-sample.mjs <path-to-audio.mp3>
 */
import fs from "node:fs";
import { Bot, InputFile } from "grammy";
import { config } from "../src/config.ts";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("استفاده: node --import tsx scripts/upload-sample.mjs <audio.mp3>");
  process.exit(1);
}
const sizeMb = fs.statSync(file).size / 1024 / 1024;
console.log(`فایل: ${file} — ${sizeMb.toFixed(1)} مگابایت\n`);

if (sizeMb > 20) {
  console.log("⚠️  بالای بیست مگابایت است؛ بله احتمالاً نمی‌پذیرد. اول فشرده‌اش کن.\n");
}

const targets = [
  { name: "telegram", token: config.BOT_TOKEN, env: "SAMPLE_AUDIO_FILE_ID", apiRoot: undefined },
  {
    name: "bale",
    token: config.BALE_BOT_TOKEN,
    env: "SAMPLE_AUDIO_FILE_ID_BALE",
    apiRoot: config.BALE_API_ROOT.replace(/\/+$/, ""),
  },
];

const found = [];
for (const t of targets) {
  if (!t.token) {
    console.log(`⏭  ${t.name}: توکن تنظیم نشده، رد شد`);
    continue;
  }
  const bot = new Bot(t.token, t.apiRoot ? { client: { apiRoot: t.apiRoot } } : undefined);
  try {
    const me = await bot.api.getMe();
    const msg = await bot.api.sendAudio(me.id, new InputFile(file, "نمونه-صوت.mp3"), {
      caption: "صوت نمونهٔ تور — برای گرفتن file_id",
    });
    const id = msg.audio?.file_id;
    if (!id) throw new Error("پاسخ file_id نداشت");
    console.log(`✅ ${t.name}: @${me.username}`);
    found.push([t.env, id]);
  } catch (e) {
    console.log(`❌ ${t.name}: ${String(e).slice(0, 160)}`);
  }
}

if (found.length) {
  console.log("\nاین خط‌ها را در `.env` سرور بگذار:\n");
  for (const [env, id] of found) console.log(`${env}=${id}`);
  console.log("\nبعدش سرویس را ری‌استارت کن.");
}
