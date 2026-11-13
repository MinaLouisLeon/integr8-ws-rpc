import { type createRpcClient, createRpcOfflineQueue } from '@integr8-media/ws-rpc/client';
import type { ExampleClient } from './router.ts';

/** Application-owned byte/wire mapping; no server value import enters the browser bundle. */
export function makeExampleOfflineQueue(
  connection: ReturnType<typeof createRpcClient<ExampleClient>>,
): ReturnType<typeof createRpcOfflineQueue<ExampleClient, number, number>> {
  const unpack = (receipt: Awaited<ReturnType<ExampleClient['delivery']['status']>>) =>
    receipt.state === 'completed'
      ? { ...receipt, result: new Uint8Array(receipt.result) }
      : receipt;
  return createRpcOfflineQueue({
    connection,
    maxEntries: 8,
    maxBytes: 4096,
    maxEntryBytes: 64,
    maxAgeMs: 30_000,
    attemptTimeoutMs: 5000,
    encode: (amount: number): Uint8Array => {
      if (!Number.isInteger(amount) || amount < 1 || amount > 10) {
        throw new Error('Example amount must be an integer from 1 to 10.');
      }
      return new Uint8Array([amount]);
    },
    decode: (bytes: Uint8Array): number => {
      const amount = bytes[0];
      if (bytes.length !== 1 || amount === undefined || amount < 1 || amount > 10) {
        throw new Error('Invalid example amount.');
      }
      return amount;
    },
    decodeResult: (bytes: Uint8Array): number => {
      const value = Number(new TextDecoder().decode(bytes));
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid example receipt.');
      return value;
    },
    deliver: async (client, command, signal) =>
      unpack(
        await client.delivery.increment(
          {
            ...command,
            payload: Array.from(command.payload),
          },
          { signal },
        ),
      ),
    reconcile: async (client, key, signal) =>
      unpack(await client.delivery.status({ key }, { signal })),
  });
}
