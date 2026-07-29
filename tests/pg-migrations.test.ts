import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { PG_MIGRATIONS } from '../src/db/pg-migrations';

let db: PGlite;

async function applyMigrations(): Promise<void> {
  await db.exec('CREATE EXTENSION IF NOT EXISTS pgcrypto').catch(() => {});
  for (const sql of PG_MIGRATIONS) await db.exec(sql);
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations();
});

afterAll(async () => {
  await db?.close();
});

describe('Postgres migrations', () => {
  test('apply idempotently without replacing existing catalog data', async () => {
    await db.query(
      `INSERT INTO knowledge_items (id, title, content)
       VALUES ('item-1', 'Kept title', 'Kept body')`,
    );

    await applyMigrations();

    const item = (await db.query<{ title: string; content: string; version: number }>(
      `SELECT title, content, version FROM knowledge_items WHERE id = 'item-1'`,
    )).rows[0];
    expect(item).toEqual({ title: 'Kept title', content: 'Kept body', version: 1 });
    const triggers = await db.query<{ name: string; enabled: string }>(
      `SELECT tgname AS name, tgenabled AS enabled
         FROM pg_trigger
        WHERE tgrelid IN ('knowledge_items'::regclass, 'knowledge_item_versions'::regclass)
          AND NOT tgisinternal
        ORDER BY tgname`,
    );
    expect(triggers.rows).toEqual([
      { name: 'trg_knowledge_item_versions_append_only', enabled: 'A' },
      { name: 'trg_knowledge_items_version', enabled: 'A' },
    ]);
  });

  test('enforces source uniqueness and cascades source deletion through revisions and chunks', async () => {
    await db.query(
      `INSERT INTO sources (id, uri, kind) VALUES ('source-1', 'file:///one.md', 'file')`,
    );
    await db.query(
      `INSERT INTO source_revisions (id, source_id, revision) VALUES ('revision-1', 'source-1', 'v1')`,
    );
    await db.query(
      `INSERT INTO chunks (id, source_revision_id, kind, ordinal, text)
       VALUES ('chunk-1', 'revision-1', 'text', 0, 'body')`,
    );

    await expect(db.query(
      `INSERT INTO sources (id, uri, kind) VALUES ('source-2', 'file:///one.md', 'file')`,
    )).rejects.toThrow();

    await db.query(`DELETE FROM sources WHERE id = 'source-1'`);
    const counts = (await db.query<{ revisions: number; chunks: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM source_revisions) AS revisions,
         (SELECT COUNT(*)::int FROM chunks) AS chunks`,
    )).rows[0];
    expect(counts).toEqual({ revisions: 0, chunks: 0 });
  });

  test('snapshots meaningful item updates, ignores no-ops, and refuses history rewrites', async () => {
    await db.query(`UPDATE knowledge_items SET content = 'Second body' WHERE id = 'item-1'`);
    await db.query(`UPDATE knowledge_items SET content = 'Second body', version = 99 WHERE id = 'item-1'`);

    const item = (await db.query<{ content: string; version: number }>(
      `SELECT content, version FROM knowledge_items WHERE id = 'item-1'`,
    )).rows[0];
    expect(item).toEqual({ content: 'Second body', version: 2 });
    const history = (await db.query<{ version: number; content: string }>(
      `SELECT version, content FROM knowledge_item_versions WHERE item_id = 'item-1' ORDER BY version`,
    )).rows;
    expect(history).toEqual([{ version: 1, content: 'Kept body' }]);

    await expect(db.query(
      `UPDATE knowledge_item_versions SET content = 'rewritten' WHERE item_id = 'item-1'`,
    )).rejects.toThrow('append-only');
    expect((await db.query<{ content: string }>(
      `SELECT content FROM knowledge_item_versions WHERE item_id = 'item-1'`,
    )).rows[0]?.content).toBe('Kept body');
  });
});
