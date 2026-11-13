import { createRpcClient } from '@integr8-media/ws-rpc/client';
import { useRpcMutation, useRpcQuery, useRpcSnapshot } from '@integr8-media/ws-rpc/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ExampleClient } from './router.ts';

const connection = createRpcClient<ExampleClient>({
  url: 'ws://127.0.0.1/rpc',
  protocolVersions: [1],
  getToken: async () => 'fake-unused',
  createWebSocket: () => {
    throw new Error('SSR must not open a socket.');
  },
});
const client = new QueryClient();
let calls = 0;
function Probe() {
  const snapshot = useRpcSnapshot(connection);
  const read = useRpcQuery({
    connection,
    cacheScope: 'ssr',
    queryKey: ['read'],
    query: async () => {
      calls += 1;
      return 1;
    },
  });
  useRpcMutation({
    connection,
    cacheScope: 'ssr',
    mutationKey: ['write'],
    mutation: async (_client, value: number) => {
      calls += 1;
      return value;
    },
  });
  return createElement('p', null, `${snapshot.state}:${read.status}`);
}
try {
  const html = renderToString(createElement(QueryClientProvider, { client }, createElement(Probe)));
  if (html !== '<p>idle:pending</p>' || calls !== 0) throw new Error('React SSR initiated work.');
} finally {
  client.clear();
  await connection.close();
}
