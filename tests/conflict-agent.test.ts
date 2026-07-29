import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeKnowledgeSyncConflictResolutionWithAi } from '../src/conflict-agent';
import { migrateKnowledgeDb, openKnowledgeDb } from '../src/knowledge-db';
import { recordKnowledgeSyncConflict } from '../src/sync';

const NOW = new Date('2026-07-29T15:00:00.000Z');

function createDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-conflict-agent-'));
  const dbPath = join(dir, 'knowledge.db');
  migrateKnowledgeDb(dbPath);
  return dbPath;
}

describe('knowledge sync conflict proposal agent', () => {
  test('builds a fake approval-gated proposal from real local and remote rows', async () => {
    const dbPath = createDb();
    const db = openKnowledgeDb(dbPath);
    try {
      db.query(`
        INSERT INTO sources (id, uri, kind, title, metadata_json, acl_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'source_1',
        'open-files://file/source_1',
        'open-files',
        'Local title',
        '{}',
        '{}',
        NOW.toISOString(),
        NOW.toISOString(),
      );
    } finally {
      db.close();
    }
    const conflict = recordKnowledgeSyncConflict(dbPath, {
      entityKind: 'sources',
      entityId: 'id="source_1"',
      localMachineId: 'local-machine',
      remoteMachineId: 'remote-machine',
      localHash: 'sha256:local',
      remoteHash: 'sha256:remote',
      metadata: {
        remote_row: {
          id: 'source_1',
          uri: 'open-files://file/source_1',
          title: 'Remote title',
        },
      },
    });

    const proposal = await proposeKnowledgeSyncConflictResolutionWithAi({
      dbPath,
      id: conflict.id,
      modelRef: 'openai:gpt-5-mini',
      fake: true,
      now: NOW,
    });

    expect(proposal).toMatchObject({
      ok: true,
      mode: 'ai',
      requires_approval: true,
      proposed_strategy: 'manual-merge',
      confidence: 0.5,
      proposed_patch: {
        kind: 'manual_merge',
        target: 'sources:id="source_1"',
        strategy: 'manual-merge',
        metadata: {
          fake: true,
          local_hash: 'sha256:local',
          remote_hash: 'sha256:remote',
        },
      },
      agent: {
        generated: true,
        provider: 'openai',
        model: 'gpt-5-mini',
      },
    });
    expect(proposal.proposed_patch?.diff).toContain('Local title');
    expect(proposal.proposed_patch?.diff).toContain('Remote title');
    expect(proposal.agent?.usage.input_tokens).toBeGreaterThan(0);
    expect(proposal.agent?.usage.output_tokens).toBeGreaterThan(0);

    const ledger = openKnowledgeDb(dbPath);
    try {
      const run = ledger.query<{
        status: string;
        cost_tokens: number;
        metadata_json: string;
      }, [string]>('SELECT status, cost_tokens, metadata_json FROM runs WHERE id = ?')
        .get(proposal.agent!.run_id!);
      expect(run?.status).toBe('dry_run');
      expect(run?.cost_tokens).toBeGreaterThan(0);
      expect(JSON.parse(run!.metadata_json)).toMatchObject({
        conflict_id: conflict.id,
        fake: true,
        proposed_strategy: 'manual-merge',
      });
      const events = ledger.query<{ event: string }, [string]>(
        'SELECT event FROM run_events WHERE run_id = ? ORDER BY created_at, event',
      ).all(proposal.agent!.run_id!).map((row) => row.event);
      expect(events).toEqual([
        'conflict_evidence_retrieved',
        'fake_conflict_proposal_generated',
      ]);
    } finally {
      ledger.close();
    }
  });

  test('falls back to review-and-select when one row snapshot is unavailable', async () => {
    const dbPath = createDb();
    const conflict = recordKnowledgeSyncConflict(dbPath, {
      entityKind: 'wiki_pages',
      entityId: 'missing-page',
      localMachineId: 'local-machine',
      remoteMachineId: 'remote-machine',
    });

    const proposal = await proposeKnowledgeSyncConflictResolutionWithAi({
      dbPath,
      id: conflict.id,
      fake: true,
      now: NOW,
    });

    expect(proposal.proposed_patch).toMatchObject({
      kind: 'custom',
      target: 'wiki_pages:missing-page',
      strategy: 'review-and-select',
      diff: null,
    });
    expect(proposal.warnings).toContain('remote_row_snapshot_unavailable');
  });

  test('rejects a missing conflict before creating a run', async () => {
    const dbPath = createDb();

    await expect(proposeKnowledgeSyncConflictResolutionWithAi({
      dbPath,
      id: 'syncconf_missing',
      fake: true,
      now: NOW,
    })).rejects.toThrow('Sync conflict not found: syncconf_missing');

    const db = openKnowledgeDb(dbPath);
    try {
      expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runs').get()?.count).toBe(0);
    } finally {
      db.close();
    }
  });

  test('records a failed run when live generation lacks provider credentials', async () => {
    const dbPath = createDb();
    const conflict = recordKnowledgeSyncConflict(dbPath, {
      entityKind: 'wiki_pages',
      entityId: 'page_1',
      localMachineId: 'local-machine',
      remoteMachineId: 'remote-machine',
      metadata: { remote_row: { id: 'page_1', title: 'Remote title' } },
    });

    await expect(proposeKnowledgeSyncConflictResolutionWithAi({
      dbPath,
      id: conflict.id,
      modelRef: 'openai:gpt-5-mini',
      env: {},
      now: NOW,
    })).rejects.toThrow('Missing OPENAI_API_KEY');

    const db = openKnowledgeDb(dbPath);
    try {
      const run = db.query<{ id: string; status: string; cost_tokens: number; metadata_json: string }, []>(
        'SELECT id, status, cost_tokens, metadata_json FROM runs LIMIT 1',
      ).get();
      expect(run?.status).toBe('failed');
      expect(run?.cost_tokens).toBeGreaterThan(0);
      expect(JSON.parse(run!.metadata_json)).toMatchObject({
        conflict_id: conflict.id,
        mode: 'ai',
        error: expect.stringContaining('Missing OPENAI_API_KEY'),
      });
      const failure = db.query<{ level: string; event: string }, [string]>(
        "SELECT level, event FROM run_events WHERE run_id = ? AND event = 'conflict_proposal_generation_failed'",
      ).get(run!.id);
      expect(failure).toEqual({ level: 'error', event: 'conflict_proposal_generation_failed' });
    } finally {
      db.close();
    }
  });
});
