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
app.set("trust proxy", 1); // Render terminates TLS at its proxy
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

const CORS_ORIGIN = process.env.CORS_ORIGIN; // e.g. "https://muse.ai" in production
// The builder page calls this API cross-origin (page on muse.ai -> API here).
// The Muse in-app viewer runs pages sandboxed, which sends `Origin: null`,
// so that is allowed too. credentials:true lets the browser send the
// HttpOnly session cookie. Unknown origins get no CORS headers.
function corsOrigin(origin, cb) {
  if (!origin) return cb(null, true); // not a browser request (curl, same-origin)
  const configured = (CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  if (configured.includes(origin) || origin === "null") return cb(null, origin);
  return cb(null, false);
}
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// ---- published sites ----
// Published generations are saved as static files and served publicly:
//   - by path:          https://your-backend.example.com/s/{id}/
//   - by free subdomain: https://{name}.yourdomain.com  (needs SITES_DOMAIN + wildcard DNS)
const SITES_DIR = path.join(__dirname, "sites");
fs.mkdirSync(SITES_DIR, { recursive: true });
const SITES_DOMAIN = process.env.SITES_DOMAIN || ""; // e.g. "mysites.com"
const NAMES_PATH = path.join(SITES_DIR, "names.json");

// Monthly upkeep: keeping a published site live costs credits every 30 days.
// Publishing includes the first 30 days; afterwards the owner renews.
const UPKEEP_CREDITS = 40;
const UPKEEP_DAYS = 30;
const UPKEEP_MS = UPKEEP_DAYS * 24 * 3600 * 1000;

function siteMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SITES_DIR, id, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

function writeSiteMeta(id, meta) {
  fs.writeFileSync(path.join(SITES_DIR, id, "meta.json"), JSON.stringify(meta, null, 2));
}

// A site is live only while its upkeep period hasn't expired. Sites published
// before upkeep existed are grandfathered in with a fresh 30 days.
function siteActive(meta) {
  if (!meta) return false;
  if (!meta.expiresAt) {
    meta.expiresAt = Date.now() + UPKEEP_MS;
    try {
      writeSiteMeta(meta.id, meta);
    } catch {}
  }
  return meta.expiresAt > Date.now();
}

function suspendedPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>This website is paused</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0a0a12; color: #e8e4d8; font-family: Georgia, 'Times New Roman', serif; }
  .card { text-align: center; padding: 48px 32px; max-width: 420px; }
  .moon { font-size: 48px; margin-bottom: 16px; }
  h1 { color: #d4af37; font-weight: normal; letter-spacing: 1px; margin: 0 0 12px; }
  p { color: #9a958a; line-height: 1.6; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="moon">🌙</div>
    <h1>This website is paused</h1>
    <p>The owner's plan for this site has lapsed. If this is your site, renew it in AI Website Builder to bring it back online.</p>
  </div>
</body>
</html>`;
}

// Google sign-in (OAuth 2.0 authorization code flow).
// The client ID is public (it ships in the page's JS), so it can live here;
// the client SECRET must come from the GOOGLE_CLIENT_SECRET env var on Render.
const BACKEND_PUBLIC_URL =
  process.env.BACKEND_PUBLIC_URL || "https://ai-website-builder-backend-5dyj.onrender.com";
const FRONTEND_URL = "https://muse.ai/s/ai-website-builder-xtk5xebsfzl5n";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = BACKEND_PUBLIC_URL + "/api/auth/google/callback";
function googleConfigured() {
  return GOOGLE_CLIENT_ID.length > 10 && GOOGLE_CLIENT_SECRET.length > 5;
}
// One-time handoff tokens: the OAuth callback runs top-level on this domain,
// but the session cookie must be set while muse.ai is the top-level site
// (Partitioned cookies). So the callback mints a 5-minute single-use token,
// redirects to the page, and the page exchanges it for a real session.
const pendingGoogle = new Map();

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
  const meta = siteMeta(id);
  if (meta && !siteActive(meta)) return res.status(402).send(suspendedPage());
  res.sendFile(file);
});

// Builder UI at the site root: same-origin with /api, so sign-in cookies work.
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.use(express.static(path.join(__dirname, "public"))); // demo client

// Expired sites show a "paused" page instead of their content.
app.use("/s/:id", (req, res, next) => {
  const id = req.params.id;
  if (!/^[a-f0-9]+$/.test(id)) return next();
  const meta = siteMeta(id);
  if (!meta) return next(); // let the static handler 404
  if (siteActive(meta)) return next();
  res.status(402).send(suspendedPage());
});
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

// ---- accounts ----
// Email+password accounts with cookie sessions. Sessions are random tokens
// stored server-side (sessions.json); the cookie is HttpOnly (+ Secure on
// https, SameSite=None) so the static builder page on another origin stays
// logged in without ever touching the token itself.
// NOTE: JSON-file storage is ephemeral on Render's free tier (resets on
// restart/redeploy). Fine for testing; use a real database before launch.
const USERS_PATH = path.join(__dirname, "users.json");
const SESSIONS_PATH = path.join(__dirname, "sessions.json");
const SESSION_COOKIE = "wb_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Password hashing with Node's built-in scrypt (no extra dependency).
// Stored format: "scrypt$<salt-hex>$<hash-hex>".
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expectedHex] = parts;
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, 64);
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}

function findUserByEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  return Object.values(loadUsers()).find(u => u.email === norm) || null;
}

function validEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[part.slice(0, i).trim()] = "";
    }
  }
  return out;
}

function sessionCookieHeader(req, token, maxAgeSeconds) {
  const isHttps = req.protocol === "https";
  if (!isHttps) {
    // Local dev over http: Secure/Partitioned aren't allowed; same-site Lax cookie.
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  }
  // Production: the cookie is cross-site (page on muse.ai, API here), so it needs
  // Secure + SameSite=None + Partitioned (CHIPS) to survive third-party-cookie
  // blocking. Partitioned scopes it per top-level site, which is what we want.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAgeSeconds}`;
}

// Returns the logged-in user object, or null. Refreshes the sliding expiry.
function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s || s.expiresAt < Date.now()) {
    if (s) {
      delete sessions[token];
      saveSessions(sessions);
    }
    return null;
  }
  const users = loadUsers();
  const user = users[s.userId];
  if (!user) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  saveSessions(sessions);
  return user;
}

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = loadSessions();
  const now = Date.now();
  for (const [t, s] of Object.entries(sessions)) {
    if (s.expiresAt < now) delete sessions[t];
  }
  sessions[token] = { userId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
  saveSessions(sessions);
  res.setHeader("Set-Cookie", sessionCookieHeader(req, token, Math.floor(SESSION_TTL_MS / 1000)));
}

function clearSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const sessions = loadSessions();
    if (sessions[token]) {
      delete sessions[token];
      saveSessions(sessions);
    }
  }
  res.setHeader("Set-Cookie", sessionCookieHeader(req, "", 0));
}

// Basic in-memory rate limit for the auth endpoints (per IP, 15-min window).
const authHits = new Map();
function authRateLimit(req, res, next) {
  const ip = req.ip || "?";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  let h = authHits.get(ip);
  if (!h || h.reset < now) h = { count: 0, reset: now + windowMs };
  h.count += 1;
  authHits.set(ip, h);
  if (h.count > 60) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  next();
}

// Resolve who is calling: logged-in account first, legacy userId second
// (keeps older page versions working during rollout).
function resolveIdentity(req) {
  const user = getSessionUser(req);
  if (user) return { user, ledgerKey: "acct:" + user.id };
  const cand = (req.body && req.body.userId) || (req.query && req.query.userId);
  if (validUserId(cand)) return { user: null, ledgerKey: cand };
  return null;
}

// Account-credit helpers (credits live on the user record, not the ledger).
function acctBalance(userId) {
  const u = loadUsers()[userId];
  return u ? u.credits : 0;
}

function acctSpend(userId, amount) {
  const users = loadUsers();
  const u = users[userId];
  if (!u || u.credits < amount) return null;
  u.credits -= amount;
  saveUsers(users);
  return u.credits;
}

function acctRefund(userId, amount) {
  const users = loadUsers();
  const u = users[userId];
  if (!u) return;
  u.credits += amount;
  saveUsers(users);
}

function acctRecordPurchase(userId) {
  const users = loadUsers();
  const u = users[userId];
  if (!u) return null;
  u.purchases = (u.purchases || 0) + 1;
  const bonus = u.purchases % 3 === 0 ? 150 : 0;
  u.credits += 100 + bonus;
  saveUsers(users);
  return { purchaseCount: u.purchases, creditsAdded: 100 + bonus, bonus, credits: u.credits };
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
    publishCredits: PUBLISH_CREDITS,
    upkeepCredits: UPKEEP_CREDITS,
    upkeepDays: UPKEEP_DAYS,
    googleSignIn: googleConfigured(),
    auth: true,
  });
});

// ---- auth endpoints ----
app.post("/api/auth/signup", authRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const normEmail = email.trim().toLowerCase();
  if (findUserByEmail(normEmail)) {
    return res.status(409).json({ error: "An account with that email already exists. Try logging in." });
  }
  const hash = hashPassword(password);
  const users = loadUsers();
  const id = crypto.randomBytes(8).toString("hex");
  users[id] = { id, email: normEmail, hash, credits: FREE_CREDITS, purchases: 0, createdAt: Date.now() };
  saveUsers(users);
  createSession(req, res, id);
  res.json({ ok: true, email: normEmail, credits: FREE_CREDITS });
});

app.post("/api/auth/login", authRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  const user = validEmail(email) ? findUserByEmail(email) : null;
  if (user && user.google && !user.hash) {
    return res.status(401).json({ error: "This account uses Google sign-in. Continue with Google below." });
  }
  const ok = user && typeof password === "string" && verifyPassword(password, user.hash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password." });
  createSession(req, res, user.id);
  res.json({ ok: true, email: user.email, credits: user.credits });
});

app.post("/api/auth/logout", (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, email: user.email, credits: user.credits });
});

// ---- Google sign-in ----
app.get("/api/auth/google", (req, res) => {
  if (!googleConfigured()) {
    return res.status(500).send("Google sign-in is not configured yet. Try email sign-in instead.");
  }
  // The app opens this in a new tab and polls for completion with the same
  // state value, because query params on the share URL don't reach the app
  // running inside the viewer frame.
  const qState = req.query && typeof req.query.state === "string" ? req.query.state : "";
  const state =
    qState.length >= 8 && qState.length <= 128 ? qState : crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state,
  });
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
});

function googleDonePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed in</title>
<meta http-equiv="refresh" content="2;url=/">
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0a0a12; color: #e8e4d8; font-family: Georgia, 'Times New Roman', serif; }
  .card { text-align: center; padding: 48px 32px; max-width: 420px; }
  .check { font-size: 48px; margin-bottom: 16px; }
  h1 { color: #d4af37; font-weight: normal; letter-spacing: 1px; margin: 0 0 12px; }
  p { color: #9a958a; line-height: 1.6; margin: 0 0 20px; }
  a { color: #d4af37; }
</style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>You're signed in</h1>
    <p>Taking you back to AI Website Builder…</p>
    <p><a href="/">Return to AI Website Builder</a></p>
  </div>
</body>
</html>`;
}

app.get("/api/auth/google/callback", async (req, res) => {
  // Failures redirect back to the builder with a reason code so the exact
  // failure point is visible (e.g. ?google=error&reason=token).
  const fail = (reason) =>
    res.redirect("/?google=error&reason=" + encodeURIComponent(reason || "unknown"));
  const { code, error } = req.query || {};
  if (error || typeof code !== "string" || !code) return fail("denied");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens || !tokens.access_token) return fail("token");
    const meRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: "Bearer " + tokens.access_token },
    });
    if (!meRes.ok) return fail("profile");
    const profile = await meRes.json();
    const email = String(profile && profile.email ? profile.email : "").trim().toLowerCase();
    if (!email || (profile.email_verified !== undefined && profile.email_verified !== true)) {
      return fail("email");
    }
    let user = findUserByEmail(email);
    if (!user) {
      const users = loadUsers();
      const id = crypto.randomBytes(8).toString("hex");
      user = { id, email, hash: null, google: true, credits: FREE_CREDITS, purchases: 0, createdAt: Date.now() };
      users[id] = user;
      saveUsers(users);
    }
    // Sign the session in directly here (this tab is first-party on this
    // domain), so sign-in no longer depends on the opener tab's polling.
    createSession(req, res, user.id);
    const once = crypto.randomBytes(24).toString("hex");
    pendingGoogle.set(once, {
      userId: user.id,
      state: typeof req.query.state === "string" ? req.query.state : null,
      expires: Date.now() + 5 * 60 * 1000,
    });
    // Kept for older clients: the app polls /api/auth/google/status with its
    // state value and then exchanges it via /api/auth/google/complete, which
    // sets the session cookie while the app page is the top-level site.
    res.send(googleDonePage());
  } catch (e) {
    fail("error");
  }
});

// Polling endpoint: has the Google sign-in for this state finished?
app.get("/api/auth/google/status", (req, res) => {
  const state = req.query && req.query.state;
  if (typeof state !== "string" || !state) return res.json({ done: false });
  for (const entry of pendingGoogle.values()) {
    if (entry.expires > Date.now() && entry.state === state) return res.json({ done: true });
  }
  res.json({ done: false });
});

app.post("/api/auth/google/complete", authRateLimit, (req, res) => {
  const { token, state } = req.body || {};
  let foundKey = null;
  let entry = null;
  if (typeof token === "string" && pendingGoogle.has(token)) {
    foundKey = token;
    entry = pendingGoogle.get(token);
  } else if (typeof state === "string" && state) {
    for (const [k, v] of pendingGoogle) {
      if (v.state === state) {
        foundKey = k;
        entry = v;
        break;
      }
    }
  }
  if (foundKey) pendingGoogle.delete(foundKey);
  if (!entry || entry.expires < Date.now()) {
    return res.status(400).json({ error: "Google sign-in expired. Please try again." });
  }
  const user = loadUsers()[entry.userId];
  if (!user) return res.status(400).json({ error: "Account not found." });
  createSession(req, res, user.id);
  res.json({ ok: true, email: user.email, credits: user.credits });
});

app.get("/api/credits", (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(400).json({ error: "Valid userId required." });
  const credits = identity.user ? acctBalance(identity.user.id) : getBalance(identity.ledgerKey);
  res.json({ credits });
});

// Called by your payment webhook after a successful 100-credit purchase.
// Grants the credits plus the every-3rd-purchase 150 bonus.
// PRODUCTION: protect this with a webhook secret so only your payment
// provider can call it.
app.post("/api/purchase", (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(400).json({ error: "Valid userId required." });
  if (identity.user) {
    const result = acctRecordPurchase(identity.user.id);
    res.json({ ok: true, ...result });
  } else {
    const result = recordPurchase(identity.ledgerKey);
    res.json({ ok: true, credits: getBalance(identity.ledgerKey), ...result });
  }
});

// Publish a generated site and get a public URL back.
// Publishing costs credits — publishing is the premium moment worth paying for.
const PUBLISH_CREDITS = 40;
app.post("/api/publish", (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(401).json({ error: "Sign in to publish." });
  const { html, title } = req.body || {};
  if (!html || typeof html !== "string" || html.length < 100 || html.length > 500000) {
    return res.status(400).json({ error: "Valid generated HTML required." });
  }
  // Charge for publishing up front.
  const remaining = identity.user
    ? acctSpend(identity.user.id, PUBLISH_CREDITS)
    : spend(identity.ledgerKey, PUBLISH_CREDITS);
  if (remaining === null) {
    return res
      .status(402)
      .json({ error: `Publishing costs ${PUBLISH_CREDITS} credits. Top up to publish your site.` });
  }
  const refundPublish = () => {
    if (identity.user) acctRefund(identity.user.id, PUBLISH_CREDITS);
    else refund(identity.ledgerKey, PUBLISH_CREDITS);
  };
  let id, name;
  try {
    id = crypto.randomBytes(6).toString("hex");
    name = assignName(typeof title === "string" ? title : "site");
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
          owner: identity.user ? "acct:" + identity.user.id : identity.ledgerKey,
          title: typeof title === "string" ? title.slice(0, 120) : "Untitled",
          publishedAt: new Date().toISOString(),
          expiresAt: Date.now() + UPKEEP_MS,
        },
        null,
        2
      )
    );
  } catch (e) {
    refundPublish();
    throw e;
  }
  res.json({
    ok: true,
    id,
    name,
    url: `/s/${id}/`,
    domain: SITES_DOMAIN ? `https://${name}.${SITES_DOMAIN}` : null,
    credits: remaining,
    expiresAt: Date.now() + UPKEEP_MS,
    upkeepCredits: UPKEEP_CREDITS,
    upkeepDays: UPKEEP_DAYS,
  });
});

// List the caller's published sites with their upkeep status.
app.get("/api/sites", (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(401).json({ error: "Sign in to view your sites." });
  const owner = identity.user ? "acct:" + identity.user.id : identity.ledgerKey;
  let ids = [];
  try {
    ids = fs.readdirSync(SITES_DIR).filter((f) => /^[a-f0-9]+$/.test(f));
  } catch {}
  const sites = [];
  for (const id of ids) {
    const meta = siteMeta(id);
    if (!meta || meta.owner !== owner) continue;
    const active = siteActive(meta); // grandfathers sites from before upkeep
    sites.push({
      id,
      name: meta.name || null,
      title: meta.title || "Untitled",
      url: `/s/${id}/`,
      domain: SITES_DOMAIN && meta.name ? `https://${meta.name}.${SITES_DOMAIN}` : null,
      publishedAt: meta.publishedAt || null,
      expiresAt: meta.expiresAt || null,
      active,
    });
  }
  sites.sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
  res.json({ ok: true, sites, upkeepCredits: UPKEEP_CREDITS, upkeepDays: UPKEEP_DAYS });
});

// Renew a published site for another 30 days. Costs upkeep credits.
app.post("/api/sites/:id/renew", (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(401).json({ error: "Sign in to renew." });
  const { id } = req.params;
  if (!/^[a-f0-9]+$/.test(id)) return res.status(404).json({ error: "Site not found." });
  const meta = siteMeta(id);
  if (!meta) return res.status(404).json({ error: "Site not found." });
  const owner = identity.user ? "acct:" + identity.user.id : identity.ledgerKey;
  if (meta.owner !== owner)
    return res.status(403).json({ error: "Only the site owner can renew it." });
  const remaining = identity.user
    ? acctSpend(identity.user.id, UPKEEP_CREDITS)
    : spend(identity.ledgerKey, UPKEEP_CREDITS);
  if (remaining === null) {
    return res.status(402).json({
      error: `Renewal costs ${UPKEEP_CREDITS} credits. Top up to keep your site live.`,
    });
  }
  const now = Date.now();
  meta.expiresAt =
    meta.expiresAt && meta.expiresAt > now ? meta.expiresAt + UPKEEP_MS : now + UPKEEP_MS;
  writeSiteMeta(id, meta);
  res.json({ ok: true, id, expiresAt: meta.expiresAt, credits: remaining });
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
  const { prompt } = req.body || {};
  const identity = resolveIdentity(req);
  if (!identity) return res.status(400).json({ error: "Valid userId required." });
  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
    return res.status(400).json({ error: "Provide a 'prompt' describing the site to build." });
  }

  // Charge credits up front so nobody builds for free.
  const remaining = identity.user
    ? acctSpend(identity.user.id, CREDITS_PER_BUILD)
    : spend(identity.ledgerKey, CREDITS_PER_BUILD);
  if (remaining === null) {
    return res.status(402).json({ error: "Not enough credits. Top up to keep building." });
  }
  const identRefund = () => {
    if (identity.user) acctRefund(identity.user.id, CREDITS_PER_BUILD);
    else refund(identity.ledgerKey, CREDITS_PER_BUILD);
  };
  const identBalance = () =>
    identity.user ? acctBalance(identity.user.id) : getBalance(identity.ledgerKey);

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

    send("done", { html: extractHtml(fullText), credits: identBalance() });
    res.end();
  } catch (err) {
    identRefund(); // provider failed: give the credits back
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
