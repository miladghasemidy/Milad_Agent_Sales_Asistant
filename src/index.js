import { handleWebApi } from "./webApi.js";
import {
  handleTelegramUpdate,
  sendInteractiveTaskItems,
  buildBeautifulDailyWorkReport,
  buildDailyStudentChangesReport,
  sendLongTelegramMessages,
  sendTelegramMessage,
  ensureTelegramWebhookConfigured
} from "./telegram.js";

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>پنل مدیریت فروش — Milad AI Sales Super Agent</title>
  <style>
    :root {
      --bg: #0b1120;
      --card: #111827;
      --card-2: #1e293b;
      --border: #293548;
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.65;
    }
    .container {
      max-width: 1080px;
      margin: 0 auto;
      padding: 24px 16px 56px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px 20px;
      margin-bottom: 20px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .dot {
      width: 11px; height: 11px; border-radius: 50%;
      background: var(--success); box-shadow: 0 0 12px var(--success);
    }
    .brand h1 { margin: 0; font-size: 18px; }
    .brand small { color: var(--muted); display: block; font-size: 12px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 18px;
    }
    .login-box { max-width: 420px; margin: 48px auto; }
    h2 { margin: 0 0 14px; font-size: 16px; }
    label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
    input, select, textarea {
      width: 100%;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
      font-family: inherit;
      margin-bottom: 12px;
    }
    input:focus, select:focus, textarea:focus {
      outline: none; border-color: var(--primary);
    }
    button {
      background: var(--primary);
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 10px 16px;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    button:hover { background: var(--primary-hover); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button.secondary { background: var(--card-2); border: 1px solid var(--border); }
    button.secondary:hover { background: #273549; }
    button.success { background: var(--success); color: #052e16; font-weight: 600; }
    .tabs {
      display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px;
    }
    .tab-btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--muted);
    }
    .tab-btn.active {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
    }
    .task-item {
      background: var(--card-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 12px;
    }
    .task-head {
      display: flex; justify-content: space-between; align-items: center;
      flex-wrap: wrap; gap: 8px; margin-bottom: 8px;
    }
    .pill {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      background: rgba(59, 130, 246, 0.15);
      color: #93c5fd;
    }
    .muted { color: var(--muted); font-size: 13px; }
    .msg {
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      margin-top: 10px;
      white-space: pre-wrap;
    }
    .msg.err { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border: 1px solid rgba(239,68,68,0.35); }
    .msg.ok { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.35); }
    pre {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      overflow-x: auto;
      font-size: 12.5px;
      direction: ltr;
      text-align: left;
    }
    .hidden { display: none; }
    .row-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  </style>
</head>
<body>
  <div class="container">
    <!-- فرم ورود -->
    <div id="loginSection" class="card login-box">
      <h2>ورود به پنل مدیریت فروش</h2>
      <p class="muted">برای دسترسی به تسک‌ها، جستجوی دانشجو و ابزارهای هوش مصنوعی وارد شوید.</p>
      <label for="usernameInput">نام کاربری</label>
      <input id="usernameInput" type="text" placeholder="نام کاربری" autocomplete="username" />
      <label for="passwordInput">رمز عبور</label>
      <input id="passwordInput" type="password" placeholder="رمز عبور" autocomplete="current-password" />
      <button id="loginBtn" style="width:100%">ورود به سامانه</button>
      <div id="loginMsg" class="msg hidden"></div>
    </div>

    <!-- داشبورد اصلی -->
    <div id="appSection" class="hidden">
      <div class="topbar">
        <div class="brand">
          <span class="dot"></span>
          <div>
            <h1>Milad AI Sales Super Agent</h1>
            <small id="userDisplay">کاربر فعال</small>
          </div>
        </div>
        <div class="row-actions">
          <a href="/setup" target="_blank"><button type="button" class="secondary">وضعیت وبهوک (/setup)</button></a>
          <button id="logoutBtn" type="button" class="secondary">خروج</button>
        </div>
      </div>

      <div class="tabs">
        <button type="button" class="tab-btn active" data-tab="tasksTab">تسک‌های امروز</button>
        <button type="button" class="tab-btn" data-tab="searchTab">جستجوی دانشجو</button>
        <button type="button" class="tab-btn" data-tab="aiTab">تحلیل فیش و ویس</button>
      </div>

      <!-- تب تسک‌ها -->
      <div id="tasksTab" class="tab-panel">
        <div class="card">
          <div class="task-head">
            <h2>لیست تسک‌های تماس و پیگیری</h2>
            <button id="refreshTasksBtn" type="button" class="secondary">تازه‌سازی لیست</button>
          </div>
          <div id="tasksMsg" class="msg hidden"></div>
          <div id="tasksList">در حال بارگذاری...</div>
        </div>

        <div class="card">
          <h2>پیگیری‌شده‌های امروز</h2>
          <div id="followedList" class="muted">هنوز موردی ثبت نشده است.</div>
        </div>
      </div>

      <!-- تب جستجوی دانشجو -->
      <div id="searchTab" class="tab-panel hidden">
        <div class="card">
          <h2>جستجو در پرونده دانشجوها</h2>
          <div class="row-actions">
            <input id="searchInput" type="text" placeholder="نام، شماره تماس یا نام تب را وارد کنید..." style="margin-bottom:0; flex:1; min-width:220px;" />
            <button id="searchBtn" type="button">جستجو</button>
          </div>
          <div id="searchMsg" class="msg hidden"></div>
          <div id="searchResults" style="margin-top:14px;"></div>
        </div>
      </div>

      <!-- تب فیش و ویس -->
      <div id="aiTab" class="tab-panel hidden">
        <div class="grid-2">
          <div class="card">
            <h2>پردازش تصویر فیش واریزی</h2>
            <label for="receiptFile">فایل تصویر فیش</label>
            <input id="receiptFile" type="file" accept="image/*" />
            <label for="receiptCaption">توضیح تکمیلی (اختیاری)</label>
            <input id="receiptCaption" type="text" placeholder="مثلاً نام دانشجو یا دوره..." />
            <button id="receiptBtn" type="button" class="success">استخراج اطلاعات و ارسال</button>
            <div id="receiptMsg" class="msg hidden"></div>
            <pre id="receiptOut" class="hidden"></pre>
          </div>

          <div class="card">
            <h2>تحلیل صوتی مکالمه فروش</h2>
            <label for="voiceFile">فایل صوتی مکالمه</label>
            <input id="voiceFile" type="file" accept="audio/*" />
            <label for="voiceCaption">راهنمای تحلیل (اختیاری)</label>
            <input id="voiceCaption" type="text" placeholder="نکات مهم مکالمه..." />
            <button id="voiceBtn" type="button">تحلیل مکالمه با AI</button>
            <div id="voiceMsg" class="msg hidden"></div>
            <pre id="voiceOut" class="hidden"></pre>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const TOKEN_KEY = "milad_sales_web_token";
    const USER_KEY = "milad_sales_web_user";
    const OUTCOMES = [
      { key: "won_sale", label: "موفق - فروش بسته" },
      { key: "future_call", label: "پیگیری - تماس آینده" },
      { key: "no_answer", label: "پیگیری - جواب نداد" },
      { key: "switched_off", label: "پیگیری - خاموش بود" },
      { key: "wrong_num", label: "ناموفق - اشتباه بود" },
      { key: "def_no", label: "ناموفق - قطعی نمی‌خواهد" }
    ];

    const el = (id) => document.getElementById(id);
    const getToken = () => localStorage.getItem(TOKEN_KEY) || "";

    function showMsg(id, text, isErr = false) {
      const box = el(id);
      if (!text) { box.className = "msg hidden"; box.textContent = ""; return; }
      box.className = "msg " + (isErr ? "err" : "ok");
      box.textContent = text;
    }

    async function apiFetch(path, opts = {}) {
      const headers = Object.assign({}, opts.headers || {});
      const token = getToken();
      if (token) headers["Authorization"] = "Bearer " + token;
      const res = await fetch(path, Object.assign({}, opts, { headers }));
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && path !== "/api/login") {
        logout();
        throw new Error(data.error || "نشست منقضی شد؛ لطفاً دوباره وارد شوید.");
      }
      if (!res.ok) throw new Error(data.error || "خطا در ارتباط با سرور");
      return data;
    }

    function setAuthenticatedState(isAuth, displayName = "") {
      el("loginSection").classList.toggle("hidden", isAuth);
      el("appSection").classList.toggle("hidden", !isAuth);
      if (displayName) {
        localStorage.setItem(USER_KEY, displayName);
        el("userDisplay").textContent = "کاربر: " + displayName;
      } else if (localStorage.getItem(USER_KEY)) {
        el("userDisplay").textContent = "کاربر: " + localStorage.getItem(USER_KEY);
      }
    }

    function logout() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      setAuthenticatedState(false);
    }

    el("loginBtn").addEventListener("click", async () => {
      const username = el("usernameInput").value.trim();
      const password = el("passwordInput").value;
      showMsg("loginMsg", "");
      if (!username || !password) return showMsg("loginMsg", "نام کاربری و رمز عبور را وارد کنید.", true);
      el("loginBtn").disabled = true;
      try {
        const data = await apiFetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        localStorage.setItem(TOKEN_KEY, data.token);
        setAuthenticatedState(true, data.displayName || username);
        await loadTasks();
      } catch (err) {
        showMsg("loginMsg", err.message, true);
      } finally {
        el("loginBtn").disabled = false;
      }
    });

    el("logoutBtn").addEventListener("click", logout);

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
        el(btn.dataset.tab).classList.remove("hidden");
      });
    });

    function escapeHtml(s) {
      return String(s || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
    }

    async function loadTasks() {
      showMsg("tasksMsg", "");
      el("tasksList").textContent = "در حال دریافت تسک‌ها...";
      try {
        const data = await apiFetch("/api/tasks");
        renderTasks(data.tasks || []);
        renderFollowed(data.followed || []);
      } catch (err) {
        el("tasksList").textContent = "";
        showMsg("tasksMsg", err.message, true);
      }
    }

    function renderTasks(tasks) {
      if (!tasks.length) {
        el("tasksList").innerHTML = '<p class="muted">تسک فعالی برای امروز باقی نمانده است.</p>';
        return;
      }
      const outcomeOpts = OUTCOMES.map((o) => '<option value="' + o.key + '">' + escapeHtml(o.label) + "</option>").join("");
      el("tasksList").innerHTML = tasks.slice(0, 40).map((t) => {
        return '<div class="task-item">' +
          '<div class="task-head">' +
            '<div><strong>' + escapeHtml(t.name || "بدون نام") + '</strong> <span class="muted">(' + escapeHtml(t.phone || "—") + ')</span></div>' +
            '<span class="pill">' + escapeHtml(t.tab || "—") + ' • ردیف ' + escapeHtml(t.rowNum || "—") + '</span>' +
          '</div>' +
          '<div class="muted" style="margin-bottom:8px;">وضعیت فعلی: ' + escapeHtml(t.previousStatus || "ثبت نشده") + ' • تعداد پیگیری: ' + escapeHtml(t.followCount ?? 0) + '</div>' +
          (t.description ? '<div class="muted" style="margin-bottom:10px;">توضیحات: ' + escapeHtml(t.description) + '</div>' : '') +
          '<div class="grid-2" style="gap:8px;">' +
            '<select id="out_' + escapeHtml(t.id) + '" style="margin-bottom:0;">' + outcomeOpts + '</select>' +
            '<input id="note_' + escapeHtml(t.id) + '" type="text" placeholder="توضیح یا زمان تماس مجدد..." style="margin-bottom:0;" />' +
          '</div>' +
          '<div style="margin-top:8px;">' +
            '<button type="button" onclick="submitOutcome(\\'' + escapeHtml(t.id) + '\\')">ثبت نتیجه در شیت</button>' +
          '</div>' +
        '</div>';
      }).join("");
    }

    window.submitOutcome = async function(taskId) {
      const outcomeKey = el("out_" + taskId)?.value;
      const extraDescription = el("note_" + taskId)?.value || "";
      showMsg("tasksMsg", "در حال ثبت نتیجه در گوگل‌شیت...");
      try {
        const res = await apiFetch("/api/tasks/outcome", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, outcomeKey, extraDescription })
        });
        showMsg("tasksMsg", "ثبت شد: " + (res.status || "موفق"));
        await loadTasks();
      } catch (err) {
        showMsg("tasksMsg", err.message, true);
      }
    };

    function renderFollowed(list) {
      if (!list.length) {
        el("followedList").innerHTML = '<p class="muted">هنوز پیگیری‌ای امروز ثبت نشده است.</p>';
        return;
      }
      el("followedList").innerHTML = list.map((item) =>
        '<div class="task-item">' +
          '<strong>' + escapeHtml(item.name || "بدون نام") + '</strong> — <span class="pill">' + escapeHtml(item.outcome || "") + '</span> ' +
          '<span class="muted">(' + escapeHtml(item.timeDisplay || "") + ' • ' + escapeHtml(item.tab || "") + ')</span>' +
        '</div>'
      ).join("");
    }

    el("refreshTasksBtn").addEventListener("click", loadTasks);

    el("searchBtn").addEventListener("click", async () => {
      const q = el("searchInput").value.trim();
      showMsg("searchMsg", "");
      if (!q) return showMsg("searchMsg", "عبارت جستجو را وارد کنید.", true);
      el("searchResults").textContent = "در حال جستجو...";
      try {
        const data = await apiFetch("/api/students/search?q=" + encodeURIComponent(q));
        const matches = data.matches || [];
        if (!matches.length) {
          el("searchResults").innerHTML = '<p class="muted">موردی یافت نشد.</p>';
          return;
        }
        el("searchResults").innerHTML = matches.map((m) =>
          '<div class="task-item">' +
            '<div class="task-head"><strong>' + escapeHtml(m.name || "بدون نام") + '</strong><span class="pill">' + escapeHtml(m.tab) + ' • ردیف ' + escapeHtml(m.rowNum) + '</span></div>' +
            '<div class="muted">شماره: ' + escapeHtml(m.phone || "—") + ' • وضعیت: ' + escapeHtml(m.status || "—") + ' • پیگیری: ' + escapeHtml(m.followCount) + '</div>' +
            (m.description ? '<div class="muted" style="margin-top:6px;">' + escapeHtml(m.description) + '</div>' : '') +
          '</div>'
        ).join("");
      } catch (err) {
        el("searchResults").innerHTML = "";
        showMsg("searchMsg", err.message, true);
      }
    });

    el("receiptBtn").addEventListener("click", async () => {
      const file = el("receiptFile").files[0];
      if (!file) return showMsg("receiptMsg", "ابتدا تصویر فیش را انتخاب کنید.", true);
      showMsg("receiptMsg", "در حال پردازش فیش...");
      el("receiptOut").classList.add("hidden");
      const fd = new FormData();
      fd.append("file", file);
      fd.append("caption", el("receiptCaption").value.trim());
      try {
        const data = await apiFetch("/api/receipt", { method: "POST", body: fd });
        showMsg("receiptMsg", "فیش پردازش شد (" + (data.model || "AI") + ")");
        el("receiptOut").textContent = JSON.stringify(data.data, null, 2);
        el("receiptOut").classList.remove("hidden");
      } catch (err) {
        showMsg("receiptMsg", err.message, true);
      }
    });

    el("voiceBtn").addEventListener("click", async () => {
      const file = el("voiceFile").files[0];
      if (!file) return showMsg("voiceMsg", "ابتدا فایل صوتی را انتخاب کنید.", true);
      showMsg("voiceMsg", "در حال تحلیل فایل صوتی...");
      el("voiceOut").classList.add("hidden");
      const fd = new FormData();
      fd.append("file", file);
      fd.append("caption", el("voiceCaption").value.trim());
      try {
        const data = await apiFetch("/api/voice", { method: "POST", body: fd });
        showMsg("voiceMsg", "تحلیل انجام شد (" + (data.model || "AI") + ")");
        el("voiceOut").textContent = JSON.stringify(data.analysis, null, 2);
        el("voiceOut").classList.remove("hidden");
      } catch (err) {
        showMsg("voiceMsg", err.message, true);
      }
    });

    if (getToken()) {
      setAuthenticatedState(true);
      loadTasks();
    } else {
      setAuthenticatedState(false);
    }
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // مسیرهای API مخصوص سایت تحت وب
    if (url.pathname.startsWith("/api/")) {
      return handleWebApi(request, env);
    }

    // تنظیم وبهوک تلگرام
    if (url.pathname === "/setup" || url.pathname === "/debug") {
      const status = await ensureTelegramWebhookConfigured(
        env.BOT_TOKEN,
        url.origin,
        env.TELEGRAM_WEBHOOK_SECRET || ""
      );
      return new Response(
        JSON.stringify(
          {
            ...status,
            hasD1Binding: Boolean(env.DB),
            hasAdminChatId: Boolean(env.ADMIN_CHAT_ID),
            hasReceiptChannel: Boolean(env.RECEIPT_CHANNEL_ID),
            hasWebhookSecret: Boolean(env.TELEGRAM_WEBHOOK_SECRET)
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // وبهوک تلگرام
    if (request.method === "POST" && url.pathname === "/webhook") {
      const expectedSecret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
      if (expectedSecret) {
        const receivedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (receivedSecret !== expectedSecret) {
          return new Response("Unauthorized webhook request", { status: 401 });
        }
      }

      try {
        const update = await request.json();
        ctx.waitUntil(handleTelegramUpdate(update, env, url.origin));
      } catch (err) {
        console.error("Webhook parse error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    // صفحه اصلی داشبورد تحت وب
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderDashboardHtml(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    return new Response("Milad AI Sales Super Agent API & Bot", { status: 200 });
  },

  async scheduled(event, env) {
    try {
      if (event.cron === "30 7 * * *") {
        await sendInteractiveTaskItems(env, env.ADMIN_CHAT_ID, "morning");
      }
      if (event.cron === "30 15 * * *") {
        await sendInteractiveTaskItems(env, env.ADMIN_CHAT_ID, "evening");
        const dailyReport = await buildBeautifulDailyWorkReport(env);
        await sendLongTelegramMessages(env.BOT_TOKEN, env.ADMIN_CHAT_ID, dailyReport);
        const changes = await buildDailyStudentChangesReport(env, true);
        await sendLongTelegramMessages(env.BOT_TOKEN, env.ADMIN_CHAT_ID, changes.text);
      }
    } catch (err) {
      await sendTelegramMessage(env.BOT_TOKEN, env.ADMIN_CHAT_ID, `⚠️ خطا در اجرای خودکار: ${err.message}`);
    }
  }
};
