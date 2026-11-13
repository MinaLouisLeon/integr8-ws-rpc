import { os, type RouterClient } from '@orpc/server';
import * as z from 'zod';

// Example application contract only. Never imported by the library's runtime entry points.
const base = os.$context<{ principal: string }>();

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
