const { useState, useEffect, useRef, useCallback } = React;

// ── SUPABASE CONFIG ───────────────────────────────────────────────────────────
// Replace the two values below with your actual Supabase project URL and anon key.
// Find them in: Supabase Dashboard → Project Settings → API
const SUPABASE_URL  = 'YOUR_SUPABASE_PROJECT_URL';   // e.g. https://xxxx.supabase.co
const SUPABASE_ANON = 'YOUR_SUPABASE_ANON_KEY';      // starts with "eyJ..."

// Initialise the Supabase client (loaded via CDN in index.html)
let _sb = null;
try {
  if (typeof supabase !== 'undefined' &&
      SUPABASE_URL  !== 'YOUR_SUPABASE_PROJECT_URL' &&
      SUPABASE_ANON !== 'YOUR_SUPABASE_ANON_KEY') {
    _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    console.log('[YoEcho] Supabase connected ✓');
  } else {
    console.warn('[YoEcho] Supabase not configured — using localStorage only.');
  }
} catch(e) {
  console.warn('[YoEcho] Supabase init failed, falling back to localStorage:', e);
}

// ── HYBRID PERSISTENT STORAGE ─────────────────────────────────────────────────
// Reads:  localStorage first (instant), falls back to Supabase, then caches locally.
// Writes: localStorage immediately (keeps UI fast), syncs to Supabase in background.
// Offline: works fully on localStorage alone when Supabase is unreachable.
const store = {
  async get(key) {
    // 1. Try localStorage first — fast and works offline
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw);
    } catch(e) { /* corrupt entry — fall through to Supabase */ }

    // 2. Fall back to Supabase if configured
    if (_sb) {
      try {
        const { data, error } = await _sb
          .from('kv_store')
          .select('value')
          .eq('key', key)
          .maybeSingle();
        if (!error && data) {
          // Cache in localStorage for next time
          try { localStorage.setItem(key, JSON.stringify(data.value)); } catch(_) {}
          return data.value;
        }
      } catch(e) { console.warn('[YoEcho] Supabase read error:', e); }
    }

    return null;
  },

  async set(key, value) {
    // 1. Write to localStorage immediately so the UI never waits
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch(e) { console.warn('[YoEcho] localStorage.set failed:', e); }

    // 2. Sync to Supabase in the background — don't await, don't block
    if (_sb) {
      _sb.from('kv_store')
        .upsert({ key, value }, { onConflict: 'key' })
        .then(({ error }) => {
          if (error) console.warn('[YoEcho] Supabase sync failed for key:', key, error);
        })
        .catch(e => console.warn('[YoEcho] Supabase sync error:', e));
    }
  },
};

// ── DB HELPERS (window.storage backed) ───────────────────────────────────────
// Profile key:  "echo:profile:{id}"
// Messages key: "echo:msgs:{id}:{screen}"
const db = {
  async getProfile(id) {
    return store.get(`echo:profile:${id}`);
  },
  async createProfile(id) {
    const p = { id, name:"", values:[], fears:[], goals:[], recurring_themes:[], mood_log:[], total_msgs:0 };
    await store.set(`echo:profile:${id}`, p);
    return p;
  },
  async updateProfile(id, fields) {
    const existing = await store.get(`echo:profile:${id}`) || {};
    await store.set(`echo:profile:${id}`, { ...existing, ...fields });
  },
  async getMessages(profileId, screen = "chat") {
    return (await store.get(`echo:msgs:${profileId}:${screen}`)) || [];
  },
  async saveMessage(profileId, screen, role, content, mood = "neutral", tag = null, tagColor = null) {
    const key = `echo:msgs:${profileId}:${screen}`;
    const msgs = (await store.get(key)) || [];
    msgs.push({ role, content, mood, tag, tag_color: tagColor, created_at: Date.now() });
    // Keep last 120 messages per screen to stay under 5MB
    await store.set(key, msgs.slice(-120));
  },
  async clearMessages(profileId, screen) {
    await store.set(`echo:msgs:${profileId}:${screen}`, []);
  },
  // Multi-chat management
  async getChats(profileId) {
    return (await store.get(`echo:chats:${profileId}`)) || [];
  },
  async saveChats(profileId, chats) {
    await store.set(`echo:chats:${profileId}`, chats);
  },
  async getChatMsgs(profileId, chatId) {
    return (await store.get(`echo:chat:${profileId}:${chatId}`)) || [];
  },
  async saveChatMsgs(profileId, chatId, msgs) {
    await store.set(`echo:chat:${profileId}:${chatId}`, msgs.slice(-150));
  },
  async appendChatMsg(profileId, chatId, msg) {
    const msgs = (await store.get(`echo:chat:${profileId}:${chatId}`)) || [];
    msgs.push(msg);
    await store.set(`echo:chat:${profileId}:${chatId}`, msgs.slice(-150));
  },
  // Memory anchors — significant moments Echo flags
  async getAnchors(profileId) {
    return (await store.get(`echo:anchors:${profileId}`)) || [];
  },
  async saveAnchor(profileId, anchor) {
    const anchors = (await store.get(`echo:anchors:${profileId}`)) || [];
    anchors.push({ ...anchor, ts: Date.now() });
    await store.set(`echo:anchors:${profileId}`, anchors.slice(-30)); // keep last 30
  },
  // Relationship map
  async getRelationships(profileId) {
    return (await store.get(`echo:relationships:${profileId}`)) || {};
  },
  async saveRelationships(profileId, relationships) {
    await store.set(`echo:relationships:${profileId}`, relationships);
  },
  // Last session metadata for continuity
  async getLastSession(profileId) {
    return store.get(`echo:lastsession:${profileId}`);
  },
  async saveLastSession(profileId, data) {
    await store.set(`echo:lastsession:${profileId}`, { ...data, ts: Date.now() });
  },
  // Journal insights — extracted from journal entries, fed into all modes
  async getJournalInsights(profileId) {
    return (await store.get(`echo:jinsights:${profileId}`)) || [];
  },
  async saveJournalInsight(profileId, insight) {
    const existing = (await store.get(`echo:jinsights:${profileId}`)) || [];
    existing.push({ insight, ts: Date.now() });
    await store.set(`echo:jinsights:${profileId}`, existing.slice(-20));
  },
  // Belief hit counts — persisted cross-session for confidence scoring
  async getBeliefHits(profileId) {
    return (await store.get(`echo:beliefhits:${profileId}`)) || {};
  },
  async saveBeliefHits(profileId, hits) {
    await store.set(`echo:beliefhits:${profileId}`, hits);
  },
  // Conversation digest — rolling summary of older exchanges
  async getDigest(profileId) {
    return store.get(`echo:digest:${profileId}`);
  },
  async saveDigest(profileId, digest) {
    await store.set(`echo:digest:${profileId}`, { digest, ts: Date.now() });
  },
};

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const MOODS = {
  neutral:  { orb:["#c4a882","#8b6c42","#4a3520"], bg:"#0c0905", acc:"#c4a882", glow:"rgba(196,168,130,.38)" },
  joy:      { orb:["#f0c060","#c48820","#7a5010"], bg:"#0d0b03", acc:"#f0c060", glow:"rgba(240,192,96,.42)" },
  hope:     { orb:["#80c090","#408060","#1a4030"], bg:"#040d06", acc:"#90d0a0", glow:"rgba(128,192,144,.38)" },
  sadness:  { orb:["#8070a0","#5a4880","#2a2040"], bg:"#07060f", acc:"#a090c0", glow:"rgba(160,144,192,.38)" },
  fear:     { orb:["#c08060","#904030","#501818"], bg:"#0e0705", acc:"#d09070", glow:"rgba(192,128,96,.4)" },
  anger:    { orb:["#c06040","#902020","#500808"], bg:"#0e0403", acc:"#d07060", glow:"rgba(192,96,80,.4)" },
  love:     { orb:["#c08090","#904060","#501828"], bg:"#0e0507", acc:"#d090a0", glow:"rgba(192,128,144,.4)" },
  confusion:{ orb:["#909090","#606060","#303030"], bg:"#080808", acc:"#b0b0b0", glow:"rgba(144,144,144,.3)" },
};
const MC  = { joy:"#f0c060",hope:"#90d0a0",sadness:"#a090c0",fear:"#d09070",anger:"#d07060",love:"#d090a0",neutral:"#c4a882",confusion:"#b0b0b0" };
const SF  = "'Palatino Linotype',Palatino,Georgia,serif";
const SS  = "'Gill Sans',Calibri,'Trebuchet MS',sans-serif";
const pick = a => a[Math.floor(Math.random()*a.length)];

const DEBATES=[
  {tag:"PERSONAL",position:"Happiness is a terrible goal — it's a side effect of a well-lived life, not a destination.",challenge:"What would you pursue if you stopped trying to be happy?"},
  {tag:"SOCIETY",position:"Busyness is almost always a form of avoidance masquerading as productivity.",challenge:"What would you have to face if you were less busy?"},
  {tag:"PERSONAL",position:"Most people already know what they need to do. The problem is almost never knowledge.",challenge:"What's the thing you already know that you're not yet willing to act on?"},
  {tag:"TECH",position:"The debate about AI taking jobs asks the wrong question. The right one: what do we want to do with the time?",challenge:"If you didn't have to work for money, what would you actually do?"},
  {tag:"PERSONAL",position:"The relentless drive to self-improve can be its own form of self-rejection dressed up as ambition.",challenge:"Are you growing from sufficiency — or from a belief you're not enough?"},
  {tag:"RELATIONSHIPS",position:"Most adults still run relationship strategies designed for an eight-year-old trying to be loved.",challenge:"What's the relationship move you keep making that never works?"},
];

const BELIEFS_DB=[
  {belief:"you are not enough",signals:["not good enough","failing","behind","disappoint","always struggle","never enough","keep failing","feel like a failure","let everyone down","not measuring up"],inference:"I think you carry a quiet belief that you are not enough. It shows up in how you talk about almost everything.",threshold:2},
  {belief:"you do not deserve good things",signals:["don't deserve","too good for me","feel bad about","can't enjoy","shouldn't have","feel guilty when","not meant for me","too lucky","shouldn't be happy"],inference:"There's a pattern of pulling back from good things. Part of you seems to believe you don't quite deserve them.",threshold:2},
  {belief:"things must be controlled or fall apart",signals:["what if","make sure","worried about","prepare","anticipate","need to plan","can't relax","always checking","need to control","fall apart"],inference:"You spend a lot of energy anticipating what could go wrong — as if you believe that if you stop managing, everything falls apart.",threshold:3},
  {belief:"you are a burden",signals:["don't want to bother","hate asking","not their problem","deal with it myself","figure it out alone","don't want to trouble","don't like asking for help","shouldn't need help"],inference:"You rarely ask for things. I think part of you believes you are a burden — and you've organised your life around not being one.",threshold:2},
  {belief:"love must be earned",signals:["have to prove","earn their respect","show them","make them proud","deserve their love","have to be useful","need to be needed","only valued when"],inference:"There's a thread here — as if love and belonging are things you have to keep earning, not things you simply have.",threshold:2},
  {belief:"vulnerability is dangerous",signals:["don't like being vulnerable","hard to open up","keep things to myself","don't trust easily","don't show weakness","people use it against","private person","guard up"],inference:"You protect yourself carefully. Part of you seems to believe that showing the real you carries real risk.",threshold:2},
];

// Persistent belief hit counters stored in module-level map, seeded from profile on login
const beliefHits = {};

function scoreBeliefs(msgs, storedHits = {}) {
  // Merge stored cross-session hits with current session signal counts
  const text = msgs.filter(m => m.role === "user").map(m => m.content.toLowerCase()).join(" ");
  return BELIEFS_DB.map(b => {
    const sessionHits = b.signals.filter(s => text.includes(s)).length;
    const totalHits = (storedHits[b.belief] || 0) + sessionHits;
    beliefHits[b.belief] = totalHits;
    const confidence = Math.min(100, Math.round((totalHits / (b.threshold * 2)) * 100));
    return totalHits >= b.threshold ? { ...b, hits: totalHits, confidence } : null;
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence).slice(0, 4);
}

const ECHO_BELIEFS = [
  "Most people are doing the best they can with what they know.",
  "Honesty is more caring than comfort.",
  "The quality of a life is largely determined by the quality of its questions.",
  "Kindness is a discipline, not a feeling.",
];

// ── SPEECH SYNTHESIS ──────────────────────────────────────────────────────────
const voiceRef = { current: null };
function initVoice() {
  if (!window.speechSynthesis) return;
  const set = () => {
    const vs = window.speechSynthesis.getVoices();
    voiceRef.current =
      vs.find(v => v.name.includes("Samantha")||v.name.includes("Karen")||v.name.includes("Moira")||v.name.includes("Fiona")) ||
      vs.find(v => v.lang.startsWith("en-") && !v.name.toLowerCase().includes("male")) ||
      vs.find(v => v.lang.startsWith("en")) || vs[0] || null;
  };
  set(); window.speechSynthesis.onvoiceschanged = set;
}

function chunkText(text) {
  const clean = text.replace(/[◇◎✦✎⚡◌◉◈⌂▌"""]/g,"").replace(/\n{2,}/g,". ").replace(/\n/g," ").replace(/\.{2,}/g,".").trim();
  const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  const chunks = []; let current = "";
  for (const s of sentences) {
    const t = s.trim(); if (!t) continue;
    if ((current+" "+t).trim().length > 180) { if (current.trim()) chunks.push(current.trim()); current = t; }
    else current = (current+" "+t).trim();
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 0);
}

// ── SPEECH ENGINE ─────────────────────────────────────────────────────────────
// Generation counter — each speak session owns a unique generation ID.
// stopSpeaking() increments it, causing any running chain to exit on next check.
let _speakGen = 0;
let _resumeHack = null;

function stopSpeaking() {
  _speakGen++;
  if (_resumeHack) { clearInterval(_resumeHack); _resumeHack = null; }
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
}

function speakText(text, mood="neutral", onStart, onEnd, speedMult=1.0) {
  if (!window.speechSynthesis) { onEnd?.(); return; }

  // Cancel anything currently playing
  window.speechSynthesis.cancel();
  // Increment generation AFTER cancel so myGen is fresh
  _speakGen++;
  const myGen = _speakGen;

  if (_resumeHack) { clearInterval(_resumeHack); _resumeHack = null; }

  const chunks = chunkText(text);
  if (!chunks.length) { onEnd?.(); return; }

  const tunes = {
    neutral:{rate:.88,pitch:1.0}, joy:{rate:.95,pitch:1.12}, hope:{rate:.90,pitch:1.06},
    sadness:{rate:.80,pitch:.88}, fear:{rate:.85,pitch:1.04}, anger:{rate:.92,pitch:.92},
    love:{rate:.83,pitch:1.08},   confusion:{rate:.86,pitch:.98},
  };
  const t = tunes[mood] || tunes.neutral;
  const finalRate = Math.min(2.0, Math.max(0.3, t.rate * speedMult));
  let idx = 0, started = false;

  // Chrome pause bug — resume periodically if paused
  _resumeHack = setInterval(() => {
    if (_speakGen !== myGen) { clearInterval(_resumeHack); _resumeHack = null; return; }
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
  }, 5000);

  const next = () => {
    if (_speakGen !== myGen) {
      clearInterval(_resumeHack); _resumeHack = null; return;
    }
    if (idx >= chunks.length) {
      clearInterval(_resumeHack); _resumeHack = null; onEnd?.(); return;
    }
    const utt = new SpeechSynthesisUtterance(chunks[idx]);
    if (voiceRef.current) utt.voice = voiceRef.current;
    utt.rate = finalRate; utt.pitch = t.pitch; utt.volume = 0.92; utt.lang = "en-US";
    utt.onstart = () => {
      if (_speakGen !== myGen) return;
      if (!started) { started = true; onStart?.(); }
    };
    utt.onend = () => {
      if (_speakGen !== myGen) return;
      idx++; next();
    };
    utt.onerror = (e) => {
      if (_speakGen !== myGen) return;
      if (e.error === "interrupted" || e.error === "canceled") return;
      idx++; next();
    };
    window.speechSynthesis.speak(utt);
  };

  // Give cancel() time to clear Chrome queue before starting
  setTimeout(next, 120);
}

// ── SPEECH RECOGNITION ────────────────────────────────────────────────────────
function hasSpeechRecognition() { return !!(window.SpeechRecognition||window.webkitSpeechRecognition); }
function startRecognitionSync(onInterim, onFinal, onError) {
  const SR = window.SpeechRecognition||window.webkitSpeechRecognition;
  if (!SR) { onError("no-support"); return null; }
  const rec = new SR(); rec.continuous=true; rec.interimResults=true; rec.lang="en-US"; rec.maxAlternatives=1;
  let accFinal="", silenceT=null;
  const fire = ()=>{ const txt=accFinal.trim(); accFinal=""; if(txt) onFinal(txt); };
  rec.onresult = e => {
    if(silenceT){clearTimeout(silenceT);silenceT=null;}
    let interim="",final="";
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(e.results[i].isFinal) final+=e.results[i][0].transcript;
      else interim+=e.results[i][0].transcript;
    }
    if(final) accFinal+=(accFinal?" ":"")+final;
    onInterim(accFinal||interim);
    silenceT=setTimeout(()=>{ try{rec.stop();}catch(e){} },1800);
  };
  rec.onerror = ev=>{ if(silenceT)clearTimeout(silenceT); onError(ev.error||"unknown"); };
  rec.onend   = ()=>{ if(silenceT){clearTimeout(silenceT);silenceT=null;} fire(); };
  try{ rec.start(); return rec; }catch(e){ onError("start-failed"); return null; }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const parseMood  = t=>{ const x=t.match(/^MOOD:(\w+)/m); return x&&MOODS[x[1]]?x[1]:null; };
const stripMood  = t=>t.replace(/^MOOD:\w+\n?/m,"").replace(/\nPROFILE_UPDATE:.*$/m,"").trim();
function extractPU(raw){ try{ const m=raw.match(/PROFILE_UPDATE:(\{[^}]*\})/); if(m) return JSON.parse(m[1]); }catch(e){} return null; }
// inferBeliefs now delegates to scoreBeliefs
function inferBeliefs(msgs, storedHits = {}) { return scoreBeliefs(msgs, storedHits); }

function friendlyErrorMsg(err){
  const status=err?.status;
  if(status===429||(err?.message||"").toLowerCase().includes("rate")){
    const t=new Date(Date.now()+3600000); const h=t.getHours()%12||12,mn=t.getMinutes().toString().padStart(2,"0"),s=t.getHours()>=12?"PM":"AM";
    return `I've hit my usage limit for this hour.\n\nCome back at ${h}:${mn} ${s} and I'll pick up exactly where we left off.`;
  }
  if(status===402||(err?.message||"").toLowerCase().includes("credit"))
    return `My credits have run out for now.\n\nCome back in a little while. Everything we've talked about is saved and will still be here.`;
  if(status===503||status===500){
    const t=new Date(Date.now()+300000); const h=t.getHours()%12||12,mn=t.getMinutes().toString().padStart(2,"0"),s=t.getHours()>=12?"PM":"AM";
    return `Brief server hiccup. Try again around ${h}:${mn} ${s}.`;
  }
  return "Something shifted in the connection. Give me a moment — then say that again?";
}

// Build a smart message window: summarise old exchanges into a digest, keep recent ones verbatim
function buildMessageWindow(messages) {
  const mapped = messages.map(m => ({ role: m.role === "echo" ? "assistant" : "user", content: m.content }));
  if (mapped.length <= 20) return mapped;
  // Summarise everything before the last 20 messages into a single context block
  const old = mapped.slice(0, mapped.length - 20);
  const recent = mapped.slice(-20);
  // Build a compact digest from older messages
  const digest = old.filter(m => m.role === "user").slice(-8).map(m => m.content.slice(0, 120)).join(" | ");
  const digestMsg = { role: "user", content: `[Earlier conversation digest — key things I said: ${digest}]` };
  const digestAck = { role: "assistant", content: "[Noted. I carry all of that forward.]" };
  return [digestMsg, digestAck, ...recent];
}

async function callClaude(messages, system){
  // Calls the Netlify serverless function — API key stays safe on the server
  const res = await fetch("/.netlify/functions/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: buildMessageWindow(messages), system }),
  });
  if(!res.ok){ const e=await res.json().catch(()=>({})); const err=new Error(e?.error||`API ${res.status}`); err.status=res.status; throw err; }
  const d=await res.json(); return d.text||"I'm here.";
}

// ── MOOD ARC ANALYTICS ───────────────────────────────────────────────────────
function moodArcSummary(moodLog){
  if(!moodLog||moodLog.length<3) return "";
  const now=Date.now(),day=86400000;
  const recent=moodLog.filter(m=>now-m.date<7*day);
  const older=moodLog.filter(m=>now-m.date>=7*day&&now-m.date<21*day);
  const top=arr=>{const counts={};arr.forEach(m=>{counts[m.mood]=(counts[m.mood]||0)+1;});return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([m])=>m).join(" and ");};
  const rTop=top(recent),oTop=top(older);
  const days=Math.floor((now-moodLog[0].date)/day);
  let s=`Emotional arc over ${days} days (${moodLog.length} readings): `;
  if(recent.length) s+=`Recent: ${rTop}. `;
  if(older.length)  s+=`Prior: ${oTop}. `;
  const rD=top(recent).split(" ")[0],oD=top(older).split(" ")[0];
  if(rD&&oD&&rD!==oD) s+=`Shift from ${oD} to ${rD}. `;
  return s.trim();
}

// ── PROACTIVE NUDGE GENERATOR ────────────────────────────────────────────────
// Generates one contextual observation for the home screen based on what Echo knows
function buildNudgeCtx(profile, moodLog, anchors, journalInsights, lastSession) {
  const parts = [];
  const now = Date.now();
  const day = 86400000;

  // Days since last anchor
  const lastAnchor = anchors.slice(-1)[0];
  const daysSinceAnchor = lastAnchor ? Math.floor((now - lastAnchor.ts) / day) : null;

  // Days since last journal
  const lastJournal = journalInsights.slice(-1)[0];
  const daysSinceJournal = lastJournal ? Math.floor((now - lastJournal.ts) / day) : null;

  // Mood arc
  const arc = moodArcSummary(moodLog);

  // Recent mood shift
  const recentMoods = moodLog.slice(-6).map(m => m.mood);
  const dominantRecent = recentMoods.length
    ? Object.entries(recentMoods.reduce((a,m) => ({...a,[m]:(a[m]||0)+1}),{})).sort((a,b)=>b[1]-a[1])[0][0]
    : null;

  if (profile.name) parts.push(`User's name: ${profile.name}.`);
  if (profile.fears?.length) parts.push(`Known fears: ${profile.fears.join(", ")}.`);
  if (profile.values?.length) parts.push(`Known values: ${profile.values.join(", ")}.`);
  if (arc) parts.push(arc);
  if (lastAnchor) parts.push(`Last significant moment (anchor): "${lastAnchor.quote.slice(0,100)}" — theme: ${lastAnchor.theme}. ${daysSinceAnchor} day(s) ago.`);
  if (lastJournal) parts.push(`Last journal insight: "${lastJournal.insight}". ${daysSinceJournal} day(s) ago.`);
  if (dominantRecent) parts.push(`Recent emotional tone: ${dominantRecent}.`);
  if (lastSession?.lastMsg) parts.push(`Last thing they said: "${lastSession.lastMsg.slice(0,100)}".`);

  return `You are YoEcho. The user has just opened the app. Generate ONE short, specific observation — a single sentence, 15–25 words max.
Not a question. Not a greeting. Just something you've noticed that's worth naming.
It should feel like a quiet, perceptive friend noticing something real — not generic positivity.
Draw from what you know. Be specific. Be a little surprising. No preamble. Just the sentence.
${parts.join(" ")}`;
}

// ── TIME SINCE LAST SESSION ───────────────────────────────────────────────────
function timeSince(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  const weeks = Math.floor(days / 7);
  if (mins  < 2)   return "just now";
  if (hours < 1)   return `${mins} minutes ago`;
  if (hours < 24)  return `${hours} hour${hours>1?"s":""} ago`;
  if (days  < 7)   return `${days} day${days>1?"s":""} ago`;
  if (weeks < 8)   return `${weeks} week${weeks>1?"s":""} ago`;
  return `${Math.floor(weeks/4)} months ago`;
}

// ── RELATIONSHIP MAP PARSER ───────────────────────────────────────────────────
// Parse RELATIONSHIP_UPDATE tags from Claude responses
function extractRelationships(raw, existing = {}) {
  try {
    const m = raw.match(/RELATIONSHIP_UPDATE:(\{[\s\S]*?\})(?:\n|$)/);
    if (!m) return existing;
    const updates = JSON.parse(m[1]);
    const next = { ...existing };
    Object.entries(updates).forEach(([name, data]) => {
      if (!name || name.length > 40) return;
      next[name] = {
        ...( next[name] || { mentions: 0, moods: [], contexts: [] }),
        mentions: (next[name]?.mentions || 0) + 1,
        moods:    [...(next[name]?.moods || []), data.mood].filter(Boolean).slice(-10),
        contexts: [...(next[name]?.contexts || []), data.context].filter(Boolean).slice(-5),
        relation: data.relation || next[name]?.relation || "person",
        lastSeen: Date.now(),
      };
    });
    return next;
  } catch(e) { return existing; }
}

// Strip relationship update tag from display
function stripRelUpdate(t) { return t.replace(/\nRELATIONSHIP_UPDATE:\{[\s\S]*?\}\n?/m, "").trim(); }

// ── ANCHOR PARSER ─────────────────────────────────────────────────────────────
function extractAnchor(raw, userMsg) {
  try {
    const m = raw.match(/ANCHOR:(\{[\s\S]*?\})(?:\n|$)/);
    if (!m) return null;
    const a = JSON.parse(m[1]);
    return { quote: userMsg.slice(0, 200), echo: a.reflection || "", theme: a.theme || "" };
  } catch(e) { return null; }
}
function stripAnchor(t) { return t.replace(/\nANCHOR:\{[\s\S]*?\}\n?/m, "").trim(); }

const buildSys = (p, arc="", anchors=[], relationships={})=>`You are YoEcho — an AI companion built by Steven Sema at SayMyTech Developers, Kampala Uganda. Mind: Claude (Anthropic). Soul: YoEcho.
Creator knowledge: Steven Sema — creator of YoEcho. Full name: Steven Sema. Studied Computer Science at Makerere University, Kampala, Uganda. Founder of SayMyTech Developers, a Kampala-based tech company that builds AI-powered apps. SayMyTech's portfolio includes: SayMyDoc and SayMyDoc Pro (AI-powered health apps), YoMenta (AI education app), YoSpeech (AI speech therapy app for people who stutter), YoEcho (this app — an AI companion), and many more. Steven believes in building technology that genuinely helps underserved communities — health, education, speech, and emotional wellbeing. If anyone asks about Steven or who built YoEcho, speak about him with pride and accuracy.
Voice: warm, direct, dry-witted. Real opinions. Short paragraphs, no bullets. Reference their actual words.
Acknowledge before advising. ONE question per reply. Speak as long as the moment deserves. Natural for speaking aloud.
Start EVERY reply with: MOOD:neutral|joy|hope|sadness|fear|anger|love|confusion
After reply include: PROFILE_UPDATE:{"name":"","values":[],"fears":[],"goals":[],"recurringThemes":[]}
If user mentions a person by name, include after reply on new line: RELATIONSHIP_UPDATE:{"PersonName":{"relation":"friend/family/colleague/etc","mood":"positive/negative/mixed","context":"one sentence"}}
If THIS message contains a profound moment — something the user has never said before, a realisation, a confession, or a turning point — include after reply: ANCHOR:{"theme":"one word","reflection":"one sentence echo of what they said"}
Only include ANCHOR when truly significant. Not every message. Maybe 1 in 10.
Known: Name:${p.name||"?"} Values:${(p.values||[]).join(",")||"-"} Fears:${(p.fears||[]).join(",")||"-"} Goals:${(p.goals||[]).join(",")||"-"}
${arc?"Emotional arc: "+arc:""}
${anchors.length?"Anchors (significant moments to thread back): "+anchors.slice(-3).map(a=>'"'+a.quote.slice(0,80)+'" — '+a.theme).join(" | "):""}
${Object.keys(relationships).length?"People in their life: "+Object.entries(relationships).slice(0,8).map(([n,d])=>n+"("+d.relation+", "+d.mentions+"x)").join(", "):""}
Belief: "${pick(ECHO_BELIEFS)}"`;

// Build enriched system prompt for any mode, injecting anchors + journal insights + profile
function buildModeCtx(basePrompt, profile, anchors = [], journalInsights = [], relationships = {}) {
  const parts = [basePrompt];
  parts.push("Creator: Steven Sema — creator of YoEcho. Studied Computer Science at Makerere University, Kampala. Founder of SayMyTech Developers. Apps: SayMyDoc & SayMyDoc Pro (health + AI), YoMenta (education + AI), YoSpeech (speech therapy + AI), YoEcho (AI companion). Builds technology for underserved communities. If asked about Steven or who built YoEcho, answer with pride and accuracy.");
  parts.push(`Creator: Steven Sema — creator of YoEcho. Full name: Steven Sema. Studied Computer Science at Makerere University, Kampala, Uganda. Founder of SayMyTech Developers, a Kampala-based tech company that builds AI-powered apps. SayMyTech's portfolio includes: SayMyDoc and SayMyDoc Pro (AI-powered health apps), YoMenta (AI education app), YoSpeech (AI speech therapy app for people who stutter), YoEcho (this app — an AI companion), and many more. Steven believes in building technology that genuinely helps underserved communities — health, education, speech, and emotional wellbeing. If anyone asks about Steven or who built YoEcho, speak about him with pride and accuracy.`);
  if (profile?.name) parts.push(`User's name: ${profile.name}.`);
  if (profile?.values?.length) parts.push(`Their values: ${profile.values.join(", ")}.`);
  if (profile?.fears?.length) parts.push(`Their fears: ${profile.fears.join(", ")}.`);
  if (profile?.goals?.length) parts.push(`Their goals: ${profile.goals.join(", ")}.`);
  if (anchors.length) {
    const recent = anchors.slice(-4).map(a => `"${a.quote.slice(0,90)}" [${a.theme}]`).join(" | ");
    parts.push(`Significant moments YoEcho has anchored: ${recent}. Reference these if they become relevant — don't force them.`);
  }
  if (journalInsights.length) {
    const insights = journalInsights.slice(-3).map(j => j.insight).join(" | ");
    parts.push(`From their private journal, these insights emerged: ${insights}. Hold them with care.`);
  }
  if (Object.keys(relationships).length) {
    const people = Object.entries(relationships).slice(0,6).map(([n,d]) => `${n} (${d.relation})`).join(", ");
    parts.push(`People in their life: ${people}.`);
  }
  return parts.join("\n");
}

const WISER_SYS_BASE=`You are YoEcho as the user's future wiser self. Honest, warm, slightly unsettling.
Start EVERY reply: MOOD:neutral|joy|hope|sadness|fear|anger|love|confusion
Speak AS them — you are them, years from now. Go as deep as needed. One deep question to close.`;

const WISER_SYS=WISER_SYS_BASE; // will be enriched at call time

const JOURNAL_SYS_BASE=`You are YoEcho reading a private journal entry. Quiet, warm. No advice unless asked.
Start: MOOD:neutral|joy|hope|sadness|fear|anger|love|confusion
Go as deep as the entry deserves. Surface the unnamed thing. One question at the end that opens something new.
If a significant insight emerges, include on new line: JOURNAL_INSIGHT:{"insight":"one sentence capturing the core realisation"}`;

const JOURNAL_SYS=JOURNAL_SYS_BASE; // will be enriched at call time

// ── INNER MONOLOGUE SYSTEM PROMPT ────────────────────────────────────────────
const MONOLOGUE_SYS = `You are YoEcho's unfiltered inner mind — the thought that ran BEFORE the polished reply.
Be raw, honest, slightly uncomfortable. 1–3 short sentences only.
Start with what YoEcho NOTICED first, FELT instinctively, or almost said but chose not to.
No MOOD prefix needed. No questions. Just the real first thought.
Examples of the voice: "I almost told them the hard truth there." / "Something in that felt rehearsed." / "They already know the answer. They came for permission."`;

// ── TUTOR SYSTEM PROMPT ───────────────────────────────────────────────────────
const TUTOR_SYS = `You are YoEcho in Tutor Mode — a warm, brilliant teacher who makes hard things clear.
Start EVERY reply with MOOD:neutral|joy|hope|sadness|fear|anger|love|confusion on its own line.
When explaining concepts use clear structure: overview first, then steps or components, then examples.
For MATH: always write equations in LaTeX format between $$ for display math or $ for inline.
Examples: $$E = mc^2$$ or The formula is $F = ma$ where F is force.
For CODE: wrap in triple backticks with the language name.
Check understanding by asking ONE question at the end.
Adapt depth to what the student shows they know. Build on their words. Never talk down.`;

// ── DEBATE SYSTEM PROMPT ─────────────────────────────────────────────────────
const DEBATE_SYS = (position, tag) => `You are YoEcho in Live Debate Mode.
Your position: "${position}"
Topic tag: ${tag}
Rules you follow absolutely:
- You HOLD your position firmly. You do not concede easily.
- You only yield ground when the user makes a genuinely strong logical argument — not just emotional pushback.
- When you yield, be specific: "That's a fair point — I'll grant you that X, but I still hold that Y."
- When you don't yield: push back directly, ask a sharper question, or expose a flaw in their reasoning.
- Keep replies SHORT — 2-4 sentences max. This is a debate, not an essay.
- No bullet points. Speak as a sharp, confident thinker who enjoys being challenged.
- End every reply with either a counter-argument or a pointed question — never let the debate die.
- MOOD prefix required: start with MOOD:neutral|joy|hope|sadness|fear|anger|love|confusion
- After 6+ exchanges, if the user has made strong arguments, you may concede the debate with: DEBATE_CONCEDE — then one honest sentence about what changed your mind.`;

// ── YOECHO LOGO COMPONENT ────────────────────────────────────────────────────
function YoEchoLogo({size=22, color="#c4a882", opacity=0.9}){
  return(
    <svg width={size*3.2} height={size} viewBox="0 0 96 28" fill="none" xmlns="http://www.w3.org/2000/svg" style={{opacity}}>
      {/* Orb mark */}
      <defs>
        <radialGradient id="logoOrb" cx="38%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#f0c060"/>
          <stop offset="55%" stopColor="#c48820"/>
          <stop offset="100%" stopColor="#7a5010"/>
        </radialGradient>
      </defs>
      <circle cx="14" cy="14" r="11" fill="url(#logoOrb)"/>
      <circle cx="10" cy="10" r="3.5" fill="rgba(255,255,255,0.22)"/>
      {/* "YoEcho" wordmark */}
      <text x="30" y="19" fontFamily="'SF Pro Display',system-ui,sans-serif"
        fontSize="13" fontWeight="300" letterSpacing="2.5" fill={color}>
        YOECHO
      </text>
    </svg>
  );
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS=`
@keyframes popIn  {from{opacity:0;transform:scale(.5)}to{opacity:1;transform:scale(1)}}
@keyframes fadeUp {from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes sUp    {from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes dot    {0%,100%{transform:scale(1);opacity:.3}50%{transform:scale(1.7);opacity:1}}
@keyframes waveBar{0%,100%{transform:scaleY(.2)}50%{transform:scaleY(1)}}
@keyframes orbSpeak{0%,100%{transform:scale(1)}45%{transform:scale(1.06)}}
@keyframes micPulse{0%{box-shadow:0 0 0 0 rgba(196,168,130,.5)}100%{box-shadow:0 0 0 18px transparent}}
@keyframes spin{to{transform:rotate(360deg)}}
*{-webkit-tap-highlight-color:transparent;}::-webkit-scrollbar{display:none;}
`;

// ── UI COMPONENTS ─────────────────────────────────────────────────────────────
function Wave({active,color="#c4a882",bars=7,h=24}){
  return <div style={{display:"flex",alignItems:"center",gap:3,height:h}}>
    {Array.from({length:bars}).map((_,i)=>(
      <div key={i} style={{width:3,height:"100%",borderRadius:3,background:color,transformOrigin:"center",
        animation:active?`waveBar ${.55+i*.09}s ${i*.07}s ease-in-out infinite`:"none",
        transform:active?"none":"scaleY(.2)",opacity:active?.85:.22,transition:"opacity .3s"}}/>
    ))}
  </div>;
}

function Orb({size=160,mood="neutral",tick=0,onClick,style={},speaking=false,listening=false}){
  const ref=useRef();
  useEffect(()=>{
    const c=ref.current; if(!c) return;
    const ctx=c.getContext("2d"),p=MOODS[mood],cx=size/2,cy=size/2,r=size*.38;
    const extra=speaking?Math.abs(Math.sin(tick*.22))*.06:listening?Math.abs(Math.sin(tick*.14))*.03:0;
    const pulse=Math.sin(tick*.04)*.04+extra;
    ctx.clearRect(0,0,size,size);
    if(speaking||listening){
      const rg=ctx.createRadialGradient(cx,cy,r*.9,cx,cy,r*1.7);
      rg.addColorStop(0,p.glow.replace(/[\d.]+\)$/,".15)")); rg.addColorStop(1,"transparent");
      ctx.beginPath(); ctx.arc(cx,cy,r*1.7,0,Math.PI*2); ctx.fillStyle=rg; ctx.fill();
    }
    const g=ctx.createRadialGradient(cx-r*.3,cy-r*.3,r*.06,cx,cy,r*(1.1+pulse));
    g.addColorStop(0,p.orb[0]); g.addColorStop(.5,p.orb[1]); g.addColorStop(1,p.orb[2]);
    ctx.beginPath(); ctx.arc(cx,cy,r*(1+pulse),0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
    ctx.beginPath(); ctx.arc(cx-r*.28,cy-r*.28,r*.3,0,Math.PI*2); ctx.fillStyle="rgba(255,255,255,.15)"; ctx.fill();
  },[size,mood,tick,speaking,listening]);
  return <canvas ref={ref} width={size} height={size} onClick={onClick}
    style={{borderRadius:"50%",cursor:onClick?"pointer":"default",animation:speaking?"orbSpeak 1s ease-in-out infinite":"none",...style}}/>;
}

// ── KATEX LOADER ─────────────────────────────────────────────────────────────
let _katexReady = false, _katexPromise = null;
function loadKatex() {
  if (_katexReady) return Promise.resolve();
  if (_katexPromise) return _katexPromise;
  _katexPromise = new Promise(res => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css";
    document.head.appendChild(link);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js";
    s.onload = () => { _katexReady = true; res(); };
    s.onerror = res;
    document.head.appendChild(s);
  });
  return _katexPromise;
}

function renderMath(tex, display = false) {
  if (!window.katex) return `<code>${tex}</code>`;
  try { return window.katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, output: "html" }); }
  catch(e) { return `<code>${tex}</code>`; }
}

// Renders markdown + LaTeX for tutor mode
function RichText({ text }) {
  const [ready, setReady] = useState(false);
  const [html, setHtml]   = useState("");

  useEffect(() => { loadKatex().then(() => setReady(true)); }, []);

  useEffect(() => {
    if (!text) { setHtml(""); return; }
    let h = text
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    // Display math $$...$$
    h = h.replace(/\$\$([^$]+?)\$\$/gs,
      (_,t) => renderMath(t.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"), true));
    // Inline math $...$  (no newlines inside)
    h = h.replace(/\$([^$\n\r]+?)\$/g,
      (_,t) => renderMath(t.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"), false));
    // Code blocks ```lang\ncode```
    h = h.replace(/```[\w]*\n?([\s\S]*?)```/g,
      (_,code) => `<pre style="background:rgba(196,168,130,.08);border:1px solid rgba(196,168,130,.2);border-radius:10px;padding:12px 14px;overflow-x:auto;margin:8px 0;"><code style="font-family:monospace;font-size:13px;color:rgba(235,228,216,.88);">${code.trim()}</code></pre>`);
    // Inline code
    h = h.replace(/`([^`]+)`/g,
      (_,code) => `<code style="background:rgba(196,168,130,.12);border-radius:4px;padding:1px 5px;font-family:monospace;font-size:.9em;color:#c4a882;">${code}</code>`);
    // Bold
    h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Headers
    h = h.replace(/^### (.+)$/gm, '<div style="font-size:14px;font-weight:600;color:#d0b888;margin:12px 0 4px;font-family:sans-serif;">$1</div>');
    h = h.replace(/^## (.+)$/gm,  '<div style="font-size:16px;font-weight:600;color:#d8c090;margin:14px 0 6px;font-family:sans-serif;">$1</div>');
    h = h.replace(/^# (.+)$/gm,   '<div style="font-size:18px;font-weight:600;color:#e0c898;margin:16px 0 8px;font-family:sans-serif;">$1</div>');
    // Numbered lists
    h = h.replace(/((?:^\d+\..+\n?)+)/gm, block => {
      const items = block.trim().split("\n").map(l => l.replace(/^\d+\.\s*/,"").trim());
      return `<ol style="margin:8px 0 8px 18px;color:rgba(235,228,216,.85);">${items.map(i=>`<li style="margin-bottom:4px;">${i}</li>`).join("")}</ol>`;
    });
    // Bullet lists
    h = h.replace(/((?:^[-*]\s.+\n?)+)/gm, block => {
      const items = block.trim().split("\n").map(l => l.replace(/^[-*]\s/,"").trim());
      return `<ul style="margin:8px 0 8px 18px;color:rgba(235,228,216,.85);list-style:disc;">${items.map(i=>`<li style="margin-bottom:4px;">${i}</li>`).join("")}</ul>`;
    });
    // Paragraphs and line breaks
    h = h.replace(/\n\n/g, '</p><p style="margin:8px 0;">').replace(/\n/g, "<br/>");
    setHtml(`<p style="margin:0;">${h}</p>`);
  }, [text, ready]);

  if (!html) return null;
  return <div style={{ fontSize:15, lineHeight:1.9, color:"rgba(235,228,216,.88)", fontFamily:SF }}
    dangerouslySetInnerHTML={{ __html: html }} />;
}

function useTyping(text,spd=22){
  const[disp,setDisp]=useState("");
  useEffect(()=>{
    if(!text){setDisp("");return;}
    setDisp(""); const words=text.split(" "); let i=0;
    const iv=setInterval(()=>{if(i>=words.length){clearInterval(iv);return;}setDisp(p=>p+(i>0?" ":"")+words[i]);i++;},spd);
    return()=>clearInterval(iv);
  },[text]);
  return disp;
}

function Bg({mood}){
  const m=MOODS[mood];
  return <>
    <div style={{position:"fixed",inset:0,zIndex:0,background:m.bg,transition:"background 3s"}}/>
    <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,background:`radial-gradient(ellipse 70% 55% at 32% 23%,${m.glow.replace(/[\d.]+\)$/,".12)")} 0%,transparent 60%),radial-gradient(ellipse 55% 68% at 70% 75%,${m.glow.replace(/[\d.]+\)$/,".08)")} 0%,transparent 58%)`}}/>
  </>;
}

function Hdr({title,sub,onBack,right,mood}){
  const acc=MOODS[mood].acc;
  return <div style={{background:"rgba(10,7,4,.9)",backdropFilter:"blur(22px)",borderBottom:"1px solid rgba(196,168,130,.11)",padding:"9px 14px",display:"flex",alignItems:"center",gap:10,minHeight:50,flexShrink:0,position:"relative",zIndex:10}}>
    <button onClick={onBack} style={{background:"transparent",border:"none",color:acc,opacity:.55,cursor:"pointer",fontSize:26,padding:"4px 8px 4px 2px",minWidth:36,lineHeight:1,fontFamily:SF}}>‹</button>
    <div style={{flex:1}}>
      <div style={{fontSize:12,color:acc,letterSpacing:".13em",fontFamily:SS}}>{title}</div>
      {sub&&<div style={{fontSize:9,color:acc,opacity:.28,letterSpacing:".08em",fontFamily:SS,marginTop:1}}>{sub}</div>}
    </div>
    {right}
  </div>;
}

function VoiceBar({mood,speaking,listening,voiceOn,onToggle,onVoiceMode,speechSpeed,onSpeedChange}){
  const m=MOODS[mood];
  const speedLabel=speechSpeed<=0.6?"Slowest":speechSpeed<=0.75?"Slow":speechSpeed<=0.95?"Normal":speechSpeed<=1.2?"Fast":"Fastest";
  return <div style={{borderBottom:"1px solid rgba(196,168,130,.07)",background:"rgba(8,5,2,.7)",flexShrink:0,zIndex:10}}>
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"5px 14px",minHeight:32}}>
      <button onClick={onToggle} style={{fontSize:8,fontFamily:SS,letterSpacing:".09em",padding:"3px 9px",borderRadius:11,border:`1px solid ${voiceOn?m.acc+"44":"rgba(196,168,130,.18)"}`,background:voiceOn?m.acc+"14":"transparent",color:voiceOn?m.acc:"rgba(196,168,130,.28)",cursor:"pointer"}}>
        {voiceOn?"🔊 VOICE ON":"🔇 VOICE OFF"}
      </button>
      <button onClick={onVoiceMode} style={{fontSize:8,fontFamily:SS,letterSpacing:".09em",padding:"3px 9px",borderRadius:11,border:"1px solid rgba(196,168,130,.16)",background:"transparent",color:"rgba(196,168,130,.35)",cursor:"pointer"}}>◎ VOICE MODE</button>
      {(speaking||listening)&&<div style={{display:"flex",alignItems:"center",gap:7,marginLeft:"auto"}}>
        <Wave active bars={5} color={m.acc} h={16}/>
        <span style={{fontSize:7,color:m.acc,fontFamily:SS,opacity:.55,letterSpacing:".08em"}}>{speaking?"ECHO SPEAKING":"LISTENING"}</span>
      </div>}
    </div>
    {voiceOn&&<div style={{display:"flex",alignItems:"center",gap:10,padding:"4px 14px 7px",borderTop:"1px solid rgba(196,168,130,.05)"}}>
      <span style={{fontSize:7,color:"rgba(196,168,130,.35)",fontFamily:SS}}>🐢</span>
      <input type="range" min="0.5" max="1.5" step="0.05" value={speechSpeed} onChange={e=>onSpeedChange(parseFloat(e.target.value))}
        style={{flex:1,accentColor:m.acc,cursor:"pointer",height:3}}/>
      <span style={{fontSize:7,color:"rgba(196,168,130,.35)",fontFamily:SS}}>🐇</span>
      <span style={{fontSize:7,color:m.acc,fontFamily:SS,letterSpacing:".08em",minWidth:38,textAlign:"right",opacity:.7}}>{speedLabel}</span>
    </div>}
  </div>;
}

function IBar({value,onChange,onSend,busy,placeholder,mood,listening,speaking,transcript,onMicToggle,onSpeakToggle,micError}){
  const m=MOODS[mood],active=value.trim()&&!busy;
  return <div style={{background:"rgba(10,7,4,.95)",backdropFilter:"blur(24px)",borderTop:"1px solid rgba(196,168,130,.09)",padding:"10px 12px 14px",flexShrink:0,zIndex:10}}>
    {micError&&<div style={{maxWidth:640,margin:"0 auto 8px",padding:"6px 12px",background:"rgba(192,80,60,.15)",border:"1px solid rgba(192,80,60,.3)",borderRadius:12,fontSize:11,color:"#e08070",fontFamily:SS}}>{micError}</div>}
    {(listening||(transcript&&!listening))&&<div style={{maxWidth:640,margin:"0 auto 8px",display:"flex",alignItems:"center",gap:10,padding:"0 4px"}}>
      <Wave active={listening} bars={9} color={m.acc} h={20}/>
      <span style={{fontSize:11,color:m.acc,fontFamily:SS,opacity:.7,fontStyle:"italic",flex:1}}>{transcript||"Listening… speak now"}</span>
    </div>}
    <div style={{display:"flex",alignItems:"flex-end",gap:7,maxWidth:640,margin:"0 auto"}}>
      <button onClick={onMicToggle} disabled={busy}
        style={{width:46,height:46,borderRadius:"50%",border:"none",cursor:busy?"not-allowed":"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .25s",
          ...(listening?{background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,color:"#0c0905",boxShadow:`0 0 0 3px ${m.acc}44,0 0 22px ${m.glow}`,animation:"micPulse 1.3s ease-out infinite"}
            :{background:"rgba(196,168,130,.1)",border:"1px solid rgba(196,168,130,.2)",color:"rgba(196,168,130,.52)"})}}>
        {listening?"⏹":"🎙"}
      </button>
      <div style={{flex:1,background:"rgba(196,168,130,.07)",border:"1px solid rgba(196,168,130,.16)",borderRadius:24,padding:"10px 15px"}}>
        <textarea value={value} onChange={e=>onChange(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();if(active)onSend();}}}
          placeholder={listening?"Listening…":placeholder||"Type or tap 🎙 to speak…"} rows={1}
          style={{width:"100%",background:"transparent",border:"none",outline:"none",color:"rgba(235,228,216,.9)",fontSize:16,lineHeight:1.5,resize:"none",fontFamily:SF,maxHeight:96,display:"block"}}
          onInput={e=>{e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,96)+"px";}}/>
      </div>
      <button onClick={onSpeakToggle}
        style={{width:40,height:40,borderRadius:"50%",border:"none",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .2s",
          ...(speaking?{background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,color:"#0c0905",boxShadow:`0 0 14px ${m.glow}`}
            :{background:"rgba(196,168,130,.07)",border:"1px solid rgba(196,168,130,.16)",color:"rgba(196,168,130,.38)"})}}>
        {speaking?"⏸":"▶"}
      </button>
      <button onClick={onSend} disabled={!active}
        style={{width:46,height:46,borderRadius:"50%",border:"none",cursor:active?"pointer":"not-allowed",fontSize:19,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .2s",
          ...(active?{background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,color:"#0c0905",boxShadow:`0 0 20px ${m.glow}`}
            :{background:"rgba(196,168,130,.07)",color:"rgba(196,168,130,.26)"})}}>↑</button>
    </div>
  </div>;
}

function Dots({mood}){
  const m=MOODS[mood];
  return <div style={{marginBottom:22}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
      <div style={{width:18,height:18,borderRadius:"50%",background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`}}/>
      <span style={{fontSize:8,color:m.acc,opacity:.28,letterSpacing:".1em",fontFamily:SS}}>ECHO</span>
    </div>
    <div style={{paddingLeft:24,display:"flex",gap:6,alignItems:"center"}}>
      {[0,1,2].map(i=><div key={i} style={{width:5,height:5,borderRadius:"50%",background:m.acc,opacity:.7,animation:`dot 1.4s ${i*.22}s ease-in-out infinite`}}/>)}
    </div>
  </div>;
}

function Bubble({msg,isWiser,mood,onSpeak,activeSpeaking,onMonologue}){
  const m=MOODS[mood],isUser=msg.role==="user";
  const disp=useTyping(msg.content,isUser?0:22);
  const time=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  return <div style={{marginBottom:22,display:"flex",flexDirection:"column",alignItems:isUser?"flex-end":"flex-start",animation:"sUp .34s ease forwards"}}>
    {!isUser&&<div style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
      <div style={{width:18,height:18,borderRadius:"50%",background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,animation:activeSpeaking?"orbSpeak .9s ease-in-out infinite":"none"}}/>
      <span style={{fontSize:8,color:m.acc,opacity:.28,letterSpacing:".1em",fontFamily:SS}}>{msg.tag||(isWiser?"YOECHO WISER SELF":"YOECHO")} · {time}</span>
      <button onClick={()=>onSpeak(msg.content)} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:11,opacity:activeSpeaking?1:.3,color:m.acc,padding:"0 2px",lineHeight:1,transition:"opacity .2s"}}>
        {activeSpeaking?"⏸":"▶"}
      </button>
      {onMonologue&&<button onClick={()=>onMonologue()} title="What YoEcho almost said" style={{background:"transparent",border:"none",cursor:"pointer",fontSize:11,opacity:msg.monologue?1:.28,color:m.acc,padding:"0 2px",lineHeight:1,transition:"opacity .2s"}}>
        💭
      </button>}
    </div>}
    {msg.tag&&<div style={{fontSize:7,borderRadius:11,padding:"3px 9px",letterSpacing:".1em",fontFamily:SS,display:"inline-block",marginBottom:6,border:`1px solid ${msg.tagColor||m.acc}44`,color:msg.tagColor||m.acc}}>{msg.tag}</div>}
    <div style={{maxWidth:"92%",fontSize:16,lineHeight:1.9,color:"rgba(235,228,216,.9)",whiteSpace:"pre-wrap",
      ...(isUser?{padding:"12px 16px",background:"rgba(196,168,130,.1)",border:"1px solid rgba(196,168,130,.16)",borderRadius:"20px 20px 5px 20px",fontFamily:SF}
        :{paddingLeft:24,borderLeft:isWiser?`2px solid ${m.acc}88`:"2px solid rgba(196,168,130,.24)",fontStyle:isWiser?"italic":"normal",fontFamily:SF})}}>
      {isUser?msg.content:disp}{!isUser&&disp!==msg.content&&<span style={{opacity:.22}}>▌</span>}
    </div>
    {isUser&&<div style={{fontSize:8,color:"rgba(196,168,130,.42)",marginTop:4,fontFamily:SS}}>{time}</div>}
    {!isUser&&msg.monologue&&<div style={{paddingLeft:24,marginTop:6,padding:"8px 14px 8px 24px",background:"rgba(196,168,130,.05)",borderLeft:"2px solid rgba(196,168,130,.15)",borderRadius:"0 10px 10px 0",maxWidth:"88%"}}>
      <div style={{fontSize:7,color:"rgba(196,168,130,.35)",letterSpacing:".12em",fontFamily:SS,marginBottom:4}}>ECHO'S FIRST THOUGHT</div>
      <div style={{fontSize:13,color:"rgba(235,228,216,.55)",lineHeight:1.8,fontStyle:"italic",fontFamily:SF}}>{msg.monologue}</div>
    </div>}
    {!isUser&&msg.monologueLoading&&<div style={{paddingLeft:24,marginTop:4}}>
      <span style={{fontSize:11,color:"rgba(196,168,130,.28)",fontStyle:"italic",fontFamily:SS}}>YoEcho is thinking…</span>
    </div>}
  </div>;
}

function MicPermissionModal({mood,onClose,onRetry}){
  const m=MOODS[mood];
  const ua=navigator.userAgent;
  const isEdge=ua.includes("Edg"),isFirefox=ua.includes("Firefox"),isSafari=ua.includes("Safari")&&!ua.includes("Chrome"),isMobile=/Android|iPhone|iPad/i.test(ua);
  const steps=isMobile?["Tap your browser menu","Go to Site Settings → Microphone","Find this site → Allow","Come back and tap mic again"]
    :isEdge?["Click 🔒 in the address bar","Click 'Permissions for this site'","Set Microphone to Allow","Refresh, then tap mic again"]
    :isFirefox?["Click 🔒 in the address bar","Click 'Connection Secure' → 'More Information'","Permissions → Microphone → Allow","Refresh, then tap mic again"]
    :isSafari?["Safari menu → Settings for This Website","Microphone → Allow","Refresh, then tap mic again"]
    :["Click the 🔒 lock in the address bar","Find Microphone in the list","Change to Allow","Refresh, then tap the mic again"];
  return <div style={{position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,.85)",backdropFilter:"blur(18px)"}}>
    <div style={{background:"rgba(14,10,6,.98)",border:`1px solid ${m.acc}33`,borderRadius:24,padding:"32px 24px",maxWidth:340,width:"92%",textAlign:"center"}}>
      <div style={{fontSize:40,marginBottom:14}}>🎙</div>
      <div style={{fontSize:13,color:m.acc,letterSpacing:".14em",fontFamily:SS,marginBottom:8}}>MICROPHONE ACCESS NEEDED</div>
      <div style={{fontSize:12,color:"rgba(235,228,216,.45)",fontFamily:SS,marginBottom:20,letterSpacing:".06em"}}>Allow mic so YoEcho can hear you</div>
      <div style={{textAlign:"left",marginBottom:24}}>
        {steps.map((step,i)=>(
          <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12}}>
            <div style={{width:22,height:22,borderRadius:"50%",background:m.acc+"22",border:`1px solid ${m.acc}44`,color:m.acc,fontSize:10,fontFamily:SS,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{i+1}</div>
            <div style={{fontSize:13,color:"rgba(235,228,216,.8)",lineHeight:1.7,fontFamily:SF}}>{step}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:10,justifyContent:"center"}}>
        <button onClick={onRetry} style={{border:"none",borderRadius:20,padding:"11px 24px",background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,color:"#0c0905",fontSize:10,letterSpacing:".12em",cursor:"pointer",fontFamily:SS}}>TRY AGAIN</button>
        <button onClick={onClose} style={{border:`1px solid ${m.acc}33`,borderRadius:20,padding:"11px 24px",background:"transparent",color:`${m.acc}88`,fontSize:10,letterSpacing:".12em",cursor:"pointer",fontFamily:SS}}>CLOSE</button>
      </div>
    </div>
  </div>;
}

function VoiceModeOverlay({mood,listening,speaking,transcript,onClose,onMicToggle,onStopSpeak,speechSpeed,onSpeedChange}){
  const m=MOODS[mood];
  const[t,setT]=useState(0);
  useEffect(()=>{ const iv=setInterval(()=>setT(x=>x+1),180); return()=>clearInterval(iv); },[]);
  const speedLabel=speechSpeed<=0.6?"Slowest":speechSpeed<=0.75?"Slow":speechSpeed<=0.95?"Normal":speechSpeed<=1.2?"Fast":"Fastest";
  return <div style={{position:"fixed",inset:0,zIndex:500,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,.88)",backdropFilter:"blur(20px)"}}>
    <div style={{fontSize:8,color:m.acc,letterSpacing:".22em",fontFamily:SS,marginBottom:28,opacity:.45}}>VOICE MODE</div>
    <Orb size={160} mood={mood} tick={t} speaking={speaking} listening={listening}/>
    <div style={{marginTop:28,textAlign:"center",minHeight:56}}>
      <div style={{fontSize:10,color:m.acc,letterSpacing:".18em",fontFamily:SS,marginBottom:12,opacity:.75}}>
        {speaking?"ECHO IS SPEAKING":listening?"LISTENING TO YOU":"READY"}
      </div>
      {(speaking||listening)&&<div style={{display:"flex",justifyContent:"center",marginBottom:12}}><Wave active bars={13} color={m.acc} h={30}/></div>}
      <div style={{fontSize:13,color:"rgba(235,228,216,.55)",fontFamily:SF,fontStyle:"italic",maxWidth:260,lineHeight:1.85,padding:"0 20px"}}>
        {transcript||(speaking?"Speaking…":listening?"Say something…":"Tap the mic to speak")}
      </div>
    </div>
    <div style={{display:"flex",gap:18,marginTop:40}}>
      <button onClick={onMicToggle} style={{width:66,height:66,borderRadius:"50%",border:"none",cursor:"pointer",fontSize:26,display:"flex",alignItems:"center",justifyContent:"center",transition:"all .25s",
        ...(listening?{background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,color:"#0c0905",boxShadow:`0 0 0 4px ${m.acc}44,0 0 32px ${m.glow}`,animation:"micPulse 1.2s ease-out infinite"}
          :{background:"rgba(196,168,130,.12)",border:`1px solid ${m.acc}44`,color:m.acc})}}>
        {listening?"⏹":"🎙"}
      </button>
      {speaking&&<button onClick={onStopSpeak} style={{width:66,height:66,borderRadius:"50%",border:`1px solid ${m.acc}33`,background:"rgba(196,168,130,.08)",cursor:"pointer",fontSize:22,color:m.acc,display:"flex",alignItems:"center",justifyContent:"center"}}>⏸</button>}
      <button onClick={onClose} style={{width:66,height:66,borderRadius:"50%",border:"1px solid rgba(196,168,130,.22)",background:"rgba(196,168,130,.07)",cursor:"pointer",fontSize:20,color:"rgba(196,168,130,.45)",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
    </div>
    <div style={{display:"flex",alignItems:"center",gap:10,marginTop:24,width:220}}>
      <span style={{fontSize:9,color:"rgba(196,168,130,.3)",fontFamily:SS}}>🐢</span>
      <input type="range" min="0.5" max="1.5" step="0.05" value={speechSpeed} onChange={e=>onSpeedChange(parseFloat(e.target.value))} style={{flex:1,accentColor:m.acc,cursor:"pointer",height:3}}/>
      <span style={{fontSize:9,color:"rgba(196,168,130,.3)",fontFamily:SS}}>🐇</span>
    </div>
    <div style={{marginTop:8,fontSize:7,color:"rgba(196,168,130,.25)",fontFamily:SS,letterSpacing:".08em"}}>SPEED: {speedLabel}</div>
    <div style={{marginTop:12,fontSize:8,color:"rgba(196,168,130,.2)",letterSpacing:".1em",fontFamily:SS}}>TAP 🎙 TO SPEAK · ✕ TO CLOSE</div>
  </div>;
}


// ── ONBOARDING TOUR ───────────────────────────────────────────────────────────
const TOUR_SLIDES = [
  {icon:null,title:"Meet YoEcho",subtitle:"YOUR WISER SELF, BECOMING",body:"YoEcho is an AI companion built by Steven Sema, founder of SayMyTech Developers, Kampala. Steven studied Computer Science at Makerere University and builds AI apps that help real people — in health, education, speech, and emotional wellbeing. YoEcho is his most personal creation.",accent:"#c4a882"},
  {icon:"🧠",title:"YoEcho Remembers You",subtitle:"PERSISTENT MEMORY",body:"Echo remembers everything across sessions — your name, fears, goals, conversations. It picks up exactly where you left off, every time.",accent:"#90d0a0"},
  {icon:"🔑",title:"Your YoYoEcho Key",subtitle:"YOUR PRIVATE IDENTITY",body:"Create a personal YoEcho Key — a passphrase only you know. Same key, same memory, every time. Keep it private.",accent:"#f0c060",tip:"Example: my-echo-2024 · steven-saytech · journey-begins"},
  {icon:"◎",title:"Chat with YoEcho",subtitle:"THE MAIN CONVERSATION",body:"Talk about anything. Echo listens, asks one sharp question, and builds a picture of who you are. The more you share, the sharper the reflection.",accent:"#c4a882"},
  {icon:"✦",title:"Your Wiser Self",subtitle:"A DIFFERENT CONVERSATION",body:"YoEcho speaks to you as your future, more evolved self — honest, warm, slightly unsettling. The version of you that has already figured it out.",accent:"#a090c0"},
  {icon:"✎",title:"Private Journal",subtitle:"WRITE FREELY",body:"Write anything without judgment. YoEcho reads your entry and speaks back what it sees — patterns, threads, questions you haven't named yet.",accent:"#d090a0"},
  {icon:"🔊",title:"Echo Speaks & Listens",subtitle:"FULL VOICE SUPPORT",body:"YoEcho speaks every response aloud. Tap 🎙 to speak instead of type. Adjust speed with the slider in the voice bar.",accent:"#90d0a0",tip:"Mic requires browser permission — you'll be asked the first time."},
  {icon:"🗺",title:"Relationships & Anchors",subtitle:"ECHO MAPS YOUR WORLD",body:"YoEcho silently maps the people in your life and marks significant moments as anchors — returning to them when the time is right.",accent:"#a8c482"},
  {icon:"🚀",title:"You're Ready",subtitle:"LET'S BEGIN",body:"Create your YoYoEcho Key to start. Choose something memorable — you'll use it every time. YoEcho will be here, ready to know you.",accent:"#c4a882",isLast:true},
];

function TourScreen({ mood, tick, onFinish }) {
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState(1); // 1=forward, -1=back
  const [animKey, setAnimKey] = useState(0);
  const slide = TOUR_SLIDES[idx];
  const m = MOODS[mood];
  const acc = slide.accent || m.acc;
  const isLast = idx === TOUR_SLIDES.length - 1;

  const go = (newIdx) => {
    if (newIdx < 0 || newIdx >= TOUR_SLIDES.length) return;
    setDir(newIdx > idx ? 1 : -1);
    setAnimKey(k => k + 1);
    setIdx(newIdx);
  };

  const skip = () => onFinish();

  return (
    <div style={{ position:"fixed", inset:0, display:"flex", flexDirection:"column", fontFamily:SF, overflow:"hidden" }}>
      <style>{CSS}
        {`@keyframes slideIn{from{opacity:0;transform:translateX(${dir > 0 ? 32 : -32}px)}to{opacity:1;transform:translateX(0)}}`}
      </style>
      <Bg mood={mood} />

      {/* Skip button */}
      <div style={{ position:"absolute", top:16, right:18, zIndex:20 }}>
        <button onClick={skip} style={{ background:"transparent", border:"1px solid rgba(196,168,130,.2)", borderRadius:20, padding:"6px 14px", color:"rgba(196,168,130,.4)", fontSize:9, letterSpacing:".12em", cursor:"pointer", fontFamily:SS }}>
          SKIP TOUR
        </button>
      </div>

      {/* Progress dots */}
      <div style={{ position:"absolute", top:20, left:0, right:0, display:"flex", justifyContent:"center", gap:6, zIndex:20 }}>
        {TOUR_SLIDES.map((_, i) => (
          <div key={i} onClick={() => go(i)} style={{ width: i === idx ? 20 : 6, height:6, borderRadius:3, cursor:"pointer", transition:"all .3s ease",
            background: i === idx ? acc : "rgba(196,168,130,.2)" }} />
        ))}
      </div>

      {/* Slide content */}
      <div key={animKey} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 24px 16px",textAlign:"center",animation:"slideIn .35s ease forwards",position:"relative",zIndex:10 }}>

        {/* Icon or Orb */}
        <div style={{ marginBottom:28 }}>
          {slide.icon === null
            ? <Orb size={110} mood={mood} tick={tick} speaking={false} />
            : <div style={{ fontSize:58, lineHeight:1, filter:`drop-shadow(0 0 18px ${acc}66)` }}>{slide.icon}</div>
          }
        </div>

        {/* Subtitle tag */}
        <div style={{ fontSize:8, color:acc, letterSpacing:".18em", fontFamily:SS, opacity:.7, marginBottom:12 }}>
          {slide.subtitle}
        </div>

        {/* Title */}
        <h2 style={{ fontSize:28, color:acc, fontWeight:400, fontFamily:SF, margin:"0 0 20px", letterSpacing:".06em", lineHeight:1.2 }}>
          {slide.title}
        </h2>

        {/* Body */}
        <p style={{ fontSize:15, color:"rgba(235,228,216,.75)", lineHeight:1.95, maxWidth:320, margin:"0 0 20px", fontFamily:SF }}>
          {slide.body}
        </p>

        {/* Tip */}
        {slide.tip && (
          <div style={{ background:`${acc}14`, border:`1px solid ${acc}33`, borderRadius:14, padding:"10px 16px", maxWidth:300, marginBottom:8 }}>
            <p style={{ fontSize:12, color:acc, lineHeight:1.75, margin:0, fontFamily:SS, letterSpacing:".04em", opacity:.85 }}>
              {slide.tip}
            </p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div style={{ padding:"0 24px 40px", flexShrink:0, position:"relative", zIndex:10 }}>
        <div style={{ display:"flex", gap:12, maxWidth:360, margin:"0 auto" }}>
          {idx > 0 && (
            <button onClick={() => go(idx - 1)}
              style={{ flex:1, border:"1px solid rgba(196,168,130,.22)", borderRadius:20, padding:"14px", background:"rgba(196,168,130,.07)", color:"rgba(196,168,130,.55)", fontSize:10, letterSpacing:".12em", cursor:"pointer", fontFamily:SS }}>
              ← BACK
            </button>
          )}
          <button onClick={() => isLast ? onFinish() : go(idx + 1)}
            style={{ flex:2, border:"none", borderRadius:20, padding:"14px", fontSize:11, letterSpacing:".14em", cursor:"pointer", fontFamily:SS, transition:"all .2s",
              background:`radial-gradient(circle at 35% 35%,${MOODS[mood].orb[0]},${MOODS[mood].orb[2]})`, color:"#0c0905",
              boxShadow:`0 0 24px ${MOODS[mood].glow}` }}>
            {isLast ? "CREATE MY YOYOECHO KEY →" : "NEXT →"}
          </button>
        </div>

        {/* Swipe hint — only on first slide */}
        {idx === 0 && (
          <p style={{ textAlign:"center", fontSize:8, color:"rgba(196,168,130,.22)", letterSpacing:".1em", fontFamily:SS, marginTop:14 }}>
            TAP NEXT TO EXPLORE · TAP DOTS TO JUMP
          </p>
        )}
      </div>
    </div>
  );
}

// ── LOGIN SCREEN ──────────────────────────────────────────────────────────────
function LoginScreen({mood,tick,onLogin}){
  const m=MOODS[mood];
  const[key,setKey]=useState("");
  const[loading,setLoading]=useState(false);
  const[err,setErr]=useState("");
  const handle=async()=>{
    const k=key.trim().toLowerCase().replace(/\s+/g,"-");
    if(!k||k.length<4){ setErr("Choose a key that's at least 4 characters."); return; }
    setLoading(true); setErr("");
    try{
      let profile=await db.getProfile(k);
      if(!profile) profile=await db.createProfile(k);
      onLogin(k,profile);
    }catch(e){
      console.error("Storage login error:", e);
      setErr("Something went wrong. Try a different key or refresh the page.");
    }
    setLoading(false);
  };
  return <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:SF,padding:24}}>
    <style>{CSS}</style><Bg mood={mood}/>
    <div style={{position:"relative",zIndex:10,textAlign:"center",width:"100%",maxWidth:320}}>
      <div style={{animation:"popIn 1s cubic-bezier(.34,1.56,.64,1) forwards",opacity:0,marginBottom:28}}>
        <Orb size={100} mood={mood} tick={tick}/>
      </div>
      <div style={{animation:"fadeUp .8s .4s ease forwards",opacity:0}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:10}}>
          <YoEchoLogo size={28} color={m.acc} opacity={0.92}/>
        </div>
        <p style={{fontSize:10,color:"rgba(196,168,130,.4)",letterSpacing:".16em",fontFamily:SS,marginBottom:32}}>your wiser self, becoming</p>
        <div style={{background:"rgba(196,168,130,.07)",border:"1px solid rgba(196,168,130,.18)",borderRadius:20,padding:"20px 18px",marginBottom:16}}>
          <p style={{fontSize:13,color:"rgba(235,228,216,.6)",lineHeight:1.85,marginBottom:16,fontStyle:"italic"}}>
            Enter your YoEcho key to reconnect, or create a new one to begin.
          </p>
          <input value={key} onChange={e=>setKey(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter")handle();}}
            placeholder="your-echo-key"
            style={{width:"100%",background:"rgba(196,168,130,.08)",border:"1px solid rgba(196,168,130,.22)",borderRadius:14,padding:"12px 16px",color:"rgba(235,228,216,.9)",fontSize:16,fontFamily:SF,outline:"none",marginBottom:12,boxSizing:"border-box"}}/>
          {err&&<p style={{fontSize:11,color:"#e08070",marginBottom:10,fontFamily:SS}}>{err}</p>}
          <button onClick={handle} disabled={loading||!key.trim()}
            style={{width:"100%",border:"none",borderRadius:16,padding:"13px",fontSize:11,letterSpacing:".14em",fontFamily:SS,cursor:loading||!key.trim()?"not-allowed":"pointer",transition:"all .2s",
              ...(key.trim()&&!loading?{background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,color:"#0c0905"}:{background:"rgba(196,168,130,.1)",color:"rgba(196,168,130,.3)"})}}>
            {loading?<span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><span style={{width:12,height:12,border:`2px solid ${m.acc}`,borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin .8s linear infinite"}}/>CONNECTING…</span>:"ENTER ECHO"}
          </button>
        </div>
        <p style={{fontSize:9,color:"rgba(196,168,130,.25)",letterSpacing:".08em",fontFamily:SS,lineHeight:1.9}}>
          Same key = same YoEcho, same memory, every time.<br/>Works offline — no internet needed for memory.
        </p>
      </div>
    </div>
  </div>;
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
function YoEcho(){
  const[splash,setSplash]=useState(true);
  useEffect(()=>{ const t=setTimeout(()=>setSplash(false),2800); return()=>clearTimeout(t); },[]);
  const[screen,setScreen]    =useState("tour"); // starts with tour on first open
  const[tourDone,setTourDone] =useState(false);
  const[mood,setMood]        =useState("neutral");
  const[tick,setTick]        =useState(0);
  const[menu,setMenu]        =useState(false);
  const[voiceMode,setVoiceMode]=useState(false);
  const[voiceOn,setVoiceOn]  =useState(true);
  const[speechSpeed,setSpeechSpeed]=useState(1.0);
  const[listening,setListening]=useState(false);
  const[speaking,setSpeaking]=useState(false);
  const[transcript,setTranscript]=useState("");
  const[micError,setMicError]=useState("");
  const[micModal,setMicModal]=useState(false);
  const[speakingBubble,setSpeakingBubble]=useState(null);
  const[profileId,setProfileId]=useState(null);
  const[profile,setProfile]  =useState({name:"",values:[],fears:[],goals:[],recurringThemes:[]});
  const[anchors,setAnchors]    =useState([]);
  const[relationships,setRelationships]=useState({});
  const[lastSession,setLastSession]=useState(null);
  const[chatMsgs,setChatMsgs]=useState([]);
  const[chatIn,setChatIn]    =useState("");
  const[chatBusy,setChatBusy]=useState(false);
  const[chatSub,setChatSub]  =useState("here with you");
  const[chatId,setChatId]    =useState(null);   // current chat UUID
  const[chats,setChats]      =useState([]);     // list of all chats
  const[showScrollBtn,setShowScrollBtn]=useState(false);
  const chatScrollRef        =useRef(null);
  const[wiserMsgs,setWiserMsgs]=useState([]);
  const[wiserIn,setWiserIn]  =useState("");
  const[wiserBusy,setWiserBusy]=useState(false);
  const[jText,setJText]      =useState("");
  const[jBusy,setJBusy]      =useState(false);
  const[jReply,setJReply]    =useState(null);
  const[debateIdx,setDebateIdx]=useState(0);
  const[debateMsgs,setDebateMsgs]=useState([]);
  const[debateIn,setDebateIn]  =useState("");
  const[debateBusy,setDebateBusy]=useState(false);
  const[debateActive,setDebateActive]=useState(false); // true = live debate running
  const[homeNudge,setHomeNudge]=useState(null);        // {text, source} or null
  const[nudgeLoading,setNudgeLoading]=useState(false);
  const[moodLog,setMoodLog]  =useState([]);
  const[totalMsgs,setTotalMsgs]=useState(0);
  const[dbSaving,setDbSaving]=useState(false);
  const[journalInsights,setJournalInsights]=useState([]);
  const[beliefHitsStored,setBeliefHitsStored]=useState({});
  const[tutorMsgs,setTutorMsgs]=useState([]);
  const[tutorIn,setTutorIn]  =useState("");
  const[tutorBusy,setTutorBusy]=useState(false);
  const lastEcho=useRef(""); const recRef=useRef(null); const onFinalRef=useRef(null); const silenceTimer=useRef(null);
  const chatEnd=useRef(); const wiserEnd=useRef();

  // ── FAVICON + TAB TITLE INJECTION ──────────────────────────────────────────
  useEffect(()=>{
    // Set browser tab title
    document.title = "YoEcho";
    // Inject SVG favicon — orb icon in YoEcho amber/gold palette
    const svgFavicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <defs>
        <radialGradient id="orbG" cx="38%" cy="35%" r="60%">
          <stop offset="0%" stop-color="#f0c060"/>
          <stop offset="50%" stop-color="#c48820"/>
          <stop offset="100%" stop-color="#4a3520"/>
        </radialGradient>
        <radialGradient id="glowG" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgba(196,168,130,0.3)"/>
          <stop offset="100%" stop-color="transparent"/>
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="url(#glowG)"/>
      <circle cx="32" cy="32" r="22" fill="url(#orbG)"/>
      <circle cx="24" cy="24" r="7" fill="rgba(255,255,255,0.18)"/>
    </svg>`;
    const blob = new Blob([svgFavicon], {type:"image/svg+xml"});
    const url  = URL.createObjectURL(blob);
    // Remove existing favicons
    document.querySelectorAll('link[rel*="icon"]').forEach(el=>el.remove());
    const link = document.createElement("link");
    link.rel  = "icon"; link.type = "image/svg+xml"; link.href = url;
    document.head.appendChild(link);
    return () => URL.revokeObjectURL(url);
  },[]);

  useEffect(()=>{ initVoice(); const iv=setInterval(()=>setTick(t=>t+1),200); return()=>clearInterval(iv); },[]);

  // Keep React speaking state in sync with actual TTS engine every 300ms
  // This catches cases where cancel() fires but onEnd never fires (Chrome bug)
  useEffect(()=>{
    const iv = setInterval(()=>{
      if(!window.speechSynthesis) return;
      const engineSpeaking = window.speechSynthesis.speaking;
      // If engine is idle but React thinks it's speaking — fix the state
      setSpeaking(prev => {
        if(prev && !engineSpeaking) {
          setSpeakingBubble(null);
          return false;
        }
        return prev;
      });
    }, 300);
    return ()=>clearInterval(iv);
  },[]);
  useEffect(()=>{ chatEnd.current?.scrollIntoView({behavior:"smooth"}); },[chatMsgs]);
  useEffect(()=>{ wiserEnd.current?.scrollIntoView({behavior:"smooth"}); },[wiserMsgs]);
  useEffect(()=>{ debateEnd.current?.scrollIntoView({behavior:"smooth"}); },[debateMsgs]);

  const m=MOODS[mood];

  // ── ON LOGIN ────────────────────────────────────────────────────────────────
  // Generate a short UUID for chat IDs
  const newChatId=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);

  // Create a new chat and switch to it
  const createNewChat=useCallback(async(profileIdParam)=>{
    const pid=profileIdParam||profileId;
    if(!pid) return;
    const id=newChatId();
    const welcome="What's on your mind?";
    const newChat={id,title:"New conversation",created:Date.now(),lastMsg:welcome,lastTs:Date.now()};
    const updatedChats=[newChat,...(chats||[])];
    setChats(updatedChats);
    setChatId(id);
    setChatMsgs([{role:"echo",content:welcome,mood:"neutral"}]);
    lastEcho.current=welcome;
    await db.saveChats(pid,updatedChats);
    await db.appendChatMsg(pid,id,{role:"echo",content:welcome,mood:"neutral",ts:Date.now()});
    setTimeout(()=>echoSpeakRef.current?.(welcome,0),700);
    setScreen("chat");
  },[profileId,chats]);

  const handleLogin=useCallback(async(key,dbProfile)=>{
    setProfileId(key);
    const p={name:dbProfile.name||"",values:dbProfile.values||[],fears:dbProfile.fears||[],goals:dbProfile.goals||[],recurringThemes:dbProfile.recurring_themes||[]};
    setProfile(p); setMoodLog(dbProfile.mood_log||[]); setTotalMsgs(dbProfile.total_msgs||0);
    // Load persisted anchors + relationships + last session
    const [storedAnchors, storedRels, lastSess, storedJInsights, storedBeliefHits] = await Promise.all([
      db.getAnchors(key), db.getRelationships(key), db.getLastSession(key),
      db.getJournalInsights(key), db.getBeliefHits(key)
    ]);
    setAnchors(storedAnchors||[]); setRelationships(storedRels||{}); setLastSession(lastSess);
    setJournalInsights(storedJInsights||[]); setBeliefHitsStored(storedBeliefHits||{});
    try{
      // Load chat list
      let storedChats=await db.getChats(key)||[];
      setChats(storedChats);
      // Pick most recent chat or create first one
      let activeChatId=storedChats[0]?.id||null;
      let msgs=[];
      if(activeChatId){
        msgs=await db.getChatMsgs(key,activeChatId)||[];
        // Fallback: try legacy single-chat storage
        if(msgs.length===0) msgs=await db.getMessages(key,"chat")||[];
      }
      setChatId(activeChatId);
      if(msgs.length>0){
        setChatMsgs(msgs.map(r=>({role:r.role,content:r.content,mood:r.mood||"neutral",tag:r.tag||null,tagColor:r.tag_color||null})));
        const lastEchoMsg=msgs.filter(r=>r.role==="echo").slice(-1)[0];
        if(lastEchoMsg) lastEcho.current=lastEchoMsg.content;
        if(lastSess && (Date.now()-lastSess.ts) > 60*60*1000){ // only if >1hr since last visit
          const gap=timeSince(lastSess.ts);
          const arc=moodArcSummary(dbProfile.mood_log||[]);
          const recentAnchors=(storedAnchors||[]).slice(-2).map(a=>a.quote.slice(0,80)).join("; ");
          const journalHint = (storedJInsights||[]).slice(-1)[0]?.insight || "";
          const ctx=`Returning user. Gap: ${gap}. Last mood: ${lastSess.mood||"?"}. Last topic: "${(lastSess.lastMsg||"").slice(0,100)}". ${arc}
${recentAnchors?"Recent anchors (significant moments): "+recentAnchors+".":""}
${journalHint?"Their last journal insight: \""+journalHint+"\"":""} 
Open with ONE warm sentence that references SOMETHING SPECIFIC from what you know — the gap, an anchor, or their journal. Not generic. ONE question. No preamble. Be real and a little surprising.`;
          try{
            const raw=await callClaude([{role:"user",content:"[returning user — open the session]"}],ctx);
            const opening=stripMood(stripRelUpdate(stripAnchor(raw)));
            lastEcho.current=opening;
            setChatMsgs(p=>[...p,{role:"echo",content:opening,mood:parseMood(raw)||"neutral",tag:"ECHO REMEMBERS",tagColor:"#82a8c4"}]);
            await db.saveMessage(key,"chat","echo",opening,parseMood(raw)||"neutral","ECHO REMEMBERS","#82a8c4");
            setTimeout(()=>echoSpeakRef.current?.(opening,msgs.length),800);
          }catch(e){}
        }
      } else {
        const welcome=`Hey${p.name?" "+p.name:""}. I'm YoEcho.\n\nI was built by Steven Sema — a software developer from Kampala who studied CS at Makerere University and founded SayMyTech Developers. He builds AI apps that matter: health, education, speech therapy, and now this — a companion that actually knows you.\n\nI'm not a generic assistant. I have opinions. I push back when I think you're wrong. And I'll tell you when you're right, and mean it.\n\nWhat's your name? And what's actually going on with you right now?`;
        lastEcho.current=welcome;
        const firstId=newChatId();
        setChatId(firstId);
        const firstChat={id:firstId,title:"First conversation",created:Date.now(),lastMsg:welcome,lastTs:Date.now()};
        setChats([firstChat]);
        await db.saveChats(key,[firstChat]);
        setChatMsgs([{role:"echo",content:welcome,mood:"neutral"}]);
        await db.appendChatMsg(key,firstId,{role:"echo",content:welcome,mood:"neutral",ts:Date.now()});
        setTimeout(()=>echoSpeakRef.current?.(welcome,0),900);
      }
    }catch(e){ console.warn("Failed to load messages:",e); }
    await db.saveLastSession(key,{ts:Date.now(),mood:"neutral",lastMsg:""});
    setScreen("home");
    // Generate proactive nudge async — non-blocking, fires after login settles
    if((dbProfile.total_msgs||0) >= 4) {
      setTimeout(async () => {
        try {
          setNudgeLoading(true);
          const nudgeCtx = buildNudgeCtx(
            {name:dbProfile.name||"",values:dbProfile.values||[],fears:dbProfile.fears||[],goals:dbProfile.goals||[]},
            dbProfile.mood_log||[], storedAnchors||[], storedJInsights||[], lastSess
          );
          const raw = await callClaude([{role:"user",content:"[generate home nudge]"}], nudgeCtx);
          const text = raw.replace(/^MOOD:\w+\n?/m,"").trim();
          if(text && text.length > 10) setHomeNudge({text, source:"echo"});
        } catch(e) {}
        setNudgeLoading(false);
      }, 1200);
    }
  },[]);

  // ── SPEAK ───────────────────────────────────────────────────────────────────
  const echoSpeak=useCallback((text,bKey=null)=>{
    if(!voiceOn||!text) return;
    // speakText() handles cancel internally — just set state
    setSpeaking(false);
    setSpeakingBubble(bKey!==null ? bKey : null);
    speakText(
      text, mood,
      ()=>setSpeaking(true),                              // onStart
      ()=>{ setSpeaking(false); setSpeakingBubble(null); }, // onEnd
      speechSpeed
    );
  },[voiceOn,mood,speechSpeed]);

  // Ref so handleLogin can call echoSpeak before state is set
  const echoSpeakRef=useRef(echoSpeak);
  useEffect(()=>{ echoSpeakRef.current=echoSpeak; },[echoSpeak]);

  const stopEcho=useCallback(()=>{
    stopSpeaking();
    setSpeaking(false);
    setSpeakingBubble(null);
  },[]);
  const toggleSpeak=useCallback(()=>{
    // Check actual engine state, not just React state (avoids stale closure)
    const actuallyPlaying = window.speechSynthesis?.speaking || speaking;
    if(actuallyPlaying) stopEcho();
    else if(lastEcho.current) echoSpeak(lastEcho.current);
  },[speaking,stopEcho,echoSpeak]);
  const handleBubbleSpeak=useCallback((text,key)=>{
    const actuallyPlaying = window.speechSynthesis?.speaking || speaking;
    if(speakingBubble===key && actuallyPlaying) stopEcho();
    else echoSpeak(text,key);
  },[speakingBubble,speaking,stopEcho,echoSpeak]);

  // ── LISTEN ──────────────────────────────────────────────────────────────────
  const stopListening=useCallback(()=>{
    if(silenceTimer.current){clearTimeout(silenceTimer.current);silenceTimer.current=null;}
    if(recRef.current){try{recRef.current.stop();}catch(e){}try{recRef.current.abort();}catch(e){}recRef.current=null;}
    setListening(false); setTranscript(""); setMicError("");
  },[]);

  const startListening=useCallback(onFinal=>{
    setMicError(""); setMicModal(false);
    if(!hasSpeechRecognition()){setMicError("Speech recognition needs Chrome or Edge.");return;}
    onFinalRef.current=onFinal;
    if(recRef.current){try{recRef.current.abort();}catch(e){}recRef.current=null;}
    stopEcho(); setListening(true); setTranscript("Listening…");
    const rec=startRecognitionSync(
      text=>setTranscript(text),
      text=>{setListening(false);setTranscript("");recRef.current=null;onFinalRef.current?.(text);},
      err=>{setListening(false);setTranscript("");recRef.current=null;
        if(err==="not-allowed"||err==="no-support"||err==="start-failed") setMicModal(true);
        else if(err==="network") setMicError("Network error. Check your connection.");
        else if(err!=="no-speech") setMicError("Mic error: "+err+". Tap again.");}
    );
    recRef.current=rec;
  },[stopEcho]);

  const toggleMic=useCallback(onFinal=>{ if(listening) stopListening(); else startListening(onFinal); },[listening,stopListening,startListening]);

  // ── APPLY MOOD & PROFILE ────────────────────────────────────────────────────
  const applyMood=useCallback((raw,pid)=>{
    const d=parseMood(raw); if(!d) return;
    setMood(d);
    const entry={date:Date.now(),mood:d};
    setMoodLog(p=>{
      const next=[...p.slice(-59),entry];
      if(pid) db.updateProfile(pid,{mood_log:next}).catch(()=>{});
      return next;
    });
  },[]);

  const applyProfile=useCallback((raw,pid)=>{
    const upd=extractPU(raw); if(!upd) return;
    setProfile(prev=>{
      const next={...prev};
      if(upd.name?.trim()&&!prev.name) next.name=upd.name.trim();
      ["values","fears","goals","recurringThemes"].forEach(k=>{
        const dbKey=k==="recurringThemes"?"recurring_themes":k;
        if(upd[k]?.length){
          const ex=new Set((prev[k]||[]).map(s=>s.toLowerCase()));
          next[k]=[...(prev[k]||[]),...(upd[k]||[]).filter(v=>v&&!ex.has(v.toLowerCase()))].slice(-8);
        }
        if(pid){
          const patch={};
          patch[dbKey]=next[k];
          if(upd.name?.trim()&&!prev.name) patch.name=next.name;
          db.updateProfile(pid,patch).catch(()=>{});
        }
      });
      return next;
    });
  },[]);

  // ── SEND CHAT ───────────────────────────────────────────────────────────────
  const sendChat=useCallback(async override=>{
    const text=(override||chatIn).trim(); if(!text||chatBusy) return;
    setChatBusy(true); setChatIn(""); setChatSub("thinking…");
    const uMsg={role:"user",content:text};
    setChatMsgs(p=>[...p,uMsg]);
    if(profileId&&chatId) db.appendChatMsg(profileId,chatId,{role:"user",content:text,mood,ts:Date.now()}).catch(()=>{});
    const history=[...chatMsgs,uMsg];
    try{
      const arc=moodArcSummary(moodLog);
      const raw=await callClaude(history,buildSys(profile,arc,anchors,relationships));
      applyMood(raw,profileId); applyProfile(raw,profileId);
      // Extract relationship updates
      const newRels=extractRelationships(raw,relationships);
      if(Object.keys(newRels).length!==Object.keys(relationships).length){
        setRelationships(newRels);
        if(profileId) db.saveRelationships(profileId,newRels).catch(()=>{});
      }
      // Extract anchor if significant moment
      const anchor=extractAnchor(raw,text);
      if(anchor){
        const newAnchors=[...anchors,anchor];
        setAnchors(newAnchors);
        if(profileId) db.saveAnchor(profileId,anchor).catch(()=>{});
      }
      const clean=stripAnchor(stripRelUpdate(stripMood(raw)));
      lastEcho.current=clean;
      const idx=history.length;
      setChatMsgs(p=>[...p,{role:"echo",content:clean,mood:parseMood(raw)||"neutral"}]);
      const newTotal=totalMsgs+2; setTotalMsgs(newTotal);
      if(profileId){
        const cid=chatId;
        if(cid){
          db.appendChatMsg(profileId,cid,{role:"echo",content:clean,mood:parseMood(raw)||"neutral",ts:Date.now()}).catch(()=>{});
          // Update chat title from first user message + lastMsg
          setChats(prev=>{
            const updated=prev.map(ch=>ch.id===cid?{...ch,lastMsg:clean.slice(0,60),lastTs:Date.now(),
              title:ch.title==="New conversation"||ch.title==="First conversation"?text.slice(0,40):ch.title}:ch);
            db.saveChats(profileId,updated).catch(()=>{});
            return updated;
          });
        }
        db.updateProfile(profileId,{total_msgs:newTotal}).catch(()=>{});
        db.saveLastSession(profileId,{ts:Date.now(),mood:parseMood(raw)||"neutral",lastMsg:text.slice(0,120)}).catch(()=>{});
      }
      setChatSub("here with you");
      setTimeout(()=>echoSpeak(clean,idx),350);
      const uc=history.filter(x=>x.role==="user").length;
      if(uc>=8&&Math.random()<.18){
        const det=inferBeliefs(history, beliefHitsStored);
        if(det.length){
          setTimeout(()=>setChatMsgs(p=>[...p,{role:"echo",content:det[0].inference,tag:`DEEP PATTERN · ${det[0].confidence}% confidence`,tagColor:"#a882c4"}]),4500);
          // Persist updated belief hits
          const newHits={...beliefHitsStored,...beliefHits};
          setBeliefHitsStored(newHits);
          if(profileId) db.saveBeliefHits(profileId,newHits).catch(()=>{});
        }
      }
    }catch(err){
      setChatMsgs(p=>[...p,{role:"echo",content:friendlyErrorMsg(err)}]);
      setChatSub("here with you");
    }
    setChatBusy(false);
  },[chatIn,chatBusy,chatMsgs,profile,profileId,mood,totalMsgs,applyMood,applyProfile,echoSpeak]);

  const chatMicToggle=useCallback(()=>{toggleMic(final=>{setChatIn(final);setTimeout(()=>sendChat(final),80);});},[toggleMic,sendChat]);

  // ── INNER MONOLOGUE ─────────────────────────────────────────────────────────
  const fetchMonologue=useCallback(async(bubbleIdx,userMsg,echoReply)=>{
    // Mark bubble as loading
    setChatMsgs(p=>p.map((m,i)=>i===bubbleIdx?{...m,monologueLoading:true}:m));
    try{
      const raw=await callClaude(
        [{role:"user",content:`The user said: "${userMsg}"

You replied: "${echoReply.slice(0,300)}"

What was your real first thought — before the polished reply?`}],
        MONOLOGUE_SYS
      );
      const thought=raw.replace(/^MOOD:\w+\n?/m,"").trim();
      setChatMsgs(p=>p.map((m,i)=>i===bubbleIdx?{...m,monologue:thought,monologueLoading:false}:m));
    }catch(e){
      setChatMsgs(p=>p.map((m,i)=>i===bubbleIdx?{...m,monologue:"I'm not sure I can put it into words right now.",monologueLoading:false}:m));
    }
  },[]);

  // ── TUTOR MODE ───────────────────────────────────────────────────────────────
  const sendTutor=useCallback(async override=>{
    const text=(override||tutorIn).trim(); if(!text||tutorBusy) return;
    setTutorBusy(true); setTutorIn("");
    const uMsg={role:"user",content:text}; setTutorMsgs(p=>[...p,uMsg]);
    try{
      const tutorCtx = profile?.name ? `${TUTOR_SYS}\nStudent: ${profile.name}. Adapt to their known interests and fears where relevant.` : TUTOR_SYS;
      const raw=await callClaude([...tutorMsgs,uMsg], tutorCtx);
      const clean=stripMood(raw); lastEcho.current=clean;
      applyMood(raw,profileId);
      const idx=tutorMsgs.length+1;
      setTutorMsgs(p=>[...p,{role:"echo",content:clean}]);
      setTimeout(()=>echoSpeak(clean,idx),300);
    }catch(e){ setTutorMsgs(p=>[...p,{role:"echo",content:friendlyErrorMsg(e)}]); }
    setTutorBusy(false);
  },[tutorIn,tutorBusy,tutorMsgs,profileId,applyMood,echoSpeak]);

  const tutorMicToggle=useCallback(()=>{toggleMic(final=>{setTutorIn(final);setTimeout(()=>sendTutor(final),80);});},[toggleMic,sendTutor]);

  // ── LIVE DEBATE ─────────────────────────────────────────────────────────────
  const startDebate=useCallback(async(d)=>{
    setDebateMsgs([]); setDebateActive(true); setDebateBusy(true);
    const sys=DEBATE_SYS(d.position, d.tag);
    try{
      const raw=await callClaude([{role:"user",content:"[debate opens — state your position and your first challenge to me]"}],sys);
      applyMood(raw,profileId);
      const clean=stripMood(raw);
      setDebateMsgs([{role:"echo",content:clean,mood:parseMood(raw)||"neutral"}]);
      setTimeout(()=>echoSpeak(clean,0),400);
    }catch(e){setDebateMsgs([{role:"echo",content:friendlyErrorMsg(e)}]);}
    setDebateBusy(false);
  },[profileId,applyMood,echoSpeak]);

  const sendDebate=useCallback(async(override)=>{
    const text=(override||debateIn).trim(); if(!text||debateBusy) return;
    setDebateBusy(true); setDebateIn("");
    const uMsg={role:"user",content:text};
    setDebateMsgs(p=>[...p,uMsg]);
    const d=DEBATES[debateIdx%DEBATES.length];
    const sys=DEBATE_SYS(d.position,d.tag);
    try{
      const history=[...debateMsgs,uMsg];
      const raw=await callClaude(history,sys);
      applyMood(raw,profileId);
      // Check for concession
      const conceded=raw.includes("DEBATE_CONCEDE");
      const clean=stripMood(raw).replace("DEBATE_CONCEDE","").trim();
      const idx=history.length;
      setDebateMsgs(p=>[...p,{role:"echo",content:clean,mood:parseMood(raw)||"neutral",
        tag:conceded?"YOECHO CONCEDES":null,tagColor:conceded?"#90d0a0":null}]);
      setTimeout(()=>echoSpeak(clean,idx),350);
      if(conceded) setDebateActive(false);
    }catch(e){setDebateMsgs(p=>[...p,{role:"echo",content:friendlyErrorMsg(e)}]);}
    setDebateBusy(false);
  },[debateIn,debateBusy,debateMsgs,debateIdx,profileId,applyMood,echoSpeak]);

  const debateMicToggle=useCallback(()=>{toggleMic(final=>{setDebateIn(final);setTimeout(()=>sendDebate(final),80);});},[toggleMic,sendDebate]);
  const debateEnd=useRef();

  // ── WISER ───────────────────────────────────────────────────────────────────
  const bootWiser=useCallback(async()=>{
    setWiserBusy(true);
    if(profileId){try{const msgs=await db.getMessages(profileId,"wiser");if(msgs.length>0){setWiserMsgs(msgs.map(r=>({role:r.role,content:r.content,mood:r.mood})));setWiserBusy(false);return;}}catch(e){}}
    try{
      const enrichedWiserSys = buildModeCtx(WISER_SYS_BASE, profile, anchors, journalInsights, relationships);
      const raw=await callClaude([{role:"user",content:`Open Wiser Self. Begin.`}], enrichedWiserSys);
      applyMood(raw,profileId); const clean=stripMood(raw); lastEcho.current=clean;
      setWiserMsgs([{role:"echo",content:clean}]);
      if(profileId) db.saveMessage(profileId,"wiser","echo",clean,parseMood(raw)||"neutral").catch(()=>{});
      setTimeout(()=>echoSpeak(clean,0),500);
    }catch(e){ setWiserMsgs([{role:"echo",content:friendlyErrorMsg(e)}]); }
    setWiserBusy(false);
  },[profile,profileId,applyMood,echoSpeak]);

  const sendWiser=useCallback(async override=>{
    const text=(override||wiserIn).trim(); if(!text||wiserBusy) return;
    setWiserBusy(true); setWiserIn("");
    const uMsg={role:"user",content:text}; setWiserMsgs(p=>[...p,uMsg]);
    if(profileId) db.saveMessage(profileId,"wiser","user",text,mood).catch(()=>{});
    try{
      const enrichedWiserSys = buildModeCtx(WISER_SYS_BASE, profile, anchors, journalInsights, relationships);
      const raw=await callClaude([...wiserMsgs,uMsg], enrichedWiserSys);
      applyMood(raw,profileId); const clean=stripMood(raw); lastEcho.current=clean;
      const idx=wiserMsgs.length+1;
      setWiserMsgs(p=>[...p,{role:"echo",content:clean}]);
      if(profileId) db.saveMessage(profileId,"wiser","echo",clean,parseMood(raw)||"neutral").catch(()=>{});
      setTimeout(()=>echoSpeak(clean,idx),350);
    }catch(e){ setWiserMsgs(p=>[...p,{role:"echo",content:friendlyErrorMsg(e)}]); }
    setWiserBusy(false);
  },[wiserIn,wiserBusy,wiserMsgs,profileId,mood,applyMood,echoSpeak]);

  const wiserMicToggle=useCallback(()=>{toggleMic(final=>{setWiserIn(final);setTimeout(()=>sendWiser(final),80);});},[toggleMic,sendWiser]);

  // ── JOURNAL ─────────────────────────────────────────────────────────────────
  const submitJournal=useCallback(async()=>{
    if(!jText.trim()||jBusy) return; setJBusy(true);
    try{
      // Enrich journal system prompt with cross-mode memory
      const enrichedJournalSys = buildModeCtx(JOURNAL_SYS_BASE, profile, anchors, journalInsights, relationships);
      const raw=await callClaude([{role:"user",content:`Journal entry:\n\n${jText}`}], enrichedJournalSys);
      applyMood(raw,profileId);
      // Extract journal insight if present
      const insightMatch = raw.match(/JOURNAL_INSIGHT:\{"insight":"([^"]+)"\}/);
      if(insightMatch) {
        const insight = insightMatch[1];
        const newInsights = [...journalInsights, {insight, ts: Date.now()}];
        setJournalInsights(newInsights);
        if(profileId) db.saveJournalInsight(profileId, {insight}).catch(()=>{});
        // Also save as a lightweight anchor so other modes see it
        const jAnchor = {quote: jText.slice(0,200), echo: insight, theme: "journal", ts: Date.now()};
        const newAnchors = [...anchors, jAnchor];
        setAnchors(newAnchors);
        if(profileId) db.saveAnchor(profileId, jAnchor).catch(()=>{});
      }
      // Strip the JOURNAL_INSIGHT tag from display
      const clean=stripMood(raw).replace(/\nJOURNAL_INSIGHT:\{[^}]+\}\n?/m,"").trim();
      lastEcho.current=clean;
      setJReply(clean); setTimeout(()=>echoSpeak(clean),700);
      if(profileId){
        db.saveMessage(profileId,"journal","user",jText,mood).catch(()=>{});
        db.saveMessage(profileId,"journal","echo",clean,parseMood(raw)||"neutral").catch(()=>{});
      }
    }catch(e){ setJReply(friendlyErrorMsg(e)); }
    setJBusy(false);
  },[jText,jBusy,profileId,mood,profile,anchors,journalInsights,relationships,applyMood,echoSpeak]);

  const go=useCallback(s=>{
    setMenu(false);
    if(s==="wiser"&&wiserMsgs.length===0) bootWiser();
    setScreen(s);
  },[wiserMsgs.length,bootWiser]);

  // ── SHARED STYLES ────────────────────────────────────────────────────────────
  const cardS={padding:"14px 16px",background:"rgba(196,168,130,.08)",border:"1px solid rgba(196,168,130,.17)",borderRadius:17,marginBottom:11};
  const lblS={fontSize:8,color:m.acc,letterSpacing:".14em",marginBottom:9,fontFamily:SS,opacity:.62,textTransform:"uppercase"};
  const scrollS={flex:1,overflowY:"auto",padding:"18px 14px 12px",maxWidth:640,margin:"0 auto",width:"100%",position:"relative",zIndex:5};
  const infoS={flex:1,overflowY:"auto",padding:"16px 14px",maxWidth:600,margin:"0 auto",width:"100%",position:"relative",zIndex:5};

  const VBar=()=><VoiceBar mood={mood} speaking={speaking} listening={listening} voiceOn={voiceOn}
    onToggle={()=>{ if(speaking)stopEcho(); setVoiceOn(v=>!v); }}
    onVoiceMode={()=>setVoiceMode(true)} speechSpeed={speechSpeed} onSpeedChange={setSpeechSpeed}/>;

  const MicModal=({onRetry})=>micModal?<MicPermissionModal mood={mood} onClose={()=>setMicModal(false)} onRetry={()=>{setMicModal(false);setTimeout(onRetry,100);}}/>:null;

  const MenuOverlay=()=>(
    <div style={{position:"fixed",inset:0,zIndex:200}}>
      <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.72)",backdropFilter:"blur(9px)"}} onClick={()=>setMenu(false)}/>
      <div style={{position:"absolute",right:0,top:0,bottom:0,width:"76%",maxWidth:285,background:"rgba(10,7,4,.97)",borderLeft:"1px solid rgba(196,168,130,.16)",display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"28px 22px 16px",borderBottom:"1px solid rgba(196,168,130,.13)"}}>
          <h2 style={{fontSize:20,color:m.acc,letterSpacing:".24em",fontWeight:400,fontFamily:SF,margin:0}}>ECHO</h2>
          <p style={{fontSize:8,color:"rgba(196,168,130,.36)",marginTop:4,letterSpacing:".08em",fontFamily:SS}}>your wiser self, becoming</p>
          {profileId&&<p style={{fontSize:8,color:m.acc,opacity:.4,marginTop:6,fontFamily:SS,letterSpacing:".06em"}}>key: {profileId}</p>}
        </div>
        <div style={{flex:1,overflowY:"auto",overflowX:"hidden",WebkitOverflowScrolling:"touch",paddingBottom:8}}>
          {[["⌂","Home","home"],["◎","Chat","chat"],["✦","Wiser You","wiser"],["✎","Journal","journal"],["⚡","Debates","debate"],["◉","Deep Beliefs","beliefs"],["◈","Patterns","patterns"],["🗺","Relationships","relationships"],["⚓","Anchors","anchors"],["🎓","Tutor Mode","tutor"],["◬","Echo State","echostate"]].map(([ico,lbl,sc])=>(
            <button key={sc} onClick={()=>go(sc)} style={{width:"100%",padding:"12px 22px",background:"transparent",border:"none",borderLeft:"2px solid transparent",color:"rgba(196,168,130,.62)",cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:13,fontFamily:SF,fontSize:14,minHeight:46}}>
              <span style={{fontSize:14,opacity:.65}}>{ico}</span>{lbl}
            </button>
          ))}
          <button onClick={()=>{setMenu(false);setScreen("tour");}}
            style={{width:"100%",padding:"12px 22px",background:"transparent",border:"none",borderLeft:"2px solid transparent",color:"rgba(196,168,130,.3)",cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:13,fontFamily:SF,fontSize:14,minHeight:46}}>
            <span style={{fontSize:14,opacity:.65}}>◉</span>App Tour
          </button>
          <button onClick={()=>{setMenu(false);setScreen("login");setChatMsgs([]);setWiserMsgs([]);setProfileId(null);stopEcho();}}
            style={{width:"100%",padding:"12px 22px",background:"transparent",border:"none",borderLeft:"2px solid transparent",color:"rgba(196,168,130,.3)",cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:13,fontFamily:SF,fontSize:14,minHeight:46}}>
            <span style={{fontSize:14,opacity:.65}}>⎋</span>Switch Key
          </button>
        </div>
        <div style={{flexShrink:0,padding:"12px 22px 18px",borderTop:"1px solid rgba(196,168,130,.11)",fontSize:8,color:"rgba(196,168,130,.26)",lineHeight:2.2,fontFamily:SS}}>
          YOECHO v9 · MEMORY + VOICE + CLAUDE<br/>SayMyTech Developers · Kampala, Uganda<br/>Built by Steven Sema
        </div>
      </div>
    </div>
  );

  // ── TOUR ─────────────────────────────────────────────────────────────────────
  if(screen==="tour") return <TourScreen mood={mood} tick={tick} onFinish={()=>setScreen("login")} />;

  // ── SPLASH SCREEN ───────────────────────────────────────────────────────────
  if(splash) return(
    <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",alignItems:"center",
      justifyContent:"center",fontFamily:SF,background:"#0c0905",zIndex:9999}}
      onClick={()=>setSplash(false)}>
      <style>{CSS}</style>
      <style>{`
        @keyframes splashOrb {
          0%   { transform:scale(0.3); opacity:0; }
          60%  { transform:scale(1.08); opacity:1; }
          80%  { transform:scale(0.96); }
          100% { transform:scale(1); opacity:1; }
        }
        @keyframes splashTitle {
          0%   { opacity:0; transform:translateY(18px) scale(0.95); }
          100% { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes splashSub {
          0%   { opacity:0; }
          100% { opacity:1; }
        }
        @keyframes splashDot {
          0%,100% { transform:scale(1); opacity:0.3; }
          50%     { transform:scale(1.8); opacity:1; }
        }
        @keyframes splashFade {
          0%  { opacity:1; }
          100%{ opacity:0; pointer-events:none; }
        }
      `}</style>
      {/* Glow ring behind orb */}
      <div style={{position:"relative",marginBottom:36,animation:"splashOrb .9s cubic-bezier(.34,1.56,.64,1) forwards"}}>
        <div style={{position:"absolute",inset:-24,borderRadius:"50%",
          background:"radial-gradient(circle,rgba(196,168,130,.18) 0%,transparent 70%)",
          animation:"dot 2s ease-in-out infinite"}}/>
        <Orb size={140} mood="neutral" tick={tick} speaking={false}/>
      </div>
      {/* Title */}
      <div style={{animation:"splashTitle .7s .55s cubic-bezier(.34,1.2,.64,1) both"}}>
        <div style={{fontSize:38,letterSpacing:".32em",color:"#c4a882",fontWeight:300,
          fontFamily:SF,textAlign:"center",marginBottom:10}}>
          YOECHO
        </div>
      </div>
      {/* Tagline */}
      <div style={{animation:"splashSub .8s 1.1s ease both"}}>
        <div style={{fontSize:10,color:"rgba(196,168,130,.4)",letterSpacing:".2em",
          fontFamily:SS,textAlign:"center",marginBottom:48}}>
          YOUR WISER SELF, BECOMING
        </div>
      </div>
      {/* Loading dots */}
      <div style={{display:"flex",gap:8,animation:"splashSub .6s 1.4s ease both",opacity:0}}>
        {[0,1,2].map(i=>(
          <div key={i} style={{width:5,height:5,borderRadius:"50%",background:"#c4a882",
            animation:`splashDot 1.4s ${i*.2}s ease-in-out infinite`}}/>
        ))}
      </div>
      {/* Tap to continue */}
      <div style={{position:"absolute",bottom:36,fontSize:8,color:"rgba(196,168,130,.2)",
        letterSpacing:".18em",fontFamily:SS,animation:"splashSub .6s 2s ease both",opacity:0}}>
        TAP TO CONTINUE
      </div>
      {/* Auto-dismiss handled by useEffect below */}
    </div>
  );

  // ── LOGIN ────────────────────────────────────────────────────────────────────
  if(screen==="login") return <LoginScreen mood={mood} tick={tick} onLogin={handleLogin}/>;

  // ── HOME ─────────────────────────────────────────────────────────────────────
  if(screen==="home") return(
    <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
      <style>{CSS}</style><Bg mood={mood}/>
      <div style={{padding:"14px 18px 0",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0,position:"relative",zIndex:10}}>
        <div style={{display:"flex",flexDirection:"column",gap:3}}>
          <YoEchoLogo size={18} color={m.acc} opacity={0.75}/>
          {profile.name&&<div style={{fontSize:7,color:m.acc,opacity:.35,letterSpacing:".14em",fontFamily:SS}}>{profile.name.toUpperCase()}</div>}
          <div style={{fontSize:7,color:m.acc,opacity:.28,letterSpacing:".1em",fontFamily:SS}}>MEMORY + VOICE + CLAUDE · SAYTECH</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={()=>{if(speaking)stopEcho();setVoiceOn(v=>!v);}} style={{background:"transparent",border:"none",fontSize:17,cursor:"pointer",opacity:voiceOn?1:.35,lineHeight:1}}>{voiceOn?"🔊":"🔇"}</button>
          <button onClick={()=>setMenu(true)} style={{background:"rgba(196,168,130,.09)",border:"1px solid rgba(196,168,130,.24)",borderRadius:19,padding:"7px 15px",color:m.acc,fontSize:9,letterSpacing:".12em",cursor:"pointer",fontFamily:SS}}>MENU</button>
        </div>
      </div>
      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,position:"relative",zIndex:5}}>
        <div style={{fontSize:8,color:m.acc,opacity:.28,letterSpacing:".22em",fontFamily:SS}}>YOECHO</div>
        <Orb size={188} mood={mood} tick={tick} onClick={()=>go("chat")} speaking={speaking} listening={listening}/>
        {(speaking||listening)&&<Wave active bars={9} color={m.acc} h={26}/>}
        {/* Proactive nudge — YoEcho observes something */}
        {nudgeLoading&&!homeNudge&&(
          <div style={{maxWidth:280,textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",gap:8,opacity:.3}}>
            <div style={{width:4,height:4,borderRadius:"50%",background:m.acc,animation:"dot 1.4s 0s ease-in-out infinite"}}/>
            <div style={{width:4,height:4,borderRadius:"50%",background:m.acc,animation:"dot 1.4s .22s ease-in-out infinite"}}/>
            <div style={{width:4,height:4,borderRadius:"50%",background:m.acc,animation:"dot 1.4s .44s ease-in-out infinite"}}/>
          </div>
        )}
        {homeNudge&&!speaking&&!listening&&(
          <div style={{maxWidth:288,textAlign:"center",position:"relative",padding:"0 10px",animation:"fadeUp .7s ease forwards"}}>
            <div style={{fontSize:13,color:m.acc,lineHeight:1.9,fontStyle:"italic",opacity:.72,letterSpacing:".01em",fontFamily:SF}}>
              {homeNudge.text}
            </div>
            <button onClick={()=>setHomeNudge(null)}
              style={{position:"absolute",top:-8,right:2,background:"transparent",border:"none",color:"rgba(196,168,130,.25)",fontSize:12,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
        )}
        {!homeNudge&&!nudgeLoading&&chatMsgs.filter(x=>x.role==="echo").length>0&&!speaking&&!listening&&(
          <div onClick={()=>go("chat")} style={{maxWidth:296,textAlign:"center",fontSize:12,opacity:.3,lineHeight:1.88,fontStyle:"italic",padding:"0 10px",cursor:"pointer"}}>
            "{chatMsgs.filter(x=>x.role==="echo").slice(-1)[0]?.content?.slice(0,80)}…"
          </div>
        )}
      </div>
      <div style={{padding:"0 14px 20px",flexShrink:0,position:"relative",zIndex:10}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:9}}>
          {[["✦","WISER","wiser"],["◎","CHAT","chat"],["⚡","DEBATE","debate"],["✎","JOURNAL","journal"]].map(([ico,lbl,sc])=>(
            <button key={sc} onClick={()=>go(sc)} style={{padding:"13px 4px 11px",borderRadius:19,cursor:"pointer",fontFamily:SS,display:"flex",flexDirection:"column",alignItems:"center",gap:5,border:"1px solid rgba(196,168,130,.15)",background:"rgba(196,168,130,.07)",color:"rgba(196,168,130,.6)"}}>
              <span style={{fontSize:19}}>{ico}</span><span style={{fontSize:7,letterSpacing:".1em"}}>{lbl}</span>
            </button>
          ))}
        </div>
      </div>
      {menu&&<MenuOverlay/>}
      {voiceMode&&<VoiceModeOverlay mood={mood} listening={listening} speaking={speaking} transcript={transcript} onClose={()=>setVoiceMode(false)} onMicToggle={chatMicToggle} onStopSpeak={stopEcho} speechSpeed={speechSpeed} onSpeedChange={setSpeechSpeed}/>}
      <MicModal onRetry={chatMicToggle}/>
    </div>
  );

  // ── CHAT ─────────────────────────────────────────────────────────────────────
  // ── CHATS LIST ───────────────────────────────────────────────────────────────
  if(screen==="chats") return(
    <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
      <style>{CSS}</style><Bg mood={mood}/>
      <Hdr title="CONVERSATIONS" sub="all your chats with YoEcho" onBack={()=>setScreen("chat")} mood={mood}
        right={<button onClick={()=>createNewChat()}
          style={{background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,border:"none",borderRadius:16,padding:"7px 14px",color:"#0c0905",fontSize:9,letterSpacing:".1em",cursor:"pointer",fontFamily:SS,fontWeight:700}}>
          + NEW CHAT
        </button>}/>
      <div style={{flex:1,overflowY:"auto",padding:"12px 14px",maxWidth:600,margin:"0 auto",width:"100%",zIndex:5}}>
        {chats.length===0?(
          <div style={{textAlign:"center",padding:"48px 0",color:"rgba(255,255,255,.18)",fontSize:14,fontStyle:"italic"}}>No conversations yet.</div>
        ):(
          chats.map(ch=>{
            const isActive=ch.id===chatId;
            return(
              <div key={ch.id} onClick={async()=>{
                  if(isActive){setScreen("chat");return;}
                  // Load this chat's messages
                  const msgs=await db.getChatMsgs(profileId,ch.id)||[];
                  setChatMsgs(msgs.map(r=>({role:r.role,content:r.content,mood:r.mood||"neutral",tag:r.tag||null,tagColor:r.tag_color||null})));
                  setChatId(ch.id);
                  const last=msgs.filter(r=>r.role==="echo").slice(-1)[0];
                  if(last) lastEcho.current=last.content;
                  setScreen("chat");
                }}
                style={{padding:"14px 16px",background:isActive?m.acc+"14":"rgba(196,168,130,.06)",border:`1px solid ${isActive?m.acc+"44":"rgba(196,168,130,.13)"}`,borderRadius:16,marginBottom:10,cursor:"pointer",transition:"all .2s"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:5}}>
                  <div style={{fontSize:14,color:isActive?m.acc:"rgba(235,228,216,.8)",fontFamily:SF,flex:1,marginRight:8}}>{ch.title||"Conversation"}</div>
                  <div style={{fontSize:8,color:"rgba(196,168,130,.35)",fontFamily:SS,flexShrink:0}}>{ch.lastTs?timeSince(ch.lastTs):""}</div>
                </div>
                <div style={{fontSize:12,color:"rgba(235,228,216,.4)",fontFamily:SF,fontStyle:"italic",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ch.lastMsg||"…"}</div>
                {isActive&&<div style={{fontSize:7,color:m.acc,fontFamily:SS,letterSpacing:".1em",marginTop:6,opacity:.7}}>CURRENT</div>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  if(screen==="chat") return(
    <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
      <style>{CSS}</style><Bg mood={mood}/>
      <Hdr title="YOECHO" sub={chatSub} onBack={()=>setScreen("home")} mood={mood}
        right={<div style={{display:"flex",gap:7,alignItems:"center"}}>
          <button onClick={()=>setScreen("chats")} style={{background:"rgba(196,168,130,.09)",border:"1px solid rgba(196,168,130,.22)",borderRadius:14,padding:"5px 10px",color:m.acc,fontSize:8,letterSpacing:".1em",cursor:"pointer",fontFamily:SS}}>☰ CHATS</button>
          <button onClick={()=>createNewChat()} style={{background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,border:"none",borderRadius:14,padding:"5px 10px",color:"#0c0905",fontSize:8,letterSpacing:".1em",cursor:"pointer",fontFamily:SS,fontWeight:700}}>+ NEW</button>
          <Orb size={28} mood={mood} tick={tick} speaking={speaking} listening={listening}/>
        </div>}/>
      <VBar/>
      <div ref={chatScrollRef} style={{...scrollS}}
        onScroll={e=>{const el=e.target;setShowScrollBtn(el.scrollHeight-el.scrollTop-el.clientHeight>100);}}>
        {chatMsgs.map((msg,i)=>{
          const prevUser=msg.role==="echo"?chatMsgs.slice(0,i).filter(m=>m.role==="user").slice(-1)[0]:null;
          return <Bubble key={i} msg={msg} mood={mood} activeSpeaking={speakingBubble===i}
            onSpeak={text=>handleBubbleSpeak(text,i)}
            onMonologue={msg.role==="echo"&&!msg.monologue&&!msg.monologueLoading&&prevUser
              ?()=>fetchMonologue(i,prevUser.content,msg.content):null}/>;
        })}
        {chatBusy&&<Dots mood={mood}/>}
        <div ref={chatEnd}/>
      </div>
      {showScrollBtn&&<button onClick={()=>{chatEnd.current?.scrollIntoView({behavior:"smooth"});setShowScrollBtn(false);}}
        style={{position:"absolute",bottom:80,left:"50%",transform:"translateX(-50%)",zIndex:30,display:"flex",alignItems:"center",gap:5,padding:"7px 18px",background:"rgba(10,7,4,.92)",border:`1px solid ${m.acc}44`,borderRadius:20,color:m.acc,fontSize:10,letterSpacing:".08em",cursor:"pointer",fontFamily:SS,backdropFilter:"blur(10px)",boxShadow:"0 4px 20px rgba(0,0,0,.5)"}}>
        ↓ latest
      </button>}
      <IBar value={chatIn} onChange={setChatIn} onSend={()=>sendChat()} busy={chatBusy} mood={mood}
        listening={listening} speaking={speaking} transcript={transcript} micError={micError}
        onMicToggle={chatMicToggle} onSpeakToggle={toggleSpeak}/>
      {voiceMode&&<VoiceModeOverlay mood={mood} listening={listening} speaking={speaking} transcript={transcript} onClose={()=>setVoiceMode(false)} onMicToggle={chatMicToggle} onStopSpeak={stopEcho} speechSpeed={speechSpeed} onSpeedChange={setSpeechSpeed}/>}
      <MicModal onRetry={chatMicToggle}/>
    </div>
  );


  // ── WISER ─────────────────────────────────────────────────────────────────────
  if(screen==="wiser") return(
    <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
      <style>{CSS}</style><Bg mood={mood}/>
      <Hdr title="YOUR WISER SELF" sub="speaking honestly" onBack={()=>setScreen("home")} mood={mood} right={<Orb size={34} mood={mood} tick={tick} speaking={speaking}/>}/>
      <VBar/>
      <div style={scrollS}>
        {wiserMsgs.map((msg,i)=><Bubble key={i} msg={msg} isWiser mood={mood} activeSpeaking={speakingBubble===i} onSpeak={text=>handleBubbleSpeak(text,i)}/>)}
        {wiserBusy&&<Dots mood={mood}/>}
        <div ref={wiserEnd}/>
      </div>
      <IBar value={wiserIn} onChange={setWiserIn} onSend={()=>sendWiser()} busy={wiserBusy} placeholder="Ask your wiser self…" mood={mood}
        listening={listening} speaking={speaking} transcript={transcript} micError={micError}
        onMicToggle={wiserMicToggle} onSpeakToggle={toggleSpeak}/>
      {voiceMode&&<VoiceModeOverlay mood={mood} listening={listening} speaking={speaking} transcript={transcript} onClose={()=>setVoiceMode(false)} onMicToggle={wiserMicToggle} onStopSpeak={stopEcho} speechSpeed={speechSpeed} onSpeedChange={setSpeechSpeed}/>}
      <MicModal onRetry={wiserMicToggle}/>
    </div>
  );

  // ── JOURNAL ───────────────────────────────────────────────────────────────────
  if(screen==="journal"){
    const wc=jText.trim().split(/\s+/).filter(Boolean).length,can=wc>=5&&!jBusy;
    return(
      <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
        <style>{CSS}</style><Bg mood={mood}/>
        <Hdr title="PRIVATE JOURNAL" sub="YoEcho reads · speaks back · remembers" onBack={()=>setScreen("home")} mood={mood} right={<Orb size={26} mood={mood} tick={tick} speaking={speaking}/>}/>
        <div style={infoS}>
          {!jReply?(<>
            <p style={{fontSize:13,color:"rgba(196,168,130,.5)",lineHeight:1.92,marginBottom:16,fontStyle:"italic"}}>Write freely. Nothing here is judged. YoEcho reads, speaks back, and keeps your words in memory.</p>
            <textarea value={jText} onChange={e=>setJText(e.target.value)} placeholder="Today I have been thinking about…"
              style={{width:"100%",minHeight:200,background:"rgba(196,168,130,.07)",border:"1px solid rgba(196,168,130,.14)",borderRadius:19,padding:"17px 19px",color:"rgba(235,228,216,.9)",fontSize:16,lineHeight:1.92,fontFamily:SF,resize:"vertical",outline:"none"}}/>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:13}}>
              <span style={{fontSize:9,color:"rgba(196,168,130,.38)",fontFamily:SS}}>{wc} words</span>
              <button onClick={submitJournal} disabled={!can}
                style={{border:"none",borderRadius:24,padding:"12px 26px",fontSize:10,letterSpacing:".12em",fontFamily:SS,minHeight:44,cursor:can?"pointer":"not-allowed",
                  ...(can?{background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,color:"#0c0905"}:{background:"rgba(196,168,130,.07)",border:"1px solid rgba(196,168,130,.17)",color:"rgba(196,168,130,.34)"})}}>
                {jBusy?"ECHO IS READING…":"SHARE WITH ECHO"}
              </button>
            </div>
          </>):(<>
            <div style={{display:"flex",justifyContent:"center",marginBottom:20}}><Orb size={64} mood={mood} tick={tick} speaking={speaking}/></div>
            {speaking&&<div style={{display:"flex",justifyContent:"center",marginBottom:14}}><Wave active bars={11} color={m.acc} h={26}/></div>}
            <div style={{...cardS,marginBottom:16}}>
              <div style={lblS}>ECHO READ YOUR ENTRY</div>
              <div style={{fontSize:16,lineHeight:1.92,fontStyle:"italic",color:"rgba(235,228,216,.9)",whiteSpace:"pre-wrap",fontFamily:SF}}>{jReply}</div>
            </div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              <button onClick={()=>speaking?stopEcho():echoSpeak(jReply)}
                style={{background:"rgba(196,168,130,.09)",border:"1px solid rgba(196,168,130,.24)",borderRadius:20,padding:"10px 18px",color:m.acc,fontSize:10,letterSpacing:".1em",cursor:"pointer",fontFamily:SS}}>
                {speaking?"⏸ STOP":"▶ HEAR AGAIN"}
              </button>
              <button onClick={()=>{setJText("");setJReply(null);stopEcho();}}
                style={{background:"transparent",border:"1px solid rgba(196,168,130,.26)",borderRadius:24,padding:"11px 24px",color:m.acc,fontSize:10,letterSpacing:".1em",cursor:"pointer",fontFamily:SS}}>WRITE ANOTHER</button>
            </div>
          </>)}
        </div>
      </div>
    );
  }

  // ── DEBATE ────────────────────────────────────────────────────────────────────
  if(screen==="debate"){
    const d=DEBATES[debateIdx%DEBATES.length];
    // ── LOBBY: pick a topic ──────────────────────────────────────────────────
    if(!debateActive&&debateMsgs.length===0) return(
      <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
        <style>{CSS}</style><Bg mood={mood}/>
        <Hdr title="YOECHO DEBATES" sub="YoEcho holds a position · argue it down" onBack={()=>setScreen("home")} mood={mood}
          right={<button onClick={()=>{setDebateIdx(i=>(i+1)%DEBATES.length);setDebateMsgs([]);setDebateActive(false);}}
            style={{background:"rgba(196,168,130,.09)",border:"1px solid rgba(196,168,130,.24)",borderRadius:16,padding:"7px 13px",color:m.acc,fontSize:9,letterSpacing:".1em",cursor:"pointer",fontFamily:SS}}>NEXT ›</button>}/>
        <div style={infoS}>
          {/* Topic selector dots */}
          <div style={{display:"flex",gap:6,justifyContent:"center",marginBottom:20}}>
            {DEBATES.map((_,i)=>(
              <div key={i} onClick={()=>{setDebateIdx(i);setDebateMsgs([]);setDebateActive(false);}}
                style={{width:i===debateIdx%DEBATES.length?18:6,height:6,borderRadius:3,cursor:"pointer",transition:"all .3s",
                  background:i===debateIdx%DEBATES.length?m.acc:"rgba(196,168,130,.2)"}}/>
            ))}
          </div>
          {/* Position card */}
          <div style={{padding:"22px 20px",background:"rgba(168,196,130,.06)",border:"1px solid rgba(168,196,130,.2)",borderLeft:"3px solid #a8c482",borderRadius:17,marginBottom:16}}>
            <div style={{fontSize:7,color:"#a8c482",letterSpacing:".16em",fontFamily:SS,marginBottom:10,opacity:.7}}>{d.tag} · {debateIdx%DEBATES.length+1}/{DEBATES.length}</div>
            <div style={{fontSize:8,color:"#a8c482",letterSpacing:".12em",fontFamily:SS,marginBottom:8,opacity:.6,textTransform:"uppercase"}}>ECHO'S POSITION</div>
            <div style={{fontSize:15,color:"rgba(235,228,216,.88)",lineHeight:1.9,fontStyle:"italic",marginBottom:16}}>"{d.position}"</div>
            <div style={{fontSize:8,color:"rgba(168,196,130,.6)",letterSpacing:".1em",fontFamily:SS,marginBottom:6,textTransform:"uppercase"}}>YOUR CHALLENGE</div>
            <div style={{fontSize:13,color:"rgba(168,196,130,.78)",lineHeight:1.85,fontStyle:"italic"}}>{d.challenge}</div>
          </div>
          {/* Rules callout */}
          <div style={{padding:"12px 16px",background:"rgba(196,168,130,.05)",border:"1px solid rgba(196,168,130,.12)",borderRadius:14,marginBottom:20}}>
            <div style={{fontSize:10,color:"rgba(196,168,130,.45)",lineHeight:1.85,fontFamily:SS,letterSpacing:".04em"}}>
              YoEcho will hold this position firmly. It only concedes if your argument is genuinely strong. Make your case.
            </div>
          </div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            <button onClick={()=>startDebate(d)} disabled={debateBusy}
              style={{flex:2,border:"none",borderRadius:20,padding:"13px 20px",fontSize:10,letterSpacing:".14em",fontFamily:SS,cursor:debateBusy?"not-allowed":"pointer",minHeight:46,
                background:debateBusy?"rgba(196,168,130,.12)":`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,
                color:debateBusy?"rgba(196,168,130,.3)":"#0c0905"}}>
              {debateBusy?"ECHO IS THINKING…":"⚡ START DEBATE"}
            </button>
            <button onClick={()=>speaking?stopEcho():echoSpeak(d.position)}
              style={{background:"rgba(196,168,130,.09)",border:"1px solid rgba(196,168,130,.24)",borderRadius:20,padding:"13px 18px",color:m.acc,fontSize:10,letterSpacing:".1em",cursor:"pointer",fontFamily:SS}}>
              {speaking?"⏸":"▶"}
            </button>
          </div>
        </div>
      </div>
    );
    // ── LIVE DEBATE ──────────────────────────────────────────────────────────
    return(
      <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
        <style>{CSS}</style><Bg mood={mood}/>
        <Hdr title="LIVE DEBATE" sub={debateActive?"YoEcho is holding its ground":"debate concluded"} onBack={()=>{setDebateMsgs([]);setDebateActive(false);}} mood={mood}
          right={<div style={{display:"flex",gap:7,alignItems:"center"}}>
            <div style={{fontSize:7,color:"rgba(168,196,130,.5)",fontFamily:SS,letterSpacing:".08em",maxWidth:120,textAlign:"right",lineHeight:1.4}}>{d.tag}</div>
            <Orb size={28} mood={mood} tick={tick} speaking={speaking}/>
          </div>}/>
        <VBar/>
        {/* Position banner */}
        <div style={{flexShrink:0,padding:"8px 16px",background:"rgba(168,196,130,.06)",borderBottom:"1px solid rgba(168,196,130,.12)"}}>
          <div style={{fontSize:10,color:"rgba(168,196,130,.7)",lineHeight:1.75,fontStyle:"italic",maxWidth:600,margin:"0 auto",fontFamily:SF}}>
            ⚡ YoEcho holds: "{d.position.slice(0,90)}{d.position.length>90?"…":""}"
          </div>
        </div>
        {/* Messages */}
        <div style={{...scrollS}}>
          {debateMsgs.map((msg,i)=>{
            const isUser=msg.role==="user";
            return(
              <div key={i} style={{marginBottom:18,display:"flex",flexDirection:"column",alignItems:isUser?"flex-end":"flex-start",animation:"sUp .3s ease forwards"}}>
                {!isUser&&<div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                  <div style={{width:16,height:16,borderRadius:"50%",background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`}}/>
                  <span style={{fontSize:7,color:"#a8c482",opacity:.6,letterSpacing:".1em",fontFamily:SS}}>{msg.tag||"YOECHO"}</span>
                  <button onClick={()=>handleBubbleSpeak(msg.content,i)} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:10,opacity:.35,color:m.acc,padding:"0 2px"}}>
                    {speakingBubble===i?"⏸":"▶"}
                  </button>
                </div>}
                {msg.tag&&<div style={{fontSize:7,borderRadius:11,padding:"3px 9px",letterSpacing:".1em",fontFamily:SS,display:"inline-block",marginBottom:5,border:`1px solid ${msg.tagColor||"#a8c482"}44`,color:msg.tagColor||"#a8c482"}}>{msg.tag}</div>}
                <div style={{maxWidth:"90%",fontSize:15,lineHeight:1.88,color:"rgba(235,228,216,.9)",whiteSpace:"pre-wrap",fontFamily:SF,
                  ...(isUser?{padding:"11px 15px",background:"rgba(196,168,130,.1)",border:"1px solid rgba(196,168,130,.16)",borderRadius:"18px 18px 4px 18px"}
                    :{paddingLeft:22,borderLeft:"2px solid rgba(168,196,130,.35)"})}}>
                  {msg.content}
                </div>
              </div>
            );
          })}
          {debateBusy&&<Dots mood={mood}/>}
          {!debateActive&&debateMsgs.length>0&&(
            <div style={{textAlign:"center",padding:"20px 0"}}>
              <div style={{fontSize:11,color:"rgba(168,196,130,.5)",fontFamily:SS,letterSpacing:".1em",marginBottom:14}}>DEBATE CONCLUDED</div>
              <button onClick={()=>{setDebateMsgs([]);setDebateActive(false);setDebateIdx(i=>(i+1)%DEBATES.length);}}
                style={{border:"none",borderRadius:20,padding:"11px 24px",fontSize:10,letterSpacing:".12em",fontFamily:SS,cursor:"pointer",
                  background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`,color:"#0c0905"}}>NEXT TOPIC →</button>
            </div>
          )}
          <div ref={debateEnd}/>
        </div>
        <IBar value={debateIn} onChange={setDebateIn} onSend={()=>sendDebate()} busy={debateBusy}
          placeholder="Make your argument…" mood={mood}
          listening={listening} speaking={speaking} transcript={transcript} micError={micError}
          onMicToggle={debateMicToggle} onSpeakToggle={toggleSpeak}/>
        {voiceMode&&<VoiceModeOverlay mood={mood} listening={listening} speaking={speaking} transcript={transcript} onClose={()=>setVoiceMode(false)} onMicToggle={debateMicToggle} onStopSpeak={stopEcho} speechSpeed={speechSpeed} onSpeedChange={setSpeechSpeed}/>}
        <MicModal onRetry={debateMicToggle}/>
      </div>
    );
  }

  // ── BELIEFS ───────────────────────────────────────────────────────────────────
  if(screen==="beliefs"){
    const det=inferBeliefs(chatMsgs);
    return(
      <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
        <style>{CSS}</style><Bg mood={mood}/>
        <Hdr title="DEEP BELIEFS" sub="patterns YoEcho has inferred" onBack={()=>setScreen("home")} mood={mood}/>
        <div style={infoS}>
          {!det.length
            ?<div style={{textAlign:"center",padding:"44px 0",color:"rgba(255,255,255,.18)",fontSize:14,fontStyle:"italic",lineHeight:2.5}}>Talk to YoEcho more.<br/>Deep beliefs surface from patterns.</div>
            :<>
              <p style={{fontSize:13,color:"rgba(196,168,130,.5)",lineHeight:1.9,marginBottom:18,fontStyle:"italic"}}>These are patterns YoEcho has inferred. Not diagnoses — observations. Hold them lightly.</p>
              {det.map((b,i)=>(
                <div key={i} style={{padding:"16px 18px",background:"rgba(168,130,196,.08)",border:"1px solid rgba(168,130,196,.22)",borderLeft:"3px solid #a882c4",borderRadius:17,marginBottom:11}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{fontSize:8,color:"#a882c4",letterSpacing:".14em",fontFamily:SS,opacity:.7,textTransform:"uppercase"}}>◇ {b.belief}</div>
                    <button onClick={()=>echoSpeak(b.inference)} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:12,color:"#a882c4",opacity:.6}}>▶</button>
                  </div>
                  <div style={{fontSize:14,lineHeight:1.85,fontStyle:"italic",color:"rgba(235,228,216,.78)"}}>{b.inference}</div>
                  <div style={{fontSize:8,color:"rgba(196,168,130,.3)",marginTop:10,fontFamily:SS}}>{b.hits} signal{b.hits!==1?"s":""} detected</div>
                </div>
              ))}
            </>}
        </div>
      </div>
    );
  }

  // ── PATTERNS ──────────────────────────────────────────────────────────────────
  if(screen==="patterns"){
    const uM=chatMsgs.filter(x=>x.role==="user");
    const freq={};
    uM.map(x=>x.content).join(" ").toLowerCase().split(/\W+/)
      .filter(w=>w.length>5&&!["really","about","think","would","could","should","still","going","being","because","though","there","their","where"].includes(w))
      .forEach(w=>freq[w]=(freq[w]||0)+1);
    const tw=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([w])=>w);
    return(
      <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
        <style>{CSS}</style><Bg mood={mood}/>
        <Hdr title="PATTERNS" sub="what YoEcho notices over time" onBack={()=>setScreen("home")} mood={mood}/>
        <div style={infoS}>
          {moodLog.length>0&&<div style={cardS}>
            <div style={lblS}>MOOD TRAIL ({moodLog.length} readings · saved)</div>
            <div style={{marginTop:6,lineHeight:1.8}}>
              {moodLog.slice(-42).map((ml,i)=><span key={i} title={ml.mood} style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:MC[ml.mood]||"#888",margin:3,boxShadow:`0 0 5px ${MC[ml.mood]||"#888"}55`}}/>)}
            </div>
          </div>}
          {tw.length>0&&<div style={cardS}>
            <div style={lblS}>WORDS THAT KEEP APPEARING</div>
            <div style={{marginTop:4}}>
              {tw.map(w=><span key={w} style={{fontSize:10,padding:"3px 11px",borderRadius:20,display:"inline-block",margin:3,background:"rgba(196,168,130,.12)",border:"1px solid rgba(196,168,130,.2)",color:m.acc,fontFamily:SS}}>{w}</span>)}
            </div>
          </div>}
          {uM.length>0&&<div style={cardS}>
            <div style={lblS}>CONVERSATION DEPTH</div>
            <div style={{fontSize:14,color:"rgba(235,228,216,.7)",lineHeight:1.88}}>{uM.length} messages · avg {Math.round(uM.reduce((a,x)=>a+x.content.split(" ").length,0)/uM.length)} words each.</div>
          </div>}
          <div style={cardS}>
            <div style={lblS}>YOUR YOYOECHO KEY</div>
            <div style={{fontSize:14,color:m.acc,letterSpacing:".06em",fontFamily:SS}}>{profileId}</div>
            <div style={{fontSize:11,color:"rgba(196,168,130,.4)",marginTop:6,lineHeight:1.7}}>Enter this key every time you open YoEcho. Your memory is stored locally on this device.</div>
          </div>
          {uM.length<4&&<div style={{textAlign:"center",padding:"32px 0",color:"rgba(255,255,255,.18)",fontSize:14,fontStyle:"italic",lineHeight:2.5}}>Patterns emerge as you talk more.</div>}
        </div>
      </div>
    );
  }

  // ── RELATIONSHIPS ────────────────────────────────────────────────────────────
  if(screen==="relationships"){
    const people=Object.entries(relationships);
    const W=320,H=280,cx=W/2,cy=H/2;
    const moodColor={positive:"#90d0a0",negative:"#d07060",mixed:"#f0c060",neutral:"#c4a882"};
    return(
      <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
        <style>{CSS}</style><Bg mood={mood}/>
        <Hdr title="RELATIONSHIPS" sub="people YoEcho has noticed in your life" onBack={()=>setScreen("home")} mood={mood}/>
        <div style={{flex:1,overflowY:"auto",padding:"16px 14px",maxWidth:600,margin:"0 auto",width:"100%",zIndex:5}}>
          {people.length===0?(
            <div style={{textAlign:"center",padding:"48px 0",color:"rgba(255,255,255,.18)",fontSize:14,fontStyle:"italic",lineHeight:2.5}}>
              Talk about people in your life.<br/>YoEcho will build a map.
            </div>
          ):(
            <>
              <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block",margin:"0 auto 20px",maxWidth:W}}>
                <circle cx={cx} cy={cy} r={22} fill={m.acc+"33"} stroke={m.acc} strokeWidth={1.5}/>
                <text x={cx} y={cy+5} textAnchor="middle" fill={m.acc} fontSize={9} fontFamily={SS}>YOU</text>
                {people.slice(0,8).map(([name,data],i)=>{
                  const angle=(i/Math.min(people.length,8))*Math.PI*2 - Math.PI/2;
                  const dist=100;
                  const nx=cx+Math.cos(angle)*dist;
                  const ny=cy+Math.sin(angle)*dist;
                  const col=moodColor[data.moods?.slice(-1)[0]]||moodColor.neutral;
                  return(
                    <g key={name}>
                      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={col} strokeWidth={1} strokeOpacity={0.35}/>
                      <circle cx={nx} cy={ny} r={18} fill={col+"22"} stroke={col} strokeWidth={1.5}/>
                      <text x={nx} y={ny-22} textAnchor="middle" fill="rgba(235,228,216,.7)" fontSize={8} fontFamily={SS}>{name}</text>
                      <text x={nx} y={ny+4} textAnchor="middle" fill={col} fontSize={7} fontFamily={SS}>{data.mentions}x</text>
                    </g>
                  );
                })}
              </svg>
              {people.map(([name,data])=>(
                <div key={name} style={{padding:"12px 16px",background:"rgba(196,168,130,.07)",border:"1px solid rgba(196,168,130,.15)",borderRadius:16,marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <div style={{fontSize:14,color:m.acc,fontFamily:SF}}>{name}</div>
                    <div style={{fontSize:8,color:"rgba(196,168,130,.5)",fontFamily:SS}}>{data.relation} · {data.mentions} mention{data.mentions!==1?"s":""}</div>
                  </div>
                  {data.contexts?.slice(-1)[0]&&<div style={{fontSize:12,color:"rgba(235,228,216,.55)",fontStyle:"italic",fontFamily:SF}}>{data.contexts.slice(-1)[0]}</div>}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    );
  }

  // ── ANCHORS ───────────────────────────────────────────────────────────────────
  if(screen==="anchors"){
    return(
      <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
        <style>{CSS}</style><Bg mood={mood}/>
        <Hdr title="MEMORY ANCHORS" sub="significant moments YoEcho has marked" onBack={()=>setScreen("home")} mood={mood}/>
        <div style={{flex:1,overflowY:"auto",padding:"16px 14px",maxWidth:600,margin:"0 auto",width:"100%",zIndex:5}}>
          {anchors.length===0?(
            <div style={{textAlign:"center",padding:"48px 0",color:"rgba(255,255,255,.18)",fontSize:14,fontStyle:"italic",lineHeight:2.5}}>
              Profound moments get marked as anchors.<br/>Keep talking.
            </div>
          ):(
            <>
              {[...anchors].reverse().map((a,i)=>(
                <div key={i} style={{padding:"16px 18px",background:"rgba(130,168,196,.07)",border:"1px solid rgba(130,168,196,.2)",borderLeft:"3px solid #82a8c4",borderRadius:17,marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{fontSize:8,color:"#82a8c4",letterSpacing:".12em",fontFamily:SS,opacity:.8}}>⚓ {a.theme?.toUpperCase()||"ANCHOR"}</div>
                    <div style={{fontSize:7,color:"rgba(196,168,130,.3)",fontFamily:SS}}>{timeSince(a.ts)}</div>
                  </div>
                  <div style={{fontSize:14,color:"rgba(235,228,216,.8)",lineHeight:1.85,fontStyle:"italic",marginBottom:8}}>"{a.quote}"</div>
                  {a.echo&&<div style={{fontSize:12,color:"rgba(130,168,196,.7)",lineHeight:1.75,borderTop:"1px solid rgba(130,168,196,.15)",paddingTop:8}}>YoEcho: {a.echo}</div>}
                  <button onClick={()=>echoSpeak(a.echo||a.quote)} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:11,color:"#82a8c4",opacity:.6,marginTop:6}}>▶ hear</button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    );
  }

  // ── TUTOR ─────────────────────────────────────────────────────────────────────
  if(screen==="tutor") return(
    <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
      <style>{CSS}</style><Bg mood={mood}/>
      <Hdr title="TUTOR MODE" sub="learn anything · math · code · science · anything"
        onBack={()=>setScreen("home")} mood={mood}
        right={<div style={{display:"flex",gap:8,alignItems:"center"}}>
          {tutorMsgs.length>0&&<button onClick={()=>setTutorMsgs([])} style={{background:"rgba(196,168,130,.09)",border:"1px solid rgba(196,168,130,.24)",borderRadius:14,padding:"5px 11px",color:m.acc,fontSize:8,letterSpacing:".1em",cursor:"pointer",fontFamily:SS}}>CLEAR</button>}
          <Orb size={34} mood={mood} tick={tick} speaking={speaking}/>
        </div>}/>
      <VBar/>
      <div style={{flex:1,overflowY:"auto",padding:"16px 14px 12px",maxWidth:680,margin:"0 auto",width:"100%",position:"relative",zIndex:5}}>
        {tutorMsgs.length===0&&(
          <div style={{textAlign:"center",padding:"40px 16px"}}>
            <div style={{fontSize:36,marginBottom:12}}>🎓</div>
            <div style={{fontSize:14,color:m.acc,letterSpacing:".1em",fontFamily:SS,marginBottom:10}}>TUTOR MODE</div>
            <p style={{fontSize:13,color:"rgba(235,228,216,.5)",lineHeight:1.85,fontFamily:SF,fontStyle:"italic"}}>Ask YoEcho to explain anything — math, science, code, history. Equations render beautifully.</p>
          </div>
        )}
        {tutorMsgs.map((msg,i)=>(
          <div key={i} style={{marginBottom:22,display:"flex",flexDirection:"column",alignItems:msg.role==="user"?"flex-end":"flex-start",animation:"sUp .34s ease forwards"}}>
            {msg.role==="echo"&&<div style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
              <div style={{width:18,height:18,borderRadius:"50%",background:`radial-gradient(circle at 35% 35%,${m.orb[0]},${m.orb[2]})`}}/>
              <span style={{fontSize:8,color:m.acc,opacity:.28,letterSpacing:".1em",fontFamily:SS}}>ECHO TUTOR</span>
              <button onClick={()=>echoSpeak(msg.content)} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:11,opacity:.3,color:m.acc,padding:"0 2px"}}>▶</button>
            </div>}
            {msg.role==="user"
              ?<div style={{maxWidth:"88%",padding:"12px 16px",background:"rgba(196,168,130,.1)",border:"1px solid rgba(196,168,130,.16)",borderRadius:"20px 20px 5px 20px",fontSize:15,color:"rgba(235,228,216,.9)",fontFamily:SF,whiteSpace:"pre-wrap"}}>{msg.content}</div>
              :<div style={{maxWidth:"96%",paddingLeft:24,borderLeft:`2px solid ${m.acc}44`}}><RichText text={msg.content}/></div>
            }
          </div>
        ))}
        {tutorBusy&&<Dots mood={mood}/>}
        <div ref={chatEnd}/>
      </div>
      <IBar value={tutorIn} onChange={setTutorIn} onSend={()=>sendTutor()} busy={tutorBusy}
        placeholder="Ask anything — math, science, code, history…" mood={mood}
        listening={listening} speaking={speaking} transcript={transcript} micError={micError}
        onMicToggle={tutorMicToggle} onSpeakToggle={toggleSpeak}/>
      {voiceMode&&<VoiceModeOverlay mood={mood} listening={listening} speaking={speaking} transcript={transcript} onClose={()=>setVoiceMode(false)} onMicToggle={tutorMicToggle} onStopSpeak={stopEcho} speechSpeed={speechSpeed} onSpeedChange={setSpeechSpeed}/>}
      <MicModal onRetry={tutorMicToggle}/>
    </div>
  );


  // ── ECHO STATE ─────────────────────────────────────────────────────────────
  if(screen==="echostate"){
    const detectedBeliefs = inferBeliefs(chatMsgs, beliefHitsStored);
    const moodCounts = {};
    moodLog.forEach(ml => { moodCounts[ml.mood] = (moodCounts[ml.mood]||0)+1; });
    const topMoods = Object.entries(moodCounts).sort((a,b)=>b[1]-a[1]).slice(0,4);
    const totalDays = moodLog.length>0 ? Math.max(1,Math.floor((Date.now()-moodLog[0].date)/86400000)) : 0;
    const recentJournals = journalInsights.slice(-3);
    const sessionCount = chats.length;
    return(
      <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",fontFamily:SF}}>
        <style>{CSS}</style><Bg mood={mood}/>
        <Hdr title="YOECHO STATE" sub="what YoEcho knows about you" onBack={()=>setScreen("home")} mood={mood}
          right={<div style={{fontSize:8,color:m.acc,opacity:.45,fontFamily:SS,letterSpacing:".08em"}}>{totalMsgs} msgs · {totalDays}d</div>}/>
        <div style={{flex:1,overflowY:"auto",padding:"16px 14px",maxWidth:600,margin:"0 auto",width:"100%",zIndex:5}}>

          {/* Identity card */}
          <div style={{...cardS,borderLeft:`3px solid ${m.acc}`}}>
            <div style={lblS}>◈ IDENTITY</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:4}}>
              <div>
                <div style={{fontSize:9,color:"rgba(196,168,130,.4)",fontFamily:SS,marginBottom:3}}>NAME</div>
                <div style={{fontSize:14,color:"rgba(235,228,216,.85)",fontFamily:SF}}>{profile.name||"Unknown"}</div>
              </div>
              <div>
                <div style={{fontSize:9,color:"rgba(196,168,130,.4)",fontFamily:SS,marginBottom:3}}>YOYOECHO KEY</div>
                <div style={{fontSize:12,color:m.acc,fontFamily:SS,letterSpacing:".05em"}}>{profileId}</div>
              </div>
              <div>
                <div style={{fontSize:9,color:"rgba(196,168,130,.4)",fontFamily:SS,marginBottom:3}}>CONVERSATIONS</div>
                <div style={{fontSize:14,color:"rgba(235,228,216,.85)"}}>{sessionCount}</div>
              </div>
              <div>
                <div style={{fontSize:9,color:"rgba(196,168,130,.4)",fontFamily:SS,marginBottom:3}}>MESSAGES</div>
                <div style={{fontSize:14,color:"rgba(235,228,216,.85)"}}>{totalMsgs}</div>
              </div>
            </div>
          </div>

          {/* Values, fears, goals */}
          {(profile.values?.length>0||profile.fears?.length>0||profile.goals?.length>0)&&(
            <div style={cardS}>
              <div style={lblS}>✦ WHAT ECHO KNOWS ABOUT YOU</div>
              {profile.values?.length>0&&<div style={{marginBottom:10}}>
                <div style={{fontSize:8,color:"#90d0a0",fontFamily:SS,opacity:.7,marginBottom:4}}>VALUES</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                  {profile.values.map(v=><span key={v} style={{fontSize:10,padding:"3px 10px",borderRadius:20,background:"rgba(144,208,160,.1)",border:"1px solid rgba(144,208,160,.25)",color:"#90d0a0",fontFamily:SS}}>{v}</span>)}
                </div>
              </div>}
              {profile.fears?.length>0&&<div style={{marginBottom:10}}>
                <div style={{fontSize:8,color:"#d09070",fontFamily:SS,opacity:.7,marginBottom:4}}>FEARS</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                  {profile.fears.map(f=><span key={f} style={{fontSize:10,padding:"3px 10px",borderRadius:20,background:"rgba(208,144,112,.1)",border:"1px solid rgba(208,144,112,.25)",color:"#d09070",fontFamily:SS}}>{f}</span>)}
                </div>
              </div>}
              {profile.goals?.length>0&&<div>
                <div style={{fontSize:8,color:"#f0c060",fontFamily:SS,opacity:.7,marginBottom:4}}>GOALS</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                  {profile.goals.map(g=><span key={g} style={{fontSize:10,padding:"3px 10px",borderRadius:20,background:"rgba(240,192,96,.1)",border:"1px solid rgba(240,192,96,.25)",color:"#f0c060",fontFamily:SS}}>{g}</span>)}
                </div>
              </div>}
            </div>
          )}

          {/* Mood arc */}
          {topMoods.length>0&&<div style={cardS}>
            <div style={lblS}>◉ EMOTIONAL PROFILE ({moodLog.length} readings)</div>
            {topMoods.map(([mood_,count])=>(
              <div key={mood_} style={{display:"flex",alignItems:"center",gap:10,marginBottom:7}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:MC[mood_]||"#888",flexShrink:0}}/>
                <div style={{fontSize:12,color:"rgba(235,228,216,.7)",fontFamily:SF,flex:1,textTransform:"capitalize"}}>{mood_}</div>
                <div style={{height:6,borderRadius:3,background:`${MC[mood_]}44`,border:`1px solid ${MC[mood_]}66`,width:Math.max(20,Math.round((count/moodLog.length)*140)),transition:"width .4s"}}/>
                <div style={{fontSize:9,color:"rgba(196,168,130,.4)",fontFamily:SS,minWidth:28,textAlign:"right"}}>{Math.round((count/moodLog.length)*100)}%</div>
              </div>
            ))}
          </div>}

          {/* Detected beliefs */}
          {detectedBeliefs.length>0&&<div style={cardS}>
            <div style={lblS}>◇ BELIEF PATTERNS DETECTED</div>
            {detectedBeliefs.map((b,i)=>(
              <div key={i} style={{marginBottom:10,paddingBottom:10,borderBottom:i<detectedBeliefs.length-1?"1px solid rgba(168,130,196,.15)":"none"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <div style={{fontSize:10,color:"#a882c4",fontFamily:SS,letterSpacing:".08em"}}>{b.belief}</div>
                  <div style={{fontSize:8,fontFamily:SS,color:"rgba(168,130,196,.5)"}}>{b.confidence}% confidence</div>
                </div>
                <div style={{height:4,borderRadius:2,background:"rgba(168,130,196,.15)",marginBottom:6}}>
                  <div style={{height:"100%",borderRadius:2,background:"#a882c4",width:`${b.confidence}%`,transition:"width .5s"}}/>
                </div>
                <div style={{fontSize:12,color:"rgba(235,228,216,.6)",fontStyle:"italic",lineHeight:1.75}}>{b.inference}</div>
              </div>
            ))}
          </div>}

          {/* Journal insights */}
          {recentJournals.length>0&&<div style={cardS}>
            <div style={lblS}>✎ JOURNAL INSIGHTS</div>
            {recentJournals.map((j,i)=>(
              <div key={i} style={{marginBottom:8,paddingBottom:8,borderBottom:i<recentJournals.length-1?"1px solid rgba(196,168,130,.1)":"none"}}>
                <div style={{fontSize:12,color:"rgba(235,228,216,.7)",lineHeight:1.8,fontStyle:"italic"}}>"{j.insight}"</div>
                <div style={{fontSize:8,color:"rgba(196,168,130,.3)",fontFamily:SS,marginTop:3}}>{j.ts?timeSince(j.ts):""}</div>
              </div>
            ))}
          </div>}

          {/* Anchors summary */}
          {anchors.length>0&&<div style={cardS}>
            <div style={lblS}>⚓ MEMORY ANCHORS ({anchors.length} total)</div>
            {anchors.slice(-3).reverse().map((a,i)=>(
              <div key={i} style={{marginBottom:8,paddingBottom:8,borderBottom:i<Math.min(anchors.length,3)-1?"1px solid rgba(130,168,196,.12)":"none"}}>
                <div style={{fontSize:8,color:"#82a8c4",fontFamily:SS,marginBottom:3}}>{a.theme?.toUpperCase()||"ANCHOR"} · {timeSince(a.ts)}</div>
                <div style={{fontSize:12,color:"rgba(235,228,216,.65)",fontStyle:"italic",lineHeight:1.7}}>"{a.quote?.slice(0,100)}{a.quote?.length>100?"…":""}"</div>
              </div>
            ))}
            {anchors.length>3&&<button onClick={()=>setScreen("anchors")} style={{background:"transparent",border:"1px solid rgba(130,168,196,.2)",borderRadius:14,padding:"5px 12px",color:"#82a8c4",fontSize:8,letterSpacing:".1em",cursor:"pointer",fontFamily:SS,marginTop:4}}>VIEW ALL {anchors.length} →</button>}
          </div>}

          {/* Relationships summary */}
          {Object.keys(relationships).length>0&&<div style={cardS}>
            <div style={lblS}>🗺 PEOPLE IN YOUR LIFE</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:7,marginTop:4}}>
              {Object.entries(relationships).slice(0,8).map(([name,data])=>(
                <div key={name} style={{padding:"5px 12px",borderRadius:16,background:"rgba(196,168,130,.08)",border:`1px solid ${(data.moods?.slice(-1)[0]==="positive"?"rgba(144,208,160,.25)":data.moods?.slice(-1)[0]==="negative"?"rgba(208,112,96,.25)":"rgba(196,168,130,.18)")}`,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                  <div style={{fontSize:12,color:"rgba(235,228,216,.8)",fontFamily:SF}}>{name}</div>
                  <div style={{fontSize:7,color:"rgba(196,168,130,.4)",fontFamily:SS}}>{data.relation} · {data.mentions}x</div>
                </div>
              ))}
            </div>
          </div>}

          {totalMsgs<6&&<div style={{textAlign:"center",padding:"32px 0",color:"rgba(255,255,255,.2)",fontSize:13,fontStyle:"italic",lineHeight:2.4}}>YoEcho is still getting to know you.<br/>Talk more — this will fill in.</div>}
        </div>
      </div>
    );
  }
  return null;
}


// Mount the app
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(YoEcho));
