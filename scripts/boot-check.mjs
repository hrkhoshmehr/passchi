/** بارگذاری ماژول ربات بدون اتصال به تلگرام — تلهٔ خطاهای زمان بارگذاری. */
import { SHORT_DESCRIPTION, DESCRIPTION, COMMANDS } from "../src/bot/profile.ts";
console.log("توضیح کوتاه:", SHORT_DESCRIPTION.length, "/120");
console.log("توضیح بلند:", DESCRIPTION.length, "/512");
console.log("دستورها:", COMMANDS.map((c) => "/" + c.command).join(" "));
const { bot } = await import("../src/bot/index.ts");
console.log("ماژول ربات بارگذاری شد:", typeof bot);
