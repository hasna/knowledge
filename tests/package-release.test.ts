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
   * A published script that imports something the package does not ship resolves fine in the
   * repo and throws ERR_MODULE_NOT_FOUND for everyone who installs it. The allowlists above
   * only catch the opposite mistake (shipping something unreviewed), so this closes the gap.
   *
   * Both directions are checked, because a published script can fail to resolve two ways:
   * a relative import of a file outside `files`, or a bare import of a package that is not a
   * runtime dependency. Checking only relative imports would let this test go green while the
   * packed script is still broken.
   */
  test('every import in a published script resolves from the published package', () => {
    // Strip comments and template literals first: a commented-out import must not fail the
    // test, and a dynamic import with an interpolated path cannot be resolved statically.
    const strip = (source: string) => source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');

    // `from '...'`, bare `import '...'` (side-effect), and `import('...')`.
    const specifierPattern =
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+(?=['"]))['"]([^'"]+)['"]/g;

    const runtimeDeps = new Set(Object.keys(
      (packageJson as unknown as { dependencies?: Record<string, string> }).dependencies ?? {},
    ));

    // Pre-existing breakage, tracked as todos task 1eb481d5. This script has TWO unresolvable
    // imports, not one: `../src/storage.ts` (src/ is not in `files`) and `@hasna/contracts/auth`
    // (a devDependency only). Both are exempted by name so the rule is not weakened, and
    // BOTH must be removed for that task to be genuinely done -- deleting only the first
    // would leave the published script still throwing.
    const knownUnresolvedImports = new Set([
      'scripts/apply-cloud-migrations.mjs -> ../src/storage.ts',
      'scripts/apply-cloud-migrations.mjs -> @hasna/contracts/auth',
    ]);

    for (const script of publicScripts) {
      const source = strip(readFileSync(join(repoRoot, script), 'utf8'));
      for (const [, specifier] of source.matchAll(specifierPattern)) {
        if (knownUnresolvedImports.has(`${script} -> ${specifier}`)) continue;
        // Runtime builtins ship with the runtime, not with the package.
        if (specifier.startsWith('node:') || specifier.startsWith('bun:')) continue;

        if (specifier.startsWith('.')) {
          const resolved = posix.normalize(posix.join(posix.dirname(script), specifier));
          expect(publicScripts, `${script} imports ${specifier}, which is not in the published files list`)
            .toContain(resolved);
          continue;
        }

        // Bare specifier: must be a runtime dependency, not a devDependency.
        const pkg = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        expect(runtimeDeps, `${script} imports ${specifier}, which is not a runtime dependency`)
          .toContain(pkg);
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
