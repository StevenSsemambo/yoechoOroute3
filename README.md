# YoEcho — Netlify PWA Deployment Guide

## What's Inside This Package

```
yoecho-netlify/
├── public/                  ← Everything Netlify serves to users
│   ├── index.html           ← App entry point (PWA shell)
│   ├── app.jsx              ← Your full YoEcho app (modified)
│   ├── manifest.json        ← PWA manifest (install to home screen)
│   ├── sw.js                ← Service worker (offline support)
│   └── icons/               ← App icons
│       ├── icon-192.png
│       └── icon-512.png
├── netlify/
│   └── functions/
│       └── chat.js          ← Serverless function (hides your API key)
├── netlify.toml             ← Netlify build config
└── README.md                ← This file
```

## What Changed From the Original App

1. **Storage**: `window.storage` (Claude artifact only) → `localStorage` (works everywhere)
2. **AI calls**: Direct Anthropic API → Netlify Function proxy (your key is now safe)
3. **AI Model**: Claude Sonnet → **Google Gemma 3 27B** (free via OpenRouter)
4. **PWA**: Added manifest, service worker, and icons so users can install it

---

## Step-by-Step: Get Your Free API Key from OpenRouter

### Step 1 — Sign Up on OpenRouter
1. Go to **https://openrouter.ai**
2. Click **"Sign In"** (top right)
3. Sign up with Google or GitHub — no credit card needed
4. You now have an account ✅

### Step 2 — Create Your API Key
1. Click your **profile icon** (top right after login)
2. Select **"API Keys"**
3. Click **"Create Key"**
4. Name it: `yoecho-app`
5. Click **Create**
6. **Copy the key immediately** — it looks like:
   ```
   sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   ⚠️ You only see it once. Save it somewhere safe.

### Step 3 — Verify Gemma 3 27B is Free
1. Go to **https://openrouter.ai/models**
2. Search for `gemma-3-27b`
3. Confirm it shows **$0.00** (free)
4. The model ID used in this app is: `google/gemma-3-27b-it:free`

---

## Step-by-Step: Deploy to Netlify

### Step 1 — Upload Your Project
**Option A — Drag & Drop (easiest):**
1. Go to **https://app.netlify.com**
2. Sign up / log in (free)
3. Drag the entire `yoecho-netlify` folder onto the Netlify dashboard
4. Netlify auto-detects `netlify.toml` and deploys

**Option B — GitHub (recommended for updates):**
1. Push this folder to a GitHub repo
2. In Netlify: **"Add new site" → "Import from Git"**
3. Connect your GitHub and select the repo
4. Build settings are auto-read from `netlify.toml`
5. Click **Deploy**

### Step 2 — Add Your API Key (CRITICAL)
This is how Netlify keeps your key secret from users:

1. In Netlify, go to your site dashboard
2. Click **"Site configuration"** (left sidebar)
3. Click **"Environment variables"**
4. Click **"Add a variable"**
5. Fill in:
   - **Key:** `OPENROUTER_API_KEY`
   - **Value:** `sk-or-v1-your-copied-key-here`
6. Click **Save**
7. Go to **Deploys** → click **"Trigger deploy"** → **"Deploy site"**
   (Environment variables only take effect after a new deploy)

### Step 3 — Test Your Deployment
1. Open your Netlify URL (e.g. `https://amazing-name-12345.netlify.app`)
2. The app should load with the amber/gold YoEcho interface
3. Type a message and wait for a response from Gemma 3 27B
4. If it responds ✅ — you're live!

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| App loads but AI doesn't respond | Check `OPENROUTER_API_KEY` is set in Netlify env vars and re-deploy |
| "Function not found" error | Make sure `netlify/functions/chat.js` is in the right folder |
| Responses are slow | Normal for free models — Gemma 3 27B may take 5-15 seconds |
| Rate limit error | Free models have limits. Wait a few minutes and try again |
| Storage not saving | Check browser allows localStorage (disable incognito or restrictions) |

---

## Update the Netlify Function URL (optional)

Open `netlify/functions/chat.js` and update line:
```js
"HTTP-Referer": "https://yoecho.netlify.app",
```
Replace with your actual Netlify URL after deployment.

---

## Installing as a PWA (Add to Home Screen)

**On Android (Chrome):**
1. Open the app in Chrome
2. Tap the 3-dot menu → "Add to Home screen"
3. Tap "Add"

**On iPhone (Safari):**
1. Open the app in Safari
2. Tap the Share icon (box with arrow)
3. Scroll down → "Add to Home Screen"
4. Tap "Add"

The app will now appear on your home screen like a native app!

---

## Built by Steven Sema — SayMyTech Developers, Kampala Uganda
