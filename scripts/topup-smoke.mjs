/**
 * دود‌آزمای مسیر شارژ روی یک پایگاه‌دادهٔ موقت.
 *
 * اجرا: DATA_DIR=./data/tmp-topup node scripts/topup-smoke.mjs
 */
process.env.CARD_NUMBER ||= "6037-9999-8888-7777";
process.env.CARD_HOLDER ||= "حمیدرضا";
process.env.ADMIN_IDS ||= "111";
process.env.BOT_TOKEN ||= "x";

const { upsertUser, getUser, openTopup, setTopupStatus, pendingTopups } = await import("../src/db/index.ts");
const { beginTopup, decide } = await import("../src/bot/topup.ts");
const { balanceCoins } = await import("../src/billing/coins.ts");

const TG = 4242;
upsertUser(TG, "دانشجوی نمونه", "student");
console.log("موجودی اولیه:", balanceCoins(getUser(TG).credit_sec), "سکه");

const order = beginTopup(TG, "p2");
console.log("\n— پیام پرداخت —\n" + order.text.replace(/<\/?[a-z][^>]*>/g, ""));

const open = openTopup(TG);
console.log("\nسفارش باز:", open.id, open.status);

setTopupStatus(open.id, "pending", { receiptFileId: "FAKE_PHOTO" });
console.log("منتظر تأیید:", pendingTopups().length);

const api = {
  sendMessage: async (id, text) => console.log(`\n[پیام به ${id}]\n` + text.replace(/<\/?[a-z][^>]*>/g, "")),
  sendPhoto: async () => {},
};
console.log("\nتصمیم:", (await decide(api, open.id, 111, true)).toast);
console.log("موجودی نهایی:", balanceCoins(getUser(TG).credit_sec), "سکه");
console.log("تأیید دوباره:", (await decide(api, open.id, 111, true)).toast);
