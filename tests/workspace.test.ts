import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('workspace path resolution', () => {
  test('maps canonical and legacy global paths beneath the user home', () => {
    expect(HASNA_KNOWLEDGE_APP_PATH).toBe(join('.hasna', 'knowledge'));
    expect(LEGACY_HASNA_KNOWLEDGE_APP_PATH).toBe(join('.hasna', 'apps', 'knowledge'));
    expect(globalKnowledgeHome()).toBe(join(homedir(), '.hasna', 'knowledge'));
    expect(legacyGlobalKnowledgeHome()).toBe(join(homedir(), '.hasna', 'apps', 'knowledge'));
    expect(legacyGlobalStorePath()).toBe(join(homedir(), '.open-knowledge', 'db.json'));
  });

  test('resolves project paths and both scoped-workspace branches', () => {
    const cwd = tempDir('knowledge-workspace-scope-');
    expect(projectKnowledgeHome(cwd)).toBe(resolve(cwd, '.hasna', 'knowledge'));
    expect(legacyProjectKnowledgeHome(cwd)).toBe(resolve(cwd, '.hasna', 'apps', 'knowledge'));
    expect(resolveScopedWorkspace('project', cwd).home).toBe(projectKnowledgeHome(cwd));
    expect(resolveScopedWorkspace('local', cwd).home).toBe(projectKnowledgeHome(cwd));
    expect(resolveScopedWorkspace(undefined, cwd).home).toBe(globalKnowledgeHome());
    expect(resolveLegacyScopedWorkspace('project', cwd).home).toBe(legacyProjectKnowledgeHome(cwd));
    expect(resolveLegacyScopedWorkspace('local', cwd).home).toBe(legacyProjectKnowledgeHome(cwd));
    expect(resolveLegacyScopedWorkspace('global', cwd).home).toBe(legacyGlobalKnowledgeHome());
  });

  test('derives every workspace file and directory from the supplied home', () => {
    const home = '/var/tmp/knowledge-workspace-map';
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
});

describe('workspace configuration', () => {
  test('returns complete local defaults and the canonical example S3 settings', () => {
    const defaults = defaultKnowledgeConfig();
    expect(defaults).toMatchObject({
      version: 1,
      mode: 'local',
      storage: { type: 'local', artifacts_root: 'artifacts' },
      sources: { preferred_ref: 'open-files' },
      safety: {
        network: { web_search_enabled: false, s3_reads_enabled: false },
        redaction: { enabled: true },
        approvals: { generated_writes_require_approval: true },
      },
    });
    expect(defaults.sources.allowed_schemes).toEqual(['open-files', 's3', 'file', 'https', 'http']);
    expect(canonicalExampleKnowledgeStorage()).toEqual({
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
  });

  test('creates the workspace scaffold and a private default config', () => {
    const home = join(tempDir('knowledge-workspace-create-'), 'nested', 'knowledge');
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
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
    expect(readKnowledgeConfig(workspace.configPath)).toEqual(defaultKnowledgeConfig());
    expect(statSync(workspace.configPath).mode & 0o777).toBe(0o600);
  });

  test('does not overwrite an existing config', () => {
    const home = join(tempDir('knowledge-workspace-existing-'), 'knowledge');
    mkdirSync(home, { recursive: true });
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, '{"sentinel":true}\n');

    ensureKnowledgeWorkspace(home);
    expect(readFileSync(configPath, 'utf8')).toBe('{"sentinel":true}\n');
  });

  test('writes and reads config through a missing parent with private permissions', () => {
    const root = tempDir('knowledge-workspace-config-');
    const path = join(root, 'deep', 'config.json');
    const config = defaultKnowledgeConfig();
    config.mode = 'hosted';

    writeKnowledgeConfig(path, config);
    expect(existsSync(join(root, 'deep'))).toBe(true);
    expect(readKnowledgeConfig(path)).toEqual(config);
    expect(readFileSync(path, 'utf8')).toEndWith('\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('creates a missing parent and surfaces missing or malformed config errors', () => {
    const root = tempDir('knowledge-workspace-parent-');
    const child = join(root, 'a', 'b', 'file.txt');
    ensureParentDir(child);
    expect(statSync(join(root, 'a', 'b')).isDirectory()).toBe(true);

    expect(() => readKnowledgeConfig(join(root, 'missing.json'))).toThrow();
    const malformed = join(root, 'malformed.json');
    writeFileSync(malformed, '{');
    expect(() => readKnowledgeConfig(malformed)).toThrow();
  });
});
