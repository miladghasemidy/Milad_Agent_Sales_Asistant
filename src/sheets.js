export const DEFAULT_IGNORED_TABS = [];

export const MESSENGER_PATTERNS = [
  { name: "تلگرام", keywords: ["تلگرام", "telegram"] },
  { name: "واتساپ", keywords: ["واتساپ", "واتس‌آپ", "whatsapp", "wa"] },
  { name: "ایتا", keywords: ["ایتا", "eitaa"] },
  { name: "روبیکا", keywords: ["روبیکا", "rubika"] },
  { name: "بله", keywords: ["بله", "bale"] },
  { name: "سروش", keywords: ["سروش", "soroush"] },
  { name: "اینستاگرام", keywords: ["اینستاگرام", "دایرکت", "instagram", "ig"] }
];

export const HEADER_ROLE_RULES = [
  { role: "phone", keywords: ["شماره تلفن", "شماره تماس", "شماره همراه", "موبایل", "تلفن", "phone", "mobile", "tel"] },
  { role: "entryDate", keywords: ["تاریخ ورود", "تاریخ ثبت", "تاریخ تماس", "تاریخ پیگیری", "تاریخ", "date"] },
  { role: "weekday", keywords: ["روز هفته", "روز", "weekday", "day"] },
  { role: "name", keywords: ["نام دانشجو", "نام و نام خانوادگی", "نام مشتری", "نام کامل", "دانشجو", "مشتری", "نام", "اسم", "name"] },
  { role: "status", keywords: ["وضعیت تماس", "نتیجه تماس", "وضعیت پیگیری", "وضعیت", "نتیجه", "حالت", "مرحله", "status", "result"] },
  { role: "followCount", keywords: ["تعداد پیگیری", "دفعات پیگیری", "شماره پیگیری", "پیگیری‌ها", "تعداد تماس", "دفعات", "پیگیری", "follow"] },
  { role: "gonCombined", keywords: ["هدف، مانع، نیاز", "هدف مانع نیاز", "هدف و مانع", "دغدغه"] },
  { role: "goal", keywords: ["هدف", "goal"] },
  { role: "obstacle", keywords: ["مانع", "موانع"] },
  { role: "need", keywords: ["نیاز"] },
  { role: "objection", keywords: ["آبجکشن", "ابجکشن", "اعتراض", "بهانه", "مقاومت", "objection"] },
  { role: "description", keywords: ["توضیحات", "توضیح", "یادداشت", "شرح", "کامنت", "نکته", "پانوشت", "description", "note", "comment"] },
  { role: "messengersCol", keywords: ["پیام‌رسان", "پیام رسان", "شبکه اجتماعی", "messenger"] },
  { role: "rowSerial", keywords: ["شماره ردیف", "شماره لیست", "ردیف", "شماره", "کد", "no", "index"] }
];

const CHECKMARK_REGEX = /[✅✔✓☑☒]|^(yes|true|ok|بله|دارد|فعال|تیک|x)$/i;

export function getEffectiveSheetId(env, ws = null) {
  return (ws && ws.sheetId) || env.GOOGLE_SHEET_ID;
}

export function getEffectiveReceiptChannelId(env, ws = null) {
  return (ws && ws.receiptChannelId) || env.RECEIPT_CHANNEL_ID;
}

export function columnIndexToLetter(index) {
  let num = index + 1;
  let letters = "";
  while (num > 0) {
    const rem = (num - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    num = Math.floor((num - 1) / 26);
  }
  return letters;
}

export function normalizeHeaderTitle(title) {
  return String(title || "")
    .trim()
    .replace(/\u200c/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function toEnglishDigits(str) {
  const persian = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  const arabic = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  let out = String(str);
  for (let i = 0; i < 10; i++) {
    out = out.replaceAll(persian[i], String(i)).replaceAll(arabic[i], String(i));
  }
  return out;
}

export function normalizePhoneKey(phone) {
  const raw = toEnglishDigits(String(phone || "")).trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00") && digits.length > 8) {
    const stripped = digits.slice(2);
    return stripped.startsWith("98") && stripped.length === 12 ? "0" + stripped.slice(2) : stripped;
  }
  if (digits.startsWith("98") && digits.length === 12) return "0" + digits.slice(2);
  if (digits.length === 10 && digits.startsWith("9")) return "0" + digits;
  return digits;
}

function isCheckedMark(val) {
  const s = String(val || "").trim();
  if (!s) return false;
  return CHECKMARK_REGEX.test(s) || s.includes("✅") || s.includes("✔") || s.includes("✓") || s.includes("☑");
}

export function resolveDynamicColumnMap(headers = []) {
  const colMap = {
    entryDate: -1, rowSerial: -1, weekday: -1, phone: -1, name: -1, status: -1,
    followCount: -1, goal: -1, obstacle: -1, need: -1, gonCombined: -1,
    objection: -1, description: -1, messengersCol: -1, messengerDedicatedCols: []
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
        if (h === normKw && 100 + normKw.length > bestScore) {
          bestScore = 100 + normKw.length;
          bestIdx = idx;
        } else if (h.includes(normKw) && normKw.length * 2 > bestScore) {
          bestScore = normKw.length * 2;
          bestIdx = idx;
        }
      }
    }
    if (bestIdx !== -1) colMap[rule.role] = bestIdx;
  }
  return colMap;
}

export function detectHeaderRowIndex(rows) {
  let bestRowIdx = 0;
  let bestMatches = -1;
  const limit = Math.min(rows.length, 10);
  for (let rIdx = 0; rIdx < limit; rIdx++) {
    const row = rows[rIdx] || [];
    const map = resolveDynamicColumnMap(row);
    let matches = 0;
    if (map.phone !== -1) matches += 2;
    if (map.name !== -1) matches += 2;
    if (map.status !== -1) matches += 1;
    if (map.followCount !== -1) matches += 1;
    if (map.description !== -1) matches += 1;
    matches += map.messengerDedicatedCols.length;
    if (matches > bestMatches) {
      bestMatches = matches;
      bestRowIdx = rIdx;
    }
  }
  return bestRowIdx;
}

export function extractActiveMessengersByHeaders(rawRow, colMap) {
  const found = new Set();
  for (const mCol of colMap.messengerDedicatedCols) {
    const val = String(rawRow[mCol.index] || "").trim();
    const lowerVal = normalizeHeaderTitle(val);
    if (!val) continue;
    if (
      isCheckedMark(val) ||
      (!lowerVal.includes("ندارد") && !lowerVal.includes("خیر") && !lowerVal.includes("غیرفعال") && lowerVal !== "0" && lowerVal !== "-")
    ) {
      found.add(mCol.name);
    }
  }
  if (colMap.messengersCol !== -1) {
    const cellVal = normalizeHeaderTitle(rawRow[colMap.messengersCol] || "");
    if (cellVal) {
      for (const m of MESSENGER_PATTERNS) {
        if (m.keywords.some((kw) => cellVal.includes(normalizeHeaderTitle(kw))) && !cellVal.includes("ندارد")) {
          found.add(m.name);
        }
      }
    }
  }
  return Array.from(found);
}

export async function getGoogleAccessToken(serviceAccountJson) {
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

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsignedToken));
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

export async function fetchAllSheetTabs(env, ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = await metaRes.json();
  if (!meta.sheets) throw new Error("دسترسی به شیت برقرار نشد.");
  const ignored = env.IGNORED_TABS ? env.IGNORED_TABS.split(",").map((t) => t.trim()) : DEFAULT_IGNORED_TABS;
  return meta.sheets.map((s) => s.properties.title).filter((t) => !ignored.includes(t));
}

export async function fetchAllSheetRows(env, ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const allTabs = await fetchAllSheetTabs(env, ws);
  if (allTabs.length === 0) return { tabsData: [], currentMap: {}, totalStudents: 0 };

  const rangesParam = allTabs.map((t) => `ranges=${encodeURIComponent(`${t}!A1:AZ2000`)}`).join("&");
  const batchRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${rangesParam}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const batchData = await batchRes.json();
  if (!batchData.valueRanges) throw new Error(batchData.error?.message || "خطا در خواندن اطلاعات تب‌های شیت");

  const strikeMapByTab = {};
  try {
    const gridRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?includeGridData=true&fields=sheets(properties.title,data.rowData.values.userEnteredFormat.textFormat.strikethrough,data.rowData.values.effectiveFormat.textFormat.strikethrough)&${rangesParam}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (gridRes.ok) {
      const gridJson = await gridRes.json();
      for (const sh of gridJson.sheets || []) {
        const strikeRows = [];
        for (const gd of sh.data || []) {
          for (const rd of gd.rowData || []) {
            strikeRows.push(
              (rd.values || []).map((v) =>
                Boolean(v?.userEnteredFormat?.textFormat?.strikethrough || v?.effectiveFormat?.textFormat?.strikethrough)
              )
            );
          }
        }
        strikeMapByTab[sh.properties?.title || ""] = strikeRows;
      }
    }
  } catch {}

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
    const getCellByRole = (rowArr, role) => (colMap[role] !== -1 ? String(rowArr[colMap[role]] || "").trim() : "");

    const parsedRows = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const phone = getCellByRole(r, "phone");
      const name = getCellByRole(r, "name");
      if (!phone && !name) continue;

      const isNameStruck =
        colMap.name !== -1 && Array.isArray(strikeRows[i]) ? Boolean(strikeRows[i][colMap.name]) : false;

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
      parsedRows.push({ rowNum: i + 1, phone, rawRow: r, fields, messengers, isNameStruck });

      const normPhone = normalizePhoneKey(phone);
      currentMap[`${tab}::${normPhone || `row_${i + 1}`}`] = { tab, phone, fields, messengers, isNameStruck };
      totalStudents++;
    }
    tabsData.push({ tab, headers, colMap, rows: parsedRows });
  }

  return { tabsData, currentMap, totalStudents };
}

export async function writeSingleCellToSheet(env, tabName, colLetter, rowNum, newValue, ws = null) {
  const sheetId = getEffectiveSheetId(env, ws);
  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const range = `${tabName}!${colLetter}${rowNum}`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range, values: [[newValue]] })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "خطا در ویرایش سلول گوگل‌شیت");
}
