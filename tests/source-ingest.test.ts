import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openKnowledgeDb } from '../src/knowledge-db';
import { ingestOpenFilesManifestItems } from '../src/manifest-ingest';
import { ingestSourceRef } from '../src/source-ingest';
import type { SafetyPolicy } from '../src/safety';
import { defaultKnowledgeConfig } from '../src/workspace';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function policyFor(root: string, webSearchEnabled = false): SafetyPolicy {
  return {
    mode: 'local',
    allowWriteRoots: [resolve(root)],
    readOnlySourceAccess: true,
    network: { webSearchEnabled, s3ReadsEnabled: false, allowedS3Buckets: [] },
    redaction: { enabled: true },
    approvals: { generatedWritesRequireApproval: true },
  };
}

describe('source-ref file ingestion', () => {
  test('ingests a file as read-only catalog content with a stable hash', async () => {
    const dir = tempDir('knowledge-source-file-');
    const dbPath = join(dir, 'knowledge.db');
    const sourcePath = join(dir, 'handbook.md');
    const text = 'The handbook requires observable unit-test assertions.';
    writeFileSync(sourcePath, text);
    const sourceRef = `file://${sourcePath}`;

    const result = await ingestSourceRef({
      dbPath,
      sourceRef,
      purpose: 'knowledge_index',
      now: new Date('2026-07-29T12:00:00.000Z'),
    });
    expect(result).toMatchObject({
      source_ref: sourceRef,
      content_source: 'file',
      read_only: true,
      items_seen: 1,
      sources_upserted: 1,
      revisions_upserted: 1,
      chunks_inserted: 1,
      skipped: 0,
      hash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
    });
    expect(result.items_preview).toEqual([{
      source_ref: sourceRef,
      title: 'handbook.md',
      status: 'active',
      has_text: true,
    }]);

    const db = openKnowledgeDb(dbPath);
    try {
      const source = db.query<{ uri: string; kind: string; acl_json: string }, []>(
        'SELECT uri, kind, acl_json FROM sources LIMIT 1',
      ).get();
      const chunk = db.query<{ text: string }, []>('SELECT text FROM chunks LIMIT 1').get();
      expect(source).toMatchObject({ uri: sourceRef, kind: 'file' });
      expect(JSON.parse(source?.acl_json ?? '{}')).toMatchObject({
        mode: 'read_only',
        allowed_purposes: ['knowledge_index'],
      });
      expect(chunk?.text).toBe(text);
    } finally {
      db.close();
    }
  });

  test('accepts an empty file without inventing chunks', async () => {
    const dir = tempDir('knowledge-source-empty-');
    const sourcePath = join(dir, 'empty.txt');
    writeFileSync(sourcePath, '');

    const result = await ingestSourceRef({ dbPath: join(dir, 'knowledge.db'), sourceRef: `file://${sourcePath}` });
    expect(result.items_seen).toBe(1);
    expect(result.chunks_inserted).toBe(0);
    expect(result.hash).toBe(`sha256:${createHash('sha256').update('').digest('hex')}`);
  });

  test('refuses missing files and file refs disabled by config', async () => {
    const dir = tempDir('knowledge-source-file-errors-');
    const missing = join(dir, 'missing.md');
    await expect(ingestSourceRef({
      dbPath: join(dir, 'missing.db'),
      sourceRef: `file://${missing}`,
    })).rejects.toThrow(`Source file not found: ${missing}`);

    const existing = join(dir, 'existing.md');
    writeFileSync(existing, 'content');
    const config = defaultKnowledgeConfig();
    config.sources.allowed_schemes = ['open-files', 's3', 'https'];
    await expect(ingestSourceRef({
      dbPath: join(dir, 'disabled.db'),
      sourceRef: `file://${existing}`,
      config,
    })).rejects.toThrow('Knowledge private-ref lint failed (local_file_uri:1)');
  });
});

describe('source-ref web and S3 safety', () => {
  test('fetches loopback HTML, strips markup, and reports HTTP failures', async () => {
    const dir = tempDir('knowledge-source-web-');
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/missing') return new Response('missing', { status: 404 });
        return new Response(
          '<html><style>.hidden{}</style><script>secret()</script><body>Research &amp; Development&nbsp;Guide</body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      },
    });
    try {
      const sourceRef = `http://127.0.0.1:${server.port}/guide.html`;
      const result = await ingestSourceRef({
        dbPath: join(dir, 'knowledge.db'),
        sourceRef,
        safetyPolicy: policyFor(dir, true),
      });
      expect(result).toMatchObject({ content_source: 'web', read_only: true, chunks_inserted: 1 });
      const db = openKnowledgeDb(join(dir, 'knowledge.db'));
      try {
        const chunk = db.query<{ text: string }, []>('SELECT text FROM chunks LIMIT 1').get();
        expect(chunk?.text).toBe('Research & Development Guide');
        expect(chunk?.text).not.toContain('secret()');
      } finally {
        db.close();
      }

      await expect(ingestSourceRef({
        dbPath: join(dir, 'missing.db'),
        sourceRef: `http://127.0.0.1:${server.port}/missing`,
        safetyPolicy: policyFor(dir, true),
      })).rejects.toThrow('Web source read failed 404');
    } finally {
      server.stop();
    }
  });

  test('refuses web and S3 reads before transport when policy disables them', async () => {
    const dir = tempDir('knowledge-source-network-denied-');
    const policy = policyFor(dir);
    await expect(ingestSourceRef({
      dbPath: join(dir, 'web.db'),
      sourceRef: 'https://knowledge.invalid/guide',
      safetyPolicy: policy,
    })).rejects.toThrow('Safety policy denied web search');
    await expect(ingestSourceRef({
      dbPath: join(dir, 's3.db'),
      sourceRef: 's3://private-bucket/guide.md',
      safetyPolicy: policy,
    })).rejects.toThrow('Safety policy denied S3 read');
  });
});

describe('open-files source ingestion', () => {
  test('re-ingests resolved catalog chunks through the exported source path', async () => {
    const dir = tempDir('knowledge-source-catalog-');
    const dbPath = join(dir, 'knowledge.db');
    const sourceRef = 'open-files://file/catalog-file/revision/rev-1';
    await ingestOpenFilesManifestItems({
      dbPath,
      sourceLabel: 'unit fixture',
      items: [{
        source_ref: sourceRef,
        name: 'Catalog Guide',
        hash: 'sha256:catalog',
        permissions: { mode: 'read_only', allowed_purposes: ['knowledge_index'] },
        extracted_text: 'Catalog chunks are available for source ingestion.',
      }],
    });

    const result = await ingestSourceRef({ dbPath, sourceRef, purpose: 'knowledge_index' });
    expect(result).toMatchObject({
      source_ref: sourceRef,
      content_source: 'catalog_chunks',
      read_only: true,
      hash: 'sha256:catalog',
      items_seen: 1,
      chunks_inserted: 1,
      chunks_deleted: 1,
    });
  });

  test('loads an extracted text file when the catalog has no chunks', async () => {
    const dir = tempDir('knowledge-source-extracted-ref-');
    const dbPath = join(dir, 'knowledge.db');
    const textPath = join(dir, 'extracted.txt');
    const text = 'Text loaded from the catalog revision extracted-text reference.';
    writeFileSync(textPath, text);
    const sourceRef = 'open-files://file/external-text/revision/rev-2';
    await ingestOpenFilesManifestItems({
      dbPath,
      sourceLabel: 'unit fixture',
      items: [{
        source_ref: sourceRef,
        name: 'External Text',
        permissions: { mode: 'read_only', allowed_purposes: ['knowledge_index'] },
        extracted_text_ref: `file://${textPath}`,
      }],
    });

    const result = await ingestSourceRef({
      dbPath,
      sourceRef,
      purpose: 'knowledge_index',
      config: defaultKnowledgeConfig(),
    });
    expect(result.content_source).toBe('extracted_text_ref');
    expect(result.chunks_inserted).toBe(1);
    expect(result.hash).toBe(`sha256:${createHash('sha256').update(text).digest('hex')}`);
  });

  test('reports missing catalog entries, absent text, and permission refusal', async () => {
    const dir = tempDir('knowledge-source-catalog-errors-');
    const dbPath = join(dir, 'knowledge.db');
    await expect(ingestSourceRef({
      dbPath,
      sourceRef: 'open-files://file/not-ingested',
    })).rejects.toThrow('Open-files source is not in the local knowledge catalog');

    const noTextRef = 'open-files://file/no-text/revision/rev-1';
    const deniedRef = 'open-files://file/denied/revision/rev-1';
    await ingestOpenFilesManifestItems({
      dbPath,
      sourceLabel: 'unit fixture',
      items: [
        { source_ref: noTextRef, permissions: { mode: 'read_only' } },
        {
          source_ref: deniedRef,
          permissions: { mode: 'read_only', denied_purposes: ['knowledge_index'] },
          extracted_text: 'This content exists but its requested purpose is denied.',
        },
      ],
    });
    await expect(ingestSourceRef({ dbPath, sourceRef: noTextRef })).rejects.toThrow(
      'Open-files source has no extracted text chunks yet',
    );
    await expect(ingestSourceRef({
      dbPath,
      sourceRef: deniedRef,
      purpose: 'knowledge_index',
    })).rejects.toThrow('Purpose is explicitly denied');
  });
});
