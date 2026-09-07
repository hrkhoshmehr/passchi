/**
 * دسته‌بندیِ چیزی که به دانشجو نشان داده می‌شود.
 *
 * این آزمون از یک حذف نگهبانی می‌کند و از سه افزوده. دستهٔ «سایر» در چک‌لیست
 * در ۱۲ جلسه از ۲۷ جلسهٔ واقعی پر شد و هیچ‌بار چیز تازه‌ای نداشت — نیمی
 * تشریفاتِ دعا و خوش‌آمد، نیمی بازگوییِ همان روایتِ جلسه، و دو مورد واقعی که
 * برچسبشان غلط بود. حذفش وقتی بی‌خطر است که واقعیت‌های بی‌خانه خانه داشته
 * باشند، پس همان‌جا «منبع»، «راه ارتباطی» و «تصحیح استاد» اضافه شدند.
 *
 * چیزی که اینجا سنجیده می‌شود، همان چیزی است که اگر بشکند بی‌صدا می‌شکند:
 * یک نوعِ تازه که برچسبِ نمایشی ندارد، در پیام به‌صورت «•» یا اسم انگلیسیِ
 * خودش چاپ می‌شود و کسی تا رسیدنِ اسکرین‌شاتِ کاربر نمی‌فهمد.
 */
import { KeyPoint, ProfessorAction } from "../src/analysis/schema.ts";
import { repairAnalysis } from "../src/analysis/repair.ts";
import { KP_LABEL, extractedMessage } from "../src/bot/strings.ts";

let bad = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
};

const kinds = KeyPoint.shape.kind.options;
const actions = ProfessorAction.shape.action.options;

// ── حذفِ «سایر» ─────────────────────────────────────────────────────────
ok("چک‌لیست دستهٔ «سایر» ندارد", !actions.includes("other"), actions.join(", "));

const repaired = repairAnalysis({
  headline: "الف",
  professor_actions: [
    { action: "homework", happened: true, detail: "ت", evidence: { quote: "تمرین را حل کنید", at_ms: 1 } },
    { action: "other", happened: true, detail: "استاد جلسه را با دعا آغاز کرد", evidence: null },
    { action: "ceremony", happened: true, detail: "صلوات", evidence: null },
  ],
});
ok(
  "کارِ ناشناخته حذف می‌شود، نه اینکه به «سایر» برگردد",
  repaired.professor_actions.length === 1 && repaired.professor_actions[0].action === "homework",
  JSON.stringify(repaired.professor_actions.map((a) => a.action)),
);

// ── افزوده‌ها ───────────────────────────────────────────────────────────
for (const k of ["resource", "contact", "correction"]) {
  ok(`نوع «${k}» در اسکیما هست`, kinds.includes(k));
}

/**
 * **هر** نوع باید برچسب داشته باشد — نه فقط سه نوعِ تازه.
 *
 * قاعدهٔ عمومی است چون خطا هم عمومی است: نوعِ بعدی که به اسکیما اضافه شود
 * دقیقاً به همین شکل بی‌برچسب می‌ماند.
 */
for (const k of kinds) {
  ok(`برچسب نمایشی برای «${k}»`, Boolean(KP_LABEL[k]), "بدون برچسب، در پیام «•» چاپ می‌شود");
}

// ── ترتیب فیلدها: اول شاهد، بعد ادعا ───────────────────────────────────
//
// مدل فیلدها را به ترتیبِ اسکیما می‌نویسد. اگر evidence دوباره به ته شیء
// برود، مدل باز اول ادعا می‌سازد و بعد دنبال نقل‌قولی می‌گردد که بپوشاندش —
// همان مسیرِ نقل‌قولِ سرِهم‌شده که در دروازهٔ راستی‌آزمایی می‌میرد.
ok(
  "نقل‌قول اولین فیلد نکته است",
  Object.keys(KeyPoint.shape)[0] === "evidence",
  Object.keys(KeyPoint.shape).join(" → "),
);

// ── نمایش: هیچ نوعی خام چاپ نمی‌شود ────────────────────────────────────
const report = {
  session_title: "ج",
  headline: "ه",
  class_recap: "ر",
  chapters: [],
  topics: [],
  glossary: [],
  open_questions: [],
  next_session_hint: null,
  composition: [],
  silenceMs: 0,
  droppedCitations: 0,
  droppedUnverified: 0,
  droppedImportance: 0,
  demotedActions: 0,
  professor_actions: [],
  key_points: kinds.map((kind, i) => ({
    kind,
    title: `نکتهٔ ${kind}`,
    detail: "",
    due: null,
    evidence: { quote: "جملهٔ نمونه", at_ms: i * 1000, speaker: "استاد", verified: true, score: 1 },
  })),
};
const msg = extractedMessage(report);
for (const k of kinds) {
  ok(`نوع «${k}» با برچسب فارسی چاپ می‌شود`, msg.includes(KP_LABEL[k]));
}
ok("اسم انگلیسیِ نوع در پیام دیده نمی‌شود", !kinds.some((k) => msg.includes(`>${k}<`)));

console.log(bad ? `\n❌ ${bad} مورد قرمز` : "\n✅ همه سبز");
process.exit(bad ? 1 : 0);
