/**
 * پاسچی — اپ وب و مینی‌اپ.
 *
 * یک فایل، سه سکو. تفاوت سکوها فقط در **ورود** است:
 *
 *   • داخل مینی‌اپ تلگرام یا بله، `initData` آماده است و ورود بی‌صدا و
 *     خودکار انجام می‌شود — کاربر هیچ فرمی نمی‌بیند.
 *   • در مرورگر، شماره و کد پیامکی — که **فعلاً خاموش است**.
 *
 * تا وقتی سرویس پیامک راه نیفتاده، `GET /api/config` مقدار `phoneLogin:false`
 * می‌دهد و به‌جای فرم، دو دکمهٔ «باز کردن در تلگرام / بله» نشان داده می‌شود.
 * فرمی که سرور جوابش را رد کند، بدتر از نبودنش است.
 *
 * بعد از آن، همه‌چیز یکی است: همان توکن، همان API، همان صفحه‌ها.
 *
 * بدون فریم‌ورک نوشته شده. کل حالت اپ چند متغیر است و رندر هم چند تابع که
 * رشته می‌سازند؛ آوردن یک فریم‌ورک برای این حجم فقط یک مرحلهٔ ساخت اضافه
 * می‌کرد بی‌آنکه چیزی ساده‌تر شود.
 */

const $ = (id) => document.getElementById(id);
const api = {
  /** توکن نشست. در `localStorage` می‌ماند تا با بستن اپ از بین نرود. */
  token: localStorage.getItem("passchi_token") || null,

  async call(path, opt = {}) {
    const headers = { ...(opt.headers || {}) };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opt.body && !(opt.body instanceof Blob) && typeof opt.body !== "string") {
      headers["content-type"] = "application/json";
      opt = { ...opt, body: JSON.stringify(opt.body) };
    }
    const res = await fetch(path, { ...opt, headers });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw Object.assign(new Error(data.error || "خطایی رخ داد."), { data, status: res.status });
    return data;
  },

  set(token) {
    this.token = token;
    localStorage.setItem("passchi_token", token);
  },
  clear() {
    this.token = null;
    localStorage.removeItem("passchi_token");
  },
};

// ─── کمکی‌های نمایش ─────────────────────────────────────────────────────────

const FA = "۰۱۲۳۴۵۶۷۸۹";
const fa = (n) => String(n).replace(/[0-9]/g, (d) => FA[+d]);
const faGroup = (n) => fa(Number(n).toLocaleString("en-US")).replace(/,/g, "٬");

/**
 * ارزش یک پکیج به زبان کاربر: «۳ کلاس ۹۰ دقیقه‌ای».
 *
 * همان قاعدهٔ ربات — عددِ سکه به‌تنهایی نمی‌گوید چند جلسه می‌شود فرستاد، و آن
 * سؤالی است که کاربر پیش از خرید در ذهن دارد. زیر یک کلاس، به دقیقه می‌افتد.
 */
function pkgWorth(coins, coinsPerMinute) {
  const minutes = Math.floor(coins / (coinsPerMinute || 1));
  const classes = Math.floor(minutes / 90);
  return classes >= 1 ? `${fa(classes)} کلاس ۹۰ دقیقه‌ای` : `${fa(minutes)} دقیقه صوت`;
}

/** میلی‌ثانیه به «۱ ساعت و ۳۴ دقیقه» یا «۴۲ دقیقه» */
function dur(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${fa(min)} دقیقه`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${fa(h)} ساعت و ${fa(m)} دقیقه` : `${fa(h)} ساعت`;
}

/** میلی‌ثانیه به `MM:SS` — برای ارجاع به لحظهٔ صوت */
function clock(ms) {
  const s = Math.floor(ms / 1000);
  return fa(`${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`);
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function show(el, on = true) {
  el.classList.toggle("hidden", !on);
}

function fail(el, message) {
  el.textContent = message;
  show(el, Boolean(message));
}

// ─── مسیریابی صفحه‌ها ───────────────────────────────────────────────────────

let current = "auth";

function go(name) {
  current = name;
  for (const s of document.querySelectorAll(".screen")) {
    s.classList.toggle("on", s.id === `s-${name}`);
  }
  for (const t of document.querySelectorAll(".tab")) {
    t.classList.toggle("on", t.dataset.go === name);
  }
  // نوار پایین فقط بعد از ورود، و نه روی صفحه‌های تودرتو
  show($("tabs"), name !== "auth");
  show($("balance"), name !== "auth");
  window.scrollTo(0, 0);
}

for (const t of document.querySelectorAll(".tab")) {
  t.addEventListener("click", () => {
    go(t.dataset.go);
    if (t.dataset.go === "list") loadList();
    if (t.dataset.go === "acct") loadAccount();
  });
}
$("balance").addEventListener("click", () => {
  go("acct");
  loadAccount();
});

// ─── سکو ────────────────────────────────────────────────────────────────────

/**
 * مینی‌اپِ میزبان، اگر داخل یکی هستیم.
 *
 * هر دو سکو شیء هم‌شکل می‌سازند. `initData` تهی یعنی اسکریپت بار شده ولی
 * صفحه داخل مینی‌اپ باز نشده — یعنی مرورگر معمولی.
 */
function host() {
  const tg = globalThis.Telegram?.WebApp;
  if (tg?.initData) return { platform: "telegram", sdk: tg };
  const bale = globalThis.Bale?.WebApp;
  if (bale?.initData) return { platform: "bale", sdk: bale };
  return null;
}

const miniApp = host();

if (miniApp) {
  const { sdk } = miniApp;
  sdk.ready?.();
  sdk.expand?.();
  /**
   * تم را از میزبان بگیر.
   *
   * مینی‌اپ داخل اپلیکیشنی باز می‌شود که کاربر تمش را انتخاب کرده؛ اگر
   * صفحه تم خودش را تحمیل کند، وسط یک اپ تاریک یک صفحهٔ سفید باز می‌شود.
   */
  const theme = sdk.colorScheme;
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  }
}

// ─── ورود ───────────────────────────────────────────────────────────────────

let me = null;

async function loadMe() {
  me = await api.call("/api/me");
  $("coins").textContent = faGroup(me.coins);
  show($("free-banner"), me.freeRunAvailable);
  return me;
}

/** بعد از هر ورودِ موفق: حساب را بخوان و برو به صفحهٔ ارسال. */
async function afterLogin(token) {
  api.set(token);
  await loadMe();
  await loadCourses();
  go("send");
}

/**
 * ورود خودکار داخل مینی‌اپ.
 *
 * `initData` هر بار که مینی‌اپ باز می‌شود تازه است، پس نیازی به نگه‌داشتن
 * توکن قدیمی نیست — ولی اگر توکن معتبری داشتیم، همان استفاده می‌شود تا یک
 * رفت‌وبرگشت کمتر شود.
 */
async function boot() {
  if (api.token) {
    try {
      await loadMe();
      await loadCourses();
      go("send");
      return;
    } catch {
      api.clear(); // توکن منقضی شده
    }
  }

  if (miniApp) {
    try {
      const { token } = await api.call("/api/auth/miniapp", {
        method: "POST",
        body: { platform: miniApp.platform, initData: miniApp.sdk.initData },
      });
      await afterLogin(token);
      return;
    } catch (e) {
      // ورود مینی‌اپ شکست خورد — صفحهٔ ورود را نشان بده تا کاربر گیر نکند
      console.warn("mini app login failed:", e.message);
    }
  }

  await showAuthScreen();
}

/**
 * صفحهٔ ورود، متناسب با درهایی که سرور باز گذاشته.
 *
 * فرم شماره فقط وقتی ساخته می‌شود که سرور بگوید کار می‌کند؛ وگرنه کاربر
 * شماره‌اش را وارد می‌کند و «فعال نیست» می‌گیرد و فکر می‌کند خراب است.
 *
 * اگر خواندن پیکربندی شکست بخورد، **بسته** فرض می‌شود: پیش‌فرضِ امن آن است
 * که کاربر را به ربات بفرستیم، نه به فرمی که احتمالاً جواب نمی‌دهد.
 */
async function showAuthScreen() {
  let phoneLogin = false;
  let bots = {};
  try {
    ({ phoneLogin, bots = {} } = await api.call("/api/config"));
  } catch (e) {
    console.warn("config fetch failed, assuming phone login is off:", e.message);
  }

  // هر دکمه فقط وقتی نشان داده می‌شود که آدرسش را داشته باشیم؛ دکمه‌ای که
  // به هیچ‌جا نبرد، بدتر از نبودنش است.
  for (const [id, url] of [["open-tg", bots.telegram], ["open-bale", bots.bale]]) {
    const el = $(id);
    if (url) el.href = url;
    show(el, Boolean(url));
  }

  show($("form-phone"), phoneLogin);
  show($("auth-bots"), !phoneLogin);
  $("auth-lead").textContent = phoneLogin
    ? "برای شروع شماره‌ات رو وارد کن"
    : "از داخل تلگرام یا بله وارد شو — همون‌جا صوت کلاستو هم می‌فرستی.";

  go("auth");
}

$("form-phone").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("phone-btn");
  fail($("phone-err"), "");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    await api.call("/api/auth/otp/request", {
      method: "POST",
      body: { phone: $("phone").value },
    });
    show($("form-phone"), false);
    show($("form-code"), true);
    // `devCode` حذف شد: ورود با شماره فقط وقتی باز است که سرویس پیامک واقعاً
    // تنظیم باشد، پس دیگر حالتی نیست که کد در پاسخ برگردد.
    $("code").focus();
  } catch (err) {
    fail($("phone-err"), err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "ارسال کد";
  }
});

$("form-code").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("code-btn");
  fail($("code-err"), "");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const { token } = await api.call("/api/auth/otp/verify", {
      method: "POST",
      body: { phone: $("phone").value, code: $("code").value },
    });
    await afterLogin(token);
  } catch (err) {
    fail($("code-err"), err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "ورود";
  }
});

$("back-phone").addEventListener("click", () => {
  show($("form-code"), false);
  show($("form-phone"), true);
  fail($("code-err"), "");
});

// ─── درس‌ها ─────────────────────────────────────────────────────────────────

async function loadCourses() {
  try {
    const { courses } = await api.call("/api/courses");
    const sel = $("course");
    sel.innerHTML =
      '<option value="">بدون درس</option>' +
      courses.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    show($("course-pick"), courses.length > 0);
  } catch {
    /* نبودِ فهرست درس‌ها نباید جلوی ارسال صوت را بگیرد */
  }
}

// ─── ارسال صوت ──────────────────────────────────────────────────────────────

const drop = $("drop");
const fileInput = $("file");

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) upload(fileInput.files[0]);
});

/**
 * مدت فایل را پیش از آپلود از خودِ مرورگر بپرس.
 *
 * سرور برای **رزرو اعتبار** به مدت نیاز دارد و بدون آن باید کل فایل را اول
 * بگیرد و بعد بفهمد کاربر پولش نمی‌رسد. اگر مرورگر نتوانست بخواند، صفر
 * برمی‌گردد و سرور با حداقلِ رزرو جلو می‌رود — تسویهٔ نهایی به‌هرحال با مدت
 * واقعی انجام می‌شود، پس این عدد فقط یک تخمین است نه مبنای محاسبه.
 */
function durationOf(file) {
  return new Promise((resolve) => {
    const el = document.createElement("audio");
    el.preload = "metadata";
    const url = URL.createObjectURL(file);
    const done = (v) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? Math.round(el.duration) : 0);
    el.onerror = () => done(0);
    el.src = url;
    setTimeout(() => done(0), 5000);
  });
}

async function upload(file) {
  fail($("send-err"), "");
  const seconds = await durationOf(file);
  const ext = (file.name.split(".").pop() || "ogg").toLowerCase();
  const courseId = $("course").value;

  go("prog");
  renderProgress({ stage: "upload" });

  const qs = new URLSearchParams({ duration: String(seconds), ext });
  if (courseId) qs.set("courseId", courseId);

  let out;
  try {
    out = await api.call(`/api/sessions/upload?${qs}`, { method: "POST", body: file });
  } catch (err) {
    // کمبود اعتبار پیام مخصوص خودش را دارد، با عددها
    if (err.status === 402) {
      const d = err.data || {};
      fail(
        $("prog-err"),
        `اعتبارت کم است — این جلسه ${faGroup(d.needCoins ?? 0)} سکه می‌خواهد و ${faGroup(d.haveCoins ?? 0)} سکه داری.`,
      );
    } else {
      fail($("prog-err"), err.message);
    }
    return;
  }

  watch(out.sessionId);
}

// ─── پیشرفت ─────────────────────────────────────────────────────────────────

const STEPS = [
  { key: "upload", label: "دریافت فایل" },
  { key: "preprocess", label: "آماده‌سازی صوت" },
  { key: "stt", label: "پیاده‌سازی متن" },
  { key: "analyze", label: "تحلیل جلسه" },
  { key: "pdf", label: "ساخت جزوه" },
];

function renderProgress(p) {
  const at = STEPS.findIndex((s) => s.key === p.stage);
  $("prog-steps").innerHTML = STEPS.map((s, i) => {
    const state = p.stage === "done" || i < at ? "done" : i === at ? "now" : "";
    const detail = state === "now" && p.detail ? `<div class="pstep-detail">${esc(p.detail)}</div>` : "";
    return `<div class="pstep ${state}">
      <div class="bullet">${state === "done" ? "✓" : ""}</div>
      <div><div>${s.label}</div>${detail}</div>
    </div>`;
  }).join("");
}

let poll = null;

/**
 * وضعیت کار را تا پایان دنبال کن.
 *
 * نظرسنجی ساده به‌جای وب‌سوکت: کار چند دقیقه طول می‌کشد و هر دو ثانیه یک
 * درخواست کوچک، در برابر پیچیدگی نگه‌داشتن اتصال زنده در مینی‌اپی که ممکن
 * است به پس‌زمینه برود، معاملهٔ بهتری است.
 */
function watch(sessionId) {
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const { progress, status } = await api.call(`/api/sessions/${sessionId}/progress`);
      renderProgress(progress);

      if (progress.stage === "error" || status === "error") {
        clearInterval(poll);
        fail($("prog-err"), progress.message || "پردازش ناموفق بود. سکه‌های رزروشده برگشت.");
        loadMe().catch(() => {});
        return;
      }
      if (progress.stage === "done" || status === "done") {
        clearInterval(poll);
        await loadMe().catch(() => {});
        openSession(sessionId);
      }
    } catch (e) {
      clearInterval(poll);
      fail($("prog-err"), e.message);
    }
  }, 2000);
}

// ─── فهرست جلسه‌ها ──────────────────────────────────────────────────────────

const STATUS_FA = {
  queued: "در صف",
  preprocess: "آماده‌سازی",
  stt: "پیاده‌سازی",
  analyze: "تحلیل",
  pdf: "ساخت جزوه",
  done: "آماده",
  error: "ناموفق",
  cancelled: "لغو شد",
};

async function loadList() {
  const box = $("list");
  box.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const { sessions } = await api.call("/api/sessions");
    if (!sessions.length) {
      box.innerHTML = `<div class="empty">
        <div class="empty-ico">📭</div>
        <p style="margin-top:10px">هنوز جلسه‌ای نفرستادی</p>
        <p class="dim">یه صوت بفرست تا شروع کنیم</p>
      </div>`;
      return;
    }
    box.innerHTML = sessions
      .map((s) => {
        const cls = s.status === "done" ? "ok" : s.status === "error" ? "err" : "run";
        const meta = [
          s.createdAt?.slice(0, 10),
          s.durationMs ? dur(s.durationMs) : null,
          s.transcriptOnly ? "فقط رونوشت" : null,
        ].filter(Boolean);
        return `<div class="item" data-id="${s.id}">
          <div class="item-title">${esc(s.title || "بدون عنوان")}</div>
          <div class="item-meta">
            <span class="badge ${cls}">${STATUS_FA[s.status] || s.status}</span>
            ${meta.map((m) => `<span>${esc(m)}</span>`).join("")}
          </div>
        </div>`;
      })
      .join("");
    for (const el of box.querySelectorAll(".item")) {
      el.addEventListener("click", () => openSession(el.dataset.id));
    }
  } catch (e) {
    box.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

$("back-list").addEventListener("click", () => {
  go("list");
  loadList();
});

// ─── یک جلسه ────────────────────────────────────────────────────────────────

/*
 * برچسب‌ها، هم‌نام با `src/bot/strings.ts`.
 *
 * تکرار شده‌اند چون کلاینت به کد سرور دسترسی ندارد و ساختن یک مسیر API فقط
 * برای چند رشتهٔ ثابت نمی‌ارزید. اگر آنجا عوض شد، اینجا هم باید عوض شود.
 */
const KP_FA = {
  exam: "🎯 در امتحان می‌آید",
  emphasis: "⚑ تأکید استاد",
  homework: "📝 تکلیف",
  deadline: "⏳ مهلت",
  grading: "💯 نمره و بارم",
  logistics: "📌 تصمیم کلاس",
};

const ACTION_FA = {
  attendance: "حضور و غیاب",
  quiz: "کوییز",
  homework: "تکلیف",
  deadline: "مهلت",
  exam_info: "اطلاعات امتحان",
  grading: "نمره و بارم",
  makeup_class: "کلاس جبرانی",
  class_cancelled: "لغو جلسه",
  other: "سایر",
};

/** جملهٔ منفیِ قطعی — «کوییز نگرفت»، نه فهرست خالی. */
const ACTION_NO = {
  attendance: "حضور و غیاب نکرد",
  quiz: "کوییز نگرفت",
  exam_info: "دربارهٔ امتحان چیزی نگفت",
  homework: "تکلیفی نداد",
  deadline: "مهلتی تعیین نکرد",
  grading: "دربارهٔ نمره و بارم صحبتی نکرد",
  makeup_class: "کلاس جبرانی اعلام نکرد",
  class_cancelled: "جلسه‌ای را لغو نکرد",
};

const KIND_FA = {
  teaching: "تدریس",
  qa: "پرسش و پاسخ",
  admin: "امور کلاس",
  offtopic: "حاشیه",
  technical: "مشکل فنی",
  break: "سکوت و وقفه",
};

async function openSession(id) {
  go("one");
  const box = $("one");
  box.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const { session, report } = await api.call(`/api/sessions/${id}`);
    box.innerHTML = renderSession(session, report, id);
  } catch (e) {
    box.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

function renderSession(s, report, id) {
  const parts = [];

  parts.push(`<h2 style="font-size:21px;margin-top:14px">${esc(s.title || "جلسهٔ کلاس")}</h2>
    <p class="dim" style="margin-top:6px">
      ${[s.date, s.durationMs ? dur(s.durationMs) : null].filter(Boolean).map(esc).join(" · ")}
    </p>`);

  if (s.status === "error") {
    parts.push(`<div class="err" style="margin-top:16px">${esc(s.error || "پردازش ناموفق بود.")}</div>`);
  }

  if (report?.class_recap || report?.headline) {
    parts.push(`<div class="rep-section">
      <h3>📋 کلاس چه خبر بود</h3>
      <div class="note">${esc(report.class_recap || report.headline)}</div>
    </div>`);
  }

  /**
   * چک‌لیست کارهای استاد — با پاسخ منفیِ صریح.
   *
   * «کوییز نگرفت» نوشته می‌شود، نه اینکه ردیفش حذف شود. دانشجویی که کلاس
   * نبوده دقیقاً همین را می‌پرسد، و سکوت را نمی‌شود «یعنی نگرفت» تفسیر کرد.
   * پشتوانه‌اش واقعی است: کل رونوشت خوانده شده و هر ادعا از دروازهٔ
   * راستی‌آزمایی رد شده.
   */
  if (report?.professor_actions?.length) {
    parts.push(`<div class="rep-section">
      <h3>✅ کارهای استاد</h3>
      ${report.professor_actions
        .map((a) => {
          const label = ACTION_FA[a.action] ?? a.action;
          if (!a.happened) {
            return `<div class="note"><span class="dim">${esc(ACTION_NO[a.action] ?? `${label} نداشت`)}</span></div>`;
          }
          return `<div class="note">
            <b>${esc(label)}</b>${a.detail ? ` — ${esc(a.detail)}` : ""}
            ${a.evidence?.quote ? `<div class="note-q">«${esc(a.evidence.quote)}»</div>` : ""}
          </div>`;
        })
        .join("")}
    </div>`);
  }

  /**
   * نکته‌ها — قلبِ محصول.
   *
   * هر نکته نقل‌قول تأییدشده و زمانش را همراه دارد. زمان نمایش داده می‌شود
   * چون کاربر باید بتواند خودش برود و گوش بدهد؛ همان چیزی که «ذکر منبع» را
   * از یک ادعا به یک ارجاع تبدیل می‌کند.
   */
  if (report?.key_points?.length) {
    parts.push(`<div class="rep-section">
      <h3>⭐ چی از کلاس درآوردم</h3>
      ${report.key_points
        .map(
          (k) => `<div class="note star">
            <div class="dim" style="font-size:13px">${esc(KP_FA[k.kind] ?? k.kind)}</div>
            <div style="margin-top:6px"><b>${esc(k.title)}</b></div>
            ${k.detail ? `<div class="muted" style="font-size:14.3px;margin-top:6px">${esc(k.detail)}</div>` : ""}
            ${k.due ? `<div class="dim" style="margin-top:6px">⏳ مهلت: ${esc(k.due)}</div>` : ""}
            ${
              k.evidence?.quote
                ? `<div class="note-q">
                     ${k.evidence.at_ms != null ? `<span class="ts">${clock(k.evidence.at_ms)}</span> ` : ""}
                     «${esc(k.evidence.quote)}»
                   </div>`
                : ""
            }
          </div>`,
        )
        .join("")}
    </div>`);
  }

  if (report?.chapters?.length) {
    parts.push(`<div class="rep-section">
      <h3>🕐 بخش‌بندی کلاس</h3>
      ${report.chapters
        .map(
          (c) => `<div class="note">
            <span class="ts">${clock(c.start_ms)}</span>
            <div style="margin-top:9px">
              <b>${esc(c.title || KIND_FA[c.kind] || c.kind)}</b>
              <span class="dim"> · ${esc(KIND_FA[c.kind] ?? c.kind)}</span>
            </div>
          </div>`,
        )
        .join("")}
    </div>`);
  }

  if (report?.glossary?.length) {
    parts.push(`<div class="rep-section">
      <h3>📖 واژه‌نامه</h3>
      ${report.glossary
        .map(
          (g) => `<div class="note">
            <b>${esc(g.term)}</b>${g.english ? ` <span class="dim">(${esc(g.english)})</span>` : ""}
            <div class="muted" style="font-size:14.3px;margin-top:5px">${esc(g.definition)}</div>
          </div>`,
        )
        .join("")}
    </div>`);
  }

  // دانلودها با توکن نیاز دارند، پس با جاوااسکریپت گرفته می‌شوند نه لینک ساده
  const acts = [];
  if (s.hasPdf) acts.push(`<button class="btn btn-primary" data-dl="pdf">📕 دانلود جزوه</button>`);
  acts.push(`<button class="btn btn-ghost" data-dl="transcript">📄 رونوشت</button>`);
  parts.push(`<div class="actions">${acts.join("")}</div>`);

  queueMicrotask(() => {
    for (const b of $("one").querySelectorAll("[data-dl]")) {
      b.addEventListener("click", () => download(id, b.dataset.dl));
    }
  });

  return parts.join("");
}

/**
 * دانلود فایلی که پشت احراز هویت است.
 *
 * لینک ساده کار نمی‌کند چون توکن در هدر می‌رود نه در URL. پس فایل با
 * `fetch` گرفته می‌شود و از روی `blob` یک لینک موقت ساخته می‌شود.
 */
async function download(id, kind) {
  try {
    const res = await fetch(`/api/sessions/${id}/${kind}`, {
      headers: { authorization: `Bearer ${api.token}` },
    });
    if (!res.ok) throw new Error("فایل در دسترس نیست.");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = kind === "pdf" ? "جزوه.pdf" : "رونوشت.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    alert(e.message);
  }
}

// ─── حساب ───────────────────────────────────────────────────────────────────

const PLATFORM_FA = { telegram: "تلگرام", bale: "بله", web: "مرورگر" };

async function loadAccount() {
  const box = $("acct");
  box.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const [u, { packages }] = await Promise.all([loadMe(), api.call("/api/packages")]);

    box.innerHTML = `
      <div class="card" style="text-align:center">
        <p class="dim">موجودی</p>
        <div style="font-size:38px;font-weight:800;letter-spacing:-.02em" class="num">
          ${faGroup(u.coins)}
        </div>
        <p class="muted" style="font-size:14px">سکه</p>
        <p class="dim" style="margin-top:10px">
          ${u.coinsPerMinute === 1 ? "هر سکه = یک دقیقه صوت" : `هر دقیقه صوت ${fa(u.coinsPerMinute)} سکه`}
        </p>
      </div>

      ${
        u.freeRunAvailable
          ? `<div class="free-banner">🎁 <div>اولین صوتت هنوز رایگان است — تا ۱۵ دقیقه.</div></div>`
          : ""
      }

      <div>
        <h3 style="font-size:16px;margin-bottom:12px">🪙 شارژ حساب</h3>
        <div class="stack">
          ${packages
            .map(
              (p) => `<div class="item">
                <div style="display:flex;align-items:center;gap:12px">
                  <div>
                    <div class="item-title num">${faGroup(p.coins)} سکه</div>
                    <div class="item-meta">
                      ${p.tag ? `<span class="badge">${esc(p.tag)}</span>` : ""}
                      <span class="num">${faGroup(p.price)} تومان</span>
                      <span class="dim">· ${pkgWorth(p.coins, u.coinsPerMinute)}</span>
                    </div>
                  </div>
                  <div style="margin-inline-start:auto" class="dim">›</div>
                </div>
              </div>`,
            )
            .join("")}
        </div>
        <p class="dim" style="margin-top:12px">
          برای شارژ، از ربات تلگرام یا بله اقدام کن — پرداخت کارت‌به‌کارت آنجا انجام می‌شود.
        </p>
      </div>

      <div>
        <h3 style="font-size:16px;margin-bottom:10px">راه‌های ورود</h3>
        <p class="dim">${u.platforms.map((p) => PLATFORM_FA[p] ?? p).join(" · ")}</p>
      </div>

      <button class="btn btn-ghost btn-block" id="logout" type="button">خروج از حساب</button>
    `;

    $("logout").addEventListener("click", async () => {
      await api.call("/api/auth/logout", { method: "POST" }).catch(() => {});
      api.clear();
      location.reload();
    });
  } catch (e) {
    box.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

// ─── شروع ───────────────────────────────────────────────────────────────────

boot().catch((e) => {
  console.error(e);
  go("auth");
});
