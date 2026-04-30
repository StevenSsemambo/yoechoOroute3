// ── YoEcho DB Proxy — Netlify Function ───────────────────────────────────────
// Routes each key-space to its dedicated Supabase table.
// The frontend calls /.netlify/functions/db with { action, key, value }
// using the same interface as before — no changes needed in app.jsx.
//
// Key → Table mapping
// ─────────────────────────────────────────────────────────────────────────────
//  echo:profile:{id}          → profiles          (id, data jsonb)
//  echo:msgs:{id}:{screen}    → chat_messages      (rows per message)
//  echo:chats:{id}            → chats              (rows per chat session)
//  echo:chat:{id}:{chatId}    → chat_messages      (rows per message)
//  echo:anchors:{id}          → anchors            (rows per anchor)
//  echo:relationships:{id}    → relationships      (single jsonb row)
//  echo:lastsession:{id}      → last_session       (single jsonb row)
//  echo:jinsights:{id}        → journal_insights   (rows per insight)
//  echo:beliefhits:{id}       → belief_hits        (single jsonb row)
//  echo:digest:{id}           → kv_store           (fallback — generic)
//
// Required Netlify env vars (Site Settings → Environment Variables):
//   SUPABASE_URL       — e.g. https://xxxx.supabase.co
//   SUPABASE_ANON_KEY  — starts with "eyJ..."
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

console.log("SUPABASE_URL:", SUPABASE_URL)
console.log("SUPABASE_KEY:", SUPABASE_ANON_KEY)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── Low-level Supabase REST helpers ──────────────────────────────────────────

function sbHeaders(extra = {}) {
  return {
    "apikey":        SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type":  "application/json",
    ...extra,
  };
}

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: sbHeaders(opts.headers || {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase ${opts.method || "GET"} /${path} → ${res.status}: ${body}`);
  }
  // 204 No Content (DELETE / upsert with Prefer:return=minimal)
  if (res.status === 204) return null;
  return res.json();
}

// ── Key parser ────────────────────────────────────────────────────────────────
// Returns { type, profileId, ...extras } so each handler knows what to do.
function parseKey(key) {
  // echo:profile:{id}
  let m = key.match(/^echo:profile:(.+)$/);
  if (m) return { type: "profile", profileId: m[1] };

  // echo:msgs:{profileId}:{screen}
  m = key.match(/^echo:msgs:([^:]+):(.+)$/);
  if (m) return { type: "screen_msgs", profileId: m[1], screen: m[2] };

  // echo:chats:{profileId}
  m = key.match(/^echo:chats:(.+)$/);
  if (m) return { type: "chats_list", profileId: m[1] };

  // echo:chat:{profileId}:{chatId}
  m = key.match(/^echo:chat:([^:]+):(.+)$/);
  if (m) return { type: "chat_msgs", profileId: m[1], chatId: m[2] };

  // echo:anchors:{profileId}
  m = key.match(/^echo:anchors:(.+)$/);
  if (m) return { type: "anchors", profileId: m[1] };

  // echo:relationships:{profileId}
  m = key.match(/^echo:relationships:(.+)$/);
  if (m) return { type: "relationships", profileId: m[1] };

  // echo:lastsession:{profileId}
  m = key.match(/^echo:lastsession:(.+)$/);
  if (m) return { type: "last_session", profileId: m[1] };

  // echo:jinsights:{profileId}
  m = key.match(/^echo:jinsights:(.+)$/);
  if (m) return { type: "journal_insights", profileId: m[1] };

  // echo:beliefhits:{profileId}
  m = key.match(/^echo:beliefhits:(.+)$/);
  if (m) return { type: "belief_hits", profileId: m[1] };

  // echo:digest:{profileId} — fallback to kv_store
  m = key.match(/^echo:digest:(.+)$/);
  if (m) return { type: "kv_store", profileId: m[1], rawKey: key };

  // Unknown — keep in kv_store
  return { type: "kv_store", rawKey: key };
}

// ── GET handlers ──────────────────────────────────────────────────────────────

async function getProfile(profileId) {
  const rows = await sbFetch(
    `profiles?id=eq.${encodeURIComponent(profileId)}&select=data&limit=1`
  );
  return rows?.length ? rows[0].data : null;
}

// Returns an array of message objects [{role,content,mood,tag,tag_color,created_at}]
async function getMessages(profileId, { screen = null, chatId = null } = {}) {
  let filter = `profile_id=eq.${encodeURIComponent(profileId)}`;
  if (screen)  filter += `&mood=eq.${encodeURIComponent(screen)}`; // screen stored in 'mood' col? No — see SET.
  // We store the screen/chatId in the chat_id column (see setMessages).
  const chatIdCol = screen ? `screen:${screen}` : chatId;
  if (chatIdCol) filter += `&chat_id=eq.${encodeURIComponent(chatIdCol)}`;
  filter += "&order=id.asc&limit=200";

  const rows = await sbFetch(`chat_messages?${filter}&select=role,content,mood,tag,tag_color,created_at`);
  return rows || [];
}

async function getChats(profileId) {
  const rows = await sbFetch(
    `chats?profile_id=eq.${encodeURIComponent(profileId)}&order=updated_at.desc&select=id,title,created_at,updated_at`
  );
  return rows || [];
}

async function getAnchors(profileId) {
  const rows = await sbFetch(
    `anchors?profile_id=eq.${encodeURIComponent(profileId)}&order=ts.asc&select=content,context,ts`
  );
  if (!rows?.length) return [];
  // Return in the shape app.jsx expects: [{quote, theme, ts}]
  return rows.map(r => {
    try { return { ...JSON.parse(r.content), ts: r.ts }; } catch { return { quote: r.content, ts: r.ts }; }
  });
}

async function getSingleJsonb(table, profileId) {
  const rows = await sbFetch(
    `${table}?profile_id=eq.${encodeURIComponent(profileId)}&select=data&limit=1`
  );
  return rows?.length ? rows[0].data : null;
}

async function getJournalInsights(profileId) {
  const rows = await sbFetch(
    `journal_insights?profile_id=eq.${encodeURIComponent(profileId)}&order=ts.asc&select=insight,ts`
  );
  if (!rows?.length) return [];
  return rows.map(r => ({ insight: r.insight, ts: r.ts }));
}

async function kvGet(rawKey) {
  const rows = await sbFetch(
    `kv_store?key=eq.${encodeURIComponent(rawKey)}&select=value&limit=1`
  );
  return rows?.length ? rows[0].value : null;
}

// ── SET handlers ──────────────────────────────────────────────────────────────

async function setProfile(profileId, data) {
  await sbFetch("profiles", {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ id: profileId, data }),
  });
}

// value is an array of message objects
async function setMessages(profileId, value, { screen = null, chatId = null } = {}) {
  const chatIdCol = screen ? `screen:${screen}` : chatId;

  // 1. Delete existing messages for this slot
  let delFilter = `profile_id=eq.${encodeURIComponent(profileId)}`;
  if (chatIdCol) delFilter += `&chat_id=eq.${encodeURIComponent(chatIdCol)}`;
  await sbFetch(`chat_messages?${delFilter}`, { method: "DELETE" });

  // 2. Insert the new set (batch)
  if (!value?.length) return;
  const rows = value.map(msg => ({
    profile_id: profileId,
    chat_id:    chatIdCol || "default",
    role:       msg.role,
    content:    msg.content,
    mood:       msg.mood || "neutral",
    tag:        msg.tag || null,
    tag_color:  msg.tag_color || null,
    created_at: msg.created_at ? new Date(msg.created_at).toISOString() : new Date().toISOString(),
  }));
  await sbFetch("chat_messages", {
    method: "POST",
    headers: { "Prefer": "return=minimal" },
    body: JSON.stringify(rows),
  });
}

// value is an array of chat session objects [{id, title, created_at, updated_at}]
async function setChats(profileId, chats) {
  // Upsert each chat row
  if (!chats?.length) return;
  const rows = chats.map(c => ({
    id:         c.id,
    profile_id: profileId,
    title:      c.title || "New Chat",
    created_at: c.created_at ? new Date(c.created_at).toISOString() : new Date().toISOString(),
    updated_at: c.updated_at ? new Date(c.updated_at).toISOString() : new Date().toISOString(),
  }));
  await sbFetch("chats", {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

// value is an array of anchor objects [{quote, theme, ts}]
async function setAnchors(profileId, anchors) {
  // Delete all existing anchors for this profile, then re-insert (mirrors app.jsx slice(-30) approach)
  await sbFetch(`anchors?profile_id=eq.${encodeURIComponent(profileId)}`, { method: "DELETE" });
  if (!anchors?.length) return;
  const rows = anchors.map(a => ({
    profile_id: profileId,
    content:    JSON.stringify(a),   // store full object so getAnchors can reconstruct
    context:    a.theme || null,
    ts:         a.ts ? new Date(a.ts).toISOString() : new Date().toISOString(),
  }));
  await sbFetch("anchors", {
    method: "POST",
    headers: { "Prefer": "return=minimal" },
    body: JSON.stringify(rows),
  });
}

async function setSingleJsonb(table, profileId, data) {
  await sbFetch(table, {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ profile_id: profileId, data, updated_at: new Date().toISOString() }),
  });
}

// value is an array of insight objects [{insight, ts}]
async function setJournalInsights(profileId, insights) {
  await sbFetch(`journal_insights?profile_id=eq.${encodeURIComponent(profileId)}`, { method: "DELETE" });
  if (!insights?.length) return;
  const rows = insights.map(i => ({
    profile_id: profileId,
    insight:    i.insight,
    ts:         i.ts ? new Date(i.ts).toISOString() : new Date().toISOString(),
  }));
  await sbFetch("journal_insights", {
    method: "POST",
    headers: { "Prefer": "return=minimal" },
    body: JSON.stringify(rows),
  });
}

async function kvSet(rawKey, value) {
  await sbFetch("kv_store", {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ key: rawKey, value }),
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
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

    const parsed = parseKey(key);

    // ── GET ──────────────────────────────────────────────────────────────────
    if (action === "get") {
      let data = null;

      switch (parsed.type) {
        case "profile":
          data = await getProfile(parsed.profileId);
          break;

        case "screen_msgs":
          data = await getMessages(parsed.profileId, { screen: parsed.screen });
          break;

        case "chats_list":
          data = await getChats(parsed.profileId);
          break;

        case "chat_msgs":
          data = await getMessages(parsed.profileId, { chatId: parsed.chatId });
          break;

        case "anchors":
          data = await getAnchors(parsed.profileId);
          break;

        case "relationships":
          data = await getSingleJsonb("relationships", parsed.profileId);
          break;

        case "last_session":
          data = await getSingleJsonb("last_session", parsed.profileId);
          break;

        case "journal_insights":
          data = await getJournalInsights(parsed.profileId);
          break;

        case "belief_hits":
          data = await getSingleJsonb("belief_hits", parsed.profileId);
          break;

        case "kv_store":
        default:
          data = await kvGet(parsed.rawKey || key);
          break;
      }

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ data }) };
    }

    // ── SET ──────────────────────────────────────────────────────────────────
    if (action === "set") {
      switch (parsed.type) {
        case "profile":
          await setProfile(parsed.profileId, value);
          break;

        case "screen_msgs":
          await setMessages(parsed.profileId, value, { screen: parsed.screen });
          break;

        case "chats_list":
          await setChats(parsed.profileId, value);
          break;

        case "chat_msgs":
          await setMessages(parsed.profileId, value, { chatId: parsed.chatId });
          break;

        case "anchors":
          await setAnchors(parsed.profileId, value);
          break;

        case "relationships":
          await setSingleJsonb("relationships", parsed.profileId, value);
          break;

        case "last_session":
          await setSingleJsonb("last_session", parsed.profileId, value);
          break;

        case "journal_insights":
          await setJournalInsights(parsed.profileId, value);
          break;

        case "belief_hits":
          await setSingleJsonb("belief_hits", parsed.profileId, value);
          break;

        case "kv_store":
        default:
          await kvSet(parsed.rawKey || key, value ?? null);
          break;
      }

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error("[YoEcho db] error:", err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message || "Internal server error" }) };
  }
};
