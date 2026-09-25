// ============================================================
// AI Website Builder - generation backend
// Prompt in -> website out. Credits-based billing built in.
//
// How it works:
//   Browser  --POST /api/generate { prompt, userId }-->  this server
//     --deducts credits-->  Anthropic API  --streams HTML-->  browser
//   Your API key never leaves this server.
//
// Quick start:
//   1. npm install
//   2. cp .env.example .env   (then put your Anthropic API key in .env)
//   3. npm start
//   4. Open http://localhost:3000 for the demo client
// ============================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ---- configuration (all overridable via .env) ----
// AI provider: "gemini" is FREE (Google AI Studio, no billing needed).
// "anthropic" needs a paid API key.
const AI_PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || process.env.MODEL || "claude-sonnet-4-5";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-lite-latest";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "12000", 10);
const FREE_CREDITS = parseInt(process.env.FREE_CREDITS || "25", 10); // free credits for new users
const CREDITS_PER_BUILD = parseInt(process.env.CREDITS_PER_BUILD || "10", 10); // cost of one generation

function providerReady() {
  return AI_PROVIDER === "gemini" ? !!GEMINI_API_KEY : !!ANTHROPIC_API_KEY;
}

function providerKeyName() {
  return AI_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
}

const CORS_ORIGIN = process.env.CORS_ORIGIN; // e.g. "https://muse.ai" in production; unset = allow all (local dev)
app.use(CORS_ORIGIN ? cors({ origin: CORS_ORIGIN.split(",").map(s => s.trim()) }) : cors());
app.use(express.json({ limit: "1mb" }));

// ---- published sites ----
// Published generations are saved as static files and served publicly:
//   - by path:          https://your-backend.example.com/s/{id}/
//   - by free subdomain: https://{name}.yourdomain.com  (needs SITES_DOMAIN + wildcard DNS)
const SITES_DIR = path.join(__dirname, "sites");
fs.mkdirSync(SITES_DIR, { recursive: true });
const SITES_DOMAIN = process.env.SITES_DOMAIN || ""; // e.g. "mysites.com"
const NAMES_PATH = path.join(SITES_DIR, "names.json");

function loadNames() {
  try {
    return JSON.parse(fs.readFileSync(NAMES_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveNames(names) {
  fs.writeFileSync(NAMES_PATH, JSON.stringify(names, null, 2));
}

function slugify(text) {
  const s = (text || "site").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  return s || "site";
}

// Pick a unique free subdomain for a published site: {slug}-{random}
function assignName(title) {
  const names = loadNames();
  const base = slugify(title);
  let name = `${base}-${crypto.randomBytes(2).toString("hex")}`;
  while (names[name]) name = `${base}-${crypto.randomBytes(2).toString("hex")}`;
  return name;
}

// Serve a published site when the request arrives on its free subdomain.
// Local testing works with http://{name}.localhost:3000 (no DNS needed).
app.use((req, res, next) => {
  const host = (req.hostname || "").toLowerCase();
  let name = null;
  if (SITES_DOMAIN && host.endsWith("." + SITES_DOMAIN.toLowerCase())) {
    name = host.slice(0, -(SITES_DOMAIN.length + 1));
  } else if (host.endsWith(".localhost")) {
    name = host.slice(0, -".localhost".length);
  }
  if (!name || name.includes(".")) return next();
  const id = loadNames()[name];
  if (!id || !/^[a-f0-9]+$/.test(id)) return next();
  const file = path.join(SITES_DIR, id, "index.html");
  if (!fs.existsSync(file)) return next();
  res.sendFile(file);
});

app.use(express.static(path.join(__dirname, "public"))); // demo client
app.use("/s", express.static(SITES_DIR));

// ---- credits ledger ----
// Simple JSON-file ledger. Fine for getting started and low volume.
// Production: swap this for a real database + user accounts.
const LEDGER_PATH = path.join(__dirname, "credits.json");

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function validUserId(id) {
  return typeof id === "string" && id.length >= 8 && id.length <= 64 && /^[a-zA-Z0-9-_]+$/.test(id);
}

// New users automatically start with FREE_CREDITS free credits.
function getBalance(userId) {
  const ledger = loadLedger();
  if (!(userId in ledger)) {
    ledger[userId] = FREE_CREDITS;
    saveLedger(ledger);
  }
  return ledger[userId];
}

// Returns the new balance, or null when the user can't afford it.
function spend(userId, amount) {
  const ledger = loadLedger();
  const balance = userId in ledger ? ledger[userId] : FREE_CREDITS;
  if (balance < amount) return null;
  ledger[userId] = balance - amount;
  saveLedger(ledger);
  return ledger[userId];
}

function refund(userId, amount) {
  const ledger = loadLedger();
  ledger[userId] = (userId in ledger ? ledger[userId] : FREE_CREDITS) + amount;
  saveLedger(ledger);
}

// ---- purchase tracking (promo: every 3rd 100-credit purchase earns 150 bonus) ----
// In production, call recordPurchase() from your Stripe/PayPal webhook
// when a 100-credit pack payment succeeds.
const PURCHASES_PATH = path.join(__dirname, "purchases.json");

function loadPurchases() {
  try {
    return JSON.parse(fs.readFileSync(PURCHASES_PATH, "utf8"));
  } catch {
    return {};
  }
}

function savePurchases(p) {
  fs.writeFileSync(PURCHASES_PATH, JSON.stringify(p, null, 2));
}

// Grants 100 credits per purchase, plus a 150-credit bonus on every 3rd purchase.
function recordPurchase(userId) {
  const purchases = loadPurchases();
  const count = (purchases[userId] || 0) + 1;
  purchases[userId] = count;
  savePurchases(purchases);

  const bonus = count % 3 === 0 ? 150 : 0;
  const ledger = loadLedger();
  ledger[userId] = (userId in ledger ? ledger[userId] : FREE_CREDITS) + 100 + bonus;
  saveLedger(ledger);
  return { purchaseCount: count, creditsAdded: 100 + bonus, bonus };
}

// ---- the build instructions sent to the AI ----
const SYSTEM_PROMPT = `You are an elite front-end developer and product designer. Your work rivals the best sites built on lovable.dev: visually striking, polished, and complete.

The user will describe a website or web application. Output ONLY a single, complete, valid HTML document. No explanations, no markdown fences, no commentary before or after.

DESIGN QUALITY (this is what matters most):
- Aim for premium, memorable design — never generic or template-looking.
- Strong visual hierarchy: one clear hero message, generous whitespace, refined typography with a deliberate font pairing (use Google Fonts).
- Cohesive color palette: 2-3 colors plus neutrals, chosen to fit the subject.
- Avoid AI clichés: no generic purple-blue gradients, no "Welcome to our website" heroes, no lorem ipsum, no empty placeholder boxes, no stock-looking layouts.
- Subtle motion: smooth hover states, tasteful entrance animations, micro-interactions. Nothing janky, nothing gratuitous.
- Every section must feel intentional and complete, with realistic, specific copy written for the described business or product — real headlines, real feature descriptions, real testimonials with names.

IF IT'S AN APP (dashboard, tool, generator, game, etc.):
- It must actually WORK: functional controls, working state, realistic sample data.
- Think through the full user flow and implement it in vanilla JavaScript. No dead buttons.

TECHNICAL:
- Everything inline: CSS in <style>, JavaScript in <script>. Tailwind via CDN is allowed, plus custom CSS for the details that make it premium.
- Responsive and mobile-friendly.
- Images via inline SVG or CSS only. No external image dependencies except CDNs and Google Fonts.
- The page must render correctly when opened directly. Begin with <!DOCTYPE html>.`;

// The model sometimes wraps output in fences; unwrap it.
function extractHtml(text) {
  const fence =
    text.match(/```html([\s\S]*?)```/i) ||
    text.match(/```([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

// ---- routes ----
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    provider: AI_PROVIDER,
    model: AI_PROVIDER === "gemini" ? GEMINI_MODEL : ANTHROPIC_MODEL,
    providerConfigured: providerReady(),
    freeCredits: FREE_CREDITS,
    creditsPerBuild: CREDITS_PER_BUILD,
  });
});

app.get("/api/credits", (req, res) => {
  const { userId } = req.query;
  if (!validUserId(userId)) return res.status(400).json({ error: "Valid userId required." });
  res.json({ credits: getBalance(userId) });
});

// Called by your payment webhook after a successful 100-credit purchase.
// Grants the credits plus the every-3rd-purchase 150 bonus.
// PRODUCTION: protect this with a webhook secret so only your payment
// provider can call it.
app.post("/api/purchase", (req, res) => {
  const { userId } = req.body || {};
  if (!validUserId(userId)) return res.status(400).json({ error: "Valid userId required." });
  const result = recordPurchase(userId);
  res.json({ ok: true, credits: getBalance(userId), ...result });
});

// Publish a generated site and get a public URL back.
// Publishing is free (no AI cost) — the HTML was already paid for at generation.
// PRODUCTION: in a multi-user setup, consider verifying the user owns the content.
app.post("/api/publish", (req, res) => {
  const { userId, html, title } = req.body || {};
  if (!validUserId(userId)) return res.status(400).json({ error: "Valid userId required." });
  if (!html || typeof html !== "string" || html.length < 100 || html.length > 500000) {
    return res.status(400).json({ error: "Valid generated HTML required." });
  }
  const id = crypto.randomBytes(6).toString("hex");
  const name = assignName(typeof title === "string" ? title : "site");
  const names = loadNames();
  names[name] = id;
  saveNames(names);
  const dir = path.join(SITES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        id,
        name,
        userId,
        title: typeof title === "string" ? title.slice(0, 120) : "Untitled",
        publishedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  res.json({
    ok: true,
    id,
    name,
    url: `/s/${id}/`,
    domain: SITES_DOMAIN ? `https://${name}.${SITES_DOMAIN}` : null,
  });
});

// Streams generated text from Anthropic, calling onText for each chunk.
// Returns the full text. Throws on provider errors.
async function streamAnthropic(prompt, onText) {
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Build this website or web application:\n\n${prompt.trim()}` },
      ],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().then((t) => t.slice(0, 300)).catch(() => "");
    throw new Error(`AI provider error (${upstream.status}). ${errText}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the incomplete line for next chunk
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue; // ignore partial JSON chunks
      }
      if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
        fullText += evt.delta.text;
        onText(evt.delta.text);
      } else if (evt.type === "error") {
        throw new Error((evt.error && evt.error.message) || "AI provider error.");
      }
    }
  }
  return fullText;
}

// Streams generated text from Google Gemini (free tier via AI Studio),
// calling onText for each chunk. Returns the full text. Throws on errors.
// If the primary model is overloaded (503/429), falls back to the lighter model.
async function streamGemini(prompt, onText) {
  const models = [GEMINI_MODEL];
  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
    models.push(GEMINI_FALLBACK_MODEL);
  }
  let lastErr = null;
  for (const model of models) {
    try {
      return await streamGeminiModel(model, prompt, onText);
    } catch (e) {
      lastErr = e;
      if (!/AI provider error \((503|429)\)/.test(e.message)) throw e;
      console.log(`Gemini model ${model} busy, trying fallback...`);
    }
  }
  throw lastErr;
}

async function streamGeminiModel(model, prompt, onText) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        { role: "user", parts: [{ text: `Build this website or web application:\n\n${prompt.trim()}` }] },
      ],
      generationConfig: { temperature: 0.7, maxOutputTokens: MAX_TOKENS },
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().then((t) => t.slice(0, 300)).catch(() => "");
    throw new Error(`AI provider error (${upstream.status}). ${errText}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by a blank line: \n\n, \r\n\r\n, or \r\r
    const events = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = events.pop(); // keep the incomplete event for next chunk
    for (const event of events) {
      for (const line of event.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // ignore partial JSON chunks
        }
        const parts = (evt.candidates && evt.candidates[0] && evt.candidates[0].content && evt.candidates[0].content.parts) || [];
        const text = parts.map((p) => p.text || "").join("");
        if (text) {
          fullText += text;
          onText(text);
        }
      }
    }
  }
  return fullText;
}

app.post("/api/generate", async (req, res) => {
  if (!providerReady()) {
    return res.status(500).json({ error: `Server misconfigured: ${providerKeyName()} is not set.` });
  }
  const { prompt, userId } = req.body || {};
  if (!validUserId(userId)) return res.status(400).json({ error: "Valid userId required." });
  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
    return res.status(400).json({ error: "Provide a 'prompt' describing the site to build." });
  }

  // Charge credits up front so nobody builds for free.
  const remaining = spend(userId, CREDITS_PER_BUILD);
  if (remaining === null) {
    return res.status(402).json({ error: "Not enough credits. Top up to keep building." });
  }

  // Stream progress back to the browser as server-sent events.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("start", { credits: remaining });

  try {
    const onText = (text) => send("delta", { text });
    const fullText =
      AI_PROVIDER === "gemini"
        ? await streamGemini(prompt, onText)
        : await streamAnthropic(prompt, onText);

    send("done", { html: extractHtml(fullText), credits: getBalance(userId) });
    res.end();
  } catch (err) {
    refund(userId, CREDITS_PER_BUILD); // provider failed: give the credits back
    console.error("Generation failed:", err.message);
    send("error", { error: `${err.message || "Generation failed."} Credits refunded.` });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`AI Website Builder backend running on http://localhost:${PORT}`);
  console.log(`AI provider: ${AI_PROVIDER} (${AI_PROVIDER === "gemini" ? GEMINI_MODEL : ANTHROPIC_MODEL})`);
  if (!providerReady()) {
    console.log(`WARNING: ${providerKeyName()} is not set. Copy .env.example to .env and add your key.`);
  }
});
