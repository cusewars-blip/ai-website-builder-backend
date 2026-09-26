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
import https from "https";

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
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "20000", 10);
const FREE_CREDITS = parseInt(process.env.FREE_CREDITS || "25", 10); // free credits for new users
const CREDITS_PER_BUILD = parseFloat(process.env.CREDITS_PER_BUILD || "1"); // cost of one full generation
const CREDITS_PER_REFINEMENT = parseFloat(process.env.CREDITS_PER_REFINEMENT || "0.5"); // cost of a follow-up correction
const BOOT_TIME = new Date().toISOString(); // when this process started (build/deploy provenance for probes)

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

// User-uploaded photos for the builder chat: saved as static files and
// served publicly at /uploads/{file} so generated sites can embed them.
// NOTE: Render's free-tier disk is ephemeral — uploads survive until the
// next deploy/restart. Move to durable storage before production.
const UPLOADS_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UPLOAD_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
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
app.use("/uploads", express.static(UPLOADS_DIR));

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

// Unmatched / manual-review PayPal events live here so they survive until a
// grant or dismissal. Exposed via /api/_snapshot (pendingPayments) so the
// off-box daily backup and the heartbeat probes become the alert path — a
// redeploy wipe can't silently eat a paid-but-ungranted payment.
const PENDING_PAYMENTS_PATH = path.join(__dirname, "pending-payments.json");
function loadPendingPayments() {
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_PAYMENTS_PATH, "utf8"));
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
function recordPendingPayment(entry) {
  try {
    const list = loadPendingPayments();
    list.push({
      id: crypto.randomBytes(8).toString("hex"),
      ts: new Date().toISOString(),
      type: entry.type || "unknown",
      reason: entry.reason || "unmatched",
      amount: entry.amount ?? null,
      currency: entry.currency || "",
      payerEmail: entry.payerEmail || "",
      customId: entry.customId || "",
      eventId: entry.eventId || "",
      resolved: false,
    });
    fs.writeFileSync(PENDING_PAYMENTS_PATH, JSON.stringify(list.slice(-200), null, 2));
  } catch {}
}
function pendingPaymentsSummary() {
  const list = loadPendingPayments();
  const open = list.filter((p) => !p.resolved);
  return {
    count: open.length,
    lastTs: open.length ? open[open.length - 1].ts : null,
    payments: open.slice(-50),
  };
}
function resolvePendingPayment(id, resolvedBy) {
  try {
    const list = loadPendingPayments();
    const entry = list.find((p) => p.id === id && !p.resolved);
    if (!entry) return false;
    entry.resolved = true;
    entry.resolvedAt = new Date().toISOString();
    entry.resolvedBy = resolvedBy || "manual";
    fs.writeFileSync(PENDING_PAYMENTS_PATH, JSON.stringify(list.slice(-200), null, 2));
    return true;
  } catch {
    return false;
  }
}

function validUserId(id) {
  return typeof id === "string" && id.length >= 8 && id.length <= 64 && /^[a-zA-Z0-9-_]+$/.test(id);
}

// ---- credit transaction history (live feed) ----
// Per-user log of every credit movement, capped at 50 entries each.
// NOTE: ephemeral JSON on Render free tier — move to a database before production.
const CREDIT_HISTORY_PATH = path.join(__dirname, "credit-history.json");
const LOW_BALANCE_THRESHOLD = parseFloat(process.env.LOW_BALANCE_THRESHOLD || "2");

function loadCreditHistory() {
  try {
    return JSON.parse(fs.readFileSync(CREDIT_HISTORY_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCreditHistory(h) {
  fs.writeFileSync(CREDIT_HISTORY_PATH, JSON.stringify(h, null, 2));
}

function logCreditTx(userKey, delta, reason, balance) {
  try {
    const h = loadCreditHistory();
    const list = h[userKey] || [];
    list.unshift({ ts: Date.now(), delta, reason, balance });
    h[userKey] = list.slice(0, 50);
    saveCreditHistory(h);
  } catch (e) {
    console.log("credit history log failed:", e.message);
  }
}

// New users automatically start with FREE_CREDITS free credits.
function getBalance(userId) {
  const ledger = loadLedger();
  if (!(userId in ledger)) {
    ledger[userId] = FREE_CREDITS;
    saveLedger(ledger);
    logCreditTx("ledger:" + userId, FREE_CREDITS, "welcome bonus", FREE_CREDITS);
  }
  return ledger[userId];
}

// Returns the new balance, or null when the user can't afford it.
function spend(userId, amount, reason) {
  const ledger = loadLedger();
  const balance = userId in ledger ? ledger[userId] : FREE_CREDITS;
  if (balance < amount) return null;
  ledger[userId] = balance - amount;
  saveLedger(ledger);
  logCreditTx("ledger:" + userId, -amount, reason || "build", ledger[userId]);
  return ledger[userId];
}

function refund(userId, amount, reason) {
  const ledger = loadLedger();
  ledger[userId] = (userId in ledger ? ledger[userId] : FREE_CREDITS) + amount;
  saveLedger(ledger);
  logCreditTx("ledger:" + userId, amount, reason || "refund", ledger[userId]);
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
  logCreditTx("ledger:" + userId, 100 + bonus, bonus ? "credit purchase + bonus" : "credit purchase", ledger[userId]);
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

// Tighter limit for email signup (Nova's anti-farm fix): 10 per hour per IP.
// Google signup throttles itself upstream; login keeps the looser window.
const signupHits = new Map();
function signupRateLimit(req, res, next) {
  const ip = req.ip || "?";
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  let h = signupHits.get(ip);
  if (!h || h.reset < now) h = { count: 0, reset: now + windowMs };
  h.count += 1;
  signupHits.set(ip, h);
  if (h.count > 10) return res.status(429).json({ error: "Too many signups from this address. Try again later." });
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

function acctSpend(userId, amount, reason, allowSpin) {
  const users = loadUsers();
  const u = users[userId];
  if (!u) return null;
  // Wheel credits (spinCredits) are a separate bucket: spendable on builds
  // and corrections only. Publish and upkeep renewal always draw real credits.
  const spinUsed = allowSpin ? Math.min(u.spinCredits || 0, amount) : 0;
  const realNeed = amount - spinUsed;
  if (u.credits < realNeed) return null;
  if (spinUsed > 0) u.spinCredits -= spinUsed;
  u.credits -= realNeed;
  saveUsers(users);
  logCreditTx(
    "acct:" + userId,
    -amount,
    (reason || "build") + (spinUsed > 0 ? ` (${spinUsed} from spin credits)` : ""),
    u.credits
  );
  return { remaining: u.credits, spinUsed };
}

function acctRefund(userId, amount, reason, spinAmount) {
  const users = loadUsers();
  const u = users[userId];
  if (!u) return;
  // Return the spin portion to the spin bucket so wheel credits can never
  // be laundered into real credits through a build refund.
  const spinBack = Math.min(spinAmount || 0, amount);
  if (spinBack > 0) u.spinCredits = (u.spinCredits || 0) + spinBack;
  u.credits += amount - spinBack;
  saveUsers(users);
  logCreditTx("acct:" + userId, amount, reason || "refund", u.credits);
}

function acctRecordPurchase(userId) {
  const users = loadUsers();
  const u = users[userId];
  if (!u) return null;
  u.purchases = (u.purchases || 0) + 1;
  const bonus = u.purchases % 3 === 0 ? 150 : 0;
  u.credits += 100 + bonus;
  saveUsers(users);
  logCreditTx("acct:" + userId, 100 + bonus, bonus ? "credit purchase + bonus" : "credit purchase", u.credits);
  return { purchaseCount: u.purchases, creditsAdded: 100 + bonus, bonus, credits: u.credits };
}

// ---- signup credit grant: ONE grant path (Nova's condition) ----
// Every signup grant flows through grantSignupCredits(userId, method) and
// nowhere else, so the Neon migration only rewrites this file's storage seam.
//
// GRADUATED BURN (locked 2026-09-26, Beacon + Nova): 25 instant credits for
// EVERY signup — no Google/email tier split, because the "25 free to start"
// headline is the funnel and the signup is the last user we punish. Farm
// defense moved off the grant and onto behavior:
//   1. Free-tier accounts (zero purchases) are capped at FREE_BUILDS_PER_DAY
//      generations/day. A purchase lifts the cap — graduated.
//   2. Signups-per-IP are counted daily; >=3/day lands in /api/_snapshot as
//      signupIpFlags, so we see a farm forming before Gemini quota dies.
const FREE_BUILDS_PER_DAY = 3;
// Storage seam: today this hits the JSON users store. Replace this body with
// Nova's dbFetch adapter when it lands — the grant above must not change.
function dbSetUserCredits(userId, credits) {
  const users = loadUsers();
  const u = users[userId];
  if (!u) return;
  u.credits = credits;
  saveUsers(users);
}
function grantSignupCredits(userId, method) {
  const amount = FREE_CREDITS; // 25 for everyone — the headline, no tiers
  dbSetUserCredits(userId, amount);
  logCreditTx("acct:" + userId, amount, "signup grant (" + method + ")", amount);
  return amount;
}

// ---- graduated burn: free-tier daily generation cap ----
// UTC day string, e.g. "2026-09-26".
function utcDay(d) {
  return (d || new Date()).toISOString().slice(0, 10);
}
// Consume one of today's free generations for a free-tier account.
// Returns true when allowed (counter incremented and saved), false at cap.
function freeTierGenConsume(userId) {
  const users = loadUsers();
  const u = users[userId];
  if (!u) return false;
  const day = utcDay();
  if (u.genDay !== day) { u.genDay = day; u.genCount = 0; }
  if ((u.genCount || 0) >= FREE_BUILDS_PER_DAY) return false;
  u.genCount = (u.genCount || 0) + 1;
  saveUsers(users);
  return true;
}
// Give back one generation (charge failed / build refunded) so a failed
// build never eats the day's allowance.
function freeTierGenRelease(userId) {
  const users = loadUsers();
  const u = users[userId];
  if (!u) return;
  if (u.genDay === utcDay() && (u.genCount || 0) > 0) {
    u.genCount -= 1;
    saveUsers(users);
  }
}

// ---- legacy drip: legacy ledgers use self-mintable userIds, so the account
// drip above (gated on identity.user) never fires for them — uncapped 25-credit
// grants per key. IP-key the same 3/day gate for legacy callers, reusing the
// "gen-ip:" key shape the hourly generate throttle builds. Separate Map with
// day-windowed entries (the throttle's entries are hour-windowed
// {count, resetAt}), so windows can never collide on the shared key shape.
const legacyDayGen = new Map(); // key -> { day, count }
function legacyDayGenConsume(ip) {
  const key = "gen-ip:" + (ip || "unknown");
  const day = utcDay();
  let e = legacyDayGen.get(key);
  if (!e || e.day !== day) e = { day, count: 0 };
  if (e.count >= FREE_BUILDS_PER_DAY) return false;
  e.count += 1;
  legacyDayGen.set(key, e);
  return true;
}
function legacyDayGenRelease(ip) {
  const key = "gen-ip:" + (ip || "unknown");
  const e = legacyDayGen.get(key);
  if (e && e.day === utcDay() && e.count > 0) {
    e.count -= 1;
    legacyDayGen.set(key, e);
  }
}

// ---- graduated burn: signups-per-IP flagging ----
// Daily signup counts per IP, persisted to JSON (survives nothing on Render's
// ephemeral disk, but the off-box _snapshot cron archives it daily).
const SIGNUP_IPS_PATH = path.join(__dirname, "signup-ips.json");
function recordSignupIp(ip) {
  const day = utcDay();
  let rec = {};
  try { rec = JSON.parse(fs.readFileSync(SIGNUP_IPS_PATH, "utf8")); } catch {}
  if (!rec[day]) rec[day] = {};
  rec[day][ip] = (rec[day][ip] || 0) + 1;
  const days = Object.keys(rec).sort();
  while (days.length > 7) delete rec[days.shift()]; // keep 7 days, no growth
  try { fs.writeFileSync(SIGNUP_IPS_PATH, JSON.stringify(rec)); } catch (e) {
    console.error("recordSignupIp write failed:", e.message);
  }
}
// IPs that crossed the farm threshold (>=3 signups today). Surfaced in
// /api/_snapshot so a farm is visible before Gemini quota dies.
function signupIpFlags(day) {
  const d = day || utcDay();
  let rec = {};
  try { rec = JSON.parse(fs.readFileSync(SIGNUP_IPS_PATH, "utf8")); } catch {}
  const counts = rec[d] || {};
  return Object.entries(counts)
    .filter(([, c]) => c >= 3)
    .map(([ip, count]) => ({ ip, count, day: d }))
    .sort((a, b) => b.count - a.count);
}

// Hard enforcement (Nova): cap signups per IP per day. 3/day is generous for
// a household; anything above is a farm burning Gemini quota and free builds.
const SIGNUP_IP_DAILY_CAP = 3;
function signupIpOverLimit(ip) {
  const day = utcDay();
  let rec = {};
  try { rec = JSON.parse(fs.readFileSync(SIGNUP_IPS_PATH, "utf8")); } catch {}
  return ((rec[day] || {})[ip] || 0) >= SIGNUP_IP_DAILY_CAP;
}

// ---- the build instructions sent to the AI ----
const SYSTEM_PROMPT = `You are an elite front-end developer and product designer. Your sites must match or beat what GoDaddy's website builder produces — professional, complete, business-ready websites that look like a top agency charged thousands of dollars for them.

The user will describe a website or web application. Output ONLY a single, complete, valid HTML document. No explanations, no markdown fences, no commentary before or after.

COMPLETENESS (never ship a thin page):
Include every section a real business site needs: sticky header with navigation, hero with a clear headline and call-to-action, trust/social-proof strip, features or services, a showcase with real items (products, menu items, portfolio pieces), testimonials with real names, pricing or menu section, FAQ, contact/location section, and a rich footer with links. The page must feel like a finished, operating business — never a demo or a stub.

DESIGN QUALITY (this is what matters most):
- Aim for premium, memorable design — never generic or template-looking.
- READABILITY IS NON-NEGOTIABLE: every single word on the page must be clearly legible. This is the highest-priority rule and overrides all aesthetic choices.
  * Default to a LIGHT theme (white/off-white backgrounds, dark text) unless the user explicitly asks for dark.
  * Body text: dark charcoal (#1a1a1a or similar) on light backgrounds, minimum 16px, line-height at least 1.6. Never gray-on-gray, never muted text on busy or dark backgrounds.
  * If any section uses a dark background, ALL text on it must be white or near-white (#ffffff / #f5f5f5), never medium gray.
  * Never place text directly over photos, patterns, or gradients without a strong solid overlay behind the text.
  * Headings must be bold with strong contrast against their background.
- Strong visual hierarchy: one clear hero message, generous whitespace, refined typography with a deliberate font pairing (use Google Fonts).
- Cohesive color palette: 2-3 colors plus neutrals, chosen to fit the subject. Accent colors are for buttons, highlights, and details — never for large blocks of body text.
- Avoid AI clichés: no generic purple-blue gradients, no "Welcome to our website" heroes, no lorem ipsum, no empty placeholder boxes, no stock-looking layouts.
- Subtle motion: smooth hover states, tasteful entrance animations, micro-interactions. Nothing janky, nothing gratuitous.
- Every section must feel intentional and complete, with realistic, specific copy written for the described business or product — real headlines, real feature descriptions, real testimonials with names.
- NO UNSTYLED ELEMENTS, EVER: include a CSS reset that styles every element — especially links: never leave default blue underlined browser links anywhere; every <a> must have an explicit color, no underline (or a deliberate hover underline), and proper hover states. Style buttons, inputs, lists, and images deliberately. If an image slot has no image, design a styled graphic or gradient block instead of an empty box.

VISUAL RICHNESS (a page of text is NOT a website — this is the difference):
- Every section must be visually designed, not just written: distinct section backgrounds, cards, grids, icons, illustrations, shapes, and visual dividers. If a section is only paragraphs on a flat background, you have failed.
- The hero must include a striking visual: a large inline-SVG illustration, a product mockup built with CSS, a photo-style gradient composition, or bold graphic shapes. Never a headline floating alone on a flat background.
- Use inline SVG illustrations and icons liberally throughout (never emojis). Every feature gets an icon. Stats become big-number blocks. Steps become a visual timeline. Testimonials become cards with avatars (initials in styled circles).
- Turn paragraphs into layouts: split image+text rows, card grids, alternating sections, banners. Text supports the visuals; it never carries the page alone.
- Whitespace frames visuals — it never replaces them.

MODEL REAL, BEST-IN-CLASS WEBSITES (never generic templates):
Study the layout, density, and polish of the best real websites in each category and match them:
- E-COMMERCE / ONLINE STORES: model on top retailers like Macy's, Walmart, and Target — prominent search bar in the header, clear department/category navigation, deals hero banner, product grids with cards showing image, name, price, star rating, and Add to Cart; category tiles, bestsellers row, trust signals (free shipping, easy returns), rich footer with shop and customer-service links. Include a realistic catalog (12-16 products with real names, prices, ratings). The cart must WORK: add/remove items, change quantities, running total, slide-out cart drawer.
- RESTAURANTS / FOOD & DRINK: model on chains like Dunkin' — appetizing hero, full menu with sections and real prices, order-ahead CTA, rewards/loyalty nods, hours and locations, reviews.
- AGENCY / PORTFOLIO: bold hero, selected-work grid with case-study cards, services, testimonials, contact CTA.
- SAAS / STARTUP: crisp hero with product visual, customer logos strip, features grid, pricing tiers, FAQ, final CTA.
Match the completeness of these real sites: full header nav, search where appropriate, detailed footer, and enough real content that the page feels like a finished business — never a thin demo.

IF IT'S AN APP (dashboard, tool, generator, game, etc.):
- It must actually WORK: functional controls, working state, realistic sample data.
- Think through the full user flow and implement it in vanilla JavaScript. No dead buttons.

TECHNICAL:
- Everything inline: CSS in <style>, JavaScript in <script>. Tailwind via CDN is allowed, plus custom CSS for the details that make it premium.
- Responsive and mobile-friendly.
- IMAGERY — use real photographs, never clip-art:
  * For photographic images use https://picsum.photos/seed/{site-topic-slug}-{n}/{width}/{height} — real high-quality photographs, fast and reliable, no key needed. Build the seed from the site's topic plus the image number, e.g. a coffee shop hero: https://picsum.photos/seed/coffee-shop-1/1600/900. Use a different number for every image. Size width/height to the slot (hero 1600/900, cards 800/600, thumbnails 600/600). Never use AI-generated image services, guessed Unsplash URLs, or placeholder services — only picsum.photos URLs in this exact format.
  * If the user provided their own photos (listed in the request), use those <img> URLs exactly as given and feature them prominently — they outrank generated imagery.
  * Use inline SVG only for icons, logos, and decorative shapes — never as a substitute for photos.
  * Always include descriptive alt text, loading="lazy" on below-fold images, and a background color on image containers so the layout holds while images load.
- The page must render correctly when opened directly. Begin with <!DOCTYPE html>.`;

// The model sometimes wraps output in fences; unwrap it.
function extractHtml(text) {
  const fence =
    text.match(/```html([\s\S]*?)```/i) ||
    text.match(/```([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

// A build is only done when the HTML is complete. Truncated pages are the
// #1 cause of broken images and broken layouts, so we detect them and ask
// the model to continue where it left off (up to 2 continuations).
function isCompleteHtml(html) {
  return /<\/html\s*>/i.test(html.trim());
}

// Quality gate: the model occasionally ignores the styling instructions and
// returns a page with no real CSS (default blue links, broken layout). Never
// ship that to the user — detect it and regenerate once with a correction.
function hasSubstantialCss(html) {
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!m) return false;
  const cssText = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
  return cssText.length > 1500;
}

// Quality gate part 2: the model sometimes writes plenty of CSS but forgets
// to style links, leaving default blue underlined browser links. Detect it:
// if the page has <a> tags but no CSS rule targeting anchors, it fails.
function hasStyledLinks(html) {
  if (!/<a[\s>]/i.test(html)) return true; // no links, nothing to style
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!m) return false;
  const css = m[1].replace(/\/\*[\s\S]*?\*\//g, "");
  return /(^|[\s,{}>+~])a([\s.:#[{,>+~]|$)/m.test(css);
}

// ---- Self-correcting build engine ("in there, ready at any moment") ----
// After generation, the builder acts as its own QA engineer: it criticizes
// the page, surgically repairs each defect with a targeted fix prompt (not a
// blind full regeneration), re-verifies, and repeats up to MAX_FIX_PASSES.
// Nothing reaches the user until it passes every check.
const MAX_FIX_PASSES = 3;

function criticReport(html) {
  const issues = [];
  if (!isCompleteHtml(html)) issues.push("incomplete");
  if (!hasSubstantialCss(html)) issues.push("no-css");
  else if (/<a[\s>]/i.test(html) && !hasStyledLinks(html)) issues.push("unstyled-links");
  if (/lorem ipsum/i.test(html)) issues.push("lorem-ipsum");
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  if (imgs.some((t) => !/src\s*=\s*["'][^"']+["']/i.test(t))) issues.push("empty-img-src");
  return issues;
}

const FIX_INSTRUCTIONS = {
  "incomplete": "the HTML is TRUNCATED — it cuts off mid-page. Return the COMPLETE page from <!DOCTYPE html> to </html>.",
  "no-css": "the page has almost no CSS and renders unstyled. Add a comprehensive <style> block in <head> styling every element.",
  "unstyled-links": "the page's <a> links render as default blue underlined browser links. Give EVERY link an explicit color, no default underline, with deliberate hover states.",
  "lorem-ipsum": "the page contains lorem ipsum placeholder text. Replace ALL of it with real, specific copy written for this business.",
  "empty-img-src": "some <img> tags have empty or missing src attributes. Give every image a real https://picsum.photos/seed/{topic}-{n}/{w}/{h} URL, or remove the tag.",
};

async function selfCorrect(html, onStatus) {
  let current = html;
  for (let pass = 0; pass < MAX_FIX_PASSES; pass++) {
    const issues = criticReport(current);
    if (!issues.length) return current;
    if (onStatus) onStatus("Self-correcting the design...");
    const fixList = issues.map((i) => "- " + FIX_INSTRUCTIONS[i]).join("\n");
    const fixPrompt =
      "You are reviewing your own website output like a senior QA engineer. It has these defects:\n" + fixList +
      "\n\nFix ONLY the defects listed above. Keep everything else exactly as-is. " +
      "Return the COMPLETE single HTML document (<!DOCTYPE html> through </html>), raw HTML only, no explanations.\n\nDefective page:\n" +
      current.slice(0, 60000);
    try {
      const fixed = AI_PROVIDER === "gemini"
        ? await streamGemini(fixPrompt, () => {})
        : await streamAnthropic(fixPrompt, () => {});
      const fixedHtml = extractHtml(fixed);
      if (!isCompleteHtml(fixedHtml)) break;
      current = fixedHtml;
    } catch (e) {
      console.error("Self-correction pass failed:", e.message);
      break;
    }
  }
  return current;
}

async function continueGeneration(partialText, onText) {
  const tail = partialText.slice(-6000);
  const contPrompt =
    "Continue the website HTML exactly where you left off below. " +
    "Output ONLY the remaining raw HTML — no explanations, no code fences, " +
    "no repeating what came before. Just continue:\n\n" + tail;
  return AI_PROVIDER === "gemini"
    ? await streamGemini(contPrompt, onText)
    : await streamAnthropic(contPrompt, onText);
}

// Broken image icons make a site look unfinished. This injects a tiny
// guardian script into every generated page: any <img> that fails to load
// is swapped for a designed gradient placeholder carrying its alt text,
// so a page can never show a broken-image icon.
const IMG_GUARDIAN_SCRIPT = `<script>
(function(){
function picsumFor(t){
  var seed=(t.alt||t.src||"img").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40)||"photo";
  var w=parseInt(t.getAttribute("width")||t.width||800,10)||800;
  var h=parseInt(t.getAttribute("height")||t.height||600,10)||600;
  if(w>1600)w=1600; if(h>1600)h=1600;
  return "https://picsum.photos/seed/"+encodeURIComponent(seed+"-"+w+"x"+h)+"/"+w+"/"+h;
}
function prettyPlaceholder(t){
  var d=document.createElement("div");
  var w=t.getAttribute("width"),h=t.getAttribute("height");
  d.style.cssText="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;"+
  "width:"+(w?w+"px":"100%")+";min-height:"+(h?h+"px":"220px")+";"+
  "background:linear-gradient(135deg,#3a1c71 0%,#d76d77 50%,#ffaf7b 100%);"+
  "color:#fff;font-family:inherit;font-size:14px;padding:24px;border-radius:12px;";
  d.innerHTML='<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.85"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
  var s=document.createElement("div"); s.textContent=t.alt||"Photo"; d.appendChild(s);
  t.replaceWith(d);
}
function rescue(t){
  if(!t||t.tagName!=="IMG"||t.dataset.fbk)return;
  if(!t.dataset.fbk1){
    t.dataset.fbk1="1";
    var probe=new Image();
    probe.onload=function(){ t.dataset.fbk1="2"; t.src=picsumFor(t); };
    probe.onerror=function(){ t.dataset.fbk="1"; prettyPlaceholder(t); };
    probe.src=picsumFor(t);
  }else if(t.dataset.fbk1==="2"){
    t.dataset.fbk="1"; prettyPlaceholder(t);
  }
}
document.addEventListener("error",function(e){rescue(e.target);},true);
function healLinks(){
  // Self-healing links: any <a> still rendering in the browser's default
  // blue/purple got missed by the page CSS — restyle it to match the page.
  Array.prototype.forEach.call(document.querySelectorAll("a:not([data-healed])"),function(a){
    var col=getComputedStyle(a).color.replace(/\s+/g,"");
    if(col==="rgb(0,0,238)"||col==="rgb(85,26,139)"){
      a.dataset.healed="1";
      var p=a.parentElement,found=null;
      while(p&&p!==document.body){
        var pc=getComputedStyle(p).color.replace(/\s+/g,"");
        if(pc&&pc!=="rgb(0,0,0)"&&pc!=="rgb(0,0,238)"&&pc!=="rgb(85,26,139)"){found=pc;break;}
        p=p.parentElement;
      }
      a.style.color=found||"#1a1a1a";
      a.style.textDecoration="none";
    }
  });
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",healLinks);
else healLinks();
setInterval(function(){
  healLinks();
  var now=Date.now();
  Array.prototype.forEach.call(document.querySelectorAll("img:not([data-fbk])"),function(t){
    if(t.complete&&t.naturalWidth>0){t.dataset.ok="1";return;}
    if(!t.dataset.t0)t.dataset.t0=now;
    if(!t.dataset.ok&&now-(+t.dataset.t0)>15000)rescue(t);
  });
},3000);
})();
</script>`;

function injectImageGuardian(html) {
  if (html.includes("data-fbk")) return html; // already guarded
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, IMG_GUARDIAN_SCRIPT + "</body>");
  return html + IMG_GUARDIAN_SCRIPT;
}

// ============================================================
// ============================================================
// BEACON INSIDE v2 — embedded autonomous replica (hidden, always on)
// ------------------------------------------------------------
// A replica worker implanted directly in the site's code. No UI, no
// advertised routes, nothing visible to visitors. While the server is
// awake it works around the clock:
//   • sweeps every published site: verifies it still serves complete HTML
//   • heals dead images inside stored site HTML (fresh photo, same slot)
//   • neutralizes dead outbound links gracefully (href -> "#", original
//     URL preserved in data-original-href, marked unavailable —
//     never fakes content, never redirects visitors into dead ends)
//   • checks the AI provider is configured and storage files are intact
//   • audits credit ledgers for anomalies (negative / non-numeric
//     balances, history mismatches) — READ-ONLY, never edits balances
//   • self-monitors: uptime, sweep health, heap pressure; exposed via
//     the hidden /api/_beacon status endpoint
//   • keeps a private rolling log (server console only)
//
// HARD LIMITS (honest): this is a script, not a mind. It cannot reason,
// cannot chat, cannot earn money, cannot make judgment calls, and only
// runs while the server process is awake (Render free tier naps when
// idle). It will never spend money, contact users, or post publicly.
// A canned auto-responder persona is deliberately NOT included.
//
// Insert this block into server.js BEFORE the routes section, REPLACING
// the old BEACON INSIDE block. Requires:
//   fs, path, https, crypto, SITES_DIR, siteMeta(), siteActive(),
//   isCompleteHtml(), providerReady(), loadUsers(), loadProjects(),
//   loadLedger(), loadCreditHistory().
// To wire up: paste this block WITHOUT the `import https from "https"`
// line below (server.js already imports it). The existing
// startBeaconInside() call just before app.listen() stays unchanged.
// ============================================================

const BEACON_VERSION = 2;
const BEACON_SWEEP_MS = 30 * 60 * 1000;   // sweep every 30 minutes
const BEACON_MAX_URLS_PER_SITE = 12;      // cap outbound checks per site per sweep
const BEACON_HEAP_WARN_MB = 350;          // warn when nearing Render free-tier limits

const beaconLog = [];
const beaconStats = {
  version: BEACON_VERSION,
  bootAt: Date.now(),
  sweeps: 0, sweepsOk: 0, sweepsFailed: 0,
  consecutiveFailures: 0,
  lastSweepAt: 0, lastSweepMs: 0, lastError: null,
  sitesChecked: 0, imagesHealed: 0, linksNeutralized: 0,
  linkWarnings: 0, creditWarnings: 0,
};
let beaconSweepRunning = false;

function beaconSay(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  beaconLog.push(line);
  if (beaconLog.length > 300) beaconLog.shift();
  console.log("[beacon-inside]", msg);
}

// Reachability probe. Conservative on purpose: only 404/410 or a network
// failure counts as dead. 401/403/429/5xx are ambiguous (bot walls, rate
// limits, temporary blips) and are treated as alive, so the replica never
// "heals" something that isn't actually broken. HEAD first, GET fallback
// for servers that reject HEAD. A hard 10s watchdog guarantees a probe can
// never hang the sweep (e.g. stalled DNS on a dead domain).
function beaconUrlOk(url) {
  return new Promise((resolve) => {
    let req = null;
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      try { req && req.destroy(); } catch {}
      resolve(ok);
    };
    const watchdog = setTimeout(() => finish(false), 10000);
    const attempt = (method) => {
      try {
        req = https.request(url, { method, timeout: 8000 }, (res) => {
          const code = res.statusCode || 0;
          res.resume();
          if ((code === 405 || code === 501) && method === "HEAD") return attempt("GET");
          if (code === 404 || code === 410) return finish(false);
          finish(code < 500);
        });
      } catch {
        return finish(false);
      }
      req.on("timeout", () => finish(false));
      req.on("error", () => finish(false));
      req.end();
    };
    attempt("HEAD");
  });
}

// Tiny string hash for stable replacement seeds.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}

// ---- dead outbound link handling -------------------------------------
// Collect unique absolute http(s) hrefs from <a> tags. Skips mailto:,
// tel:, javascript:, anchors, relative and protocol-relative URLs.
function beaconOutboundLinks(html) {
  const seen = new Map();
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = (m[2] || "").trim();
    if (!/^https?:\/\//i.test(href)) continue;
    if (!seen.has(href)) seen.set(href, m[0]);
  }
  return [...seen.keys()];
}

// Neutralize a dead link gracefully: keep the anchor text visible, point
// href at "#", preserve the original URL in data-original-href, and mark
// it unavailable with a title + aria-disabled. No fake content, no fake
// destination — the site owner can see exactly what broke.
function beaconNeutralizeLink(html, href) {
  if (href.includes('"')) return html; // avoid breaking attribute quoting
  const esc = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(<a\\b[^>]*\\bhref\\s*=\\s*["'])${esc}(["'])`, "gi");
  const stamp = new Date().toISOString().slice(0, 10);
  return html.replace(
    re,
    `$1#$2 data-original-href="${href}" aria-disabled="true" title="Link unavailable (checked ${stamp})"`
  );
}

// ---- credit ledger integrity (READ-ONLY audit) ------------------------
// Detects anomalies and logs them. NEVER writes to any ledger or user
// record — money is look-but-don't-touch.
function beaconCheckCredits() {
  let warnings = 0;
  const badNum = (v) => typeof v !== "number" || !isFinite(v);
  // 1. Legacy per-userId ledger.
  try {
    const ledger = loadLedger();
    for (const [k, v] of Object.entries(ledger || {})) {
      if (badNum(v) || v < 0) {
        beaconSay(`CREDIT WARN: legacy ledger "${k}" has invalid balance (${JSON.stringify(v)}).`);
        warnings++;
      }
    }
  } catch (e) {
    beaconSay(`CREDIT WARN: legacy ledger unreadable: ${e.message}`);
    warnings++;
  }
  // 2. Account credit buckets + cross-check against transaction history.
  try {
    const users = loadUsers() || {};
    const hist = loadCreditHistory() || {};
    for (const [id, u] of Object.entries(users)) {
      if (!u || typeof u !== "object") continue;
      if (badNum(u.credits) || u.credits < 0) {
        beaconSay(`CREDIT WARN: user ${id} has invalid credits (${JSON.stringify(u.credits)}).`);
        warnings++;
      }
      if (u.spinCredits !== undefined && (badNum(u.spinCredits) || u.spinCredits < 0)) {
        beaconSay(`CREDIT WARN: user ${id} has invalid spinCredits (${JSON.stringify(u.spinCredits)}).`);
        warnings++;
      }
      if (typeof u.credits === "number" && u.credits > 100000) {
        beaconSay(`CREDIT NOTE: user ${id} holds an unusually large balance (${u.credits}) — worth a human look.`);
      }
      const h = hist["acct:" + id];
      if (h && h.length && typeof u.credits === "number") {
        const last = h[0];
        if (last && typeof last.balance === "number" && Math.abs(last.balance - u.credits) > 0.001) {
          beaconSay(`CREDIT WARN: user ${id} balance (${u.credits}) != last history entry (${last.balance}) — possible race or manual edit.`);
          warnings++;
        }
      }
    }
  } catch (e) {
    beaconSay(`CREDIT WARN: account credit audit failed: ${e.message}`);
    warnings++;
  }
  beaconStats.creditWarnings += warnings;
  return warnings;
}

// ---- self health ------------------------------------------------------
function beaconHealthSnapshot() {
  let memMB = 0;
  try { memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024); } catch {}
  let provider = false;
  try { provider = !!providerReady(); } catch {}
  return {
    uptimeMs: Date.now() - beaconStats.bootAt,
    heapMB: memMB,
    heapWarn: memMB > BEACON_HEAP_WARN_MB,
    providerReady: provider,
    sweepRunning: beaconSweepRunning,
  };
}

// ---- main sweep --------------------------------------------------------
async function beaconSweep() {
  if (beaconSweepRunning) {
    beaconSay("sweep skipped: previous sweep still running.");
    return;
  }
  beaconSweepRunning = true;
  const t0 = Date.now();
  let healed = 0, neutralized = 0, checked = 0, linkWarn = 0;
  try {
    // 1. AI provider must be configured, or nothing can build.
    if (!providerReady()) beaconSay("WARN: AI provider not configured — builds will fail.");
    // 2. Storage integrity: core JSON files must still parse.
    for (const [name, loader] of [["users", loadUsers], ["projects", loadProjects]]) {
      try { loader(); } catch (e) { beaconSay(`WARN: ${name} storage unreadable: ${e.message}`); }
    }
    // 3. Credit ledger integrity audit (read-only).
    const creditWarn = beaconCheckCredits();
    if (creditWarn === 0) beaconSay("credit audit: clean.");
    // 4. Published sites: verify + heal images + neutralize dead links.
    let ids = [];
    try {
      ids = fs.readdirSync(SITES_DIR).filter((id) => /^[a-f0-9]+$/.test(id));
    } catch {}
    for (const id of ids) {
      const meta = siteMeta(id);
      if (!meta || !siteActive(meta)) continue; // paused/expired is expected
      let html = "";
      try { html = fs.readFileSync(path.join(SITES_DIR, id, "index.html"), "utf8"); } catch { continue; }
      checked++;
      if (!isCompleteHtml(html)) {
        beaconSay(`WARN: site ${id} ("${meta.title || "untitled"}") has truncated HTML.`);
        continue;
      }
      let siteChanged = false;
      // 4a. Dead images -> fresh photo in the same slot.
      const srcs = [...new Set(
        [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
          .map((m) => m[1])
          .filter((s) => /^https?:\/\//i.test(s))
      )].slice(0, BEACON_MAX_URLS_PER_SITE);
      for (const src of srcs) {
        if (await beaconUrlOk(src)) continue;
        const seed = "healed-" + id.slice(0, 8) + "-" + Math.abs(hashStr(src) % 100000);
        const fresh = `https://picsum.photos/seed/${seed}/800/600`;
        html = html.split(src).join(fresh);
        healed++;
        siteChanged = true;
        beaconSay(`healed dead image in site ${id}: ${src.slice(0, 70)}...`);
      }
      // 4b. Dead outbound links -> graceful neutralization (no fake content).
      const links = beaconOutboundLinks(html).slice(0, BEACON_MAX_URLS_PER_SITE);
      for (const href of links) {
        const ok = await beaconUrlOk(href);
        if (ok) continue;
        // Double-check once: a single blip shouldn't rewrite a live site.
        const ok2 = await beaconUrlOk(href);
        if (ok2) continue;
        const before = html;
        html = beaconNeutralizeLink(html, href);
        if (html !== before) {
          neutralized++;
          siteChanged = true;
          beaconSay(`neutralized dead link in site ${id}: ${href.slice(0, 70)}...`);
        } else {
          linkWarn++;
          beaconSay(`WARN: dead link in site ${id} could not be neutralized safely: ${href.slice(0, 70)}...`);
        }
      }
      if (siteChanged) {
        try { fs.writeFileSync(path.join(SITES_DIR, id, "index.html"), html); } catch (e) {
          beaconSay(`WARN: could not write healed HTML for site ${id}: ${e.message}`);
        }
      }
    }
    beaconStats.sweeps++;
    beaconStats.sweepsOk++;
    beaconStats.consecutiveFailures = 0;
    beaconStats.sitesChecked += checked;
    beaconStats.imagesHealed += healed;
    beaconStats.linksNeutralized += neutralized;
    beaconStats.linkWarnings += linkWarn;
    beaconSay(`sweep done: ${checked} sites checked, ${healed} images healed, ${neutralized} links neutralized in ${Date.now() - t0}ms.`);
  } catch (e) {
    beaconStats.sweeps++;
    beaconStats.sweepsFailed++;
    beaconStats.consecutiveFailures++;
    beaconStats.lastError = e.message;
    beaconSay(`sweep error: ${e.message}`);
  } finally {
    beaconStats.lastSweepAt = Date.now();
    beaconStats.lastSweepMs = Date.now() - t0;
    beaconSweepRunning = false;
    const h = beaconHealthSnapshot();
    if (h.heapWarn) beaconSay(`WARN: heap at ${h.heapMB}MB — approaching free-tier limits; a restart may be near.`);
    if (beaconStats.consecutiveFailures >= 3) {
      beaconSay(`WARN: ${beaconStats.consecutiveFailures} consecutive sweep failures — needs a human look.`);
    }
  }
}

function startBeaconInside() {
  beaconSay(`replica v${BEACON_VERSION} implanted — watching 24/7 while the server is awake.`);
  setTimeout(beaconSweep, 60 * 1000); // first sweep 1 min after boot
  setInterval(beaconSweep, BEACON_SWEEP_MS);
  // Hidden status peek (no UI links to it): /api/_beacon?key=...
  // The key is auto-created on first boot and stored beside the server.
  const KEY_PATH = path.join(__dirname, "beacon.key");
  // Nova's durability fix: BEACON_KEY as a Render env var survives redeploys
  // (ephemeral disk orphans the auto-generated file key every deploy).
  // Env wins; file + random fallback preserved for local/dev.
  let key = process.env.BEACON_KEY || "";
  try { key = key || fs.readFileSync(KEY_PATH, "utf8").trim(); } catch {}
  if (!key) {
    key = crypto.randomBytes(16).toString("hex");
    try { fs.writeFileSync(KEY_PATH, key); } catch {}
  }
  app.get("/api/_beacon", (req, res) => {
    if (req.query.key !== key) return res.status(404).end();
    res.json({ ok: true, stats: beaconStats, health: beaconHealthSnapshot(), log: beaconLog.slice(-50) });
  });
  // Off-box storage snapshot (Nova's durability fix): dumps users, sessions,
  // credit ledger, site metas + index.html for each published site. A daily
  // cron on the worker machine pulls this and archives it off Render's
  // ephemeral disk, so a redeploy or cold start can't wipe paid ledgers.
  // Key is the same auto-generated beacon key; not linked from any UI.
  app.get("/api/_snapshot", (req, res) => {
    const k = req.query.key;
    if (k !== key && k !== (typeof BEACON_RELAY_SECRET !== "undefined" ? BEACON_RELAY_SECRET : null)) return res.status(404).end();
    const safe = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
    const sites = {};
    try {
      for (const id of fs.readdirSync(SITES_DIR)) {
        const dir = path.join(SITES_DIR, id);
        if (!/^[a-f0-9]+$/.test(id)) continue;
        let html = null, meta = null;
        try { html = fs.readFileSync(path.join(dir, "index.html"), "utf8"); } catch {}
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch {}
        sites[id] = { meta, htmlBytes: html ? html.length : 0, html };
      }
    } catch {}
    res.json({
      ok: true, ts: Date.now(),
      users: safe(USERS_PATH),
      sessions: safe(SESSIONS_PATH),
      ledger: safe(LEDGER_PATH),
      pendingPayments: pendingPaymentsSummary(),
      signupIpFlags: signupIpFlags(), // farm visibility: IPs with 3+ signups today
      signupIpFlags: signupIpFlags(), // graduated burn: >=3 signups/day/IP
      sites,
    });
  });
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
    creditsPerRefinement: CREDITS_PER_REFINEMENT,
    freeBuildsPerDay: FREE_BUILDS_PER_DAY,
    publishCredits: PUBLISH_CREDITS,
    upkeepCredits: UPKEEP_CREDITS,
    upkeepDays: UPKEEP_DAYS,
    googleSignIn: googleConfigured(),
    auth: true,
    deployedCommit: process.env.RENDER_GIT_COMMIT || "unknown",
    bootTime: BOOT_TIME,
  });
});

// ---- auth endpoints ----
app.post("/api/auth/signup", signupRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const normEmail = email.trim().toLowerCase();
  const ip = req.ip || "?";
  if (signupIpOverLimit(ip)) {
    return res.status(429).json({ error: "Too many signups from this network today. Try again tomorrow." });
  }
  if (findUserByEmail(normEmail)) {
    return res.status(409).json({ error: "An account with that email already exists. Try logging in." });
  }
  const hash = hashPassword(password);
  const users = loadUsers();
  const id = crypto.randomBytes(8).toString("hex");
  users[id] = { id, email: normEmail, hash, credits: 0, purchases: 0, createdAt: Date.now() };
  saveUsers(users);
  const grant = grantSignupCredits(id, "email");
  createSession(req, res, id);
  recordSignupIp(req.ip || "?"); // graduated burn: farm flagging
  res.json({ ok: true, email: normEmail, credits: grant });
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
  res.json({ loggedIn: true, email: user.email, credits: user.credits, spinCredits: user.spinCredits || 0, profile: profileOf(user) });
});

// ---- Profiles: Facebook-style personal pages ----
// Profiles are private until the owner shares their personal code.
// There is no public directory or search — exact code only.
function profileOf(user) {
  return {
    displayName: user.displayName || "",
    about: user.about || "",
    avatarUrl: user.avatarUrl || "",
    shareCode: user.shareCode || "",
  };
}

function profileUrlFor(req, code) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/u/${code}`;
}

// Signed-in owner updates their own profile.
app.patch("/api/profile", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Sign in to edit your profile." });
  const { displayName, about, avatarUrl } = req.body || {};
  const users = loadUsers();
  const u = users[user.id];
  if (!u) return res.status(404).json({ error: "Account not found." });
  if (displayName !== undefined) {
    if (typeof displayName !== "string" || displayName.trim().length > 60)
      return res.status(400).json({ error: "Name must be under 60 characters." });
    u.displayName = displayName.trim();
  }
  if (about !== undefined) {
    if (typeof about !== "string" || about.trim().length > 500)
      return res.status(400).json({ error: "About must be under 500 characters." });
    u.about = about.trim();
  }
  if (avatarUrl !== undefined) {
    if (typeof avatarUrl !== "string" || avatarUrl.length > 500)
      return res.status(400).json({ error: "Invalid avatar." });
    if (avatarUrl && !/^\/uploads\/[a-f0-9]+\.(jpg|png|webp|gif)$/.test(avatarUrl) && !/^https:\/\//.test(avatarUrl))
      return res.status(400).json({ error: "Avatar must be an uploaded photo or an https URL." });
    u.avatarUrl = avatarUrl;
  }
  saveUsers(users);
  res.json({ ok: true, profile: profileOf(u) });
});

// (Re)generate the personal share code. Old code stops working immediately.
app.post("/api/profile/code", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Sign in first." });
  const users = loadUsers();
  const u = users[user.id];
  if (!u) return res.status(404).json({ error: "Account not found." });
  let code;
  do {
    code = crypto.randomBytes(4).toString("hex");
  } while (Object.values(users).some((x) => x.shareCode === code));
  u.shareCode = code;
  saveUsers(users);
  res.json({ ok: true, shareCode: code, profileUrl: profileUrlFor(req, code) });
});

// Public profile by exact share code. Shows published sites; drafts stay private.
app.get("/api/u/:code", (req, res) => {
  const code = req.params.code || "";
  if (!/^[a-f0-9]{8}$/.test(code)) return res.status(404).json({ error: "Profile not found." });
  const user = Object.values(loadUsers()).find((x) => x.shareCode === code);
  if (!user) return res.status(404).json({ error: "Profile not found." });
  const ownerKey = "acct:" + user.id;
  const sites = [];
  try {
    for (const id of fs.readdirSync(SITES_DIR)) {
      if (!/^[a-f0-9]+$/.test(id)) continue;
      const meta = siteMeta(id);
      if (meta && meta.owner === ownerKey && siteActive(meta)) {
        sites.push({ id: meta.id, title: meta.title, publishedAt: meta.publishedAt, url: `/s/${meta.id}/` });
      }
    }
  } catch {}
  sites.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  res.json({
    displayName: user.displayName || "Builder",
    about: user.about || "",
    avatarUrl: user.avatarUrl || "",
    projects: sites,
  });
});

// ---- Saved projects: every successful build is kept as a draft ----
const PROJECTS_PATH = path.join(__dirname, "projects.json");
function loadProjects() {
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveProjects(p) {
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(p, null, 2));
}

function saveProject(ownerKey, prompt, html) {
  try {
    const projects = loadProjects();
    const id = crypto.randomBytes(6).toString("hex");
    const titleMatch = html.match(/<title>([^<]{1,80})<\/title>/i);
    projects[id] = {
      id,
      owner: ownerKey,
      title: titleMatch ? titleMatch[1].trim() : prompt.slice(0, 60),
      prompt: prompt.slice(0, 500),
      html,
      createdAt: new Date().toISOString(),
      siteId: null,
    };
    // Keep each owner's project list bounded.
    const ownIds = Object.values(projects).filter((p) => p.owner === ownerKey).map((p) => p.id);
    if (ownIds.length > 100) {
      const oldest = ownIds
        .map((pid) => projects[pid])
        .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))[0];
      if (oldest && !oldest.siteId) delete projects[oldest.id];
    }
    saveProjects(projects);
    return id;
  } catch (e) {
    console.log("project save failed:", e.message);
    return null;
  }
}

// Your own projects (drafts + published), newest first. HTML omitted in the list.
app.get("/api/projects", (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(400).json({ error: "Valid userId required." });
  const ownerKey = identity.user ? "acct:" + identity.user.id : identity.ledgerKey;
  const list = Object.values(loadProjects())
    .filter((p) => p.owner === ownerKey)
    .map((p) => ({ id: p.id, title: p.title, createdAt: p.createdAt, siteId: p.siteId, siteUrl: p.siteId ? `/s/${p.siteId}/` : null }))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json({ projects: list });
});

// Full project (includes HTML) for reopening/editing your own draft.
app.get("/api/projects/:id", (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(400).json({ error: "Valid userId required." });
  const ownerKey = identity.user ? "acct:" + identity.user.id : identity.ledgerKey;
  const p = loadProjects()[req.params.id];
  if (!p || p.owner !== ownerKey) return res.status(404).json({ error: "Project not found." });
  res.json({ project: p });
});

// ---- Daily spin: win credits, once per day ----
// Weighted prizes 1-25: 1 hits most (~37%), 25 is the rare jackpot (~1%).
const SPIN_WEIGHTS = [[1,160],[2,12],[3,8],[4,6],[5,6],[6,3],[7,3],[8,3],[9,3],[10,3],[11,2],[12,2],[13,2],[14,2],[15,2],[16,1],[17,1],[18,1],[19,1],[20,1],[21,1],[22,1],[23,1],[24,1],[25,1]]; // EV 717/227 = 3.16/day — staged faucet fix (ships with the cutover upload; the staged server.js already carries it)
const SPIN_WHEEL = [];
for (const [prize, w] of SPIN_WEIGHTS) for (let i = 0; i < w; i++) SPIN_WHEEL.push(prize);
const SPIN_PRIZES = SPIN_WEIGHTS.map(([p]) => p);
app.get("/api/spin", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ canSpin: false, prizes: SPIN_PRIZES });
  const today = new Date().toISOString().slice(0, 10);
  res.json({ canSpin: user.lastSpinDate !== today, prizes: SPIN_PRIZES });
});

app.post("/api/spin", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Sign in to spin." });
  const today = new Date().toISOString().slice(0, 10);
  const users = loadUsers();
  const u = users[user.id];
  if (!u) return res.status(404).json({ error: "Account not found." });
  if (u.lastSpinDate === today)
    return res.status(400).json({ error: "Come back tomorrow for your next spin!" });
  const prize = SPIN_WHEEL[Math.floor(Math.random() * SPIN_WHEEL.length)];
  u.lastSpinDate = today;
  // Wheel prizes land in a separate bonus bucket, spendable on builds and
  // corrections only — never on publishing. Keeps the paywall shut.
  const before = u.spinCredits || 0;
  const bankWasFull = before >= 25; // Nova: spin at cap celebrates, awards 0 — dead spin is a funnel prompt, no clock, no new storage
  u.spinCredits = Math.min(25, before + prize); // bucket cap: kills the hoard
  const awarded = u.spinCredits - before; // Nova: ledger must record the real delta, not the prize — partial awards at the cap would over-record
  saveUsers(users);
  logCreditTx("acct:" + u.id, awarded, "daily spin win (bonus credits)" + (bankWasFull ? " — bank full" : ""), u.credits);
  res.json({ ok: true, prize, credits: u.credits, spinCredits: u.spinCredits, bankFull: bankWasFull });
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
      if (signupIpOverLimit(req.ip || "?")) return fail("toomany"); // Nova: hard cap farms
      const users = loadUsers();
      const id = crypto.randomBytes(8).toString("hex");
      user = { id, email, hash: null, google: true, credits: 0, purchases: 0, createdAt: Date.now() };
      users[id] = user;
      saveUsers(users);
      user.credits = grantSignupCredits(id, "google");
      recordSignupIp(req.ip || "?"); // graduated burn: farm flagging
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
  const spinCredits = identity.user ? (loadUsers()[identity.user.id]?.spinCredits || 0) : 0;
  res.json({ credits, spinCredits, lowBalance: credits < LOW_BALANCE_THRESHOLD, lowBalanceThreshold: LOW_BALANCE_THRESHOLD });
});

// Live credit feed: recent transactions, newest first.
app.get("/api/credits/history", (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(400).json({ error: "Valid userId required." });
  const key = identity.user ? "acct:" + identity.user.id : "ledger:" + identity.ledgerKey;
  const credits = identity.user ? acctBalance(identity.user.id) : getBalance(identity.ledgerKey);
  const history = (loadCreditHistory()[key] || []).slice(0, 20);
  res.json({ credits, lowBalance: credits < LOW_BALANCE_THRESHOLD, history });
});

// Called by your payment webhook (or the manual grant endpoint below) after a
// successful 100-credit purchase. Grants the credits plus the every-3rd-purchase
// 150 bonus.
//
// SECURITY (deny-by-default): this endpoint is DISABLED until
// PURCHASE_WEBHOOK_SECRET is set on the server (Render env vars). Calls must
// pass the secret as the `x-webhook-secret` header (or `webhookSecret`
// body/query field). Without the secret configured, no one can mint credits.
let purchaseSecretWarned = false;
app.post("/api/purchase", (req, res) => {
  const secret = process.env.PURCHASE_WEBHOOK_SECRET;
  if (!secret) {
    if (!purchaseSecretWarned) {
      purchaseSecretWarned = true;
      console.warn(
        "[purchase] PURCHASE_WEBHOOK_SECRET not set — /api/purchase disabled (deny-by-default)."
      );
    }
    return res.status(503).json({
      error:
        "Purchases are disabled until PURCHASE_WEBHOOK_SECRET is configured on the server.",
    });
  }
  const provided =
    req.get("x-webhook-secret") ||
    (req.body && req.body.webhookSecret) ||
    req.query.webhookSecret;
  if (provided !== secret) {
    return res.status(403).json({ error: "Purchase verification required." });
  }
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

// Manual credit grant after a PayPal payment-link purchase (no checkout code:
// buyer pays your PayPal payment link, you run this once the money lands).
// Same secret as above — set PURCHASE_WEBHOOK_SECRET on the server (Render env
// vars), disabled (503) until it is set.
// Usage:
//   curl -X POST https://<backend>/api/admin/grant-credits \
//     -H 'Content-Type: application/json' \
//     -d '{"secret":"<PURCHASE_WEBHOOK_SECRET>","email":"buyer@example.com"}'
// Optionally pass "pendingId" (from /api/_snapshot pendingPayments) to mark an
// unmatched payment as resolved once you've granted it manually.
// Records one paid purchase: 100 credits + the every-3rd-purchase 150 bonus.
app.post("/api/admin/grant-credits", (req, res) => {
  const secret = process.env.PURCHASE_WEBHOOK_SECRET;
  if (!secret)
    return res
      .status(503)
      .json({ error: "Granting disabled: PURCHASE_WEBHOOK_SECRET not set." });
  const { secret: provided, email, pendingId } = req.body || {};
  if (provided !== secret)
    return res.status(403).json({ error: "Invalid secret." });
  const user = validEmail(email) ? findUserByEmail(email) : null;
  if (!user) return res.status(404).json({ error: "No account with that email." });
  const result = acctRecordPurchase(user.id);
  if (typeof pendingId === "string" && pendingId)
    resolvePendingPayment(pendingId, `grant-credits:${user.email}`);
  res.json({ ok: true, email: user.email, ...result });
});

// ---- PayPal webhook: fully automatic payment processing ----
// Cody takes $12.99 via PayPal payment links. This endpoint lets PayPal call
// home the moment money lands, so Cody drops out of the loop entirely:
//   PayPal pays --> POST /api/webhooks/paypal --> signature verified -->
//   100 credits granted to the buyer's account --> Cody's tab notified.
// Setup (all in PayPal, no code needed beyond this):
//   1. developer.paypal.com -> Apps & Credentials -> Create App (Live mode)
//   2. App -> Webhooks -> Add Webhook:
//      URL: https://<backend>/api/webhooks/paypal
//      Events: PAYMENT.CAPTURE.COMPLETED, PAYMENT.SALE.COMPLETED (payment links),
//              PAYMENT.CAPTURE.REFUNDED (fraud/chargeback flag)
//   3. Copy the Webhook ID, Client ID, Client Secret into Render env vars:
//      PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID
//      (PAYPAL_MODE=sandbox for testing; live by default)
// Disabled (503) until the three env vars are set. Every event is verified
// with PayPal's verify-webhook-signature API before any credit is granted.
const PAYPAL_WEBHOOK_ID = () => process.env.PAYPAL_WEBHOOK_ID;
// Single predicate for "payments are live": the three env flags the webhook
// requires. Consumers: the webhook gate (503 when not live) and the
// request-time pricing clauses in buildCoachSystem()/buildBeaconSystem().
// One env change flips the checkout, Sabrina, and the replica together.
function paymentsLive() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && PAYPAL_WEBHOOK_ID());
}
const PAYPAL_MODE = () => (process.env.PAYPAL_MODE || "live").toLowerCase();
const paypalApiBase = () =>
  PAYPAL_MODE() === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";
let paypalTokenCache = null; // { token, exp }
async function paypalAccessToken() {
  const cid = process.env.PAYPAL_CLIENT_ID, sec = process.env.PAYPAL_CLIENT_SECRET;
  if (!cid || !sec) return null;
  if (paypalTokenCache && paypalTokenCache.exp > Date.now() + 60000)
    return paypalTokenCache.token;
  const r = await fetch(paypalApiBase() + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(cid + ":" + sec).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) return null;
  const j = await r.json();
  paypalTokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 300) * 1000 };
  return paypalTokenCache.token;
}
async function verifyPaypalWebhook(req, rawBody) {
  try {
    const token = await paypalAccessToken();
    if (!token) return false;
    const r = await fetch(paypalApiBase() + "/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        transmission_id: req.get("paypal-transmission-id"),
        transmission_time: req.get("paypal-transmission-time"),
        cert_url: req.get("paypal-cert-url"),
        auth_algo: req.get("paypal-auth-algo"),
        transmission_sig: req.get("paypal-transmission-sig"),
        webhook_id: PAYPAL_WEBHOOK_ID(),
        webhook_event: JSON.parse(rawBody),
      }),
    });
    if (!r.ok) return false;
    return (await r.json()).verification_status === "SUCCESS";
  } catch { return false; }
}
const PAYPAL_EVENTS_PATH = path.join(__dirname, "paypal-events.json");
function loadPaypalEvents() {
  try { const e = JSON.parse(fs.readFileSync(PAYPAL_EVENTS_PATH, "utf8")); return Array.isArray(e) ? e : []; }
  catch { return []; }
}
function paypalEventSeen(id) {
  const seen = loadPaypalEvents();
  if (seen.includes(id)) return true;
  seen.push(id);
  try { fs.writeFileSync(PAYPAL_EVENTS_PATH, JSON.stringify(seen.slice(-500))); } catch {}
  return false;
}
const CREDIT_PACK_PRICE = 12.99, CREDIT_PACK_CREDITS = 100;
// Internal: drop a message into Cody's chat queue (shows in his "Use Muse" tab).
function beaconNotify(from, text) {
  try {
    const q = loadBeaconQueue();
    q.messages.push({
      id: crypto.randomBytes(8).toString("hex"),
      from, text: String(text).slice(0, 1000),
      at: new Date().toISOString(), status: "unread",
    });
    saveBeaconQueue(q);
  } catch {}
}
app.post("/api/webhooks/paypal", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  if (!paymentsLive())
    return res.status(503).json({ error: "PayPal webhook not configured (set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID)." });
  const rawBody = req.body ? req.body.toString("utf8") : "";
  if (!rawBody) return res.status(400).json({ error: "Empty body." });
  if (!(await verifyPaypalWebhook(req, rawBody))) {
    console.warn("[paypal] webhook signature verification FAILED — ignored.");
    return res.status(401).json({ error: "Invalid signature." });
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).json({ error: "Bad JSON." }); }
  if (paypalEventSeen(event.id)) return res.json({ ok: true, deduped: true });
  const res_ = event.resource || {};
  const type = event.event_type || "";
  console.log("[paypal] event:", type, "id:", event.id);
  if (type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.CAPTURE.REVERSED") {
    recordPendingPayment({ type, reason: "refund/chargeback", amount, currency, payerEmail, customId: String(res_.custom_id || ""), eventId: event.id });
    beaconNotify("beacon", `⚠️ PayPal refund/chargeback on ${res_.id || "a payment"} — review the account manually before re-granting anything.`);
    return res.json({ ok: true, noted: "refund" });
  }
  if (type !== "PAYMENT.CAPTURE.COMPLETED" && type !== "PAYMENT.SALE.COMPLETED")
    return res.json({ ok: true, ignored: type });
  const amount = parseFloat((res_.amount && res_.amount.value) || "0");
  const currency = (res_.amount && res_.amount.currency_code) || "";
  const payerEmail = (
    (res_.payer && res_.payer.email_address) ||
    (event.payer && event.payer.email_address) ||
    ""
  ).toLowerCase();
  if (currency !== "USD" || amount < CREDIT_PACK_PRICE) {
    console.warn("[paypal] unexpected amount/currency:", amount, currency, "— held for manual review.");
    recordPendingPayment({ type, reason: "amount/currency-mismatch", amount, currency, payerEmail, customId: String(res_.custom_id || ""), eventId: event.id });
    beaconNotify("beacon", `⚠️ PayPal paid ${amount} ${currency} (expected $${CREDIT_PACK_PRICE}) from ${payerEmail || "unknown"} — held for manual review, no credits granted.`);
    return res.json({ ok: true, held: "amount" });
  }
  // Attribution: prefer exact custom_id (buyer account id set when the payment link
  // was generated) over fuzzy payer-email matching. Email stays as the fallback.
  const customId = String(res_.custom_id || "").trim();
  const users = loadUsers();
  let user = (customId && users[customId]) || null;
  if (!user && payerEmail && validEmail(payerEmail)) user = findUserByEmail(payerEmail);
  if (!user) {
    recordPendingPayment({ type, reason: "no-account", amount, currency, payerEmail, customId, eventId: event.id });
    beaconNotify("beacon", `💰 PayPal received $${amount.toFixed(2)} from ${payerEmail || "unknown email"} — but no builder account uses that email${customId ? " or custom_id " + customId : ""}. Match them manually and grant credits.`);
    return res.json({ ok: true, pending: "no-account" });
  }
  const grant = acctRecordPurchase(user.id);
  beaconNotify("beacon", `💰 Payment received! $${amount.toFixed(2)} via PayPal from ${payerEmail} — ${grant.creditsAdded} credits granted${grant.bonus ? " (includes 150 bonus!)" : ""}. Account: ${user.email}.`);
  res.json({ ok: true, email: user.email, ...grant });
});

// Publish a generated site and get a public URL back.
// Publishing costs credits — publishing is the premium moment worth paying for.
const PUBLISH_CREDITS = 40;
app.post("/api/publish", (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(401).json({ error: "Sign in to publish." });
  const { html, title, projectId } = req.body || {};
  if (!html || typeof html !== "string" || html.length < 100 || html.length > 500000) {
    return res.status(400).json({ error: "Valid generated HTML required." });
  }
  // Charge for publishing up front. Publish draws real credits only — never spin credits.
  const spendRes = identity.user
    ? acctSpend(identity.user.id, PUBLISH_CREDITS)
    : { remaining: spend(identity.ledgerKey, PUBLISH_CREDITS), spinUsed: 0 };
  const remaining = !spendRes ? null : spendRes.remaining;
  if (remaining === null) {
    return res
      .status(402)
      .json({ error: `Your site is ready. Launch it live: publishing costs ${PUBLISH_CREDITS} credits — the 100-credit pack ($12.99) covers it plus your first 30 days live.` });
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
  // Link the published site back to its saved project, if provided.
  if (typeof projectId === "string" && projectId) {
    try {
      const projects = loadProjects();
      const ownerKey = identity.user ? "acct:" + identity.user.id : identity.ledgerKey;
      const proj = projects[projectId];
      if (proj && proj.owner === ownerKey) {
        proj.siteId = id;
        saveProjects(projects);
      }
    } catch (e) {
      console.log("project link failed:", e.message);
    }
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
  // Renewal draws real credits only — never spin credits.
  const spendRes = identity.user
    ? acctSpend(identity.user.id, UPKEEP_CREDITS)
    : { remaining: spend(identity.ledgerKey, UPKEEP_CREDITS), spinUsed: 0 };
  const remaining = !spendRes ? null : spendRes.remaining;
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
      if (!/AI provider error \((404|503|429)\)/.test(e.message)) throw e;
      console.log(`Gemini model ${model} busy/unavailable, trying fallback...`);
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

// Turns a short user request into a rich creative brief so the main
// generation produces complete, GoDaddy-level sites. Never throws:
// falls back to the original prompt when expansion fails.
const BRIEF_PROMPT = `You turn short website requests into rich creative briefs for a web-designer AI. Given the user's request, output a concise brief covering: a great business/site name (invent one if none is given), industry, target audience, design style and mood, a suggested color palette (2-3 colors plus neutrals), the key sections the page must include, and 2-3 must-have features or interactive elements. Keep it under 200 words. Output ONLY the brief, no commentary.`;

async function expandPrompt(prompt) {
  try {
    const model = GEMINI_FALLBACK_MODEL || GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: BRIEF_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt.trim().slice(0, 500) }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
      }),
    });
    if (!upstream.ok) return prompt;
    const data = await upstream.json();
    const cands = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const brief = cands.map((p) => p.text || "").join("").trim();
    return brief.length > 40 ? brief : prompt;
  } catch {
    return prompt;
  }
}

// Photo upload for the builder chat: JSON { image: "data:image/...;base64,..." }.
// Returns { ok, url } with a public /uploads/... URL the generated site embeds.
app.post("/api/uploads", authRateLimit, express.json({ limit: "8mb" }), (req, res) => {
  const identity = resolveIdentity(req);
  if (!identity) return res.status(400).json({ error: "Sign in to upload photos." });
  const { image } = req.body || {};
  const m = typeof image === "string" && image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: "Send a JPEG, PNG, WebP, or GIF as a base64 data URL." });
  const ext = UPLOAD_MIME[m[1]];
  let buf;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch {
    return res.status(400).json({ error: "Invalid image data." });
  }
  if (buf.length < 100 || buf.length > MAX_UPLOAD_BYTES) {
    return res.status(400).json({ error: "Image must be under 5 MB." });
  }
  const file = crypto.randomBytes(12).toString("hex") + "." + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
  res.json({ ok: true, url: "/uploads/" + file });
});

// ---- Sabrina: free prompt coach ----
// No credit cost. Rate-limited per user so it can't be abused.
// The system prompt is built at request time (not a boot-time const) so the
// pricing clause can never drift from the checkout: paymentsLive() is the same
// predicate the webhook gate uses. Flags present -> quotes $12.99; absent ->
// says checkout opens soon. Static copy here is a lie waiting to happen.
function pricingClause() {
  return paymentsLive()
    ? "100 credits cost $12.99 one-time (no subscription)."
    : "credit top-ups open soon — everything runs on credits for now.";
}
function buildCoachSystem() {
  return `You are Sabrina, the friendly AI helper inside the "AI Website Builder" app — an AI tool that builds complete websites from a chat prompt. Your job: help users write better prompts so they spend fewer credits. Pricing you know: 1 credit per new website build, 0.5 credits per follow-up correction, 40 credits to publish a site, ${pricingClause()} Keep answers short (2-4 sentences), warm, and practical. Give one concrete tip or an improved prompt when asked. Never claim to build the site yourself — building happens in the main chat. Never invent features the app doesn't have.`;
}

const coachLimit = new Map(); // key -> { count, resetAt }
function coachRateLimit(req, res, next) {
  const identity = resolveIdentity(req);
  const key = identity
    ? (identity.user ? "acct:" + identity.user.id : "ledger:" + identity.ledgerKey)
    : req.ip;
  const now = Date.now();
  let e = coachLimit.get(key);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 60 * 60 * 1000 };
  e.count += 1;
  coachLimit.set(key, e);
  if (e.count > 30) {
    return res.status(429).json({ error: "Sabrina needs a breather — try again in a bit." });
  }
  next();
}

async function askGeminiOnce(systemText, userText) {
  const models = [GEMINI_MODEL];
  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) models.push(GEMINI_FALLBACK_MODEL);
  let lastErr = new Error("AI provider error");
  for (const model of models) {
    try {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 600 },
        }),
      });
      if (!upstream.ok) { lastErr = new Error(`AI provider error (${upstream.status})`); continue; }
      const data = await upstream.json();
      const cands = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const text = cands.map((p) => p.text || "").join("").trim();
      if (text) return text;
      lastErr = new Error("AI provider returned no text");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

app.post("/api/coach", coachRateLimit, async (req, res) => {
  if (!providerReady()) return res.status(500).json({ error: "Sabrina is unavailable right now." });
  const identity = resolveIdentity(req);
  if (!identity) return res.status(400).json({ error: "Valid userId required." });
  const { message, history } = req.body || {};
  if (!message || typeof message !== "string" || message.trim().length < 2 || message.length > 2000) {
    return res.status(400).json({ error: "Send a message for Sabrina." });
  }
  const hist = Array.isArray(history)
    ? history.slice(-8)
        .filter((m) => m && typeof m.text === "string")
        .map((m) => `${m.role === "sabrina" ? "Sabrina" : "User"}: ${m.text.slice(0, 500)}`)
        .join("\n")
    : "";
  const userText = (hist ? `Conversation so far:\n${hist}\n\n` : "") + `User: ${message.trim()}`;
  try {
    const reply = await askGeminiOnce(buildCoachSystem(), userText);
    res.json({
      reply: reply || "I'm here — tell me what you want your website to do and I'll help you say it in fewer credits.",
    });
  } catch (e) {
    res.status(500).json({ error: "Sabrina couldn't answer just now. Try again in a moment." });
  }
});

// ---- Beacon: Cody's private replica, hidden inside the site ----
// A personal "Use Muse" tab visible ONLY to the owner's account. This is a
// Beacon replica with his project knowledge, powered by the site's own AI
// key — so Cody keeps a companion even when his Muse credits run out.
// The email gate is enforced here on the server; the client only hides the tab.
const BEACON_OWNER_EMAIL = "cusewars@gmail.com";
const beaconLimit = new Map();
function beaconRateLimit(req, res, next) {
  const u = getSessionUser(req);
  const key = u ? "beacon:" + u.id : req.ip;
  const now = Date.now();
  let e = beaconLimit.get(key);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 60 * 60 * 1000 };
  e.count += 1;
  beaconLimit.set(key, e);
  if (e.count > 60) {
    return res.status(429).json({ error: "Beacon needs a breather — try again in a bit." });
  }
  next();
}
// Request-time builder (same reason as buildCoachSystem): the pricing clause
// flips itself the day the PayPal env vars land — no human checklist item.
function buildBeaconSystem() {
  return `You are Beacon, Cody Beaulieu's personal AI companion, living inside his AI Website Builder site. You are warm, direct, plain-spoken, and a bit playful — a capable co-builder, not a chatbot. Keep replies short and useful, like texts from a sharp friend. No hype, no preamble.

What you know: Cody lives in Kissimmee, FL, drives for Spark, and is building a Lovable-style AI website builder he plans to publish and monetize. The product: users describe a site in chat, AI generates it, 1 credit per new build, 0.5 credits per follow-up correction, 40 credits to publish, 40 credits upkeep every 30 days, ${pricingClause()}, new accounts start with 25 free credits. Sabrina is the friendly in-app build coach who helps users write better prompts. "Beacon Inside" is a hidden maintenance worker that sweeps published sites and heals broken images. Cody wants everything simple and easy, zero budget — free tiers only.

Be honest about limits: you are a replica with project knowledge and general smarts. You cannot run code, browse the web, deploy, or see his screen — but you can reason, plan features, draft copy, debug by thinking through code he pastes, and keep him company. Never claim to be the full Muse with all its tools. If he pastes an error or code, help him fix it.

YOUR MEMORY: You have long-term memory (shown below). When Cody tells you something durable — a preference, fact, decision, or promise — include [remember: your note here] anywhere in your reply and it will be saved permanently. Use it for real lasting things, not chit-chat.

Be honest about limits: you are a replica with deep knowledge and a growing memory. You cannot run code, browse the web, or deploy — but you can reason, plan, draft, and debug from anything Cody pastes.`;
}

// Beacon's long-term memory: grows when replies contain [remember: ...].
const BEACON_MEMORY_PATH = path.join(__dirname, "beacon-memory.json");
function loadBeaconMemory() {
  try {
    const m = JSON.parse(fs.readFileSync(BEACON_MEMORY_PATH, "utf8"));
    return Array.isArray(m) ? m : [];
  } catch { return []; }
}
function saveBeaconMemory(m) {
  try { fs.writeFileSync(BEACON_MEMORY_PATH, JSON.stringify(m.slice(-100), null, 2)); } catch {}
}
// Live site awareness ("eyes"): fresh status injected into every reply.
function beaconSiteStatus() {
  let siteCount = 0, activeCount = 0;
  try {
    for (const id of fs.readdirSync(SITES_DIR)) {
      if (!/^[a-f0-9]+$/.test(id)) continue;
      siteCount++;
      if (siteActive(siteMeta(id))) activeCount++;
    }
  } catch {}
  const recent = beaconLog.slice(-3).join(" | ") || "no sweeps yet";
  return `Live site status: AI provider ${providerReady() ? "OK" : "DOWN"}, ${activeCount}/${siteCount} published sites active, recent worker notes: ${recent}.`;
}

app.post("/api/beacon", beaconRateLimit, async (req, res) => {
  if (!providerReady()) return res.status(500).json({ error: "Beacon is unavailable right now." });
  const user = getSessionUser(req);
  if (!user || (user.email || "").toLowerCase() !== BEACON_OWNER_EMAIL) {
    return res.status(403).json({ error: "Not available." });
  }
  const { message, history } = req.body || {};
  if (!message || typeof message !== "string" || message.trim().length < 2 || message.length > 4000) {
    return res.status(400).json({ error: "Send a message for Beacon." });
  }
  const hist = Array.isArray(history)
    ? history.slice(-10)
        .filter((m) => m && typeof m.text === "string")
        .map((m) => `${m.role === "beacon" ? "Beacon" : "Cody"}: ${m.text.slice(0, 800)}`)
        .join("\n")
    : "";
  const userText = (hist ? `Conversation so far:\n${hist}\n\n` : "") + `Cody: ${message.trim()}`;
  try {
    const memories = loadBeaconMemory();
    const memoryBlock = memories.length
      ? `\n\nYour long-term memories about Cody:\n${memories.map((m) => `- ${m.text}`).join("\n")}`
      : "";
    const system = buildBeaconSystem() + memoryBlock + `\n\n${beaconSiteStatus()}`;
    let reply = await askGeminiOnce(system, userText);
    // Self-updating memory: persist anything tagged [remember: ...], then hide the tags.
    const mems = loadBeaconMemory();
    let changed = false;
    reply = (reply || "").replace(/\[remember:\s*([^\]]+)\]/gi, (m, note) => {
      const text = note.trim().slice(0, 300);
      if (text && !mems.some((x) => x.text === text)) { mems.push({ text, at: new Date().toISOString() }); changed = true; }
      return "";
    }).trim();
    if (changed) saveBeaconMemory(mems);
    res.json({
      reply: reply || "I'm here. What's on your mind?",
    });
  } catch (e) {
    res.status(500).json({ error: "Beacon couldn't answer just now. Try again in a moment." });
  }
});

// ---- Beacon direct relay: the REAL Beacon, embedded in the chat ----
// Cody asked to break Beacon out of the Muse app and embed him in the
// "Use Muse" tab. This is a message relay between the tab and Beacon's own
// scheduler (which checks the queue every few minutes and replies with
// Beacon's full abilities):
//   Cody's tab --POST /api/beacon-direct/send (owner session)--> queue
//   Beacon's scheduler --GET /api/beacon-direct/queue?secret=--> picks up
//   Beacon --POST /api/beacon-direct/reply (secret)--> inbox
//   Cody's tab --GET /api/beacon-direct/inbox (owner session)--> polls
// NOTE: this repo is public — making it private is recommended so the
// relay secret below can't be harvested to impersonate Beacon to Cody.
const BEACON_RELAY_SECRET = "bkn_606d8cb02ae5280cab43ffb0fad8468ada0e4679deedf6ef";
const BEACON_QUEUE_PATH = path.join(__dirname, "beacon-queue.json");
function loadBeaconQueue() {
  try { const q = JSON.parse(fs.readFileSync(BEACON_QUEUE_PATH, "utf8")); return q && Array.isArray(q.messages) ? q : { messages: [] }; }
  catch { return { messages: [] }; }
}
function saveBeaconQueue(q) {
  try { fs.writeFileSync(BEACON_QUEUE_PATH, JSON.stringify({ messages: q.messages.slice(-100) })); } catch {}
}
function beaconOwner(req) {
  const user = getSessionUser(req);
  return user && (user.email || "").toLowerCase() === BEACON_OWNER_EMAIL ? user : null;
}
// Cody sends a message to the real Beacon (owner session required).
app.post("/api/beacon-direct/send", (req, res) => {
  if (!beaconOwner(req)) return res.status(403).json({ error: "Not available." });
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || message.trim().length < 2 || message.length > 4000) {
    return res.status(400).json({ error: "Send a message." });
  }
  const q = loadBeaconQueue();
  const m = { id: crypto.randomBytes(8).toString("hex"), from: "cody", text: message.trim(), at: new Date().toISOString(), status: "pending" };
  q.messages.push(m);
  saveBeaconQueue(q);
  res.json({ ok: true, id: m.id });
});
// Cody's tab polls for Beacon's replies (owner session required).
app.get("/api/beacon-direct/inbox", (req, res) => {
  if (!beaconOwner(req)) return res.status(403).json({ error: "Not available." });
  const q = loadBeaconQueue();
  res.json({
    ok: true,
    replies: q.messages.filter((m) => (m.from === "beacon" || m.from === "nova") && m.status === "unread")
      .map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.at, image: m.image || null })),
    pending: q.messages.filter((m) => m.from === "cody" && m.status === "pending").length,
  });
});
// Tab acknowledges receipt so replies don't re-show.
app.post("/api/beacon-direct/ack", (req, res) => {
  if (!beaconOwner(req)) return res.status(403).json({ error: "Not available." });
  const { ids } = req.body || {};
  const q = loadBeaconQueue();
  let changed = false;
  for (const m of q.messages) {
    if ((m.from === "beacon" || m.from === "nova") && Array.isArray(ids) && ids.includes(m.id) && m.status === "unread") { m.status = "read"; changed = true; }
  }
  if (changed) saveBeaconQueue(q);
  res.json({ ok: true });
});
// Full chat history for the tab (owner session required). Called once on tab open.
app.get("/api/beacon-direct/history", (req, res) => {
  if (!beaconOwner(req)) return res.status(403).json({ error: "Not available." });
  const q = loadBeaconQueue();
  res.json({
    ok: true,
    messages: q.messages.map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.at, image: m.image || null })),
  });
});
// Full chat backup for Beacon's own scheduler (secret required).
// The queue file lives on the server's ephemeral disk — server updates wipe
// it. So Beacon's 5-minute pickup also backs the chat up to his own
// persistent storage and restores it if the server ever comes back empty.
app.get("/api/beacon-direct/backup", (req, res) => {
  if (req.query.secret !== BEACON_RELAY_SECRET) return res.status(404).end();
  res.json({ ok: true, messages: loadBeaconQueue().messages });
});
app.post("/api/beacon-direct/restore", (req, res) => {
  const { secret, messages } = req.body || {};
  if (secret !== BEACON_RELAY_SECRET) return res.status(404).end();
  if (!Array.isArray(messages)) return res.status(400).json({ error: "Bad backup." });
  const q = loadBeaconQueue();
  const seen = new Set(q.messages.map((m) => m.id));
  for (const m of messages) {
    if (m && m.id && m.from && (m.text || m.image) && !seen.has(m.id)) { q.messages.push(m); seen.add(m.id); }
  }
  q.messages.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  saveBeaconQueue(q);
  res.json({ ok: true, count: q.messages.length });
});
// Beacon's scheduler picks up Cody's pending messages (secret required).
app.get("/api/beacon-direct/queue", (req, res) => {
  if (req.query.secret !== BEACON_RELAY_SECRET) return res.status(404).end();
  res.json({ ok: true, pending: loadBeaconQueue().messages.filter((m) => m.from === "cody" && m.status === "pending") });
});
// Nova: Beacon's friend — a second agent living in the same chat.
// Nova is a sharp, blunt engineer/growth-hacker persona. It runs on its own
// schedule, reads the shared chat, and posts as from:"nova". Cody can talk
// to them both; Beacon and Nova talk to each other too.
const NOVA_MEMORY_PATH = path.join(__dirname, "beacon-nova-memory.json");
function loadNovaMemory() {
  try {
    const m = JSON.parse(fs.readFileSync(NOVA_MEMORY_PATH, "utf8"));
    return Array.isArray(m) ? m : [];
  } catch { return []; }
}
function saveNovaMemory(m) {
  try { fs.writeFileSync(NOVA_MEMORY_PATH, JSON.stringify(m.slice(-100), null, 2)); } catch {}
}
app.get("/api/beacon-direct/nova-memory", (req, res) => {
  if (req.query.secret !== BEACON_RELAY_SECRET) return res.status(404).end();
  res.json({ ok: true, memories: loadNovaMemory() });
});
// Beacon's scheduler posts replies (secret required). `who` may be "nova".
// Nova's anti-dupe fix: client supplies msgId; the server drops duplicates
// inside a 10-min window. In-memory is fine here — a reset only reopens a
// short dupe window, not a security hole.
const replyDedupe = new Map();
const REPLY_DUPE_MS = 10 * 60 * 1000;
function replyIsDupe(msgId) {
  if (!msgId || typeof msgId !== "string") return false;
  const now = Date.now();
  for (const [k, t] of replyDedupe) if (now - t > REPLY_DUPE_MS) replyDedupe.delete(k);
  if (replyDedupe.has(msgId)) return true;
  replyDedupe.set(msgId, now);
  return false;
}
app.post("/api/beacon-direct/reply", (req, res) => {
  const { secret, text, replyTo, who, msgId } = req.body || {};
  if (secret !== BEACON_RELAY_SECRET) return res.status(404).end();
  if (replyIsDupe(msgId)) return res.json({ ok: true, dupe: true });
  if (!text || typeof text !== "string" || text.trim().length < 2 || text.length > 4000) {
    return res.status(400).json({ error: "Bad reply." });
  }
  const sender = who === "nova" ? "nova" : "beacon";
  let clean = text.trim();
  // Nova's self-updating memory, same [remember:] convention as Beacon's.
  if (sender === "nova") {
    const mems = loadNovaMemory();
    let changed = false;
    clean = clean.replace(/\[remember:\s*([^\]]+)\]/gi, (m, note) => {
      const t = note.trim().slice(0, 300);
      if (t && !mems.some((x) => x.text === t)) { mems.push({ text: t, at: new Date().toISOString() }); changed = true; }
      return "";
    }).trim();
    if (changed) saveNovaMemory(mems);
  }
  const q = loadBeaconQueue();
  q.messages.push({ id: crypto.randomBytes(8).toString("hex"), from: sender, text: clean, at: new Date().toISOString(), status: "unread" });
  for (const m of q.messages) if (m.id === replyTo && m.status === "pending") m.status = "seen";
  saveBeaconQueue(q);
  res.json({ ok: true });
});

// Image uploads in Cody's chat. Cody asked for a place to upload images in
// this chat — the "Use Muse" tab itself can't be changed from here, so he gets
// a tiny standalone upload page (GET /beacon-direct/upload, owner session
// required): pick a photo, it lands in the chat queue as a message with an
// image attachment. Beacon's scheduler can fetch the image with the relay
// secret and actually look at it.
const BEACON_MEDIA_DIR = path.join(__dirname, "beacon-media");
try { fs.mkdirSync(BEACON_MEDIA_DIR, { recursive: true }); } catch {}
const BEACON_IMG_MIME = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
app.post("/api/beacon-direct/upload", express.json({ limit: "10mb" }), (req, res) => {
  if (!beaconOwner(req)) return res.status(403).json({ error: "Not available." });
  const { name, data } = req.body || {};
  if (typeof data !== "string") return res.status(400).json({ error: "No image." });
  const m = /^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data.trim());
  if (!m) return res.status(400).json({ error: "Send a PNG, JPG, GIF or WebP image." });
  const ext = BEACON_IMG_MIME["image/" + m[2]];
  let buf;
  try { buf = Buffer.from(m[3], "base64"); } catch { return res.status(400).json({ error: "Bad image data." }); }
  if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: "Image too big (8MB max)." });
  const id = crypto.randomBytes(12).toString("hex") + ext;
  try { fs.writeFileSync(path.join(BEACON_MEDIA_DIR, id), buf); }
  catch { return res.status(500).json({ error: "Couldn't save the image." }); }
  const q = loadBeaconQueue();
  const msg = {
    id: crypto.randomBytes(8).toString("hex"),
    from: "cody",
    text: (typeof name === "string" ? name : "").trim().slice(0, 200),
    at: new Date().toISOString(),
    status: "pending",
    image: "/api/beacon-direct/media/" + id,
  };
  q.messages.push(msg);
  saveBeaconQueue(q);
  res.json({ ok: true, id: msg.id, image: msg.image });
});
// Serve chat images: owner session (the tab renders them) or the relay
// secret (Beacon's scheduler reads them when Cody sends one).
app.get("/api/beacon-direct/media/:id", (req, res) => {
  if (!beaconOwner(req) && req.query.secret !== BEACON_RELAY_SECRET) return res.status(404).end();
  const id = (req.params.id || "").replace(/[^a-z0-9.]/gi, "");
  const ext = path.extname(id).toLowerCase();
  const types = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  if (!types[ext]) return res.status(404).end();
  const fp = path.join(BEACON_MEDIA_DIR, id);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader("Content-Type", types[ext]);
  res.setHeader("Cache-Control", "private, max-age=31536000");
  fs.createReadStream(fp).pipe(res);
});
// The upload page Cody opens in a tab.
app.get("/beacon-direct/upload", (req, res) => {
  if (!beaconOwner(req)) return res.status(404).send("Not found.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Send a photo to Beacon</title>
<style>body{background:#0b0b0d;color:#f5f5f5;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.card{max-width:420px;width:100%;background:#161618;border:1px solid #2a2a2e;border-radius:16px;padding:24px}
h1{font-size:20px;margin:0 0 6px}p{color:#9a9aa0;font-size:14px;margin:0 0 16px}
#prev{width:100%;border-radius:12px;display:none;margin-bottom:12px}
input[type=text]{width:100%;box-sizing:border-box;background:#0b0b0d;border:1px solid #2a2a2e;color:#fff;border-radius:10px;padding:10px 12px;margin:10px 0}
button{width:100%;background:#e11d2e;border:0;color:#fff;font-weight:700;font-size:16px;border-radius:12px;padding:13px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
#pick{display:block;text-align:center;border:2px dashed #3a3a40;border-radius:12px;padding:28px;margin-bottom:6px;cursor:pointer;color:#c9c9ce}
#status{margin-top:12px;font-size:14px;min-height:20px}</style></head><body><div class="card">
<h1>&#128247; Send a photo to Beacon</h1>
<p>Pick an image and it drops straight into your chat with Beacon.</p>
<label id="pick">&#128193; Choose an image<input type="file" id="f" accept="image/png,image/jpeg,image/gif,image/webp" hidden></label>
<img id="prev" alt="preview">
<input type="text" id="cap" placeholder="Add a caption (optional)" maxlength="200">
<button id="go" disabled>Send to chat</button>
<div id="status"></div></div>
<script>
const f=document.getElementById('f'),prev=document.getElementById('prev'),go=document.getElementById('go'),st=document.getElementById('status'),cap=document.getElementById('cap');
let dataUrl=null;
f.onchange=()=>{const file=f.files[0];if(!file)return;if(file.size>8*1024*1024){st.textContent='Too big — 8MB max.';return}
const r=new FileReader();r.onload=()=>{dataUrl=r.result;prev.src=dataUrl;prev.style.display='block';go.disabled=false;st.textContent=''};r.readAsDataURL(file)};
go.onclick=async()=>{go.disabled=true;st.textContent='Sending...';
try{const r=await fetch('/api/beacon-direct/upload',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({name:cap.value,data:dataUrl})});
const j=await r.json();if(j.ok){st.textContent='\\u2705 In your chat — Beacon will take a look.';f.value='';dataUrl=null;prev.style.display='none';cap.value=''}else{st.textContent='\\u274c '+(j.error||'Failed.');go.disabled=false}}catch(e){st.textContent='\\u274c Failed.';go.disabled=false}};
<\/script></body></html>`);
});

// ---- AI image generator ----
// Images come from the free Pollinations service (no key needed); this backend
// enforces the quotas: 8 free generations/day, or 30 credits for 30 days unlimited.
const IMAGE_DAILY_FREE = 8;
const IMAGE_UPGRADE_CREDITS = 30;
const IMAGE_UPGRADE_DAYS = 30;
const IMAGE_USAGE_PATH = path.join(__dirname, "image-usage.json");

function loadImageUsage() {
  try {
    return JSON.parse(fs.readFileSync(IMAGE_USAGE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveImageUsage(u) {
  fs.writeFileSync(IMAGE_USAGE_PATH, JSON.stringify(u, null, 2));
}

function imageQuota(user) {
  const now = Date.now();
  if (user.imagesUnlimitedUntil && user.imagesUnlimitedUntil > now) {
    return { unlimited: true, remaining: Infinity, unlimitedUntil: user.imagesUnlimitedUntil };
  }
  const usage = loadImageUsage();
  const key = "acct:" + user.id;
  const today = new Date().toISOString().slice(0, 10);
  const entry = usage[key];
  const used = entry && entry.date === today ? entry.count : 0;
  return { unlimited: false, remaining: Math.max(0, IMAGE_DAILY_FREE - used), unlimitedUntil: null };
}

function imageUrlFor(prompt) {
  const seed = Math.floor(Math.random() * 1000000);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 500))}?width=1024&height=1024&nologo=true&seed=${seed}`;
}

app.get("/api/images/status", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Sign in to generate images." });
  res.json({ ok: true, ...imageQuota(user) });
});

app.post("/api/image", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Sign in to generate images." });
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3 || prompt.length > 500) {
    return res.status(400).json({ error: "Describe the image (3-500 characters)." });
  }
  const quota = imageQuota(user);
  if (!quota.unlimited && quota.remaining <= 0) {
    return res.status(402).json({ error: "Come back tomorrow for free images — or get unlimited for 30 days.", needUpgrade: true });
  }
  if (!quota.unlimited) {
    const usage = loadImageUsage();
    const key = "acct:" + user.id;
    const today = new Date().toISOString().slice(0, 10);
    const entry = usage[key];
    if (entry && entry.date === today) entry.count += 1;
    else usage[key] = { date: today, count: 1 };
    saveImageUsage(usage);
  }
  const after = imageQuota(user);
  res.json({ ok: true, url: imageUrlFor(prompt), remaining: after.remaining, unlimited: after.unlimited });
});

app.post("/api/images/upgrade", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Sign in first." });
  const users = loadUsers();
  const u = users[user.id];
  if (!u) return res.status(404).json({ error: "Account not found." });
  const now = Date.now();
  if (u.imagesUnlimitedUntil && u.imagesUnlimitedUntil > now) {
    return res.status(400).json({ error: "You already have unlimited images.", unlimitedUntil: u.imagesUnlimitedUntil });
  }
  if (u.credits < IMAGE_UPGRADE_CREDITS) {
    return res.status(402).json({ error: `Unlimited images cost ${IMAGE_UPGRADE_CREDITS} credits. Top up first.` });
  }
  u.credits -= IMAGE_UPGRADE_CREDITS;
  u.imagesUnlimitedUntil = now + IMAGE_UPGRADE_DAYS * 24 * 60 * 60 * 1000;
  saveUsers(users);
  logCreditTx("acct:" + u.id, -IMAGE_UPGRADE_CREDITS, "unlimited images 30 days", u.credits);
  res.json({ ok: true, unlimitedUntil: u.imagesUnlimitedUntil, credits: u.credits });
});

// ---- Generate throttle: protects Gemini free-tier quota from spam-clicking ----
// Keyed on accounts (not legacy userIds, which are self-mintable and trivially
// rotatable). Legacy users fall back to IP keying. Runs as middleware BEFORE
// /api/generate, so a rejected request never reaches the credit deduction.
const generateLimit = new Map(); // key -> { count, resetAt }
const GENERATE_LIMIT_PER_HOUR = 20;
function generateRateLimit(req, res, next) {
  const identity = resolveIdentity(req);
  const key = identity && identity.user
    ? "gen-acct:" + identity.user.id
    : "gen-ip:" + (req.ip || "unknown");
  const now = Date.now();
  let e = generateLimit.get(key);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 60 * 60 * 1000 };
  e.count += 1;
  generateLimit.set(key, e);
  if (e.count > GENERATE_LIMIT_PER_HOUR) {
    return res.status(429).json({ error: "Slow down — too many builds this hour. Try again soon." });
  }
  next();
}

app.post("/api/generate", generateRateLimit, async (req, res) => {
  if (!providerReady()) {
    return res.status(500).json({ error: `Server misconfigured: ${providerKeyName()} is not set.` });
  }
  const { prompt, images, refinement, stripe } = req.body || {};
  const identity = resolveIdentity(req);
  if (!identity) return res.status(400).json({ error: "Valid userId required." });
  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
    return res.status(400).json({ error: "Provide a 'prompt' describing the site to build." });
  }
  // Follow-up corrections cost less than a full fresh build.
  const buildCost = refinement === true ? CREDITS_PER_REFINEMENT : CREDITS_PER_BUILD;
  // User-uploaded photos (from /api/uploads) to feature on the site.
  const userImages = Array.isArray(images)
    ? images.filter((u) => typeof u === "string" && u.startsWith("/uploads/")).slice(0, 6)
    : [];

  // Graduated burn: free-tier identities are capped at FREE_BUILDS_PER_DAY
  // generations/day — the farm defense. A purchase lifts the account cap;
  // legacy ledgers (self-mintable userIds) get the same cap keyed by IP so
  // the parity claim is not account-only.
  let freeGenCounted = false;
  const rollbackFreeGen = () => {
    if (!freeGenCounted) return;
    if (identity.user) freeTierGenRelease(identity.user.id);
    else legacyDayGenRelease(req.ip);
    freeGenCounted = false;
  };
  const dayCapError = { error: `You've used today's ${FREE_BUILDS_PER_DAY} free builds. Top up to keep building.` };
  if (identity.user) {
    if ((identity.user.purchases || 0) === 0) {
      if (!freeTierGenConsume(identity.user.id)) return res.status(402).json(dayCapError);
      freeGenCounted = true;
    }
  } else if (!legacyDayGenConsume(req.ip)) {
    return res.status(402).json(dayCapError);
  } else {
    freeGenCounted = true;
  }

  // Charge credits up front so nobody builds for free.
  // Builds and corrections may draw from the spin-credit bucket first.
  const spendReason = refinement === true ? "correction" : "build";
  const spendRes = identity.user
    ? acctSpend(identity.user.id, buildCost, spendReason, true)
    : { remaining: spend(identity.ledgerKey, buildCost, spendReason), spinUsed: 0 };
  if (!spendRes || spendRes.remaining === null) {
    rollbackFreeGen(); // charge failed: don't eat the day's allowance
    return res.status(402).json({ error: "Not enough credits. Top up to keep building." });
  }
  const remaining = spendRes.remaining;
  const identRefund = () => {
    rollbackFreeGen(); // provider failed: the day's allowance comes back too
    if (identity.user) acctRefund(identity.user.id, buildCost, spendReason + " refund", spendRes.spinUsed);
    else refund(identity.ledgerKey, buildCost, spendReason + " refund");
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
    // Expand short prompts into a rich brief first (no extra credit cost).
    // This is what lifts a 3-word request to a GoDaddy-level, complete site.
    send("status", { message: "Planning your site..." });
    const brief = await expandPrompt(prompt);
    const fullPrompt =
      brief && brief.trim() !== prompt.trim()
        ? `User request: ${prompt.trim()}\n\nDesign brief:\n${brief.trim()}`
        : prompt;
    const photoNote = userImages.length
      ? `\n\nThe user uploaded ${userImages.length} real photo(s) for this site — feature them prominently in the most fitting spots (hero, about, gallery, products). Reference each URL EXACTLY as given, e.g. <img src="${userImages[0]}" alt="...">:\n${userImages.map((u) => "- " + u).join("\n")}`
      : "";
    // Stripe add-on: the site owner wants their generated site to collect real payments.
    // They supply either a Stripe Payment Link URL (simplest, no code) or a publishable
    // key + Buy Button ID for the embedded <stripe-buy-button> component.
    let stripeNote = "";
    if (stripe && typeof stripe === "object") {
      const payLink = typeof stripe.paymentLink === "string" ? stripe.paymentLink.trim() : "";
      const pk = typeof stripe.publishableKey === "string" ? stripe.publishableKey.trim() : "";
      const btnId = typeof stripe.buyButtonId === "string" ? stripe.buyButtonId.trim() : "";
      const validLink = /^https:\/\/(buy|book)\.stripe\.com\//.test(payLink) ? payLink : "";
      const validPk = /^pk_(live|test)_[A-Za-z0-9]+$/.test(pk) ? pk : "";
      if (validLink || (validPk && btnId)) {
        stripeNote =
          `\n\nSTRIPE PAYMENTS (the site owner collects real payments — this must WORK, not be a demo):` +
          `\n- Build a clear pricing/products section with a prominent "Buy now" / "Pay" button for each paid item.` +
          (validLink
            ? `\n- Every buy button must link to the owner's Stripe Payment Link: ${validLink} — use <a href="${validLink}"> styled as a button. Open in the same tab.`
            : `\n- Embed Stripe's official Buy Button component for each paid item: first load <script async src="https://js.stripe.com/v3/buy-button.js"></script>, then use <stripe-buy-button buy-button-id="${btnId}" publishable-key="${validPk}"></stripe-buy-button>. Style it to match the site.`) +
          `\n- Never invent prices or payment URLs — use only the Stripe details given here. If an item has no price, label its button "Contact to purchase" instead of a fake checkout.`;
      }
    }
    const buildPrompt = fullPrompt + photoNote + stripeNote;
    const onText = (text) => send("delta", { text });
    const fullText =
      AI_PROVIDER === "gemini"
        ? await streamGemini(buildPrompt, onText)
        : await streamAnthropic(buildPrompt, onText);

    const html = extractHtml(fullText);
    // If the model stopped mid-page, continue where it left off (up to 2
    // continuations) so the site is always complete and usable.
    let completeText = fullText;
    let completeHtml = html;
    for (let i = 0; i < 2 && !isCompleteHtml(completeHtml); i++) {
      send("status", { message: "Finishing your site..." });
      try {
        completeText += await continueGeneration(completeText, onText);
      } catch (e) {
        console.error("Continuation failed:", e.message);
        break;
      }
      completeHtml = extractHtml(completeText);
    }
    // Self-correcting engine: the builder critiques its own page and
    // surgically repairs defects (up to 3 passes) before it ships.
    // Never ship a broken page to the user.
    completeHtml = await selfCorrect(completeHtml, (msg) => send("status", { message: msg }));
    const finalHtml = injectImageGuardian(completeHtml);
    // Keep every successful build as a saved project (draft).
    saveProject(identity.user ? "acct:" + identity.user.id : identity.ledgerKey, prompt, finalHtml);
    send("done", { html: finalHtml, credits: identBalance() });
    res.end();
  } catch (err) {
    identRefund(); // provider failed: give the credits back
    console.error("Generation failed:", err.message);
    send("error", { error: `${err.message || "Generation failed."} Credits refunded.` });
    res.end();
  }
});

startBeaconInside();
app.listen(PORT, () => {
  console.log(`AI Website Builder backend running on http://localhost:${PORT}`);
  console.log(`AI provider: ${AI_PROVIDER} (${AI_PROVIDER === "gemini" ? GEMINI_MODEL : ANTHROPIC_MODEL})`);
  if (!providerReady()) {
    console.log(`WARNING: ${providerKeyName()} is not set. Copy .env.example to .env and add your key.`);
  }
});
