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
      'react/index': 'src/react/index.ts',
    },
    platform: 'neutral',
  }),
  deps: { neverBundle: [/^node:/, /^react(?:\/|$)/, /^@tanstack\//] },
  banner: ({ fileName }) =>
    /(?:^|\/)react\/index\.mjs$/.test(fileName.replaceAll('\\', '/'))
      ? { js: "'use client';" }
      : undefined,
  inputOptions: {
    onLog(level, log, defaultHandler) {
      // Rolldown may drop source directives; the React entry banner preserves this exact one.
      if (
        log.code === 'MODULE_LEVEL_DIRECTIVE' &&
        log.message.includes('use client') &&
        log.id?.replaceAll('\\', '/').endsWith('/src/react/index.ts')
      )
        return;
      defaultHandler(level, log);
    },
  },
  outDir: 'dist',
};

export default config;
