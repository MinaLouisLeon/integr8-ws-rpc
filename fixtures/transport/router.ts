import { ORPCError, os, type RouterClient } from '@orpc/server';
import * as z from 'zod';

// Compile-only characterization, never a production transport or authentication implementation.
interface SessionCell {
  principal: { readonly id: string } | undefined;
}

const base = os.$context<{ session: SessionCell }>();
const guarded = base.use(({ context, next }) => {
  const principal = context.session.principal;
  if (!principal) {
    throw new ORPCError('UNAUTHORIZED');
  }
  return next({ context: { principal } });
});

const lookup = guarded
  .input(z.object({ id: z.string() }))
  .output(z.object({ id: z.string(), owner: z.string() }))
  .errors({ NOT_FOUND: { data: z.object({ id: z.string() }) } })
  .handler(({ input, context, errors, signal }) => {
    signal?.throwIfAborted();
    if (input.id === 'missing') {
      throw errors.NOT_FOUND({ data: { id: input.id } });
    }
    return { id: input.id, owner: context.principal.id };
  });

const events = guarded.handler(async function* ({ signal }): AsyncGenerator<{ sequence: number }> {
  signal?.throwIfAborted();
  yield { sequence: 1 };
});

export const application = { nested: { lookup, events } };
export const router = {
  ...application,
  __integr8Transport: {
    // Shows reserved procedure + app router composition only; no real hello/auth contract here.
    ping: base.handler((): { alive: true } => ({ alive: true })),
  },
};

export type ApplicationClient = RouterClient<typeof application>;
