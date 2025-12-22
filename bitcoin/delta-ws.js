const WebSocket = require("ws");

function startDeltaWs({
  io,
  logger = console,
  url = "wss://socket.india.delta.exchange",
  symbol = "BTCUSD",
  channel = "ticker",
  eventName = "delta:ws",
}) {
  let socket = null;
  let lastPayload = null;
  let reconnectDelayMs = 1000;

  function connect() {
    socket = new WebSocket(url);

    socket.on("open", () => {
      reconnectDelayMs = 1000;
      socket.send(
        JSON.stringify({
          type: "subscribe",
          payload: {
            channels: [{ name: channel, symbols: [symbol] }],
          },
        })
      );
      logger.log(`Delta WS connected: ${url} (${symbol})`);
    });

    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }

        const dataNode = msg.data || msg.payload || msg;
        const priceRaw =
          dataNode.last_price ||
          dataNode.price ||
          dataNode.mark_price ||
          dataNode.close ||
          dataNode.ltp;
        const price = priceRaw !== undefined ? Number(priceRaw) : null;
        if (!Number.isFinite(price)) {
          return;
        }

        const payload = {
          exchange: "delta",
          symbol: dataNode.symbol || symbol,
          price,
          timestamp: new Date().toISOString(),
          raw: msg,
        };
        lastPayload = payload;
        io.emit(eventName, payload);
      } catch (err) {
        logger.error("Delta WS parse error:", err.message);
      }
    });

    socket.on("close", () => {
      logger.warn("Delta WS closed. Reconnecting...");
      setTimeout(connect, reconnectDelayMs);
    });

    socket.on("error", (err) => {
      logger.error("Delta WS error:", err.message);
      socket.close();
    });
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
      if (socket) {
        socket.close();
      }
    },
  };
}

module.exports = { startDeltaWs };

