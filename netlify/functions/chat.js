// ── YoEcho AI Proxy — Netlify Function ───────────────────────────────────────
// Sits between your frontend and OpenRouter so the API key is NEVER exposed.
// Model: google/gemma-3-27b-it:free (Gemma 3 27B — free on OpenRouter)

exports.handler = async (event) => {
  // Only allow POST requests
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // CORS headers — allow your frontend to call this function
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { messages, system } = JSON.parse(event.body);

    if (!messages || !Array.isArray(messages)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "messages array required" }) };
    }

    // Build the request body for OpenRouter
    // Gemma 3 27B does not support a separate "system" role in the same way,
    // so we inject the system prompt as the first user message if provided.
    const openRouterMessages = system
      ? [
          { role: "user", content: `[System context — follow these instructions for the entire conversation]:\n${system}` },
          { role: "assistant", content: "Understood. I will follow those instructions." },
          ...messages,
        ]
      : messages;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://yoecho.netlify.app", // update to your actual Netlify URL
        "X-Title": "YoEcho",
      },
      body: JSON.stringify({
        model: "google/gemma-3-27b-it:free",
        messages: openRouterMessages,
        max_tokens: 1024,
        temperature: 0.85,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const status = response.status;

      // Pass structured error back to the frontend
      return {
        statusCode: status,
        headers,
        body: JSON.stringify({
          error: errData?.error?.message || `OpenRouter error ${status}`,
          status,
        }),
      };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "I'm here.";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ text }),
    };
  } catch (err) {
    console.error("YoEcho function error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal server error", status: 500 }),
    };
  }
};
