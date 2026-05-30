/**
 * Addon contract. Every addon implements any subset of these lifecycle methods.
 * Hooks may be async; the proxy awaits them in order, so an addon can mutate a flow
 * (rewrite, mock, pause) before the proxy proceeds.
 */

import type { Flow, WebSocketMessage } from "../flow/flow.ts";

export interface Addon {
  name: string;

  /** Proxy is up and listening. */
  running?(): void | Promise<void>;

  /** Request line + headers received; body not yet read. Good for redirect/abort decisions. */
  requestheaders?(flow: Flow): void | Promise<void>;
  /** Full request (headers + body) available; last chance to rewrite before sending upstream. */
  request?(flow: Flow): void | Promise<void>;
  /** Response status + headers received; body not yet read. */
  responseheaders?(flow: Flow): void | Promise<void>;
  /** Full response available; last chance to rewrite before sending to client. */
  response?(flow: Flow): void | Promise<void>;
  /** Upstream/transport error. */
  error?(flow: Flow): void | Promise<void>;

  /** A WebSocket frame passed through (already appended to flow.websocketMessages). */
  websocketMessage?(flow: Flow, msg: WebSocketMessage): void | Promise<void>;
  /** A WebSocket connection was established (after the HTTP upgrade). */
  websocketStart?(flow: Flow): void | Promise<void>;

  /** Shutting down. */
  done?(): void | Promise<void>;
}

export type HookName = keyof Omit<Addon, "name">;
