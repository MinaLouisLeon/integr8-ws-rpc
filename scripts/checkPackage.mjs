import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectPackage } from './packageChecks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = await inspectPackage(root);
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
Object.defineProperty(globalThis, 'WebSocket', {
  configurable: true,
  get() {
    throw new Error('Root/client evaluated the global WebSocket during import.');
  },
});
try {
  for (const path of entries) {
    await import(pathToFileURL(path).href);
  }
} finally {
  if (descriptor) {
    Object.defineProperty(globalThis, 'WebSocket', descriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'WebSocket');
  }
}
console.log('Dist exports, installed client runtime graph and WebSocket import isolation checked.');
