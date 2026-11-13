import { RpcError } from '@integr8-media/ws-rpc';
import { createRpcClient } from '@integr8-media/ws-rpc/client';
import { useRpcMutation, useRpcQuery, useRpcSnapshot } from '@integr8-media/ws-rpc/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExampleClient } from './router.ts';

const connection = createRpcClient<ExampleClient>({
  url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rpc`,
  protocolVersions: [1],
  getToken: async () => 'playground-fake-token',
  createWebSocket: (url) => new WebSocket(url),
});
const queryClient = new QueryClient();
function code(error: unknown): string {
  return error instanceof RpcError ? error.code : error ? 'Application error' : '';
}
function Example() {
  const snapshot = useRpcSnapshot(connection);
  const [localError, setLocalError] = useState('');
  const read = useRpcQuery({
    connection,
    cacheScope: 'playground',
    queryKey: ['lookup', 'react'],
    query: (client, signal) => client.lookup({ id: 'react' }, { signal }),
  });
  const write = useRpcMutation({
    connection,
    cacheScope: 'playground',
    mutationKey: ['increment'],
    mutation: (client, input: { key: string; amount: number }) =>
      client.delivery.increment({
        key: input.key,
        expiresAt: Date.now() + 30_000,
        payload: [input.amount],
      }),
  });
  const button = (label: string, run: () => void) =>
    createElement('button', { type: 'button', onClick: run }, label);
  return createElement(
    'main',
    null,
    createElement('h1', null, 'React RPC playground'),
    createElement('p', { role: 'status' }, `Connection: ${snapshot.state}`),
    createElement(
      'p',
      null,
      'Fake credentials on loopback. Reads and mutations run only when requested.',
    ),
    button('Connect', () => {
      void connection.connect().catch((error: unknown) => setLocalError(code(error)));
    }),
    button('Read lookup', () => {
      void read.refetch();
    }),
    button('Send increment', () => write.mutate({ key: `react_${Date.now()}`, amount: 1 })),
    button('Close', () => {
      void connection.close();
    }),
    createElement('pre', null, read.data ? JSON.stringify(read.data) : 'No read result'),
    createElement('pre', null, write.data ? JSON.stringify(write.data) : 'No mutation result'),
    createElement('p', { role: 'alert' }, localError || code(read.error) || code(write.error)),
  );
}
const host = document.getElementById('root');
if (!host) throw new Error('Missing React playground root.');
const root = createRoot(host);
root.render(
  createElement(
    StrictMode,
    null,
    createElement(QueryClientProvider, { client: queryClient }, createElement(Example)),
  ),
);
window.addEventListener(
  'pagehide',
  () => {
    root.unmount();
    queryClient.clear();
    void connection.close();
  },
  { once: true },
);
