/**
 * Packed-package consumer verification.
 *
 * Importing from `dist/` proves that the compiler emitted something. It does
 * not prove that the *published* package is usable: `files`, `exports`,
 * `types`, and `type` can each be wrong in a way that only a real install
 * reveals. So this packs the tarball, installs it into a scratch project, and
 * uses it the way a consumer would — from plain JavaScript at runtime, and from
 * TypeScript through `tsc`.
 *
 *   node scripts/verify-package.mjs [directory containing an already-built .tgz]
 *
 * With no argument it packs the repository itself. The scratch project is
 * removed on the way out, including on failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Files that must never reach a consumer, as `npm pack` path prefixes. */
const FORBIDDEN = ['test/', 'examples/', '.github/', 'coverage/', 'scripts/', '.env'];

let step = 0;
const log = (message) => console.log(`\n[${++step}] ${message}`);
const ok = (message) => console.log(`    ok — ${message}`);

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const workspace = mkdtempSync(join(tmpdir(), 'fetch-auth-refresh-verify-'));

try {
  // ---------------------------------------------------------------- pack ---
  let tarballDir = process.argv[2];
  if (tarballDir === undefined) {
    log('npm pack');
    tarballDir = join(workspace, 'tarball');
    mkdirSync(tarballDir);
    run(npm, ['pack', '--pack-destination', tarballDir], repo);
  } else {
    log(`using the tarball already in ${tarballDir}`);
  }

  const tarballs = readdirSync(tarballDir).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one .tgz in ${tarballDir}, found ${tarballs.length}`);
  }
  const tarball = join(tarballDir, tarballs[0]);
  ok(tarballs[0]);

  // ------------------------------------------------------------- contents ---
  log('inspecting tarball contents');
  // `--ignore-scripts`: `dist/` is already built by the pack above, and letting
  // `prepack` run again would print build output ahead of the JSON.
  const contents = JSON.parse(
    run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], repo),
  )[0];
  const entries = contents.files.map((file) => file.path).sort();
  console.log(entries.map((path) => `    ${path}`).join('\n'));

  const leaked = entries.filter((path) =>
    FORBIDDEN.some((prefix) => path === prefix || path.startsWith(prefix)),
  );
  if (leaked.length > 0) {
    throw new Error(`private files in the tarball: ${leaked.join(', ')}`);
  }
  for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) {
    if (!entries.includes(required)) throw new Error(`missing from the tarball: ${required}`);
  }
  ok(`${entries.length} files, nothing private`);

  // Every path an `exports` condition points at must actually be shipped,
  // otherwise the failure surfaces as an unresolvable import at install time.
  log('checking that every exports target is shipped');
  const manifest = JSON.parse(run(npm, ['pkg', 'get'], repo));
  const targets = new Set();
  const collect = (value) => {
    if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(manifest.exports);
  collect(manifest.types);
  collect(manifest.main);
  for (const target of targets) {
    if (!entries.includes(target)) throw new Error(`exports/types/main points at unshipped ${target}`);
  }
  ok([...targets].join(', '));

  // ----------------------------------------------------------- install ---
  log('installing the tarball into a scratch consumer project');
  const consumer = join(workspace, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, version: '1.0.0', type: 'module' }, null, 2),
  );
  run(npm, ['install', tarball, '@types/node', '--no-audit', '--no-fund', '--loglevel', 'error'], consumer);
  ok('installed');

  // --------------------------------------------------------- runtime (JS) ---
  log('importing and exercising the package from plain JavaScript');
  writeFileSync(
    join(consumer, 'use.mjs'),
    `import assert from 'node:assert/strict';
import { createAuthFetch } from 'fetch-auth-refresh';

assert.equal(typeof createAuthFetch, 'function');

let refreshes = 0;
const seen = [];

// A stand-in transport: 401 for anything but the refreshed token.
const transport = async (request) => {
  seen.push(request.headers.get('authorization'));
  return request.headers.get('authorization') === 'Bearer fresh'
    ? new Response('ok', { status: 200 })
    : new Response('no', { status: 401 });
};

const authFetch = createAuthFetch({
  getToken: () => 'stale',
  refreshToken: async () => {
    refreshes += 1;
    return 'fresh';
  },
  fetch: transport,
});

// Twenty concurrent failures must produce exactly one refresh and twenty retries.
const responses = await Promise.all(
  Array.from({ length: 20 }, (_, i) => authFetch('https://api.test/r' + i)),
);

assert.ok(responses.every((response) => response.status === 200), 'every request should succeed');
assert.equal(refreshes, 1, 'expected exactly one refresh, got ' + refreshes);
assert.equal(seen.length, 40, 'expected 20 attempts plus 20 retries');
assert.equal(await responses[0].text(), 'ok', 'the response body must be unconsumed');

console.log('    ok — 20 requests, 1 refresh, 20 retries, body readable');
`,
  );
  console.log(run(process.execPath, ['use.mjs'], consumer).trimEnd());

  // -------------------------------------------------------- types (tsc) ---
  // Two consumer shapes, because the declarations reference Fetch types that
  // reach a project either through the DOM lib or through @types/node.
  const source = `import { createAuthFetch } from 'fetch-auth-refresh';
import type {
  AccessToken,
  AuthFailureContext,
  AuthFetch,
  AuthFetchOptions,
  FetchLike,
  RefreshContext,
} from 'fetch-auth-refresh';

let token: AccessToken | null = null;

const options: AuthFetchOptions = {
  getToken: () => token,
  refreshToken: async (context: RefreshContext): Promise<AccessToken> => {
    void context.rejectedToken;
    void context.request.url;
    void (await context.response.text());
    token = 'fresh';
    return token;
  },
  isAuthFailure: (response: Response, request: Request) =>
    response.status === 401 && request.method === 'GET',
  attachToken: (request: Request, value: AccessToken) => {
    request.headers.set('X-Api-Key', value);
    return request;
  },
  onAuthFailure: (context: AuthFailureContext) => {
    void context.response.status;
    token = null;
  },
};

// The returned function must be assignable to a bare fetch signature.
const authFetch: AuthFetch = createAuthFetch(options);
const transport: FetchLike = authFetch;

export async function main(): Promise<number> {
  const response = await transport('https://api.test/me');
  return response.status;
}
`;

  for (const [label, compilerOptions] of [
    ['DOM lib', { lib: ['ES2023', 'DOM', 'DOM.Iterable'], types: [] }],
    ['@types/node, no DOM lib', { lib: ['ES2023'], types: ['node'] }],
  ]) {
    log(`typechecking a consumer (${label})`);
    const dir = join(consumer, `ts-${label.replace(/\W+/g, '-')}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'use.ts'), source);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
            ...compilerOptions,
          },
          include: ['use.ts'],
        },
        null,
        2,
      ),
    );
    // The repository's own tsc, resolving types from the consumer's node_modules.
    run(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', dir], consumer);
    ok('tsc clean');
  }

  console.log('\nPacked-package consumer verification passed.');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
