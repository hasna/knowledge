/**
 * @hasna/knowledge
 * Copyright 2026 Hasna Inc.
 * Licensed under the Apache License, Version 2.0
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  files: string[];
};

const publicDocs = [
  'docs/architecture/ai-native-knowledge-base.md',
  'docs/architecture/hosted-wrapper-responsibilities.md',
  'docs/architecture/hybrid-semantic-search.md',
  'docs/architecture/machine-sync-schema.md',
  'docs/examples/app-project-wiki-standard.md',
  'docs/examples/company-wiki-workflow.md',
  'docs/migration/global-rules-provenance-import.md',
  'docs/migration/json-to-sqlite.md',
].sort();

const publicScripts = [
  'scripts/apply-cloud-migrations.mjs',
  // Imported by scripts/smoke-machine-sync-release.mjs, so it must ship with it or the
  // published script fails to resolve at runtime.
  'scripts/lib/remote-temp-dir.mjs',
  'scripts/smoke-machine-sync-release.mjs',
  'scripts/smoke-machines-adapter.mjs',
  'scripts/smoke-open-files-installed-boundary.mjs',
  'scripts/strip-generated-trailing-whitespace.mjs',
  'scripts/verify-generated-artifacts.mjs',
].sort();

const forbiddenPackagePaths = [
  'docs/canonical-secrets-bootstrap-2026-06-08.md',
  'scripts/validate-public-package.mjs',
].sort();

describe('public package release safety', () => {
  // Pre-existing breakage, each verified against a packed tarball and tracked in todos.
  // Every entry must be removed by its task; removing one and not the others leaves the
  // published script still throwing, so they are listed individually.
  const knownUnresolvedImports = new Set([
    // task 1eb481d5 - src/ is not in `files`
    'scripts/apply-cloud-migrations.mjs -> ../src/storage.ts',
    // task 1eb481d5 - @hasna/contracts is a devDependency only
    'scripts/apply-cloud-migrations.mjs -> @hasna/contracts/auth',
    // task 104f993d - bun:sqlite throws ERR_UNSUPPORTED_ESM_URL_SCHEME under node
    'scripts/smoke-open-files-installed-boundary.mjs -> bun:sqlite',
  ]);

  test('package files list public docs explicitly', () => {
    expect(packageJson.files).not.toContain('docs');
    expect(packageJson.files).not.toContain('docs/*');
    expect(packageJson.files).not.toContain('docs/**');
    expect(packageJson.files).not.toContain('scripts');
    expect(packageJson.files).not.toContain('scripts/*');
    expect(packageJson.files).not.toContain('scripts/**');

    for (const doc of publicDocs) {
      expect(packageJson.files).toContain(doc);
    }

    for (const script of publicScripts) {
      expect(packageJson.files).toContain(script);
    }

    for (const path of forbiddenPackagePaths) {
      expect(packageJson.files).not.toContain(path);
    }
  });

  /**
   * Imports of a published script that would NOT resolve for someone who installed the
   * package. Returns the offending specifiers, so both the enforcement test and the tests
   * that pin it call THIS function - if it stops reporting, both fail.
   *
   * That structure is the point. Three previous versions of this check could each be replaced
   * with something that reports nothing while the whole suite stayed green, because the tests
   * that were supposed to pin them exercised a private copy of the logic instead of the logic
   * itself. Silent-green was the defect; moving the implementation never fixed it.
   *
   * Imports are extracted with the real transpiler, NOT by stripping comments and matching a
   * regex. Two hand-written strippers were tried and both had the same defect: a `/*` inside
   * an ordinary string opened a phantom comment and silently deleted real imports. The second
   * only moved the trigger - a regex literal containing a quote (`/['"]/`) shifted it into
   * string state and everything after it vanished. Extracting imports is a parsing problem;
   * anything short of a parser is a guess that fails silently.
   */
  function unresolvableImportsIn(script: string, source: string): string[] {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const runtimeDeps = new Set(Object.keys(
      (packageJson as unknown as { dependencies?: Record<string, string> }).dependencies ?? {},
    ));

    /**
     * Only `node:`-prefixed builtins are unconditionally resolvable.
     *
     * Deliberately NOT allowed, each verified against this repo rather than assumed:
     *  - unprefixed builtins. `builtinModules` under `bun test` is BUN's list, which contains
     *    `ws`, `undici` and `bun` - real npm package names that are NOT Node builtins, so a
     *    published script importing `ws` would pass here and throw for every node installer.
     *  - the package's own name. No published script imports it; that allowance existed only
     *    to mask a phantom the old regex stripper invented from a template literal, which a
     *    real parser does not report at all.
     *  - `#`-prefixed subpaths. package.json has no `imports` map, so every one is guaranteed
     *    to fail with ERR_PACKAGE_IMPORT_NOT_DEFINED.
     *  - `bun:` builtins. They resolve under Bun and throw ERR_UNSUPPORTED_ESM_URL_SCHEME
     *    under node, so they are exempted by name below, never blessed as a class.
     */
    const isAlwaysResolvable = (specifier: string): boolean => specifier.startsWith('node:');

    const unresolvable: string[] = [];
    for (const { path: specifier } of transpiler.scan(source).imports) {
      if (knownUnresolvedImports.has(`${script} -> ${specifier}`)) continue;
      if (isAlwaysResolvable(specifier)) continue;

      if (specifier.startsWith('.')) {
        const resolved = posix.normalize(posix.join(posix.dirname(script), specifier));
        if (!publicScripts.includes(resolved)) unresolvable.push(specifier);
        continue;
      }

      const pkg = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (!runtimeDeps.has(pkg)) unresolvable.push(specifier);
    }
    return unresolvable;
  }

  /**
   * A published script that imports something the package does not ship resolves fine in the
   * repo and throws ERR_MODULE_NOT_FOUND for everyone who installs it. The allowlists above
   * only catch the opposite mistake (shipping something unreviewed), so this closes the gap.
   */
  test('every import in a published script resolves from the published package', () => {
    for (const script of publicScripts) {
      const source = readFileSync(join(repoRoot, script), 'utf8');
      expect(unresolvableImportsIn(script, source), `unresolvable imports in ${script}`).toEqual([]);
    }
  });

  /**
   * Pins the function above against the mutation that kept slipping through: every previous
   * version could be replaced with something that reports nothing while the suite stayed
   * green. Each case below drives the REAL function, so disabling the extractor, widening the
   * exemptions, or making everything "always resolvable" fails here.
   */
  test('the published-import check reports real breakage, in every shape', () => {
    const check = (source: string) => unresolvableImportsIn('scripts/probe.mjs', source);

    // The two shapes that defeated both hand-written strippers.
    expect(check(`const g = '**/*.ts';\nimport bad from 'ghost-a';`)).toContain('ghost-a');
    expect(check(`const q = /['"]/g;\nconst g = '**/*.json';\nconst m = import('ghost-b');`)).toContain('ghost-b');
    expect(check(`const re = /[a\\/*]/;\nimport bad from 'ghost-c';`)).toContain('ghost-c');
    // Every import form the check claims to cover.
    expect(check(`import './not-shipped.mjs';`)).toContain('./not-shipped.mjs');
    expect(check(`export { a } from './not-shipped2.mjs';`)).toContain('./not-shipped2.mjs');
    expect(check(`export * from './not-shipped3.mjs';`)).toContain('./not-shipped3.mjs');
    expect(check(`const m = await import('ghost-d');`)).toContain('ghost-d');
    // The allowances are exactly as narrow as documented.
    expect(check(`import x from 'ws';`)).toContain('ws');
    expect(check(`import x from 'undici';`)).toContain('undici');
    expect(check(`import x from '#internal/x.js';`)).toContain('#internal/x.js');
    expect(check(`import x from '@hasna/knowledge/not-in-exports';`)).toContain('@hasna/knowledge/not-in-exports');
    expect(check(`import { Database } from 'bun:sqlite';`)).toContain('bun:sqlite');

    // ...and legitimate code is not reported, or the check false-positives and gets widened.
    expect(check(`import { readFileSync } from 'node:fs';`)).toEqual([]);
    expect(check(`import { z } from 'zod';`)).toEqual([]);
    expect(check(`// import dead from 'ghost-e';`)).toEqual([]);
    expect(check(`/* import dead from 'ghost-f'; */`)).toEqual([]);
    expect(check(`const s = "import x from 'ghost-g'";`)).toEqual([]);
    // A child script emitted as a template literal is data, not an import of this file.
    expect(check("const child = `import { k } from '@hasna/knowledge';`;")).toEqual([]);
  });

  test('the exemptions stay narrow, and each names real breakage', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const importsOf = (script: string) =>
      transpiler.scan(readFileSync(join(repoRoot, script), 'utf8')).imports.map((i) => i.path);

    // Each exempted import must still exist; a stale exemption invites the next one to be
    // added without evidence.
    expect(importsOf('scripts/apply-cloud-migrations.mjs')).toContain('../src/storage.ts');
    expect(importsOf('scripts/apply-cloud-migrations.mjs')).toContain('@hasna/contracts/auth');
    expect(importsOf('scripts/smoke-open-files-installed-boundary.mjs')).toContain('bun:sqlite');

    // ...and each is genuinely unresolvable, not merely unfamiliar.
    expect(packageJson.files).not.toContain('src');
    const deps = (packageJson as unknown as { dependencies?: Record<string, string> }).dependencies ?? {};
    expect(Object.keys(deps)).not.toContain('@hasna/contracts');

    // Removing an exemption must make the check report it again.
    for (const [script, specifier] of [
      ['scripts/apply-cloud-migrations.mjs', '../src/storage.ts'],
      ['scripts/apply-cloud-migrations.mjs', '@hasna/contracts/auth'],
      ['scripts/smoke-open-files-installed-boundary.mjs', 'bun:sqlite'],
    ] as const) {
      const key = `${script} -> ${specifier}`;
      knownUnresolvedImports.delete(key);
      try {
        expect(unresolvableImportsIn(script, readFileSync(join(repoRoot, script), 'utf8')))
          .toContain(specifier);
      } finally {
        knownUnresolvedImports.add(key);
      }
    }
  });

  test('npm pack dry-run includes only public docs', () => {
    const result = spawnSync('node', ['scripts/validate-public-package.mjs', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });

    if (result.status !== 0) {
      throw new Error(`public package validation failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }

    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      docsFiles: string[];
      scriptsFiles: string[];
      forbiddenPackagePaths: string[];
    };

    expect(summary.ok).toBe(true);
    expect(summary.docsFiles).toEqual(publicDocs);
    expect(summary.scriptsFiles).toEqual(publicScripts);
    expect(summary.forbiddenPackagePaths).toEqual(forbiddenPackagePaths);
    for (const path of forbiddenPackagePaths) {
      expect(summary.docsFiles).not.toContain(path);
      expect(summary.scriptsFiles).not.toContain(path);
    }
  });
});
