import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startExample } from './server.mjs';

const app = await startExample();
const react = process.argv.includes('--react');
let browser;
let closing;
function close() {
  closing ??= (async () => {
    await browser?.close();
    await app.close();
  })();
  return closing;
}
try {
  browser = await createServer({
    configFile: false,
    root: fileURLToPath(new URL(react ? './react/' : './browser/', import.meta.url)),
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/rpc': { target: new URL(app.url).origin, ws: true } },
    },
  });
  await browser.listen();
  process.stdout.write('RPC playground: http://127.0.0.1:5173 (loopback, fake credentials).\n');
  process.once('SIGINT', () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once('SIGTERM', () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
} catch (error) {
  await close();
  throw error;
}
