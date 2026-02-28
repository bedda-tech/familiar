/**
 * WsServer -- WebSocket server for real-time dashboard updates.
 *
 * Attaches to an existing HTTP server and handles WebSocket upgrades
 * at /ws?token=TOKEN. Broadcasts events to all connected clients.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { getLogger } from "../util/logger.js";
import type { WsEvent } from "./types.js";

const log = getLogger("ws-server");

export class WsServer {
  private wss: WebSocketServer;
  private clients = new Map<string, WebSocket>();
  private authToken: string;

  constructor(httpServer: Server, authToken: string) {
    this.authToken = authToken;

    this.wss = new WebSocketServer({ noServer: true });

    // Handle WebSocket upgrade requests
    httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      // Auth check -- token via query string or header
      const token =
        url.searchParams.get("token") ??
        (req.headers["x-familiar-token"] as string | undefined);

      if (token !== this.authToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws: WebSocket) => {
      const clientId = randomUUID().slice(0, 8);
      this.clients.set(clientId, ws);
      log.info({ clientId, total: this.clients.size }, "ws client connected");

      // Send connected confirmation
      ws.send(JSON.stringify({ type: "connected", clientId } satisfies WsEvent));

      ws.on("close", () => {
        this.clients.delete(clientId);
        log.debug({ clientId, total: this.clients.size }, "ws client disconnected");
      });

      ws.on("error", (err) => {
        log.warn({ clientId, err }, "ws client error");
        this.clients.delete(clientId);
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleClientMessage(clientId, msg);
        } catch {
          log.debug({ clientId }, "invalid ws message");
        }
      });
    });
  }

  /** Broadcast an event to all connected clients. */
  broadcast(event: WsEvent): void {
    const payload = JSON.stringify(event);
    for (const [clientId, ws] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else {
        this.clients.delete(clientId);
      }
    }
  }

  /** Get the number of connected clients. */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Handler for messages from dashboard clients. Override for chat support. */
  private messageHandler: ((clientId: string, msg: Record<string, unknown>) => void) | null = null;

  onMessage(handler: (clientId: string, msg: Record<string, unknown>) => void): void {
    this.messageHandler = handler;
  }

  private handleClientMessage(clientId: string, msg: Record<string, unknown>): void {
    if (this.messageHandler) {
      this.messageHandler(clientId, msg);
    }
  }

  /** Close all connections and clean up. */
  close(): void {
    for (const [, ws] of this.clients) {
      ws.close();
    }
    this.clients.clear();
    this.wss.close();
    log.info("ws server closed");
  }
}
