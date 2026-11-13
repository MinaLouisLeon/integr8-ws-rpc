import { integr8Tsdown } from '@integr8-media/config/tsdown';
import type { UserConfig } from 'tsdown';

// One graph preserves RpcError identity across all entries and server-handle identity across
// server/Fastify. Dist paths still separate platform entries; inspectPackage checks client chunks.
const config: UserConfig = {
  ...integr8Tsdown({
    entry: {
      'browser/index': 'src/index.ts',
      'browser/client/index': 'src/client/index.ts',
      'node/server/index': 'src/server/index.ts',
      'node/fastify/index': 'src/fastify/index.ts',
    },
    platform: 'neutral',
  }),
  deps: { neverBundle: [/^node:/] },
  outDir: 'dist',
};

export default config;
