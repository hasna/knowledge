import { describe, expect, test } from 'bun:test';
import {
  KIT_VERSION,
  createKnowledgeCloudClient,
  normalizeCloudStorageMode,
  resolveStorageMode,
  storageEnvKeys,
  wrapExecutor,
  type PgExecutor,
} from '../src/storage';

/**
 * A tiny in-memory executor shim so the kit's typed query surface can be
 * exercised without a live Postgres. Mirrors the shape pg.Pool returns.
 */
class FakeExecutor implements PgExecutor {
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async query<T>(_sql: string, _params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
    return { rows: this.rows as unknown as T[], rowCount: this.rows.length };
  }
}

describe('vendored cloud storage kit surface', () => {
  test('exposes a stamped kit version', () => {
    expect(KIT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('restores the dropped single-row get() helper', async () => {
    const populated = wrapExecutor(new FakeExecutor([{ id: 'a' }, { id: 'b' }]));
    expect(await populated.get<{ id: string }>('SELECT ...')).toEqual({ id: 'a' });

    const empty = wrapExecutor(new FakeExecutor([]));
    expect(await empty.get('SELECT ...')).toBeNull();
  });

  test('one() enforces exactly-one-row semantics', async () => {
    const single = wrapExecutor(new FakeExecutor([{ id: 'only' }]));
    expect(await single.one<{ id: string }>('SELECT ...')).toEqual({ id: 'only' });
    const empty = wrapExecutor(new FakeExecutor([]));
    await expect(empty.one('SELECT ...')).rejects.toThrow('exactly one row');
  });

  test('resolves the canonical HASNA_KNOWLEDGE_* env contract', () => {
    const keys = storageEnvKeys('knowledge');
    expect(keys.modeKeys[0]).toBe('HASNA_KNOWLEDGE_STORAGE_MODE');
    expect(keys.databaseUrlKeys[0]).toBe('HASNA_KNOWLEDGE_DATABASE_URL');

    expect(resolveStorageMode('knowledge', {}).mode).toBe('local');
    expect(
      resolveStorageMode('knowledge', {
        HASNA_KNOWLEDGE_STORAGE_MODE: 'cloud',
        HASNA_KNOWLEDGE_DATABASE_URL: 'postgres://x/y',
      }).mode,
    ).toBe('cloud');
  });

  test('normalizes deprecated aliases to cloud', () => {
    expect(normalizeCloudStorageMode('remote').mode).toBe('cloud');
    expect(normalizeCloudStorageMode('hybrid').mode).toBe('cloud');
    expect(normalizeCloudStorageMode('self_hosted').mode).toBe('cloud');
    expect(normalizeCloudStorageMode('local').mode).toBe('local');
  });

  test('createKnowledgeCloudClient refuses non-cloud mode without leaking the URL', () => {
    const priorMode = process.env.HASNA_KNOWLEDGE_STORAGE_MODE;
    const priorUrl = process.env.HASNA_KNOWLEDGE_DATABASE_URL;
    try {
      delete process.env.HASNA_KNOWLEDGE_STORAGE_MODE;
      process.env.HASNA_KNOWLEDGE_DATABASE_URL = 'postgres://secret:secret@host/db';
      expect(() => createKnowledgeCloudClient()).toThrow(/storage mode 'cloud'/);
      try {
        createKnowledgeCloudClient();
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    } finally {
      if (priorMode === undefined) delete process.env.HASNA_KNOWLEDGE_STORAGE_MODE;
      else process.env.HASNA_KNOWLEDGE_STORAGE_MODE = priorMode;
      if (priorUrl === undefined) delete process.env.HASNA_KNOWLEDGE_DATABASE_URL;
      else process.env.HASNA_KNOWLEDGE_DATABASE_URL = priorUrl;
    }
  });
});
