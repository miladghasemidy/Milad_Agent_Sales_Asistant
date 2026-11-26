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
