import { SHORT_DESCRIPTION, DESCRIPTION, COMMANDS } from "../src/bot/profile.js";
console.log("توضیح کوتاه:", SHORT_DESCRIPTION.length, "از ۱۲۰");
console.log("توضیح بلند: ", DESCRIPTION.length, "از ۵۱۲");
console.log("دستورها:", COMMANDS.length);
for (const c of COMMANDS) console.log(`  /${c.command.padEnd(9)} ${c.description}`);
