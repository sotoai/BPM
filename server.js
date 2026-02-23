#!/usr/bin/env node
/**
 * BentoBase Project Portal — File-Backed Server
 *
 * Serves the portal UI and persists all data to local JSON files
 * inside the ./data directory instead of browser localStorage.
 *
 * Endpoints:
 *   GET  /                     - Serve index.html
 *   GET  /api/data             - Read all portal data
 *   PUT  /api/data             - Write all portal data
 *   GET  /api/settings         - Read settings (theme, etc.)
 *   PUT  /api/settings         - Write settings
 *   GET  /health               - Health check
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORTAL_PORT || 3100;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "portal-data.json");
const SETTINGS_FILE = path.join(DATA_DIR, "portal-settings.json");

// ---------------------------------------------------------------------------
// Ensure data directory exists
// ---------------------------------------------------------------------------
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function readJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.error(`[Portal] Failed to read ${filePath}:`, e.message);
  }
  return fallback;
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

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

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
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
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // --- Serve index.html ---
    if (pathname === "/" && req.method === "GET") {
      sendHTML(res, path.join(__dirname, "index.html"));
      return;
    }

    // --- Portal Data ---
    if (pathname === "/api/data" && req.method === "GET") {
      const data = readJSON(DATA_FILE, { tickets: [], activity: [], kbNotes: {} });
      sendJSON(res, 200, data);
      return;
    }

    if (pathname === "/api/data" && req.method === "PUT") {
      const body = await parseBody(req);
      writeJSON(DATA_FILE, body);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // --- Settings ---
    if (pathname === "/api/settings" && req.method === "GET") {
      const settings = readJSON(SETTINGS_FILE, { theme: "marshmallow" });
      sendJSON(res, 200, settings);
      return;
    }

    if (pathname === "/api/settings" && req.method === "PUT") {
      const body = await parseBody(req);
      writeJSON(SETTINGS_FILE, body);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // --- Health ---
    if (pathname === "/health" && req.method === "GET") {
      sendJSON(res, 200, {
        status: "ok",
        dataFile: fs.existsSync(DATA_FILE),
        settingsFile: fs.existsSync(SETTINGS_FILE),
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
  console.log(`\n  BentoBase Project Portal`);
  console.log(`  ───────────────────────`);
  console.log(`  Running at  http://localhost:${PORT}`);
  console.log(`  Data dir    ${DATA_DIR}`);
  console.log(`  Data file   ${DATA_FILE}`);
  console.log(`  Settings    ${SETTINGS_FILE}\n`);
});
