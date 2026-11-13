import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectPackage } from './packageChecks.mjs';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(extra: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ws-rpc-package-'));
  directories.push(directory);
  const exports = Object.fromEntries(
    ['.', './client', './server', './fastify', './react'].map((entry) => {
      const name = entry === '.' ? 'index' : entry.slice(2);
      return [entry, { types: `./dist/${name}.d.mts`, default: `./dist/${name}.mjs` }];
    }),
  );
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ files: ['dist'], exports }),
    ...Object.fromEntries(
      ['index', 'client', 'server', 'fastify', 'react'].flatMap((entry) => [
        [`dist/${entry}.mjs`, entry === 'react' ? "'use client'; export {};" : 'export {};'],
        [`dist/${entry}.d.mts`, 'export {};'],
      ]),
    ),
    ...extra,
  };
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(directory, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, contents);
  }
  return directory;
}

describe('M0 package boundary inspection', () => {
  it('accepts the five entry paths when source and private modules stay out of dist', async () => {
    await expect(inspectPackage(await fixture())).resolves.toHaveLength(2);
  });

  it('requires the optional React client directive without allowing peers into the base client', async () => {
    await expect(inspectPackage(await fixture({ 'dist/react.mjs': 'export {};' }))).rejects.toThrow(
      'use client',
    );
    await expect(
      inspectPackage(
        await fixture({
          'dist/client.mjs': "export { useState } from 'react';",
        }),
      ),
    ).rejects.toThrow('external runtime import');
  });

  it('follows relative chunks before checking browser import isolation', async () => {
    const directory = await fixture({
      'dist/client.mjs': "export { value } from './shared.mjs';",
      'dist/shared.mjs': "import fs from 'node:fs'; export const value = fs;",
    });
    await expect(inspectPackage(directory)).rejects.toThrow('external runtime import');
  });

  it('inspects allowed external packages rather than trusting their names', async () => {
    const directory = await fixture({
      'dist/client.mjs': "export { value } from '@orpc/client';",
      'node_modules/@orpc/client/package.json': JSON.stringify({
        name: '@orpc/client',
        exports: { '.': { import: './index.mjs' } },
      }),
      'node_modules/@orpc/client/index.mjs': "export { value } from './hidden.mjs';",
      'node_modules/@orpc/client/hidden.mjs': "import fs from 'node:fs'; export const value = fs;",
    });
    await expect(inspectPackage(directory)).rejects.toThrow('external runtime import');
  });

  it('resolves import conditions instead of following a CommonJS require entry', async () => {
    const directory = await fixture({
      'dist/client.mjs': "export { value } from 'zod';",
      'node_modules/zod/package.json': JSON.stringify({
        name: 'zod',
        exports: {
          '.': { import: './index.js', require: './index.cjs' },
        },
      }),
      'node_modules/zod/index.js': 'export const value = 1;',
      'node_modules/zod/index.cjs': "require('node:fs');",
    });
    await expect(inspectPackage(directory)).resolves.toHaveLength(2);
  });

  it('rejects test artifacts and source maps even when no entry imports them', async () => {
    await expect(
      inspectPackage(await fixture({ 'dist/private.test.mjs': 'export {};' })),
    ).rejects.toThrow('Unpublishable');
    await expect(inspectPackage(await fixture({ 'dist/index.mjs.map': '{}' }))).rejects.toThrow(
      'Unpublishable',
    );
    await expect(
      inspectPackage(await fixture({ 'dist/private.test.d.mts': 'export {};' })),
    ).rejects.toThrow('Unpublishable');
  });

  it('rejects computed imports whose browser safety is unknown', async () => {
    const directory = await fixture({ 'dist/client.mjs': 'export const load = (x) => import(x);' });
    await expect(inspectPackage(directory)).rejects.toThrow('Computed import');
  });

  it('requires actual declaration files for every declared subpath', async () => {
    const directory = await fixture();
    await rm(join(directory, 'dist/fastify.d.mts'));
    await expect(inspectPackage(directory)).rejects.toThrow();
  });
});
