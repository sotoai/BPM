#!/usr/bin/env node
/**
 * BPM (BentoBase Performance Manager) — SQLite-Backed Server
 *
 * Serves the BPM UI and persists all data to a local SQLite database
 * inside the ./data directory. Supports concurrent access from multiple
 * clients safely.
 *
 * Endpoints:
 *   GET  /                     - Serve index.html
 *   GET  /api/data             - Read all portal data (tickets + activity)
 *   PUT  /api/data             - Write all portal data (full sync)
 *   GET  /api/tickets          - List all tickets
 *   POST /api/tickets          - Create a ticket
 *   PUT  /api/tickets/:id      - Update a ticket
 *   DELETE /api/tickets/:id    - Delete a ticket
 *   GET  /api/activity         - List recent activity
 *   GET  /api/settings         - Read settings
 *   PUT  /api/settings         - Write settings
 *   POST /api/ai/prompt        - Generate AI prompt via Anthropic Claude
 *   GET  /health               - Health check
 */

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || process.env.PORTAL_PORT || 3100;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "portal.sqlite3");

// ---------------------------------------------------------------------------
// Ensure data directory exists
// ---------------------------------------------------------------------------
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    type        TEXT DEFAULT 'feature',
    priority    TEXT DEFAULT 'medium',
    status      TEXT DEFAULT 'open',
    area        TEXT DEFAULT '',
    subarea     TEXT DEFAULT '',
    assignee    TEXT DEFAULT '',
    files       TEXT DEFAULT '',
    createdAt   TEXT NOT NULL,
    updatedAt   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    rowid_      INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,
    ticketId    TEXT,
    title       TEXT NOT NULL,
    time        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Prepared statements for performance
const stmts = {
  allTickets:      db.prepare("SELECT * FROM tickets ORDER BY createdAt DESC"),
  getTicket:       db.prepare("SELECT * FROM tickets WHERE id = ?"),
  insertTicket:    db.prepare(`INSERT INTO tickets (id, title, description, type, priority, status, area, subarea, assignee, files, createdAt, updatedAt)
                               VALUES (@id, @title, @description, @type, @priority, @status, @area, @subarea, @assignee, @files, @createdAt, @updatedAt)`),
  updateTicket:    db.prepare(`UPDATE tickets SET title=@title, description=@description, type=@type, priority=@priority,
                               status=@status, area=@area, subarea=@subarea, assignee=@assignee, files=@files, updatedAt=@updatedAt
                               WHERE id=@id`),
  deleteTicket:    db.prepare("DELETE FROM tickets WHERE id = ?"),
  deleteAllTickets: db.prepare("DELETE FROM tickets"),

  recentActivity:  db.prepare("SELECT action, ticketId, title, time FROM activity ORDER BY rowid_ DESC LIMIT 100"),
  insertActivity:  db.prepare("INSERT INTO activity (action, ticketId, title, time) VALUES (@action, @ticketId, @title, @time)"),
  trimActivity:    db.prepare("DELETE FROM activity WHERE rowid_ NOT IN (SELECT rowid_ FROM activity ORDER BY rowid_ DESC LIMIT 100)"),
  deleteAllActivity: db.prepare("DELETE FROM activity"),

  getSetting:      db.prepare("SELECT value FROM settings WHERE key = ?"),
  upsertSetting:   db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
};

// Transactional bulk write (for the PUT /api/data full-sync endpoint)
const bulkSync = db.transaction((data) => {
  stmts.deleteAllTickets.run();
  stmts.deleteAllActivity.run();
  for (const t of (data.tickets || [])) {
    stmts.insertTicket.run({
      id: t.id,
      title: t.title || "",
      description: t.description || "",
      type: t.type || "feature",
      priority: t.priority || "medium",
      status: t.status || "open",
      area: t.area || "",
      subarea: t.subarea || "",
      assignee: t.assignee || "",
      files: t.files || "",
      createdAt: t.createdAt || new Date().toISOString(),
      updatedAt: t.updatedAt || new Date().toISOString(),
    });
  }
  for (const a of (data.activity || [])) {
    stmts.insertActivity.run({
      action: a.action || "",
      ticketId: a.ticketId || null,
      title: a.title || "",
      time: a.time || new Date().toISOString(),
    });
  }
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

function sendHTML(res, filePath) {
  try {
    const html = fs.readFileSync(filePath, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}

// ---------------------------------------------------------------------------
// Route matching helper
// ---------------------------------------------------------------------------
function matchRoute(method, pathname, pattern) {
  if (req_method !== method) return null;
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
let req_method = "";

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  req_method = req.method;

  try {
    // --- Serve index.html ---
    if (pathname === "/" && req.method === "GET") {
      sendHTML(res, path.join(__dirname, "index.html"));
      return;
    }

    // --- Bulk data (backwards-compatible with frontend) ---
    if (pathname === "/api/data" && req.method === "GET") {
      const tickets = stmts.allTickets.all();
      const activity = stmts.recentActivity.all();
      sendJSON(res, 200, { tickets, activity, kbNotes: {} });
      return;
    }

    if (pathname === "/api/data" && req.method === "PUT") {
      const body = await parseBody(req);
      bulkSync(body);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // --- Individual ticket CRUD ---
    if (pathname === "/api/tickets" && req.method === "GET") {
      sendJSON(res, 200, stmts.allTickets.all());
      return;
    }

    if (pathname === "/api/tickets" && req.method === "POST") {
      const t = await parseBody(req);
      stmts.insertTicket.run({
        id: t.id,
        title: t.title || "",
        description: t.description || "",
        type: t.type || "feature",
        priority: t.priority || "medium",
        status: t.status || "open",
        area: t.area || "",
        subarea: t.subarea || "",
        assignee: t.assignee || "",
        files: t.files || "",
        createdAt: t.createdAt || new Date().toISOString(),
        updatedAt: t.updatedAt || new Date().toISOString(),
      });
      if (t._activity) {
        stmts.insertActivity.run(t._activity);
        stmts.trimActivity.run();
      }
      sendJSON(res, 201, stmts.getTicket.get(t.id));
      return;
    }

    // PUT /api/tickets/:id
    {
      const m = matchRoute("PUT", pathname, "/api/tickets/:id");
      if (m) {
        const t = await parseBody(req);
        const existing = stmts.getTicket.get(m.id);
        if (!existing) { sendJSON(res, 404, { error: "Ticket not found" }); return; }
        stmts.updateTicket.run({
          id: m.id,
          title: t.title ?? existing.title,
          description: t.description ?? existing.description,
          type: t.type ?? existing.type,
          priority: t.priority ?? existing.priority,
          status: t.status ?? existing.status,
          area: t.area ?? existing.area,
          subarea: t.subarea ?? existing.subarea,
          assignee: t.assignee ?? existing.assignee,
          files: t.files ?? existing.files,
          updatedAt: t.updatedAt || new Date().toISOString(),
        });
        if (t._activity) {
          stmts.insertActivity.run(t._activity);
          stmts.trimActivity.run();
        }
        sendJSON(res, 200, stmts.getTicket.get(m.id));
        return;
      }
    }

    // DELETE /api/tickets/:id
    {
      const m = matchRoute("DELETE", pathname, "/api/tickets/:id");
      if (m) {
        const body = await parseBody(req).catch(() => ({}));
        const existing = stmts.getTicket.get(m.id);
        if (!existing) { sendJSON(res, 404, { error: "Ticket not found" }); return; }
        stmts.deleteTicket.run(m.id);
        if (body._activity) {
          stmts.insertActivity.run(body._activity);
          stmts.trimActivity.run();
        }
        sendJSON(res, 200, { ok: true, deleted: m.id });
        return;
      }
    }

    // --- Activity ---
    if (pathname === "/api/activity" && req.method === "GET") {
      sendJSON(res, 200, stmts.recentActivity.all());
      return;
    }

    // --- Settings ---
    if (pathname === "/api/settings" && req.method === "GET") {
      const theme = stmts.getSetting.get("theme");
      const apiKeyRow = stmts.getSetting.get("anthropic_api_key");
      const openaiKeyRow = stmts.getSetting.get("openai_api_key");
      const hasApiKey = !!(apiKeyRow?.value);
      const hasOpenAIKey = !!(openaiKeyRow?.value);
      sendJSON(res, 200, {
        theme: theme ? theme.value : "marshmallow",
        hasAnthropicKey: hasApiKey,
        anthropicKeyHint: hasApiKey ? "sk-ant-•••" + apiKeyRow.value.slice(-4) : "",
        hasOpenAIKey,
        openaiKeyHint: hasOpenAIKey ? "sk-•••" + openaiKeyRow.value.slice(-4) : "",
      });
      return;
    }

    if (pathname === "/api/settings" && req.method === "PUT") {
      const body = await parseBody(req);
      if (body.theme) stmts.upsertSetting.run("theme", body.theme);
      if (body.anthropic_api_key !== undefined) {
        if (body.anthropic_api_key) {
          stmts.upsertSetting.run("anthropic_api_key", body.anthropic_api_key);
        } else {
          db.prepare("DELETE FROM settings WHERE key = 'anthropic_api_key'").run();
        }
      }
      if (body.openai_api_key !== undefined) {
        if (body.openai_api_key) {
          stmts.upsertSetting.run("openai_api_key", body.openai_api_key);
        } else {
          db.prepare("DELETE FROM settings WHERE key = 'openai_api_key'").run();
        }
      }
      sendJSON(res, 200, { ok: true });
      return;
    }

    // --- AI Prompt Generation (proxy to Anthropic / OpenAI) ---
    if (pathname === "/api/ai/prompt" && req.method === "POST") {
      const body = await parseBody(req);
      const provider = body.provider || "anthropic";
      const model = body.model;

      let result;

      if (provider === "openai") {
        // --- OpenAI ---
        const apiKey = stmts.getSetting.get("openai_api_key")?.value;
        if (!apiKey) {
          sendJSON(res, 400, { error: "No OpenAI API key configured. Add one in the Prompt Lab settings." });
          return;
        }

        const oaiMessages = [];
        if (body.system) oaiMessages.push({ role: "system", content: body.system });
        for (const m of (body.messages || [])) {
          oaiMessages.push({ role: m.role, content: m.content });
        }

        const payload = JSON.stringify({
          model: model || "gpt-4o",
          max_tokens: 1024,
          messages: oaiMessages,
        });

        result = await new Promise((resolve) => {
          const apiReq = https.request({
            hostname: "api.openai.com",
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
          }, (apiRes) => {
            let data = "";
            apiRes.on("data", (chunk) => { data += chunk; });
            apiRes.on("end", () => {
              try {
                const parsed = JSON.parse(data);
                if (apiRes.statusCode >= 400) {
                  resolve({ error: parsed.error?.message || `API error ${apiRes.statusCode}`, status: apiRes.statusCode });
                } else {
                  resolve({
                    ok: true,
                    content: parsed.choices?.[0]?.message?.content || "",
                    usage: parsed.usage,
                  });
                }
              } catch (e) {
                resolve({ error: "Failed to parse OpenAI response" });
              }
            });
          });
          apiReq.on("error", (e) => resolve({ error: e.message }));
          apiReq.write(payload);
          apiReq.end();
        });

      } else {
        // --- Anthropic (default) ---
        const apiKey = body.apiKey || (stmts.getSetting.get("anthropic_api_key")?.value);
        if (!apiKey) {
          sendJSON(res, 400, { error: "No Anthropic API key configured. Add one in the Prompt Lab settings." });
          return;
        }

        const payload = JSON.stringify({
          model: model || "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: body.system || "",
          messages: body.messages || [],
        });

        result = await new Promise((resolve) => {
          const apiReq = https.request({
            hostname: "api.anthropic.com",
            path: "/v1/messages",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
          }, (apiRes) => {
            let data = "";
            apiRes.on("data", (chunk) => { data += chunk; });
            apiRes.on("end", () => {
              try {
                const parsed = JSON.parse(data);
                if (apiRes.statusCode >= 400) {
                  resolve({ error: parsed.error?.message || `API error ${apiRes.statusCode}`, status: apiRes.statusCode });
                } else {
                  resolve({ ok: true, content: parsed.content?.[0]?.text || "", usage: parsed.usage });
                }
              } catch (e) {
                resolve({ error: "Failed to parse API response" });
              }
            });
          });
          apiReq.on("error", (e) => resolve({ error: e.message }));
          apiReq.write(payload);
          apiReq.end();
        });
      }

      if (result.error) {
        sendJSON(res, result.status || 500, { error: result.error });
      } else {
        sendJSON(res, 200, result);
      }
      return;
    }

    // --- Health ---
    if (pathname === "/health" && req.method === "GET") {
      const ticketCount = db.prepare("SELECT COUNT(*) as count FROM tickets").get();
      sendJSON(res, 200, {
        status: "ok",
        database: DB_PATH,
        tickets: ticketCount.count,
      });
      return;
    }

    // --- 404 ---
    sendJSON(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[BPM] Error:", err.message);
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  const ticketCount = db.prepare("SELECT COUNT(*) as count FROM tickets").get().count;
  console.log(`\n  BPM — BentoBase Performance Manager`);
  console.log(`  ────────────────────────────────────`);
  console.log(`  Running at  http://localhost:${PORT}`);
  console.log(`  Database    ${DB_PATH}`);
  console.log(`  Tickets     ${ticketCount}\n`);
});

// Graceful shutdown
process.on("SIGINT", () => { db.close(); process.exit(0); });
process.on("SIGTERM", () => { db.close(); process.exit(0); });
