import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openKnowledgeDb } from '../src/knowledge-db';
import { ingestSourceRef } from '../src/source-ingest';
import { defaultKnowledgeConfig, type KnowledgeConfig } from '../src/workspace';
import type { SafetyPolicy } from '../src/safety';

function sourcePolicy(input: { web?: boolean; s3?: boolean; buckets?: string[]; writeRoot?: string } = {}): SafetyPolicy {
  return {
    mode: 'local',
    allowWriteRoots: input.writeRoot ? [resolve(input.writeRoot)] : [],
    readOnlySourceAccess: true,
    network: {
      webSearchEnabled: input.web ?? false,
      s3ReadsEnabled: input.s3 ?? false,
      allowedS3Buckets: input.buckets ?? [],
    },
    redaction: { enabled: true },
    approvals: { generatedWritesRequireApproval: true },
  };
}

function configWithoutFileSources(): KnowledgeConfig {
  const config = defaultKnowledgeConfig();
  config.sources.allowed_schemes = config.sources.allowed_schemes.filter((scheme) => scheme !== 'file');
  return config;
}

describe('source ref ingestion', () => {
  test('ingests a file as read-only text using the default purpose', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-source-file-'));
    const dbPath = join(dir, 'knowledge.db');
    const sourcePath = join(dir, 'Team Guide.md');
    writeFileSync(sourcePath, 'A direct source document for the knowledge catalog.');
    const sourceRef = pathToFileURL(sourcePath).href;

    const result = await ingestSourceRef({
      dbPath,
      sourceRef,
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
    });
    expect(result.hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const db = openKnowledgeDb(dbPath);
    try {
      const row = db.query<{ title: string; acl_json: string }, []>('SELECT title, acl_json FROM sources LIMIT 1').get();
      expect(row?.title).toBe('Team Guide.md');
      expect(JSON.parse(row!.acl_json)).toMatchObject({
        mode: 'read_only',
        allowed_purposes: ['knowledge_index'],
      });
    } finally {
      db.close();
    }
  });

  test('accepts an empty file without inventing a text chunk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-source-empty-'));
    const sourcePath = join(dir, 'empty.txt');
    writeFileSync(sourcePath, '');

    const result = await ingestSourceRef({
      dbPath: join(dir, 'knowledge.db'),
      sourceRef: pathToFileURL(sourcePath).href,
    });

    expect(result.content_source).toBe('file');
    expect(result.items_seen).toBe(1);
    expect(result.chunks_inserted).toBe(0);
  });

  test('rejects missing files, empty refs, and file refs disabled by config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-source-refusal-'));
    const sourcePath = join(dir, 'missing.txt');
    const sourceRef = pathToFileURL(sourcePath).href;

    await expect(ingestSourceRef({ dbPath: join(dir, 'missing.db'), sourceRef })).rejects.toThrow('Source file not found');
    await expect(ingestSourceRef({ dbPath: join(dir, 'empty.db'), sourceRef: '' })).rejects.toThrow('Unsupported source ref scheme');
    await expect(ingestSourceRef({
      dbPath: join(dir, 'disabled.db'),
      sourceRef,
      config: configWithoutFileSources(),
    })).rejects.toThrow('local_file_uri:1');
  });

  test('rejects unresolved open-files refs and malformed S3 refs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-source-invalid-'));
    await expect(ingestSourceRef({
      dbPath: join(dir, 'open-files.db'),
      sourceRef: 'open-files://file/not-cataloged',
    })).rejects.toThrow('not in the local knowledge catalog');
    await expect(ingestSourceRef({
      dbPath: join(dir, 's3.db'),
      sourceRef: 's3://fixture-bucket',
    })).rejects.toThrow('Missing object key');
  });

  test('refuses S3 reads before loading the remote client when policy disables them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-source-s3-'));
    await expect(ingestSourceRef({
      dbPath: join(dir, 'knowledge.db'),
      sourceRef: 's3://fixture-bucket/guide.md',
      safetyPolicy: sourcePolicy({ s3: false, buckets: ['fixture-bucket'] }),
    })).rejects.toThrow('Safety policy denied S3 read');
  });

  test('fetches loopback HTML, strips active markup, and records web metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-source-web-'));
    const dbPath = join(dir, 'knowledge.db');
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response(
          '<h1>Guide &amp; Notes</h1><script>doNotIndex()</script><style>.hidden{}</style><p>Body &lt;ok&gt;</p>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      },
    });
    try {
      const sourceRef = `http://127.0.0.1:${server.port}/docs/guide.html`;
      const result = await ingestSourceRef({
        dbPath,
        sourceRef,
        safetyPolicy: sourcePolicy({ web: true, writeRoot: dir }),
      });
      expect(result).toMatchObject({
        source_ref: sourceRef,
        content_source: 'web',
        read_only: true,
        chunks_inserted: 1,
      });

      const db = openKnowledgeDb(dbPath);
      try {
        const source = db.query<{ title: string; metadata_json: string }, []>('SELECT title, metadata_json FROM sources LIMIT 1').get();
        const chunk = db.query<{ text: string }, []>('SELECT text FROM chunks LIMIT 1').get();
        expect(source?.title).toBe('guide.html');
        expect(JSON.parse(source!.metadata_json)).toMatchObject({
          url: sourceRef,
          metadata: { url: sourceRef, content_source: 'web', read_only: true },
        });
        expect(chunk?.text).toBe('Guide & Notes Body <ok>');
        expect(chunk?.text).not.toContain('doNotIndex');
      } finally {
        db.close();
      }
    } finally {
      server.stop();
    }
  });

  test('surfaces HTTP failures and policy refusal without ingesting content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-source-web-errors-'));
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests += 1;
        return new Response('unavailable', { status: 503 });
      },
    });
    try {
      const sourceRef = `http://127.0.0.1:${server.port}/unavailable`;
      await expect(ingestSourceRef({
        dbPath: join(dir, 'http-error.db'),
        sourceRef,
        safetyPolicy: sourcePolicy({ web: true }),
      })).rejects.toThrow('Web source read failed 503');
      expect(requests).toBe(1);

      await expect(ingestSourceRef({
        dbPath: join(dir, 'policy-error.db'),
        sourceRef,
        safetyPolicy: sourcePolicy({ web: false }),
      })).rejects.toThrow('Safety policy denied web search');
      expect(requests).toBe(1);
    } finally {
      server.stop();
    }
  });
});
