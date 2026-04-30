// ── YoEcho DB Proxy — Netlify Function ───────────────────────────────────────
// Handles all Supabase reads and writes server-side so the keys never reach
// the browser. The frontend calls /.netlify/functions/db with { action, key, value }.
//
// Required Netlify environment variables (set in Site Settings → Environment Variables):
//   SUPABASE_URL       — e.g. https://xxxx.supabase.co
//   SUPABASE_ANON_KEY  — starts with "eyJ..."
//
// Supabase table required (run once in Supabase SQL Editor):
//   create table kv_store (
//     key   text primary key,
//     value jsonb
//   );
//   alter table kv_store enable row level security;
//   create policy "Allow all" on kv_store for all using (true);

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Lightweight fetch wrapper around the Supabase REST API — no SDK needed.
async function sbGet(key) {
  const url = `${SUPABASE_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(key)}&select=value&limit=1`;
  const res = await fetch(url, {
    headers: {
      "apikey":        SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type":  "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
  const rows = await res.json();
  return rows.length ? rows[0].value : null;
}

async function sbSet(key, value) {
  const url = `${SUPABASE_URL}/rest/v1/kv_store`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "apikey":        SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        "resolution=merge-duplicates",  // upsert behaviour
    },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error(`Supabase SET failed: ${res.status}`);
}

exports.handler = async (event) => {
  // Handle CORS pre-flight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Supabase env vars not configured on Netlify." }),
    };
  }

  try {
    const { action, key, value } = JSON.parse(event.body || "{}");

    if (!action || !key) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "action and key are required" }) };
    }

    if (action === "get") {
      const data = await sbGet(key);
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ data }) };
    }

    if (action === "set") {
      await sbSet(key, value ?? null);
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error("[YoEcho db] error:", err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message || "Internal server error" }) };
  }
};
