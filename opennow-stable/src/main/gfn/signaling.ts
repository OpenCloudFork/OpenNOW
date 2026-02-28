import { randomBytes } from "node:crypto";

import WebSocket from "ws";

import type {
  IceCandidatePayload,
  MainToRendererSignalingEvent,
  SendAnswerRequest,
} from "@shared/gfn";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36";

interface SignalingMessage {
  ackid?: number;
  ack?: number;
  hb?: number;
  peer_info?: {
    id: number;
  };
  peer_msg?: {
    from: number;
    to: number;
    msg: string;
  };
}

export class GfnSignalingClient {
  private ws: WebSocket | null = null;
  private peerId = 2;
  private peerName = `peer-${Math.floor(Math.random() * 10_000_000_000)}`;
  private ackCounter = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private transportPingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 6;
  private closedByUser = false;
  private listeners = new Set<(event: MainToRendererSignalingEvent) => void>();

  constructor(
    private readonly signalingServer: string,
    private readonly sessionId: string,
    private readonly signalingUrl?: string,
  ) {}

  private buildSignInUrl(): string {
    // Match Rust behavior: extract host:port from signalingUrl if available,
    // since the signalingUrl contains the real server address (which may differ
    // from signalingServer when the resource path was an rtsps:// URL)
    let serverWithPort: string;

    if (this.signalingUrl) {
      // Extract host:port from wss://host:port/path
      const withoutScheme = this.signalingUrl.replace(/^wss?:\/\//, "");
      const hostPort = withoutScheme.split("/")[0];
      serverWithPort = hostPort && hostPort.length > 0
        ? (hostPort.includes(":") ? hostPort : `${hostPort}:443`)
        : (this.signalingServer.includes(":") ? this.signalingServer : `${this.signalingServer}:443`);
    } else {
      serverWithPort = this.signalingServer.includes(":")
        ? this.signalingServer
        : `${this.signalingServer}:443`;
    }

    const url = `wss://${serverWithPort}/nvst/sign_in?peer_id=${this.peerName}&version=2`;
    console.log("[Signaling] URL:", url, "(server:", this.signalingServer, ", signalingUrl:", this.signalingUrl, ")");
    return url;
  }

  onEvent(listener: (event: MainToRendererSignalingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MainToRendererSignalingEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private nextAckId(): number {
    this.ackCounter += 1;
    return this.ackCounter;
  }

  private sendJson(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private setupHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendJson({ hb: 1 });
    }, 5000);

    this.transportPingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 15000);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.transportPingTimer) {
      clearInterval(this.transportPingTimer);
      this.transportPingTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private shouldReconnect(closeCode: number): boolean {
    if (this.closedByUser) {
      return false;
    }
    return closeCode !== 1000 && closeCode !== 1001;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser) {
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit({ type: "error", message: "Signaling reconnect exhausted (max retries reached)" });
      return;
    }

    this.reconnectAttempts += 1;
    const baseDelayMs = Math.min(30000, 1000 * (2 ** (this.reconnectAttempts - 1)));
    const jitterMs = Math.floor(Math.random() * 400);
    const delayMs = baseDelayMs + jitterMs;
    console.warn(`[Signaling] Scheduling reconnect #${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delayMs}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) {
        return;
      }
      this.connect().catch((error) => {
        console.warn("[Signaling] Reconnect attempt failed:", error);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private sendPeerInfo(): void {
    this.sendJson({
      ackid: this.nextAckId(),
      peer_info: {
        browser: "Chrome",
        browserVersion: "131",
        connected: true,
        id: this.peerId,
        name: this.peerName,
        peerRole: 0,
        resolution: "1920x1080",
        version: 2,
      },
    });
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    this.clearReconnectTimer();
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = this.buildSignInUrl();
    const protocol = `x-nv-sessionid.${this.sessionId}`;

    console.log("[Signaling] Connecting to:", url);
    console.log("[Signaling] Session ID:", this.sessionId);
    console.log("[Signaling] Protocol:", protocol);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      // Extract host:port for the Host header (matching Rust behavior)
      const urlHost = url.replace(/^wss?:\/\//, "").split("/")[0];

      const ws = new WebSocket(url, protocol, {
        rejectUnauthorized: false,
        headers: {
          Host: urlHost,
          Origin: "https://play.geforcenow.com",
          "User-Agent": USER_AGENT,
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        },
      });

      this.ws = ws;

      ws.once("error", (error) => {
        this.emit({ type: "error", message: `Signaling connect failed: ${String(error)}` });
        fail(error);
      });

      ws.once("open", () => {
        this.reconnectAttempts = 0;
        this.sendPeerInfo();
        this.setupHeartbeat();
        this.emit({ type: "connected" });
        succeed();
      });

      ws.on("message", (raw) => {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        this.handleMessage(text);
      });

      ws.on("close", (code, reason) => {
        this.clearHeartbeat();
        const reasonText = typeof reason === "string" ? reason : reason.toString("utf8");
        const closeSummary = `code=${code}, reason=${reasonText || "socket closed"}`;
        console.warn(`[Signaling] Disconnected (${closeSummary})`);
        this.emit({ type: "disconnected", reason: closeSummary });
        this.ws = null;
        if (!settled) {
          fail(new Error(`Signaling socket closed before open (${closeSummary})`));
        }
        if (this.shouldReconnect(code)) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private handleMessage(text: string): void {
    let parsed: SignalingMessage;
    try {
      parsed = JSON.parse(text) as SignalingMessage;
    } catch {
      this.emit({ type: "log", message: `Ignoring non-JSON signaling packet: ${text.slice(0, 120)}` });
      return;
    }

    if (typeof parsed.ackid === "number") {
      const shouldAck = parsed.peer_info?.id !== this.peerId;
      if (shouldAck) {
        this.sendJson({ ack: parsed.ackid });
      }
    }

    if (parsed.hb) {
      this.sendJson({ hb: 1 });
      return;
    }

    if (!parsed.peer_msg?.msg) {
      return;
    }

    let peerPayload: Record<string, unknown>;
    try {
      peerPayload = JSON.parse(parsed.peer_msg.msg) as Record<string, unknown>;
    } catch {
      this.emit({ type: "log", message: "Received non-JSON peer payload" });
      return;
    }

    if (peerPayload.type === "offer" && typeof peerPayload.sdp === "string") {
      console.log(`[Signaling] Received OFFER SDP (${peerPayload.sdp.length} chars), first 500 chars:`);
      console.log(peerPayload.sdp.slice(0, 500));
      this.emit({ type: "offer", sdp: peerPayload.sdp });
      return;
    }

    if (typeof peerPayload.candidate === "string") {
      console.log(`[Signaling] Received remote ICE candidate: ${peerPayload.candidate}`);
      this.emit({
        type: "remote-ice",
        candidate: {
          candidate: peerPayload.candidate,
          sdpMid:
            typeof peerPayload.sdpMid === "string" || peerPayload.sdpMid === null
              ? peerPayload.sdpMid
              : undefined,
          sdpMLineIndex:
            typeof peerPayload.sdpMLineIndex === "number" || peerPayload.sdpMLineIndex === null
              ? peerPayload.sdpMLineIndex
              : undefined,
        },
      });
      return;
    }

    // Log any unhandled peer message types for debugging
    console.log("[Signaling] Unhandled peer message keys:", Object.keys(peerPayload));
  }

  async sendAnswer(payload: SendAnswerRequest): Promise<void> {
    console.log(`[Signaling] Sending ANSWER SDP (${payload.sdp.length} chars), first 500 chars:`);
    console.log(payload.sdp.slice(0, 500));
    if (payload.nvstSdp) {
      console.log(`[Signaling] Sending nvstSdp (${payload.nvstSdp.length} chars):`);
      console.log(payload.nvstSdp);
    }
    const answer = {
      type: "answer",
      sdp: payload.sdp,
      ...(payload.nvstSdp ? { nvstSdp: payload.nvstSdp } : {}),
    };

    this.sendJson({
      peer_msg: {
        from: this.peerId,
        to: 1,
        msg: JSON.stringify(answer),
      },
      ackid: this.nextAckId(),
    });
  }

  async sendIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    console.log(`[Signaling] Sending local ICE candidate: ${candidate.candidate} (sdpMid=${candidate.sdpMid})`);
    this.sendJson({
      peer_msg: {
        from: this.peerId,
        to: 1,
        msg: JSON.stringify({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        }),
      },
      ackid: this.nextAckId(),
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.clearHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
