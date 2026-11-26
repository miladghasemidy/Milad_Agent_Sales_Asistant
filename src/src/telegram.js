// هیچ تبی به صورت پیش‌فرض نادیده گرفته نمی‌شود و تمام تب‌های شیت بررسی می‌شوند
const DEFAULT_IGNORED_TABS = [];

// اندازه هر دسته ارسالی به مدل‌های متنی برای جلوگیری از عبور از سقف توکن در دقیقه (TPM)
const AI_CHUNK_SIZE = 15;

// اندازه دسته برای تشخیص هوشمند وضعیت ردیف‌ها در تسک‌ها
const AI_TASK_FILTER_CHUNK_SIZE = 30;

// حداکثر تعداد تسک در هر پیام واحد برای جلوگیری از خطای سقف کاراکتر یا دکمه‌های تلگرام
const TASKS_PER_SINGLE_MESSAGE = 6;

// ۶ حالت دقیق ثبت نتیجه تماس پس از برقراری تماس برای هر تسک
const CALL_OUTCOME_OPTIONS = [
  { key: "won_sale", label: "موفق - فروش بسته" },
  { key: "future_call", label: "پیگیری - تماس آینده" },
  { key: "no_answer", label: "پیگیری - جواب نداد" },
  { key: "switched_off", label: "پیگیری - خاموش بود" },
  { key: "wrong_num", label: "ناموفق - اشتباه بود" },
  { key: "def_no", label: "ناموفق - قطعی نمی‌خواهد" }
];

// نام‌های رایج پیام‌رسان‌ها برای تشخیص خودکار ستون یا تیک‌های داخل سلول
const MESSENGER_PATTERNS = [
  { name: "تلگرام", keywords: ["تلگرام", "telegram"] },
  { name: "واتساپ", keywords: ["واتساپ", "واتس‌آپ", "whatsapp", "wa"] },
  { name: "ایتا", keywords: ["ایتا", "eitaa"] },
  { name: "روبیکا", keywords: ["روبیکا", "rubika"] },
  { name: "بله", keywords: ["بله", "bale"] },
  { name: "سروش", keywords: ["سروش", "soroush"] },
  { name: "اینستاگرام", keywords: ["اینستاگرام", "دایرکت", "instagram", "ig"] }
];

// الگوهای تشخیص نقش هر ستون صرفاً بر اساس تایتل (Header) همان ستون در شیت (مرتب‌شده از دقیق به عمومی)
const HEADER_ROLE_RULES = [
  {
    role: "phone",
    keywords: ["شماره تلفن", "شماره تماس", "شماره همراه", "موبایل", "تلفن", "phone", "mobile", "tel"]
  },
  {
    role: "entryDate",
    keywords: ["تاریخ ورود", "تاریخ ثبت", "تاریخ تماس", "تاریخ پیگیری", "تاریخ", "date"]
  },
  {
    role: "weekday",
    keywords: ["روز هفته", "روز", "weekday", "day"]
  },
  {
    role: "name",
    keywords: ["نام دانشجو", "نام و نام خانوادگی", "نام مشتری", "نام کامل", "دانشجو", "مشتری", "نام", "اسم", "name"]
  },
  {
    role: "status",
    keywords: ["وضعیت تماس", "نتیجه تماس", "وضعیت پیگیری", "وضعیت", "نتیجه", "حالت", "مرحله", "status", "result"]
  },
  {
    role: "followCount",
    keywords: ["تعداد پیگیری", "دفعات پیگیری", "شماره پیگیری", "پیگیری‌ها", "تعداد تماس", "دفعات", "پیگیری", "follow"]
  },
  {
    role: "gonCombined",
    keywords: ["هدف، مانع، نیاز", "هدف مانع نیاز", "هدف و مانع", "دغدغه"]
  },
  {
    role: "goal",
    keywords: ["هدف", "goal"]
  },
  {
    role: "obstacle",
    keywords: ["مانع", "موانع"]
  },
  {
    role: "need",
    keywords: ["نیاز"]
  },
  {
    role: "objection",
    keywords: ["آبجکشن", "ابجکشن", "اعتراض", "بهانه", "مقاومت", "objection"]
  },
  {
    role: "description",
    keywords: ["توضیحات", "توضیح", "یادداشت", "شرح", "کامنت", "نکته", "پانوشت", "description", "note", "comment"]
  },
  {
    role: "messengersCol",
    keywords: ["پیام‌رسان", "پیام رسان", "شبکه اجتماعی", "messenger"]
  },
  {
    role: "rowSerial",
    keywords: ["شماره ردیف", "شماره لیست", "ردیف", "شماره", "کد", "no", "index"]
  }
];

const CHECKMARK_REGEX = /[✅✔✓☑☒]|^(yes|true|ok|بله|دارد|فعال|تیک|x)$/i;

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

// --- [لایه احراز هویت و مدیریت فضای کاری چندکاربره (Multi-User & Auth Gate)] ---

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

  // بدون fallback ناامن به admin / 1234
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
    sheetId:
      workspacePatch.sheetId !== undefined
        ? workspacePatch.sheetId
        : existing.sheetId || env.GOOGLE_SHEET_ID || "",
    receiptChannelId:
      workspacePatch.receiptChannelId !== undefined
        ? workspacePatch.receiptChannelId
        : existing.receiptChannelId || env.RECEIPT_CHANNEL_ID || "",
    adminChatId:
      workspacePatch.adminChatId !== undefined
        ? workspacePatch.adminChatId
        : existing.adminChatId || env.ADMIN_CHAT_ID || ""
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
      "⚠️ *حساب کاربری در متغیرهای محیطی Worker تنظیم نشده است.*\n" +
        "لطفاً `AUTH_USERS_JSON` یا `AUTH_USER` و `AUTH_PASS` را در تنظیمات Cloudflare قرار دهید."
    );
    return;
  }

  await dbPut(
    env,
    `login_flow:${uid}`,
    JSON.stringify({ step: "awaiting_username", username: "" }),
    { expirationTtl: 900 }
  );

  await sendTelegramMessage(
    env.BOT_TOKEN,
    chatId,
    (promptNote ? `${promptNote}\n\n` : "") +
      `🔐 *ورود به حساب کاربری*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `لطفاً **نام کاربری (Username)** خود را ارسال کنید:`
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
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `🔑 حالا **رمز عبور (Password)** برای کاربری \`${escapeTelegramMarkdown(cleanInput)}\` را وارد کنید:`
    );
    return true;
  }

  if (flow.step === "awaiting_password") {
    const users = parseConfiguredUsers(env);
    if (users.length === 0) {
      await sendTelegramMessage(
        env.BOT_TOKEN,
        chatId,
        "⚠️ هیچ کاربر معتبری در متغیرهای محیطی تنظیم نشده است."
      );
      return true;
    }

    const matchedUser = users.find(
      (u) =>
        String(u.username || "").trim() === String(flow.username || "").trim() &&
        String(u.password || "") === cleanInput
    );

    if (!matchedUser) {
      await dbPut(
        env,
        `login_flow:${uid}`,
        JSON.stringify({ step: "awaiting_username", username: "" }),
        { expirationTtl: 900 }
      );
      await sendTelegramMessage(
        env.BOT_TOKEN,
        chatId,
        `❌ *نام کاربری یا رمز عبور اشتباه است.*\nلطفاً **نام کاربری** را دوباره وارد کنید:`
      );
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

    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `✅ *ورود موفقیت‌آمیز بود!*\n` +
        `👤 *کاربر:* *${escapeTelegramMarkdown(ws.displayName || ws.username)}*\n` +
        (ws.sheetId ? `📊 *شیت متصل:* \`${escapeTelegramMarkdown(ws.sheetId.slice(0, 14))}...\`\n` : "") +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
        `منوی سریع و پنل مدیریت فعال شد:`,
      QUICK_SUMMON_KEYBOARD
    );
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      buildPanelWelcomeText(env, "🔐 احراز هویت: *تایید شد ✅*"),
      getMainGlassPanel()
    );
    return true;
  }

  return false;
}

async function handleAuthenticationGate(update, env) {
  const fromUser = update.message?.from || update.callback_query?.from;
  const chatId =
    update.message?.chat?.id ||
    update.callback_query?.message?.chat?.id ||
    fromUser?.id;

  if (!fromUser?.id || !chatId) {
    return null;
  }

  const uid = String(fromUser.id);
  const existingWs = await getUserWorkspace(env, uid);

  if (existingWs) {
    if (update.message?.text && update.message.text.trim() === "/logout") {
      await clearUserWorkspaceSession(env, uid);
      await sendTelegramMessage(
        env.BOT_TOKEN,
        chatId,
        "🚪 *از حساب کاربری خارج شدید.* برای ورود مجدد /start را بزنید."
      );
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

  await startLoginFlow(
    env,
    chatId,
    uid,
    "🔒 *دسترسی نیازمند ورود به حساب کاربری است.*"
  );
  return null;
}

function getEffectiveSheetId(env, ws = null) {
  return (ws && ws.sheetId) || env.GOOGLE_SHEET_ID;
}

function getEffectiveReceiptChannelId(env, ws = null) {
  return (ws && ws.receiptChannelId) || env.RECEIPT_CHANNEL_ID;
}

function columnIndexToLetter(index) {
  let num = index + 1;
  let letters = "";
  while (num > 0) {
    const rem = (num - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    num = Math.floor((num - 1) / 26);
  }
  return letters;
}

function normalizeHeaderTitle(title) {
  return String(title || "")
    .trim()
    .replace(/\u200c/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeStatusComparable(str) {
  return normalizeHeaderTitle(str)
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*–\s*/g, "-")
    .trim();
}

function escapeTelegramMarkdown(text) {
  return String(text || "").replace(/([_*`\[])/g, "\\$1");
}

function hasStrikethroughName(nameText = "", isStruckInSheet = false) {
  if (isStruckInSheet) return true;
  const s = String(nameText || "").trim();
  if (!s) return false;
  if (/^~.+~$/.test(s)) return true;
  if (/[\u0336\u0335\u2015\u2014]/.test(s)) return true;
  return false;
}

function canonicalizeOutcomeLabel(rawValue) {
  const norm = normalizeStatusComparable(rawValue || "");
  if (!norm) return "";

  const exactOption = CALL_OUTCOME_OPTIONS.find(
    (opt) => normalizeStatusComparable(opt.label) === norm
  );
  if (exactOption) return exactOption.label;

  if (norm.includes("فروش بسته") || norm.includes("بسته فروش") || norm.includes("ثبت نام") || norm.includes("موفق")) {
    return "موفق - فروش بسته";
  }
  if (norm.includes("تماس آینده") || norm.includes("آینده")) {
    return "پیگیری - تماس آینده";
  }
  if (norm.includes("خاموش")) {
    return "پیگیری - خاموش بود";
  }
  if (norm.includes("جواب نداد") || norm.includes("پاسخ نداد") || norm.includes("رد تماس")) {
    return "پیگیری - جواب نداد";
  }
  if (norm.includes("اشتباه")) {
    return "ناموفق - اشتباه بود";
  }
  if (norm.includes("قطعی نمی‌خواهد") || norm.includes("قطعی نمیخواهد") || norm.includes("نمی‌خواهد") || norm.includes("نمیخواهد") || norm.includes("انصراف")) {
    return "ناموفق - قطعی نمی‌خواهد";
  }

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
  return /(ساعت\s*\d|چند ساعت بعد|ساعت بعد|امروز تماس|همین امروز|امشب|عصر|بعدازظهر|بعد از ظهر|دوباره تماس|تماس مجدد|زنگ بزنم|پیگیری امروز)/i.test(
    clean
  );
}

async function classifyExcludedRowsWithAi(env, candidates = []) {
  const excludedSet = new Set();
  if (!candidates.length) return excludedSet;

  const deadKeys = new Set();

  for (let i = 0; i < candidates.length; i += AI_TASK_FILTER_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + AI_TASK_FILTER_CHUNK_SIZE);
    const payload = chunk.map((c) => ({
      id: c.id,
      status: c.status || "",
      description: c.description || ""
    }));

    const systemPrompt =
      "تو یک سیستم تشخیص وضعیت تماس‌های فروش آموزشی هستی. فقط ردیف‌هایی را در excluded_ids قرار بده که به صورت کاملاً قطعی کارشان تمام شده یا ناموفق قطعی هستند:\n" +
      "- فروش بسته شده یا ثبت‌نام قطعی انجام شده\n" +
      "- به صورت قطعی نمی‌خواهد یا انصراف قطعی داده\n" +
      "- شماره اشتباه بوده یا به شخص دیگری تعلق داشته\n" +
      "اگر تماس اول است یا خاموش بوده یا جواب نداده یا در آینده پیگیری می‌شود یا جای تردید دارد، در excluded_ids قرار نده.\n" +
      'خروجی را دقیقاً به صورت JSON برگردان: {"excluded_ids": ["..."]}';

    try {
      const res = await callAiTextWithFallback(
        env,
        systemPrompt,
        JSON.stringify(payload),
        null,
        deadKeys
      );
      const parsed = JSON.parse(extractJsonBlock(res.text));
      if (Array.isArray(parsed.excluded_ids)) {
        for (const id of parsed.excluded_ids) {
          excludedSet.add(String(id));
        }
      }
    } catch {
      for (const c of chunk) {
        if (fallbackShouldExcludeRow({ status: c.status, description: c.description })) {
          excludedSet.add(c.id);
        }
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

function normalizePhoneKey(phone) {
  const raw = toEnglishDigits(String(phone || "")).trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("00") && digits.length > 8) {
    const stripped = digits.slice(2);
    if (stripped.startsWith("98") && stripped.length === 12) {
      return "0" + stripped.slice(2);
    }
    return stripped;
  }

  if (digits.startsWith("98") && digits.length === 12) {
    return "0" + digits.slice(2);
  }

  if (digits.length === 10 && digits.startsWith("9")) {
    return "0" + digits;
  }

  return digits;
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

function isCheckedMark(val) {
  const s = String(val || "").trim();
  if (!s) return false;
  return (
    CHECKMARK_REGEX.test(s) ||
    s.includes("✅") ||
    s.includes("✔") ||
    s.includes("✓") ||
    s.includes("☑")
  );
}

function resolveDynamicColumnMap(headers = []) {
  const colMap = {
    entryDate: -1,
    rowSerial: -1,
    weekday: -1,
    phone: -1,
    name: -1,
    status: -1,
    followCount: -1,
    goal: -1,
    obstacle: -1,
    need: -1,
    gonCombined: -1,
    objection: -1,
    description: -1,
    messengersCol: -1,
    messengerDedicatedCols: []
  };

  const normalizedHeaders = headers.map((h) => normalizeHeaderTitle(h));

  for (let idx = 0; idx < normalizedHeaders.length; idx++) {
    const h = normalizedHeaders[idx];
    if (!h) continue;
    for (const m of MESSENGER_PATTERNS) {
      if (m.keywords.some((kw) => h.includes(normalizeHeaderTitle(kw)))) {
        colMap.messengerDedicatedCols.push({ index: idx, name: m.name });
      }
    }
  }

  for (const rule of HEADER_ROLE_RULES) {
    let bestIdx = -1;
    let bestScore = 0;

    for (let idx = 0; idx < normalizedHeaders.length; idx++) {
      const h = normalizedHeaders[idx];
      if (!h) continue;

      const alreadyAssigned = Object.entries(colMap).some(
        ([k, v]) => typeof v === "number" && v === idx && k !== rule.role
      );
      if (alreadyAssigned) continue;

      for (const kw of rule.keywords) {
        const normKw = normalizeHeaderTitle(kw);
        if (h === normKw) {
          const score = 100 + normKw.length;
          if (score > bestScore) {
            bestScore = score;
            bestIdx = idx;
          }
        } else if (h.includes(normKw)) {
          const score = normKw.length * 2;
          if (score > bestScore) {
            bestScore = score;
            bestIdx = idx;
          }
        }
      }
    }

    if (bestIdx !== -1) {
      colMap[rule.role] = bestIdx;
    }
  }

  return colMap;
}

function detectHeaderRowIndex(rows) {
  let bestRowIdx = 0;
  let bestMatches = -1;

  const limit = Math.min(rows.length, 10);
  for (let rIdx = 0; rIdx < limit; rIdx++) {
    const row = rows[rIdx] || [];
    const map = resolveDynamicColumnMap(row);
    let matches = 0;
    if (map.entryDate !== -1) matches += 1;
    if (map.rowSerial !== -1) matches += 1;
    if (map.weekday !== -1) matches += 1;
    if (map.phone !== -1) matches += 2;
    if (map.name !== -1) matches += 2;
    if (map.status !== -1) matches += 1;
    if (map.followCount !== -1) matches += 1;
    if (map.gonCombined !== -1 || map.goal !== -1 || map.obstacle !== -1 || map.need !== -1) matches += 1;
    if (map.objection !== -1) matches += 1;
    if (map.description !== -1) matches += 1;
    matches += map.messengerDedicatedCols.length;

    if (matches > bestMatches) {
      bestMatches = matches;
      bestRowIdx = rIdx;
    }
  }

  return bestRowIdx;
}

function extractActiveMessengersByHeaders(rawRow, colMap) {
  const found = new Set();

  for (const mCol of colMap.messengerDedicatedCols) {
    const val = String(rawRow[mCol.index] || "").trim();
    const lowerVal = normalizeHeaderTitle(val);
    if (!val) continue;
    if (
      isCheckedMark(val) ||
      (!lowerVal.includes("ندارد") &&
        !lowerVal.includes("خیر") &&
        !lowerVal.includes("غیرفعال") &&
        lowerVal !== "0" &&
        lowerVal !== "-")
    ) {
      found.add(mCol.name);
    }
  }

  if (colMap.messengersCol !== -1) {
    const cellVal = normalizeHeaderTitle(rawRow[colMap.messengersCol] || "");
    if (cellVal) {
      for (const m of MESSENGER_PATTERNS) {
        if (m.keywords.some((kw) => cellVal.includes(normalizeHeaderTitle(kw)))) {
          if (!cellVal.includes("ندارد") && !cellVal.includes("غیرفعال")) {
            found.add(m.name);
          }
        }
      }
    }
  }

  return Array.from(found);
}

function extractGoalObstacleNeedFromFields(fields) {
  let goal = String(fields.goal || "").trim();
  let obstacle = String(fields.obstacle || "").trim();
  let need = String(fields.need || "").trim();

  const combined = String(fields.gonCombined || "").trim();
  const desc = String(fields.description || "").trim();
  const obj = String(fields.objection || "").trim();
  const sourcePool = [combined, desc, obj].filter(Boolean).join(" | ");

  if (!goal) {
    if (combined && /(هدف|مهاجرت|شغل|کار|فریلنس|درآمد|اپلای|کنکور|دانشگاه|زبان|مکالمه|آیلتس|تافل|پیشرفت|قبولی|تحصیل|برنامه‌نویسی|هوش)/i.test(combined)) {
      goal = combined;
    } else if (sourcePool) {
      const goalMatch = sourcePool.match(
        /([^|.\n]*(?:هدف|می‌خواد|میخواد|قصد|یادگیری|مهاجرت|فریلنس|درآمد|شغل|اپلای|کنکور|مکالمه|آیلتس|تافل|تخفیف|بلک فرایدی|آفر|برنامه‌نویسی|هوش)[^|.\n]*)/i
      );
      if (goalMatch) goal = goalMatch[1].trim();
    }
  }

  if (!obstacle) {
    if (combined && /(مانع|وقت|زمان|گرون|گران|قسط|بودجه|پول|درگیر|محدودیت|نمی‌رسه|نمیرسه|سخت|مشکل)/i.test(combined)) {
      obstacle = combined;
    } else if (sourcePool) {
      const obstacleMatch = sourcePool.match(
        /([^|.\n]*(?:مانع|وقت|زمان|گرون|گران|قسط|بودجه|پول|درگیر|محدودیت|نمی‌رسه|نمیرسه|سرکار|دانشجو|سخت|شرایط مالی|مشکل)[^|.\n]*)/i
      );
      if (obstacleMatch) obstacle = obstacleMatch[1].trim();
    }
  }

  if (!need) {
    if (combined && /(نیاز|لازم|نیازمند|کمک|راهنمایی|مشاوره|شروع|تقویت|تعیین سطح|برنامه)/i.test(combined)) {
      need = combined;
    } else if (sourcePool) {
      const needMatch = sourcePool.match(
        /([^|.\n]*(?:نیاز|لازم|نیازمند|کمک|راهنمایی|مشاوره|شروع|تقویت|تعیین سطح|برنامه)[^|.\n]*)/i
      );
      if (needMatch) need = needMatch[1].trim();
    }
  }

  if (!goal && !obstacle && !need && combined) {
    goal = combined;
  }

  const shortText = (s) => (s.length > 95 ? `${s.slice(0, 95)}...` : s);

  return {
    goal: goal ? shortText(goal) : "",
    obstacle: obstacle ? shortText(obstacle) : "",
    need: need ? shortText(need) : "",
    summaryText: [
      goal ? `🎯 *هدف:* ${shortText(goal)}` : "",
      obstacle ? `🚧 *مانع:* ${shortText(obstacle)}` : "",
      need ? `🧩 *نیاز:* ${shortText(need)}` : ""
    ]
      .filter(Boolean)
      .join("  |  ")
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

  if (month && day && year) {
    return `${month}/${day}/${year}`;
  }
  return new Date().toLocaleDateString("en-US", { timeZone: "Asia/Tehran" });
}

function getTehranWeekdayName() {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: "Asia/Tehran",
    weekday: "long"
  }).format(new Date());
}

function getTehranDateDisplay() {
  const gregDate = getGregorianSheetDate();
  const weekday = getTehranWeekdayName();
  return weekday ? `${gregDate} (${weekday})` : gregDate;
}

function getTehranTimeDisplay() {
  return new Date().toLocaleTimeString("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit"
  });
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
  ]
    .filter(Boolean)
    .join("\r\n");
}

function transliteratePersianForPdf(str) {
  const map = {
    "آ": "A", "ا": "a", "ب": "b", "پ": "p", "ت": "t", "ث": "s", "ج": "j",
    "چ": "ch", "ح": "h", "خ": "kh", "د": "d", "ذ": "z", "ر": "r", "ز": "z",
    "ژ": "zh", "س": "s", "ش": "sh", "ص": "s", "ض": "z", "ط": "t", "ظ": "z",
    "ع": "a", "غ": "gh", "ف": "f", "ق": "gh", "ک": "k", "ك": "k", "گ": "g",
    "ل": "l", "م": "m", "ن": "n", "و": "v", "ه": "h", "ی": "y", "ي": "y",
    "ئ": "y", "ء": "", "ؤ": "o", "ة": "h", "‌": " ", "ـ": "",
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
    "،": ",", "؛": ";", "؟": "?", "«": "\"", "»": "\""
  };
  return String(str || "")
    .split("")
    .map((ch) => (Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch))
    .join("");
}

function escapePdfText(str) {
  return transliteratePersianForPdf(str)
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function buildCallAnalysisPdfBytes(analysisData = {}) {
  const lines = [
    "AI SALES SUPER AGENT - CALL PSYCHOLOGY & STRATEGY REPORT",
    `Date: ${escapePdfText(getTehranDateDisplay())} | Time: ${escapePdfText(getTehranTimeDisplay())}`,
    "============================================================",
    `Contact: ${escapePdfText(analysisData.contactName || "Unknown")} (${escapePdfText(analysisData.phone || "N/A")})`,
    "",
    "[1] PERSONALITY & BEHAVIOR:",
    ...wrapPdfLines(escapePdfText(analysisData.personalityAndBehavior || "-"), 78),
    "",
    "[2] NEEDS & MOTIVATIONS:",
    ...wrapPdfLines(escapePdfText(analysisData.needsAndMotivations || "-"), 78),
    "",
    "[3] MENTOR INFO PROVIDED TO STUDENT:",
    ...wrapPdfLines(escapePdfText(analysisData.mentorInfoProvided || "-"), 78),
    "",
    "[4] OBJECTIONS & NEXT ACTION:",
    ...wrapPdfLines(escapePdfText(analysisData.objectionsAndNextStep || "-"), 78)
  ];

  const streamContentParts = ["BT", "/F1 10 Tf", "45 750 Td", "14 TL"];
  for (const line of lines) {
    streamContentParts.push(`(${line.replace(/([\\()])/g, "\\$1")}) Tj`);
    streamContentParts.push("T*");
  }
  streamContentParts.push("ET");
  const streamBody = streamContentParts.join("\n");

  const obj1 = "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n";
  const obj2 = "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n";
  const obj3 =
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n";
  const obj4 = `4 0 obj << /Length ${streamBody.length} >> stream\n${streamBody}\nendstream endobj\n`;
  const obj5 = "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n";

  const header = "%PDF-1.4\n";
  const body = obj1 + obj2 + obj3 + obj4 + obj5;
  const xrefStart = header.length + body.length;

  const offsets = [
    header.length,
    header.length + obj1.length,
    header.length + obj1.length + obj2.length,
    header.length + obj1.length + obj2.length + obj3.length,
    header.length + obj1.length + obj2.length + obj3.length + obj4.length
  ];

  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(header + body + xref + trailer);
}

function wrapPdfLines(text, maxChars = 78) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (cur.length + w.length + 1 <= maxChars) {
      cur += ` ${w}`;
    } else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : ["-"];
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
  if (!s) return false;
  if (/^13\d\d\/|^14\d\d\//.test(s)) return false;
  return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s);
}

function fallbackPresetMatch(presetOptions = [], preferredValues = [], fieldKey = "") {
  const list = Array.isArray(presetOptions) ? presetOptions : [];

  if (fieldKey === "status") {
    const canonicalPrefs = preferredValues
      .map((v) => canonicalizeOutcomeLabel(v))
      .filter(Boolean);

    for (const pref of canonicalPrefs) {
      const exactInList = list.find(
        (opt) => normalizeStatusComparable(opt) === normalizeStatusComparable(pref)
      );
      if (exactInList) return exactInList;
    }

    for (const pref of canonicalPrefs) {
      const partialInList = list.find(
        (opt) =>
          normalizeStatusComparable(canonicalizeOutcomeLabel(opt)) ===
          normalizeStatusComparable(pref)
      );
      if (partialInList) return partialInList;
    }

    return canonicalPrefs[0] || "";
  }

  if (fieldKey === "entryDate") {
    for (const pref of preferredValues) {
      const clean = toEnglishDigits(String(pref || "")).trim();
      if (!isValidGregorianDateValue(clean)) continue;
      const exactInList = list.find((opt) => toEnglishDigits(String(opt)).trim() === clean);
      if (exactInList) return exactInList;
    }
    const todayGreg = getGregorianSheetDate();
    const todayInList = list.find((opt) => toEnglishDigits(String(opt)).trim() === todayGreg);
    if (todayInList) return todayInList;
    return todayGreg;
  }

  for (const pref of preferredValues) {
    const cleanPref = normalizeStatusComparable(pref || "");
    if (!cleanPref) continue;
    const exact = list.find((opt) => normalizeStatusComparable(opt) === cleanPref);
    if (exact) return exact;
  }

  for (const pref of preferredValues) {
    const cleanPref = normalizeStatusComparable(pref || "");
    if (!cleanPref) continue;
    const partial = list.find(
      (opt) =>
        normalizeStatusComparable(opt).includes(cleanPref) ||
        cleanPref.includes(normalizeStatusComparable(opt))
    );
    if (partial) return partial;
  }

  return "";
}

async function resolvePresetFieldsWithAi(env, params) {
  const {
    outcomeLabel,
    extraDescription,
    currentFields = {},
    rowNum,
    presets = {}
  } = params;

  const canonicalOutcome = canonicalizeOutcomeLabel(outcomeLabel);
  const todayGreg = getGregorianSheetDate();

  const fallbackResult = {
    entryDate: fallbackPresetMatch(
      presets.entryDate,
      [currentFields.entryDate, todayGreg],
      "entryDate"
    ),
    rowSerial: fallbackPresetMatch(
      presets.rowSerial,
      [currentFields.rowSerial, String(rowNum || "")],
      "rowSerial"
    ),
    weekday: fallbackPresetMatch(
      presets.weekday,
      [currentFields.weekday, getTehranWeekdayName()],
      "weekday"
    ),
    status: fallbackPresetMatch(
      presets.status,
      [canonicalOutcome, currentFields.status],
      "status"
    )
  };

  const hasAnyPreset =
    (presets.entryDate && presets.entryDate.length > 0) ||
    (presets.rowSerial && presets.rowSerial.length > 0) ||
    (presets.weekday && presets.weekday.length > 0) ||
    (presets.status && presets.status.length > 0);

  if (!hasAnyPreset) {
    return fallbackResult;
  }

  const systemPrompt =
    "تو یک دستیار هوشمند تکمیل فیلدهای گوگل‌شیت بر اساس انتخاب کاربر در تلگرام و گزینه‌های پیش‌فرض موجود در خود شیت هستی.\n" +
    "قوانین قطعی:\n" +
    "1. وضعیت (status) حتماً باید یکی از گزینه‌های معتبر باشد و ترجیحاً دقیقاً منطبق با گزینه‌های موجود در status شیت یا لیست زیر باشد:\n" +
    "   [موفق - فروش بسته, پیگیری - تماس آینده, پیگیری - جواب نداد, پیگیری - خاموش بود, ناموفق - اشتباه بود, ناموفق - قطعی نمی‌خواهد]\n" +
    "2. تاریخ ورود (entryDate) حتماً باید میلادی به فرمت M/D/YYYY مثل 11/26/2026 باشد (هرگز تاریخ شمسی مثل 1405 یا ۱۴۰۵ ننویس).\n" +
    "3. اگر در لیست گزینه‌های پیش‌فرض هر ستون مقدار مناسبی وجود دارد، دقیقاً یکی از همان گزینه‌های پیش‌فرض را انتخاب کن.\n" +
    "خروجی را دقیقاً به صورت JSON برگردان:\n" +
    '{"entryDate": "...", "rowSerial": "...", "weekday": "...", "status": "..."}';

  const contextPayload = {
    telegram_selection: {
      outcome_label: canonicalOutcome,
      note_text: extraDescription || "",
      today_gregorian_date: todayGreg,
      today_weekday: getTehranWeekdayName(),
      sheet_row_number: String(rowNum || "")
    },
    allowed_status_options: CALL_OUTCOME_OPTIONS.map((o) => o.label),
    current_row_values: {
      entryDate: currentFields.entryDate || "",
      rowSerial: currentFields.rowSerial || "",
      weekday: currentFields.weekday || "",
      status: currentFields.status || ""
    },
    preset_options_from_sheet: presets
  };

  try {
    const aiRes = await callAiTextWithFallback(
      env,
      systemPrompt,
      JSON.stringify(contextPayload),
      null,
      new Set()
    );
    const parsed = JSON.parse(extractJsonBlock(aiRes.text));

    const pickStatus = () => {
      const aiCanonical = canonicalizeOutcomeLabel(parsed.status || "");
      if (aiCanonical && Array.isArray(presets.status) && presets.status.length > 0) {
        const matchedPreset = presets.status.find(
          (opt) =>
            normalizeStatusComparable(opt) === normalizeStatusComparable(aiCanonical) ||
            normalizeStatusComparable(canonicalizeOutcomeLabel(opt)) ===
              normalizeStatusComparable(aiCanonical)
        );
        if (matchedPreset) return matchedPreset;
      }
      return aiCanonical || fallbackResult.status;
    };

    const pickEntryDate = () => {
      const cleanCand = toEnglishDigits(String(parsed.entryDate || "")).trim();
      if (isValidGregorianDateValue(cleanCand)) {
        if (Array.isArray(presets.entryDate) && presets.entryDate.length > 0) {
          const matched = presets.entryDate.find(
            (opt) => toEnglishDigits(String(opt)).trim() === cleanCand
          );
          if (matched) return matched;
        }
        return cleanCand;
      }
      return fallbackResult.entryDate || todayGreg;
    };

    const pickFromListOrFallback = (candVal, optionsList, fallbackVal) => {
      const cleanCand = String(candVal || "").trim();
      if (!cleanCand) return fallbackVal || "";
      if (!Array.isArray(optionsList) || optionsList.length === 0) return cleanCand;
      const matched = optionsList.find(
        (opt) => normalizeStatusComparable(opt) === normalizeStatusComparable(cleanCand)
      );
      return matched || fallbackVal || "";
    };

    return {
      entryDate: pickEntryDate(),
      rowSerial: pickFromListOrFallback(parsed.rowSerial, presets.rowSerial, fallbackResult.rowSerial),
      weekday: pickFromListOrFallback(parsed.weekday, presets.weekday, fallbackResult.weekday),
      status: pickStatus()
    };
  } catch {
    return fallbackResult;
  }
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
      [
        { text: "✨ تازه‌سازی پنل", callback_data: "panel:refresh" }
      ]
    ]
  };
}

function buildPanelWelcomeText(env, webhookStatusLine = "") {
  const geminiKeysCount = getGeminiApiKeys(env).length;
  const groqKeysCount = getGroqApiKeys(env).length;
  const activeModels = `${getGeminiModels(env).join(", ")} ➔ Groq (${getGroqTextModels(env)[0]})`;
  const tehranTime = new Date().toLocaleTimeString("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  return (
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
    `   🎛 *پـنـل هـوشـمـنـد فـروش و پـیـگـیـری*\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n` +
    `⚡ *وضعیت:* \`آنلاین (D1 SQL)\`  •  🕒 \`${tehranTime}\`\n` +
    `🔑 *موتورها:* *${geminiKeysCount}* Gemini  •  *${groqKeysCount}* Groq\n` +
    `🧠 *مدل:* \`${activeModels}\`\n` +
    (webhookStatusLine ? `${webhookStatusLine}\n` : "") +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `🌟 *امکانات فعال:*\n` +
    `▸ *جستجوی دانشجو*، *ویرایش کامل ستون‌ها* و *عملیات سریع*\n` +
    `▸ *بارگذاری فیش* برای هر دانشجو + تکمیل *اکسل فروش / کپی آف*\n` +
    `▸ *انتقال به زیر شیت MIP* و حذف خودکار *خط‌خورده‌ها* از تسک\n\n` +
    `👇 *یک گزینه را لمس کنید یا ویس/فیش بفرستید:*`
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getGeminiModels(env) {
  if (env.GEMINI_MODELS) {
    const list = env.GEMINI_MODELS.split(",")
      .map((m) => m.trim())
      .filter((m) => Boolean(m) && m !== "gemini-2.5-flash-lite");
    if (list.length > 0) return list;
  }
  return ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];
}

function getGroqTextModels(env) {
  if (env.GROQ_TEXT_MODEL) {
    const list = env.GROQ_TEXT_MODEL.split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
}

function getGroqAudioModel(env) {
  return (env.GROQ_AUDIO_MODEL || "whisper-large-v3-turbo").trim();
}

async function ensureTelegramWebhookConfigured(botToken, originUrl, secretToken = "") {
  const webhookUrl = `${originUrl}/webhook`;
  const webhookPayload = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"]
  };
  if (secretToken) {
    webhookPayload.secret_token = secretToken;
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(webhookPayload)
  });
  const setWebhookResult = await res.json();

  await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "start", description: "نمایش پنل شیشه‌ای مدیریت" },
        { command: "panel", description: "باز کردن پنل شیشه‌ای" },
        { command: "search", description: "جستجوی دانشجو و ویرایش" },
        { command: "tasks", description: "تسک‌های باقی‌مانده امروز" },
        { command: "followed", description: "مشاهده لیست پیگیری شده‌ها" },
        { command: "report", description: "گزارش روزانه کارهای انجام‌شده" },
        { command: "check", description: "تجزیه و تحلیل متنی شیت" },
        { command: "overview", description: "بررسی اجمالی کامل تسک‌ها" },
        { command: "changes", description: "گزارش تغییرات دانشجوها" },
        { command: "logout", description: "خروج از حساب کاربری" },
        { command: "stop", description: "توقف فوری عملیات" }
      ]
    })
  });

  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  const webhookInfo = await infoRes.json();
  return { setWebhookResult, webhookInfo };
}


async function startTrackableJob(env, chatId) {
  if (!env.DB) return null;
  try {
    const jobId = String(Date.now());
    const stopFlag = await dbGet(env, `stop_flag:${chatId}`);
    if (stopFlag === "1") {
      await dbDelete(env, `stop_flag:${chatId}`);
    }
    return jobId;
  } catch {
    return null;
  }
}

async function finishTrackableJob() {
  return;
}

async function throwIfJobStopped(env, chatId, jobId) {
  if (!env.DB || !jobId) return;
  const stopFlag = await dbGet(env, `stop_flag:${chatId}`);
  if (stopFlag === "1") {
    throw new Error("USER_ABORTED");
  }
}

async function executeStopRequest(env, chatId) {
  if (env.DB) {
    await dbDelete(env, `outcome_wizard:${chatId}`);
    await dbDelete(env, `student_state:${chatId}`);
    await dbPut(env, `stop_flag:${chatId}`, "1", { expirationTtl: 300 });
  }
  await sendTelegramMessage(
    env.BOT_TOKEN,
    chatId,
    "🛑 *دستور توقف فوری اعمال شد و عملیات جاری متوقف گردید.*",
    getMainGlassPanel()
  );
}

// --- [مدیریت جستجوی دانشجو، عملیات متنوع، ویرایش ستون‌ها، بارگذاری فیش و انتقال به MIP] ---

async function startStudentSearchPrompt(env, chatId) {
  if (!env.DB) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ اتصال دیتابیس D1 با نام `DB` برقرار نیست.");
    return;
  }
  await dbPut(
    env,
    `student_state:${chatId}`,
    JSON.stringify({ mode: "awaiting_search_query" }),
    { expirationTtl: 1800 }
  );

  await sendTelegramMessage(
    env.BOT_TOKEN,
    chatId,
    `🔍 *جستجوی دانشجو*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `لطفاً **نام دانشجو**، **شماره تلفن** یا **نام تب/ردیف** را بنویسید و ارسال کنید:`,
    {
      inline_keyboard: [[{ text: "❌ انصراف", callback_data: "st_cancel" }]]
    }
  );
}

async function performStudentSearchAndShowResults(env, chatId, queryText, ws = null) {
  const q = normalizeHeaderTitle(toEnglishDigits(queryText || ""));
  const qDigits = normalizePhoneKey(queryText || "");
  const { tabsData } = await fetchAllSheetRows(env, ws);

  const matches = [];
  for (const t of tabsData) {
    for (const r of t.rows) {
      const nameStr = String(r.fields.name || "").trim();
      const phoneStr = String(r.phone || "").trim();
      const normPhone = normalizePhoneKey(phoneStr);
      const tabStr = String(t.tab || "").trim();
      const rowNumStr = String(r.rowNum || "");

      const hitName = q && normalizeHeaderTitle(nameStr).includes(q);
      const hitPhone =
        (qDigits && normPhone.includes(qDigits)) ||
        (q && normalizeHeaderTitle(phoneStr).includes(q));
      const hitTabRow =
        q &&
        (normalizeHeaderTitle(tabStr).includes(q) ||
          (rowNumStr === toEnglishDigits(q).trim() && /^\d+$/.test(rowNumStr)));

      if (hitName || hitPhone || hitTabRow) {
        matches.push({
          tab: t.tab,
          rowNum: r.rowNum,
          name: nameStr,
          phone: phoneStr,
          status: r.fields.status || "",
          followCount: parseNumericFollowCount(r.fields.followCount) || 0,
          description: r.fields.description || "",
          headers: t.headers || [],
          colMap: t.colMap || {},
          fields: r.fields || {}
        });
      }
    }
  }

  if (matches.length === 0) {
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `⚠️ دانشجویی با عبارت «${escapeTelegramMarkdown(queryText)}» پیدا نشد.`,
      {
        inline_keyboard: [
          [{ text: "🔍 جستجوی مجدد", callback_data: "panel:student_search" }],
          [{ text: "🎛 پنل اصلی", callback_data: "panel:refresh" }]
        ]
      }
    );
    return;
  }

  const topMatches = matches.slice(0, 12);
  const searchSessionId = `s_${Date.now().toString(36)}`;
  await dbPut(
    env,
    `student_search:${searchSessionId}`,
    JSON.stringify({ matches: topMatches }),
    { expirationTtl: 3600 }
  );

  let text =
    `🔎 *نتایج جستجو برای «${escapeTelegramMarkdown(queryText)}» (${matches.length} مورد)*\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`;

  const keyboardRows = [];
  topMatches.forEach((m, idx) => {
    text +=
      `${idx + 1}. 👤 *${escapeTelegramMarkdown(m.name || "بدون نام")}*  •  📱 \`${escapeTelegramMarkdown(m.phone || "—")}\`\n` +
      `   📂 \`${escapeTelegramMarkdown(m.tab)}\` (ردیف ${m.rowNum})  •  ⏮ *${escapeTelegramMarkdown(m.status || "ثبت نشده")}*\n\n`;

    keyboardRows.push([
      {
        text: `👤 ${idx + 1}. ${(m.name || m.phone || "دانشجو").slice(0, 22)} (${m.tab.slice(0, 10)})`,
        callback_data: `st_open:${searchSessionId}:${idx}`.slice(0, 64)
      }
    ]);
  });

  keyboardRows.push([
    { text: "🔍 جستجوی جدید", callback_data: "panel:student_search" },
    { text: "🎛 پنل اصلی", callback_data: "panel:refresh" }
  ]);

  await sendTelegramMessage(env.BOT_TOKEN, chatId, text.trim(), { inline_keyboard: keyboardRows });
}

function buildStudentActionsKeyboard(studentKey) {
  const safeKey = String(studentKey).slice(0, 48);
  const rows = [
    [
      { text: "🧾 بارگذاری فیش", callback_data: `st_receipt:${safeKey}`.slice(0, 64) },
      { text: "📤 انتقال به زیر شیت MIP", callback_data: `st_mip:${safeKey}`.slice(0, 64) }
    ],
    [
      { text: "✏️ ویرایش ستون‌های شیت", callback_data: `st_cols:${safeKey}`.slice(0, 64) },
      { text: "📝 افزودن توضیح سریع", callback_data: `st_note:${safeKey}`.slice(0, 64) }
    ],
    [
      { text: "🔁 افزایش پیگیری (+1)", callback_data: `st_inc_f:${safeKey}`.slice(0, 64) },
      { text: "📇 خروجی مخاطب vCard", callback_data: `st_vcard:${safeKey}`.slice(0, 64) }
    ],
    [
      { text: "🎉 فروش بسته", callback_data: `st_qst:${safeKey}:won_sale`.slice(0, 64) },
      { text: "🗓 تماس آینده", callback_data: `st_qst:${safeKey}:future_call`.slice(0, 64) }
    ],
    [
      { text: "📵 جواب نداد", callback_data: `st_qst:${safeKey}:no_answer`.slice(0, 64) },
      { text: "📴 خاموش بود", callback_data: `st_qst:${safeKey}:switched_off`.slice(0, 64) }
    ],
    [
      { text: "🔍 جستجوی دیگر", callback_data: "panel:student_search" },
      { text: "🎛 پنل اصلی", callback_data: "panel:refresh" }
    ]
  ];
  return { inline_keyboard: rows };
}

async function openStudentActionCard(env, chatId, messageId, studentKey) {
  const raw = await dbGet(env, `st_record:${studentKey}`);
  if (!raw) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ اطلاعات این دانشجو منقضی شده است. دوباره جستجو کنید.");
    return;
  }

  const st = JSON.parse(raw);
  const gon = extractGoalObstacleNeedFromFields(st.fields || {});

  const cardText =
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
    `  👤 *پـروفـایـل و عـمـلـیـات دانـشـجـو*\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
    `👤 *نام:* *${escapeTelegramMarkdown(st.name || "بدون نام")}*\n` +
    `📱 *شماره:* \`${escapeTelegramMarkdown(st.phone || "—")}\`\n` +
    `📂 *تب:* \`${escapeTelegramMarkdown(st.tab)}\`  •  *ردیف:* ${st.rowNum}\n` +
    `⏮ *وضعیت:* ${escapeTelegramMarkdown(st.status || "ثبت نشده")}  •  🔁 *پیگیری:* ${st.followCount || 0} بار\n` +
    (gon.goal ? `🎯 *هدف:* ${escapeTelegramMarkdown(gon.goal)}\n` : "") +
    (gon.obstacle ? `🚧 *مانع:* ${escapeTelegramMarkdown(gon.obstacle)}\n` : "") +
    (gon.need ? `🧩 *نیاز:* ${escapeTelegramMarkdown(gon.need)}\n` : "") +
    (st.fields?.objection ? `🛡 *آبجکشن:* ${escapeTelegramMarkdown(st.fields.objection)}\n` : "") +
    (st.fields?.description ? `📝 *توضیحات:* ${escapeTelegramMarkdown(st.fields.description)}\n` : "") +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `👇 *عملیات مورد نظر را انتخاب کنید:*`;

  const keyboard = buildStudentActionsKeyboard(studentKey);
  const edited = await tryEditTelegramMessage(env.BOT_TOKEN, chatId, messageId, cardText, keyboard);
  if (!edited) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, cardText, keyboard);
  }
}

async function showStudentColumnsMenu(env, chatId, messageId, studentKey) {
  const raw = await dbGet(env, `st_record:${studentKey}`);
  if (!raw) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ اطلاعات دانشجو منقضی شده است.");
    return;
  }
  const st = JSON.parse(raw);
  const headers = Array.isArray(st.headers) ? st.headers : [];

  const validCols = [];
  headers.forEach((hTitle, idx) => {
    const cleanTitle = String(hTitle || "").trim();
    if (cleanTitle) {
      validCols.push({ idx, title: cleanTitle, letter: columnIndexToLetter(idx) });
    }
  });

  if (validCols.length === 0) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ ستونی با عنوان در این تب پیدا نشد.");
    return;
  }

  const inlineRows = [];
  for (let i = 0; i < validCols.length; i += 2) {
    const c1 = validCols[i];
    const row = [
      {
        text: `✏️ ${c1.title.slice(0, 18)} (${c1.letter})`,
        callback_data: `st_edit_col:${studentKey}:${c1.idx}`.slice(0, 64)
      }
    ];
    if (validCols[i + 1]) {
      const c2 = validCols[i + 1];
      row.push({
        text: `✏️ ${c2.title.slice(0, 18)} (${c2.letter})`,
        callback_data: `st_edit_col:${studentKey}:${c2.idx}`.slice(0, 64)
      });
    }
    inlineRows.push(row);
  }
  inlineRows.push([{ text: "↩️ بازگشت به کارت دانشجو", callback_data: `st_back:${studentKey}`.slice(0, 64) }]);

  await updateTelegramReply(
    env.BOT_TOKEN,
    chatId,
    messageId,
    `✏️ *ویرایش ستون‌های شیت برای «${escapeTelegramMarkdown(st.name || st.phone)}»*\n` +
      `📂 تب \`${escapeTelegramMarkdown(st.tab)}\` • ردیف ${st.rowNum}\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `ستونی که می‌خواهید مقدارش تغییر کند را انتخاب کنید:`,
    { inline_keyboard: inlineRows }
  );
}

async function writeSingleCellToSheet(env, tabName, colLetter, rowNum, newValue, ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const range = `${tabName}!${colLetter}${rowNum}`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        range,
        values: [[newValue]]
      })
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || "خطا در ویرایش سلول گوگل‌شیت");
  }
}

async function transferStudentToMipSubsheet(env, chatId, studentKey, ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  const raw = await dbGet(env, `st_record:${studentKey}`);
  if (!raw) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ اطلاعات دانشجو در دسترس نیست.");
    return;
  }
  const st = JSON.parse(raw);
  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = await metaRes.json();
  const sheetTitles = (meta.sheets || []).map((s) => s.properties.title);
  const mipTabName =
    sheetTitles.find((t) => normalizeHeaderTitle(t) === "mip") ||
    sheetTitles.find((t) => normalizeHeaderTitle(t).includes("mip")) ||
    "MIP";

  if (!sheetTitles.includes(mipTabName)) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: mipTabName } } }]
      })
    });
  }

  const mipRangeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${mipTabName}!A1:AZ5`)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const mipRangeData = await mipRangeRes.json();
  let mipHeaders = (mipRangeData.values && mipRangeData.values[0]) || [];

  const defaultMipHeaders = [
    "تاریخ انتقال",
    "نام دانشجو",
    "شماره تلفن",
    "وضعیت",
    "تعداد پیگیری",
    "هدف",
    "مانع",
    "نیاز",
    "آبجکشن",
    "توضیحات",
    "تب مبدا"
  ];

  if (mipHeaders.length === 0) {
    mipHeaders = defaultMipHeaders;
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${mipTabName}!A1`)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ range: `${mipTabName}!A1`, values: [mipHeaders] })
      }
    );
  }

  const gon = extractGoalObstacleNeedFromFields(st.fields || {});
  const rowValues = mipHeaders.map((h) => {
    const nh = normalizeHeaderTitle(h);
    if (nh.includes("تاریخ")) return getGregorianSheetDate();
    if (nh.includes("نام") || nh.includes("اسم")) return st.name || "";
    if (nh.includes("تلفن") || nh.includes("موبایل") || nh.includes("شماره تماس") || nh === "شماره") return st.phone || "";
    if (nh.includes("وضعیت")) return st.status || "";
    if (nh.includes("پیگیری")) return `${st.followCount || 0} بار`;
    if (nh.includes("هدف")) return gon.goal || st.fields?.goal || "";
    if (nh.includes("مانع")) return gon.obstacle || st.fields?.obstacle || "";
    if (nh.includes("نیاز")) return gon.need || st.fields?.need || "";
    if (nh.includes("آبجکشن") || nh.includes("ابجکشن")) return st.fields?.objection || "";
    if (nh.includes("توضیح")) return st.fields?.description || "";
    if (nh.includes("تب") || nh.includes("مبدا")) return `${st.tab} (ردیف ${st.rowNum})`;
    return "";
  });

  const appendRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${mipTabName}!A:AZ`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: [rowValues] })
    }
  );
  const appendData = await appendRes.json();
  if (!appendRes.ok) {
    throw new Error(appendData.error?.message || "خطا در انتقال اطلاعات به زیر شیت MIP");
  }

  await sendTelegramMessage(
    env.BOT_TOKEN,
    chatId,
    `📤 *اطلاعات «${escapeTelegramMarkdown(st.name || st.phone)}» با موفقیت به زیر شیت \`${escapeTelegramMarkdown(mipTabName)}\` کپی شد.*`,
    buildStudentActionsKeyboard(studentKey)
  );
}

function getActualCellValueFromRowObj(rowObj, headerTitle, colIdx) {
  const rawRow = rowObj?.rawRow;
  if (Array.isArray(rawRow) && colIdx >= 0 && colIdx < rawRow.length) {
    return String(rawRow[colIdx] ?? "").trim();
  }

  const fields = rowObj?.fields || {};
  const nh = normalizeHeaderTitle(headerTitle);
  if (nh.includes("تلفن") || nh.includes("موبایل") || nh.includes("شماره تماس")) {
    return String(fields.phone || rowObj?.phone || "").trim();
  }
  if (nh.includes("نام") || nh.includes("اسم")) {
    return String(fields.name || "").trim();
  }
  if (nh.includes("وضعیت")) {
    return String(fields.status || "").trim();
  }
  if (nh.includes("پیگیری")) {
    return String(fields.followCount || "").trim();
  }
  if (nh.includes("تاریخ")) {
    return String(fields.entryDate || "").trim();
  }
  if (nh.includes("توضیح")) {
    return String(fields.description || "").trim();
  }
  return "";
}

async function fillSalesExcelAndCopyOffForStudent(env, student, receiptData = {}, captionHint = "", ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  const { tabsData } = await fetchAllSheetRows(env, ws);
  const targetNormName = normalizeHeaderTitle(student.name || "");
  const targetNormPhone = normalizePhoneKey(student.phone || "");

  const matchedTargets = [];

  for (const t of tabsData) {
    const tabNorm = normalizeHeaderTitle(t.tab);
    const isSalesOrCopyTab =
      tabNorm.includes("اکسل فروش") ||
      tabNorm.includes("کپی آف") ||
      tabNorm.includes("کپی اف") ||
      tabNorm.includes("فروش") ||
      tabNorm.includes("copy");

    for (const r of t.rows) {
      const rNameNorm = normalizeHeaderTitle(r.fields.name || "");
      const rPhoneNorm = normalizePhoneKey(r.phone || "");
      const sameStudent =
        (targetNormPhone && rPhoneNorm && targetNormPhone === rPhoneNorm) ||
        (targetNormName && rNameNorm && rNameNorm.includes(targetNormName));

      const hasSalesOrCopyHeader = (t.headers || []).some((h) => {
        const nh = normalizeHeaderTitle(h);
        return (
          nh.includes("اکسل فروش") ||
          nh.includes("کپی آف") ||
          nh.includes("کپی اف") ||
          nh.includes("مبلغ") ||
          nh.includes("فیش") ||
          nh.includes("پیگیری")
        );
      });

      if (sameStudent && (isSalesOrCopyTab || hasSalesOrCopyHeader || t.tab === student.tab)) {
        matchedTargets.push({ tabInfo: t, rowObj: r });
      }
    }
  }

  if (matchedTargets.length === 0) {
    return { updatedCount: 0, details: [] };
  }

  const updates = [];
  const details = [];

  for (const { tabInfo, rowObj } of matchedTargets) {
    const headers = tabInfo.headers || [];
    headers.forEach((hTitle, colIdx) => {
      const nh = normalizeHeaderTitle(hTitle);
      if (!nh) return;
      const colLetter = columnIndexToLetter(colIdx);
      const currentVal = getActualCellValueFromRowObj(rowObj, hTitle, colIdx);

      let suggestedVal = "";
      if (nh.includes("مبلغ") || nh.includes("واریز") || nh.includes("فیش")) {
        suggestedVal = receiptData.amount || "";
      } else if (nh.includes("کد پیگیری") || nh.includes("مرجع") || nh.includes("رسید")) {
        suggestedVal = receiptData.tracking_code || "";
      } else if (nh.includes("تاریخ واریز") || nh.includes("تاریخ تراکنش") || nh.includes("تاریخ")) {
        suggestedVal = receiptData.transaction_date || getGregorianSheetDate();
      } else if (nh.includes("بانک") || nh.includes("درگاه")) {
        suggestedVal = receiptData.bank_or_gateway || "";
      } else if (nh.includes("وضعیت")) {
        suggestedVal = receiptData.status || "موفق - فروش بسته";
      } else if (nh.includes("توضیح") || nh.includes("اکسل فروش") || nh.includes("کپی آف") || nh.includes("کپی اف")) {
        const piece = [
          receiptData.amount ? `مبلغ: ${receiptData.amount}` : "",
          receiptData.tracking_code ? `کد پیگیری: ${receiptData.tracking_code}` : "",
          captionHint || ""
        ]
          .filter(Boolean)
          .join(" | ");
        suggestedVal = piece ? `فیش ثبت شد (${piece})` : "";
      }

      if (suggestedVal && !currentVal) {
        updates.push({
          range: `${tabInfo.tab}!${colLetter}${rowObj.rowNum}`,
          values: [[suggestedVal]]
        });
        details.push(`\`${tabInfo.tab}!${colLetter}${rowObj.rowNum}\` (${hTitle}) ➔ «${suggestedVal}»`);
      }
    });
  }

  if (updates.length > 0) {
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          valueInputOption: "USER_ENTERED",
          data: updates
        })
      }
    );
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error?.message || "خطا در پر کردن ستون‌های اکسل فروش / کپی آف");
    }
  }

  return { updatedCount: updates.length, details };
}

async function handleStudentTextInput(env, chatId, userText, ws = null) {
  const rawState = await dbGet(env, `student_state:${chatId}`);
  if (!rawState) return false;

  const stState = JSON.parse(rawState);

  if (stState.mode === "awaiting_search_query") {
    await dbDelete(env, `student_state:${chatId}`);
    await performStudentSearchAndShowResults(env, chatId, userText, ws);
    return true;
  }

  if (stState.mode === "awaiting_col_value") {
    await dbDelete(env, `student_state:${chatId}`);
    await writeSingleCellToSheet(
      env,
      stState.tab,
      stState.colLetter,
      stState.rowNum,
      userText,
      ws
    );
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `✅ ستون *${escapeTelegramMarkdown(stState.colTitle)}* (\`${stState.colLetter}${stState.rowNum}\`) در تب \`${escapeTelegramMarkdown(stState.tab)}\` با مقدار «${escapeTelegramMarkdown(userText)}» به‌روزرسانی شد.`,
      buildStudentActionsKeyboard(stState.studentKey)
    );
    return true;
  }

  if (stState.mode === "awaiting_quick_note") {
    await dbDelete(env, `student_state:${chatId}`);
    const noteEntry = formatFollowUpNoteEntry("یادداشت سریع", userText);
    const colLetter = stState.descColLetter || "M";
    const nextNote = stState.currentDesc ? `${stState.currentDesc} ${noteEntry}` : noteEntry;
    await writeSingleCellToSheet(env, stState.tab, colLetter, stState.rowNum, nextNote, ws);
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `📝 یادداشت جدید برای *${escapeTelegramMarkdown(stState.studentName || "دانشجو")}* در ستون توضیحات (\`${colLetter}${stState.rowNum}\`) ثبت شد.`,
      buildStudentActionsKeyboard(stState.studentKey)
    );
    return true;
  }

  return false;
}

async function handleTelegramUpdate(update, env, originUrl = "") {
  const activeChatId =
    update.message?.chat?.id ||
    update.callback_query?.message?.chat?.id ||
    update.callback_query?.from?.id ||
    env.ADMIN_CHAT_ID;
  let currentJobId = null;

  try {
    const ws = await handleAuthenticationGate(update, env);
    if (!ws) {
      return;
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      const adminId = String(ws.adminChatId || env.ADMIN_CHAT_ID || "").trim();
      if (adminId && String(cb.from?.id) !== adminId) {
        await answerCallback(env.BOT_TOKEN, cb.id, `دسترسی غیرمجاز (ID: ${cb.from?.id})`);
        return;
      }

      const chatId = cb.message?.chat?.id || cb.from.id;
      const messageId = cb.message?.message_id;
      const data = cb.data || "";

      if (data === "panel:refresh") {
        await answerCallback(env.BOT_TOKEN, cb.id, "پنل تازه شد ✨");
        await updateTelegramReply(
          env.BOT_TOKEN,
          chatId,
          messageId,
          buildPanelWelcomeText(env, "📡 اتصال دکمه‌های شیشه‌ای: *برقرار ✅*"),
          getMainGlassPanel()
        );
      } else if (data === "panel:student_search") {
        await answerCallback(env.BOT_TOKEN, cb.id, "نام یا شماره دانشجو را وارد کنید");
        await startStudentSearchPrompt(env, chatId);
      } else if (data === "st_cancel") {
        await answerCallback(env.BOT_TOKEN, cb.id, "لغو شد");
        if (env.DB) await dbDelete(env, `student_state:${chatId}`);
        await updateTelegramReply(
          env.BOT_TOKEN,
          chatId,
          messageId,
          "❌ عملیات جستجو/ویرایش لغو شد.",
          getMainGlassPanel()
        );
      } else if (data.startsWith("st_open:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "باز کردن پروفایل دانشجو...");
        const parts = data.split(":");
        const searchSessionId = parts[1];
        const idx = parseInt(parts[2], 10);
        const rawSearch = await dbGet(env, `student_search:${searchSessionId}`);
        if (!rawSearch) {
          await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ نتیجه جستجو منقضی شده است.");
          return;
        }
        const searchData = JSON.parse(rawSearch);
        const picked = searchData.matches?.[idx];
        if (!picked) {
          await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ رکورد انتخابی پیدا نشد.");
          return;
        }
        const stKey = `st_${Date.now().toString(36)}_${idx}`;
        await dbPut(env, `st_record:${stKey}`, JSON.stringify(picked), { expirationTtl: 3600 });
        await openStudentActionCard(env, chatId, messageId, stKey);
      } else if (data.startsWith("st_back:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "بازگشت");
        const stKey = data.slice("st_back:".length);
        await openStudentActionCard(env, chatId, messageId, stKey);
      } else if (data.startsWith("st_cols:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "انتخاب ستون");
        const stKey = data.slice("st_cols:".length);
        await showStudentColumnsMenu(env, chatId, messageId, stKey);
      } else if (data.startsWith("st_edit_col:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "مقدار جدید را بفرستید");
        const parts = data.split(":");
        const stKey = parts[1];
        const colIdx = parseInt(parts[2], 10);
        const raw = await dbGet(env, `st_record:${stKey}`);
        if (!raw) return;
        const st = JSON.parse(raw);
        const colTitle = st.headers?.[colIdx] || `ستون ${colIdx + 1}`;
        const colLetter = columnIndexToLetter(colIdx);

        await dbPut(
          env,
          `student_state:${chatId}`,
          JSON.stringify({
            mode: "awaiting_col_value",
            studentKey: stKey,
            tab: st.tab,
            rowNum: st.rowNum,
            colIdx,
            colLetter,
            colTitle
          }),
          { expirationTtl: 1800 }
        );

        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          `✏️ مقدار جدید برای ستون *${escapeTelegramMarkdown(colTitle)}* (\`${colLetter}${st.rowNum}\`) در تب \`${escapeTelegramMarkdown(st.tab)}\` را بنویسید:`,
          { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "st_cancel" }]] }
        );
      } else if (data.startsWith("st_note:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "توضیح جدید را بنویسید");
        const stKey = data.slice("st_note:".length);
        const raw = await dbGet(env, `st_record:${stKey}`);
        if (!raw) return;
        const st = JSON.parse(raw);
        const descIdx = st.colMap?.description ?? -1;
        await dbPut(
          env,
          `student_state:${chatId}`,
          JSON.stringify({
            mode: "awaiting_quick_note",
            studentKey: stKey,
            tab: st.tab,
            rowNum: st.rowNum,
            studentName: st.name || "",
            descColLetter: descIdx !== -1 ? columnIndexToLetter(descIdx) : "M",
            currentDesc: st.fields?.description || ""
          }),
          { expirationTtl: 1800 }
        );
        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          `📝 یادداشت جدید برای *${escapeTelegramMarkdown(st.name || st.phone)}* را بنویسید:`,
          { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "st_cancel" }]] }
        );
      } else if (data.startsWith("st_inc_f:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال افزایش تعداد پیگیری...");
        const stKey = data.slice("st_inc_f:".length);
        const raw = await dbGet(env, `st_record:${stKey}`);
        if (!raw) return;
        const st = JSON.parse(raw);
        const followIdx = st.colMap?.followCount ?? -1;
        if (followIdx === -1) {
          await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ ستون تعداد پیگیری در این تب پیدا نشد.");
          return;
        }
        const nextNum = (st.followCount || 0) + 1;
        const colLetter = columnIndexToLetter(followIdx);
        await writeSingleCellToSheet(env, st.tab, colLetter, st.rowNum, `${nextNum} بار`, ws);
        st.followCount = nextNum;
        await dbPut(env, `st_record:${stKey}`, JSON.stringify(st), { expirationTtl: 3600 });
        await openStudentActionCard(env, chatId, messageId, stKey);
      } else if (data.startsWith("st_vcard:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "ساخت فایل مخاطب...");
        const stKey = data.slice("st_vcard:".length);
        const raw = await dbGet(env, `st_record:${stKey}`);
        if (!raw) return;
        const st = JSON.parse(raw);
        const fullName = formatContactFullName(st.name || "دانشجو");
        const vcf = buildVCardString(st.name || "دانشجو", st.phone || "", st.status || "");
        const safeName = `${fullName.replace(/[^\w\u0600-\u06FF\s-]/g, "").trim() || "contact"}.vcf`;
        await sendTelegramDocumentBytes(
          env.BOT_TOKEN,
          chatId,
          new TextEncoder().encode(vcf),
          safeName,
          "text/vcard",
          `📇 *مخاطب:* \`${escapeTelegramMarkdown(fullName)}\``
        );
      } else if (data.startsWith("st_qst:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال ثبت وضعیت...");
        const parts = data.split(":");
        const stKey = parts[1];
        const outcomeKey = parts[2];
        const raw = await dbGet(env, `st_record:${stKey}`);
        if (!raw) return;
        const st = JSON.parse(raw);
        const chosen = CALL_OUTCOME_OPTIONS.find((o) => o.key === outcomeKey);
        if (!chosen) return;
        const statusIdx = st.colMap?.status ?? -1;
        if (statusIdx !== -1) {
          await writeSingleCellToSheet(env, st.tab, columnIndexToLetter(statusIdx), st.rowNum, chosen.label, ws);
        }
        st.status = chosen.label;
        await dbPut(env, `st_record:${stKey}`, JSON.stringify(st), { expirationTtl: 3600 });
        await openStudentActionCard(env, chatId, messageId, stKey);
      } else if (data.startsWith("st_receipt:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "عکس فیش دانشجو را بفرستید");
        const stKey = data.slice("st_receipt:".length);
        await dbPut(
          env,
          `student_state:${chatId}`,
          JSON.stringify({
            mode: "awaiting_student_receipt",
            studentKey: stKey
          }),
          { expirationTtl: 1800 }
        );
        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          `🧾 *بارگذاری فیش برای دانشجو*\n` +
            `لطفاً **عکس فیش واریزی** را بفرستید تا هم به کانال فیش‌ها ارسال شود و هم بخش **اکسل فروش** و **کپی آف** دانشجو در شیت پر شود:`,
          { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "st_cancel" }]] }
        );
      } else if (data.startsWith("st_mip:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال انتقال به زیر شیت MIP...");
        const stKey = data.slice("st_mip:".length);
        await transferStudentToMipSubsheet(env, chatId, stKey, ws);
      } else if (data === "panel:followed_up") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال بارگذاری پیگیری شده‌ها...");
        const followedText = await buildFollowedUpTasksReport(env);
        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, followedText, {
          inline_keyboard: [
            [
              { text: "📋 همه تسک‌ها", callback_data: "panel:tasks" },
              { text: "🎛 پنل اصلی", callback_data: "panel:refresh" }
            ]
          ]
        });
      } else if (data === "panel:requeue_today") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال بررسی تماس‌های مجدد امروز...");
        const requeueText = await buildSameDayRequeueReport(env);
        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, requeueText, {
          inline_keyboard: [
            [
              { text: "📋 همه تسک‌ها", callback_data: "panel:tasks" },
              { text: "🎛 پنل اصلی", callback_data: "panel:refresh" }
            ]
          ]
        });
      } else if (data === "panel:daily_report") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال آماده‌سازی گزارش روزانه...");
        const dailyText = await buildBeautifulDailyWorkReport(env);
        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, dailyText, {
          inline_keyboard: [[{ text: "🎛 بازگشت به پنل شیشه‌ای", callback_data: "panel:refresh" }]]
        });
      } else if (data === "panel:check_all") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال تحلیل متنی شیت...");
        currentJobId = await startTrackableJob(env, chatId);
        await executeSheetAnalysisWorkflow(env, chatId, currentJobId, "", ws);
        await finishTrackableJob(env, chatId, currentJobId);
      } else if (data === "panel:select_tab") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال دریافت لیست تب‌ها...");
        const allTabs = await fetchAllSheetTabs(env, ws);
        if (allTabs.length === 0) {
          await updateTelegramReply(
            env.BOT_TOKEN,
            chatId,
            messageId,
            "⚠️ هیچ تبی در شیت پیدا نشد.",
            { inline_keyboard: [[{ text: "🔙 بازگشت به پنل اصلی", callback_data: "panel:refresh" }]] }
          );
          return;
        }

        const inlineRows = [];
        for (let i = 0; i < allTabs.length; i += 2) {
          const row = [{ text: `📄 ${allTabs[i]}`, callback_data: `check_tab_idx:${i}` }];
          if (allTabs[i + 1]) {
            row.push({ text: `📄 ${allTabs[i + 1]}`, callback_data: `check_tab_idx:${i + 1}` });
          }
          inlineRows.push(row);
        }
        inlineRows.push([{ text: "🔙 بازگشت به پنل اصلی", callback_data: "panel:refresh" }]);

        await updateTelegramReply(
          env.BOT_TOKEN,
          chatId,
          messageId,
          "📂 *انتخاب تب برای تحلیل متنی:*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\nروی تب مورد نظر کلیک کنید:",
          { inline_keyboard: inlineRows }
        );
      } else if (data.startsWith("check_tab_idx:")) {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال آماده‌سازی تحلیل تب...");
        const tabIdx = parseInt(data.split(":")[1], 10);
        const allTabs = await fetchAllSheetTabs(env, ws);
        const selectedTab = allTabs[tabIdx];

        if (!selectedTab) {
          await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ تب انتخاب‌شده پیدا نشد.");
          return;
        }

        await updateTelegramReply(
          env.BOT_TOKEN,
          chatId,
          messageId,
          `📂 تب «${selectedTab}» انتخاب شد.`,
          { inline_keyboard: [[{ text: "🔙 بازگشت به پنل اصلی", callback_data: "panel:refresh" }]] }
        );

        currentJobId = await startTrackableJob(env, chatId);
        await executeSheetAnalysisWorkflow(env, chatId, currentJobId, selectedTab, ws);
        await finishTrackableJob(env, chatId, currentJobId);
      } else if (data === "panel:tasks") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال بارگذاری همه تسک‌ها...");
        await sendInteractiveTaskItems(env, chatId, "all", ws);
      } else if (data === "panel:tasks_new") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال بارگذاری تماس‌های اول...");
        await sendInteractiveTaskItems(env, chatId, "morning", ws);
      } else if (data === "panel:tasks_followup") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال بارگذاری پیگیری‌ها...");
        await sendInteractiveTaskItems(env, chatId, "evening", ws);
      } else if (data === "panel:task_overview") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال آماده‌سازی بررسی اجمالی...");
        const overviewText = await buildTasksOverviewReport(env, ws);
        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, overviewText, {
          inline_keyboard: [[{ text: "🎛 بازگشت به پنل شیشه‌ای", callback_data: "panel:refresh" }]]
        });
      } else if (data.startsWith("call_menu:") || data.startsWith("cm:")) {
        const taskRefKey = data.startsWith("cm:") ? data.slice(3) : data.slice("call_menu:".length);
        await answerCallback(env.BOT_TOKEN, cb.id, "حالت تماس را انتخاب کنید");
        await showCallOutcomeMenuForTask(env, chatId, messageId, taskRefKey);
      } else if (data.startsWith("set_outcome:")) {
        const parts = data.split(":");
        const taskRefKey = parts.slice(1, parts.length - 1).join(":");
        const outcomeKey = parts[parts.length - 1];

        await answerCallback(env.BOT_TOKEN, cb.id, "توضیحات را وارد کنید");
        await startOutcomeNotesWizard(env, chatId, messageId, taskRefKey, outcomeKey);
      } else if (data === "skip_outcome_note") {
        await answerCallback(env.BOT_TOKEN, cb.id, "ثبت بدون توضیح اضافی...");
        await completeOutcomeWizardWithNote(env, chatId, "", ws);
      } else if (data === "cancel_outcome_wizard") {
        await answerCallback(env.BOT_TOKEN, cb.id, "ثبت وضعیت لغو شد");
        if (env.DB) await dbDelete(env, `outcome_wizard:${chatId}`);
        await updateTelegramReply(
          env.BOT_TOKEN,
          chatId,
          messageId,
          "❌ ثبت وضعیت تماس لغو شد.",
          getMainGlassPanel()
        );
      } else if (data.startsWith("cancel_return:")) {
        const taskRefKey = data.slice("cancel_return:".length);
        await answerCallback(env.BOT_TOKEN, cb.id, "صرف نظر و بازگشت");
        await restoreBatchMessage(env, chatId, messageId, taskRefKey);
      } else if (data === "panel:changes") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال بررسی تغییرات...");
        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          "📊 در حال مقایسه وضعیت فعلی دانشجوها با آخرین وضعیت ثبت‌شده..."
        );
        currentJobId = await startTrackableJob(env, chatId);
        const changeReport = await buildDailyStudentChangesReport(env, false, chatId, currentJobId, ws);
        await throwIfJobStopped(env, chatId, currentJobId);

        const buttons = [];
        if (changeReport.hasBaseline) {
          buttons.push([{ text: "📌 ثبت وضعیت فعلی به عنوان مبنای جدید", callback_data: "save_snapshot" }]);
        }
        buttons.push([{ text: "🔙 بازگشت به پنل اصلی", callback_data: "panel:refresh" }]);

        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, changeReport.text, {
          inline_keyboard: buttons
        });
        await finishTrackableJob(env, chatId, currentJobId);
      } else if (data === "panel:stop") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال توقف...");
        await executeStopRequest(env, chatId);
      } else if (data === "save_snapshot") {
        await answerCallback(env.BOT_TOKEN, cb.id, "در حال ذخیره وضعیت فعلی...");
        const total = await saveCurrentSheetSnapshot(env, ws);
        await updateTelegramReply(
          env.BOT_TOKEN,
          chatId,
          messageId,
          `📌 *وضعیت فعلی (${total} دانشجو در تمام تب‌ها) به عنوان مبنای جدید مقایسه ذخیره شد.*`,
          { inline_keyboard: [[{ text: "🎛 بازگشت به پنل شیشه‌ای", callback_data: "panel:refresh" }]] }
        );
      }
      return;
    }

    const message = update.message;
    const adminId = String(ws.adminChatId || env.ADMIN_CHAT_ID || "").trim();
    if (message && (!adminId || String(message.from?.id) === adminId)) {
      const chatId = message.chat.id;
      const text = (message.text || "").trim();

      const isCommandOrMenuButton = [
        "/start",
        "/panel",
        "/search",
        "/followed",
        "/report",
        "/stop",
        "/check",
        "/tasks",
        "/overview",
        "/changes",
        "🎛 پنل شیشه‌ای",
        "🎛 باز کردن پنل شیشه‌ای",
        "پنل",
        "ℹ️ وضعیت و راهنما",
        "🔍 جستجوی دانشجو",
        "✅ پیگیری شده‌ها",
        "📊 گزارش روزانه",
        "🛑 توقف فوری",
        "🛑 توقف عملیات",
        "🧠 تحلیل کل شیت",
        "🧠 بررسی کل شیت",
        "📋 تسک‌های امروز",
        "📋 همه تسک‌ها",
        "🔍 بررسی اجمالی",
        "🔍 بررسی اجمالی تسک‌ها",
        "📈 تغییرات دانشجوها"
      ].includes(text) || text.startsWith("/check ");

      if (!isCommandOrMenuButton && text && env.DB) {
        const handledStudentText = await handleStudentTextInput(env, chatId, text, ws);
        if (handledStudentText) return;

        const handledWizard = await handleOutcomeTextInput(env, chatId, text, ws);
        if (handledWizard) return;
      }

      if (
        text === "/start" ||
        text === "/panel" ||
        text === "🎛 پنل شیشه‌ای" ||
        text === "🎛 باز کردن پنل شیشه‌ای" ||
        text === "پنل" ||
        text === "ℹ️ وضعیت و راهنما"
      ) {
        let webhookStatusLine = "📡 دریافت کلیک دکمه‌های شیشه‌ای: *فعال ✅*";
        if (originUrl) {
          try {
            const wh = await ensureTelegramWebhookConfigured(
              env.BOT_TOKEN,
              originUrl,
              env.TELEGRAM_WEBHOOK_SECRET || ""
            );
            const allowed = wh.webhookInfo?.result?.allowed_updates || [];
            const ok = wh.setWebhookResult?.ok && allowed.includes("callback_query");
            webhookStatusLine = ok
              ? "📡 دریافت کلیک دکمه‌های شیشه‌ای: *متصل و فعال ✅*"
              : `⚠️ وضعیت وبهوک: ${JSON.stringify(wh.setWebhookResult)}`;
          } catch (e) {
            webhookStatusLine = `⚠️ خطای تنظیم وبهوک: ${e.message}`;
          }
        }

        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          "✨ منوی سریع فعال شد:",
          QUICK_SUMMON_KEYBOARD
        );
        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          buildPanelWelcomeText(env, webhookStatusLine),
          getMainGlassPanel()
        );
      } else if (text === "/search" || text === "🔍 جستجوی دانشجو") {
        await startStudentSearchPrompt(env, chatId);
      } else if (text === "/followed" || text === "✅ پیگیری شده‌ها") {
        const followedText = await buildFollowedUpTasksReport(env);
        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, followedText, {
          inline_keyboard: [
            [
              { text: "📋 همه تسک‌ها", callback_data: "panel:tasks" },
              { text: "🎛 پنل اصلی", callback_data: "panel:refresh" }
            ]
          ]
        });
      } else if (text === "/report" || text === "📊 گزارش روزانه") {
        const dailyText = await buildBeautifulDailyWorkReport(env);
        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, dailyText, {
          inline_keyboard: [[{ text: "🎛 بازگشت به پنل شیشه‌ای", callback_data: "panel:refresh" }]]
        });
      } else if (text === "/stop" || text === "🛑 توقف فوری" || text === "🛑 توقف عملیات") {
        await executeStopRequest(env, chatId);
      } else if (
        text === "/check" ||
        text === "🧠 تحلیل کل شیت" ||
        text === "🧠 بررسی کل شیت" ||
        text.startsWith("/check ")
      ) {
        const targetTabFilter = text.startsWith("/check ") ? text.slice(6).trim() : "";
        currentJobId = await startTrackableJob(env, chatId);
        await executeSheetAnalysisWorkflow(env, chatId, currentJobId, targetTabFilter, ws);
        await finishTrackableJob(env, chatId, currentJobId);
      } else if (text === "/tasks" || text === "📋 تسک‌های امروز" || text === "📋 همه تسک‌ها") {
        await sendInteractiveTaskItems(env, chatId, "all", ws);
      } else if (text === "/overview" || text === "🔍 بررسی اجمالی" || text === "🔍 بررسی اجمالی تسک‌ها") {
        const overviewText = await buildTasksOverviewReport(env, ws);
        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, overviewText, {
          inline_keyboard: [[{ text: "🎛 بازگشت به پنل شیشه‌ای", callback_data: "panel:refresh" }]]
        });
      } else if (text === "/changes" || text === "📈 تغییرات دانشجوها") {
        currentJobId = await startTrackableJob(env, chatId);
        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          "📊 در حال مقایسه وضعیت فعلی تمام دانشجوها با آخرین وضعیت ثبت‌شده..."
        );
        const changeReport = await buildDailyStudentChangesReport(env, false, chatId, currentJobId, ws);
        await throwIfJobStopped(env, chatId, currentJobId);

        const buttons = [];
        if (changeReport.hasBaseline) {
          buttons.push([{ text: "📌 ثبت وضعیت فعلی به عنوان مبنای جدید", callback_data: "save_snapshot" }]);
        }
        buttons.push([{ text: "🔙 بازگشت به پنل اصلی", callback_data: "panel:refresh" }]);

        await sendLongTelegramMessages(env.BOT_TOKEN, chatId, changeReport.text, {
          inline_keyboard: buttons
        });
        await finishTrackableJob(env, chatId, currentJobId);
      } else if (message.photo) {
        currentJobId = await startTrackableJob(env, chatId);
        let boundStudent = null;
        let boundStudentKey = "";

        if (env.DB) {
          const rawStState = await dbGet(env, `student_state:${chatId}`);
          if (rawStState) {
            const parsedState = JSON.parse(rawStState);
            if (parsedState.mode === "awaiting_student_receipt" && parsedState.studentKey) {
              boundStudentKey = parsedState.studentKey;
              const rawRec = await dbGet(env, `st_record:${boundStudentKey}`);
              if (rawRec) boundStudent = JSON.parse(rawRec);
              await dbDelete(env, `student_state:${chatId}`);
            }
          }
        }

        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          boundStudent
            ? `🧾 در حال خواندن فیش برای «${escapeTelegramMarkdown(boundStudent.name || boundStudent.phone)}» و تکمیل اکسل فروش / کپی آف...`
            : "🧾 در حال خواندن اطلاعات فیش و ارسال به کانال مخصوص..."
        );

        const receiptRes = await processReceiptPhotoToChannel(env, message, chatId, currentJobId, {
          student: boundStudent,
          ws
        });
        await throwIfJobStopped(env, chatId, currentJobId);

        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          `✅ *فیش با موفقیت پردازش و به کانال ارسال شد.*\n` +
            `💰 *مبلغ:* *${escapeTelegramMarkdown(receiptRes.amount)}*\n` +
            `🔢 *کد پیگیری:* \`${escapeTelegramMarkdown(receiptRes.trackingCode)}\`\n` +
            (boundStudent
              ? `📊 *تکمیل اکسل فروش / کپی آف:* *${receiptRes.sheetUpdatedCount}* ستون به‌روزرسانی شد.\n`
              : "") +
            `⚙️ \`${receiptRes.modelUsed}\``,
          boundStudent ? buildStudentActionsKeyboard(boundStudentKey) : getMainGlassPanel()
        );
        await finishTrackableJob(env, chatId, currentJobId);
      } else if (message.voice || message.audio || message.document) {
        const isAudioDoc =
          message.document &&
          (String(message.document.mime_type || "").startsWith("audio/") ||
            /\.(ogg|mp3|wav|m4a|amr|aac|opus)$/i.test(message.document.file_name || ""));

        if (message.voice || message.audio || isAudioDoc) {
          currentJobId = await startTrackableJob(env, chatId);
          await sendTelegramMessage(
            env.BOT_TOKEN,
            chatId,
            "🎙 در حال شنیدن و تحلیل عمیق مکالمه (شخصیت، رفتار، نیازها، انگیزه‌ها، اطلاعات منتور و صدور PDF)..."
          );
          const voiceResult = await processVoiceCallAnalysis(env, message, chatId, currentJobId);
          await throwIfJobStopped(env, chatId, currentJobId);

          await sendLongTelegramMessages(env.BOT_TOKEN, chatId, voiceResult.analysisMessage, {
            inline_keyboard: [[{ text: "🎛 بازگشت به پنل شیشه‌ای", callback_data: "panel:refresh" }]]
          });

          if (voiceResult.pdfBytes && voiceResult.pdfFilename) {
            await sendTelegramDocumentBytes(
              env.BOT_TOKEN,
              chatId,
              voiceResult.pdfBytes,
              voiceResult.pdfFilename,
              "application/pdf",
              "📄 *فایل PDF تحلیل کامل مکالمه*"
            );
          }

          await finishTrackableJob(env, chatId, currentJobId);
        }
      }
    }
  } catch (err) {
    if (err.message === "USER_ABORTED") {
      if (activeChatId && env.BOT_TOKEN) {
        if (env.DB) {
          await dbDelete(env, `stop_flag:${activeChatId}`);
        }
        await sendTelegramMessage(
          env.BOT_TOKEN,
          activeChatId,
          "🛑 *عملیات با موفقیت متوقف شد.*",
          { inline_keyboard: [[{ text: "🎛 بازگشت به پنل شیشه‌ای", callback_data: "panel:refresh" }]] }
        );
      }
      return;
    }
    console.error(err);
    if (activeChatId && env.BOT_TOKEN) {
      await sendTelegramMessage(
        env.BOT_TOKEN,
        activeChatId,
        `⚠️ *خطا در اجرا:*\n${err.message}`
      );
    }
  }
}

async function processReceiptPhotoToChannel(env, message, chatId = null, jobId = null, opts = {}) {
  await throwIfJobStopped(env, chatId, jobId);

  const channelId = String(getEffectiveReceiptChannelId(env, opts.ws) || "").trim();
  if (!channelId) {
    throw new Error("متغیر RECEIPT_CHANNEL_ID در تنظیمات Worker تعریف نشده است.");
  }

  const photos = message.photo || [];
  if (!photos.length) {
    throw new Error("تصویری در پیام پیدا نشد.");
  }

  const bestPhoto = photos[photos.length - 1];
  const captionHint = (message.caption || "").trim();

  const fileMetaRes = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${bestPhoto.file_id}`
  );
  const fileMeta = await fileMetaRes.json();
  if (!fileMeta.ok || !fileMeta.result?.file_path) {
    throw new Error("خطا در دریافت اطلاعات فایل تصویر از تلگرام");
  }
  await throwIfJobStopped(env, chatId, jobId);

  const imgRes = await fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileMeta.result.file_path}`
  );
  const imgBuffer = await imgRes.arrayBuffer();
  const mimeType = fileMeta.result.file_path.toLowerCase().endsWith(".png")
    ? "image/png"
    : "image/jpeg";
  await throwIfJobStopped(env, chatId, jobId);

  const receiptPrompt =
    "این تصویر یک فیش یا رسید واریز مالی است. تمام اطلاعات موجود در تصویر را با دقت بالا استخراج کن (یادداشت همراه کاربر: «" +
    captionHint +
    "»):\n" +
    "خروجی را دقیقاً به صورت JSON معتبر برگردان:\n" +
    `{
      "amount": "مبلغ دقیق واریزی به همراه واحد",
      "transaction_date": "تاریخ تراکنش",
      "transaction_time": "ساعت تراکنش",
      "tracking_code": "کد پیگیری یا شماره مرجع",
      "payer_name": "نام واریزکننده یا صاحب حساب مبدا",
      "source_account_or_card": "شماره کارت / حساب / شبا مبدا",
      "destination_account_or_card": "شماره کارت / حساب / شبا مقصد",
      "bank_or_gateway": "نام بانک یا درگاه پرداخت",
      "status": "وضعیت تراکنش (موفق / ناموفق / نامشخص)",
      "extra_details": "سایر جزئیات یا متن‌های تکمیلی موجود در فیش"
    }`;

  const aiOut = await callAiImageWithFallback(
    env,
    receiptPrompt,
    imgBuffer,
    mimeType,
    { chatId, jobId }
  );
  await throwIfJobStopped(env, chatId, jobId);

  let parsed = {};
  try {
    parsed = JSON.parse(extractJsonBlock(aiOut.text));
  } catch {
    parsed = { extra_details: aiOut.text };
  }

  let sheetUpdatedCount = 0;
  if (opts.student) {
    const syncRes = await fillSalesExcelAndCopyOffForStudent(env, opts.student, parsed, captionHint, opts.ws);
    sheetUpdatedCount = syncRes.updatedCount;
  }

  const channelCaption =
    `🧾 *گـزارش فـیـش واریـزی*\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
    (opts.student
      ? `🎓 *دانشجو:* *${escapeTelegramMarkdown(opts.student.name || "—")}* (\`${escapeTelegramMarkdown(opts.student.phone || "—")}\`)\n`
      : "") +
    (parsed.amount ? `💰 *مبلغ:* *${escapeTelegramMarkdown(parsed.amount)}*\n` : "") +
    (parsed.status ? `📌 *وضعیت:* ${escapeTelegramMarkdown(parsed.status)}\n` : "") +
    (parsed.tracking_code ? `🔢 *کد پیگیری:* \`${escapeTelegramMarkdown(parsed.tracking_code)}\`\n` : "") +
    (parsed.transaction_date || parsed.transaction_time
      ? `🗓 *زمان:* \`${escapeTelegramMarkdown([parsed.transaction_date, parsed.transaction_time].filter(Boolean).join(" - "))}\`\n`
      : "") +
    (parsed.payer_name ? `👤 *واریزکننده:* ${escapeTelegramMarkdown(parsed.payer_name)}\n` : "") +
    (parsed.bank_or_gateway ? `🏦 *بانک / درگاه:* ${escapeTelegramMarkdown(parsed.bank_or_gateway)}\n` : "") +
    (parsed.source_account_or_card ? `💳 *مبدا:* \`${escapeTelegramMarkdown(parsed.source_account_or_card)}\`\n` : "") +
    (parsed.destination_account_or_card ? `📥 *مقصد:* \`${escapeTelegramMarkdown(parsed.destination_account_or_card)}\`\n` : "") +
    (captionHint ? `✍️ *توضیح ادمین:* ${escapeTelegramMarkdown(captionHint)}\n` : "") +
    (parsed.extra_details ? `📝 *سایر جزئیات:* ${escapeTelegramMarkdown(parsed.extra_details)}\n` : "") +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `🕒 *ثبت در سیستم:* \`${getTehranDateDisplay()} - ${getTehranTimeDisplay()}\``;

  await sendTelegramPhotoBytes(
    env.BOT_TOKEN,
    channelId,
    imgBuffer,
    `receipt-${Date.now()}.${mimeType.includes("png") ? "png" : "jpg"}`,
    mimeType,
    channelCaption.slice(0, 1020)
  );

  return {
    channelId,
    amount: parsed.amount || "—",
    trackingCode: parsed.tracking_code || "—",
    sheetUpdatedCount,
    modelUsed: aiOut.model
  };
}

async function callAiImageWithFallback(env, prompt, imageBuffer, mimeType, jobCtx = null) {
  const geminiKeys = getGeminiApiKeys(env);
  if (geminiKeys.length === 0) {
    throw new Error("برای خواندن تصویر فیش، حداقل یک کلید GEMINI_API_KEY لازم است.");
  }

  const bytes = new Uint8Array(imageBuffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64Image = btoa(binary);

  const models = getGeminiModels(env);
  const deadKeys = new Set();
  const errors = [];

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let sawTemporarySpike = false;

      for (let i = 0; i < geminiKeys.length; i++) {
        const keyTag = `gemini-img::${model}::${i}`;
        if (deadKeys.has(keyTag)) continue;

        if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
        const apiKey = geminiKeys[i];

        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts: [
                      { text: prompt },
                      { inlineData: { mimeType, data: base64Image } }
                    ]
                  }
                ],
                generationConfig: {
                  temperature: 0.1,
                  responseMimeType: "application/json"
                }
              })
            }
          );
          const data = await res.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (res.ok && text) {
            return { model: `${model} Vision (کلید ${i + 1})`, text };
          }
          const errMsg = data.error?.message || String(res.status);
          if (isDailyQuotaError(errMsg)) {
            deadKeys.add(keyTag);
          } else if (isTemporarySpikeError(res.status, errMsg)) {
            sawTemporarySpike = true;
          }
          errors.push(`[${model} | کلید ${i + 1}]: ${errMsg}`);
        } catch (e) {
          if (e.message === "USER_ABORTED") throw e;
          errors.push(`[${model} | کلید ${i + 1}]: ${e.message}`);
        }
      }

      if (sawTemporarySpike && attempt < 2) {
        if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
        await sleep(2500);
      } else {
        break;
      }
    }
  }

  throw new Error(`خطا در خواندن تصویر فیش:\n${errors.slice(-3).join("\n")}`);
}

async function sendTelegramPhotoBytes(token, chatId, buffer, filename, mimeType, caption = "") {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([buffer], { type: mimeType }), filename);
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "Markdown");
  }

  let res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: form
  });
  let data = await res.json().catch(() => null);

  if ((!res.ok || !data || data.ok !== true) && caption) {
    const retryForm = new FormData();
    retryForm.append("chat_id", String(chatId));
    retryForm.append("photo", new Blob([buffer], { type: mimeType }), filename);
    retryForm.append("caption", caption.replace(/[*_`\\]/g, ""));
    res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: retryForm
    });
    data = await res.json().catch(() => null);
  }

  if (!res.ok || !data || data.ok !== true) {
    throw new Error(`ارسال عکس به تلگرام ناموفق بود: ${data?.description || `HTTP ${res.status}`}`);
  }
}

async function resolveTaskFromRefOrBundle(env, taskIdOrRef) {
  if (!env.DB || !taskIdOrRef) return null;

  if (taskIdOrRef.includes(":")) {
    const parts = taskIdOrRef.split(":");
    const bundleId = parts[0];
    const idx = parseInt(parts[1], 10);
    const rawBundle = await dbGet(env, `tasks_bundle:${bundleId}`);
    if (rawBundle) {
      const bundle = JSON.parse(rawBundle);
      const task = Array.isArray(bundle.tasks) ? bundle.tasks[idx] : null;
      if (task) {
        return {
          ...task,
          _bundleId: bundleId,
          _taskIndex: idx,
          _headerInfo: bundle.headerInfo || ""
        };
      }
    }
  }

  const raw = await dbGet(env, `task_ref:${taskIdOrRef}`);
  return raw ? JSON.parse(raw) : null;
}

async function startOutcomeNotesWizard(env, chatId, sourceMessageId, taskIdOrRef, outcomeKey) {
  if (!env.DB) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ اتصال دیتابیس D1 با نام `DB` برقرار نیست.");
    return;
  }

  const chosen = CALL_OUTCOME_OPTIONS.find((o) => o.key === outcomeKey);
  if (!chosen) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ وضعیت انتخاب‌شده نامعتبر است.");
    return;
  }

  const taskObj = await resolveTaskFromRefOrBundle(env, taskIdOrRef);
  const existingName = String(taskObj?.name || "").trim();
  const shouldAskStudentName = !existingName;

  await dbPut(
    env,
    `outcome_wizard:${chatId}`,
    JSON.stringify({
      step: shouldAskStudentName ? "awaiting_name" : "awaiting_description",
      taskId: taskIdOrRef,
      outcomeKey,
      sourceMessageId,
      studentName: existingName,
      nameWasUpdatedByUser: false,
      extraDescription: ""
    }),
    { expirationTtl: 1800 }
  );

  const headerLine =
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
    `  ${getOutcomeBadge(chosen.label)} *${chosen.label}*\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
    (taskObj
      ? `${existingName ? `👤 *نام:* *${escapeTelegramMarkdown(existingName)}*  |  ` : ""}📱 *شماره:* \`${escapeTelegramMarkdown(taskObj.phone)}\`\n` +
        `📂 *تب:* \`${escapeTelegramMarkdown(taskObj.tab)}\`  •  *ردیف:* ${taskObj.rowNum}`
      : "");

  if (shouldAskStudentName) {
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `${headerLine}\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
        `👤 *مرحله ۱ از ۲:* نام این دانشجو در شیت ثبت نشده است.\n` +
        `لطفاً **نام دانشجو** را بنویسید تا با فرمت «... آیولرن شاتل آذر» آماده شود:`,
      {
        inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_outcome_wizard" }]]
      }
    );
  } else {
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `${headerLine}\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
        `📝 لطفاً **توضیحات** این تماس را بنویسید و بفرستید\n` +
        `*(در قالب \`[توضیح]///\` ثبت می‌شود)*:`,
      {
        inline_keyboard: [
          [{ text: "⏭ ثبت بدون توضیح", callback_data: "skip_outcome_note" }],
          [{ text: "❌ انصراف", callback_data: "cancel_outcome_wizard" }]
        ]
      }
    );
  }
}

async function handleOutcomeTextInput(env, chatId, userText, ws = null) {
  const rawWiz = await dbGet(env, `outcome_wizard:${chatId}`);
  if (!rawWiz) return false;

  const wiz = JSON.parse(rawWiz);

  if (wiz.step === "awaiting_name") {
    wiz.studentName = userText.trim();
    wiz.nameWasUpdatedByUser = true;
    wiz.step = "awaiting_description";
    await dbPut(env, `outcome_wizard:${chatId}`, JSON.stringify(wiz), {
      expirationTtl: 1800
    });

    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `✅ *نام مخاطب:* \`${escapeTelegramMarkdown(formatContactFullName(wiz.studentName))}\`\n` +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
        `📝 *مرحله ۲ از ۲:* حالا **توضیحات** این تماس را بنویسید و بفرستید:`,
      {
        inline_keyboard: [
          [{ text: "⏭ ثبت بدون توضیح", callback_data: "skip_outcome_note" }],
          [{ text: "❌ انصراف", callback_data: "cancel_outcome_wizard" }]
        ]
      }
    );
    return true;
  }

  if (wiz.step === "awaiting_description") {
    await completeOutcomeWizardWithNote(env, chatId, userText.trim(), ws);
    return true;
  }

  return false;
}

async function completeOutcomeWizardWithNote(env, chatId, noteText, ws = null) {
  if (!env.DB) return;
  const rawWiz = await dbGet(env, `outcome_wizard:${chatId}`);
  if (!rawWiz) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ حالت ثبت توضیح منقضی شده است.");
    return;
  }

  const wiz = JSON.parse(rawWiz);
  await dbDelete(env, `outcome_wizard:${chatId}`);

  await applyCallOutcomeMoveToFollowedAndWriteSheet(
    env,
    chatId,
    wiz.sourceMessageId,
    wiz.taskId,
    wiz.outcomeKey,
    {
      studentName: wiz.studentName,
      nameWasUpdatedByUser: wiz.nameWasUpdatedByUser,
      extraDescription: noteText,
      ws
    }
  );
}

async function addTaskToFollowedUpSection(env, entry) {
  if (!env.DB) {
    throw new Error("اتصال دیتابیس D1 با نام DB در Cloudflare تنظیم نشده است.");
  }
  const dateKey = getTodayTehranKey();
  const listKey = `followed_up_list:${dateKey}`;
  const raw = await dbGet(env, listKey);
  const list = raw ? JSON.parse(raw) : [];

  const normPhone = normalizePhoneKey(entry.phone);
  const identityKeys = buildTaskIdentityKeys(entry.tab, entry.rowNum, entry.phone);

  const record = {
    identityKey: entry.identityKey || identityKeys[0] || `${entry.tab}::${entry.rowNum}`,
    identityKeys,
    phoneNormalized: normPhone,
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

  if (idx >= 0) {
    list[idx] = record;
  } else {
    list.unshift(record);
  }

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
    for (const k of keys) {
      map[k] = item;
    }
  }

  const rawDaily = await dbGet(env, `daily_work_log:${dateKey}`);
  const dailyList = rawDaily ? JSON.parse(rawDaily) : [];
  for (const item of dailyList) {
    if (shouldRequeueSameDayFromNote(item.logNote || "")) continue;
    const keys = item.identityKeys || buildTaskIdentityKeys(item.tab, item.rowNum, item.phone);
    for (const k of keys) {
      if (!map[k]) map[k] = item;
    }
  }

  return map;
}

async function buildSameDayRequeueReport(env) {
  const dateLabel = getTehranDateDisplay();
  const dateKey = getTodayTehranKey();

  let list = [];
  if (env.DB) {
    const raw = await dbGet(env, `followed_up_list:${dateKey}`);
    if (raw) list = JSON.parse(raw);
  }

  const requeueItems = list.filter(
    (item) => item.requeueSameDay || shouldRequeueSameDayFromNote(item.logNote || "")
  );

  if (requeueItems.length === 0) {
    return (
      `⏰ *تماس‌های مجدد امروز*\n` +
      `🗓 *تاریخ:* ${dateLabel}\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
      `✨ موردی برای تماس مجدد امروز ثبت نشده است.`
    );
  }

  let text =
    `⏰ *تماس‌های مجدد امروز (${requeueItems.length} مورد)*\n` +
    `🗓 *تاریخ:* ${dateLabel}\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`;

  requeueItems.forEach((item, idx) => {
    text +=
      `🔔 *${idx + 1}. ${escapeTelegramMarkdown(item.name)}*  \`(${escapeTelegramMarkdown(item.phone)})\`\n` +
      `   📂 \`${escapeTelegramMarkdown(item.tab)}\` (ردیف ${item.rowNum})  •  🕒 \`${item.timeDisplay}\`\n` +
      `   📝 \`${escapeTelegramMarkdown(item.logNote)}\`\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n`;
  });

  return text.trim();
}

async function buildFollowedUpTasksReport(env) {
  const dateLabel = getTehranDateDisplay();
  const dateKey = getTodayTehranKey();

  let list = [];
  if (env.DB) {
    const raw = await dbGet(env, `followed_up_list:${dateKey}`);
    if (raw) list = JSON.parse(raw);
  }

  if (list.length === 0) {
    return (
      `✅ *بخش پیگیری شده‌ها*\n` +
      `🗓 *تاریخ:* ${dateLabel}\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
      `🌱 هنوز هیچ تماسی برای امروز در *«پیگیری شده‌ها»* ثبت نشده است.\n` +
      `با ثبت نتیجه هر تماس در تسک‌ها، مورد مربوطه به اینجا منتقل می‌شود.`
    );
  }

  let text =
    `✅ *بخش پیگیری شده‌ها (${list.length} مورد)*\n` +
    `🗓 *تاریخ:* ${dateLabel}\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`;

  list.forEach((item, idx) => {
    const cleanOutcome = canonicalizeOutcomeLabel(item.outcome) || item.outcome;
    const requeueTag = item.requeueSameDay ? "  •  ⏰ *تماس مجدد امروز*" : "";
    text +=
      `🔹 *${idx + 1}. ${escapeTelegramMarkdown(item.name)}*  \`(${escapeTelegramMarkdown(item.phone)})\`\n` +
      `   📂 \`${escapeTelegramMarkdown(item.tab)}\` (ردیف ${item.rowNum})${requeueTag}\n` +
      `   ${getOutcomeBadge(cleanOutcome)} *${cleanOutcome}*  •  🔁 *${item.followNumber} بار*  •  🕒 \`${item.timeDisplay}\`\n` +
      `   📝 \`${escapeTelegramMarkdown(item.logNote)}\`\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n`;
  });

  return text.trim();
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

  if (existingIdx >= 0) {
    logs[existingIdx] = record;
  } else {
    logs.push(record);
  }

  await dbPut(env, storageKey, JSON.stringify(logs), { expirationTtl: 604800 });
}

function getOutcomeBadge(outcomeLabel) {
  const norm = normalizeStatusComparable(outcomeLabel || "");
  if (norm.includes("فروش بسته") || norm.includes("بسته فروش")) return "🎉";
  if (norm.includes("تماس آینده")) return "🗓";
  if (norm.includes("خاموش")) return "📴";
  if (norm.includes("جواب نداد")) return "📵";
  if (norm.includes("قطعی نمی‌خواهد") || norm.includes("قطعی نمیخواهد")) return "🚫";
  if (norm.includes("اشتباه")) return "❓";
  return "✅";
}

async function buildBeautifulDailyWorkReport(env) {
  const dateLabel = getTehranDateDisplay();
  const dateKey = getTodayTehranKey();

  let logs = [];
  if (env.DB) {
    const raw = await dbGet(env, `daily_work_log:${dateKey}`);
    if (raw) logs = JSON.parse(raw);
  }

  if (logs.length === 0) {
    return (
      `✨ *گـزارش روزانـه فـعـالـیـت‌ها* ✨\n` +
      `🗓 *تاریخ:* ${dateLabel}\n` +
      `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n` +
      `🌱 هنوز نتیجه‌ای برای تماس‌های امروز ثبت نکرده‌اید.\n` +
      `از دکمه‌های تسک در پنل استفاده کنید تا نتایج هم در *«پیگیری شده‌ها»* و هم در شیت ثبت شوند.`
    );
  }

  const countsByOutcome = {};
  for (const item of logs) {
    const statusKey = canonicalizeOutcomeLabel(item.newStatus) || item.newStatus;
    countsByOutcome[statusKey] = (countsByOutcome[statusKey] || 0) + 1;
  }

  const wonCount = countsByOutcome["موفق - فروش بسته"] || 0;
  const futureCount = countsByOutcome["پیگیری - تماس آینده"] || 0;
  const noAnsCount = countsByOutcome["پیگیری - جواب نداد"] || 0;

  let text =
    `✨ *گـزارش روزانـه فـعـالـیـت‌ها* ✨\n` +
    `🗓 *تاریخ:* ${dateLabel}\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n` +
    `🏆 *خلاصه عملکرد امروز:*\n` +
    `▸ ✅ *کل تماس‌ها:* *${logs.length}* مورد\n` +
    `▸ 🎉 *فروش بسته:* *${wonCount}*  •  🗓 *آینده:* *${futureCount}*  •  📵 *جواب نداد:* *${noAnsCount}*\n\n`;

  text += `📌 *تفکیک وضعیت‌ها:*\n`;
  for (const [statusName, cnt] of Object.entries(countsByOutcome)) {
    text += `  ${getOutcomeBadge(statusName)} ${statusName}: *${cnt}* نفر\n`;
  }

  text += `\n✦━━━━━━━━━━━━━━━━━━━━━━✦\n📋 *جزئیات تماس‌های ثبت‌شده:*\n\n`;

  logs.forEach((item, idx) => {
    const cleanStatus = canonicalizeOutcomeLabel(item.newStatus) || item.newStatus;
    const badge = getOutcomeBadge(cleanStatus);
    text +=
      `✅ *${idx + 1}. ${escapeTelegramMarkdown(item.name)}*  \`(${escapeTelegramMarkdown(item.phone)})\`\n` +
      `   📂 \`${escapeTelegramMarkdown(item.tab)}\` (ردیف ${item.rowNum})  •  🕒 \`${item.timeDisplay}\`\n` +
      `   ${badge} *${cleanStatus}* (${item.followNumber} بار)\n` +
      (item.logNote ? `   📝 \`${escapeTelegramMarkdown(item.logNote)}\`\n` : "") +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n`;
  });

  return text.trim();
}

function formatFullTaskDetailBlock(r, tabName, isDone) {
  const numericFollow = parseNumericFollowCount(r.fields.followCount);
  const followDisplay = numericFollow !== null ? `${numericFollow} بار (تماس ${numericFollow + 1})` : "تماس اول";
  const badge = isDone ? "✅ *انجام‌شده*" : "⏳ *در انتظار*";
  const gon = extractGoalObstacleNeedFromFields(r.fields);
  const prevStatus = String(r.fields.status || "").trim() || "ثبت نشده";

  const lines = [
    `${badge}  •  👤 *${escapeTelegramMarkdown(r.fields.name || "بدون نام")}*  •  📂 \`${escapeTelegramMarkdown(tabName)}\` (ردیف ${r.rowNum})`,
    `📱 \`${escapeTelegramMarkdown(r.phone || "—")}\`  •  ⏮ *${escapeTelegramMarkdown(prevStatus)}*  •  🔢 *${escapeTelegramMarkdown(followDisplay)}*`
  ];
  if (r.messengers && r.messengers.length > 0) {
    lines.push(`💬 ${escapeTelegramMarkdown(r.messengers.join(" ، "))}`);
  }
  if (gon.goal) lines.push(`🎯 *هدف:* ${escapeTelegramMarkdown(gon.goal)}`);
  if (gon.obstacle) lines.push(`🚧 *مانع:* ${escapeTelegramMarkdown(gon.obstacle)}`);
  if (gon.need) lines.push(`🧩 *نیاز:* ${escapeTelegramMarkdown(gon.need)}`);
  if (r.fields.objection) lines.push(`🛡 *آبجکشن:* ${escapeTelegramMarkdown(r.fields.objection)}`);
  if (r.fields.description) lines.push(`📝 *توضیحات:* ${escapeTelegramMarkdown(r.fields.description)}`);
  return lines.join("\n");
}

async function buildTasksOverviewReport(env, ws = null) {
  const { tabsData } = await fetchAllSheetRows(env, ws);
  const followedMap = await getFollowedUpMapForToday(env);
  const today = getTehranDateDisplay();

  const allEntries = [];
  const aiCandidates = [];

  for (const t of tabsData) {
    for (const r of t.rows) {
      if (!r.phone && !r.fields.name) continue;
      if (hasStrikethroughName(r.fields.name, r.isNameStruck)) continue;

      const id = `${t.tab}::${r.rowNum}`;
      const candidateKeys = buildTaskIdentityKeys(t.tab, r.rowNum, r.phone);
      const isFollowedToday = candidateKeys.some((k) => Boolean(followedMap[k]));

      allEntries.push({ id, tab: t.tab, r, isFollowedToday });
      if (!isFollowedToday && (r.fields.status || r.fields.description)) {
        aiCandidates.push({
          id,
          status: r.fields.status || "",
          description: r.fields.description || ""
        });
      }
    }
  }

  const excludedByAi = await classifyExcludedRowsWithAi(env, aiCandidates);

  const pendingItems = [];
  const completedItems = [];

  for (const entry of allEntries) {
    const done = entry.isFollowedToday || excludedByAi.has(entry.id);
    const block = formatFullTaskDetailBlock(entry.r, entry.tab, done);
    if (done) completedItems.push(block);
    else pendingItems.push(block);
  }

  const totalCount = pendingItems.length + completedItems.length;
  let report =
    `🔍 *بـررسـی اجـمـالـی تـسـک‌ها (${today})*\n` +
    `📊 *کل:* *${totalCount}*  •  ⏳ *باقیمانده:* *${pendingItems.length}*  •  ✅ *انجام‌شده:* *${completedItems.length}*\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`;

  report += `⏳ *در انتظار اقدام (${pendingItems.length} مورد):*\n\n`;
  if (pendingItems.length > 0) {
    report += pendingItems.join("\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n");
  } else {
    report += "🎉 همه تسک‌ها انجام شده‌اند.";
  }

  report += `\n\n✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`;
  report += `✅ *انجام‌شده / مختومه (${completedItems.length} مورد):*\n\n`;
  if (completedItems.length > 0) {
    report += completedItems.join("\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n");
  } else {
    report += "ℹ️ مورد مختومه‌ای ثبت نشده است.";
  }

  return report.trim();
}

function encodeTaskToken(tabName, rowNum) {
  const bytes = new TextEncoder().encode(`${tabName}::${rowNum}`);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 40);
}

function formatSingleTaskInBatch(task, indexNumber) {
  const typeTag = task.isNew
    ? `📞 *تماس اول*`
    : `🔥 *پیگیری (${task.followCount} ➔ ${task.followCount + 1})*`;
  const prevStatusLabel = task.previousStatus || "ثبت نشده";

  const lines = [
    `✦ *#${indexNumber}*  ${typeTag}  •  📂 \`${escapeTelegramMarkdown(task.tab)}\``,
    `▸ 👤 *${escapeTelegramMarkdown(task.name || "بدون نام")}*  |  📱 \`${escapeTelegramMarkdown(task.phone || "—")}\``,
    `▸ ⏮ *وضعیت:* ${escapeTelegramMarkdown(prevStatusLabel)}`
  ];
  if (task.messengers && task.messengers.length > 0) {
    lines.push(`▸ 💬 *پیام‌رسان:* ${escapeTelegramMarkdown(task.messengers.join(" ، "))}`);
  }
  if (task.goal) lines.push(`▸ 🎯 *هدف:* ${escapeTelegramMarkdown(task.goal)}`);
  if (task.obstacle) lines.push(`▸ 🚧 *مانع:* ${escapeTelegramMarkdown(task.obstacle)}`);
  if (task.need) lines.push(`▸ 🧩 *نیاز:* ${escapeTelegramMarkdown(task.need)}`);
  if (task.objection) lines.push(`▸ 🛡 *آبجکشن:* ${escapeTelegramMarkdown(task.objection)}`);
  if (task.description) lines.push(`▸ 📝 *توضیحات:* ${escapeTelegramMarkdown(task.description)}`);
  lines.push(`┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`);
  return lines.join("\n");
}

function buildBatchTasksText(tasksChunk, batchIndex, totalBatches, headerInfo) {
  const batchHeader =
    totalBatches > 1
      ? `${headerInfo}\n📦 *دسته ${batchIndex + 1} از ${totalBatches}*\n✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`
      : `${headerInfo}\n✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`;

  const body = tasksChunk
    .map((item, idx) => formatSingleTaskInBatch(item, batchIndex * TASKS_PER_SINGLE_MESSAGE + idx + 1))
    .join("\n\n");

  return `${batchHeader}${body}`.trim();
}

function buildBatchTasksKeyboard(tasksChunk, batchIndex, isLastBatch, bundleId = "") {
  const rows = [];
  for (let i = 0; i < tasksChunk.length; i += 2) {
    const num1 = batchIndex * TASKS_PER_SINGLE_MESSAGE + i + 1;
    const t1 = tasksChunk[i];
    const label1 = (t1.name || t1.phone || "ثبت").replace(/[^\w\u0600-\u06FF\s]/g, "").trim().slice(0, 11) || "ثبت";
    const cb1 = bundleId && typeof t1.idx === "number" ? `cm:${bundleId}:${t1.idx}` : `call_menu:${t1.token}`;
    const row = [
      {
        text: `📞 #${num1} • ${label1}`,
        callback_data: cb1.slice(0, 64)
      }
    ];
    if (tasksChunk[i + 1]) {
      const num2 = batchIndex * TASKS_PER_SINGLE_MESSAGE + i + 2;
      const t2 = tasksChunk[i + 1];
      const label2 = (t2.name || t2.phone || "ثبت").replace(/[^\w\u0600-\u06FF\s]/g, "").trim().slice(0, 11) || "ثبت";
      const cb2 = bundleId && typeof t2.idx === "number" ? `cm:${bundleId}:${t2.idx}` : `call_menu:${t2.token}`;
      row.push({
        text: `📞 #${num2} • ${label2}`,
        callback_data: cb2.slice(0, 64)
      });
    }
    rows.push(row);
  }

  if (isLastBatch) {
    rows.push([
      { text: "✅ پیگیری شده‌ها", callback_data: "panel:followed_up" },
      { text: "📊 گزارش روزانه", callback_data: "panel:daily_report" }
    ]);
    rows.push([{ text: "🎛 پنل اصلی", callback_data: "panel:refresh" }]);
  }

  return { inline_keyboard: rows };
}

function buildCallOutcomeKeyboard(taskRefKey) {
  const safeKey = String(taskRefKey || "").slice(0, 42);
  return {
    inline_keyboard: [
      [
        { text: "🎉 فروش بسته", callback_data: `set_outcome:${safeKey}:won_sale`.slice(0, 64) },
        { text: "🗓 تماس آینده", callback_data: `set_outcome:${safeKey}:future_call`.slice(0, 64) }
      ],
      [
        { text: "📵 جواب نداد", callback_data: `set_outcome:${safeKey}:no_answer`.slice(0, 64) },
        { text: "📴 خاموش بود", callback_data: `set_outcome:${safeKey}:switched_off`.slice(0, 64) }
      ],
      [
        { text: "❓ اشتباه بود", callback_data: `set_outcome:${safeKey}:wrong_num`.slice(0, 64) },
        { text: "🚫 قطعی نمی‌خواهد", callback_data: `set_outcome:${safeKey}:def_no`.slice(0, 64) }
      ],
      [
        { text: "↩️ بازگشت به لیست", callback_data: `cancel_return:${safeKey}`.slice(0, 64) }
      ]
    ]
  };
}

async function collectTodayTasks(env, mode = "all", ws = null) {
  const { tabsData, totalStudents } = await fetchAllSheetRows(env, ws);
  const followedMap = await getFollowedUpMapForToday(env);

  const prelimRows = [];
  const aiCandidates = [];
  let followedCountToday = 0;

  for (const t of tabsData) {
    const descColIdx = t.colMap?.description ?? -1;
    const descColLetter = descColIdx !== -1 ? columnIndexToLetter(descColIdx) : "";
    const nameColIdx = t.colMap?.name ?? -1;
    const nameColLetter = nameColIdx !== -1 ? columnIndexToLetter(nameColIdx) : "";
    const followColIdx = t.colMap?.followCount ?? -1;
    const followColLetter = followColIdx !== -1 ? columnIndexToLetter(followColIdx) : "";
    const entryDateColIdx = t.colMap?.entryDate ?? -1;
    const entryDateColLetter = entryDateColIdx !== -1 ? columnIndexToLetter(entryDateColIdx) : "";
    const rowSerialColIdx = t.colMap?.rowSerial ?? -1;
    const rowSerialColLetter = rowSerialColIdx !== -1 ? columnIndexToLetter(rowSerialColIdx) : "";
    const weekdayColIdx = t.colMap?.weekday ?? -1;
    const weekdayColLetter = weekdayColIdx !== -1 ? columnIndexToLetter(weekdayColIdx) : "";
    const statusColIdx = t.colMap?.status ?? -1;
    const statusColLetter = statusColIdx !== -1 ? columnIndexToLetter(statusColIdx) : "";

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
      const isAlreadyFollowed = candidateKeys.some((k) => Boolean(followedMap[k]));

      if (isAlreadyFollowed) {
        followedCountToday++;
        continue;
      }

      const id = `${t.tab}::${r.rowNum}`;
      prelimRows.push({
        id,
        t,
        r,
        candidateKeys,
        descColLetter,
        nameColLetter,
        followColLetter,
        entryDateColLetter,
        rowSerialColLetter,
        weekdayColLetter,
        statusColLetter,
        tabPresets
      });

      const numericFollow = parseNumericFollowCount(r.fields.followCount);
      const hasExplicitStatus = Boolean(String(r.fields.status || "").trim());
      if ((numericFollow !== null || hasExplicitStatus) && (r.fields.status || r.fields.description)) {
        aiCandidates.push({
          id,
          status: r.fields.status || "",
          description: r.fields.description || ""
        });
      }
    }
  }

  const excludedByAi = await classifyExcludedRowsWithAi(env, aiCandidates);

  const newCalls = [];
  const followUps = [];
  const seenTabRowOrPhone = new Set();

  for (const entry of prelimRows) {
    if (excludedByAi.has(entry.id)) continue;

    const {
      t,
      r,
      candidateKeys,
      descColLetter,
      nameColLetter,
      followColLetter,
      entryDateColLetter,
      rowSerialColLetter,
      weekdayColLetter,
      statusColLetter,
      tabPresets
    } = entry;

    const normPhone = normalizePhoneKey(r.phone);
    const dedupKey = normPhone
      ? `${normalizeHeaderTitle(t.tab)}::${normPhone}`
      : `${normalizeHeaderTitle(t.tab)}::row_${r.rowNum}`;

    if (seenTabRowOrPhone.has(dedupKey)) {
      continue;
    }
    seenTabRowOrPhone.add(dedupKey);

    const numericFollow = parseNumericFollowCount(r.fields.followCount);
    const isNew = numericFollow === null;
    const followCount = numericFollow !== null ? numericFollow : 0;

    const gon = extractGoalObstacleNeedFromFields(r.fields);
    const previousStatus = String(r.fields.status || "").trim() || "ثبت نشده";

    const item = {
      tab: t.tab,
      rowNum: r.rowNum,
      identityKey: candidateKeys[0] || `${t.tab}::${r.rowNum}`,
      identityKeys: candidateKeys,
      phoneNormalized: normPhone,
      descColLetter,
      nameColLetter,
      followColLetter,
      entryDateColLetter,
      rowSerialColLetter,
      weekdayColLetter,
      statusColLetter,
      tabPresets,
      currentRowFields: {
        entryDate: r.fields.entryDate || "",
        rowSerial: r.fields.rowSerial || "",
        weekday: r.fields.weekday || "",
        status: r.fields.status || ""
      },
      phone: r.phone,
      name: r.fields.name || "",
      previousStatus,
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

  let selected = [];
  if (mode === "morning") selected = [...newCalls];
  else if (mode === "evening") selected = [...followUps];
  else selected = [...newCalls, ...followUps];

  return {
    newCalls,
    followUps,
    followedCountToday,
    totalStudents,
    tabsCount: tabsData.length,
    selected
  };
}

async function sendInteractiveTaskItems(env, chatId, mode = "all", ws = null) {
  const { newCalls, followUps, followedCountToday, totalStudents, tabsCount, selected } =
    await collectTodayTasks(env, mode, ws);
  const today = getTehranDateDisplay();
  const modeTitle =
    mode === "morning"
      ? "📞 *تـمـاس‌هـای اول بـاقـی‌مـانـده*"
      : mode === "evening"
        ? "🔥 *پـیـگـیـری‌هـای بـاقـی‌مـانـده*"
        : "📋 *تـسـک‌هـای بـاقـی‌مـانـده امـروز*";

  const headerInfo =
    `${modeTitle} *(${today})*\n` +
    `📞 *اول:* *${newCalls.length}*  •  🔥 *پیگیری:* *${followUps.length}*  •  ✅ *انجام‌شده:* *${followedCountToday}*`;

  if (selected.length === 0) {
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `${headerInfo}\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
        `🎉 هیچ تسک فعالی برای نمایش باقی نمانده است.\n` +
        `• کل ردیف‌های *${tabsCount}* تب: *${totalStudents}* مورد\n` +
        `• انجام‌شده امروز: *${followedCountToday}* مورد`,
      {
        inline_keyboard: [
          [
            { text: "🔍 بررسی اجمالی", callback_data: "panel:task_overview" },
            { text: "✅ پیگیری شده‌ها", callback_data: "panel:followed_up" }
          ],
          [{ text: "🎛 پنل اصلی", callback_data: "panel:refresh" }]
        ]
      }
    );
    return;
  }

  const indexedSelected = selected.map((item, idx) => ({ ...item, idx }));
  const bundleId = `b${Date.now().toString(36)}`;

  if (env.DB) {
    await dbPut(
      env,
      `tasks_bundle:${bundleId}`,
      JSON.stringify({
        headerInfo,
        tasks: indexedSelected
      }),
      { expirationTtl: 86400 }
    );
  }

  const batches = [];
  for (let i = 0; i < indexedSelected.length; i += TASKS_PER_SINGLE_MESSAGE) {
    batches.push(indexedSelected.slice(i, i + TASKS_PER_SINGLE_MESSAGE));
  }

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    const msgText = buildBatchTasksText(batch, bIdx, batches.length, headerInfo);
    const keyboard = buildBatchTasksKeyboard(batch, bIdx, bIdx === batches.length - 1, bundleId);
    await sendTelegramMessage(env.BOT_TOKEN, chatId, msgText, keyboard);
  }
}

async function showCallOutcomeMenuForTask(env, chatId, messageId, taskRefKey) {
  let taskObj = null;
  try {
    taskObj = await resolveTaskFromRefOrBundle(env, taskRefKey);
  } catch (e) {
    console.error("Failed reading task ref:", e);
  }

  const trimField = (val, maxLen = 140) => {
    const s = String(val || "").replace(/\s+/g, " ").trim();
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
  };

  const safeName = escapeTelegramMarkdown(trimField(taskObj?.name || "بدون نام", 60));
  const safePhone = escapeTelegramMarkdown(trimField(taskObj?.phone || "—", 30));
  const safeTab = escapeTelegramMarkdown(trimField(taskObj?.tab || "—", 40));
  const safePrevStatus = escapeTelegramMarkdown(trimField(taskObj?.previousStatus || "ثبت نشده", 50));
  const safeGoal = escapeTelegramMarkdown(trimField(taskObj?.goal || "", 120));
  const safeObstacle = escapeTelegramMarkdown(trimField(taskObj?.obstacle || "", 120));
  const safeNeed = escapeTelegramMarkdown(trimField(taskObj?.need || "", 120));
  const safeMessengers = Array.isArray(taskObj?.messengers) && taskObj.messengers.length > 0
    ? escapeTelegramMarkdown(taskObj.messengers.join(" ، "))
    : "";

  const followText = taskObj
    ? (taskObj.isNew ? "تماس اول" : `${taskObj.followCount || 0} بار ➔ ${(taskObj.followCount || 0) + 1} بار`)
    : "نامشخص";

  const summary = taskObj
    ? `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
      `  📞 *ثـبـت نـتـیـجـه تـمـاس*\n` +
      `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
      `👤 *نام:* ${safeName}  |  📱 \`${safePhone}\`\n` +
      `📂 *تب:* \`${safeTab}\`  •  *ردیف:* ${taskObj.rowNum || "—"}\n` +
      `⏮ *وضعیت قبلی:* ${safePrevStatus}\n` +
      `🔁 *پیگیری:* ${followText}\n` +
      (safeMessengers ? `💬 *پیام‌رسان‌ها:* ${safeMessengers}\n` : "") +
      (safeGoal ? `🎯 *هدف:* ${safeGoal}\n` : "") +
      (safeObstacle ? `🚧 *مانع:* ${safeObstacle}\n` : "") +
      (safeNeed ? `🧩 *نیاز:* ${safeNeed}\n` : "") +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `👇 *نتیجه تماس را انتخاب کنید:*`
    : `📞 *ثبت نتیجه تماس*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n👇 *نتیجه تماس را انتخاب کنید:*`;

  const keyboard = buildCallOutcomeKeyboard(taskRefKey);

  const edited = await tryEditTelegramMessage(env.BOT_TOKEN, chatId, messageId, summary, keyboard);
  if (!edited) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, summary, keyboard);
  }
}

async function restoreBatchMessage(env, chatId, messageId, taskRefKey) {
  const taskObj = await resolveTaskFromRefOrBundle(env, taskRefKey);
  if (taskObj && taskObj._bundleId && typeof taskObj._taskIndex === "number" && env.DB) {
    const rawBundle = await dbGet(env, `tasks_bundle:${taskObj._bundleId}`);
    if (rawBundle) {
      const bundle = JSON.parse(rawBundle);
      const allTasks = bundle.tasks || [];
      const batchIndex = Math.floor(taskObj._taskIndex / TASKS_PER_SINGLE_MESSAGE);
      const startIdx = batchIndex * TASKS_PER_SINGLE_MESSAGE;
      const batchTasks = allTasks.slice(startIdx, startIdx + TASKS_PER_SINGLE_MESSAGE);
      const totalBatches = Math.max(1, Math.ceil(allTasks.length / TASKS_PER_SINGLE_MESSAGE));
      const isLastBatch = batchIndex === totalBatches - 1;

      if (batchTasks.length > 0) {
        const msgText = buildBatchTasksText(batchTasks, batchIndex, totalBatches, bundle.headerInfo || "");
        const keyboard = buildBatchTasksKeyboard(batchTasks, batchIndex, isLastBatch, taskObj._bundleId);
        await updateTelegramReply(env.BOT_TOKEN, chatId, messageId, msgText, keyboard);
        return;
      }
    }
  }

  await updateTelegramReply(
    env.BOT_TOKEN,
    chatId,
    messageId,
    buildPanelWelcomeText(env),
    getMainGlassPanel()
  );
}

async function applyCallOutcomeMoveToFollowedAndWriteSheet(
  env,
  chatId,
  messageId,
  taskRefKey,
  outcomeKey,
  extraInput = {}
) {
  const chosen = CALL_OUTCOME_OPTIONS.find((o) => o.key === outcomeKey);
  if (!chosen) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ حالت انتخاب‌شده نامعتبر است.");
    return;
  }

  if (!env.DB) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ اتصال دیتابیس D1 با نام `DB` در Cloudflare متصل نیست.");
    return;
  }

  const taskRef = await resolveTaskFromRefOrBundle(env, taskRefKey);
  if (!taskRef) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, "⚠️ اطلاعات این تسک منقضی شده است.");
    return;
  }

  const currentNumericFollow = parseNumericFollowCount(taskRef.followCount);
  const updatedFollowNumber = currentNumericFollow !== null ? currentNumericFollow + 1 : 1;

  const finalStudentName = String(extraInput.studentName || taskRef.name || "بدون نام").trim();
  const timeDisplay = getTehranTimeDisplay();
  const dateDisplay = getTehranDateDisplay();
  const identityKeys = buildTaskIdentityKeys(taskRef.tab, taskRef.rowNum, taskRef.phone);
  const identityKey = taskRef.identityKey || identityKeys[0] || `${taskRef.tab}::${taskRef.rowNum}`;
  const logNote = formatFollowUpNoteEntry(chosen.label, extraInput.extraDescription || "");
  const requeueSameDay = shouldRequeueSameDayFromNote(extraInput.extraDescription || "");

  const shouldOverwriteNameInSheet =
    Boolean(extraInput.nameWasUpdatedByUser) && Boolean(extraInput.studentName);

  const presetValues = await resolvePresetFieldsWithAi(env, {
    outcomeLabel: chosen.label,
    extraDescription: extraInput.extraDescription || "",
    currentFields: taskRef.currentRowFields || {},
    rowNum: taskRef.rowNum,
    presets: taskRef.tabPresets || {}
  });

  const finalStatusLabel = canonicalizeOutcomeLabel(presetValues.status || chosen.label) || chosen.label;

  let sheetWriteStatus = "ثبت شد ✅";
  try {
    await writeFollowUpUpdatesToSheet(
      env,
      taskRef,
      {
        logNote,
        nextFollowCount: updatedFollowNumber,
        studentName: shouldOverwriteNameInSheet ? extraInput.studentName : "",
        presetValues: {
          ...presetValues,
          status: finalStatusLabel
        }
      },
      extraInput.ws || null
    );
  } catch (sheetErr) {
    sheetWriteStatus = `⚠️ خطا در شیت: ${sheetErr.message}`;
  }

  await addTaskToFollowedUpSection(env, {
    identityKey,
    identityKeys,
    name: finalStudentName,
    phone: taskRef.phone,
    tab: taskRef.tab,
    rowNum: taskRef.rowNum,
    previousStatus: taskRef.previousStatus || "ثبت نشده",
    outcome: finalStatusLabel,
    followNumber: updatedFollowNumber,
    logNote,
    requeueSameDay,
    timeDisplay,
    dateDisplay
  });

  await appendPersonalDailyWorkLog(env, {
    token: taskRef.token || taskRefKey,
    identityKey,
    identityKeys,
    name: finalStudentName,
    phone: taskRef.phone,
    tab: taskRef.tab,
    rowNum: taskRef.rowNum,
    previousStatus: taskRef.previousStatus || "ثبت نشده",
    newStatus: finalStatusLabel,
    followNumber: updatedFollowNumber,
    timeDisplay,
    logNote
  });

  if (taskRef._bundleId && !requeueSameDay) {
    const rawBundle = await dbGet(env, `tasks_bundle:${taskRef._bundleId}`);
    if (rawBundle) {
      const bundle = JSON.parse(rawBundle);
      const normTargetPhone = normalizePhoneKey(taskRef.phone);
      const updatedTasks = (bundle.tasks || []).filter((item) => {
        if (item.token && taskRef.token && item.token === taskRef.token) return false;
        if (normTargetPhone && normalizePhoneKey(item.phone) === normTargetPhone) return false;
        return true;
      });

      const reindexed = updatedTasks.map((tItem, i) => ({ ...tItem, idx: i }));
      await dbPut(
        env,
        `tasks_bundle:${taskRef._bundleId}`,
        JSON.stringify({
          headerInfo: bundle.headerInfo || "",
          tasks: reindexed
        }),
        { expirationTtl: 86400 }
      );

      if (messageId) {
        const batchIndex = Math.floor((taskRef._taskIndex || 0) / TASKS_PER_SINGLE_MESSAGE);
        const startIdx = batchIndex * TASKS_PER_SINGLE_MESSAGE;
        const remainingInBatch = reindexed.slice(startIdx, startIdx + TASKS_PER_SINGLE_MESSAGE);
        const totalBatches = Math.max(1, Math.ceil(reindexed.length / TASKS_PER_SINGLE_MESSAGE));
        const isLastBatch = batchIndex >= totalBatches - 1;

        if (remainingInBatch.length > 0) {
          const updatedMsgText = buildBatchTasksText(
            remainingInBatch,
            Math.min(batchIndex, totalBatches - 1),
            totalBatches,
            bundle.headerInfo || ""
          );
          const updatedKeyboard = buildBatchTasksKeyboard(
            remainingInBatch,
            Math.min(batchIndex, totalBatches - 1),
            isLastBatch,
            taskRef._bundleId
          );
          await updateTelegramReply(env.BOT_TOKEN, chatId, messageId, updatedMsgText, updatedKeyboard);
        } else {
          await updateTelegramReply(
            env.BOT_TOKEN,
            chatId,
            messageId,
            `✨ تسک‌های این بخش پیگیری و به *«✅ پیگیری شده‌ها»* منتقل شدند.`,
            {
              inline_keyboard: [
                [
                  { text: "✅ پیگیری شده‌ها", callback_data: "panel:followed_up" },
                  { text: "📋 همه تسک‌ها", callback_data: "panel:tasks" }
                ],
                [{ text: "🎛 پنل اصلی", callback_data: "panel:refresh" }]
              ]
            }
          );
        }
      }
    }
  }

  const formattedContactName = formatContactFullName(finalStudentName);
  const vcardContent = buildVCardString(
    finalStudentName,
    taskRef.phone,
    `${finalStatusLabel} | ${logNote}`
  );
  const safeFileName = `${formattedContactName.replace(/[^\w\u0600-\u06FF\s-]/g, "").trim() || "contact"}.vcf`;

  await sendTelegramMessage(
    env.BOT_TOKEN,
    chatId,
    `✅ *${escapeTelegramMarkdown(finalStudentName)}* با موفقیت ثبت شد.\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `📌 *وضعیت:* *${chosen.label}*  •  🔁 *${updatedFollowNumber} بار*\n` +
      (requeueSameDay
        ? `⏰ *لیست تسک:* به دلیل ذکر تماس مجدد امروز، باقی ماند.\n`
        : `🗂 *لیست تسک:* از تسک‌ها خارج و به پیگیری‌شده‌ها منتقل شد.\n`) +
      `📝 \`${escapeTelegramMarkdown(logNote)}\`\n` +
      `📊 *گوگل‌شیت:* ${sheetWriteStatus}`,
    {
      inline_keyboard: [
        [
          { text: "✅ پیگیری شده‌ها", callback_data: "panel:followed_up" },
          { text: "📊 گزارش روزانه", callback_data: "panel:daily_report" }
        ]
      ]
    }
  );

  if (extraInput.nameWasUpdatedByUser && taskRef.phone) {
    await sendTelegramDocumentBytes(
      env.BOT_TOKEN,
      chatId,
      new TextEncoder().encode(vcardContent),
      safeFileName,
      "text/vcard",
      `📇 *مخاطب آماده ذخیره:* \`${escapeTelegramMarkdown(formattedContactName)}\``
    );
  }
}

async function writeFollowUpUpdatesToSheet(env, taskRef, payload, ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  let descColLetter = taskRef.descColLetter;
  let followColLetter = taskRef.followColLetter;
  let nameColLetter = taskRef.nameColLetter;
  let entryDateColLetter = taskRef.entryDateColLetter;
  let rowSerialColLetter = taskRef.rowSerialColLetter;
  let weekdayColLetter = taskRef.weekdayColLetter;
  let statusColLetter = taskRef.statusColLetter;
  let existingDesc = taskRef.description || "";

  const { tabsData } = await fetchAllSheetRows(env, ws);
  const targetTab = tabsData.find((t) => normalizeHeaderTitle(t.tab) === normalizeHeaderTitle(taskRef.tab));
  if (targetTab) {
    const descIdx = targetTab.colMap?.description ?? -1;
    if (descIdx !== -1) descColLetter = columnIndexToLetter(descIdx);

    const followIdx = targetTab.colMap?.followCount ?? -1;
    if (followIdx !== -1) followColLetter = columnIndexToLetter(followIdx);

    const nameIdx = targetTab.colMap?.name ?? -1;
    if (nameIdx !== -1) nameColLetter = columnIndexToLetter(nameIdx);

    const entryDateIdx = targetTab.colMap?.entryDate ?? -1;
    if (entryDateIdx !== -1) entryDateColLetter = columnIndexToLetter(entryDateIdx);

    const rowSerialIdx = targetTab.colMap?.rowSerial ?? -1;
    if (rowSerialIdx !== -1) rowSerialColLetter = columnIndexToLetter(rowSerialIdx);

    const weekdayIdx = targetTab.colMap?.weekday ?? -1;
    if (weekdayIdx !== -1) weekdayColLetter = columnIndexToLetter(weekdayIdx);

    const statusIdx = targetTab.colMap?.status ?? -1;
    if (statusIdx !== -1) statusColLetter = columnIndexToLetter(statusIdx);

    const matchedRow = targetTab.rows.find((r) => r.rowNum === taskRef.rowNum);
    if (matchedRow) {
      existingDesc = matchedRow.fields.description || "";
    }
  }

  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const updatesToApply = [];
  const preset = payload.presetValues || {};

  if (entryDateColLetter && isValidGregorianDateValue(preset.entryDate)) {
    updatesToApply.push({
      range: `${taskRef.tab}!${entryDateColLetter}${taskRef.rowNum}`,
      values: [[toEnglishDigits(String(preset.entryDate)).trim()]]
    });
  }

  if (rowSerialColLetter && preset.rowSerial) {
    updatesToApply.push({
      range: `${taskRef.tab}!${rowSerialColLetter}${taskRef.rowNum}`,
      values: [[preset.rowSerial]]
    });
  }

  if (weekdayColLetter && preset.weekday) {
    updatesToApply.push({
      range: `${taskRef.tab}!${weekdayColLetter}${taskRef.rowNum}`,
      values: [[preset.weekday]]
    });
  }

  if (statusColLetter && preset.status) {
    const cleanStatus = canonicalizeOutcomeLabel(preset.status) || preset.status;
    updatesToApply.push({
      range: `${taskRef.tab}!${statusColLetter}${taskRef.rowNum}`,
      values: [[cleanStatus]]
    });
  }

  if (descColLetter) {
    const combinedDesc = existingDesc ? `${existingDesc} ${payload.logNote}` : payload.logNote;
    updatesToApply.push({
      range: `${taskRef.tab}!${descColLetter}${taskRef.rowNum}`,
      values: [[combinedDesc]]
    });
  }

  if (followColLetter && typeof payload.nextFollowCount === "number") {
    const formattedFollowValue = `${payload.nextFollowCount} بار`;
    updatesToApply.push({
      range: `${taskRef.tab}!${followColLetter}${taskRef.rowNum}`,
      values: [[formattedFollowValue]]
    });
  }

  if (nameColLetter && payload.studentName) {
    updatesToApply.push({
      range: `${taskRef.tab}!${nameColLetter}${taskRef.rowNum}`,
      values: [[payload.studentName]]
    });
  }

  if (updatesToApply.length === 0) {
    throw new Error("ستون‌های مناسب در این تب پیدا نشدند.");
  }

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: updatesToApply
      })
    }
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || "عدم دسترسی نوشتن در گوگل‌شیت");
  }
}

async function executeSheetAnalysisWorkflow(env, chatId, jobId, targetTabFilter = "", ws = null) {
  await sendTelegramMessage(
    env.BOT_TOKEN,
    chatId,
    targetTabFilter
      ? `🧠 در حال تحلیل متنی تب «${targetTabFilter}»...`
      : "🧠 در حال تحلیل متنی تمام تب‌های شیت..."
  );

  const result = await generateTextSheetAnalysis(env, chatId, jobId, targetTabFilter, ws);
  await throwIfJobStopped(env, chatId, jobId);

  await sendLongTelegramMessages(env.BOT_TOKEN, chatId, result.reportText, {
    inline_keyboard: [[{ text: "🎛 بازگشت به پنل شیشه‌ای", callback_data: "panel:refresh" }]]
  });
}

async function generateTextSheetAnalysis(env, chatId = null, jobId = null, targetTabFilter = "", ws = null) {
  await throwIfJobStopped(env, chatId, jobId);
  const { tabsData } = await fetchAllSheetRows(env, ws);
  await throwIfJobStopped(env, chatId, jobId);

  const filteredTabs = targetTabFilter
    ? tabsData.filter((t) => t.tab.includes(targetTabFilter))
    : tabsData;

  if (filteredTabs.length === 0) {
    return {
      reportText: `⚠️ تب «${targetTabFilter}» در شیت پیدا نشد.`,
      modelUsed: "none"
    };
  }

  const studentProfiles = [];
  for (const tabInfo of filteredTabs) {
    for (const r of tabInfo.rows) {
      const gon = extractGoalObstacleNeedFromFields(r.fields);
      const hasAnalysisFields = Boolean(
        gon.summaryText || r.fields.objection || r.fields.description || (r.messengers && r.messengers.length > 0)
      );
      if (!hasAnalysisFields && !r.fields.name && !r.phone) continue;

      studentProfiles.push({
        id: `${tabInfo.tab}::${r.rowNum}`,
        tab: tabInfo.tab,
        row: r.rowNum,
        label: r.fields.name || r.phone || `ردیف ${r.rowNum}`,
        previousStatus: String(r.fields.status || "").trim() || "ثبت نشده",
        messengers: r.messengers || [],
        goal: gon.goal,
        obstacle: gon.obstacle,
        need: gon.need,
        objection: r.fields.objection || "",
        description: r.fields.description || ""
      });
    }
  }

  const actionableProfiles = studentProfiles.filter(
    (p) => p.goal || p.obstacle || p.need || p.objection || p.description || (p.messengers && p.messengers.length > 0)
  );

  if (actionableProfiles.length === 0) {
    return {
      reportText:
        `📊 *گزارش تجزیه و تحلیل شیت*\n\n` +
        `🔹 تعداد کل ردیف‌های بررسی‌شده: *${studentProfiles.length}* مورد\n` +
        `🔸 در ستون‌های تحلیلی هنوز یادداشتی ثبت نشده است.`,
      modelUsed: "local"
    };
  }

  let modelUsed = "none";
  const deadKeys = new Set();
  const analyzedItems = [];
  const commonGoals = new Set();
  const commonObstacles = new Set();
  const commonNeeds = new Set();
  const commonObjections = new Set();

  for (let i = 0; i < actionableProfiles.length; i += AI_CHUNK_SIZE) {
    await throwIfJobStopped(env, chatId, jobId);
    if (i > 0) await sleep(1200);
    await throwIfJobStopped(env, chatId, jobId);

    const chunk = actionableProfiles.slice(i, i + AI_CHUNK_SIZE);
    const systemPrompt =
      "تو یک تحلیل‌گر دقیق داده‌های آموزشی هستی. فقط و فقط بر اساس فیلدهای هدف، مانع، نیاز، آبجکشن و توضیحات در هر دانشجو تحلیل بنویس:\n" +
      "قوانین قطعی:\n" +
      "1. هیچ پیشنهاد ویرایشی یا اصلاحی برای نام، تاریخ، نوع لیست، روز هفته، وضعیت، تعداد پیگیری یا تایپ نده.\n" +
      "2. هدف، مانع و نیاز هر فرد را به صورت مجزا استخراج و خلاصه کن.\n" +
      "3. خروجی را صرفاً به صورت JSON معتبر برگردان:\n" +
      `{
        "students": [
          {
            "id": "...",
            "goal": "هدف دانشجو",
            "obstacle": "مانع دانشجو",
            "need": "نیاز دانشجو",
            "objection_summary": "آبجکشن‌های دانشجو",
            "description_summary": "خلاصه توضیحات دانشجو"
          }
        ],
        "top_goals": ["..."],
        "top_obstacles": ["..."],
        "top_needs": ["..."],
        "top_objections": ["..."]
      }`;

    const aiRes = await callAiTextWithFallback(
      env,
      systemPrompt,
      JSON.stringify(chunk),
      { chatId, jobId },
      deadKeys
    );
    await throwIfJobStopped(env, chatId, jobId);
    modelUsed = aiRes.model;

    let parsed;
    try {
      parsed = JSON.parse(extractJsonBlock(aiRes.text));
    } catch {
      continue;
    }

    (parsed.top_goals || []).forEach((g) => g && commonGoals.add(String(g).trim()));
    (parsed.top_obstacles || []).forEach((o) => o && commonObstacles.add(String(o).trim()));
    (parsed.top_needs || []).forEach((n) => n && commonNeeds.add(String(n).trim()));
    (parsed.top_objections || []).forEach((obj) => obj && commonObjections.add(String(obj).trim()));

    if (Array.isArray(parsed.students)) {
      for (const st of parsed.students) {
        const orig = chunk.find((c) => c.id === st.id);
        if (!orig) continue;
        analyzedItems.push({
          tab: orig.tab,
          row: orig.row,
          label: orig.label,
          previousStatus: orig.previousStatus,
          messengers: orig.messengers || [],
          goal: (st.goal || orig.goal || "").trim(),
          obstacle: (st.obstacle || orig.obstacle || "").trim(),
          need: (st.need || orig.need || "").trim(),
          objection: (st.objection_summary || orig.objection || "—").trim(),
          desc: (st.description_summary || orig.description || "—").trim()
        });
      }
    }
  }

  const today = getTehranDateDisplay();
  let text =
    `🧠 *گـزارش تـحـلـیـل مـتـنـی شـیـت (${today})*\n` +
    `⚙️ \`${modelUsed}\`  •  📌 *${analyzedItems.length}* نفر\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`;

  if (commonGoals.size > 0 || commonObstacles.size > 0 || commonNeeds.size > 0 || commonObjections.size > 0) {
    text += `🔎 *الگوهای پرتکرار شیت:*\n`;
    if (commonGoals.size > 0) text += `▸ 🎯 *اهداف:* ${Array.from(commonGoals).slice(0, 6).join(" ، ")}\n`;
    if (commonObstacles.size > 0) text += `▸ 🚧 *موانع:* ${Array.from(commonObstacles).slice(0, 6).join(" ، ")}\n`;
    if (commonNeeds.size > 0) text += `▸ 🧩 *نیازها:* ${Array.from(commonNeeds).slice(0, 6).join(" ، ")}\n`;
    if (commonObjections.size > 0) text += `▸ 🛡 *آبجکشن‌ها:* ${Array.from(commonObjections).slice(0, 6).join(" ، ")}\n\n`;
    text += `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`;
  }

  for (const item of analyzedItems) {
    const msgLine = item.messengers && item.messengers.length > 0
      ? `▸ 💬 *پیام‌رسان:* ${escapeTelegramMarkdown(item.messengers.join(" ، "))}\n`
      : "";
    text +=
      `👤 *${escapeTelegramMarkdown(item.label)}*  •  📂 \`${escapeTelegramMarkdown(item.tab)}\` (ردیف ${item.row})\n` +
      `▸ ⏮ *وضعیت:* ${escapeTelegramMarkdown(item.previousStatus)}\n` +
      msgLine +
      (item.goal ? `▸ 🎯 *هدف:* ${escapeTelegramMarkdown(item.goal)}\n` : "") +
      (item.obstacle ? `▸ 🚧 *مانع:* ${escapeTelegramMarkdown(item.obstacle)}\n` : "") +
      (item.need ? `▸ 🧩 *نیاز:* ${escapeTelegramMarkdown(item.need)}\n` : "") +
      `▸ 🛡 *آبجکشن:* ${escapeTelegramMarkdown(item.objection)}\n` +
      `▸ 📝 *توضیحات:* ${escapeTelegramMarkdown(item.desc)}\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n`;
  }

  return { reportText: text.trim(), modelUsed };
}

async function buildDailyStudentChangesReport(env, autoUpdateBaseline = false, chatId = null, jobId = null, ws = null) {
  await throwIfJobStopped(env, chatId, jobId);
  const { currentMap, totalStudents } = await fetchAllSheetRows(env, ws);
  await throwIfJobStopped(env, chatId, jobId);

  if (!env.DB) {
    return {
      hasBaseline: false,
      text: "⚠️ برای مقایسه تغییرات روزانه، اتصال دیتابیس D1 با نام `DB` را تنظیم کنید."
    };
  }

  const snapKey = ws?.userId ? `STUDENT_SNAPSHOT_V2:${ws.userId}` : "STUDENT_SNAPSHOT_V2";
  const rawPrev = await dbGet(env, snapKey);
  if (!rawPrev) {
    await dbPut(env, snapKey, JSON.stringify(currentMap));
    return {
      hasBaseline: false,
      text:
        `📌 *نقطه مبنای اولیه ثبت شد!*\n\n` +
        `وضعیت فعلی *${totalStudents} دانشجو* در تمام تب‌ها ذخیره شد.`
    };
  }

  const prevMap = JSON.parse(rawPrev);
  const newStudents = [];
  const changedStudents = [];
  let unchangedCount = 0;

  const fieldLabels = {
    goal: "🎯 هدف",
    obstacle: "🚧 مانع",
    need: "🧩 نیاز",
    gonCombined: "🎯 هدف، مانع، نیاز",
    objection: "🛡 آبجکشن",
    description: "📝 توضیحات"
  };

  for (const [key, curr] of Object.entries(currentMap)) {
    const prev = prevMap[key];
    const displayName = `${escapeTelegramMarkdown(curr.fields.name || curr.phone || "مشتری")} [${escapeTelegramMarkdown(curr.tab)}]`;

    if (!prev || !prev.fields) {
      newStudents.push(`🆕 *${displayName}*`);
      continue;
    }

    const diffs = [];
    for (const [fieldKey, label] of Object.entries(fieldLabels)) {
      const oldV = (prev.fields[fieldKey] || "").trim();
      const newV = (curr.fields[fieldKey] || "").trim();
      if (oldV !== newV) {
        diffs.push(`${label}: «${escapeTelegramMarkdown(oldV || "خالی")}» ➔ «${escapeTelegramMarkdown(newV || "خالی")}»`);
      }
    }

    if (diffs.length > 0) {
      changedStudents.push(`🔹 *${displayName}*\n   └ ${diffs.join("\n   └ ")}`);
    } else {
      unchangedCount++;
    }
  }

  if (autoUpdateBaseline) {
    await dbPut(env, snapKey, JSON.stringify(currentMap));
  }

  const today = getTehranDateDisplay();
  let reportText =
    `📈 *گـزارش تـغـیـرات دانـشـجـوهـا (${today})*\n` +
    `• 👥 *کل:* *${totalStudents}*  •  🆕 *جدید:* *${newStudents.length}*  •  🔄 *تغییر:* *${changedStudents.length}*  •  ⏸ *ثابت:* *${unchangedCount}*\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n\n`;

  if (newStudents.length > 0) {
    reportText += `${newStudents.join("\n")}\n\n`;
  }
  if (changedStudents.length > 0) {
    reportText += `${changedStudents.join("\n\n")}`;
  } else if (newStudents.length === 0) {
    reportText += "ℹ️ تغییری نسبت به مبنای قبلی ثبت نشده است.";
  }

  return { hasBaseline: true, text: reportText };
}

async function saveCurrentSheetSnapshot(env, ws = null) {
  const { currentMap, totalStudents } = await fetchAllSheetRows(env, ws);
  if (env.DB) {
    const snapKey = ws?.userId ? `STUDENT_SNAPSHOT_V2:${ws.userId}` : "STUDENT_SNAPSHOT_V2";
    await dbPut(env, snapKey, JSON.stringify(currentMap));
  }
  return totalStudents;
}

async function processVoiceCallAnalysis(env, message, chatId = null, jobId = null) {
  await throwIfJobStopped(env, chatId, jobId);
  const fileObj = message.voice || message.audio || message.document;
  const captionHint = (message.caption || "").trim();

  const fileMetaRes = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileObj.file_id}`
  );
  const fileMeta = await fileMetaRes.json();
  if (!fileMeta.ok) throw new Error("خطا در دریافت فایل صوتی از تلگرام");
  await throwIfJobStopped(env, chatId, jobId);

  const audioRes = await fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileMeta.result.file_path}`
  );
  const audioBuffer = await audioRes.arrayBuffer();
  const mimeType = fileObj.mime_type || "audio/ogg";
  await throwIfJobStopped(env, chatId, jobId);

  const analysisPrompt =
    "این مکالمه تلفنی/صوتی را با دقت بالا تحلیل کن و موارد زیر را به صورت شفاف، دقیق و کاربردی استخراج کن (راهنمای کاربر: «" +
    captionHint +
    "»):\n" +
    "1. contact_name: نام مخاطب اگر ذکر شده است\n" +
    "2. phone: شماره تلفن اگر ذکر شده است\n" +
    "3. personality_and_behavior: تحلیل شخصیت، تیپ ارتباطی و رفتار مخاطب در مکالمه\n" +
    "4. needs_and_motivations: نیازها، دغدغه‌ها و انگیزه‌های اصلی مخاطب\n" +
    "5. mentor_info_provided: اطلاعات، راهنمایی‌ها و پیشنهادهای ارائه‌شده توسط منتور/مشاور به دانشجو\n" +
    "6. objections_and_next_step: آبجکشن‌ها، موانع و اقدام بعدی پیشنهادی\n" +
    "خروجی را دقیقاً به صورت JSON معتبر برگردان:\n" +
    `{
      "contact_name": "...",
      "phone": "...",
      "personality_and_behavior": "...",
      "needs_and_motivations": "...",
      "mentor_info_provided": "...",
      "objections_and_next_step": "..."
    }`;

  const aiOut = await callAiAudioWithFallback(
    env,
    analysisPrompt,
    audioBuffer,
    mimeType,
    { chatId, jobId }
  );
  await throwIfJobStopped(env, chatId, jobId);

  const parsed = JSON.parse(extractJsonBlock(aiOut.text));

  const analysisMessage =
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
    `  🎙 *تـحـلـیـل جـامـع مـکـالـمـه*\n` +
    `✦━━━━━━━━━━━━━━━━━━━━━━✦\n` +
    `⚙️ \`${aiOut.model}\`\n` +
    (parsed.contact_name ? `👤 *مخاطب:* ${escapeTelegramMarkdown(parsed.contact_name)}\n` : "") +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
    `🧠 *شخصیت و رفتار:*\n${escapeTelegramMarkdown(parsed.personality_and_behavior || "—")}\n\n` +
    `🎯 *نیازها و انگیزه‌ها:*\n${escapeTelegramMarkdown(parsed.needs_and_motivations || "—")}\n\n` +
    `🎓 *اطلاعات ارائه‌شده توسط منتور:*\n${escapeTelegramMarkdown(parsed.mentor_info_provided || "—")}\n\n` +
    `🛡 *آبجکشن‌ها و اقدام بعدی:*\n${escapeTelegramMarkdown(parsed.objections_and_next_step || "—")}`;

  const pdfBytes = buildCallAnalysisPdfBytes({
    contactName: parsed.contact_name || captionHint || "Call Analysis",
    phone: parsed.phone || "",
    personalityAndBehavior: parsed.personality_and_behavior || "",
    needsAndMotivations: parsed.needs_and_motivations || "",
    mentorInfoProvided: parsed.mentor_info_provided || "",
    objectionsAndNextStep: parsed.objections_and_next_step || ""
  });

  const pdfFilename = `call-analysis-${Date.now()}.pdf`;

  return { analysisMessage, pdfBytes, pdfFilename };
}

function getGeminiApiKeys(env) {
  const candidates = [
    env.GEMINI_API_KEY_1 || env.GEMINI_API_KEY,
    env.GEMINI_API_KEY_2,
    env.GEMINI_API_KEY_3
  ];
  return [...new Set(candidates.map((k) => (k || "").trim()).filter(Boolean))];
}

function getGroqApiKeys(env) {
  const candidates = [
    env.GROQ_API_KEY,
    env.GROQ_API_KEY_1,
    env.GROQ_API_KEY_2,
    env.GROQ_API_KEY_3
  ];
  return [...new Set(candidates.map((k) => (k || "").trim()).filter(Boolean))];
}

function isDailyQuotaError(errMsg) {
  const lower = errMsg.toLowerCase();
  return (
    lower.includes("per day") ||
    lower.includes("free_tier_requests") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("invalid api key") ||
    lower.includes("no longer available")
  );
}

function isTemporarySpikeError(status, errMsg) {
  const lower = errMsg.toLowerCase();
  return (
    status === 503 ||
    status === 429 ||
    lower.includes("high demand") ||
    lower.includes("overloaded") ||
    lower.includes("per minute") ||
    lower.includes("rate limit")
  );
}

async function callAiTextWithFallback(env, systemPrompt, userPrompt, jobCtx = null, deadKeys = new Set()) {
  const geminiKeys = getGeminiApiKeys(env);
  const groqKeys = getGroqApiKeys(env);

  if (geminiKeys.length === 0 && groqKeys.length === 0) {
    throw new Error("هیچ کلید API برای Gemini یا Groq در کلادفلر تنظیم نشده است.");
  }

  const errors = [];

  if (geminiKeys.length > 0) {
    const models = getGeminiModels(env);
    for (const model of models) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        let sawTemporarySpike = false;

        for (let i = 0; i < geminiKeys.length; i++) {
          const keyTag = `gemini::${model}::${i}`;
          if (deadKeys.has(keyTag)) continue;

          if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
          const apiKey = geminiKeys[i];

          try {
            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  systemInstruction: { parts: [{ text: systemPrompt }] },
                  contents: [{ role: "user", parts: [{ text: userPrompt }] }],
                  generationConfig: {
                    temperature: 0.2,
                    responseMimeType: "application/json"
                  }
                })
              }
            );
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (res.ok && text) {
              return { model: `${model} (کلید ${i + 1})`, text };
            }
            const errMsg = data.error?.message || String(res.status);
            if (isDailyQuotaError(errMsg)) {
              deadKeys.add(keyTag);
              errors.push(`[Gemini ${model} | کلید ${i + 1}]: ${errMsg}`);
            } else if (isTemporarySpikeError(res.status, errMsg)) {
              sawTemporarySpike = true;
              errors.push(`[Gemini ${model} | کلید ${i + 1}]: شلوغی موقت سرور.`);
            } else {
              errors.push(`[Gemini ${model} | کلید ${i + 1}]: ${errMsg}`);
            }
          } catch (e) {
            if (e.message === "USER_ABORTED") throw e;
            errors.push(`[Gemini ${model} | کلید ${i + 1}]: ${e.message}`);
          }
        }

        if (sawTemporarySpike && attempt < 2) {
          if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
          await sleep(2500);
        } else {
          break;
        }
      }
    }
  }

  if (groqKeys.length > 0) {
    try {
      return await callGroqText(env, systemPrompt, userPrompt, jobCtx, deadKeys);
    } catch (groqErr) {
      if (groqErr.message === "USER_ABORTED") throw groqErr;
      errors.push(groqErr.message);
    }
  }

  throw new Error(`خطا در ارتباط با هوش مصنوعی (Gemini و Groq):\n${errors.slice(-4).join("\n")}`);
}

async function callGroqText(env, systemPrompt, userPrompt, jobCtx = null, deadKeys = new Set()) {
  const groqKeys = getGroqApiKeys(env);
  const models = getGroqTextModels(env);
  const errors = [];

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let sawRateLimit = false;

      for (let i = 0; i < groqKeys.length; i++) {
        const keyTag = `groq::${model}::${i}`;
        if (deadKeys.has(keyTag)) continue;

        if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
        const apiKey = groqKeys[i];

        try {
          const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
              ],
              temperature: 0.2,
              response_format: { type: "json_object" }
            })
          });

          const data = await res.json();
          const text = data.choices?.[0]?.message?.content;
          if (res.ok && text) {
            return { model: `Groq ${model} (کلید ${i + 1})`, text };
          }

          const errMsg = data.error?.message || String(res.status);
          if (res.status === 401 || errMsg.toLowerCase().includes("invalid api key")) {
            deadKeys.add(keyTag);
            errors.push(`[Groq کلید ${i + 1}]: کلید نامعتبر است.`);
          } else if (errMsg.toLowerCase().includes("does not exist") || errMsg.toLowerCase().includes("decommissioned")) {
            deadKeys.add(keyTag);
            errors.push(`[Groq ${model}]: مدل در دسترس نیست.`);
          } else if (errMsg.toLowerCase().includes("request too large") || errMsg.toLowerCase().includes("tokens per minute")) {
            sawRateLimit = true;
            errors.push(`[Groq ${model} | کلید ${i + 1}]: حجم درخواست از سقف توکن در دقیقه بیشتر است.`);
          } else if (res.status === 429 || errMsg.toLowerCase().includes("rate limit")) {
            sawRateLimit = true;
            errors.push(`[Groq ${model} | کلید ${i + 1}]: محدودیت موقت نرخ درخواست.`);
          } else {
            errors.push(`[Groq ${model} | کلید ${i + 1}]: ${errMsg}`);
          }
        } catch (e) {
          if (e.message === "USER_ABORTED") throw e;
          errors.push(`[Groq ${model} | کلید ${i + 1}]: ${e.message}`);
        }
      }

      if (sawRateLimit && attempt < 2) {
        if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
        await sleep(3000);
      } else {
        break;
      }
    }
  }

  throw new Error(errors.join("\n") || "خطا در ارتباط با Groq");
}

async function callAiAudioWithFallback(env, prompt, audioBuffer, mimeType, jobCtx = null) {
  const geminiKeys = getGeminiApiKeys(env);
  const groqKeys = getGroqApiKeys(env);

  if (geminiKeys.length === 0 && groqKeys.length === 0) {
    throw new Error("هیچ کلید API برای Gemini یا Groq در کلادفلر تنظیم نشده است.");
  }

  const errors = [];

  if (geminiKeys.length > 0) {
    const bytes = new Uint8Array(audioBuffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const base64Audio = btoa(binary);

    const models = getGeminiModels(env);
    const deadKeys = new Set();

    for (const model of models) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        let sawTemporarySpike = false;

        for (let i = 0; i < geminiKeys.length; i++) {
          const keyTag = `gemini::${model}::${i}`;
          if (deadKeys.has(keyTag)) continue;

          if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
          const apiKey = geminiKeys[i];

          try {
            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [
                    {
                      role: "user",
                      parts: [
                        { text: prompt },
                        { inlineData: { mimeType, data: base64Audio } }
                      ]
                    }
                  ],
                  generationConfig: {
                    temperature: 0.2,
                    responseMimeType: "application/json"
                  }
                })
              }
            );
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (res.ok && text) {
              return { model: `${model} Audio (کلید ${i + 1})`, text };
            }
            const errMsg = data.error?.message || String(res.status);
            if (isDailyQuotaError(errMsg)) {
              deadKeys.add(keyTag);
              errors.push(`[Gemini Audio ${model} | کلید ${i + 1}]: ${errMsg}`);
            } else if (isTemporarySpikeError(res.status, errMsg)) {
              sawTemporarySpike = true;
              errors.push(`[Gemini Audio ${model} | کلید ${i + 1}]: شلوغی موقت.`);
            } else {
              errors.push(`[Gemini Audio ${model} | کلید ${i + 1}]: ${errMsg}`);
            }
          } catch (e) {
            if (e.message === "USER_ABORTED") throw e;
            errors.push(`[Gemini Audio ${model} | کلید ${i + 1}]: ${e.message}`);
          }
        }

        if (sawTemporarySpike && attempt < 2) {
          if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
          await sleep(2500);
        } else {
          break;
        }
      }
    }
  }

  if (groqKeys.length > 0) {
    try {
      return await callGroqAudioPipeline(env, prompt, audioBuffer, mimeType, jobCtx);
    } catch (groqErr) {
      if (groqErr.message === "USER_ABORTED") throw groqErr;
      errors.push(groqErr.message);
    }
  }

  throw new Error(`خطا در تحلیل صوتی (Gemini و Groq):\n${errors.slice(-4).join("\n")}`);
}

async function callGroqAudioPipeline(env, analysisPrompt, audioBuffer, mimeType, jobCtx = null) {
  const groqKeys = getGroqApiKeys(env);
  const whisperModel = getGroqAudioModel(env);
  const ext = mimeType.includes("mp3") || mimeType.includes("mpeg")
    ? "mp3"
    : mimeType.includes("mp4") || mimeType.includes("m4a")
      ? "m4a"
      : mimeType.includes("wav")
        ? "wav"
        : "ogg";

  let transcriptText = "";
  let usedKeyIdx = 0;

  for (let i = 0; i < groqKeys.length; i++) {
    if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: mimeType }), `call.${ext}`);
    form.append("model", whisperModel);
    form.append("language", "fa");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKeys[i]}` },
      body: form
    });
    const data = await res.json();
    if (res.ok && data.text) {
      transcriptText = data.text;
      usedKeyIdx = i + 1;
      break;
    }
  }

  if (!transcriptText) {
    throw new Error("[Groq Whisper]: تبدیل فایل صوتی به متن ناموفق بود.");
  }

  if (jobCtx) await throwIfJobStopped(env, jobCtx.chatId, jobCtx.jobId);
  const llmResult = await callGroqText(
    env,
    analysisPrompt,
    `متن کامل مکالمه پیاده‌سازی‌شده:\n${transcriptText}`,
    jobCtx
  );

  return {
    model: `Groq Whisper (کلید ${usedKeyIdx}) + ${llmResult.model}`,
    text: llmResult.text
  };
}

async function fetchAllSheetTabs(env, ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = await metaRes.json();
  if (!meta.sheets) throw new Error("دسترسی به شیت برقرار نشد.");

  const ignored = env.IGNORED_TABS
    ? env.IGNORED_TABS.split(",").map((t) => t.trim())
    : DEFAULT_IGNORED_TABS;

  return meta.sheets
    .map((s) => s.properties.title)
    .filter((t) => !ignored.includes(t));
}

async function fetchAllSheetRows(env, ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = await metaRes.json();
  if (!meta.sheets) throw new Error("دسترسی به شیت برقرار نشد.");

  const ignored = env.IGNORED_TABS
    ? env.IGNORED_TABS.split(",").map((t) => t.trim())
    : DEFAULT_IGNORED_TABS;

  const allTabs = meta.sheets
    .map((s) => s.properties.title)
    .filter((t) => !ignored.includes(t));

  if (allTabs.length === 0) {
    return { tabsData: [], currentMap: {}, totalStudents: 0 };
  }

  const rangesParam = allTabs
    .map((t) => `ranges=${encodeURIComponent(`${t}!A1:AZ2000`)}`)
    .join("&");

  const batchRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${rangesParam}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const batchData = await batchRes.json();
  if (!batchData.valueRanges) {
    throw new Error(batchData.error?.message || "خطا در خواندن اطلاعات تب‌های شیت");
  }

  const strikeMapByTab = {};
  try {
    const gridRanges = allTabs
      .map((t) => `ranges=${encodeURIComponent(`${t}!A1:AZ2000`)}`)
      .join("&");
    const gridRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?includeGridData=true&fields=sheets(properties.title,data.rowData.values.userEnteredFormat.textFormat.strikethrough,data.rowData.values.effectiveFormat.textFormat.strikethrough)&${gridRanges}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (gridRes.ok) {
      const gridJson = await gridRes.json();
      for (const sh of gridJson.sheets || []) {
        const shTitle = sh.properties?.title || "";
        const strikeRows = [];
        for (const gd of sh.data || []) {
          for (const rd of gd.rowData || []) {
            const cellFlags = (rd.values || []).map((v) =>
              Boolean(
                v?.userEnteredFormat?.textFormat?.strikethrough ||
                  v?.effectiveFormat?.textFormat?.strikethrough
              )
            );
            strikeRows.push(cellFlags);
          }
        }
        strikeMapByTab[shTitle] = strikeRows;
      }
    }
  } catch {
    // در صورت خطای جزئی در gridData، بررسی متنی استرایک‌ترو همچنان فعال می‌ماند
  }

  const tabsData = [];
  const currentMap = {};
  let totalStudents = 0;

  for (let tIdx = 0; tIdx < allTabs.length; tIdx++) {
    const tab = allTabs[tIdx];
    const rows = batchData.valueRanges[tIdx]?.values || [];
    if (rows.length === 0) {
      tabsData.push({ tab, rows: [] });
      continue;
    }

    const headerIdx = detectHeaderRowIndex(rows);
    const headers = rows[headerIdx] || [];
    const colMap = resolveDynamicColumnMap(headers);
    const strikeRows = strikeMapByTab[tab] || [];

    const getCellByRole = (rowArr, role) => {
      const idx = colMap[role];
      return idx !== -1 ? String(rowArr[idx] || "").trim() : "";
    };

    const parsedRows = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const phone = getCellByRole(r, "phone");
      const name = getCellByRole(r, "name");
      if (!phone && !name) continue;

      const nameColIndex = colMap.name;
      const isNameStruck =
        nameColIndex !== -1 && Array.isArray(strikeRows[i])
          ? Boolean(strikeRows[i][nameColIndex])
          : false;

      const fields = {
        entryDate: getCellByRole(r, "entryDate"),
        rowSerial: getCellByRole(r, "rowSerial"),
        weekday: getCellByRole(r, "weekday"),
        phone,
        name,
        status: getCellByRole(r, "status"),
        followCount: getCellByRole(r, "followCount"),
        goal: getCellByRole(r, "goal"),
        obstacle: getCellByRole(r, "obstacle"),
        need: getCellByRole(r, "need"),
        gonCombined: getCellByRole(r, "gonCombined"),
        objection: getCellByRole(r, "objection"),
        description: getCellByRole(r, "description")
      };

      const messengers = extractActiveMessengersByHeaders(r, colMap);

      const rowObj = {
        rowNum: i + 1,
        phone,
        rawRow: r,
        fields,
        messengers,
        isNameStruck
      };
      parsedRows.push(rowObj);

      const normPhone = normalizePhoneKey(phone);
      const uniqueKey = `${tab}::${normPhone || `row_${i + 1}`}`;
      currentMap[uniqueKey] = { tab, phone, fields, messengers, isNameStruck };
      totalStudents++;
    }

    tabsData.push({ tab, headers, colMap, rows: parsedRows });
  }

  return { tabsData, currentMap, totalStudents };
}

function extractJsonBlock(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

function toEnglishDigits(str) {
  const persian = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  const arabic = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  let out = String(str);
  for (let i = 0; i < 10; i++) {
    out = out.replaceAll(persian[i], String(i)).replaceAll(arabic[i], String(i));
  }
  return out;
}

async function getGoogleAccessToken(serviceAccountJson) {
  if (!serviceAccountJson) throw new Error("متغیر GOOGLE_SERVICE_ACCOUNT_JSON تنظیم نشده است.");
  const sa = JSON.parse(serviceAccountJson);
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const encodeBase64Url = (obj) => {
    const str = typeof obj === "string" ? obj : JSON.stringify(obj);
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  const unsignedToken = `${encodeBase64Url(header)}.${encodeBase64Url(claimSet)}`;
  const pemContents = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) binaryDer[i] = binaryDerString.charCodeAt(i);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const sigBytes = new Uint8Array(signature);
  let sigBinary = "";
  for (let i = 0; i < sigBytes.length; i++) sigBinary += String.fromCharCode(sigBytes[i]);
  const encodedSig = btoa(sigBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${unsignedToken}.${encodedSig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("خطای احراز هویت گوگل");
  return tokenData.access_token;
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

  if (!res.ok || !data || data.ok !== true) {
    const plainPayload = { chat_id: chatId, text: safeText };
    if (replyMarkup) plainPayload.reply_markup = replyMarkup;
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plainPayload)
    });
    data = await res.json().catch(() => null);
  }

  if (!res.ok || !data || data.ok !== true) {
    throw new Error(`ارسال پیام تلگرام ناموفق بود: ${data?.description || `HTTP ${res.status}`}`);
  }

  return data.result;
}

async function sendTelegramDocumentBytes(token, chatId, bytes, filename, mimeType, caption = "") {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([bytes], { type: mimeType }), filename);
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "Markdown");
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok !== true) {
    throw new Error(`ارسال فایل به تلگرام ناموفق بود: ${data?.description || `HTTP ${res.status}`}`);
  }
  return data.result;
}

async function sendLongTelegramMessages(token, chatId, fullText, lastReplyMarkup = null) {
  const maxLen = 3800;
  if (fullText.length <= maxLen) {
    await sendTelegramMessage(token, chatId, fullText, lastReplyMarkup);
    return;
  }

  const parts = [];
  let remaining = fullText;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < 500) splitIdx = maxLen;
    parts.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining) parts.push(remaining);

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    await sendTelegramMessage(token, chatId, parts[i], isLast ? lastReplyMarkup : null);
  }
}

async function tryEditTelegramMessage(token, chatId, messageId, text, replyMarkup = null) {
  if (!messageId) return false;

  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" };
  if (replyMarkup) body.reply_markup = replyMarkup;

  let res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = await res.json().catch(() => null);
  if (res.ok && data?.ok === true) return true;

  const plainBody = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) plainBody.reply_markup = replyMarkup;
  res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plainBody)
  });
  data = await res.json().catch(() => null);

  return Boolean(res.ok && data?.ok === true);
}

async function updateTelegramReply(token, chatId, messageId, text, replyMarkup = null) {
  const edited = await tryEditTelegramMessage(token, chatId, messageId, text, replyMarkup);
  if (!edited) {
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

// Public module API used by src/index.js and src/webApi.js.
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
  fetchAllSheetRows,
  getEffectiveReceiptChannelId,
  callAiImageWithFallback,
  callAiAudioWithFallback,
  extractJsonBlock,
  handleTelegramUpdate,
  sendInteractiveTaskItems,
  buildBeautifulDailyWorkReport,
  buildDailyStudentChangesReport,
  sendLongTelegramMessages,
  sendTelegramMessage,
  ensureTelegramWebhookConfigured
};
