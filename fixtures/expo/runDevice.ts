import { type RpcClientOptions, RpcError } from '@integr8-media/ws-rpc';
import { chunkBinary, createRpcClient, createRpcClientGroup } from '@integr8-media/ws-rpc/client';
import type { ExampleClient } from './router.ts';

export interface DeviceResult {
  readonly state: 'passed';
  readonly platform: 'android' | 'ipados';
  readonly runtime: string;
  readonly artifactSha256: string;
  readonly states: readonly string[];
  readonly received: number;
  readonly localBinaryBytes: number;
  readonly binaryRpcBytes: number | null;
}

/** Run inside the developer's existing Expo app. No React/native imports enter the transport. */
export async function runDevice(
  options: Readonly<{
    platform: DeviceResult['platform'];
    runtime: string;
    artifactSha256: string;
    connection: RpcClientOptions;
    verifyBinaryRpc?: boolean;
  }>,
): Promise<DeviceResult> {
  if (!/^[a-f0-9]{64}$/i.test(options.artifactSha256) || !options.runtime.trim()) {
    throw new Error('Record the actual packed artifact hash and Expo/runtime version.');
  }
  if (options.platform !== 'android' && options.platform !== 'ipados') {
    throw new Error('Record the actual native device platform.');
  }
  const states: string[] = [];
  const connection = createRpcClient<ExampleClient>(options.connection);
  const group = createRpcClientGroup({ main: connection });
  const detach = connection.subscribe((snapshot) => {
    states.push(snapshot.state);
  });
  let received = 0;
  let localBinaryBytes = 0;
  let binaryRpcBytes: number | null = options.verifyBinaryRpc ? 0 : null;
  try {
    await group.connect('main');
    const result = await connection.client.lookup({ id: 'device' });
    if (result.id !== 'device' || typeof result.owner !== 'string')
      throw new Error('Unexpected call output.');
    const stream = await connection.client.events({ count: 3 });
    for await (const item of stream) {
      if (item.sequence !== received) throw new Error('Unexpected stream sequence.');
      received += 1;
    }
    if (received !== 3) throw new Error('Incomplete stream.');
    for await (const chunk of chunkBinary(new Uint8Array([1, 2, 3]), {
      maxBytes: 3,
      chunkBytes: 2,
    })) {
      localBinaryBytes += chunk.byteLength;
      if (binaryRpcBytes !== null) {
        const reply = await connection.client.binarySize(new Blob([new Uint8Array(chunk).buffer]));
        binaryRpcBytes += reply.receivedBytes;
      }
    }
    if (localBinaryBytes !== 3) throw new Error('Unexpected local binary output.');
    if (binaryRpcBytes !== null && binaryRpcBytes !== 3)
      throw new Error('Unexpected native binary RPC output.');
    const controller = new AbortController();
    controller.abort();
    try {
      await connection.client.lookup({ id: 'cancelled' }, { signal: controller.signal });
      throw new Error('Pre-aborted call unexpectedly succeeded.');
    } catch (error) {
      if (!(error instanceof RpcError) || error.code !== 'CANCELLED') throw error;
    }
  } finally {
    await group.close();
    detach();
  }
  if (connection.getSnapshot().state !== 'closed') throw new Error('Connection did not close.');
  return Object.freeze({
    state: 'passed',
    platform: options.platform,
    runtime: options.runtime,
    artifactSha256: options.artifactSha256,
    states: Object.freeze(states),
    received,
    localBinaryBytes,
    binaryRpcBytes,
  });
}
