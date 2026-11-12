import { RpcError } from '@integr8-media/ws-rpc';
import { chunkBinary, createRpcClient, createRpcClientGroup } from '@integr8-media/ws-rpc/client';
import type { ExampleClient } from '../router.ts';

function element<T extends HTMLElement>(id: string, kind: new () => T): T {
  const value = document.getElementById(id);
  if (!(value instanceof kind)) throw new Error('Missing playground control.');
  return value;
}
const output = element('output', HTMLPreElement);
const state = element('state', HTMLParagraphElement);
function show(message: string): void {
  output.textContent = `${output.textContent}\n${message}`.slice(-8192);
}
const connection = createRpcClient<ExampleClient>({
  url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rpc`,
  protocolVersions: [1],
  getToken: async () => 'playground-fake-token',
  createWebSocket: (url) => new WebSocket(url),
});
const group = createRpcClientGroup({ main: connection });
const detach = group.subscribe((snapshot) => {
  state.textContent = snapshot.main.state;
});
let subscription: ReturnType<typeof connection.subscribeStream> | undefined;
function action(id: string, run: () => Promise<unknown>): void {
  element(id, HTMLButtonElement).addEventListener('click', () => {
    void run().catch((error: unknown) =>
      show(error instanceof RpcError ? error.code : 'Application error'),
    );
  });
}
action('connect', () => group.connect('main'));
action('binary', async () => {
  for await (const chunk of chunkBinary(new Uint8Array([1, 2, 3, 4, 5]), {
    maxBytes: 5,
    chunkBytes: 2,
    onProgress: (event) =>
      show(`prepared ${event.producedBytes}/${event.totalBytes} bytes; done=${event.done}`),
  })) {
    const result = await connection.client.binarySize(new Blob([new Uint8Array(chunk).buffer]));
    show(`example application received ${result.receivedBytes} bytes`);
  }
});
action('call', async () => {
  show(JSON.stringify(await connection.client.lookup({ id: 'browser' })));
});
action('stream', async () => {
  await subscription?.unsubscribe();
  subscription = connection.subscribeStream(
    (client, signal) => client.events({ count: 4 }, { signal }),
    {
      next: (item) => {
        show(`event ${item.sequence}`);
      },
      error: (error) => show(error instanceof RpcError ? error.code : 'Stream error'),
      complete: () => show('complete'),
      gap: () => show('gap: reconcile application state'),
    },
    { resubscribe: true },
  );
});
action('unsubscribe', async () => {
  await subscription?.unsubscribe();
  subscription = undefined;
});
action('close', async () => {
  await group.close();
  detach();
});
window.addEventListener(
  'pagehide',
  () => {
    detach();
    void group.close();
  },
  { once: true },
);
