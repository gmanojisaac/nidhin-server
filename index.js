const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");
const { KiteTicker } = require("kiteconnect");
const { startBinanceWs } = require("./bitcoin/binance-ws");
const { startDeltaWs } = require("./bitcoin/delta-ws");
const { startDeltaRestPolling } = require("./bitcoin/delta-rest");
//node .\scripts\rewrite-env.js
function loadEnv(envPath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const apiKey = process.env.KITE_API_KEY;
const accessToken = process.env.KITE_ACCESS_TOKEN;
const instrumentsRaw = process.env.INSTRUMENTS_DATA;

if (!apiKey || !accessToken || !instrumentsRaw) {
  console.error("Missing KITE_API_KEY, KITE_ACCESS_TOKEN, or INSTRUMENTS_DATA in .env");
  process.exit(1);
}

let instruments;
try {
  instruments = JSON.parse(instrumentsRaw);
} catch (err) {
  console.error("INSTRUMENTS_DATA must be valid JSON. Run: node scripts/rewrite-env.js");
  console.error(err.message);
  process.exit(1);
}

if (!Array.isArray(instruments) || instruments.length === 0) {
  console.error("INSTRUMENTS_DATA must be a non-empty JSON array");
  process.exit(1);
}

const tokens = instruments
  .map((instrument) => instrument.token)
  .filter((token) => Number.isFinite(token));

if (tokens.length === 0) {
  console.error("No valid numeric tokens found in INSTRUMENTS_DATA");
  process.exit(1);
}

const port = process.env.SOCKET_PORT
  ? Number(process.env.SOCKET_PORT)
  : 3001;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: "text/plain" }));

function normalizeWebhookPayload(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    const trimmed = req.body.trim();
    if (!trimmed) {
      return {};
    }

    try {
      return JSON.parse(trimmed);
    } catch (err) {
      const parsed = {};
      const [prefix, rest] = trimmed.split("+").map((part) => part.trim());
      if (prefix) {
        parsed.action = prefix.replace(/^Accepted\s+/i, "").trim();
      }

      const kvSource = rest || trimmed;
      const kvPairs = kvSource.split(/[|,\n]/);
      for (const pair of kvPairs) {
        const idx = pair.indexOf("=");
        if (idx === -1) {
          continue;
        }
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (key) {
          parsed[key] = value;
        }
      }
      return parsed;
    }
  }

  return {};
}

function extractTradeSignal(payload) {
  const symbol = payload.symbol || payload.ticker || payload.sym || null;
  const stopPxRaw =
    payload.stoppx || payload.stopPx || payload.stop_price || payload.stopPrice || null;
  const stoppx = stopPxRaw !== null && stopPxRaw !== undefined ? Number(stopPxRaw) : null;
  const actionRaw = String(
    payload.action || payload.side || payload.signal || payload.order_type || payload.type || ""
  )
    .trim()
    .toUpperCase();

  const isEntry =
    actionRaw.includes("ENTRY") ||
    payload.entry === true ||
    payload.isEntry === true ||
    String(payload.entry || payload.isEntry || "")
      .toLowerCase()
      .includes("true");
  const isExit =
    actionRaw.includes("EXIT") ||
    payload.exit === true ||
    payload.isExit === true ||
    String(payload.exit || payload.isExit || "")
      .toLowerCase()
      .includes("true");

  let side = null;
  if (actionRaw.includes("BUY") || actionRaw.includes("LONG")) {
    side = "BUY";
  } else if (actionRaw.includes("SELL") || actionRaw.includes("SHORT")) {
    side = "SELL";
  }

  if (!side) {
    if (isEntry) {
      side = "BUY";
    } else if (isExit) {
      side = "SELL";
    }
  }

  return {
    symbol,
    stoppx: Number.isFinite(stoppx) ? stoppx : null,
    intent: isEntry ? "ENTRY" : isExit ? "EXIT" : null,
    side,
    raw: payload,
  };
}

app.post("/webhook", (req, res) => {
  const payload = normalizeWebhookPayload(req);
  const signal = extractTradeSignal(payload);
  lastWebhookSignal = signal;
  console.log("TradingView webhook:", signal);
  io.emit("webhook", signal);
  res.json({ ok: true, received: signal });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

startBinanceWs({ io });
startDeltaWs({ io });
startDeltaRestPolling({ io });

const ticker = new KiteTicker({
  api_key: apiKey,
  access_token: accessToken,
});

let firstTickLogged = false;
let firstTickCache = null;
let lastWebhookSignal = null;

io.on("connection", (socket) => {
  if (firstTickCache) {
    socket.emit("firstTick", firstTickCache);
  }
  if (lastWebhookSignal) {
    socket.emit("webhook", lastWebhookSignal);
  }
});

ticker.on("connect", () => {
  ticker.subscribe(tokens);
  ticker.setMode(ticker.modeFull, tokens);
});

ticker.on("ticks", (ticks) => {
  if (!firstTickLogged && Array.isArray(ticks) && ticks.length > 0) {
    console.log("First tick:", ticks[0]);
    firstTickCache = ticks[0];
    io.emit("firstTick", firstTickCache);
    firstTickLogged = true;
  }

  console.log("Ticks:", ticks);
  io.emit("ticks", ticks);
});

ticker.on("error", (err) => {
  console.error("KiteTicker error:", err);
});

ticker.on("close", () => {
  console.log("KiteTicker closed");
});

ticker.on("reconnect", (reconnectAttempt) => {
  console.log("KiteTicker reconnect:", reconnectAttempt);
});

ticker.on("noreconnect", () => {
  console.log("KiteTicker noreconnect");
});

ticker.connect();

server.listen(port, () => {
  console.log(`Socket.IO server listening on port ${port}`);
});
