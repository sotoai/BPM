#!/usr/bin/env node
/**
 * BentoBase Project Portal — SQLite-Backed Server
 *
 * Serves the portal UI and persists all data to a local SQLite database
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
 *   GET  /health               - Health check
 */

import http from "http";
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
      sendJSON(res, 200, { theme: theme ? theme.value : "marshmallow" });
      return;
    }

    if (pathname === "/api/settings" && req.method === "PUT") {
      const body = await parseBody(req);
      if (body.theme) stmts.upsertSetting.run("theme", body.theme);
      sendJSON(res, 200, { ok: true });
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
    console.error("[Portal] Error:", err.message);
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  const ticketCount = db.prepare("SELECT COUNT(*) as count FROM tickets").get().count;
  console.log(`\n  BentoBase Project Portal`);
  console.log(`  ───────────────────────`);
  console.log(`  Running at  http://localhost:${PORT}`);
  console.log(`  Database    ${DB_PATH}`);
  console.log(`  Tickets     ${ticketCount}\n`);
});

// Graceful shutdown
process.on("SIGINT", () => { db.close(); process.exit(0); });
process.on("SIGTERM", () => { db.close(); process.exit(0); });
