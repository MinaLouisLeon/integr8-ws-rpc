import { createORPCClient, type InferClientErrors } from '@orpc/client';
import { StandardRPCLink } from '@orpc/client/standard';
import { type LinkWebsocketClientOptions, RPCLink } from '@orpc/client/websocket';
import type { RouterClient } from '@orpc/server';
import { RPCHandler } from '@orpc/server/ws';
import type { WebSocket } from 'ws';
import { createUnaryConnection, type UnaryConnection } from '../../src/client/connection.js';
import { chunkBinary, createRpcClient, createRpcClientGroup } from '../../src/client/index.js';
import { createPeerClient } from '../../src/client/peerClient.js';
import type { RpcClientOptions } from '../../src/index.js';
import { createRpcServer } from '../../src/server/index.js';
import { type ApplicationClient, application, router } from './router.js';

/** Compile-only factory: called by no script and never opens a socket. */
export function makeClient(socket: LinkWebsocketClientOptions['websocket']): ApplicationClient {
  return createORPCClient<ApplicationClient>(new RPCLink({ websocket: socket }));
}

/** Compile-only owned adapter composition must retain the same inferred application client. */
export function makeOwnedClient(
  socket: ReturnType<RpcClientOptions['createWebSocket']>,
): ApplicationClient {
  const peer = createPeerClient(socket);
  return createORPCClient<ApplicationClient>(
    new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
  );
}

/** Private M1 connection composition; this is not an added public package export. */
export function makeOwnedConnection(options: RpcClientOptions): UnaryConnection<ApplicationClient> {
  return createUnaryConnection<ApplicationClient>(options);
}

/** Required caller context must not be erased by the connection's generic constraint. */
export function checkRequiredContext(options: RpcClientOptions): void {
  type ContextClient = RouterClient<typeof application, { tenant: string }>;
  const connection = createUnaryConnection<ContextClient>(options);
  void connection.client.nested.lookup({ id: 'one' }, { context: { tenant: 'example' } });
  // @ts-expect-error A client with required context cannot omit its context argument.
  void connection.client.nested.lookup({ id: 'one' });
  // @ts-expect-error Caller context values must retain their declared types.
  void connection.client.nested.lookup({ id: 'one' }, { context: { tenant: 1 } });
  const publicConnection = createRpcClient<ContextClient>(options);
  void publicConnection.client.nested.lookup({ id: 'one' }, { context: { tenant: 'example' } });
  // @ts-expect-error Public factory must preserve required per-call context too.
  void publicConnection.client.nested.lookup({ id: 'one' });
  const group = createRpcClientGroup({
    contextual: publicConnection,
    ordinary: createRpcClient<ApplicationClient>(options),
  });
  void group.clients.contextual.client.nested.lookup(
    { id: 'one' },
    { context: { tenant: 'example' } },
  );
  void group.clients.ordinary.client.nested.lookup({ id: 'one' });
  // @ts-expect-error Group must not erase one child's required per-call context.
  void group.clients.contextual.client.nested.lookup({ id: 'one' });
  // @ts-expect-error Group names must remain the exact registry keys.
  void group.connect('unknown');
  // @ts-expect-error Public registry is readonly.
  group.clients.ordinary = publicConnection;
}

/** Binary options/item/progress types survive the public barrel without a new wire contract. */
export async function checkBinary(signal: AbortSignal): Promise<void> {
  const chunks = chunkBinary(new Uint8Array([1, 2]), {
    maxBytes: 2,
    signal,
    onProgress: (event) => {
      const produced: number = event.producedBytes;
      // @ts-expect-error Progress snapshots are readonly.
      event.done = true;
      void produced;
    },
  });
  for await (const chunk of chunks) {
    const bytes: Uint8Array = chunk;
    // @ts-expect-error Binary chunks are not decoded strings.
    const wrong: string = chunk;
    void [bytes, wrong];
  }
  // @ts-expect-error An explicit whole-input budget is required.
  chunkBinary(new Uint8Array([1]), {});
}

/** Public factory inference: input/output/error/stream types must survive the lifecycle wrapper. */
export async function checkPublicFactory(options: RpcClientOptions): Promise<void> {
  const connection = createRpcClient<ApplicationClient>(options);
  await checkCalls(connection.client, new AbortController().signal);
  connection.subscribeStream((client, signal) => client.nested.events(undefined, { signal }), {
    next: (item) => {
      const sequence: number = item.sequence;
      // @ts-expect-error Managed stream item type must remain a number.
      const wrong: string = item.sequence;
      void [sequence, wrong];
    },
    error: () => {},
    complete: () => {},
  });
  createRpcServer({
    router: application,
    protocolVersions: [1],
    authenticate: async () => ({ context: { session: { principal: { id: 'example' } } } }),
  });
  createRpcServer({
    router: application,
    protocolVersions: [1],
    // @ts-expect-error Authentication must supply the application router's required context.
    authenticate: async () => ({ context: { unrelated: true } }),
  });
}

/** Compile-only attachment confirms the selected ws upgrade/context signature. */
export async function attach(socket: WebSocket): Promise<void> {
  const handler = new RPCHandler(router);
  await handler.upgrade(socket, { context: { session: { principal: undefined } } });
}

/** Positive and negative call-site checks must survive the eventual package wrapper. */
export async function checkCalls(client: ApplicationClient, signal: AbortSignal): Promise<void> {
  const value = await client.nested.lookup({ id: 'one' }, { signal });
  const owner: string = value.owner;
  // @ts-expect-error Output must retain its string type.
  const wrongOutput: number = value.owner;
  // @ts-expect-error Input id must remain a string.
  await client.nested.lookup({ id: 1 });
  // @ts-expect-error Unknown procedures must not become callable.
  await client.nested.missing();
  const stream: AsyncIterable<{ sequence: number }> = await client.nested.events(undefined, {
    signal,
  });
  for await (const item of stream) {
    const sequence: number = item.sequence;
    // @ts-expect-error Stream item types must not widen to unknown or any.
    const wrongItem: string = item.sequence;
    void [sequence, wrongItem];
  }
  void [owner, wrongOutput];
}

type LookupError = Extract<
  InferClientErrors<ApplicationClient>['nested']['lookup'],
  { code: 'NOT_FOUND' }
>;

export function checkError(error: LookupError): string {
  // @ts-expect-error Typed application error data must retain its string id.
  const wrong: number = error.data.id;
  void wrong;
  return error.data.id;
}
