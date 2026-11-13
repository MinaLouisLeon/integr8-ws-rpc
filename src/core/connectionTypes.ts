import type { LinkWebsocketClientOptions } from '@orpc/client/websocket';
import type { RpcErrorCode } from './rpcError.js';

/** Observable connection lifecycle; ready requires a successful authenticated handshake. */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'reconnecting'
  | 'error'
  | 'closed';

/** Immutable, credential-free state. Only a ready snapshot includes negotiated session metadata. */
export type ConnectionSnapshot =
  | {
      readonly state: 'ready';
      readonly attempt: number;
      readonly sessionId: string;
      readonly protocolVersion: number;
      readonly lastErrorCode?: RpcErrorCode;
    }
  | {
      readonly state: Exclude<ConnectionState, 'ready'>;
      readonly attempt: number;
      readonly lastErrorCode?: RpcErrorCode;
      readonly sessionId?: never;
      readonly protocolVersion?: never;
    };

/**
 * Initial client configuration. Values are read when creating a connection handle.
 *
 * The socket factory is invoked only by connect/reconnect; provide a browser, Node or Expo
 * implementation. Runtime validation is implemented by the client factory; platform support
 * still requires consumer/device verification.
 */
export interface RpcClientOptions {
  /** WebSocket endpoint. Credentials belong in hello, never in this URL. */
  readonly url: string;
  /** Ordered application version preferences: at most eight positive integers. */
  readonly protocolVersions: readonly number[];
  /** Read fresh credentials for each connection attempt. Failure is terminal AUTH_FAILED. */
  readonly getToken: () => Promise<string>;
  /** Caller-owned platform constructor; the returned socket is owned by this connection. */
  readonly createWebSocket: (url: string) => LinkWebsocketClientOptions['websocket'] & {
    readonly bufferedAmount: number;
    close(code?: number, reason?: string): void;
  };
  /** Connect plus handshake deadline per attempt; default 10,000 ms. */
  readonly handshakeTimeoutMs?: number;
  /** Unary call deadline; default 30,000 ms. */
  readonly callTimeoutMs?: number;
  /** Retry retryable failures; default true. Never replays application calls. */
  readonly reconnect?: boolean;
  /** Consecutive retry limit; default 10, reset after an authenticated handshake. */
  readonly retryLimit?: number;
  /** Initial full-jitter exponential backoff ceiling; default 500 ms. */
  readonly backoffBaseMs?: number;
  /** Maximum full-jitter backoff ceiling; default 30,000 ms. */
  readonly backoffMaxMs?: number;
  /** Ready-state ping interval; default 15,000 ms. */
  readonly heartbeatIntervalMs?: number;
  /** Ping reply deadline; default 10,000 ms. */
  readonly heartbeatTimeoutMs?: number;
  /** Maximum encoded message in either direction; default 1 MiB. */
  readonly maxMessageBytes?: number;
  /** Maximum concurrent calls; default 100. */
  readonly maxInFlightCalls?: number;
  /** Maximum managed subscriptions; default 32. */
  readonly maxSubscriptions?: number;
  /** Pending items per stream; default 256, applied together with the byte bound. */
  readonly maxPendingStreamItems?: number;
  /** Pending encoded bytes per stream; default 1 MiB, applied together with the item bound. */
  readonly maxPendingStreamBytes?: number;
  /** Outgoing socket queue high-water mark; default 1 MiB. */
  readonly maxBufferedBytes?: number;
}
