export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function extractJsonBlock(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

export function getGeminiModels(env) {
  if (env.GEMINI_MODELS) {
    const list = env.GEMINI_MODELS.split(",")
      .map((m) => m.trim())
      .filter((m) => Boolean(m) && m !== "gemini-2.5-flash-lite");
    if (list.length > 0) return list;
  }
  return ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];
}

export function getGroqTextModels(env) {
  if (env.GROQ_TEXT_MODEL) {
    const list = env.GROQ_TEXT_MODEL.split(",").map((m) => m.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  return ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
}

export function getGroqAudioModel(env) {
  return (env.GROQ_AUDIO_MODEL || "whisper-large-v3-turbo").trim();
}

export function getGeminiApiKeys(env) {
  return [...new Set([env.GEMINI_API_KEY_1 || env.GEMINI_API_KEY, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3].map((k) => (k || "").trim()).filter(Boolean))];
}

export function getGroqApiKeys(env) {
  return [...new Set([env.GROQ_API_KEY, env.GROQ_API_KEY_1, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3].map((k) => (k || "").trim()).filter(Boolean))];
}

function isDailyQuotaError(errMsg) {
  const lower = errMsg.toLowerCase();
  return lower.includes("per day") || lower.includes("free_tier_requests") || lower.includes("exceeded your current quota") || lower.includes("invalid api key");
}

function isTemporarySpikeError(status, errMsg) {
  const lower = errMsg.toLowerCase();
  return status === 503 || status === 429 || lower.includes("high demand") || lower.includes("overloaded") || lower.includes("rate limit");
}

export async function callAiTextWithFallback(env, systemPrompt, userPrompt, jobCtx = null, deadKeys = new Set(), checkStopFn = null) {
  const geminiKeys = getGeminiApiKeys(env);
  const groqKeys = getGroqApiKeys(env);
  if (geminiKeys.length === 0 && groqKeys.length === 0) throw new Error("هیچ کلید API برای Gemini یا Groq تنظیم نشده است.");

  const errors = [];
  if (geminiKeys.length > 0) {
    for (const model of getGeminiModels(env)) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        let sawSpike = false;
        for (let i = 0; i < geminiKeys.length; i++) {
          const keyTag = `gemini::${model}::${i}`;
          if (deadKeys.has(keyTag)) continue;
          if (jobCtx && checkStopFn) await checkStopFn(env, jobCtx.chatId, jobCtx.jobId);
          try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKeys[i]}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: "user", parts: [{ text: userPrompt }] }],
                generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
              })
            });
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (res.ok && text) return { model: `${model} (کلید ${i + 1})`, text };
            const errMsg = data.error?.message || String(res.status);
            if (isDailyQuotaError(errMsg)) deadKeys.add(keyTag);
            else if (isTemporarySpikeError(res.status, errMsg)) sawSpike = true;
            errors.push(`[${model}]: ${errMsg}`);
          } catch (e) {
            if (e.message === "USER_ABORTED") throw e;
            errors.push(e.message);
          }
        }
        if (sawSpike && attempt < 2) await sleep(2500);
        else break;
      }
    }
  }

  if (groqKeys.length > 0) {
    for (const model of getGroqTextModels(env)) {
      for (let i = 0; i < groqKeys.length; i++) {
        try {
          const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${groqKeys[i]}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
              temperature: 0.2,
              response_format: { type: "json_object" }
            })
          });
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content;
          if (res.ok && text) return { model: `Groq ${model} (کلید ${i + 1})`, text };
        } catch (e) {
          errors.push(e.message);
        }
      }
    }
  }

  throw new Error(`خطا در هوش مصنوعی:\n${errors.slice(-3).join("\n")}`);
}

export async function callAiImageWithFallback(env, prompt, imageBuffer, mimeType) {
  const geminiKeys = getGeminiApiKeys(env);
  if (geminiKeys.length === 0) throw new Error("کلید GEMINI_API_KEY تنظیم نشده است.");

  const bytes = new Uint8Array(imageBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const base64Image = btoa(binary);

  for (const model of getGeminiModels(env)) {
    for (let i = 0; i < geminiKeys.length; i++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKeys[i]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: base64Image } }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
        })
      });
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (res.ok && text) return { model: `${model} Vision (کلید ${i + 1})`, text };
    }
  }
  throw new Error("خواندن تصویر فیش ناموفق بود.");
}

export async function callAiAudioWithFallback(env, prompt, audioBuffer, mimeType) {
  const geminiKeys = getGeminiApiKeys(env);
  const groqKeys = getGroqApiKeys(env);

  if (geminiKeys.length > 0) {
    const bytes = new Uint8Array(audioBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const base64Audio = btoa(binary);

    for (const model of getGeminiModels(env)) {
      for (let i = 0; i < geminiKeys.length; i++) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKeys[i]}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: base64Audio } }] }],
            generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
          })
        });
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (res.ok && text) return { model: `${model} Audio (کلید ${i + 1})`, text };
      }
    }
  }

  if (groqKeys.length > 0) {
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: mimeType }), "call.ogg");
    form.append("model", getGroqAudioModel(env));
    form.append("language", "fa");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKeys[0]}` },
      body: form
    });
    const data = await res.json();
    if (res.ok && data.text) {
      const llmRes = await callAiTextWithFallback(env, prompt, `متن مکالمه:\n${data.text}`);
      return { model: `Groq Whisper + ${llmRes.model}`, text: llmRes.text };
    }
  }

  throw new Error("تحلیل فایل صوتی ناموفق بود.");
}
