const WebSocket = require("ws");

function startDeltaWs({
  io,
  logger = console,
  url = "wss://socket.delta.exchange",
  symbol = "BTCUSD",
  channel = "trades",
  eventName = "delta:ws",
}) {
  let socket = null;
  let reconnectTimer = null;
  let lastPayload = null;
  let reconnectDelayMs = 1000;

  function connect() {
    socket = new WebSocket(url);

    socket.on("open", () => {
      reconnectDelayMs = 1000;
      const subscribeMsg = {
        type: "subscribe",
        payload: {
          channels: [
            {
              name: channel,
              symbols: [symbol],
            },
          ],
        },
      };
      socket.send(JSON.stringify(subscribeMsg));
      logger.log(`Delta WS connected: ${url} (${symbol}, ${channel})`);
    });

    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }

        const trade = msg.data || msg;
        if (!trade.price || !trade.symbol) {
          return;
        }

        const price = Number(trade.price);
        if (!Number.isFinite(price)) {
          return;
        }

        const payload = {
          exchange: "delta",
          symbol: trade.symbol,
          price,
          timestamp: trade.timestamp
            ? new Date(trade.timestamp).toISOString()
            : new Date().toISOString(),
          raw: trade,
        };
        lastPayload = payload;
        io.emit(eventName, payload);
      } catch (err) {
        logger.error("Delta WS parse error:", err.message);
      }
    });

    socket.on("close", (code, reason) => {
      logger.warn(`Delta WS closed (${code}): ${reason || "no reason"}`);
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      logger.error("Delta WS error:", err.message);
      socket.close();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
      connect();
    }, reconnectDelayMs);
  }

  io.on("connection", (socketClient) => {
    if (lastPayload) {
      socketClient.emit(eventName, lastPayload);
    }
  });

  connect();

  return {
    getLastPayload: () => lastPayload,
    close: () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.close();
      }
    },
  };
}

module.exports = { startDeltaWs };

