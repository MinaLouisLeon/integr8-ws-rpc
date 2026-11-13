import { createRpcDeliveryLedger } from '@integr8-media/ws-rpc/server';
import { os, type RouterClient } from '@orpc/server';
import * as z from 'zod';

// Example application contract only. Never imported by the library's runtime entry points.
const base = os.$context<{ principal: string }>();

// Process-local example only: real applications own identity, operation schemas and commit policy.
export const exampleDeliveryLedger = createRpcDeliveryLedger({
  maxEntries: 32,
  maxBytes: 32_768,
  maxEntryBytes: 64,
  maxCommandAgeMs: 60_000,
  retentionMs: 120_000,
  encodeResult: (value: number): Uint8Array => new TextEncoder().encode(String(value)),
  decodeResult: (bytes: Uint8Array): number =>
    z
      .number()
      .int()
      .nonnegative()
      .parse(Number(new TextDecoder().decode(bytes))),
});
const totals = new Map<string, number>();
const deliveryInput = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  expiresAt: z.number().int().positive(),
  payload: z.array(z.number().int().min(0).max(255)).max(64),
});
function packReceipt(receipt: ReturnType<typeof exampleDeliveryLedger.lookup>) {
  return receipt.state === 'completed'
    ? { ...receipt, result: Array.from(receipt.result) }
    : receipt;
}

function waitForTick(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
    };
    const abort = (): void => {
      cleanup();
      reject(new Error('Example stream cancelled.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 100);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export const exampleRouter = {
  delivery: {
    increment: base.input(deliveryInput).handler(async ({ input, context }) =>
      packReceipt(
        await exampleDeliveryLedger.execute(
          `${context.principal}/increment`,
          {
            ...input,
            payload: new Uint8Array(input.payload),
          },
          (bytes, signal) => {
            signal.throwIfAborted();
            const amount = z.number().int().min(1).max(10).parse(bytes[0]);
            if (bytes.length !== 1) throw new Error('Invalid example command.');
            const total = (totals.get(context.principal) ?? 0) + amount;
            totals.set(context.principal, total);
            return total;
          },
        ),
      ),
    ),
    status: base
      .input(z.object({ key: deliveryInput.shape.key }))
      .handler(({ input, context }) =>
        packReceipt(exampleDeliveryLedger.lookup(`${context.principal}/increment`, input.key)),
      ),
  },
  binarySize: base
    .input(z.instanceof(Blob))
    .handler(({ input }) => ({ receivedBytes: input.size })),
  lookup: base
    .input(z.object({ id: z.string() }))
    .errors({ NOT_FOUND: { data: z.object({ id: z.string() }) } })
    .handler(({ input, context, errors }) => {
      if (input.id === 'missing') throw errors.NOT_FOUND({ data: { id: input.id } });
      return { id: input.id, owner: context.principal };
    }),
  events: base
    .input(z.object({ count: z.number().int().min(1).max(256) }))
    .handler(async function* ({ input, context, signal }): AsyncGenerator<{
      sequence: number;
      owner: string;
    }> {
      for (let sequence = 0; sequence < input.count; sequence += 1) {
        signal?.throwIfAborted();
        yield { sequence, owner: context.principal };
        if (sequence + 1 < input.count) await waitForTick(signal);
      }
    }),
};
export type ExampleClient = RouterClient<typeof exampleRouter>;
