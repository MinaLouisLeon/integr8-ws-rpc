import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { os } from '@orpc/server';
import Fastify from 'fastify';
import { WebSocket as NativeWebSocket } from 'ws';
import { createRpcClient } from '../dist/browser/client/index.mjs';
import { registerRpcWebSocket } from '../dist/node/fastify/index.mjs';
import { createRpcServer } from '../dist/node/server/index.mjs';

assert(typeof global.gc === 'function', 'Run npm run test:stress (requires --expose-gc).');
const app = Fastify({ logger: false });
let produced;
const router = {
  ping: os.handler(() => 'pong'),
  burst: os.handler(async function* ({ signal }) {
    try {
      for (let sequence = 0; sequence < 128; sequence += 1) {
        signal?.throwIfAborted();
        yield { sequence, data: 'x'.repeat(512) };
      }
    } finally {
      produced?.resolve();
    }
  }),
};
const server = createRpcServer({
  router,
  protocolVersions: [1],
  authenticate: async ({ token }) => {
    if (token !== 'stress-fake-token') throw new Error('Rejected fixture credentials.');
    return { context: {} };
  },
});
const adapter = registerRpcWebSocket(app, server, {
  originPolicy: (origin) => origin === undefined,
});
const outputDirectory = fileURLToPath(new URL('../fixtures/.artifacts/', import.meta.url));
await mkdir(outputDirectory, { recursive: true });
const samples = [];
const result = {
  status: 'incomplete',
  node: process.version,
  samples,
  cycles: 0,
  malformedPeers: 0,
};
let active;
let malformed;
let checksPassed = false;
async function withinDeadline(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native stress step exceeded 10 seconds.')),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function sample() {
  global.gc();
  const memory = process.memoryUsage();
  return {
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    rss: memory.rss,
  };
}
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}/rpc`;
  for (let iteration = 0; iteration < 35; iteration += 1) {
    produced = Promise.withResolvers();
    active = createRpcClient({
      url,
      protocolVersions: [1],
      getToken: async () => 'stress-fake-token',
      createWebSocket: (endpoint) => new WebSocket(endpoint),
      reconnect: false,
      maxPendingStreamItems: 8,
      maxPendingStreamBytes: 4096,
    });
    await active.connect();
    const pending = active.client.burst().then(
      (stream) => ({ stream }),
      (error) => ({ error }),
    );
    await withinDeadline(produced.promise);
    assert.equal(await active.client.ping(), 'pong');
    const outcome = await pending;
    if (outcome.stream)
      await assert.rejects(withinDeadline(outcome.stream.next()), { code: 'BACKPRESSURE' });
    else assert.equal(outcome.error?.code, 'BACKPRESSURE');
    malformed = new NativeWebSocket(url);
    await once(malformed, 'open', { signal: AbortSignal.timeout(10_000) });
    const closed = once(malformed, 'close', { signal: AbortSignal.timeout(10_000) });
    malformed.send('{malformed');
    await closed;
    malformed = undefined;
    result.malformedPeers += 1;
    assert.equal(await active.client.ping(), 'pong');
    await active.close();
    active = undefined;
    await new Promise((resolve) => setImmediate(resolve));
    result.cycles += 1;
    if (iteration >= 4 && (iteration - 4) % 5 === 0) samples.push(sample());
  }
  const baseline = samples[0];
  const latest = samples.at(-1);
  assert(baseline && latest);
  // Regression envelope, not a proof of exact per-stream or process-memory limits.
  assert(
    latest.heapUsed - baseline.heapUsed < 32 * 1024 * 1024,
    'Retained heap regression exceeded 32 MiB.',
  );
  assert(
    latest.external - baseline.external < 32 * 1024 * 1024,
    'Retained external memory regression exceeded 32 MiB.',
  );
  checksPassed = true;
} finally {
  let disposed = false;
  try {
    malformed?.terminate();
    await active?.close();
    await adapter.dispose();
    await server.close();
    await app.close();
    disposed = true;
  } finally {
    result.status = checksPassed && disposed ? 'passed' : 'incomplete';
    await writeFile(
      new URL('../fixtures/.artifacts/stress.json', import.meta.url),
      JSON.stringify({ ...result, finishedAt: new Date().toISOString() }, null, 2),
    );
  }
}
process.stdout.write(
  'Native slow/malformed-peer stress completed; see fixtures/.artifacts/stress.json.\n',
);
