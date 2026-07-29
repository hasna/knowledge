import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  defaultStorePath,
  ensureStore,
  loadStore,
  loadStoreIfExists,
  makeId,
  makeShortId,
  saveStore,
  withLock,
  type KnowledgeItem,
} from '../src/store';

const __dirname = dirname(fileURLToPath(import.meta.url));

function item(id: string, shortId = id.replace(/^k_/, '')): KnowledgeItem {
  return {
    id,
    short_id: shortId,
    title: `Title for ${id}`,
    content: `Content for ${id}`,
    url: null,
    tags: ['test'],
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
  };
}

function runLegacyImport(home: string, dryRun: boolean): {
  exitCode: number;
  stderr: string;
  result: Record<string, unknown>;
} {
  const moduleUrl = pathToFileURL(join(__dirname, '..', 'src', 'store.ts')).href;
  const script = [
    `import { importLegacyGlobalStore } from ${JSON.stringify(moduleUrl)};`,
    `const result = importLegacyGlobalStore({ dryRun: ${dryRun}, now: new Date('2026-07-29T12:34:56.789Z') });`,
    'console.log(JSON.stringify(result));',
  ].join('\n');
  const child = Bun.spawnSync(['bun', '-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new TextDecoder().decode(child.stdout).trim();
  return {
    exitCode: child.exitCode,
    stderr: new TextDecoder().decode(child.stderr),
    result: stdout ? JSON.parse(stdout) : {},
  };
}

describe('JSON knowledge store', () => {
  test('creates, preserves, saves, and loads stores atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-store-'));
    const storePath = join(dir, 'nested', 'db.json');

    expect(defaultStorePath()).toEndWith(join('.hasna', 'knowledge', 'db.json'));
    expect(loadStoreIfExists(storePath)).toEqual({ exists: false, items: [] });

    ensureStore(storePath);
    expect(loadStoreIfExists(storePath)).toEqual({ exists: true, items: [] });
    expect(statSync(storePath).mode & 0o777).toBe(0o600);

    const saved = { items: [item('k_saved')] };
    saveStore(storePath, saved);
    ensureStore(storePath);
    expect(loadStore(storePath)).toEqual(saved);
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toEqual(saved);
    expect(existsSync(join(dir, 'nested'))).toBe(true);
  });

  test('reports missing stores, normalizes invalid shapes, and surfaces malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-store-invalid-'));
    const storePath = join(dir, 'db.json');

    writeFileSync(storePath, JSON.stringify({ items: 'not-an-array' }));
    expect(loadStoreIfExists(storePath)).toEqual({ exists: true, items: [] });
    expect(loadStore(storePath)).toEqual({ items: [] });

    writeFileSync(storePath, '{ malformed');
    expect(() => loadStoreIfExists(storePath)).toThrow();
    expect(() => loadStore(storePath)).toThrow();
  });

  test('supports reentrant locks and always releases them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-store-lock-'));
    const storePath = join(dir, 'missing', 'db.json');
    const lockPath = `${storePath}.lock`;

    expect(() => withLock(storePath, () => 'unreachable')).toThrow();
    expect(existsSync(lockPath)).toBe(false);

    const result = withLock(storePath, () => {
      expect(existsSync(lockPath)).toBe(true);
      return withLock(storePath, () => 41) + 1;
    }, { createParent: true });
    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false);

    expect(() => withLock(storePath, () => {
      throw new Error('callback failed');
    })).toThrow('callback failed');
    expect(existsSync(lockPath)).toBe(false);
  });

  test('generates full and short identifiers at their guarded boundaries', () => {
    const first = makeId();
    const second = makeId();
    expect(first).toMatch(/^k_[a-z0-9]+_[a-z0-9]{6}$/);
    expect(second).not.toBe(first);
    expect(makeShortId('k_abcdefghijklmnop')).toBe('abcdefghijkl');
    expect(makeShortId('plain_identifier')).toBe('plain_identi');
    expect(makeShortId('k_')).toBe('');
  });

  test('imports legacy records without overwriting canonical identities', () => {
    const home = mkdtempSync(join(tmpdir(), 'knowledge-store-import-'));
    const legacyPath = join(home, '.open-knowledge', 'db.json');
    const canonicalPath = join(home, '.hasna', 'knowledge', 'db.json');
    mkdirSync(dirname(legacyPath), { recursive: true });
    mkdirSync(dirname(canonicalPath), { recursive: true });
    writeFileSync(legacyPath, `${JSON.stringify({
      items: [item('k_new', 'new'), item('k_duplicate', 'duplicate'), { title: 'missing id' }],
    }, null, 2)}\n`);
    writeFileSync(canonicalPath, `${JSON.stringify({ items: [item('k_duplicate', 'duplicate')] }, null, 2)}\n`);

    const imported = runLegacyImport(home, false);
    expect(imported.exitCode).toBe(0);
    expect(imported.stderr).toBe('');
    expect(imported.result).toMatchObject({
      ok: true,
      dry_run: false,
      legacy_exists: true,
      canonical_existed: true,
      canonical_created: false,
      imported: 1,
      skipped_existing: 1,
      skipped_invalid: 1,
    });
    expect(imported.result.backup_path).toBeString();
    expect(imported.result.report_path).toBeString();
    expect(existsSync(imported.result.backup_path as string)).toBe(true);
    expect(existsSync(imported.result.report_path as string)).toBe(true);
    expect(loadStore(canonicalPath).items.map((entry) => entry.id)).toEqual(['k_duplicate', 'k_new']);
  });

  test('keeps dry runs read-only and returns malformed legacy-store errors', () => {
    const home = mkdtempSync(join(tmpdir(), 'knowledge-store-import-edge-'));
    const legacyPath = join(home, '.open-knowledge', 'db.json');
    const canonicalPath = join(home, '.hasna', 'knowledge', 'db.json');
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, `${JSON.stringify({ items: [item('k_preview', 'preview')] }, null, 2)}\n`);

    const preview = runLegacyImport(home, true);
    expect(preview.exitCode).toBe(0);
    expect(preview.result).toMatchObject({
      ok: true,
      dry_run: true,
      canonical_existed: false,
      canonical_created: false,
      would_create_canonical: true,
      imported: 1,
      backup_path: null,
      report_path: null,
    });
    expect(existsSync(canonicalPath)).toBe(false);

    writeFileSync(legacyPath, '{ malformed');
    const malformed = runLegacyImport(home, true);
    expect(malformed.exitCode).toBe(0);
    expect(malformed.result).toMatchObject({
      ok: false,
      imported: 0,
      message: 'Legacy global store import failed',
    });
    expect(malformed.result.errors).toEqual([
      expect.stringContaining('Could not read legacy store'),
    ]);
    expect(existsSync(canonicalPath)).toBe(false);
  });
});
