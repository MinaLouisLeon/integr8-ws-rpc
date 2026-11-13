import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { attach } from './inference.js';

/** Compile-only plugin/ws shape check, never a runnable or authenticated server example. */
export async function checkFastify(instance: FastifyInstance): Promise<void> {
  await instance.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  instance.get('/compile-fixture', { websocket: true }, (socket): void => {
    // No fixture code is executed; real upgrade rejection, auth and cleanup belong to M1.
    void attach(socket);
  });
}
