import { afterEach, describe, expect, test } from 'bun:test';
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

const SAFETY_ENV_KEYS = [
  'HASNA_KNOWLEDGE_ALLOWED_S3_BUCKETS',
  'HASNA_KNOWLEDGE_ALLOW_S3_READS',
  'HASNA_KNOWLEDGE_WEB_SEARCH',
] as const;
const originalSafetyEnv = Object.fromEntries(SAFETY_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of SAFETY_ENV_KEYS) {
    const original = originalSafetyEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function policyFor(root: string): SafetyPolicy {
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

describe('safety policy resolution and enforcement', () => {
  test('resolves defaults, configured storage, and environment opt-ins', () => {
    for (const key of SAFETY_ENV_KEYS) delete process.env[key];
    const home = mkdtempSync(join(tmpdir(), 'knowledge-safety-policy-'));
    const workspace = workspaceForHome(home);
    const defaults = resolveSafetyPolicy(defaultKnowledgeConfig(), workspace);

    expect(defaults).toMatchObject({
      mode: 'local',
      readOnlySourceAccess: true,
      network: { webSearchEnabled: false, s3ReadsEnabled: false, allowedS3Buckets: [] },
      redaction: { enabled: true },
      approvals: { generatedWritesRequireApproval: true },
    });
    expect(defaults.allowWriteRoots).toContain(resolve(workspace.home));
    expect(defaults.allowWriteRoots).toContain(resolve(workspace.wikiDir));

    process.env.HASNA_KNOWLEDGE_WEB_SEARCH = 'yes';
    process.env.HASNA_KNOWLEDGE_ALLOW_S3_READS = '1';
    process.env.HASNA_KNOWLEDGE_ALLOWED_S3_BUCKETS = 'zeta, alpha, zeta, ';
    const configured = defaultKnowledgeConfig();
    configured.storage = {
      type: 's3',
      artifacts_root: 'artifacts',
      s3: { bucket: 'storage-bucket' },
    };
    delete configured.safety;

    expect(resolveSafetyPolicy(configured, workspace).network).toEqual({
      webSearchEnabled: true,
      s3ReadsEnabled: true,
      allowedS3Buckets: ['alpha', 'storage-bucket', 'zeta'],
    });

    configured.safety = {
      network: { web_search_enabled: false, s3_reads_enabled: false, allowed_s3_buckets: ['configured'] },
      redaction: { enabled: false },
      approvals: { generated_writes_require_approval: false },
    };
    const explicit = resolveSafetyPolicy(configured, workspace);
    expect(explicit.network.webSearchEnabled).toBe(false);
    expect(explicit.network.s3ReadsEnabled).toBe(false);
    expect(explicit.redaction.enabled).toBe(false);
    expect(explicit.approvals.generatedWritesRequireApproval).toBe(false);
  });

  test('allows writes within a configured root and refuses sibling paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-safety-write-'));
    const policy = policyFor(root);

    expect(() => assertWriteAllowed(root, policy)).not.toThrow();
    expect(() => assertWriteAllowed(join(root, 'nested', 'knowledge.db'), policy)).not.toThrow();
    expect(() => assertWriteAllowed(`${root}-sibling/knowledge.db`, policy)).toThrow(
      'Safety policy denied write outside .hasna/knowledge',
    );
  });

  test('enforces S3 enablement and the bucket allowlist', () => {
    const policy = policyFor('/tmp/knowledge-safety-s3');
    expect(() => assertS3ReadAllowed('s3://allowed/key', policy)).toThrow('Safety policy denied S3 read');

    policy.network.s3ReadsEnabled = true;
    expect(() => assertS3ReadAllowed('s3://blocked/key', policy)).toThrow('denied S3 bucket "blocked"');
    policy.network.allowedS3Buckets.push('allowed');
    expect(() => assertS3ReadAllowed('s3://allowed/key', policy)).not.toThrow();
    expect(() => assertS3ReadAllowed('not a uri', policy)).toThrow();
  });

  test('enforces the web-search opt-in', () => {
    const policy = policyFor('/tmp/knowledge-safety-web');
    expect(() => assertWebSearchAllowed(policy)).toThrow('Safety policy denied web search');
    policy.network.webSearchEnabled = true;
    expect(() => assertWebSearchAllowed(policy)).not.toThrow();
  });
});

describe('secret redaction', () => {
  test('redacts supported token shapes and reports their source ranges', () => {
    const input = [
      'api_key=abcdefghijk',
      'sk-1234567890abcdefghij',
      'ghp_1234567890abcdefghij',
      'AKIA1234567890ABCDEF',
    ].join('\n');
    const result = redactSecrets(input);

    expect(result.text).not.toContain('abcdefghijk');
    expect(result.text).toContain('[REDACTED:secret_assignment]');
    expect(result.text).toContain('[REDACTED:openai_api_key]');
    expect(result.text).toContain('[REDACTED:github_token]');
    expect(result.text).toContain('[REDACTED:aws_access_key_id]');
    expect(result.findings.map((finding) => finding.type)).toEqual([
      'secret_assignment',
      'openai_api_key',
      'aws_access_key_id',
      'github_token',
    ]);
    expect(result.findings.every((finding) => finding.end > finding.start)).toBe(true);
  });

  test('returns empty input unchanged and honors disabled redaction', () => {
    expect(redactSecrets('')).toEqual({ text: '', findings: [] });
    const secret = 'token=abcdefghijk';
    expect(redactSecrets(secret, { redaction: { enabled: false } })).toEqual({ text: secret, findings: [] });
  });
});

describe('safety audit and approval persistence', () => {
  test('creates unique audit ids with the expected opaque shape', () => {
    const input = { event_type: 'write', action: 'test', decision: 'allow' as const };
    const first = auditId(input);
    const second = auditId(input);
    expect(first).toMatch(/^audit_[a-f0-9]{24}$/);
    expect(second).toMatch(/^audit_[a-f0-9]{24}$/);
    expect(second).not.toBe(first);
  });

  test('records bounded audit metadata and handles empty redaction findings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-safety-audit-'));
    const dbPath = join(dir, 'knowledge.db');
    migrateKnowledgeDb(dbPath);
    const db = openKnowledgeDb(dbPath);
    try {
      const createdAt = '2026-07-29T12:00:00.000Z';
      const id = recordAuditEvent(db, {
        event_type: 'source_read',
        action: 'unit_test',
        target_uri: 's3://allowed/item',
        decision: 'allow',
        metadata: { long: 'x'.repeat(1005), many: Array.from({ length: 27 }, (_, index) => index) },
        created_at: createdAt,
      });
      const row = db.query<{
        target_uri: string;
        metadata_json: string;
        created_at: string;
      }, [string]>('SELECT target_uri, metadata_json, created_at FROM audit_events WHERE id = ?').get(id);
      const metadata = JSON.parse(row?.metadata_json ?? '{}') as { long: string; many: unknown[] };
      expect(row).toMatchObject({ target_uri: 's3://allowed/item', created_at: createdAt });
      expect(metadata.long).toEndWith('[Truncated:5 chars]');
      expect(metadata.many).toHaveLength(26);
      expect(metadata.many.at(-1)).toBe('[Truncated:2 items]');

      expect(recordRedactionFindings(db, { findings: [] })).toBe(0);
      expect(recordRedactionFindings(db, {
        source_uri: 'open-files://file/test',
        findings: [
          { type: 'token', severity: 'high', start: 2, end: 12 },
          { type: 'password', severity: 'medium', start: 20, end: 30 },
        ],
        metadata: { detector: 'unit' },
        created_at: createdAt,
      })).toBe(2);
      const findings = db.query<{ finding_type: string; metadata_json: string }, []>(
        'SELECT finding_type, metadata_json FROM redaction_findings ORDER BY finding_type',
      ).all();
      expect(findings.map((finding) => finding.finding_type)).toEqual(['password', 'token']);
      expect(JSON.parse(findings[1].metadata_json)).toEqual({ detector: 'unit', start: 2, end: 12 });
    } finally {
      db.close();
    }
  });

  test('persists approvals and reports required, approved, and unneeded decisions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-safety-approval-'));
    const dbPath = join(dir, 'knowledge.db');
    migrateKnowledgeDb(dbPath);
    const db = openKnowledgeDb(dbPath);
    const policy = policyFor(dir);
    try {
      expect(hasApproval(db, 'generated_write', 'wiki/page.md')).toBe(false);
      expect(approvalStatus(db, policy, 'generated_write', 'wiki/page.md')).toEqual({
        action: 'generated_write',
        target_uri: 'wiki/page.md',
        approval_required: true,
        approved: false,
        decision: 'requires_approval',
      });

      const gate = createApprovalGate(db, {
        action: 'generated_write',
        target_uri: 'wiki/page.md',
        reason: 'reviewed',
        metadata: { ticket: 'OPE53-00024' },
        created_at: '2026-07-29T12:00:00.000Z',
      });
      expect(gate.id).toStartWith('approval_');
      expect(gate.status).toBe('approved');
      expect(hasApproval(db, 'generated_write', 'wiki/page.md')).toBe(true);
      expect(hasApproval(db, 'generated_write', 'wiki/other.md')).toBe(false);
      expect(approvalStatus(db, policy, 'generated_write', 'wiki/page.md').decision).toBe('allow');
      expect(approvalStatus(db, policy, 'source_read').approval_required).toBe(false);

      createApprovalGate(db, { action: 'global_action' });
      expect(hasApproval(db, 'global_action', 'any-target')).toBe(true);
      const stored = db.query<{ approved_by: string; target_uri: string | null }, [string]>(
        'SELECT approved_by, target_uri FROM approval_gates WHERE id = ?',
      ).get(gate.id);
      expect(stored).toEqual({ approved_by: 'local-cli', target_uri: 'wiki/page.md' });
    } finally {
      db.close();
    }
  });
});
