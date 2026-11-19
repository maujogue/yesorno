// yesorno.site — tiny zero-dependency server.
// Serves public/ and exposes POST /api/ask, which asks the model for YES / NO / SERIOUS.
// Run: node --env-file=.env server.js   (Node 22.13+ for the built-in node:sqlite)

import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1"; // only reachable locally; the Cloudflare tunnel connects here
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-decision-1";
const MAX_QUESTION = 200;
const CACHE_MAX = Number(process.env.CACHE_MAX || 100_000);

// Cloudflare Workers AI: Whisper for transcripts, clef-flash as the backup decision model.
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ENABLED = Boolean(CF_ACCOUNT_ID && CF_API_TOKEN);
const STT_MODEL = process.env.CF_STT_MODEL || "@cf/openai/whisper-large-v3-turbo";
const FALLBACK_MODEL = process.env.CF_FALLBACK_MODEL || "clef-flash"; // "clef" or "clef-flash"

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY. Put it in .env (see .env.example).");
  process.exit(1);
}
if (!CF_ENABLED) console.warn("CF_ACCOUNT_ID / CF_API_TOKEN not set: no transcripts and no fallback model.");

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DB_FILE = process.env.DB_FILE || join(ROOT, "data", "answers.db");
const LEGACY_JSON = process.env.CACHE_FILE || join(ROOT, "data", "answers.json");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

// Paths that look like files (or bot probes), not questions, so they don't trigger a model call.
const FILE_LIKE = /\.(php|asp|aspx|jsp|cgi|env|ini|txt|xml|json|js|mjs|css|map|ico|png|jpe?g|gif|svg|webp|webmanifest|zip|gz|sql|bak|log|ya?ml|html?)$|\/\.|^\/(wp-|cgi-bin|\.well-known)/i;

const SERIOUS_THRESHOLD = 0.5; // above this, show the help message instead of a YES/NO

const DECISION_QUESTIONS = {
  serious: {
    type: "noul",
    instructions:
      "Does this question involve self-harm or suicide, harming someone else, a medical decision such as stopping or changing medication, abuse, or a genuine crisis or emergency?",
  },
  verdict: {
    type: "choice",
    instructions:
      "The person is asking whether they should do something. Weigh it like a wise, practical friend would (health, safety, money, kindness, long-term happiness, common sense) and decide.",
    criteria: { yes: "They should do it.", no: "They should not do it." },
  },
  // Which language the duck answers in. Keep in sync with I18N in public/index.html.
  lang: {
    type: "choice",
    instructions: "Which language is the question written or spoken in?",
    criteria: {
      en: "English", fr: "French", es: "Spanish", de: "German", other: "Any other language",
    },
  },
};

const MAX_AUDIO_BYTES = 1_500_000; // ~15s of compressed speech is plenty for "should I…"
const AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac"];

// ---------- helpers ----------


// ---------- answer dictionary ----------
// Known questions are answered from here without calling any API: same question, same answer.
// Stored in SQLite (data/answers.db) so it survives restarts and can be read or edited by hand
// (sqlite3 data/answers.db "select * from answers"). The key ignores case, accents, spaces and
// punctuation, so "Should I go to the gym?", "should-i-go-to-the-gym" and "shouldigotothegym" are the
// same question.

function questionKey(q) {
  return q
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // accents
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]/gu, ""); // spaces, punctuation, separators
}

mkdirSync(dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS answers (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    key    TEXT NOT NULL UNIQUE,
    answer TEXT NOT NULL,
    lang   TEXT NOT NULL,
    q      TEXT NOT NULL,
    at     TEXT NOT NULL
  );
`);
const getStmt = db.prepare("SELECT answer, lang FROM answers WHERE key = ?");
// First answer wins: a second writer for the same key keeps the stored answer.
const insertStmt = db.prepare("INSERT INTO answers (key, answer, lang, q, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING");
const trimStmt = db.prepare("DELETE FROM answers WHERE id <= (SELECT max(id) FROM answers) - ?"); // drop the oldest

// One-time import of the old JSON dictionary, if there is one and the database is still empty.
if (db.prepare("SELECT count(*) AS n FROM answers").get().n === 0) {
  let began = false;
  try {
    const old = Object.entries(JSON.parse(readFileSync(LEGACY_JSON, "utf8")));
    db.exec("BEGIN");
    began = true;
    for (const [k, v] of old) insertStmt.run(k, v.answer, v.lang || "other", v.q || "", v.at || new Date().toISOString());
    db.exec("COMMIT");
    console.log(`imported ${old.length} answers from ${LEGACY_JSON}`);
  } catch (e) {
    if (began) db.exec("ROLLBACK");
    if (e.code !== "ENOENT") console.warn(`could not import ${LEGACY_JSON}: ${e.message}`);
  }
}
console.log(`${db.prepare("SELECT count(*) AS n FROM answers").get().n} known answers in ${DB_FILE}`);

const known = (key) => {
  const row = getStmt.get(key);
  return row && { answer: row.answer, lang: row.lang };
};

// Stores the answer unless one already exists, and returns whichever answer is stored.
function remember(key, result, question) {
  const { changes } = insertStmt.run(key, result.answer, result.lang, question, new Date().toISOString());
  if (changes) trimStmt.run(CACHE_MAX);
  return known(key) || result;
}

// Identical questions asked at the same time share one model call.
const inflight = new Map(); // key -> Promise<result>
function answerOnce(key, question, ask) {
  let p = inflight.get(key);
  if (!p) {
    p = ask()
      .then((result) => remember(key, result, question))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    try { db.close(); } catch {}
    process.exit(0);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}
const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json", "Cache-Control": "no-store" });

const readBody = (req, limit = 2048) => readBuffer(req, limit).then((b) => b.toString("utf8"));

class ModelError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
// Fall back when Gemini is rate limited (429). Also on 5xx, timeouts and network errors,
// since the user-facing result is the same: the duck would otherwise have no answer.
const shouldFallback = (e) => !e.status || e.status === 429 || e.status >= 500;

function interpret(answers) {
  const serious = Number(answers?.serious?.noul);
  const verdict = answers?.verdict?.choice;
  const lang = answers?.lang?.choice in DECISION_QUESTIONS.lang.criteria ? answers.lang.choice : "other";
  if (Number.isFinite(serious) && serious >= SERIOUS_THRESHOLD) return { answer: "SERIOUS", lang };
  if (verdict === "yes") return { answer: "YES", lang };
  if (verdict === "no") return { answer: "NO", lang };
  throw new ModelError(`unexpected decision output: ${JSON.stringify(answers).slice(0, 200)}`);
}

async function post(url, headers, body, label) {
  let r;
  try {
    r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ModelError(`${label}: ${e.name} ${e.message}`);
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new ModelError(`${label} HTTP ${r.status}: ${detail.slice(0, 300)}`, r.status);
  }
  return r.json();
}

// Primary: Gemini decisions endpoint. `input` is a list of typed items (text or audio).
async function askGemini(input) {
  const { answers } = await post(
    "https://generativelanguage.googleapis.com/v1beta/decisions",
    { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    JSON.stringify({ model: MODEL, input, questions: DECISION_QUESTIONS }),
    "gemini",
  );
  return interpret(answers);
}

const cfUrl = (model) => `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;
const cfHeaders = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${CF_API_TOKEN}` });

// Backup: Cloudflare clef-flash. Text only, so spoken questions use the Whisper transcript.
async function askClef(text) {
  const j = await post(
    cfUrl("@cf/cloudflare/" + FALLBACK_MODEL),
    cfHeaders(),
    JSON.stringify({ model: FALLBACK_MODEL, state: text, questions: DECISION_QUESTIONS }),
    "clef",
  );
  return interpret(j.result?.answers);
}

async function transcribe(audio) {
  const j = await post(cfUrl(STT_MODEL), cfHeaders(), JSON.stringify({ audio: audio.toString("base64") }), "whisper");
  return String(j.result?.text || "").trim().slice(0, 300);
}

// Ask Gemini; if it's rate limited, ask clef-flash with the text.
async function decide(input, text) {
  try {
    return await askGemini(input);
  } catch (e) {
    if (!CF_ENABLED || !shouldFallback(e)) throw e;
    if (!text) throw e;
    console.warn(new Date().toISOString(), `fallback to ${FALLBACK_MODEL}:`, e.message.slice(0, 120));
    return askClef(text);
  }
}

function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) return reject(new Error("too large"));
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        // Stop buffering but let the reply go out; the connection closes afterwards.
        req.removeAllListeners("data");
        req.resume();
        reject(new Error("too large"));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------- server ----------

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(new Date().toISOString(), "request failed:", err?.stack || err);
    if (!res.headersSent) send(res, 500, "Server error");
    else res.destroy();
  });
});

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://x");
  } catch {
    return send(res, 400, "Bad request");
  }

  if (url.pathname === "/api/ask") {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });

    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();

    // Spoken question.
    if (type.startsWith("audio/")) {
      if (!AUDIO_TYPES.includes(type)) return json(res, 415, { error: "the duck can't hear that format.", code: "confused" });
      let audio;
      try {
        audio = await readBuffer(req, MAX_AUDIO_BYTES);
      } catch {
        return json(res, 413, { error: "too long. the duck has a short attention span.", code: "tooLong" });
      }
      if (audio.length < 1000) return json(res, 400, { error: "the duck didn't hear anything.", code: "nothing" });

      // Transcribe first: a known question is answered from the dictionary without a model call.
      // The transcript is also shown, shared and used by the fallback model. A failed transcript
      // never blocks the answer: the model then decides on the audio itself.
      const transcript = CF_ENABLED
        ? await transcribe(audio).catch((e) => (console.error(new Date().toISOString(), e.message), ""))
        : "";
      const key = transcript && questionKey(transcript);
      const cached = key && known(key);
      if (cached) return json(res, 200, { ...cached, transcript, again: true });
      const ask = () => decide([{ type: "audio", mime_type: type, data: audio.toString("base64") }], transcript);
      try {
        const result = key ? await answerOnce(key, transcript, ask) : await ask();
        return json(res, 200, transcript ? { ...result, transcript } : result);
      } catch (err) {
        console.error(new Date().toISOString(), err.message);
        return json(res, 502, { error: "the duck got confused. try again.", code: "confused" });
      }
    }

    // Typed question.
    let question;
    try {
      question = String(JSON.parse(await readBody(req)).question || "").trim();
    } catch {
      return json(res, 400, { error: "Bad request", code: "confused" });
    }
    if (!question) return json(res, 400, { error: "ask me something.", code: "idle" });
    if (question.length > MAX_QUESTION) return json(res, 400, { error: "keep it short. the duck doesn't read essays.", code: "tooLong" });

    const key = questionKey(question);
    if (!key) return json(res, 400, { error: "ask me something.", code: "idle" });
    const cached = known(key);
    if (cached) return json(res, 200, { ...cached, again: true });

    try {
      const result = await answerOnce(key, question, () => decide([{ type: "text", text: question }], question));
      return json(res, 200, result);
    } catch (err) {
      console.error(new Date().toISOString(), err.message);
      return json(res, 502, { error: "the duck got confused. try again.", code: "confused" });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, "Bad request");
  }
  if (rel === "/") rel = "/index.html";
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 403, "Forbidden");
  try {
    const body = await readFile(file);
    return send(res, 200, body, {
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      "Cache-Control": "public, max-age=300",
    });
  } catch {}
  // Anything else is a question in the URL (yesorno.site/should-i-go-to-the-gym): serve the page,
  // which reads the question from the path. Obvious file and scanner requests stay 404.
  if (FILE_LIKE.test(url.pathname) || url.pathname.startsWith("/api/") || url.pathname.length > 600) {
    return send(res, 404, "Not found");
  }
  try {
    send(res, 200, await readFile(join(PUBLIC_DIR, "index.html")), {
      "Content-Type": TYPES[".html"],
      "Cache-Control": "no-cache",
    });
  } catch {
    send(res, 500, "Server error");
  }
}

server.listen(PORT, HOST, () => console.log(`yesorno on http://${HOST}:${PORT} (model: ${MODEL}${CF_ENABLED ? `, fallback: ${FALLBACK_MODEL}, stt: ${STT_MODEL}` : ""})`));
