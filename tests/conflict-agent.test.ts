import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeKnowledgeSyncConflictResolutionWithAi } from '../src/conflict-agent';
import { migrateKnowledgeDb, openKnowledgeDb } from '../src/knowledge-db';
import { recordKnowledgeSyncConflict } from '../src/sync';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function temporaryDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'knowledge-conflict-agent-')), 'knowledge.db');
}

function insertLocalSource(dbPath: string, id: string): void {
  migrateKnowledgeDb(dbPath);
  const db = openKnowledgeDb(dbPath);
  try {
    db.run(
      `INSERT INTO sources (id, uri, kind, title, metadata_json, acl_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', '{}', ?, ?)`,
      [id, `open-files://file/${id}`, 'document', 'Local source', NOW.toISOString(), NOW.toISOString()],
    );
  } finally {
    db.close();
  }
}

describe('conflict-agent', () => {
  test('builds a review-only fake proposal from local and remote evidence and records its run', async () => {
    const dbPath = temporaryDb();
    insertLocalSource(dbPath, 'source-1');
    const conflict = recordKnowledgeSyncConflict(dbPath, {
      entityKind: 'sources',
      entityId: 'id="source-1"',
      localMachineId: 'local-machine',
      remoteMachineId: 'remote-machine',
      localHash: 'sha256:local',
      remoteHash: 'sha256:remote',
      metadata: {
        remote_row: {
          id: 'source-1',
          uri: 'open-files://file/source-1',
          kind: 'document',
          title: 'Remote source',
        },
      },
    });

    const proposal = await proposeKnowledgeSyncConflictResolutionWithAi({
      dbPath,
      id: conflict.id,
      modelRef: 'deepseek:deepseek-chat',
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
        target: 'sources:id="source-1"',
        strategy: 'manual-merge',
      },
      agent: {
        generated: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    });
    expect(proposal.proposed_patch?.diff).toContain('Local source');
    expect(proposal.proposed_patch?.diff).toContain('Remote source');
    expect(proposal.citations.map((citation) => citation.id)).toEqual(
      expect.arrayContaining(['conflict', 'local-row', 'remote-row', 'source-1']),
    );
    expect(proposal.warnings).not.toContain('remote_row_snapshot_unavailable');

    const db = openKnowledgeDb(dbPath);
    try {
      const run = db.query<{
        status: string;
        provider: string;
        model: string;
        metadata_json: string;
      }, [string]>('SELECT status, provider, model, metadata_json FROM runs WHERE id = ?').get(proposal.agent!.run_id);
      expect(run).toMatchObject({ status: 'dry_run', provider: 'deepseek', model: 'deepseek-chat' });
      expect(JSON.parse(run!.metadata_json)).toMatchObject({
        conflict_id: conflict.id,
        fake: true,
        proposed_strategy: 'manual-merge',
      });
      const events = db.query<{ event: string }, [string]>(
        'SELECT event FROM run_events WHERE run_id = ? ORDER BY created_at, event',
      ).all(proposal.agent!.run_id).map((row) => row.event);
      expect(events).toEqual(['conflict_evidence_retrieved', 'fake_conflict_proposal_generated']);
    } finally {
      db.close();
    }
  });

  test('falls back to a custom review proposal when row snapshots are unavailable', async () => {
    const dbPath = temporaryDb();
    const conflict = recordKnowledgeSyncConflict(dbPath, {
      entityKind: 'unknown_entity',
      entityId: 'missing-row',
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
      strategy: 'review-and-select',
      diff: null,
    });
    expect(proposal.warnings).toContain('remote_row_snapshot_unavailable');
    expect(proposal.citations).toEqual([
      expect.objectContaining({ id: 'conflict', ref: `knowledge-sync-conflict://${conflict.id}` }),
    ]);
  });

  test('refuses a real provider call without credentials and records the failed run', async () => {
    const dbPath = temporaryDb();
    const conflict = recordKnowledgeSyncConflict(dbPath, {
      entityKind: 'sources',
      entityId: 'id="missing"',
      localMachineId: 'local-machine',
      remoteMachineId: 'remote-machine',
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
      const run = db.query<{ id: string; status: string; metadata_json: string }, []>(
        `SELECT id, status, metadata_json FROM runs
         WHERE type = 'sync-conflict-proposal' ORDER BY rowid DESC LIMIT 1`,
      ).get();
      expect(run?.status).toBe('failed');
      expect(JSON.parse(run!.metadata_json)).toMatchObject({
        conflict_id: conflict.id,
        mode: 'ai',
        error: expect.stringContaining('Missing OPENAI_API_KEY'),
      });
      const failure = db.query<{ level: string; metadata_json: string }, [string, string]>(
        'SELECT level, metadata_json FROM run_events WHERE run_id = ? AND event = ?',
      ).get(run!.id, 'conflict_proposal_generation_failed');
      expect(failure?.level).toBe('error');
      expect(JSON.parse(failure!.metadata_json).message).toContain('Missing OPENAI_API_KEY');
    } finally {
      db.close();
    }
  });
});
