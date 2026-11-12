import { os, type RouterClient } from '@orpc/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createSocketPair } from '../core/testing/socketPair.js';
import { createRpcServer } from '../server/createRpcServer.js';
import { getServerBinding } from '../server/serverBinding.js';
import { createRpcClient } from './createRpcClient.js';
import { createRpcClientGroup } from './createRpcClientGroup.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('M4 prerequisite: independent existing handles', () => {
  it('keeps credentials, schemas, sessions and shutdown isolated before adding orchestration', async () => {
    const base = os.$context<{ principal: string }>();
    const catalogRouter = {
      catalog: base.handler(({ context }) => ({ owner: context.principal })),
    };
    const jobsRouter = {
      jobs: base.handler(({ context }) => ({ worker: context.principal, active: 2 })),
    };
    let catalogReads = 0;
    let jobsReads = 0;
    const catalogServer = createRpcServer({
      router: catalogRouter,
      protocolVersions: [1],
      authenticate: async ({ token }) => {
        if (token !== 'catalog-fake-token') throw new Error('Rejected fixture credential.');
        return { context: { principal: 'catalog-owner' } };
      },
    });
    const jobsServer = createRpcServer({
      router: jobsRouter,
      protocolVersions: [2],
      authenticate: async ({ token }) => {
        if (token !== 'jobs-fake-token') throw new Error('Rejected fixture credential.');
        return { context: { principal: 'jobs-worker' } };
      },
    });
    cleanup.push(
      () => catalogServer.close(),
      () => jobsServer.close(),
    );
    const catalogPair = createSocketPair();
    const jobsPair = createSocketPair();
    getServerBinding(catalogServer).attach(catalogPair.server);
    getServerBinding(jobsServer).attach(jobsPair.server);
    const catalog = createRpcClient<RouterClient<typeof catalogRouter>>({
      url: 'ws://127.0.0.1/catalog',
      protocolVersions: [1],
      reconnect: false,
      getToken: async () => {
        catalogReads += 1;
        return 'catalog-fake-token';
      },
      createWebSocket: () => catalogPair.client,
    });
    const jobs = createRpcClient<RouterClient<typeof jobsRouter>>({
      url: 'ws://127.0.0.1/jobs',
      protocolVersions: [2],
      reconnect: false,
      getToken: async () => {
        jobsReads += 1;
        return 'jobs-fake-token';
      },
      createWebSocket: () => jobsPair.client,
    });
    cleanup.push(
      () => catalog.close(),
      () => jobs.close(),
    );
    const group = createRpcClientGroup({ catalog, jobs });
    cleanup.push(() => group.close());
    const connecting = group.connect('catalog');
    expect(group.connect('catalog')).toBe(connecting);
    await Promise.all([connecting, group.connect('jobs')]);
    expect(catalogReads).toBe(1);
    expect(jobsReads).toBe(1);
    await expect(catalog.client.catalog()).resolves.toEqual({ owner: 'catalog-owner' });
    await expect(jobs.client.jobs()).resolves.toEqual({ worker: 'jobs-worker', active: 2 });
    const catalogSnapshot = catalog.getSnapshot();
    const jobsSnapshot = jobs.getSnapshot();
    expect(catalogSnapshot.state).toBe('ready');
    expect(jobsSnapshot.state).toBe('ready');
    if (catalogSnapshot.state !== 'ready' || jobsSnapshot.state !== 'ready') {
      throw new Error('Expected independent authenticated sessions.');
    }
    expect(catalogSnapshot.protocolVersion).toBe(1);
    expect(jobsSnapshot.protocolVersion).toBe(2);
    expect(catalogSnapshot.sessionId).not.toBe(jobsSnapshot.sessionId);
    await catalogServer.disconnectSession(catalogSnapshot.sessionId, 'AUTH_FAILED');
    expect(catalogPair.clientSocket.listenerCount).toBe(0);
    expect(jobs.getSnapshot()).toEqual(jobsSnapshot);
    await expect(jobs.client.jobs()).resolves.toEqual({ worker: 'jobs-worker', active: 2 });
    await group.close('catalog');
    expect(jobsPair.clientSocket.socket.readyState).toBe(1);
  });
});
