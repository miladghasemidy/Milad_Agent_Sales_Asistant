import {
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
  fillSalesExcelAndCopyOffForStudent
} from "./telegram.js";
import { fetchAllSheetRows, getEffectiveReceiptChannelId } from "./sheets.js";
import { callAiImageWithFallback, callAiAudioWithFallback, extractJsonBlock } from "./ai.js";

function jsonCors(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

export async function handleWebApi(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return jsonCors({ ok: true }, 204);
  }

  try {
    // ۱. ورود به سایت با AUTH_USERS_JSON
    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      const users = parseConfiguredUsers(env);
      const matched = users.find(
        (u) => String(u.username).trim().toLowerCase() === username.toLowerCase() && String(u.password) === password
      );

      if (!matched) {
        return jsonCors({ error: "نام کاربری یا رمز عبور اشتباه است." }, 401);
      }

      await ensureBotStateTable(env);
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS web_sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_json TEXT NOT NULL, created_at INTEGER NOT NULL)"
      ).run();

      const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const ws = {
        userId: matched.userId || `user_${matched.username}`,
        username: matched.username,
        displayName: matched.displayName || matched.username,
        sheetId: matched.sheetId || env.GOOGLE_SHEET_ID || "",
        receiptChannelId: matched.receiptChannelId || env.RECEIPT_CHANNEL_ID || "",
        adminChatId: matched.adminChatId || env.ADMIN_CHAT_ID || ""
      };

      await env.DB.prepare(
        "INSERT INTO web_sessions (token, user_id, workspace_json, created_at) VALUES (?, ?, ?, ?)"
      )
        .bind(token, ws.userId, JSON.stringify(ws), Math.floor(Date.now() / 1000))
        .run();

      return jsonCors({ ok: true, token, displayName: ws.displayName });
    }

    // اعتبارسنجی توکن نشست
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return jsonCors({ error: "توکن احراز هویت ارسال نشده است." }, 401);

    await ensureBotStateTable(env);
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS web_sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_json TEXT NOT NULL, created_at INTEGER NOT NULL)"
    ).run();

    const sessionRow = await env.DB.prepare("SELECT workspace_json FROM web_sessions WHERE token = ?")
      .bind(token)
      .first();
    if (!sessionRow) return jsonCors({ error: "نشست نامعتبر است؛ مجدداً وارد شوید." }, 401);

    const ws = JSON.parse(sessionRow.workspace_json);

    // ۲. دریافت لیست تسک‌ها و پیگیری‌شده‌های امروز
    if (url.pathname === "/api/tasks" && request.method === "GET") {
      const { selected } = await collectTodayTasks(env, "all", ws);
      const bundleId = `web_${Date.now().toString(36)}`;

      const tasks = selected.map((item, idx) => ({
        ...item,
        id: `${bundleId}:${idx}`,
        idx
      }));

      await dbPut(env, `tasks_bundle:${bundleId}`, JSON.stringify({ headerInfo: "Web CRM", tasks }), {
        expirationTtl: 86400
      });

      const dateKey = getTodayTehranKey();
      const rawFollowed = await dbGet(env, `followed_up_list:${dateKey}`);
      const followed = rawFollowed ? JSON.parse(rawFollowed) : [];

      return jsonCors({ ok: true, tasks, followed });
    }

    // ۳. ثبت نتیجه تماس و آپدیت گوگل‌شیت
    if (url.pathname === "/api/tasks/outcome" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { taskId, outcomeKey, studentName, extraDescription } = body;

      const chosen = CALL_OUTCOME_OPTIONS.find((o) => o.key === outcomeKey);
      if (!taskId || !chosen) {
        return jsonCors({ error: "شناسه تسک یا نتیجه تماس نامعتبر است." }, 400);
      }

      const [bundleId, idxStr] = String(taskId).split(":");
      const rawBundle = await dbGet(env, `tasks_bundle:${bundleId}`);
      if (!rawBundle) {
        return jsonCors({ error: "اطلاعات تسک منقضی شده است؛ صفحه را تازه‌سازی کنید." }, 404);
      }

      const bundle = JSON.parse(rawBundle);
      const taskRef = bundle.tasks?.[parseInt(idxStr, 10)];
      if (!taskRef) return jsonCors({ error: "تسک مورد نظر یافت نشد." }, 404);

      const currentNumericFollow = parseNumericFollowCount(taskRef.followCount);
      const updatedFollowNumber = currentNumericFollow !== null ? currentNumericFollow + 1 : 1;
      const finalStudentName = String(studentName || taskRef.name || "بدون نام").trim();
      const timeDisplay = getTehranTimeDisplay();
      const dateDisplay = getTehranDateDisplay();
      const identityKeys = buildTaskIdentityKeys(taskRef.tab, taskRef.rowNum, taskRef.phone);
      const identityKey = taskRef.identityKey || identityKeys[0];
      const logNote = formatFollowUpNoteEntry(chosen.label, extraDescription || "");
      const requeueSameDay = shouldRequeueSameDayFromNote(extraDescription || "");

      const presetValues = await resolvePresetFieldsWithAi(env, {
        outcomeLabel: chosen.label,
        extraDescription: extraDescription || "",
        currentFields: taskRef.currentRowFields || {},
        rowNum: taskRef.rowNum,
        presets: taskRef.tabPresets || {}
      });

      const finalStatusLabel = canonicalizeOutcomeLabel(presetValues.status || chosen.label) || chosen.label;

      await writeFollowUpUpdatesToSheet(
        env,
        taskRef,
        {
          logNote,
          nextFollowCount: updatedFollowNumber,
          studentName: finalStudentName !== taskRef.name ? finalStudentName : "",
          presetValues: { ...presetValues, status: finalStatusLabel }
        },
        ws
      );

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
        token: taskRef.token || taskId,
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

      return jsonCors({ ok: true, status: finalStatusLabel, logNote });
    }

    // ۴. جستجوی پرونده دانشجو در تمام تب‌های شیت
    if (url.pathname === "/api/students/search" && request.method === "GET") {
      const queryText = (url.searchParams.get("q") || "").trim();
      if (!queryText) return jsonCors({ ok: true, matches: [] });

      const q = normalizeHeaderTitle(toEnglishDigits(queryText));
      const qDigits = normalizePhoneKey(queryText);
      const { tabsData } = await fetchAllSheetRows(env, ws);

      const matches = [];
      for (const t of tabsData) {
        for (const r of t.rows) {
          const nameStr = String(r.fields.name || "").trim();
          const phoneStr = String(r.phone || "").trim();
          const normPhone = normalizePhoneKey(phoneStr);
          const tabStr = String(t.tab || "").trim();

          if (
            (q && normalizeHeaderTitle(nameStr).includes(q)) ||
            (qDigits && normPhone.includes(qDigits)) ||
            (q && normalizeHeaderTitle(tabStr).includes(q))
          ) {
            matches.push({
              tab: t.tab,
              rowNum: r.rowNum,
              name: nameStr,
              phone: phoneStr,
              status: r.fields.status || "",
              followCount: parseNumericFollowCount(r.fields.followCount) || 0,
              description: r.fields.description || ""
            });
          }
        }
      }

      return jsonCors({ ok: true, matches: matches.slice(0, 30) });
    }

    // ۵. پردازش تصویر فیش از طریق سایت
    if (url.pathname === "/api/receipt" && request.method === "POST") {
      const formData = await request.formData();
      const file = formData.get("file");
      const captionHint = String(formData.get("caption") || "").trim();
      if (!file) return jsonCors({ error: "فایل تصویر فیش انتخاب نشده است." }, 400);

      const buffer = await file.arrayBuffer();
      const mimeType = file.type || "image/jpeg";
      const receiptPrompt =
        `این تصویر یک فیش واریزی است. اطلاعات را استخراج کن (توضیح کاربر: «${captionHint}») و به صورت JSON برگردان:\n` +
        `{"amount":"","transaction_date":"","transaction_time":"","tracking_code":"","payer_name":"","bank_or_gateway":"","status":"","extra_details":""}`;

      const aiOut = await callAiImageWithFallback(env, receiptPrompt, buffer, mimeType);
      const parsed = JSON.parse(extractJsonBlock(aiOut.text));

      const channelId = getEffectiveReceiptChannelId(env, ws);
      if (channelId && env.BOT_TOKEN) {
        const tgForm = new FormData();
        tgForm.append("chat_id", String(channelId));
        tgForm.append("photo", new Blob([buffer], { type: mimeType }), `receipt-${Date.now()}.jpg`);
        tgForm.append(
          "caption",
          `🧾 فیش ثبت‌شده از پنل وب\n💰 مبلغ: ${parsed.amount || "—"}\n🔢 کد پیگیری: ${parsed.tracking_code || "—"}\n✍️ توضیح: ${captionHint || "—"}`
        );
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: "POST", body: tgForm });
      }

      return jsonCors({ ok: true, data: parsed, model: aiOut.model });
    }

    // ۶. تحلیل فایل صوتی مکالمه از طریق سایت
    if (url.pathname === "/api/voice" && request.method === "POST") {
      const formData = await request.formData();
      const file = formData.get("file");
      const captionHint = String(formData.get("caption") || "").trim();
      if (!file) return jsonCors({ error: "فایل صوتی انتخاب نشده است." }, 400);

      const buffer = await file.arrayBuffer();
      const mimeType = file.type || "audio/ogg";
      const analysisPrompt =
        `این مکالمه فروش را تحلیل کن (راهنمای کاربر: «${captionHint}») و JSON برگردان:\n` +
        `{"contact_name":"","phone":"","personality_and_behavior":"","needs_and_motivations":"","mentor_info_provided":"","objections_and_next_step":""}`;

      const aiOut = await callAiAudioWithFallback(env, analysisPrompt, buffer, mimeType);
      const parsed = JSON.parse(extractJsonBlock(aiOut.text));
      return jsonCors({ ok: true, analysis: parsed, model: aiOut.model });
    }

    return jsonCors({ error: "مسیر API یافت نشد." }, 404);
  } catch (err) {
    return jsonCors({ error: err.message || "خطای داخلی سرور" }, 500);
  }
}
