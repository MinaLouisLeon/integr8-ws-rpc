import assert from 'node:assert/strict';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Fail closed when npm's pack report contains source, fixtures or unexpected artifact paths. */
export function validatePackReport(reports) {
  assert(Array.isArray(reports) && reports.length === 1, 'Expected exactly one packed artifact.');
  const report = reports[0];
  assert(report?.name === '@integr8-media/ws-rpc', 'Packed package identity mismatch.');
  assert(
    typeof report.filename === 'string' && /^[\w.-]+\.tgz$/.test(report.filename),
    'Unsafe packed artifact filename.',
  );
  assert(Array.isArray(report.files) && report.files.length > 0, 'Missing pack file inventory.');
  const files = report.files.map((file) => file.path);
  for (const name of files) {
    assert(
      typeof name === 'string' && !name.includes('..') && !name.includes('\\'),
      'Unsafe packed path.',
    );
    if (/^(?:package\.json|readme(?:\.md)?|changelog(?:\.md)?|licen[cs]e(?:\.md)?)$/i.test(name))
      continue;
    assert(
      name.startsWith('dist/') && /\.(?:mjs|d\.mts)$/.test(name),
      `Unexpected packed file: ${name}`,
    );
    assert(
      !/(?:^|\/)(?:testing|fixtures|playground)\/|\.(?:test|spec)\./.test(name),
      `Private packed file: ${name}`,
    );
  }
  for (const entry of [
    'browser/index',
    'browser/client/index',
    'node/server/index',
    'node/fastify/index',
  ]) {
    assert(
      files.includes(`dist/${entry}.mjs`) && files.includes(`dist/${entry}.d.mts`),
      `Missing packed entry: ${entry}`,
    );
  }
  return report;
}

/** Keep every generated consumer directory inside the caller's explicitly owned work area. */
export function ownedPath(root, ...segments) {
  const target = resolve(root, ...segments);
  const child = relative(resolve(root), target);
  assert(
    child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child),
    'Consumer path escaped its work directory.',
  );
  return target;
}

/** Audit real bundle module IDs and unresolved imports, including dynamically imported chunks. */
export function inspectBrowserBundle(bundle) {
  const modules = new Set();
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue;
    for (const id of Object.keys(output.modules)) {
      const normalized = id.replaceAll('\\', '/');
      assert(
        !normalized.includes('__vite-browser-external') &&
          !/(?:^|\/)node_modules\/(?:@orpc\/server|fastify|@fastify|ws|react|react-native|expo)(?:\/|$)/.test(
            normalized,
          ) &&
          !normalized.startsWith('node:'),
        `Forbidden browser module: ${normalized}`,
      );
      modules.add(normalized);
    }
    for (const dependency of [...output.imports, ...output.dynamicImports]) {
      assert(Object.hasOwn(bundle, dependency), `Unbundled browser dependency: ${dependency}`);
    }
  }
  assert(modules.size > 0, 'Empty browser graph is not consumer evidence.');
  return [...modules].sort();
}
