import { integr8SizeLimit } from '@integr8-media/config/size-limit';

export default integr8SizeLimit([
  { name: 'Root entry JS', path: 'dist/browser/index.mjs', limit: '5 kB' },
  { name: 'Client entry JS', path: 'dist/browser/client/index.mjs', limit: '20 kB' },
  { name: 'Server entry JS', path: 'dist/node/server/index.mjs', limit: '30 kB' },
  { name: 'Fastify entry JS', path: 'dist/node/fastify/index.mjs', limit: '10 kB' },
  { name: 'Root emitted JS', path: 'dist/browser/**/*.mjs', limit: '25 kB' },
  { name: 'Server and Fastify emitted JS', path: 'dist/node/**/*.mjs', limit: '40 kB' },
  { name: 'All emitted JS including shared chunks', path: 'dist/**/*.mjs', limit: '65 kB' },
]).map((entry) => ({ ...entry, gzip: true }));
