import { randomUUID } from 'node:crypto';
import { negotiateProtocol, parseHello, validateProtocolVersions } from '../core/handshake.js';
import { isAsyncIterator, retainIterator } from '../core/iteratorLifetime.js';
import {
  runOperation,
  type Scheduler,
  systemScheduler,
  validateTimeout,
} from '../core/operation.js';
import { RpcError, type RpcErrorCode } from '../core/rpcError.js';

/**
 * Authentication callback input; never persist this object or forward it to diagnostics.
 * @inline
 */
export interface AuthenticationInput {
  readonly token: string;
  readonly protocolVersion: number;
  readonly signal: AbortSignal;
}

/**
 * Caller context and optional expiry, in epoch milliseconds.
 * @inline
 */
export interface AuthenticationResult<TContext extends object> {
  readonly context: TContext;
  readonly expiresAt?: number;
}

/** Internal construction seam, not part of a public package entry point. */
export interface SessionOptions<TContext extends object> {
  readonly protocolVersions: readonly number[];
  readonly authenticate: (
    input: AuthenticationInput,
  ) => PromiseLike<AuthenticationResult<TContext>>;
  readonly handshakeTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly maxInFlightCalls?: number;
  readonly maxSubscriptions?: number;
  readonly onClose?: (code: RpcErrorCode) => void;
  readonly scheduler?: Scheduler;
  readonly createSessionId?: () => string;
}

/** Internal reserved hello result; the adapter still uses oRPC to encode this value. */
export interface HelloResponse {
  readonly transportVersion: 1;
  readonly protocolVersion: number;
  readonly sessionId: string;
  readonly expiresAt?: number;
}

/**
 * One socket's authentication and unary-call lifetime. This class does not parse socket frames,
 * implement reconnect, issue/store credentials, or provide stream buffering.
 */
export class Session<TContext extends object> {
  private readonly options: SessionOptions<TContext>;
  private readonly versions: readonly number[];
  private readonly scheduler: Scheduler;
  private readonly controller: AbortController = new AbortController();
  private readonly id: string;
  private readonly callTimeoutMs: number;
  private readonly maxInFlightCalls: number;
  private readonly maxSubscriptions: number;
  private readonly handshakeDeadlineAt: number;
  private cancelHandshake: (() => void) | undefined;
  private cancelExpiry: (() => void) | undefined;
  private state: 'pending' | 'authenticating' | 'ready' | 'closed' = 'pending';
  private closedCode: RpcErrorCode = 'CLOSED';
  private context: TContext | undefined;
  private expiresAt: number | undefined;
  private inFlight: number = 0;
  private streams: number = 0;

  public constructor(options: SessionOptions<TContext>) {
    this.options = { ...options };
    this.versions = validateProtocolVersions(options.protocolVersions);
    const handshakeTimeoutMs = validateTimeout(options.handshakeTimeoutMs ?? 10_000);
    this.callTimeoutMs = validateTimeout(options.callTimeoutMs ?? 30_000);
    this.maxInFlightCalls = options.maxInFlightCalls ?? 100;
    this.maxSubscriptions = options.maxSubscriptions ?? 32;
    if (
      !Number.isSafeInteger(this.maxInFlightCalls) ||
      this.maxInFlightCalls < 1 ||
      this.maxInFlightCalls > 10_000 ||
      !Number.isSafeInteger(this.maxSubscriptions) ||
      this.maxSubscriptions < 1 ||
      this.maxSubscriptions > 1024 ||
      typeof options.authenticate !== 'function'
    ) {
      throw new RpcError('INVALID_OPTION');
    }
    this.scheduler = options.scheduler ?? systemScheduler;
    const now = this.scheduler.now();
    if (!Number.isFinite(now)) {
      throw new RpcError('INVALID_OPTION');
    }
    this.handshakeDeadlineAt = now + handshakeTimeoutMs;
    this.id = (options.createSessionId ?? randomUUID)();
    if (typeof this.id !== 'string' || this.id.length === 0 || this.id.length > 128) {
      throw new RpcError('INTERNAL');
    }
    // Starts at socket/session allocation, independently of whether a hello ever arrives.
    const remaining = this.handshakeDeadlineAt - this.scheduler.now();
    if (remaining <= 0) {
      throw new RpcError('HANDSHAKE_TIMEOUT');
    } else {
      this.cancelHandshake = this.scheduler.schedule(
        () => this.close('HANDSHAKE_TIMEOUT'),
        remaining,
      );
    }
  }

  /** Authenticate once; concurrent/second hellos never invoke the authentication adapter again. */
  public async hello(input: unknown): Promise<HelloResponse> {
    if (this.state !== 'pending') {
      throw new RpcError(this.state === 'closed' ? this.closedCode : 'INVALID_MESSAGE');
    }
    this.state = 'authenticating';
    let token: string;
    let protocolVersion: number;
    try {
      this.assertHandshakeActive();
      const hello = parseHello(input);
      token = hello.token;
      protocolVersion = negotiateProtocol(hello.protocolVersions, this.versions);
      this.assertHandshakeActive();
    } catch (error) {
      const safe = error instanceof RpcError ? error : new RpcError('INVALID_MESSAGE');
      this.close(safe.code);
      throw safe;
    }

    let authenticated: AuthenticationResult<TContext>;
    try {
      authenticated = await runOperation(
        (signal) => this.options.authenticate({ token, protocolVersion, signal }),
        { lifetime: this.controller.signal },
      );
    } catch {
      // A rejected adapter may include credentials or product details. Never retain its error.
      const code = this.controller.signal.aborted ? this.closedCode : 'AUTH_FAILED';
      this.close(code);
      throw new RpcError(code);
    }
    this.assertHandshakeActive();
    let context: TContext;
    let expiresAt: number | undefined;
    try {
      if (typeof authenticated !== 'object' || authenticated === null) {
        throw new RpcError('AUTH_FAILED');
      }
      context = authenticated.context;
      expiresAt = authenticated.expiresAt;
      if (typeof context !== 'object' || context === null) {
        throw new RpcError('AUTH_FAILED');
      }
      if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) {
        throw new RpcError('AUTH_FAILED');
      }
    } catch {
      // Read callback-owned properties only inside a sanitizing boundary.
      const code = this.controller.signal.aborted ? this.closedCode : 'AUTH_FAILED';
      this.close(code);
      throw new RpcError(code);
    }
    this.assertHandshakeActive();
    if (expiresAt !== undefined && expiresAt <= this.scheduler.now()) {
      this.close('AUTH_EXPIRED');
      throw new RpcError('AUTH_EXPIRED');
    }
    this.context = context;
    this.expiresAt = expiresAt;
    this.cancelHandshake?.();
    this.cancelHandshake = undefined;
    this.state = 'ready';
    this.armExpiry();
    if (this.controller.signal.aborted) {
      throw new RpcError(this.closedCode);
    }
    return Object.freeze({
      transportVersion: 1,
      protocolVersion,
      sessionId: this.id,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }

  /** Guard every application invocation, including calls racing hello/expiry/invalidation. */
  public getContext(): TContext {
    if (this.state === 'ready' && this.expiresAt !== undefined) {
      if (this.expiresAt <= this.scheduler.now()) {
        this.close('AUTH_EXPIRED');
      }
    }
    if (this.state === 'closed') {
      throw new RpcError(this.closedCode);
    }
    if (this.state !== 'ready' || this.context === undefined) {
      throw new RpcError('AUTH_FAILED');
    }
    return this.context;
  }

  /** Acquire an authenticated context and a bounded, cancellable unary-operation slot. */
  public async runUnary<T>(
    operation: (context: TContext, signal: AbortSignal) => PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.runProcedure(operation, signal);
  }

  /** Retain authenticated request/session lifetime until a returned stream actually terminates. */
  public async runProcedure<T>(
    operation: (context: TContext, signal: AbortSignal) => PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const context = this.getContext();
    if (this.inFlight >= this.maxInFlightCalls) {
      throw new RpcError('LIMIT_EXCEEDED');
    }
    this.inFlight += 1;
    const controller = new AbortController();
    const onSession = (): void => {
      controller.abort(this.controller.signal.reason);
    };
    const onCaller = (): void => {
      controller.abort(new RpcError('CANCELLED'));
    };
    const cleanup = (): void => {
      this.controller.signal.removeEventListener('abort', onSession);
      signal?.removeEventListener('abort', onCaller);
    };
    this.controller.signal.addEventListener('abort', onSession, { once: true });
    signal?.addEventListener('abort', onCaller, { once: true });
    if (this.controller.signal.aborted) onSession();
    else if (signal?.aborted) onCaller();
    try {
      const value = await runOperation(
        (deadlineSignal) => {
          const onDeadline = (): void => {
            controller.abort(deadlineSignal.reason);
          };
          deadlineSignal.addEventListener('abort', onDeadline, { once: true });
          return Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted();
              return operation(context, controller.signal);
            })
            .finally(() => {
              deadlineSignal.removeEventListener('abort', onDeadline);
            });
        },
        {
          lifetime: controller.signal,
          timeoutMs: this.callTimeoutMs,
          scheduler: this.scheduler,
        },
      );
      if (isAsyncIterator(value)) {
        if (this.streams >= this.maxSubscriptions) {
          controller.abort(new RpcError('LIMIT_EXCEEDED'));
          void Promise.resolve(value.return?.()).catch(() => {});
          throw new RpcError('LIMIT_EXCEEDED');
        }
        this.streams += 1;
        return retainIterator(value, {
          lifetime: controller.signal,
          onFinish: () => {
            this.streams -= 1;
            cleanup();
          },
        });
      }
      cleanup();
      return value;
    } catch (error) {
      cleanup();
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Commit closure before notifying the socket owner; revocation and expiry share this path. */
  public close(code: RpcErrorCode = 'CLOSED'): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    this.closedCode = code;
    this.context = undefined;
    this.cancelHandshake?.();
    this.cancelHandshake = undefined;
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    this.controller.abort(new RpcError(code));
    try {
      this.options.onClose?.(code);
    } catch {
      // Observer/adapter failure must not resurrect the session or skip cancellation cleanup.
    }
  }

  private armExpiry(): void {
    if (this.expiresAt === undefined || this.state !== 'ready') {
      return;
    }
    const remaining = this.expiresAt - this.scheduler.now();
    if (remaining <= 0) {
      this.close('AUTH_EXPIRED');
      return;
    }
    this.cancelExpiry = this.scheduler.schedule(
      () => {
        this.cancelExpiry = undefined;
        this.armExpiry();
      },
      Math.min(remaining, 2_147_483_647),
    );
  }

  private assertHandshakeActive(): void {
    if (this.controller.signal.aborted) {
      throw new RpcError(this.closedCode);
    }
    if (this.scheduler.now() >= this.handshakeDeadlineAt) {
      this.close('HANDSHAKE_TIMEOUT');
      throw new RpcError('HANDSHAKE_TIMEOUT');
    }
  }
}
