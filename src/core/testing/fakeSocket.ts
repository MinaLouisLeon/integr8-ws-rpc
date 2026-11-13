import type { RpcClientOptions } from '../connectionTypes.js';

type Socket = ReturnType<RpcClientOptions['createWebSocket']>;
type SendData = Parameters<Socket['send']>[0];

interface Registration {
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly capture: boolean;
  readonly wrapped: EventListener;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

/** Private test facility: no real socket, wall-clock timer or automatic event scheduling. */
export class FakeSocket {
  public readonly socket: Socket;
  private readonly events: EventTarget = new EventTarget();
  private readonly registrations: Set<Registration> = new Set();
  private readonly sentData: SendData[] = [];
  private state: Socket['readyState'] = 0;
  private queuedBytes: number = 0;

  public constructor() {
    const owner = this;
    this.socket = {
      get readyState(): Socket['readyState'] {
        return owner.state;
      },
      get bufferedAmount(): number {
        return owner.queuedBytes;
      },
      // EventTarget dispatches concrete MessageEvent/Event instances below. The cast adapts
      // its broad listener signature to WebSocket's event-map overloads, without router casts.
      addEventListener: this.addListener.bind(this) as Socket['addEventListener'],
      removeEventListener: this.removeListener.bind(this) as Socket['removeEventListener'],
      send: (data: SendData): void => {
        if (this.state !== 1) {
          throw new Error('Fake socket is not open.');
        }
        this.sentData.push(data);
        this.queuedBytes += this.byteLength(data);
      },
      close: (): void => {
        if (this.state !== 3) {
          this.state = 2;
        }
      },
    };
  }

  public get sent(): readonly SendData[] {
    return [...this.sentData];
  }

  public get listenerCount(): number {
    return this.registrations.size;
  }

  public open(): void {
    if (this.state !== 0) {
      throw new Error('Fake socket cannot reopen.');
    }
    this.state = 1;
    this.events.dispatchEvent(new Event('open'));
  }

  /** Allows deliberate late delivery after close to test connection epoch isolation. */
  public receive(data: unknown): void {
    this.events.dispatchEvent(new MessageEvent('message', { data }));
  }

  public finishClose(code = 1000, reason = ''): void {
    if (this.state === 3) {
      return;
    }
    this.state = 3;
    this.queuedBytes = 0;
    this.events.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: true }));
  }

  public drain(): void {
    this.queuedBytes = 0;
  }

  private byteLength(data: SendData): number {
    if (typeof data === 'string') {
      return new TextEncoder().encode(data).byteLength;
    }
    if (data instanceof Blob) {
      return data.size;
    }
    return data.byteLength;
  }

  private addListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener === null) {
      return;
    }
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
    const settings = typeof options === 'object' ? options : {};
    if (settings.signal?.aborted) {
      return;
    }
    for (const entry of this.registrations) {
      if (entry.type === type && entry.listener === listener && entry.capture === capture) {
        return;
      }
    }
    const wrapped: EventListener = (event): void => {
      if (settings.once) {
        this.removeListener(type, listener, capture);
      }
      if (typeof listener === 'function') {
        listener.call(this.socket, event);
      } else {
        listener.handleEvent(event);
      }
    };
    const abort = (): void => {
      this.removeListener(type, listener, capture);
    };
    this.registrations.add({
      type,
      listener,
      capture,
      wrapped,
      ...(settings.signal ? { signal: settings.signal, abort } : {}),
    });
    this.events.addEventListener(type, wrapped, capture);
    settings.signal?.addEventListener('abort', abort, { once: true });
  }

  private removeListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
    for (const entry of this.registrations) {
      if (entry.type === type && entry.listener === listener && entry.capture === capture) {
        this.events.removeEventListener(type, entry.wrapped, capture);
        if (entry.signal && entry.abort) {
          entry.signal.removeEventListener('abort', entry.abort);
        }
        this.registrations.delete(entry);
        return;
      }
    }
  }
}
