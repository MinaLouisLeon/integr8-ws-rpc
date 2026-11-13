import {
  type ClientPeer,
  decodeRequestMessage,
  decodeResponseMessage,
  type EncodedMessage,
  encodeResponseMessage,
  MessageType,
} from '@orpc/standard-server-peer';
import { isAsyncIterator, retainIterator } from '../core/iteratorLifetime.js';
import type { TransportLimits } from '../core/limits.js';
import { RpcError } from '../core/rpcError.js';

type Response = Awaited<ReturnType<ClientPeer['request']>>;
const localIdHeader = 'x-integr8-local-peer-id';
interface RecordState {
  readonly sizes: number[];
  bytes: number;
  responseSeen: boolean;
  terminal: boolean;
  stream: boolean;
  failure?: RpcError;
}
interface Controls {
  close(id: string, error: RpcError): void;
  cancel(id: string): void;
}
interface Quota {
  sent(data: EncodedMessage): Promise<void>;
  received(data: EncodedMessage, bytes: number): Promise<EncodedMessage | undefined>;
  response(value: Response, signal: AbortSignal | undefined, lifetime: AbortSignal): Response;
  clear(): void;
}

/**
 * Resource bookkeeping around exported codecs, not a second router or ID generator. The temporary
 * header exists only between our adapter and ClientPeer and is stripped before RPC value decoding.
 * Network frames remain upstream oRPC frames, with IDs allocated exclusively by ClientPeer.
 */
export function createPeerQuota(limits: TransportLimits, controls: Controls): Quota {
  const records = new Map<string, RecordState>();
  let streams = 0;
  function drop(id: string): void {
    const record = records.get(id);
    if (!record) return;
    if (record.stream) streams -= 1;
    record.sizes.length = 0;
    record.bytes = 0;
    records.delete(id);
  }
  function fail(id: string, record: RecordState, code: 'BACKPRESSURE' | 'LIMIT_EXCEEDED'): void {
    const error = new RpcError(code);
    record.failure = error;
    drop(id);
    controls.close(id, error);
    controls.cancel(id);
  }
  return {
    sent: async (data): Promise<void> => {
      const [id, type] = await decodeRequestMessage(data);
      if (type === MessageType.REQUEST) {
        if (records.size >= limits.maxInFlightCalls + limits.maxSubscriptions + 1) {
          throw new RpcError('LIMIT_EXCEEDED');
        }
        records.set(id, {
          sizes: [],
          bytes: 0,
          responseSeen: false,
          terminal: false,
          stream: false,
        });
      } else if (type === MessageType.ABORT_SIGNAL) {
        drop(id);
      }
    },
    received: async (data, bytes): Promise<EncodedMessage | undefined> => {
      const [id, type, payload] = await decodeResponseMessage(data);
      const record = records.get(id);
      if (!record) return undefined; // Ignore cancelled/old/unsolicited IDs without allocating queues.
      if (type === MessageType.RESPONSE) {
        if (record.responseSeen) throw new RpcError('INVALID_MESSAGE');
        record.responseSeen = true;
        // The decoded initial stream response has an undefined body. Its public codec represents
        // streaming with this header; re-encoding undefined would erase the marker. An inert
        // iterator restores that representation without consuming or manufacturing any events.
        const contentType = payload.headers['content-type'];
        const streaming = (Array.isArray(contentType) ? contentType[0] : contentType)?.startsWith(
          'text/event-stream',
        );
        const body = streaming
          ? {
              [Symbol.asyncIterator]() {
                return this;
              },
              next: async (): Promise<IteratorResult<never>> => ({ done: true, value: undefined }),
            }
          : payload.body;
        return encodeResponseMessage(id, MessageType.RESPONSE, {
          ...payload,
          body,
          headers: { ...payload.headers, [localIdHeader]: id },
        });
      }
      if (type === MessageType.EVENT_ITERATOR) {
        if (record.terminal) throw new RpcError('INVALID_MESSAGE');
        if (
          (payload.event === 'message' && record.sizes.length >= limits.maxPendingStreamItems) ||
          record.bytes > limits.maxPendingStreamBytes - bytes
        ) {
          fail(id, record, 'BACKPRESSURE');
          return undefined;
        }
        record.terminal = payload.event !== 'message';
        record.sizes.push(bytes);
        record.bytes += bytes;
      }
      return data;
    },
    response: (value, signal, lifetime): Response => {
      const { [localIdHeader]: id, ...headers } = value.headers;
      if (typeof id !== 'string') throw new RpcError('INVALID_MESSAGE');
      const record = records.get(id);
      if (!isAsyncIterator(value.body)) {
        drop(id);
        return { ...value, headers };
      }
      if (record) {
        if (streams >= limits.maxSubscriptions) {
          fail(id, record, 'LIMIT_EXCEEDED');
          throw new RpcError('LIMIT_EXCEEDED');
        }
        record.stream = true;
        streams += 1;
      }
      return {
        ...value,
        headers,
        body: retainIterator(value.body, {
          ...(signal ? { signal } : {}),
          lifetime,
          beforeNext: () => {
            if (record?.failure) throw record.failure;
          },
          onItem: () => {
            if (record) record.bytes -= record.sizes.shift() ?? 0;
          },
          onAbort: (error) => {
            controls.close(id, error);
            controls.cancel(id);
          },
          onFinish: () => drop(id),
        }),
      };
    },
    clear: (): void => {
      for (const id of [...records.keys()]) drop(id);
    },
  };
}
