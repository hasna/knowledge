import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrateKnowledgeDb, openKnowledgeDb } from '../src/knowledge-db';
import {
  approvalStatus,
  assertS3ReadAllowed,
  assertWebSearchAllowed,
  assertWriteAllowed,
  auditId,
  createApprovalGate,
  hasApproval,
  recordAuditEvent,
  recordRedactionFindings,
  redactSecrets,
  resolveSafetyPolicy,
  type SafetyPolicy,
} from '../src/safety';
import { defaultKnowledgeConfig, workspaceForHome } from '../src/workspace';

function basePolicy(root: string): SafetyPolicy {
  return {
    mode: 'local',
    allowWriteRoots: [resolve(root)],
    readOnlySourceAccess: true,
    network: {
      webSearchEnabled: false,
      s3ReadsEnabled: false,
      allowedS3Buckets: [],
    },
    redaction: { enabled: true },
    approvals: { generatedWritesRequireApproval: true },
  };
}

describe('safety policy resolution and guards', () => {
  test('resolves configured defaults, write roots, and sorted S3 buckets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-safety-policy-'));
    const workspace = workspaceForHome(join(dir, '.hasna', 'knowledge'));
    const config = defaultKnowledgeConfig();
    config.mode = 'hosted';
    config.storage = {
      type: 's3',
      artifacts_root: 'artifacts',
      s3: { bucket: 'storage-bucket' },
    };
    config.safety!.network!.allowed_s3_buckets = ['z-bucket', 'storage-bucket'];

    const policy = resolveSafetyPolicy(config, workspace);

    expect(policy).toMatchObject({
      mode: 'hosted',
      readOnlySourceAccess: true,
      network: {
        webSearchEnabled: false,
        s3ReadsEnabled: false,
        allowedS3Buckets: ['storage-bucket', 'z-bucket'],
      },
      redaction: { enabled: true },
      approvals: { generatedWritesRequireApproval: true },
    });
    expect(policy.allowWriteRoots).toHaveLength(9);
    expect(policy.allowWriteRoots).toContain(resolve(workspace.wikiDir));
  });

  test('uses environment fallbacks while explicit configuration wins', () => {
    const keys = [
      'HASNA_KNOWLEDGE_WEB_SEARCH',
      'HASNA_KNOWLEDGE_ALLOW_S3_READS',
      'HASNA_KNOWLEDGE_ALLOWED_S3_BUCKETS',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.HASNA_KNOWLEDGE_WEB_SEARCH = 'yes';
      process.env.HASNA_KNOWLEDGE_ALLOW_S3_READS = 'true';
      process.env.HASNA_KNOWLEDGE_ALLOWED_S3_BUCKETS = ' beta,alpha,, beta ';
      const config = defaultKnowledgeConfig();
      delete config.safety;
      const workspace = workspaceForHome('/tmp/knowledge-safety-env-fixture');

      expect(resolveSafetyPolicy(config, workspace).network).toEqual({
        webSearchEnabled: true,
        s3ReadsEnabled: true,
        allowedS3Buckets: ['alpha', 'beta'],
      });

      config.safety = {
        network: { web_search_enabled: false, s3_reads_enabled: false, allowed_s3_buckets: [] },
        redaction: { enabled: false },
        approvals: { generated_writes_require_approval: false },
      };
      expect(resolveSafetyPolicy(config, workspace)).toMatchObject({
        network: { webSearchEnabled: false, s3ReadsEnabled: false },
        redaction: { enabled: false },
        approvals: { generatedWritesRequireApproval: false },
      });
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('allows writes at or below a configured root and rejects prefix siblings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-safety-write-'));
    const allowed = join(dir, 'knowledge');
    const policy = basePolicy(allowed);

    expect(() => assertWriteAllowed(allowed, policy)).not.toThrow();
    expect(() => assertWriteAllowed(join(allowed, 'wiki', 'page.md'), policy)).not.toThrow();
    expect(() => assertWriteAllowed(`${allowed}-other/page.md`, policy)).toThrow('denied write outside');
    expect(() => assertWriteAllowed(join(allowed, '..', 'outside.md'), policy)).toThrow('denied write outside');
  });

  test('enforces S3 enablement, bucket allowlists, and valid URIs', () => {
    const policy = basePolicy('/tmp/knowledge-safety-s3-fixture');
    expect(() => assertS3ReadAllowed('s3://allowed-bucket/readme.md', policy)).toThrow('denied S3 read');

    policy.network.s3ReadsEnabled = true;
    policy.network.allowedS3Buckets = ['allowed-bucket'];
    expect(() => assertS3ReadAllowed('s3://allowed-bucket/readme.md', policy)).not.toThrow();
    expect(() => assertS3ReadAllowed('s3://other-bucket/readme.md', policy)).toThrow('denied S3 bucket');
    expect(() => assertS3ReadAllowed('not a URI', policy)).toThrow();
  });

  test('enforces web-search refusal and allow decisions', () => {
    const policy = basePolicy('/tmp/knowledge-safety-web-fixture');
    expect(() => assertWebSearchAllowed(policy)).toThrow('denied web search');
    policy.network.webSearchEnabled = true;
    expect(() => assertWebSearchAllowed(policy)).not.toThrow();
  });
});

describe('secret redaction', () => {
  test('redacts supported secrets and reports their locations', () => {
    const value = [
      'api_key=1234567890abcdef',
      'sk-123456789012345678901234',
      'ghp_123456789012345678901234',
    ].join('\n');
    const result = redactSecrets(value);

    expect(result.text).toContain('[REDACTED:secret_assignment]');
    expect(result.text).toContain('[REDACTED:openai_api_key]');
    expect(result.text).toContain('[REDACTED:github_token]');
    expect(result.findings.map((finding) => finding.type)).toEqual([
      'secret_assignment',
      'openai_api_key',
      'github_token',
    ]);
    expect(result.findings.every((finding) => finding.end > finding.start)).toBe(true);
  });

  test('preserves empty, clean, and explicitly unredacted input', () => {
    expect(redactSecrets('')).toEqual({ text: '', findings: [] });
    expect(redactSecrets('ordinary knowledge text')).toEqual({ text: 'ordinary knowledge text', findings: [] });
    expect(redactSecrets('token=1234567890abcdef', { redaction: { enabled: false } })).toEqual({
      text: 'token=1234567890abcdef',
      findings: [],
    });
  });
});

describe('safety audit and approval persistence', () => {
  test('creates opaque, unique audit identifiers', () => {
    const input = { event_type: 'source', action: 'read', decision: 'allow' as const };
    const first = auditId(input);
    const second = auditId(input);
    expect(first).toMatch(/^audit_[a-f0-9]{24}$/);
    expect(second).toMatch(/^audit_[a-f0-9]{24}$/);
    expect(second).not.toBe(first);
  });

  test('records events and bounds oversized or deeply nested metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-safety-audit-'));
    const dbPath = join(dir, 'knowledge.db');
    migrateKnowledgeDb(dbPath);
    const db = openKnowledgeDb(dbPath);
    try {
      const id = recordAuditEvent(db, {
        event_type: 'source',
        action: 'read',
        target_uri: 'open-files://file/example',
        decision: 'allow',
        created_at: '2026-07-29T12:00:00.000Z',
        metadata: {
          long: 'x'.repeat(1005),
          items: Array.from({ length: 26 }, (_, index) => index),
          object: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`key_${index}`, index])),
          deep: { one: { two: { three: { four: { five: { six: 'hidden' } } } } } },
        },
      });
      const row = db.query<{
        id: string;
        target_uri: string;
        metadata_json: string;
        created_at: string;
      }, [string]>('SELECT id, target_uri, metadata_json, created_at FROM audit_events WHERE id = ?').get(id);
      const metadata = JSON.parse(row!.metadata_json);

      expect(row).toMatchObject({
        id,
        target_uri: 'open-files://file/example',
        created_at: '2026-07-29T12:00:00.000Z',
      });
      expect(metadata.long).toEndWith('[Truncated:5 chars]');
      expect(metadata.items).toHaveLength(26);
      expect(metadata.items[25]).toBe('[Truncated:1 items]');
      expect(metadata.object.__truncated_keys).toBe(1);
      expect(metadata.deep.one.two.three.four.five.six).toBe('[Truncated:depth]');
    } finally {
      db.close();
    }
  });

  test('records every redaction finding and accepts an empty set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-safety-findings-'));
    const dbPath = join(dir, 'knowledge.db');
    migrateKnowledgeDb(dbPath);
    const db = openKnowledgeDb(dbPath);
    try {
      expect(recordRedactionFindings(db, { findings: [] })).toBe(0);
      expect(recordRedactionFindings(db, {
        source_uri: 'open-files://file/example',
        findings: [
          { type: 'secret_assignment', severity: 'high', start: 2, end: 18 },
          { type: 'private_key_block', severity: 'high', start: 30, end: 90 },
        ],
        metadata: { phase: 'ingest' },
        created_at: '2026-07-29T12:00:00.000Z',
      })).toBe(2);

      const rows = db.query<{ finding_type: string; metadata_json: string }, []>(
        'SELECT finding_type, metadata_json FROM redaction_findings ORDER BY finding_type',
      ).all();
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[1].metadata_json)).toEqual({ phase: 'ingest', start: 2, end: 18 });
    } finally {
      db.close();
    }
  });

  test('matches exact and wildcard approvals while rejecting other targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-safety-approval-'));
    const dbPath = join(dir, 'knowledge.db');
    migrateKnowledgeDb(dbPath);
    const db = openKnowledgeDb(dbPath);
    try {
      expect(hasApproval(db, 'generated_write', 'wiki://one')).toBe(false);
      const exact = createApprovalGate(db, {
        action: 'generated_write',
        target_uri: 'wiki://one',
        reason: 'reviewed',
        approved_by: 'unit-test',
        metadata: { ticket: 'OPE53-00024' },
        created_at: '2026-07-29T12:00:00.000Z',
      });
      expect(exact.id).toStartWith('approval_');
      expect(exact.status).toBe('approved');
      expect(hasApproval(db, 'generated_write', 'wiki://one')).toBe(true);
      expect(hasApproval(db, 'generated_write', 'wiki://two')).toBe(false);

      createApprovalGate(db, { action: 'generated_write' });
      expect(hasApproval(db, 'generated_write', 'wiki://two')).toBe(true);
      expect(hasApproval(db, 'different_action', 'wiki://one')).toBe(false);
    } finally {
      db.close();
    }
  });

  test('reports required, approved, and bypassed approval decisions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-safety-status-'));
    const dbPath = join(dir, 'knowledge.db');
    migrateKnowledgeDb(dbPath);
    const db = openKnowledgeDb(dbPath);
    try {
      const policy = basePolicy(dir);
      expect(approvalStatus(db, policy, 'generated_write', 'wiki://answer')).toEqual({
        action: 'generated_write',
        target_uri: 'wiki://answer',
        approval_required: true,
        approved: false,
        decision: 'requires_approval',
      });

      createApprovalGate(db, { action: 'generated_write', target_uri: 'wiki://answer' });
      expect(approvalStatus(db, policy, 'generated_write', 'wiki://answer')).toMatchObject({
        approval_required: true,
        approved: true,
        decision: 'allow',
      });
      expect(approvalStatus(db, policy, 'source_read')).toMatchObject({
        target_uri: null,
        approval_required: false,
        approved: true,
        decision: 'allow',
      });

      policy.approvals.generatedWritesRequireApproval = false;
      expect(approvalStatus(db, policy, 'generated_write', 'wiki://unseen')).toMatchObject({
        approval_required: false,
        approved: true,
        decision: 'allow',
      });
    } finally {
      db.close();
    }
  });
});
