import { describe, expect, it } from 'vitest';
import { inspectBrowserBundle, ownedPath, validatePackReport } from './consumerChecks.mjs';

const entries = [
  'browser/index',
  'browser/client/index',
  'node/server/index',
  'node/fastify/index',
];
function report(extra: string[] = []) {
  return [
    {
      name: '@integr8-media/ws-rpc',
      filename: 'integr8-media-ws-rpc-0.0.0.tgz',
      files: [
        ...entries.flatMap((entry) => [`dist/${entry}.mjs`, `dist/${entry}.d.mts`]),
        ...extra,
      ].map((path) => ({ path })),
    },
  ];
}
describe('clean consumer evidence boundaries', () => {
  it('requires the actual public artifact entries and rejects leaked source/maps', () => {
    expect(() => validatePackReport(report(['README.md', 'package.json']))).not.toThrow();
    for (const path of [
      'src/client.ts',
      'dist/client.mjs.map',
      'dist/private.test.mjs',
      '../escape',
    ]) {
      expect(() => validatePackReport(report([path]))).toThrow();
    }
    expect(() => validatePackReport([])).toThrow();
  });
  it('rejects an escaped consumer work directory', () => {
    expect(() => ownedPath(process.cwd(), '..', 'elsewhere')).toThrow();
    expect(ownedPath(process.cwd(), 'fixtures', 'run')).toContain('fixtures');
  });
  it('audits dynamic chunks and rejects server modules even when the entry looks safe', () => {
    const chunk = {
      type: 'chunk',
      modules: { '/client.js': {} },
      imports: [],
      dynamicImports: ['lazy.js'],
    };
    const bad = {
      type: 'chunk',
      modules: { '/node_modules/ws/index.js': {} },
      imports: [],
      dynamicImports: [],
    };
    expect(() => inspectBrowserBundle({ 'entry.js': chunk, 'lazy.js': bad })).toThrow(
      'Forbidden browser module',
    );
    expect(() => inspectBrowserBundle({ 'entry.js': chunk })).toThrow(
      'Unbundled browser dependency',
    );
  });
});
