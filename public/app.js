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
    /**
     * مهلت، مگر برای آپلود.
     *
     * بدون این، یک درخواستِ بی‌جواب یعنی صفحه تا ابد روی «یه لحظه…» می‌ماند —
     * که بدترین حالت است، چون کاربر نه خطایی می‌بیند نه راهی جلو. آپلود صوت
     * استثناست: فایل بزرگ واقعاً طول می‌کشد.
     */
    const ms = opt.timeoutMs ?? 15000;
    if (ms > 0 && !opt.signal) {
      opt = { ...opt, signal: AbortSignal.timeout(ms) };
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

/** بایت به مگابایت، با یک رقم اعشار — واحدی که کاربر روی نوار آپلود می‌فهمد. */
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

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
    if (t.dataset.go === "acct") loadAccount();
  });
}
$("balance").addEventListener("click", () => {
  go("acct");
  loadAccount();
});

// ─── سکو ────────────────────────────────────────────────────────────────────

/**
 * `initData` را از هرجایی که ممکن است باشد بخوان.
 *
 * تلگرام آن را در قطعهٔ آدرس (`#tgWebAppData=…`) می‌گذارد و SDKاش همان را
 * می‌خواند. بله SDK قابل‌بارگذاری ندارد (آدرسش ۴۰۴ می‌دهد) و معلوم نیست
 * دقیقاً کجا می‌گذاردش، پس **هر چهار جای ممکن** بررسی می‌شود: قطعهٔ آدرس،
 * رشتهٔ پرس‌وجو، و هر دو نامِ رایج کلید.
 *
 * گشاده‌دستی اینجا بی‌خطر است: مقدارِ پیداشده در سرور با HMAC راستی‌آزمایی
 * می‌شود، پس دادهٔ جعلی رد می‌شود و بدترین حالتِ حدسِ اشتباه یک ۴۰۱ است.
 */
function initDataFromUrl() {
  const KEYS = ["tgWebAppData", "initData", "web_app_data", "baleWebAppData"];
  // `?? ""` عمدی است: میزبان‌های مینی‌اپ گاهی `location` ناقص می‌دهند و یک
  // `undefined` اینجا کل بالاآمدن را می‌شکند — همان چیزی که باید جلویش را بگیریم.
  const sources = [
    (location.hash ?? "").replace(/^#/, ""),
    (location.search ?? "").replace(/^\?/, ""),
  ];
  for (const src of sources) {
    if (!src) continue;
    const params = new URLSearchParams(src);
    for (const k of KEYS) {
      const v = params.get(k);
      // `initData` خودش یک رشتهٔ پرس‌وجوست و باید دست‌کم `hash=` داشته باشد؛
      // این شرط جلوی برداشتنِ یک مقدار بی‌ربط را می‌گیرد.
      if (v && v.includes("hash=")) return v;
    }
  }
  return null;
}

/**
 * مینی‌اپِ میزبان، اگر داخل یکی هستیم.
 *
 * **به SDK تکیه نمی‌شود، چون همیشه بار نمی‌شود.** آدرس اسکریپت بله
 * (`tapi.bale.ai/miniapp/bale-web-app.js`) ۴۰۴ می‌دهد، پس `globalThis.Bale`
 * هرگز ساخته نمی‌شد و اپ فکر می‌کرد داخل مرورگر معمولی است — نتیجه‌اش این بود
 * که کاربر بله به‌جای فرم آپلود، صفحهٔ ورود می‌دید.
 *
 * ترتیب: اول SDK (اگر بود، تم و دکمهٔ برگشت هم می‌دهد)، بعد خودِ آدرس.
 */
function host() {
  const tg = globalThis.Telegram?.WebApp;
  if (tg?.initData) return { platform: "telegram", sdk: tg };
  const bale = globalThis.Bale?.WebApp;
  if (bale?.initData) return { platform: "bale", sdk: bale };

  const initData = initDataFromUrl();
  if (initData) return { platform: null, sdk: { initData } };
  return null;
}

const miniApp = host();

/**
 * سکویی که نشستِ فعلی با آن وارد شده — «telegram» یا «bale».
 *
 * `miniApp.platform` برای بله `null` است (چون `initData` از قطعهٔ آدرس
 * خوانده می‌شود و SDKی در کار نیست)، پس این مقدار از پاسخ ورود می‌آید و در
 * `localStorage` می‌ماند تا بازکردن دوبارهٔ اپ هم آن را بداند.
 *
 * تنها مصرفش امروز، بردنِ کاربر به رباتِ **درست** است.
 */
let platformOfSession =
  miniApp?.platform || localStorage.getItem("passchi_platform") || null;

/**
 * آیا این دستگاه یک کامپیوتر رومیزی است؟
 *
 * بله روی دسکتاپ دکمهٔ مینی‌اپ را داخل خودش باز نمی‌کند و لینک را به مرورگر
 * سیستم می‌سپارد — و مرورگر سیستم هیچ `initData` ندارد، پس ورود خودکار
 * ناممکن است. تشخیصش لازم است چون پیامِ «از داخل تلگرام یا بله وارد شو»
 * برای این کاربر توهین‌آمیز است: او *دقیقاً همین کار را کرده*.
 *
 * ملاک، نبودِ صفحهٔ لمسی و اشاره‌گر دقیق است، نه رشتهٔ User-Agent — که هم
 * جعل می‌شود و هم روی هر نسخهٔ تازهٔ مرورگر می‌شکند.
 */
const isDesktop = (() => {
  try {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  } catch {
    return false;
  }
})();

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
    /**
     * وقتی سکو از SDK معلوم نشده، هر دو امتحان می‌شوند.
     *
     * `initData` با توکن رباتِ همان سکو امضا شده، پس فقط یکی از این دو
     * راستی‌آزمایی می‌شود و آن دیگری ۴۰۱ می‌گیرد — یعنی حدس‌زدن سکو لازم
     * نیست و امضا خودش جواب را می‌دهد. حدس اشتباه، کاربر را روی حساب اشتباه
     * نمی‌نشاند چون امضا اجازه نمی‌دهد.
     */
    const candidates = miniApp.platform ? [miniApp.platform] : ["bale", "telegram"];
    for (const platform of candidates) {
      try {
        const res = await api.call("/api/auth/miniapp", {
          method: "POST",
          body: { platform, initData: miniApp.sdk.initData },
        });
        /**
         * سکو را از **پاسخ سرور** بگیر، نه از حدس خودمان.
         *
         * وقتی `initData` از قطعهٔ آدرس خوانده شده — تنها راه در بله —
         * `miniApp.platform` برابر `null` است و اینجا هر دو توکن امتحان
         * می‌شوند. سروری که امضا را پذیرفته می‌داند کدام بود؛ بدون ثبتِ
         * جوابش، دکمهٔ «برگرد به ربات» کاربر بله را به تلگرام می‌برد.
         */
        platformOfSession = res.platform ?? platform;
        try {
          localStorage.setItem("passchi_platform", platformOfSession);
        } catch {
          /* حالت ناشناس مرورگر — بدون ماندگاری هم همین نشست درست کار می‌کند */
        }
        await afterLogin(res.token);
        return;
      } catch (e) {
        console.warn(`mini app login failed on ${platform}:`, e.message);
      }
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
  // فرم کد همیشه بسته می‌شود: اگر کاربر پیش‌تر تا مرحلهٔ کد رفته و بعد
  // برگشته باشد، بازماندهٔ آن نباید کنار دکمه‌های ربات بماند.
  show($("form-code"), false);
  show($("auth-bots"), !phoneLogin);
  /**
   * وقتی اینجاییم یعنی ورود خودکار نشده.
   *
   * داخل مینی‌اپ این نباید پیش بیاید و اگر آمد یعنی `initData` نرسیده —
   * پس متن باید بگوید چه کار کند، نه اینکه فقط دو دکمهٔ بی‌ربط بگذارد.
   */
  /**
   * کاربر دسکتاپ دکمه‌های ربات را نمی‌بیند.
   *
   * او روی همان دکمه زده و بله بیرونش انداخته؛ دادن دکمهٔ «باز کردن در بله»
   * یعنی فرستادنش به همان حلقه. تنها راهِ واقعیِ امروز، گوشی است.
   */
  const strandedOnDesktop = !phoneLogin && isDesktop;
  if (strandedOnDesktop) {
    show($("auth-bots"), false);
    // «خوش اومدی» برای کسی که همین الان به بن‌بست خورده، پاسخ نیست.
    $("auth-mark").textContent = "📱";
    $("auth-title").textContent = "با گوشی بیا";
  }

  $("auth-lead").textContent = phoneLogin
    ? "برای شروع شماره‌ات رو وارد کن"
    : strandedOnDesktop
      ? "فعلاً آپلود صوت فقط با گوشی کار می‌کنه. ربات رو روی موبایلت باز کن و همون‌جا دکمهٔ «📤 آپلود فایل» رو بزن. نسخهٔ کامپیوتر بعداً اضافه می‌شه."
      : miniApp
        ? "ورود خودکار انجام نشد. مینی‌اپ رو ببند و از داخل ربات دوباره بازش کن."
        // روی گوشی، دکمه‌های زیر واقعاً کار می‌کنند — پس متن باید به همان‌ها
        // اشاره کند، نه به یک «از داخل تلگرام وارد شو»ِ مبهم.
        : "یکی از دکمه‌های زیر رو بزن تا وارد ربات بشی — صوت کلاستو همون‌جا می‌فرستی.";

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

/**
 * فهرست درس‌ها را می‌کشد و انتخابگر را می‌سازد.
 *
 * `selectId` بعد از ساختن درس تازه داده می‌شود تا همان درس انتخاب بماند —
 * وگرنه کاربر درس را می‌سازد و انتخابگر برمی‌گردد روی «بدون درس»، و صوتش
 * بی‌درس آپلود می‌شود؛ یعنی دقیقاً همان کاری که تازه از آن صرف‌نظر کرد.
 */
async function loadCourses(selectId = "") {
  try {
    const { courses } = await api.call("/api/courses");
    const sel = $("course");
    sel.innerHTML =
      '<option value="">بدون درس</option>' +
      courses.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("") +
      '<option value="new">➕ درس جدید…</option>';
    if (selectId) sel.value = String(selectId);
  } catch {
    /* نبودِ فهرست درس‌ها نباید جلوی ارسال صوت را بگیرد */
  }
}

// ─── ساختن درس از داخل اپ ───────────────────────────────────────────────────
//
// پیش‌تر تنها راه ساختن درس، گفت‌وگو با ربات بود. ولی کاربر بله و کاربر
// تلگرامِ پشت فیلترشکن اصلاً برای همین به اپ می‌آیند که صوت را اینجا بفرستند؛
// فرستادنشان به ربات وسط کار یعنی رهاکردن آپلود.

const courseNew = () => $("course-new");

/** انتخابگر را به حالت پیش‌فرض برمی‌گرداند و فرم ساخت را می‌بندد. */
function closeCourseForm(value = "") {
  show(courseNew(), false);
  fail($("course-err"), "");
  $("course-name").value = "";
  $("course-prof").value = "";
  $("course").value = value;
}

$("course").addEventListener("change", () => {
  const opening = $("course").value === "new";
  show(courseNew(), opening);
  if (opening) $("course-name").focus();
});

$("course-cancel").addEventListener("click", () => closeCourseForm());

$("course-save").addEventListener("click", async () => {
  const name = $("course-name").value.trim();
  if (!name) return fail($("course-err"), "اسم درس را بنویس.");

  const btn = $("course-save");
  btn.disabled = true;
  try {
    const { course } = await api.call("/api/courses", {
      method: "POST",
      body: { name, professor: $("course-prof").value.trim() || null },
    });
    await loadCourses(course.id);
    closeCourseForm(String(course.id));
  } catch (err) {
    fail($("course-err"), err.message || "ساختن درس نشد. دوباره امتحان کن.");
  } finally {
    btn.disabled = false;
  }
});

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

/**
 * آپلود با گزارش درصد.
 *
 * **چرا `XMLHttpRequest` و نه `fetch`:** `fetch` هیچ راهی برای دنبال‌کردن
 * پیشرفتِ *فرستادن* ندارد — `ReadableStream` به‌عنوان بدنه در مرورگرهای
 * موبایل عملاً کار نمی‌کند و `Content-Length` هم که لازم است از بین می‌رود.
 * `xhr.upload.onprogress` تنها راهی است که همه‌جا جواب می‌دهد.
 *
 * کاربر یک فایل ۹۰ دقیقه‌ای را روی اینترنت موبایل می‌فرستد؛ چرخاندنِ یک
 * اسپینر بی‌عدد برای چند دقیقه، بدترین قسمت این مسیر بود.
 *
 * شکل خطا عمداً همان چیزی است که `api.call` می‌دهد (`status` و `data`)، تا
 * صدازننده لازم نباشد دو حالت را جدا کند.
 */
function uploadWithProgress(path, file, onPercent) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    if (api.token) xhr.setRequestHeader("authorization", `Bearer ${api.token}`);

    xhr.upload.onprogress = (e) => {
      // `lengthComputable` روی بعضی پراکسی‌ها نادرست است؛ آنجا درصدی نشان
      // نمی‌دهیم به‌جای اینکه عدد ساختگی بسازیم.
      if (e.lengthComputable && e.total > 0) onPercent(e.loaded / e.total);
    };

    xhr.onload = () => {
      let data = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        /* پاسخ غیرJSON یعنی خطای سرور یا پراکسی */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      reject(
        Object.assign(new Error(data.error || "آپلود ناموفق بود."), { data, status: xhr.status }),
      );
    };
    xhr.onerror = () => reject(new Error("ارتباط قطع شد. اینترنتت را بررسی کن."));
    xhr.onabort = () => reject(new Error("آپلود لغو شد."));

    // بدون مهلت: یک کلاس ۹۰ دقیقه‌ای روی اینترنت موبایل می‌تواند دقایقی
    // طول بکشد و بریدنش یعنی از دست‌رفتن کل فایل.
    xhr.timeout = 0;
    xhr.send(file);
  });
}

async function upload(file) {
  fail($("send-err"), "");
  const seconds = await durationOf(file);
  const ext = (file.name.split(".").pop() || "ogg").toLowerCase();
  // `new` یک شناسهٔ درس نیست، برچسب گزینهٔ «درس جدید…» است. اگر کاربر فرم را
  // باز کند و بی‌آنکه بسازد فایل بفرستد، نباید رشتهٔ `new` به سرور برود.
  const picked = $("course").value;
  const courseId = picked === "new" ? "" : picked;

  /**
   * آپلود روی همین صفحه می‌ماند تا رسیدنِ قیمت.
   *
   * پیش‌تر اینجا به صفحهٔ پیشرفت می‌پرید، ولی حالا قدم بعدی «تأیید هزینه»
   * است نه پردازش — و پریدن به صفحه‌ای که هنوز چیزی در آن نیست، فقط این
   * توهم را می‌سازد که کار شروع شده.
   */
  drop.classList.add("busy");
  drop.innerHTML =
    '<h3 id="up-title">در حال فرستادن…</h3>' +
    '<div class="bar"><div class="bar-fill" id="up-fill"></div></div>' +
    '<p class="dim" id="up-note">صفحه رو نبند تا آپلود تمام شود.</p>';

  /**
   * پیش از فرستادنِ یک بایت بپرس که این فایل پذیرفته می‌شود یا نه.
   *
   * بدون این، تنها راهِ فهمیدنِ «اعتبارت کم است» فرستادن کل فایل بود — و
   * چون سرور وسط راه جواب می‌داد و بدنه را نمی‌خواند، نوار درصد روی همان
   * عدد **خشک می‌شد** و بعد «اتصال قطع شد» می‌آمد. روی اینترنت موبایل با
   * فایل ۵۰ مگابایتی همیشه اتفاق می‌افتاد.
   */
  try {
    await api.call("/api/sessions/precheck", {
      method: "POST",
      body: { durationSec: seconds, sizeBytes: file.size },
    });
  } catch (err) {
    resetDrop();
    if (err.status === 402) {
      const d = err.data || {};
      fail(
        $("send-err"),
        `اعتبارت کم است — این جلسه ${faGroup(d.needCoins ?? 0)} سکه می‌خواهد و ${faGroup(d.haveCoins ?? 0)} سکه داری.`,
      );
    } else {
      fail($("send-err"), err.message);
    }
    return;
  }

  const qs = new URLSearchParams({ duration: String(seconds), ext });
  if (courseId) qs.set("courseId", courseId);

  const total = mb(file.size);
  let out;
  try {
    out = await uploadWithProgress(`/api/sessions/upload?${qs}`, file, (ratio) => {
      const pct = Math.min(99, Math.round(ratio * 100));
      $("up-fill").style.width = `${pct}%`;
      $("up-title").textContent = `${fa(pct)}٪ فرستاده شد`;
      $("up-note").textContent = `${fa(mb(file.size * ratio))} از ${fa(total)} مگابایت`;
    });

    /**
     * رسیدنِ آخرین بایت پایانِ کار نیست.
     *
     * سرور بعدش فایل را با ffmpeg می‌سنجد تا مدت واقعی را دربیاورد، و آن
     * چند ثانیه‌ای طول می‌کشد. اگر روی «۹۹٪» می‌ماند، کاربر فکر می‌کرد
     * آپلود گیر کرده — پس اینجا صریح گفته می‌شود چه خبر است.
     */
    $("up-fill").style.width = "100%";
    $("up-title").textContent = "دارم فایل رو بررسی می‌کنم…";
    $("up-note").textContent = "چند ثانیه طول می‌کشه";
  } catch (err) {
    resetDrop();
    // کمبود اعتبار پیام مخصوص خودش را دارد، با عددها
    if (err.status === 402) {
      const d = err.data || {};
      fail(
        $("send-err"),
        `اعتبارت کم است — این جلسه ${faGroup(d.needCoins ?? 0)} سکه می‌خواهد و ${faGroup(d.haveCoins ?? 0)} سکه داری.`,
      );
    } else {
      fail($("send-err"), err.message);
    }
    return;
  }

  resetDrop();
  // آپلود دیگر کار را شروع نمی‌کند؛ اول قیمت را نشان بده.
  askConfirm(out, file.name);
}

/** ناحیهٔ رهاکردن فایل را به حالت اولش برگردان. */
function resetDrop() {
  drop.classList.remove("busy");
  drop.innerHTML =
    '<div class="drop-ico">🎧</div>' +
    "<h3>صوت کلاست رو بذار اینجا</h3>" +
    "<p>یا بزن تا از دستگاهت انتخاب کنی</p>" +
    '<p class="dim" style="margin-top:9px">mp3 · m4a · ogg · wav — تا ۵۰۰ مگابایت</p>';
}

// ─── تأیید هزینه ────────────────────────────────────────────────────────────
//
// بین آپلود و شروعِ کار. مدت از سرور می‌آید (با ffmpeg اندازه‌گیری شده)، نه
// از `<audio>` مرورگر که برای بعضی قالب‌ها صفر یا غلط می‌دهد — و عددی که
// کاربر تأیید می‌کند باید همان باشد که از او کم می‌شود.

/** ثانیه به «۱ ساعت و ۳۳ دقیقه». */
function faDuration(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${fa(m)} دقیقه`;
  return rest ? `${fa(h)} ساعت و ${fa(rest)} دقیقه` : `${fa(h)} ساعت`;
}

let pendingSession = null;

function askConfirm(out, filename) {
  pendingSession = out.sessionId;
  $("confirm-file").textContent = filename || "";
  $("confirm-dur").textContent = faDuration(out.durationSec);
  $("confirm-cost").textContent = `${faGroup(out.costCoins)} 🪙`;
  $("confirm-have").textContent = `${faGroup(out.haveCoins)} 🪙`;
  fail($("confirm-err"), "");

  // موجودی کم؟ دکمه را نبند — بگو چقدر کم دارد و بگذار برود شارژ کند.
  const short = Math.max(0, out.costCoins - out.haveCoins);
  $("confirm-go").disabled = !out.enough;
  if (!out.enough) {
    fail($("confirm-err"), `${faGroup(short)} سکه کم داری. از تب «حساب» شارژ کن و دوباره بفرست.`);
  }
  go("confirm");
}

$("confirm-cancel").addEventListener("click", () => {
  pendingSession = null;
  go("send");
});

$("confirm-go").addEventListener("click", async () => {
  if (!pendingSession) return;
  const btn = $("confirm-go");
  btn.disabled = true;
  fail($("confirm-err"), "");
  try {
    await api.call(`/api/sessions/${pendingSession}/confirm`, { method: "POST" });
  } catch (err) {
    btn.disabled = false;
    if (err.status === 402) {
      const d = err.data || {};
      fail(
        $("confirm-err"),
        `اعتبارت کم است — ${faGroup(d.needCoins ?? 0)} سکه لازم است و ${faGroup(d.haveCoins ?? 0)} سکه داری.`,
      );
    } else {
      fail($("confirm-err"), err.message);
    }
    return;
  }
  const id = pendingSession;
  pendingSession = null;
  btn.disabled = false;
  handedOff(id);
});

// ─── تحویل به ربات ──────────────────────────────────────────────────────────
//
// مینی‌اپ دیگر وضعیت را دنبال نمی‌کند و نظرسنجیِ دوثانیه‌ای حذف شد.
//
// پیش‌تر کاربر باید صفحه را باز نگه می‌داشت تا نوار پیشرفت را ببیند — روی
// اینترنت موبایل، برای کاری که دقایقی طول می‌کشد. حالا همان گام‌ها در ربات
// به‌روز می‌شوند: جایی که کاربر به‌هرحال منتظر نتیجه است، و پیام‌هایش با
// بستن صفحه از بین نمی‌روند.

/**
 * کار شروع شد و از اینجا به بعد در ربات دنبال می‌شود.
 *
 * تنها کاری که می‌ماند این است که راه برگشت به ربات را نشان بدهیم — همان
 * سکویی که کاربر از آن آمده.
 */
async function handedOff() {
  await loadMe().catch(() => {});

  let url = null;
  try {
    const { bots = {} } = await api.call("/api/config");
    /**
     * رباتِ همان سکویی که کاربر از آن آمده.
     *
     * پیش‌تر `miniApp.platform` خوانده می‌شد که برای بله همیشه `null` است،
     * پس به `bots.telegram` می‌افتاد: کاربر بله روی «برگرد به ربات» می‌زد و
     * **تلگرام** باز می‌شد.
     */
    url = (platformOfSession && bots[platformOfSession]) || null;
  } catch {
    /* بی‌آدرس هم کارت پیام خودش را می‌دهد */
  }
  const link = $("go-bot");
  if (url) link.href = url;
  show(link, Boolean(url));
  go("prog");
}

$("send-another").addEventListener("click", () => go("send"));

/**
 * برچسب فارسی وضعیت — برای نوار پیشرفت.
 *
 * بقیهٔ این بخش (فهرست جلسه‌ها و نمایش گزارش) از مینی‌اپ برداشته شد: نتیجه
 * در **ربات** تحویل داده می‌شود، چون آنجا می‌شود جزوه را برای گروه درس
 * فوروارد کرد و زمان‌ها لینکِ پخش می‌شوند. مینی‌اپ فقط برای آپلود است، که
 * کاری است که ربات نمی‌تواند بکند — بله بالای بیست مگابایت را نمی‌پذیرد و
 * آپلود در تلگرام از پشت فیلترشکن کند است.
 */
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

/**
 * اگر `boot` جایی پرت کرد، باز هم باید صفحهٔ ورودِ **پیکربندی‌شده** را دید.
 *
 * پیش‌تر اینجا `go("auth")` مستقیم صدا زده می‌شد و همان یک خط، کل تصمیمِ
 * «کدام در باز است» را دور می‌زد: صفحه نشان داده می‌شد ولی فرم شماره هنوز
 * همان‌طور که در HTML بود می‌ماند. کاربر بله اولین چیزی که می‌دید فرم شماره
 * بود، در حالی که سرور آن مسیر را رد می‌کرد.
 */
boot().catch(async (e) => {
  console.error(e);
  await showAuthScreen().catch(() => go("auth"));
});

/**
 * تور نجات: اگر بالاآمدن به هر دلیلی تمام نشد، صفحه نباید روی «یه لحظه…»
 * بماند.
 *
 * `boot` می‌تواند *معلق* بماند نه اینکه پرت کند — یک درخواست بی‌جواب، یک
 * وعدهٔ حل‌نشده — و در آن حالت `catch` هرگز اجرا نمی‌شود. کاربر آن‌وقت یک
 * صفحهٔ ساکن می‌بیند بدون خطا و بدون راه جلو، که بدترین شکست ممکن است.
 *
 * پس اگر بعد از این مهلت هنوز روی صفحهٔ ورود و روی همان متنِ اولیه‌ایم،
 * صفحهٔ ورود به‌زور ساخته می‌شود.
 */
setTimeout(() => {
  if (current === "auth" && $("auth-lead").textContent.trim() === "یه لحظه…") {
    console.warn("boot did not settle in time; forcing auth screen");
    showAuthScreen().catch(() => go("auth"));
  }
}, 6000);
