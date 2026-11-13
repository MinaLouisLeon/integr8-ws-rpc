import { RpcError } from '@integr8-media/ws-rpc';
import { chunkBinary, createRpcClient, createRpcClientGroup } from '@integr8-media/ws-rpc/client';
import type { ExampleClient } from './router.ts';

// A real bundled entry using only the installed package's browser-safe public entry points.
export function makeBrowserConnection(
  url: string,
): ReturnType<typeof createRpcClient<ExampleClient>> {
  return createRpcClient<ExampleClient>({
    url,
    protocolVersions: [1],
    getToken: async () => 'playground-fake-token',
    createWebSocket: (endpoint) => new WebSocket(endpoint),
  });
}
export function safeCode(error: unknown): string {
  return error instanceof RpcError ? error.code : 'Application error';
}
const status = document.createElement('p');
const connection = makeBrowserConnection('ws://127.0.0.1/rpc');
const group = createRpcClientGroup({ main: connection });
status.textContent = `Packed browser client imported: ${group.getSnapshot().main.state}. Runtime RPC requires the separate playground.`;
document.body.append(status);
void (async () => {
  let produced = 0;
  for await (const chunk of chunkBinary(new Uint8Array([1, 2, 3]), {
    maxBytes: 3,
    chunkBytes: 2,
  })) {
    produced += chunk.byteLength;
  }
  status.textContent += ` Local binary helper produced ${produced} bytes.`;
})().catch((error: unknown) => {
  status.textContent = safeCode(error);
});
window.addEventListener(
  'pagehide',
  () => {
    void group.close().catch((error: unknown) => {
      status.textContent = safeCode(error);
    });
  },
  { once: true },
);
