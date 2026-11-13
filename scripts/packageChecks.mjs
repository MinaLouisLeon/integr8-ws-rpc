import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/** Inspect outputs and the installed browser runtime graph without executing dependencies. */
export async function inspectPackage(rootDirectory) {
  const root = resolve(rootDirectory);
  const dist = resolve(root, 'dist');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.deepEqual(
    manifest.files,
    ['dist'],
    'Only dist may be explicitly included for publication.',
  );
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    '.',
    './client',
    './fastify',
    './server',
  ]);
  const files = await listFiles(dist);
  for (const path of files) {
    const name = relative(dist, path);
    assert(
      !/(?:^|[/\\])(?:testing|fixtures|playground)(?:[/\\]|$)/.test(name),
      `Unpublishable: ${name}`,
    );
    assert(!/\.(?:test|spec)\./.test(name), `Unpublishable: ${name}`);
    assert(name.endsWith('.mjs') || name.endsWith('.d.mts'), `Unpublishable: ${name}`);
  }
  for (const conditions of Object.values(manifest.exports)) {
    for (const path of [conditions.types, conditions.default]) {
      const absolute = resolve(root, path);
      assert(within(dist, absolute), 'Export must stay within dist.');
      await readFile(absolute);
    }
  }
  const entries = ['.', './client'].map((key) => resolve(root, manifest.exports[key].default));
  const visited = new Set();
  for (const entry of entries) {
    await inspectClientModule(entry, root, dist, visited);
  }
  return entries;
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assert(!entry.isSymbolicLink(), 'dist must not contain symlinks.');
    if (entry.isDirectory()) {
      result.push(...(await listFiles(path)));
    } else {
      result.push(path);
    }
  }
  return result;
}

function within(parent, path) {
  const child = relative(parent, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

const browserDependencies = new Set([
  '@orpc/client',
  '@orpc/shared',
  '@orpc/standard-server',
  '@orpc/standard-server-fetch',
  '@orpc/standard-server-peer',
  'zod',
  'radash', // Runtime re-exports of the approved @orpc/shared dependency.
]);

async function inspectClientModule(path, root, dist, visited) {
  assert(
    within(dist, path) || within(resolve(root, 'node_modules'), path),
    'Client import escaped dist/node_modules.',
  );
  if (visited.has(path)) {
    return;
  }
  visited.add(path);
  const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert(ts.isStringLiteral(node.moduleSpecifier), 'Computed import cannot be inspected.');
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      assert(argument && ts.isStringLiteral(argument), 'Computed import cannot be inspected.');
      imports.push(argument.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      assert.fail('CommonJS require cannot establish ESM browser isolation.');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const specifier of imports) {
    const target = specifier.startsWith('.')
      ? resolve(dirname(path), specifier)
      : await resolveBrowserDependency(specifier, path, root);
    await inspectClientModule(target, root, dist, visited);
  }
}

async function resolveBrowserDependency(specifier, importer, root) {
  const segments = specifier.split('/');
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  assert(browserDependencies.has(name), `Client external runtime import: ${specifier}`);
  const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  for (
    let directory = dirname(importer);
    directory === root || within(root, directory);
    directory = dirname(directory)
  ) {
    const packageRoot = resolve(directory, 'node_modules', name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    assert.equal(manifest.name, name, 'Dependency identity mismatch.');
    assert(!manifest.browser, 'Browser remapping needs a dedicated resolver/consumer audit.');
    const exports = manifest.exports;
    let target =
      subpath === '.' && exports && !Object.keys(exports).some((key) => key.startsWith('.'))
        ? exports
        : exports?.[subpath];
    if (target === undefined && exports && typeof exports === 'object') {
      for (const [pattern, candidate] of Object.entries(exports)) {
        const [prefix, suffix] = pattern.split('*');
        if (suffix !== undefined && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
          const match = subpath.slice(prefix.length, suffix.length ? -suffix.length : undefined);
          const selected = importTarget(candidate);
          target = selected.replaceAll('*', match);
          break;
        }
      }
    }
    const selected = importTarget(target);
    assert(selected.startsWith('./'), 'Dependency export must be package-relative.');
    const absolute = resolve(packageRoot, selected);
    assert(within(packageRoot, absolute), 'Dependency export escaped package.');
    return absolute;
  }
  assert.fail(`Installed browser dependency not found: ${specifier}`);
}

function importTarget(target) {
  if (typeof target === 'string') return target;
  assert(
    target && typeof target === 'object' && !Array.isArray(target),
    'Unsupported dependency export conditions.',
  );
  for (const [condition, value] of Object.entries(target)) {
    if (condition === 'import' || condition === 'default' || condition === 'browser') {
      return importTarget(value);
    }
  }
  assert.fail('No browser ESM dependency export.');
}
