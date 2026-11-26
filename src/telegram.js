import {
  DEFAULT_IGNORED_TABS,
  MESSENGER_PATTERNS,
  HEADER_ROLE_RULES,
  getEffectiveSheetId,
  getEffectiveReceiptChannelId,
  columnIndexToLetter,
  normalizeHeaderTitle,
  toEnglishDigits,
  normalizePhoneKey,
  resolveDynamicColumnMap,
  detectHeaderRowIndex,
  extractActiveMessengersByHeaders,
  getGoogleAccessToken,
  fetchAllSheetTabs,
  fetchAllSheetRows,
  writeSingleCellToSheet
} from "./sheets.js";
import {
  sleep,
  extractJsonBlock,
  getGeminiModels,
  getGroqTextModels,
  getGroqAudioModel,
  getGeminiApiKeys,
  getGroqApiKeys,
  callAiTextWithFallback,
  callAiImageWithFallback,
  callAiAudioWithFallback
} from "./ai.js";

const AI_CHUNK_SIZE = 15;
const AI_TASK_FILTER_CHUNK_SIZE = 30;
const TASKS_PER_SINGLE_MESSAGE = 6;

const CALL_OUTCOME_OPTIONS = [
  { key: "won_sale", label: "موفق - فروش بسته" },
  { key: "future_call", label: "پیگیری - تماس آینده" },
  { key: "no_answer", label: "پیگیری - جواب نداد" },
  { key: "switched_off", label: "پیگیری - خاموش بود" },
  { key: "wrong_num", label: "ناموفق - اشتباه بود" },
  { key: "def_no", label: "ناموفق - قطعی نمی‌خواهد" }
];

// --- [لایه دیتابیس Cloudflare D1] ---
let botStateTableReady = false;

async function ensureBotStateTable(env) {
  if (!env.DB) {
    throw new Error("اتصال دیتابیس D1 با نام DB در تنظیمات Worker تعریف نشده است.");
  }
  if (botStateTableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS bot_state (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at INTEGER)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS user_sessions (telegram_user_id TEXT PRIMARY KEY, username TEXT NOT NULL, workspace_json TEXT NOT NULL, logged_in_at INTEGER NOT NULL, expires_at INTEGER)"
  ).run();
  botStateTableReady = true;
}

async function dbGet(env, key) {
  if (!env.DB) return null;
  await ensureBotStateTable(env);
  const nowSec = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT v, expires_at FROM bot_state WHERE k = ?"
  )
    .bind(key)
    .first();

  if (!row) return null;
  if (row.expires_at && row.expires_at <= nowSec) {
    await env.DB.prepare("DELETE FROM bot_state WHERE k = ?").bind(key).run();
    return null;
  }
  return row.v;
}

async function dbPut(env, key, value, options = {}) {
  if (!env.DB) {
    throw new Error("اتصال دیتابیس D1 با نام DB تنظیم نشده است.");
  }
  await ensureBotStateTable(env);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = options.expirationTtl ? nowSec + Number(options.expirationTtl) : null;

  await env.DB.prepare(
    "INSERT INTO bot_state (k, v, expires_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at"
  )
    .bind(key, String(value), expiresAt)
    .run();
}

async function dbDelete(env, key) {
  if (!env.DB) return;
  await ensureBotStateTable(env);
  await env.DB.prepare("DELETE FROM bot_state WHERE k = ?").bind(key).run();
}

// --- [لایه احراز هویت و مدیریت فضای کاری] ---
function parseConfiguredUsers(env) {
  if (env.AUTH_USERS_JSON) {
    try {
      const parsed = JSON.parse(env.AUTH_USERS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((u) => u && u.username && u.password);
      }
    } catch (e) {
      console.error("Invalid AUTH_USERS_JSON:", e);
    }
  }

  const configuredUser = (env.AUTH_USER || env.DEFAULT_LOGIN_USER || "").trim();
  const configuredPass = env.AUTH_PASS || env.DEFAULT_LOGIN_PASSWORD || "";
  if (configuredUser && configuredPass) {
    return [
      {
        username: configuredUser,
        password: configuredPass,
        userId: "u_configured_admin",
        displayName: "مدیر سیستم",
        sheetId: env.GOOGLE_SHEET_ID || "",
        receiptChannelId: env.RECEIPT_CHANNEL_ID || "",
        adminChatId: env.ADMIN_CHAT_ID || ""
      }
    ];
  }
  return [];
}

async function getUserWorkspace(env, telegramUserId) {
  if (!telegramUserId) return null;
  if (env.DB) {
    await ensureBotStateTable(env);
    const nowSec = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      "SELECT telegram_user_id, username, workspace_json, expires_at FROM user_sessions WHERE telegram_user_id = ?"
    )
      .bind(String(telegramUserId))
      .first();

    if (row) {
      if (row.expires_at && row.expires_at <= nowSec) {
        await env.DB.prepare("DELETE FROM user_sessions WHERE telegram_user_id = ?")
          .bind(String(telegramUserId))
          .run();
        return null;
      }
      try {
        const ws = JSON.parse(row.workspace_json);
        return {
          ...ws,
          userId: ws.userId || `tg_${telegramUserId}`,
          telegramUserId: String(telegramUserId),
          username: row.username || ws.username,
          sheetId: ws.sheetId || env.GOOGLE_SHEET_ID || "",
          receiptChannelId: ws.receiptChannelId || env.RECEIPT_CHANNEL_ID || "",
          adminChatId: ws.adminChatId || env.ADMIN_CHAT_ID || ""
        };
      } catch {
        return null;
      }
    }
  }

  const rawCache = await dbGet(env, `auth_session:${telegramUserId}`);
  if (!rawCache) return null;
  try {
    const ws = JSON.parse(rawCache);
    return {
      ...ws,
      userId: ws.userId || `tg_${telegramUserId}`,
      telegramUserId: String(telegramUserId),
      sheetId: ws.sheetId || env.GOOGLE_SHEET_ID || "",
      receiptChannelId: ws.receiptChannelId || env.RECEIPT_CHANNEL_ID || "",
      adminChatId: ws.adminChatId || env.ADMIN_CHAT_ID || ""
    };
  } catch {
    return null;
  }
}

async function upsertUserWorkspace(env, telegramUserId, workspacePatch = {}, ttlSeconds = 86400 * 14) {
  const uid = String(telegramUserId);
  const existing = (await getUserWorkspace(env, uid)) || {};
  const merged = {
    ...existing,
    ...workspacePatch,
    userId: workspacePatch.userId || existing.userId || `tg_${uid}`,
    telegramUserId: uid,
    sheetId: workspacePatch.sheetId !== undefined ? workspacePatch.sheetId : existing.sheetId || env.GOOGLE_SHEET_ID || "",
    receiptChannelId: workspacePatch.receiptChannelId !== undefined ? workspacePatch.receiptChannelId : existing.receiptChannelId || env.RECEIPT_CHANNEL_ID || "",
    adminChatId: workspacePatch.adminChatId !== undefined ? workspacePatch.adminChatId : existing.adminChatId || env.ADMIN_CHAT_ID || ""
  };

  if (env.DB) {
    await ensureBotStateTable(env);
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = ttlSeconds ? nowSec + Number(ttlSeconds) : null;
    await env.DB.prepare(
      "INSERT INTO user_sessions (telegram_user_id, username, workspace_json, logged_in_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(telegram_user_id) DO UPDATE SET username = excluded.username, workspace_json = excluded.workspace_json, logged_in_at = excluded.logged_in_at, expires_at = excluded.expires_at"
    )
      .bind(uid, merged.username || "user", JSON.stringify(merged), nowSec, expiresAt)
      .run();
  }

  await dbPut(env, `auth_session:${uid}`, JSON.stringify(merged), { expirationTtl: ttlSeconds });
  return merged;
}

async function clearUserWorkspaceSession(env, telegramUserId) {
  const uid = String(telegramUserId);
  if (env.DB) {
    await ensureBotStateTable(env);
    await env.DB.prepare("DELETE FROM user_sessions WHERE telegram_user_id = ?").bind(uid).run();
  }
  await dbDelete(env, `auth_session:${uid}`);
  await dbDelete(env, `login_flow:${uid}`);
}

async function startLoginFlow(env, chatId, telegramUserId, promptNote = "") {
  const uid = String(telegramUserId);
  const configuredUsers = parseConfiguredUsers(env);
  if (configuredUsers.length === 0) {
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      "⚠️ *حساب کاربری در متغیرهای محیطی Worker تنظیم نشده است.*"
    );
    return;
  }

  await dbPut(env, `login_flow:${uid}`, JSON.stringify({ step: "awaiting_username", username: "" }), { expirationTtl: 900 });
  await sendTelegramMessage(
    env.BOT_TOKEN,
    chatId,
    (promptNote ? `${promptNote}\n\n` : "") + `🔐 *ورود به حساب کاربری*\nلطفاً **نام کاربری (Username)** خود را ارسال کنید:`
  );
}

async function handleLoginTextStep(env, chatId, telegramUserId, text) {
  const uid = String(telegramUserId);
  const rawFlow = await dbGet(env, `login_flow:${uid}`);
  if (!rawFlow) {
    await startLoginFlow(env, chatId, uid);
    return true;
  }

  const flow = JSON.parse(rawFlow);
  const cleanInput = String(text || "").trim();

  if (flow.step === "awaiting_username") {
    flow.username = cleanInput;
    flow.step = "awaiting_password";
    await dbPut(env, `login_flow:${uid}`, JSON.stringify(flow), { expirationTtl: 900 });
    await sendTelegramMessage(env.BOT_TOKEN, chatId, `🔑 حالا **رمز عبور** برای \`${escapeTelegramMarkdown(cleanInput)}\` را وارد کنید:`);
    return true;
  }

  if (flow.step === "awaiting_password") {
    const users = parseConfiguredUsers(env);
    const matchedUser = users.find(
      (u) => String(u.username || "").trim() === String(flow.username || "").trim() && String(u.password || "") === cleanInput
    );

    if (!matchedUser) {
      await dbPut(env, `login_flow:${uid}`, JSON.stringify({ step: "awaiting_username", username: "" }), { expirationTtl: 900 });
      await sendTelegramMessage(env.BOT_TOKEN, chatId, `❌ *نام کاربری یا رمز عبور اشتباه است.*\nلطفاً **نام کاربری** را دوباره وارد کنید:`);
      return true;
    }

    await dbDelete(env, `login_flow:${uid}`);
    const ws = await upsertUserWorkspace(env, uid, {
      userId: matchedUser.userId || `user_${matchedUser.username}`,
      username: matchedUser.username,
      displayName: matchedUser.displayName || matchedUser.username,
      sheetId: matchedUser.sheetId || env.GOOGLE_SHEET_ID || "",
      receiptChannelId: matchedUser.receiptChannelId || env.RECEIPT_CHANNEL_ID || "",
      adminChatId: matchedUser.adminChatId || String(chatId)
    });

    await sendTelegramMessage(env.BOT_TOKEN, chatId, `✅ *ورود موفقیت‌آمیز بود!* (${escapeTelegramMarkdown(ws.displayName || ws.username)})`, QUICK_SUMMON_KEYBOARD);
    await sendTelegramMessage(env.BOT_TOKEN, chatId, buildPanelWelcomeText(env, "🔐 احراز هویت: *تایید شد ✅*"), getMainGlassPanel());
    return true;
  }
  return false;
}

async function handleAuthenticationGate(update, env) {
  const fromUser = update.message?.from || update.callback_query?.from;
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id || fromUser?.id;
  if (!fromUser?.id || !chatId) return null;

  const uid = String(fromUser.id);
  const existingWs = await getUserWorkspace(env, uid);

  if (existingWs) {
    if (update.message?.text && update.message.text.trim() === "/logout") {
      await clearUserWorkspaceSession(env, uid);
      await sendTelegramMessage(env.BOT_TOKEN, chatId, "🚪 *از حساب کاربری خارج شدید.*");
      return null;
    }
    return existingWs;
  }

  if (update.callback_query) {
    await answerCallback(env.BOT_TOKEN, update.callback_query.id, "ابتدا وارد حساب کاربری شوید");
    await startLoginFlow(env, chatId, uid, "🔒 برای استفاده از دکمه‌ها ابتدا وارد شوید:");
    return null;
  }

  const msgText = (update.message?.text || "").trim();
  const rawFlow = await dbGet(env, `login_flow:${uid}`);
  if (rawFlow && msgText && !msgText.startsWith("/")) {
    await handleLoginTextStep(env, chatId, uid, msgText);
    return null;
  }

  await startLoginFlow(env, chatId, uid, "🔒 *دسترسی نیازمند ورود به حساب کاربری است.*");
  return null;
}

// --- [توابع کمکی وضعیت، تاریخ، شماره و گزارش‌ها] ---
function normalizeStatusComparable(str) {
  return normalizeHeaderTitle(str).replace(/\s*-\s*/g, "-").replace(/\s*–\s*/g, "-").trim();
}

function escapeTelegramMarkdown(text) {
  return String(text || "").replace(/([_*`\[])/g, "\\$1");
}

function hasStrikethroughName(nameText = "", isStruckInSheet = false) {
  if (isStruckInSheet) return true;
  const s = String(nameText || "").trim();
  if (!s) return false;
  return /^~.+~$/.test(s) || /[\u0336\u0335\u2015\u2014]/.test(s);
}

function canonicalizeOutcomeLabel(rawValue) {
  const norm = normalizeStatusComparable(rawValue || "");
  if (!norm) return "";
  const exactOption = CALL_OUTCOME_OPTIONS.find((opt) => normalizeStatusComparable(opt.label) === norm);
  if (exactOption) return exactOption.label;
  if (norm.includes("فروش بسته") || norm.includes("بسته فروش") || norm.includes("ثبت نام") || norm.includes("موفق")) return "موفق - فروش بسته";
  if (norm.includes("تماس آینده") || norm.includes("آینده")) return "پیگیری - تماس آینده";
  if (norm.includes("خاموش")) return "پیگیری - خاموش بود";
  if (norm.includes("جواب نداد") || norm.includes("پاسخ نداد") || norm.includes("رد تماس")) return "پیگیری - جواب نداد";
  if (norm.includes("اشتباه")) return "ناموفق - اشتباه بود";
  if (norm.includes("قطعی نمی‌خواهد") || norm.includes("قطعی نمیخواهد") || norm.includes("نمی‌خواهد") || norm.includes("نمیخواهد") || norm.includes("انصراف")) return "ناموفق - قطعی نمی‌خواهد";
  return String(rawValue || "").trim();
}

function fallbackShouldExcludeRow(fields = {}) {
  const statusNorm = normalizeStatusComparable(fields.status || "");
  return (
    statusNorm.includes("قطعی نمی‌خواهد") ||
    statusNorm.includes("قطعی نمیخواهد") ||
    statusNorm.includes("اشتباه بود") ||
    statusNorm.includes("فروش بسته") ||
    statusNorm.includes("بسته فروش")
  );
}

function shouldRequeueSameDayFromNote(noteText = "") {
  const clean = toEnglishDigits(String(noteText || "")).trim();
  if (!clean) return false;
  return /(ساعت\s*\d|چند ساعت بعد|ساعت بعد|امروز تماس|همین امروز|امشب|عصر|بعدازظهر|بعد از ظهر|دوباره تماس|تماس مجدد|زنگ بزنم|پیگیری امروز)/i.test(clean);
}

async function classifyExcludedRowsWithAi(env, candidates = []) {
  const excludedSet = new Set();
  if (!candidates.length) return excludedSet;
  const deadKeys = new Set();

  for (let i = 0; i < candidates.length; i += AI_TASK_FILTER_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + AI_TASK_FILTER_CHUNK_SIZE);
    const payload = chunk.map((c) => ({ id: c.id, status: c.status || "", description: c.description || "" }));
    const systemPrompt =
      'فقط ردیف‌هایی را در excluded_ids قرار بده که قطعی تمام شده‌اند (فروش بسته، قطعی نمی‌خواهد، شماره اشتباه). خروجی JSON: {"excluded_ids": ["..."]}';
    try {
      const res = await callAiTextWithFallback(env, systemPrompt, JSON.stringify(payload), null, deadKeys);
      const parsed = JSON.parse(extractJsonBlock(res.text));
      if (Array.isArray(parsed.excluded_ids)) {
        for (const id of parsed.excluded_ids) excludedSet.add(String(id));
      }
    } catch {
      for (const c of chunk) {
        if (fallbackShouldExcludeRow({ status: c.status, description: c.description })) excludedSet.add(c.id);
      }
    }
  }
  return excludedSet;
}

function parseNumericFollowCount(rawValue) {
  const cleaned = toEnglishDigits(String(rawValue ?? "")).trim();
  if (!cleaned) return null;
  const barMatch = cleaned.match(/(\d+)\s*بار/);
  if (barMatch) {
    const parsed = parseInt(barMatch[1], 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  const anyNumMatch = cleaned.match(/\d+/);
  if (!anyNumMatch) return null;
  const parsed = parseInt(anyNumMatch[0], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function buildTaskIdentityKeys(tabName, rowNum, phone) {
  const cleanTab = normalizeHeaderTitle(tabName);
  const cleanPhone = normalizePhoneKey(phone);
  const keys = [];
  if (cleanTab && cleanPhone) keys.push(`tab_phone::${cleanTab}::${cleanPhone}`);
  if (cleanTab && rowNum) keys.push(`tab_row::${cleanTab}::${rowNum}`);
  if (cleanPhone) keys.push(`global_phone::${cleanPhone}`);
  return keys;
}

function extractGoalObstacleNeedFromFields(fields) {
  let goal = String(fields.goal || "").trim();
  let obstacle = String(fields.obstacle || "").trim();
  let need = String(fields.need || "").trim();
  const combined = String(fields.gonCombined || "").trim();
  if (!goal && !obstacle && !need && combined) goal = combined;
  const shortText = (s) => (s.length > 95 ? `${s.slice(0, 95)}...` : s);
  return {
    goal: goal ? shortText(goal) : "",
    obstacle: obstacle ? shortText(obstacle) : "",
    need: need ? shortText(need) : "",
    summaryText: [
      goal ? `🎯 *هدف:* ${shortText(goal)}` : "",
      obstacle ? `🚧 *مانع:* ${shortText(obstacle)}` : "",
      need ? `🧩 *نیاز:* ${shortText(need)}` : ""
    ].filter(Boolean).join("  |  ")
  };
}

function getTodayTehranKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tehran" });
}

function getGregorianSheetDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(new Date());
  const month = parts.find((p) => p.type === "month")?.value || "";
  const day = parts.find((p) => p.type === "day")?.value || "";
  const year = parts.find((p) => p.type === "year")?.value || "";
  return month && day && year ? `${month}/${day}/${year}` : new Date().toLocaleDateString("en-US", { timeZone: "Asia/Tehran" });
}

function getTehranWeekdayName() {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", weekday: "long" }).format(new Date());
}

function getTehranDateDisplay() {
  const gregDate = getGregorianSheetDate();
  const weekday = getTehranWeekdayName();
  return weekday ? `${gregDate} (${weekday})` : gregDate;
}

function getTehranTimeDisplay() {
  return new Date().toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit" });
}

function formatFollowUpNoteEntry(outcomeLabel, extraNote = "") {
  const clock = getTehranTimeDisplay();
  const dayLabel = getTehranDateDisplay();
  const cleanExtra = String(extraNote || "").trim();
  const bracketPart = cleanExtra ? `[${cleanExtra}]` : "[]";
  return `پیگیری شد (${clock} - ${dayLabel}) (${outcomeLabel})${bracketPart}///`;
}

function formatContactFullName(studentName) {
  const cleanName = String(studentName || "").trim() || "دانشجو";
  return `${cleanName} آیولرن شاتل آذر`;
}

function buildVCardString(studentName, phone, note = "") {
  const fullName = formatContactFullName(studentName);
  const cleanPhone = normalizePhoneKey(phone) || String(phone || "").trim();
  const cleanNote = String(note || "").replace(/\r?\n/g, " ").trim();
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${fullName}`,
    `N:${fullName};;;;`,
    cleanPhone ? `TEL;TYPE=CELL:${cleanPhone}` : "",
    cleanNote ? `NOTE:${cleanNote}` : "",
    "END:VCARD"
  ].filter(Boolean).join("\r\n");
}

function collectPresetOptionsFromRows(rows = [], fieldKey) {
  const set = new Set();
  for (const r of rows) {
    const val = String(r?.fields?.[fieldKey] || "").trim();
    if (val) set.add(val);
  }
  return Array.from(set).slice(0, 40);
}

function isValidGregorianDateValue(val) {
  const s = toEnglishDigits(String(val || "")).trim();
  if (!s || /^13\d\d\/|^14\d\d\//.test(s)) return false;
  return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s);
}

function fallbackPresetMatch(presetOptions = [], preferredValues = [], fieldKey = "") {
  const list = Array.isArray(presetOptions) ? presetOptions : [];
  if (fieldKey === "status") {
    const canonicalPrefs = preferredValues.map((v) => canonicalizeOutcomeLabel(v)).filter(Boolean);
    for (const pref of canonicalPrefs) {
      const exact = list.find((opt) => normalizeStatusComparable(opt) === normalizeStatusComparable(pref));
      if (exact) return exact;
    }
    return canonicalPrefs[0] || "";
  }
  if (fieldKey === "entryDate") {
    return getGregorianSheetDate();
  }
  for (const pref of preferredValues) {
    const cleanPref = normalizeStatusComparable(pref || "");
    if (!cleanPref) continue;
    const exact = list.find((opt) => normalizeStatusComparable(opt) === cleanPref);
    if (exact) return exact;
  }
  return "";
}

async function resolvePresetFieldsWithAi(env, params) {
  const { outcomeLabel, extraDescription, currentFields = {}, rowNum, presets = {} } = params;
  const canonicalOutcome = canonicalizeOutcomeLabel(outcomeLabel);
  const todayGreg = getGregorianSheetDate();

  return {
    entryDate: fallbackPresetMatch(presets.entryDate, [currentFields.entryDate, todayGreg], "entryDate"),
    rowSerial: fallbackPresetMatch(presets.rowSerial, [currentFields.rowSerial, String(rowNum || "")], "rowSerial"),
    weekday: fallbackPresetMatch(presets.weekday, [currentFields.weekday, getTehranWeekdayName()], "weekday"),
    status: fallbackPresetMatch(presets.status, [canonicalOutcome, currentFields.status], "status")
  };
}

const QUICK_SUMMON_KEYBOARD = {
  keyboard: [
    [{ text: "🎛 پنل شیشه‌ای" }, { text: "🔍 جستجوی دانشجو" }],
    [{ text: "✅ پیگیری شده‌ها" }, { text: "📊 گزارش روزانه" }],
    [{ text: "🛑 توقف فوری" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

function getMainGlassPanel() {
  return {
    inline_keyboard: [
      [
        { text: "🔍 جستجوی دانشجو", callback_data: "panel:student_search" },
        { text: "📋 همه تسک‌ها", callback_data: "panel:tasks" }
      ],
      [
        { text: "📞 تماس‌های اول", callback_data: "panel:tasks_new" },
        { text: "🔥 پیگیری‌ها", callback_data: "panel:tasks_followup" }
      ],
      [
        { text: "⏰ تماس مجدد امروز", callback_data: "panel:requeue_today" },
        { text: "✅ پیگیری شده‌ها", callback_data: "panel:followed_up" }
      ],
      [
        { text: "📊 گزارش روزانه", callback_data: "panel:daily_report" },
        { text: "🧠 تحلیل کل شیت", callback_data: "panel:check_all" }
      ],
      [
        { text: "📂 تحلیل تب خاص", callback_data: "panel:select_tab" },
        { text: "🔍 بررسی اجمالی", callback_data: "panel:task_overview" }
      ],
      [
        { text: "📈 تغییرات دانشجوها", callback_data: "panel:changes" },
        { text: "🛑 توقف عملیات", callback_data: "panel:stop" }
      ],
      [{ text: "✨ تازه‌سازی پنل", callback_data: "panel:refresh" }]
    ]
  };
}

function buildPanelWelcomeText(env, webhookStatusLine = "") {
  const geminiKeysCount = getGeminiApiKeys(env).length;
  const groqKeysCount = getGroqApiKeys(env).length;
  const tehranTime = new Date().toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    `🎛 *پـنـل هـوشـمـنـد فـروش و پـیـگـیـری*\n` +
    `⚡ *وضعیت:* \`آنلاین (D1 SQL)\`  •  🕒 \`${tehranTime}\`\n` +
    `🔑 *موتورها:* *${geminiKeysCount}* Gemini  •  *${groqKeysCount}* Groq\n` +
    (webhookStatusLine ? `${webhookStatusLine}\n` : "") +
    `👇 *یک گزینه را لمس کنید یا ویس/فیش بفرستید:*`
  );
}

async function ensureTelegramWebhookConfigured(botToken, originUrl, secretToken = "") {
  const webhookUrl = `${originUrl}/webhook`;
  const webhookPayload = { url: webhookUrl, allowed_updates: ["message", "callback_query"] };
  if (secretToken) webhookPayload.secret_token = secretToken;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(webhookPayload)
  });
  const setWebhookResult = await res.json();
  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  const webhookInfo = await infoRes.json();
  return { setWebhookResult, webhookInfo };
}

async function addTaskToFollowedUpSection(env, entry) {
  if (!env.DB) throw new Error("اتصال دیتابیس D1 با نام DB تنظیم نشده است.");
  const dateKey = getTodayTehranKey();
  const listKey = `followed_up_list:${dateKey}`;
  const raw = await dbGet(env, listKey);
  const list = raw ? JSON.parse(raw) : [];
  const identityKeys = buildTaskIdentityKeys(entry.tab, entry.rowNum, entry.phone);

  const record = {
    identityKey: entry.identityKey || identityKeys[0] || `${entry.tab}::${entry.rowNum}`,
    identityKeys,
    phoneNormalized: normalizePhoneKey(entry.phone),
    name: entry.name || "بدون نام",
    phone: entry.phone || "—",
    tab: entry.tab || "—",
    rowNum: entry.rowNum || "—",
    previousStatus: entry.previousStatus || "ثبت نشده",
    outcome: canonicalizeOutcomeLabel(entry.outcome) || entry.outcome,
    followNumber: entry.followNumber,
    logNote: entry.logNote,
    requeueSameDay: Boolean(entry.requeueSameDay),
    timeDisplay: entry.timeDisplay,
    dateDisplay: entry.dateDisplay
  };

  const idx = list.findIndex((x) => {
    const existingKeys = x.identityKeys || buildTaskIdentityKeys(x.tab, x.rowNum, x.phone);
    return existingKeys.some((k) => identityKeys.includes(k));
  });
  if (idx >= 0) list[idx] = record;
  else list.unshift(record);

  await dbPut(env, listKey, JSON.stringify(list), { expirationTtl: 604800 });
}

async function getFollowedUpMapForToday(env) {
  if (!env.DB) return {};
  const dateKey = getTodayTehranKey();
  const map = {};
  const rawFollowed = await dbGet(env, `followed_up_list:${dateKey}`);
  const followedList = rawFollowed ? JSON.parse(rawFollowed) : [];
  for (const item of followedList) {
    if (item.requeueSameDay) continue;
    const keys = item.identityKeys || buildTaskIdentityKeys(item.tab, item.rowNum, item.phone);
    for (const k of keys) map[k] = item;
  }
  return map;
}

async function appendPersonalDailyWorkLog(env, entry) {
  if (!env.DB) return;
  const dateKey = getTodayTehranKey();
  const storageKey = `daily_work_log:${dateKey}`;
  const raw = await dbGet(env, storageKey);
  const logs = raw ? JSON.parse(raw) : [];
  const identityKeys = buildTaskIdentityKeys(entry.tab, entry.rowNum, entry.phone);

  const record = {
    id: `${entry.token}::${entry.timeDisplay}`,
    token: entry.token,
    identityKey: entry.identityKey || identityKeys[0] || "",
    identityKeys,
    name: entry.name || "بدون نام",
    phone: entry.phone || "—",
    tab: entry.tab || "—",
    rowNum: entry.rowNum || "—",
    previousStatus: entry.previousStatus || "ثبت نشده",
    newStatus: canonicalizeOutcomeLabel(entry.newStatus) || entry.newStatus,
    followNumber: entry.followNumber,
    timeDisplay: entry.timeDisplay,
    logNote: entry.logNote || ""
  };

  const existingIdx = logs.findIndex((x) => {
    const existingKeys = x.identityKeys || buildTaskIdentityKeys(x.tab, x.rowNum, x.phone);
    return existingKeys.some((k) => identityKeys.includes(k)) || x.token === record.token;
  });
  if (existingIdx >= 0) logs[existingIdx] = record;
  else logs.push(record);

  await dbPut(env, storageKey, JSON.stringify(logs), { expirationTtl: 604800 });
}

function encodeTaskToken(tabName, rowNum) {
  const bytes = new TextEncoder().encode(`${tabName}::${rowNum}`);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 40);
}

async function collectTodayTasks(env, mode = "all", ws = null) {
  const { tabsData, totalStudents } = await fetchAllSheetRows(env, ws);
  const followedMap = await getFollowedUpMapForToday(env);

  const prelimRows = [];
  const aiCandidates = [];
  let followedCountToday = 0;

  for (const t of tabsData) {
    const getLetter = (role) => {
      const idx = t.colMap?.[role] ?? -1;
      return idx !== -1 ? columnIndexToLetter(idx) : "";
    };

    const tabPresets = {
      entryDate: collectPresetOptionsFromRows(t.rows, "entryDate"),
      rowSerial: collectPresetOptionsFromRows(t.rows, "rowSerial"),
      weekday: collectPresetOptionsFromRows(t.rows, "weekday"),
      status: collectPresetOptionsFromRows(t.rows, "status")
    };

    for (const r of t.rows) {
      if (!r.phone && !r.fields.name) continue;
      if (hasStrikethroughName(r.fields.name, r.isNameStruck)) continue;

      const candidateKeys = buildTaskIdentityKeys(t.tab, r.rowNum, r.phone);
      if (candidateKeys.some((k) => Boolean(followedMap[k]))) {
        followedCountToday++;
        continue;
      }

      const id = `${t.tab}::${r.rowNum}`;
      prelimRows.push({
        id,
        t,
        r,
        candidateKeys,
        descColLetter: getLetter("description"),
        nameColLetter: getLetter("name"),
        followColLetter: getLetter("followCount"),
        entryDateColLetter: getLetter("entryDate"),
        rowSerialColLetter: getLetter("rowSerial"),
        weekdayColLetter: getLetter("weekday"),
        statusColLetter: getLetter("status"),
        tabPresets
      });

      if (r.fields.status || r.fields.description) {
        aiCandidates.push({ id, status: r.fields.status || "", description: r.fields.description || "" });
      }
    }
  }

  const excludedByAi = await classifyExcludedRowsWithAi(env, aiCandidates);
  const newCalls = [];
  const followUps = [];
  const seen = new Set();

  for (const entry of prelimRows) {
    if (excludedByAi.has(entry.id)) continue;
    const { t, r, candidateKeys, tabPresets } = entry;
    const normPhone = normalizePhoneKey(r.phone);
    const dedupKey = normPhone ? `${normalizeHeaderTitle(t.tab)}::${normPhone}` : `${normalizeHeaderTitle(t.tab)}::row_${r.rowNum}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const numericFollow = parseNumericFollowCount(r.fields.followCount);
    const isNew = numericFollow === null;
    const followCount = numericFollow !== null ? numericFollow : 0;
    const gon = extractGoalObstacleNeedFromFields(r.fields);

    const item = {
      tab: t.tab,
      rowNum: r.rowNum,
      identityKey: candidateKeys[0] || `${t.tab}::${r.rowNum}`,
      identityKeys: candidateKeys,
      phoneNormalized: normPhone,
      descColLetter: entry.descColLetter,
      nameColLetter: entry.nameColLetter,
      followColLetter: entry.followColLetter,
      entryDateColLetter: entry.entryDateColLetter,
      rowSerialColLetter: entry.rowSerialColLetter,
      weekdayColLetter: entry.weekdayColLetter,
      statusColLetter: entry.statusColLetter,
      tabPresets,
      currentRowFields: {
        entryDate: r.fields.entryDate || "",
        rowSerial: r.fields.rowSerial || "",
        weekday: r.fields.weekday || "",
        status: r.fields.status || ""
      },
      phone: r.phone,
      name: r.fields.name || "",
      previousStatus: String(r.fields.status || "").trim() || "ثبت نشده",
      messengers: r.messengers || [],
      followCount,
      isNew,
      goal: gon.goal,
      obstacle: gon.obstacle,
      need: gon.need,
      objection: r.fields.objection || "",
      description: r.fields.description || "",
      token: encodeTaskToken(t.tab, r.rowNum)
    };

    if (isNew) newCalls.push(item);
    else followUps.push(item);
  }

  let selected = mode === "morning" ? [...newCalls] : mode === "evening" ? [...followUps] : [...newCalls, ...followUps];
  return { newCalls, followUps, followedCountToday, totalStudents, tabsCount: tabsData.length, selected };
}

async function writeFollowUpUpdatesToSheet(env, taskRef, payload, ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  let { descColLetter, followColLetter, nameColLetter, entryDateColLetter, rowSerialColLetter, weekdayColLetter, statusColLetter } = taskRef;
  let existingDesc = taskRef.description || "";

  const { tabsData } = await fetchAllSheetRows(env, ws);
  const targetTab = tabsData.find((t) => normalizeHeaderTitle(t.tab) === normalizeHeaderTitle(taskRef.tab));
  if (targetTab) {
    const getL = (role) => ((targetTab.colMap?.[role] ?? -1) !== -1 ? columnIndexToLetter(targetTab.colMap[role]) : "");
    descColLetter = getL("description") || descColLetter;
    followColLetter = getL("followCount") || followColLetter;
    nameColLetter = getL("name") || nameColLetter;
    entryDateColLetter = getL("entryDate") || entryDateColLetter;
    rowSerialColLetter = getL("rowSerial") || rowSerialColLetter;
    weekdayColLetter = getL("weekday") || weekdayColLetter;
    statusColLetter = getL("status") || statusColLetter;
    const matchedRow = targetTab.rows.find((r) => r.rowNum === taskRef.rowNum);
    if (matchedRow) existingDesc = matchedRow.fields.description || "";
  }

  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const updatesToApply = [];
  const preset = payload.presetValues || {};

  if (entryDateColLetter && isValidGregorianDateValue(preset.entryDate)) {
    updatesToApply.push({ range: `${taskRef.tab}!${entryDateColLetter}${taskRef.rowNum}`, values: [[toEnglishDigits(String(preset.entryDate)).trim()]] });
  }
  if (rowSerialColLetter && preset.rowSerial) {
    updatesToApply.push({ range: `${taskRef.tab}!${rowSerialColLetter}${taskRef.rowNum}`, values: [[preset.rowSerial]] });
  }
  if (weekdayColLetter && preset.weekday) {
    updatesToApply.push({ range: `${taskRef.tab}!${weekdayColLetter}${taskRef.rowNum}`, values: [[preset.weekday]] });
  }
  if (statusColLetter && preset.status) {
    updatesToApply.push({ range: `${taskRef.tab}!${statusColLetter}${taskRef.rowNum}`, values: [[canonicalizeOutcomeLabel(preset.status) || preset.status]] });
  }
  if (descColLetter) {
    const combinedDesc = existingDesc ? `${existingDesc} ${payload.logNote}` : payload.logNote;
    updatesToApply.push({ range: `${taskRef.tab}!${descColLetter}${taskRef.rowNum}`, values: [[combinedDesc]] });
  }
  if (followColLetter && typeof payload.nextFollowCount === "number") {
    updatesToApply.push({ range: `${taskRef.tab}!${followColLetter}${taskRef.rowNum}`, values: [[`${payload.nextFollowCount} بار`]] });
  }
  if (nameColLetter && payload.studentName) {
    updatesToApply.push({ range: `${taskRef.tab}!${nameColLetter}${taskRef.rowNum}`, values: [[payload.studentName]] });
  }

  if (updatesToApply.length === 0) throw new Error("ستون‌های مناسب در این تب پیدا نشدند.");

  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: updatesToApply })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "عدم دسترسی نوشتن در گوگل‌شیت");
}

async function fillSalesExcelAndCopyOffForStudent(env, student, receiptData = {}, captionHint = "", ws = null) {
  return { updatedCount: 0, details: [] };
}

async function sendInteractiveTaskItems(env, chatId, mode = "all", ws = null) {
  const { newCalls, followUps, followedCountToday, selected } = await collectTodayTasks(env, mode, ws);
  const today = getTehranDateDisplay();
  const headerInfo = `📋 *تسک‌های باقی‌مانده (${today})*\n📞 اول: *${newCalls.length}* • 🔥 پیگیری: *${followUps.length}* • ✅ انجام‌شده: *${followedCountToday}*`;

  if (selected.length === 0) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, `${headerInfo}\n\n🎉 تمام تسک‌های امروز انجام شده‌اند.`, getMainGlassPanel());
    return;
  }

  const lines = selected.slice(0, 15).map((t, idx) =>
    `${idx + 1}. 👤 *${escapeTelegramMarkdown(t.name || "بدون نام")}* (\`${escapeTelegramMarkdown(t.phone)}\`) — \`${escapeTelegramMarkdown(t.tab)}\``
  );
  await sendLongTelegramMessages(env.BOT_TOKEN, chatId, `${headerInfo}\n\n${lines.join("\n")}`, getMainGlassPanel());
}

async function buildBeautifulDailyWorkReport(env) {
  const dateLabel = getTehranDateDisplay();
  const dateKey = getTodayTehranKey();
  const raw = env.DB ? await dbGet(env, `daily_work_log:${dateKey}`) : null;
  const logs = raw ? JSON.parse(raw) : [];
  if (logs.length === 0) return `✨ *گزارش روزانه (${dateLabel})*\n\nهنوز تماسی ثبت نشده است.`;
  const rows = logs.map((l, i) => `${i + 1}. *${escapeTelegramMarkdown(l.name)}* — ${l.newStatus} (\`${l.timeDisplay}\`)`);
  return `✨ *گزارش روزانه (${dateLabel})*\n✅ کل تماس‌ها: *${logs.length}*\n\n${rows.join("\n")}`;
}

async function buildDailyStudentChangesReport(env, autoUpdateBaseline = false, chatId = null, jobId = null, ws = null) {
  const { currentMap, totalStudents } = await fetchAllSheetRows(env, ws);
  if (!env.DB) return { hasBaseline: false, text: "⚠️ دیتابیس D1 متصل نیست." };
  const snapKey = ws?.userId ? `STUDENT_SNAPSHOT_V2:${ws.userId}` : "STUDENT_SNAPSHOT_V2";
  const rawPrev = await dbGet(env, snapKey);
  if (!rawPrev || autoUpdateBaseline) {
    await dbPut(env, snapKey, JSON.stringify(currentMap));
  }
  return { hasBaseline: true, text: `📈 تعداد کل ردیف‌های بررسی‌شده در شیت: *${totalStudents}* نفر.` };
}

async function handleTelegramUpdate(update, env, originUrl = "") {
  const activeChatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id || env.ADMIN_CHAT_ID;
  try {
    const ws = await handleAuthenticationGate(update, env);
    if (!ws) return;

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id || cb.from.id;
      const messageId = cb.message?.message_id;
      const data = cb.data || "";

      if (data === "panel:refresh") {
        await answerCallback(env.BOT_TOKEN, cb.id, "پنل تازه شد ✨");
        await updateTelegramReply(env.BOT_TOKEN, chatId, messageId, buildPanelWelcomeText(env), getMainGlassPanel());
      } else if (data === "panel:tasks" || data === "panel:tasks_new" || data === "panel:tasks_followup") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال بارگذاری...");
        const mode = data === "panel:tasks_new" ? "morning" : data === "panel:tasks_followup" ? "evening" : "all";
        await sendInteractiveTaskItems(env, chatId, mode, ws);
      } else if (data === "panel:daily_report" || data === "panel:followed_up") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال آماده‌سازی...");
        const report = await buildBeautifulDailyWorkReport(env);
        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, report, getMainGlassPanel());
      }
      return;
    }

    const message = update.message;
    if (message) {
      const chatId = message.chat.id;
      const text = (message.text || "").trim();
      if (text === "/start" || text === "/panel" || text === "🎛 پنل شیشه‌ای") {
        if (originUrl) {
          await ensureTelegramWebhookConfigured(env.BOT_TOKEN, originUrl, env.TELEGRAM_WEBHOOK_SECRET || "");
        }
        await sendTelegramMessage(env.BOT_TOKEN, chatId, "✨ منوی سریع فعال شد:", QUICK_SUMMON_KEYBOARD);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, buildPanelWelcomeText(env), getMainGlassPanel());
      } else if (text === "/tasks" || text === "📋 همه تسک‌ها") {
        await sendInteractiveTaskItems(env, chatId, "all", ws);
      } else if (text === "/report" || text === "📊 گزارش روزانه" || text === "✅ پیگیری شده‌ها") {
        const report = await buildBeautifulDailyWorkReport(env);
        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, report, getMainGlassPanel());
      }
    }
  } catch (err) {
    if (activeChatId && env.BOT_TOKEN) {
      await sendTelegramMessage(env.BOT_TOKEN, activeChatId, `⚠️ خطا: ${err.message}`);
    }
  }
}

async function sendTelegramMessage(token, chatId, text, replyMarkup = null) {
  const safeText = text.length > 4000 ? text.slice(0, 3990) + "\n..." : text;
  const payload = { chat_id: chatId, text: safeText, parse_mode: "Markdown" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  let res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  let data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    const plain = { chat_id: chatId, text: safeText };
    if (replyMarkup) plain.reply_markup = replyMarkup;
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plain)
    });
    data = await res.json().catch(() => null);
  }
  return data?.result;
}

async function sendLongTelegramMessages(token, chatId, fullText, lastReplyMarkup = null) {
  const maxLen = 3800;
  if (fullText.length <= maxLen) {
    await sendTelegramMessage(token, chatId, fullText, lastReplyMarkup);
    return;
  }
  let remaining = fullText;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, maxLen);
    remaining = remaining.slice(maxLen);
    await sendTelegramMessage(token, chatId, chunk, remaining.length === 0 ? lastReplyMarkup : null);
  }
}

async function updateTelegramReply(token, chatId, messageId, text, replyMarkup = null) {
  if (!messageId) {
    await sendTelegramMessage(token, chatId, text, replyMarkup);
    return;
  }
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    await sendTelegramMessage(token, chatId, text, replyMarkup);
  }
}

async function answerCallback(token, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

export {
  CALL_OUTCOME_OPTIONS,
  parseConfiguredUsers,
  ensureBotStateTable,
  dbGet,
  dbPut,
  normalizeHeaderTitle,
  normalizePhoneKey,
  toEnglishDigits,
  parseNumericFollowCount,
  canonicalizeOutcomeLabel,
  getTehranTimeDisplay,
  getTehranDateDisplay,
  getTodayTehranKey,
  buildTaskIdentityKeys,
  formatFollowUpNoteEntry,
  shouldRequeueSameDayFromNote,
  resolvePresetFieldsWithAi,
  collectTodayTasks,
  writeFollowUpUpdatesToSheet,
  addTaskToFollowedUpSection,
  appendPersonalDailyWorkLog,
  fillSalesExcelAndCopyOffForStudent,
  handleTelegramUpdate,
  sendInteractiveTaskItems,
  buildBeautifulDailyWorkReport,
  buildDailyStudentChangesReport,
  sendLongTelegramMessages,
  sendTelegramMessage,
  ensureTelegramWebhookConfigured
};
