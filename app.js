const OUTCOME_LABELS = {
  won_sale: "موفق - فروش بسته",
  future_call: "پیگیری - تماس آینده",
  no_answer: "پیگیری - جواب نداد",
  switched_off: "پیگیری - خاموش بود",
  wrong_num: "ناموفق - اشتباه بود",
  def_no: "ناموفق - قطعی نمی‌خواهد"
};

const DEMO_DATA = {
  tasks: [
    {
      id: "t1",
      tab: "لیست آذر",
      rowNum: 14,
      name: "سارا محمدی",
      phone: "09123456789",
      isNew: true,
      followCount: 0,
      previousStatus: "ثبت نشده",
      goal: "مهاجرت تحصیلی و تقویت مکالمه",
      obstacle: "مشغله کاری تا ساعت ۶ عصر",
      need: "برنامه فشرده ۳ ماهه",
      objection: "نیاز به بررسی شرایط پرداخت قسطی"
    },
    {
      id: "t2",
      tab: "لیست آذر",
      rowNum: 22,
      name: "امیرحسین رضایی",
      phone: "09351112233",
      isNew: false,
      followCount: 2,
      previousStatus: "پیگیری - تماس آینده",
      goal: "ورود به بازار کار فریلنسری",
      obstacle: "تردید در شروع از سطح صفر",
      need: "پشتیبانی و منتورینگ قدم‌به‌قدم",
      objection: "قبلاً دوره دیگری گرفته و نتیجه نگرفته"
    },
    {
      id: "t3",
      tab: "ورودی جدید",
      rowNum: 8,
      name: "زهرا کریمی",
      phone: "09198887766",
      isNew: true,
      followCount: 0,
      previousStatus: "ثبت نشده",
      goal: "ارتقای رزومه شغلی",
      obstacle: "محدودیت زمانی آخر هفته‌ها",
      need: "دسترسی آفلاین به جلسات",
      objection: ""
    }
  ],
  followed: [
    {
      name: "مهدی حسینی",
      phone: "09127776655",
      tab: "لیست آذر",
      rowNum: 5,
      outcome: "موفق - فروش بسته",
      followNumber: 2,
      timeDisplay: "14:20",
      logNote: "پیگیری شد (14:20) (موفق - فروش بسته)[واریز قسط اول انجام شد]///"
    }
  ]
};

const state = {
  isDemo: false,
  workerUrl: localStorage.getItem("crm_worker_url") || "",
  token: localStorage.getItem("crm_auth_token") || "",
  userName: localStorage.getItem("crm_user_name") || "میلاد قاسمی",
  tasks: [],
  followed: [],
  activeFilter: "all",
  selectedTask: null,
  selectedOutcome: "future_call"
};

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

// افکت درخشش موس روی کارت‌ها (Spotlight Hover)
document.addEventListener("mousemove", (e) => {
  const card = e.target.closest(".spotlight-card");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
  card.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
});

function showToast(msg) {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<i data-lucide="info" class="icon-xs text-accent"></i><span>${msg}</span>`;
  container.appendChild(el);
  refreshIcons();
  setTimeout(() => el.remove(), 3600);
}

function formatTehranDate() {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());
}

async function apiRequest(path, options = {}) {
  if (state.isDemo) return null;
  const baseUrl = state.workerUrl.replace(/\/$/, "");
  const headers = {
    ...(options.headers || {}),
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
  };
  const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `خطای سرور (${res.status})`);
  }
  return data;
}

function enterAppShell() {
  document.getElementById("loginView").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");
  document.getElementById("todayDateLabel").textContent = formatTehranDate();
  document.getElementById("sidebarUserName").textContent = state.userName;
  document.getElementById("sidebarModeLabel").textContent = state.isDemo
    ? "حالت نمایشی (Demo)"
    : "متصل به Cloudflare Worker";
  loadDashboardData();
}

async function loadDashboardData() {
  if (state.isDemo) {
    state.tasks = structuredClone(DEMO_DATA.tasks);
    state.followed = structuredClone(DEMO_DATA.followed);
  } else {
    try {
      const data = await apiRequest("/api/tasks");
      state.tasks = data.tasks || [];
      state.followed = data.followed || [];
    } catch (err) {
      showToast(err.message);
    }
  }
  renderAllViews();
}

function renderAllViews() {
  const newCalls = state.tasks.filter((t) => t.isNew);
  const followUps = state.tasks.filter((t) => !t.isNew);
  const wonSales = state.followed.filter((f) => f.outcome.includes("فروش بسته"));

  document.getElementById("statNewCalls").textContent = newCalls.length;
  document.getElementById("statFollowUps").textContent = followUps.length;
  document.getElementById("statDoneToday").textContent = state.followed.length;
  document.getElementById("statWonSales").textContent = wonSales.length;
  document.getElementById("navTasksCount").textContent = state.tasks.length;

  const totalWork = state.tasks.length + state.followed.length;
  const pct = totalWork > 0 ? Math.round((state.followed.length / totalWork) * 100) : 0;

  // آپدیت حلقه پیشرفت SVG
  const circumference = 326.72;
  const offset = circumference - (pct / 100) * circumference;
  const ringEl = document.getElementById("progressRingCircle");
  if (ringEl) ringEl.style.strokeDashoffset = String(offset);

  document.getElementById("progressPercentText").textContent = `${pct}٪`;
  document.getElementById("progressRatioText").textContent = `${state.followed.length} از ${totalWork} تماس تکمیل شده`;

  // پیش‌نمایش تسک‌های فوری در داشبورد
  const previewBox = document.getElementById("urgentTasksPreview");
  previewBox.innerHTML =
    state.tasks
      .slice(0, 3)
      .map(
        (t) => `
    <div class="list-row">
      <div>
        <strong>${t.name || "بدون نام"}</strong>
        <div style="font-size:0.8rem;color:#94a3b8">${t.tab} • ${t.phone}</div>
      </div>
      <button class="btn btn-sm btn-primary" onclick="openOutcomeModal('${t.id}')">
        <i data-lucide="phone-call" class="icon-xs"></i>
        <span>ثبت تماس</span>
      </button>
    </div>
  `
      )
      .join("") || `<p class="muted-text">تمام تسک‌های امروز انجام شده‌اند.</p>`;

  renderTasksGrid();
  renderFollowedList();
  refreshIcons();
}

function renderTasksGrid() {
  const q = (document.getElementById("taskSearchInput").value || "").trim().toLowerCase();
  const filtered = state.tasks.filter((t) => {
    if (state.activeFilter === "new" && !t.isNew) return false;
    if (state.activeFilter === "followup" && t.isNew) return false;
    if (!q) return true;
    return (
      (t.name || "").toLowerCase().includes(q) ||
      (t.phone || "").includes(q) ||
      (t.tab || "").toLowerCase().includes(q)
    );
  });

  const grid = document.getElementById("tasksGrid");
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="glass-card panel-box"><p class="muted-text">موردی برای نمایش وجود ندارد.</p></div>`;
    return;
  }

  grid.innerHTML = filtered
    .map(
      (t, idx) => `
    <article class="glass-card spotlight-card task-card animate-up" style="--delay: ${Math.min(idx * 0.05, 0.35)}s">
      <div>
        <div class="task-top">
          <span class="tag ${t.isNew ? "new" : "followup"}">
            <i data-lucide="${t.isNew ? "phone-incoming" : "repeat"}" class="icon-xs"></i>
            <span>${t.isNew ? "تماس اول" : `پیگیری (${t.followCount} ➔ ${t.followCount + 1})`}</span>
          </span>
          <span class="tab-chip">${t.tab} • ردیف ${t.rowNum}</span>
        </div>
        <h4 class="student-name mt-12">${t.name || "بدون نام"}</h4>
        <a href="tel:${t.phone}" class="student-phone">${t.phone || "—"}</a>
      </div>

      <div class="gon-list">
        ${t.goal ? `<div class="gon-row"><i data-lucide="target" class="icon-xs text-accent"></i><span><strong>هدف:</strong> ${t.goal}</span></div>` : ""}
        ${t.obstacle ? `<div class="gon-row"><i data-lucide="alert-triangle" class="icon-xs text-primary"></i><span><strong>مانع:</strong> ${t.obstacle}</span></div>` : ""}
        ${t.need ? `<div class="gon-row"><i data-lucide="layers" class="icon-xs text-emerald"></i><span><strong>نیاز:</strong> ${t.need}</span></div>` : ""}
        ${t.objection ? `<div class="gon-row"><i data-lucide="shield-alert" class="icon-xs"></i><span><strong>آبجکشن:</strong> ${t.objection}</span></div>` : ""}
        ${!t.goal && !t.obstacle && !t.need ? `<div class="gon-row"><i data-lucide="clock" class="icon-xs"></i><span><strong>وضعیت قبلی:</strong> ${t.previousStatus || "ثبت نشده"}</span></div>` : ""}
      </div>

      <div class="card-actions">
        <button class="btn btn-primary btn-sm" onclick="openOutcomeModal('${t.id}')">
          <i data-lucide="check-square" class="icon-xs"></i>
          <span>ثبت نتیجه تماس</span>
        </button>
        <button class="btn btn-glass btn-sm" onclick="downloadVCard('${t.name || "دانشجو"}', '${t.phone}')">
          <i data-lucide="contact" class="icon-xs"></i>
          <span>مخاطب</span>
        </button>
      </div>
    </article>
  `
    )
    .join("");

  refreshIcons();
}

function renderFollowedList() {
  const container = document.getElementById("followedListContainer");
  if (state.followed.length === 0) {
    container.innerHTML = `<p class="muted-text">هنوز تماسی برای امروز ثبت نشده است.</p>`;
    return;
  }
  container.innerHTML = state.followed
    .map(
      (item) => `
    <div class="list-row">
      <div>
        <strong>${item.name}</strong> <span class="student-phone">(${item.phone})</span>
        <div style="font-size:0.82rem;color:#94a3b8;margin-top:4px">${item.logNote || item.outcome}</div>
      </div>
      <span class="tag new">
        <i data-lucide="check" class="icon-xs"></i>
        <span>${item.outcome}</span>
      </span>
    </div>
  `
    )
    .join("");
  refreshIcons();
}

function switchTab(tabName) {
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-view").forEach((sec) => {
    sec.classList.toggle("active", sec.id === `tab-${tabName}`);
    sec.classList.toggle("hidden", sec.id !== `tab-${tabName}`);
  });

  const titles = {
    dashboard: "داشبورد عملکرد روزانه",
    tasks: "میز کار تماس‌ها و پیگیری‌ها",
    students: "جستجو و مدیریت پرونده دانشجو",
    followed: "لیست پیگیری شده‌های امروز",
    aiTools: "پردازش هوشمند فیش و تحلیل مکالمه"
  };
  document.getElementById("pageTitle").textContent = titles[tabName] || "داشبورد";
}

function openOutcomeModal(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  state.selectedTask = task;
  state.selectedOutcome = "future_call";

  document.getElementById("modalStudentSummary").innerHTML = `
    <strong>${task.name || "بدون نام"}</strong> | <code>${task.phone}</code><br/>
    <small style="color:#94a3b8">تب: ${task.tab} • ردیف: ${task.rowNum}</small>
  `;
  document.getElementById("modalStudentName").value = task.name || "";
  document.getElementById("modalNoteInput").value = "";

  document.querySelectorAll(".outcome-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.outcome === state.selectedOutcome);
  });
  document.getElementById("outcomeModal").classList.remove("hidden");
  refreshIcons();
}

function downloadVCard(name, phone) {
  const fullName = `${name} آیولرن شاتل آذر`;
  const vcf = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${fullName}`,
    `N:${fullName};;;;`,
    `TEL;TYPE=CELL:${phone}`,
    "END:VCARD"
  ].join("\r\n");

  const blob = new Blob([vcf], { type: "text/vcard" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${fullName}.vcf`;
  a.click();
  showToast("فایل مخاطب آماده دانلود شد");
}

// --- رویدادهای صفحه ---
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const workerUrl = document.getElementById("workerUrl").value.trim();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  if (!workerUrl) {
    showToast("برای ورود واقعی آدرس Worker را وارد کنید یا از دکمه دمو استفاده کنید.");
    return;
  }

  try {
    state.workerUrl = workerUrl;
    state.isDemo = false;
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "نام کاربری یا رمز عبور اشتباه است");

    state.token = data.token;
    state.userName = data.displayName || username;
    localStorage.setItem("crm_worker_url", state.workerUrl);
    localStorage.setItem("crm_auth_token", state.token);
    localStorage.setItem("crm_user_name", state.userName);
    enterAppShell();
    showToast("ورود با موفقیت انجام شد");
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById("demoLoginBtn").addEventListener("click", () => {
  state.isDemo = true;
  state.userName = "میلاد قاسمی (دمو)";
  enterAppShell();
  showToast("وارد محیط نمایشی شدید");
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem("crm_auth_token");
  location.reload();
});

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    state.activeFilter = pill.dataset.filter;
    renderTasksGrid();
  });
});

document.getElementById("taskSearchInput").addEventListener("input", renderTasksGrid);
document.getElementById("refreshDataBtn").addEventListener("click", () => {
  loadDashboardData();
  showToast("اطلاعات همگام‌سازی شد");
});

document.querySelectorAll(".outcome-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.selectedOutcome = btn.dataset.outcome;
    document.querySelectorAll(".outcome-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
  });
});

document.getElementById("closeModalBtn").addEventListener("click", () => {
  document.getElementById("outcomeModal").classList.add("hidden");
});

document.getElementById("saveOutcomeBtn").addEventListener("click", async () => {
  if (!state.selectedTask) return;
  const studentName = document.getElementById("modalStudentName").value.trim() || state.selectedTask.name || "بدون نام";
  const note = document.getElementById("modalNoteInput").value.trim();
  const outcomeLabel = OUTCOME_LABELS[state.selectedOutcome];

  if (state.isDemo) {
    state.tasks = state.tasks.filter((t) => t.id !== state.selectedTask.id);
    state.followed.unshift({
      name: studentName,
      phone: state.selectedTask.phone,
      tab: state.selectedTask.tab,
      rowNum: state.selectedTask.rowNum,
      outcome: outcomeLabel,
      followNumber: (state.selectedTask.followCount || 0) + 1,
      logNote: `پیگیری شد (${outcomeLabel})[${note}]///`
    });
    document.getElementById("outcomeModal").classList.add("hidden");
    renderAllViews();
    showToast("نتیجه تماس با موفقیت ثبت شد");
    return;
  }

  try {
    await apiRequest("/api/tasks/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: state.selectedTask.id,
        outcomeKey: state.selectedOutcome,
        studentName,
        extraDescription: note
      })
    });
    document.getElementById("outcomeModal").classList.add("hidden");
    await loadDashboardData();
    showToast("در گوگل‌شیت و سیستم ثبت شد");
  } catch (err) {
    showToast(err.message);
  }
});

// جستجوی پرونده دانشجو
document.getElementById("runStudentSearchBtn").addEventListener("click", async () => {
  const q = document.getElementById("studentGlobalSearch").value.trim();
  if (!q) return;

  let results = [];
  if (state.isDemo) {
    results = [...DEMO_DATA.tasks].filter(
      (s) => (s.name || "").includes(q) || (s.phone || "").includes(q) || (s.tab || "").includes(q)
    );
  } else {
    try {
      const data = await apiRequest(`/api/students/search?q=${encodeURIComponent(q)}`);
      results = data.matches || [];
    } catch (err) {
      showToast(err.message);
      return;
    }
  }

  const box = document.getElementById("studentSearchResults");
  if (results.length === 0) {
    box.innerHTML = `<p class="muted-text">دانشجویی با این مشخصات پیدا نشد.</p>`;
    return;
  }

  box.innerHTML = results
    .map(
      (s) => `
    <div class="glass-card spotlight-card task-card">
      <div>
        <span class="tab-chip">${s.tab} • ردیف ${s.rowNum}</span>
        <h4 class="student-name mt-12">${s.name || "بدون نام"}</h4>
        <div class="student-phone">${s.phone || "—"}</div>
      </div>
      <div class="gon-list">
        <div class="gon-row"><i data-lucide="activity" class="icon-xs text-accent"></i><span><strong>وضعیت:</strong> ${s.status || s.previousStatus || "ثبت نشده"}</span></div>
        <div class="gon-row"><i data-lucide="repeat" class="icon-xs text-primary"></i><span><strong>پیگیری:</strong> ${s.followCount || 0} بار</span></div>
      </div>
      <div class="card-actions">
        <button class="btn btn-glass btn-sm" onclick="downloadVCard('${s.name || "دانشجو"}', '${s.phone}')">
          <i data-lucide="contact" class="icon-xs"></i>
          <span>خروجی مخاطب</span>
        </button>
      </div>
    </div>
  `
    )
    .join("");
  refreshIcons();
});

// پیش‌نمایش نام فایل‌های انتخاب‌شده
document.getElementById("receiptFileInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) document.getElementById("receiptFileName").textContent = file.name;
});

document.getElementById("voiceFileInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) document.getElementById("voiceFileName").textContent = file.name;
});

// مقداردهی اولیه آیکون‌ها هنگام لود صفحه
document.addEventListener("DOMContentLoaded", refreshIcons);
refreshIcons();
