import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { inspectBrowserBundle, ownedPath, validatePackReport } from './consumerChecks.mjs';

// Developer-run command: intentionally packs/installs into isolated generated directories.
// It does not build, select a version, modify the root manifest/lockfile, or publish.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert(
  typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version),
  'Set the developer-selected initial package version before packed consumer checks.',
);
const npmCli = process.env.npm_execpath;
assert(npmCli && /npm-cli\.js$/i.test(npmCli), 'Run through npm run check:consumers.');
const artifacts = ownedPath(root, 'fixtures', '.artifacts');
await mkdir(artifacts, { recursive: true });
const recordDirectory = await mkdtemp(ownedPath(artifacts, 'consumer-'));
// Outside this repository: missing consumer dependencies must not fall back to root node_modules.
const workspace = await mkdtemp(join(tmpdir(), 'integr8-ws-rpc-consumer-'));
const commands = [];
async function run(program, args, cwd, capture = false) {
  commands.push({ program: program === process.execPath ? 'node' : program, args, cwd });
  const child = spawn(program, args, {
    cwd,
    shell: false,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  let output = '';
  if (capture)
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Consumer command failed.')),
    );
  });
  return output;
}
const packed = validatePackReport(
  JSON.parse(
    await run(
      process.execPath,
      [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', recordDirectory],
      root,
      true,
    ),
  ),
);
const artifact = ownedPath(recordDirectory, packed.filename);
const sha256 = createHash('sha256')
  .update(await readFile(artifact))
  .digest('hex');
const evidence = {
  status: 'incomplete',
  artifact,
  workspace,
  sha256,
  version: manifest.version,
  node: process.version,
  startedAt: new Date().toISOString(),
  commands,
  consumers: {},
};
const evidencePath = ownedPath(recordDirectory, 'evidence.json');
try {
  for (const kind of ['noPeers', 'node', 'browser', 'react']) {
    const directory = ownedPath(workspace, kind);
    await mkdir(directory);
    const dependencyNames =
      kind === 'noPeers'
        ? []
        : [
            '@orpc/client',
            '@orpc/server',
            'zod',
            ...(kind === 'node' ? ['fastify'] : []),
            ...(kind === 'react' ? ['react', 'react-dom', '@tanstack/react-query'] : []),
          ];
    const dependencies = Object.fromEntries(
      dependencyNames.map((name) => [
        name,
        manifest.dependencies[name] ?? manifest.devDependencies[name],
      ]),
    );
    dependencies[manifest.name] = `file:${artifact.replaceAll('\\', '/')}`;
    const devDependencies = {
      typescript: manifest.devDependencies.typescript,
      ...(kind === 'node'
        ? { '@types/node': manifest.devDependencies['@types/node'] }
        : kind === 'noPeers'
          ? {}
          : { vite: manifest.devDependencies.vite }),
      ...(kind === 'react'
        ? {
            '@types/react': manifest.devDependencies['@types/react'],
            '@types/react-dom': manifest.devDependencies['@types/react-dom'],
            '@types/node': manifest.devDependencies['@types/node'],
          }
        : {}),
    };
    await writeFile(
      ownedPath(directory, 'package.json'),
      JSON.stringify(
        {
          name: `ws-rpc-${kind}-consumer`,
          private: true,
          type: 'module',
          dependencies,
          devDependencies,
        },
        null,
        2,
      ),
    );
    if (kind !== 'noPeers') {
      await copyFile(ownedPath(root, 'playground', 'router.ts'), ownedPath(directory, 'router.ts'));
      await copyFile(
        ownedPath(root, 'playground', 'offlineClient.ts'),
        ownedPath(directory, 'offlineClient.ts'),
      );
      await copyFile(
        ownedPath(root, 'fixtures', 'consumers', 'assertTypes.ts'),
        ownedPath(directory, 'assertTypes.ts'),
      );
    }
    await copyFile(
      kind === 'react'
        ? ownedPath(root, 'playground', 'react', 'main.ts')
        : ownedPath(
            root,
            'fixtures',
            'consumers',
            kind === 'node' ? 'node.mts' : kind === 'noPeers' ? 'noPeers.mts' : 'browser.ts',
          ),
      ownedPath(directory, kind === 'node' || kind === 'noPeers' ? 'main.mts' : 'main.ts'),
    );
    if (kind === 'react') {
      for (const name of ['assertReactTypes.ts', 'reactSsr.mts']) {
        await copyFile(ownedPath(root, 'fixtures', 'consumers', name), ownedPath(directory, name));
      }
    }
    if (kind === 'browser') {
      await copyFile(
        ownedPath(root, 'fixtures', 'expo', 'runDevice.ts'),
        ownedPath(directory, 'runDevice.ts'),
      );
    }
    if (kind === 'browser' || kind === 'react')
      await writeFile(
        ownedPath(directory, 'index.html'),
        '<!doctype html><html lang="en"><title>Packed consumer</title><body><div id="root"></div><script type="module" src="/main.ts"></script></body></html>',
      );
    await writeFile(
      ownedPath(directory, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2024',
            module:
              kind === 'node' || kind === 'noPeers' || kind === 'react' ? 'NodeNext' : 'ESNext',
            moduleResolution:
              kind === 'node' || kind === 'noPeers' || kind === 'react' ? 'NodeNext' : 'Bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            verbatimModuleSyntax: true,
            allowImportingTsExtensions: true,
            lib: ['ES2024', 'DOM', 'DOM.Iterable'],
            types: kind === 'node' || kind === 'react' ? ['node'] : [],
          },
          include: ['*.ts', '*.mts'],
        },
        null,
        2,
      ),
    );
    await run(
      process.execPath,
      [
        npmCli,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        // Vite sets NODE_ENV=production in this process; later installs still need dev tools.
        '--include=dev',
        // Browser builds require Rolldown's optional native binding.
        ...(kind === 'noPeers' || kind === 'node' ? ['--omit=optional'] : ['--include=optional']),
      ],
      directory,
    );
    const require = createRequire(ownedPath(directory, 'package.json'));
    const installed = `${ownedPath(directory, 'node_modules')}${sep}`;
    for (const name of Object.keys(dependencies)) {
      assert(
        require.resolve(name).startsWith(installed),
        `Consumer dependency resolved outside its install: ${name}`,
      );
    }
    if (kind !== 'react') {
      for (const name of [
        'react',
        'react-dom',
        '@tanstack/react-query',
        '@types/react/package.json',
      ]) {
        assert.throws(
          () => require.resolve(name),
          `Optional React peer unexpectedly installed: ${name}`,
        );
      }
    }
    await run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit'], directory);
    await copyFile(
      ownedPath(directory, 'package.json'),
      ownedPath(recordDirectory, `${kind}-package.json`),
    );
    await copyFile(
      ownedPath(directory, 'package-lock.json'),
      ownedPath(recordDirectory, `${kind}-package-lock.json`),
    );
    const lockSha256 = createHash('sha256')
      .update(await readFile(ownedPath(directory, 'package-lock.json')))
      .digest('hex');
    evidence.consumers[kind] = { lockSha256 };
    if (kind === 'node' || kind === 'noPeers') await run(process.execPath, ['main.mts'], directory);
    else {
      if (kind === 'react') await run(process.execPath, ['reactSsr.mts'], directory);
      const { build } = await import(pathToFileURL(require.resolve('vite')).href);
      let graph;
      let gzipBytes = 0;
      await build({
        root: directory,
        configFile: false,
        build: { sourcemap: false },
        plugins: [
          {
            name: 'ws-rpc-browser-boundary',
            generateBundle(_options, bundle) {
              graph = inspectBrowserBundle(bundle, kind === 'react');
              for (const output of Object.values(bundle)) {
                if (output.type === 'chunk') gzipBytes += gzipSync(output.code).byteLength;
              }
              // Initial complete JS consumer budget; dependency costs are included, not treated as zero.
              assert(
                gzipBytes <= (kind === 'react' ? 300 : 150) * 1024,
                `Packed ${kind} JS exceeds its ${kind === 'react' ? 300 : 150} KiB gzip fixture budget.`,
              );
            },
          },
        ],
      });
      assert(graph?.length, 'Browser graph hook did not execute.');
      assert(
        graph.some((id) => id.includes('/node_modules/@integr8-media/ws-rpc/')),
        'Browser consumer did not include the installed artifact.',
      );
      evidence.consumers[kind] = { lockSha256, graph, gzipBytes };
      await cp(ownedPath(directory, 'dist'), ownedPath(recordDirectory, `${kind}-dist`), {
        recursive: true,
      });
    }
  }
  evidence.status = 'passed';
} finally {
  await writeFile(
    evidencePath,
    JSON.stringify({ ...evidence, finishedAt: new Date().toISOString() }, null, 2),
  );
  process.stdout.write(
    `Packed artifact/evidence retained at ${recordDirectory}\nConsumer work directories retained at ${workspace}\n`,
  );
}
