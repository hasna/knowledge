import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  EXAMPLE_KNOWLEDGE_CANONICAL,
  HASNA_KNOWLEDGE_APP_PATH,
  LEGACY_HASNA_KNOWLEDGE_APP_PATH,
  canonicalExampleKnowledgeStorage,
  defaultKnowledgeConfig,
  ensureKnowledgeWorkspace,
  ensureParentDir,
  globalKnowledgeHome,
  legacyGlobalKnowledgeHome,
  legacyGlobalStorePath,
  legacyProjectKnowledgeHome,
  projectKnowledgeHome,
  readKnowledgeConfig,
  resolveLegacyScopedWorkspace,
  resolveScopedWorkspace,
  workspaceForHome,
  writeKnowledgeConfig,
} from '../src/workspace';

describe('workspace path resolution', () => {
  test('builds every workspace path beneath the supplied home', () => {
    const home = '/fixture/.hasna/knowledge';
    expect(workspaceForHome(home)).toEqual({
      home,
      configPath: join(home, 'config.json'),
      jsonStorePath: join(home, 'db.json'),
      knowledgeDbPath: join(home, 'knowledge.db'),
      artifactsDir: join(home, 'artifacts'),
      cacheDir: join(home, 'cache'),
      exportsDir: join(home, 'exports'),
      indexesDir: join(home, 'indexes'),
      logsDir: join(home, 'logs'),
      runsDir: join(home, 'runs'),
      schemasDir: join(home, 'schemas'),
      wikiDir: join(home, 'wiki'),
    });
  });

  test('resolves current and legacy global and project locations', () => {
    const cwd = '/fixture/project';
    expect(HASNA_KNOWLEDGE_APP_PATH).toBe(join('.hasna', 'knowledge'));
    expect(LEGACY_HASNA_KNOWLEDGE_APP_PATH).toBe(join('.hasna', 'apps', 'knowledge'));
    expect(globalKnowledgeHome()).toBe(join(homedir(), '.hasna', 'knowledge'));
    expect(legacyGlobalKnowledgeHome()).toBe(join(homedir(), '.hasna', 'apps', 'knowledge'));
    expect(legacyGlobalStorePath()).toBe(join(homedir(), '.open-knowledge', 'db.json'));
    expect(projectKnowledgeHome(cwd)).toBe(resolve(cwd, '.hasna', 'knowledge'));
    expect(legacyProjectKnowledgeHome(cwd)).toBe(resolve(cwd, '.hasna', 'apps', 'knowledge'));
  });

  test('treats project and local as project scopes and everything else as global', () => {
    const cwd = '/fixture/project';
    const currentProject = resolve(cwd, '.hasna', 'knowledge');
    const legacyProject = resolve(cwd, '.hasna', 'apps', 'knowledge');

    expect(resolveScopedWorkspace('project', cwd).home).toBe(currentProject);
    expect(resolveScopedWorkspace('local', cwd).home).toBe(currentProject);
    expect(resolveScopedWorkspace(undefined, cwd).home).toBe(globalKnowledgeHome());
    expect(resolveScopedWorkspace('unexpected', cwd).home).toBe(globalKnowledgeHome());
    expect(resolveLegacyScopedWorkspace('project', cwd).home).toBe(legacyProject);
    expect(resolveLegacyScopedWorkspace('local', cwd).home).toBe(legacyProject);
    expect(resolveLegacyScopedWorkspace(undefined, cwd).home).toBe(legacyGlobalKnowledgeHome());
    expect(resolveLegacyScopedWorkspace('unexpected', cwd).home).toBe(legacyGlobalKnowledgeHome());
  });
});

describe('workspace defaults and initialization', () => {
  test('returns the canonical S3 example without sharing mutable objects', () => {
    const first = canonicalExampleKnowledgeStorage();
    const second = canonicalExampleKnowledgeStorage();
    expect(first).toEqual({
      type: 's3',
      artifacts_root: 'artifacts',
      s3: {
        bucket: EXAMPLE_KNOWLEDGE_CANONICAL.s3.bucket,
        prefix: EXAMPLE_KNOWLEDGE_CANONICAL.s3.prefix,
        region: EXAMPLE_KNOWLEDGE_CANONICAL.s3.region,
        profile: EXAMPLE_KNOWLEDGE_CANONICAL.s3.profile,
        server_side_encryption: 'AES256',
      },
    });
    first.s3!.bucket = 'changed';
    expect(second.s3!.bucket).toBe('example-knowledge-prod');
  });

  test('returns complete local defaults and fresh nested values', () => {
    const first = defaultKnowledgeConfig();
    const second = defaultKnowledgeConfig();
    expect(first).toMatchObject({
      version: 1,
      mode: 'local',
      hosted: { api_url: 'https://knowledge.md' },
      storage: { type: 'local', artifacts_root: 'artifacts' },
      sources: { preferred_ref: 'open-files' },
      embeddings: { dimensions: 1536, batch_size: 64, max_parallel_calls: 4 },
      safety: {
        network: { web_search_enabled: false, s3_reads_enabled: false, allowed_s3_buckets: [] },
        redaction: { enabled: true },
        approvals: { generated_writes_require_approval: true },
      },
    });
    expect(first.sources.allowed_schemes).toEqual(['open-files', 's3', 'file', 'https', 'http']);
    first.sources.allowed_schemes.push('changed');
    first.providers!.aliases!.fast = 'changed';
    expect(second.sources.allowed_schemes).not.toContain('changed');
    expect(second.providers!.aliases!.fast).toBe('openai:gpt-5-mini');
  });

  test('creates the workspace tree and a private default config when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-workspace-init-'));
    const home = join(dir, 'nested', '.hasna', 'knowledge');
    const workspace = ensureKnowledgeWorkspace(home);

    for (const path of [
      workspace.home,
      workspace.artifactsDir,
      workspace.cacheDir,
      workspace.exportsDir,
      workspace.indexesDir,
      workspace.logsDir,
      workspace.runsDir,
      workspace.schemasDir,
      workspace.wikiDir,
    ]) {
      expect(statSync(path).isDirectory()).toBe(true);
    }
    expect(readKnowledgeConfig(workspace.configPath)).toEqual(defaultKnowledgeConfig());
    expect(statSync(workspace.configPath).mode & 0o777).toBe(0o600);
  });

  test('does not overwrite an existing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-workspace-existing-'));
    const workspace = workspaceForHome(dir);
    const config = defaultKnowledgeConfig();
    config.mode = 'hosted';
    writeKnowledgeConfig(workspace.configPath, config);

    ensureKnowledgeWorkspace(dir);

    expect(readKnowledgeConfig(workspace.configPath).mode).toBe('hosted');
  });
});

describe('workspace config I/O', () => {
  test('creates parent directories, writes formatted JSON, and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-workspace-config-'));
    const path = join(dir, 'deep', 'config.json');
    const config = defaultKnowledgeConfig();
    config.storage.artifacts_root = 'custom-artifacts';

    writeKnowledgeConfig(path, config);

    expect(existsSync(join(dir, 'deep'))).toBe(true);
    expect(readKnowledgeConfig(path)).toEqual(config);
    expect(readFileSync(path, 'utf8')).toEndWith('\n');
    expect(readFileSync(path, 'utf8')).toContain('\n  "version": 1,');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('ensureParentDir handles nested paths and an existing parent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-workspace-parent-'));
    const path = join(dir, 'one', 'two', 'file.json');
    ensureParentDir(path);
    expect(statSync(join(dir, 'one', 'two')).isDirectory()).toBe(true);
    expect(() => ensureParentDir(path)).not.toThrow();
  });

  test('readKnowledgeConfig rejects missing and malformed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-workspace-read-'));
    expect(() => readKnowledgeConfig(join(dir, 'missing.json'))).toThrow();
    const malformed = join(dir, 'malformed.json');
    writeFileSync(malformed, '{not-json');
    expect(() => readKnowledgeConfig(malformed)).toThrow();
  });
});
