import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { assertRemoteTempDir } from '../scripts/lib/remote-temp-dir.mjs';

const repoRoot = resolve(import.meta.dir, '..');
const script = join(repoRoot, 'scripts', 'smoke-machine-sync-release.mjs');
const openFilesBoundaryScript = join(repoRoot, 'scripts', 'smoke-open-files-installed-boundary.mjs');

describe('machine sync release smoke script', () => {
  test('prints help without requiring ssh or installed packages', () => {
    const result = spawnSync(process.execPath, [script, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('smoke-machine-sync-release.mjs');
    expect(result.stdout).toContain('sync doctor');
    expect(result.stdout).toContain('@hasna/machines hidden locally');
    expect(result.stdout).toContain('--peer-workspace omitted');
  });

  test('renders dry-run release evidence plan as JSON', () => {
    const result = spawnSync(process.execPath, [
      script,
      '--dry-run',
      '--json',
      '--remote',
      'linux-node-a',
      '--peer',
      'linux-node-a',
      '--knowledge-version',
      '0.0.0-test',
      '--machines-version',
      '0.0.0-machines',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      dry_run: true,
      remote: 'linux-node-a',
      peer: 'linux-node-a',
      knowledge_version: '0.0.0-test',
      machines_version: '0.0.0-machines',
      no_machines_sync: true,
      no_machines_registry_sync: true,
    });
    expect(output.checks).toContain('run knowledge machines adapter smoke locally and remotely');
    expect(output.checks).toContain('assert artifact manifest modified_at/provenance/raw-source boundary');
    expect(output.checks).toContain('assert final bidirectional dry-run has zero conflicts');
    expect(output.checks).toContain('run isolated installed-package sync with @hasna/machines and machines CLI hidden');
    expect(output.checks).toContain('learn registry fallback then run isolated hidden-machines sync with --peer-workspace omitted');
  });
});

describe('installed open-files boundary smoke script', () => {
  test('prints help without requiring installed files or knowledge commands', () => {
    const result = spawnSync(process.execPath, [openFilesBoundaryScript, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('smoke-open-files-installed-boundary.mjs');
    expect(result.stdout).toContain('installed open-files to open-knowledge source-boundary smoke');
    expect(result.stdout).toContain('scan both knowledge SQLite stores and artifacts');
  });

  test('renders dry-run installed open-files boundary evidence plan as JSON', () => {
    const result = spawnSync(process.execPath, [
      openFilesBoundaryScript,
      '--dry-run',
      '--json',
      '--files-bin',
      'files-test',
      '--knowledge-bin',
      'knowledge-test',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      dry_run: true,
      files_bin: 'files-test',
      knowledge_bin: 'knowledge-test',
    });
    expect(output.checks).toContain('run installed files sources/index/manifest/doctor/resolve/extract-text');
    expect(output.checks).toContain('redact raw sentinel before knowledge ingest');
    expect(output.checks).toContain('scan source and peer knowledge SQLite/artifacts for raw sentinel and base64');
  });
});

/**
 * `runSyncSmoke` sends `rm -rf <remoteDir>` over ssh, where remoteDir came from a remote
 * `mktemp -d`. Taking a delete target on faith from a command's output is the same class of
 * defect as the 2026-07-24 incident, where an empty `$(bun pm cache)` turned
 * `rm -rf "$(cmd)"/*` into `rm -rf /*`.
 *
 * Precisely which case is live: `runRemote` goes through `runChecked`, which throws on a
 * non-zero remote exit, so a *failing* `mktemp -d` (exit 1) aborts the run and never assigns
 * an empty string. The reachable hole is the remote exiting **zero** with stdout that is not
 * the path - an ssh `Banner`, a chatty login profile, or a `ForceCommand` wrapper prepending
 * lines or masking the status. Measured verbatim:
 *
 *     $ echo "Welcome to linux-node-a"; mktemp -d /tmp/knowledge-banner-XXXXXX
 *     Welcome to linux-node-a
 *     /tmp/knowledge-banner-jjuN3k
 *
 * exit 0, so `runChecked` passes it through; the guard rejects it as multi-line.
 *
 * These cases prove the guard rejects bad input rather than merely accepting good input.
 * No `rm` runs here: only the validator is exercised.
 */
describe('remote temp dir guard', () => {
  const remote = 'linux-node-a';
  const template = '/tmp/knowledge-linux-node-a-0.0.0-test-XXXXXX';

  test('accepts what a successful mktemp -d actually returns', () => {
    expect(assertRemoteTempDir(remote, '/tmp/knowledge-linux-node-a-0.0.0-test-Ab3De9', template))
      .toBe('/tmp/knowledge-linux-node-a-0.0.0-test-Ab3De9');
  });

  test('rejects the empty output a failing mktemp -d leaves behind', () => {
    // Defence in depth rather than the live defect: runChecked aborts on a non-zero remote
    // exit, so an empty value cannot reach here via a failing mktemp. It can via a wrapper
    // that exits 0 without printing a path.
    expect(() => assertRemoteTempDir(remote, '', template)).toThrow(/produced no path/);
    expect(() => assertRemoteTempDir(remote, '   '.trim(), template)).toThrow(/produced no path/);
  });

  test('rejects paths that are not a temp dir this template could have created', () => {
    for (const bad of [
      '/',
      '/tmp',
      '/usr',
      '/home/hasna',
      '/tmp/somebody-elses-dir',
      'knowledge-linux-node-a-0.0.0-test-Ab3De9',
      './relative',
      '/tmp/knowledge-linux-node-a-0.0.0-test-Ab3De9/../../etc',
    ]) {
      expect(() => assertRemoteTempDir(remote, bad, template))
        .toThrow(/Refusing to use remote temp dir/);
    }
  });

  test('rejects multi-line output, so only the first line is never silently used', () => {
    expect(() => assertRemoteTempDir(
      remote,
      '/tmp/knowledge-linux-node-a-0.0.0-test-Ab3De9\nmktemp: failed',
      template,
    )).toThrow(/multiple lines/);
  });

  test('the failure names the path and says why it matters', () => {
    expect(() => assertRemoteTempDir(remote, '', template))
      .toThrow(/used as an `rm -rf` target on the remote host/);
  });

  test('rejects a sibling directory that merely shares the temp parent', () => {
    // Checking only the parent directory would accept this, and `rm -rf` would then delete
    // somebody else's directory.
    expect(() => assertRemoteTempDir(remote, '/tmp/somebody-elses-dir', template))
      .toThrow(/does not start with the template prefix/);
  });

  test('rejects a malformed template rather than deriving a bogus bound from it', () => {
    expect(() => assertRemoteTempDir(remote, '/tmp/x', 'relative-XXXXXX'))
      .toThrow(/must be an absolute path/);
    expect(() => assertRemoteTempDir(remote, '/tmp/x', '/tmp/no-placeholder'))
      .toThrow(/must end in at least three X/);
  });

  /**
   * Regression for the review finding that this guard silently degraded into the
   * parent-directory-only check it exists to avoid. With a template like `/tmp/XXXXXX` the
   * derived prefix is a bare directory, so every sibling under it validated:
   * `/tmp/XXXXXX` accepted `/tmp/somebody-elses-dir`, and `/XXXXXX` accepted `/etc`.
   */
  test('refuses a template whose final component is only X, which would accept any sibling', () => {
    for (const badTemplate of ['/tmp/XXXXXX', '/XXXXXX', '/home/hasna/XXXXXXXX']) {
      expect(() => assertRemoteTempDir(remote, '/tmp/anything', badTemplate))
        .toThrow(/must have a fixed prefix in its final component/);
    }
  });

  test('refuses a template containing . or .., which makes the derived bound meaningless', () => {
    // The template is built from a caller-supplied version string.
    expect(() => assertRemoteTempDir(
      remote,
      '/tmp/knowledge-x/../../../home/hasna-AbCdEf',
      '/tmp/knowledge-x/../../../home/hasna-XXXXXX',
    )).toThrow(/must be normalized/);
    expect(() => assertRemoteTempDir(remote, '/tmp/k-AbCdEf', '/tmp/./k-XXXXXX'))
      .toThrow(/must be normalized/);
  });

  test('rejects the bare template prefix, which means mktemp created nothing', () => {
    expect(() => assertRemoteTempDir(remote, '/tmp/knowledge-linux-node-a-0.0.0-test-', template))
      .toThrow(/mktemp created nothing/);
  });

  test('rejects the banner-first shape the docstring calls the live case', () => {
    // Documented as the reachable hole but previously untested: only path-then-junk was
    // covered, never junk-then-path.
    expect(() => assertRemoteTempDir(
      remote,
      'Welcome to linux-node-a\n/tmp/knowledge-linux-node-a-0.0.0-test-Ab3De9',
      template,
    )).toThrow(/multiple lines/);
  });

  test('rejects a suffix mktemp could not have generated', () => {
    const base = '/tmp/knowledge-linux-node-a-0.0.0-test-';
    // mktemp replaces the X run with exactly that many [A-Za-z0-9] characters.
    expect(() => assertRemoteTempDir(remote, `${base}Z`, template)).toThrow(/X run is 6/);
    expect(() => assertRemoteTempDir(remote, `${base}ZZZZZZZZZZ`, template)).toThrow(/X run is 6/);
    expect(() => assertRemoteTempDir(remote, `${base}A B123`, template))
      .toThrow(/characters mktemp never generates/);
    expect(() => assertRemoteTempDir(remote, `${base}$(id)`, template)).toThrow();
    expect(assertRemoteTempDir(remote, `${base}Ab3De9`, template)).toBe(`${base}Ab3De9`);
  });

  test('a suffix containing a separator reports descent, not a charset complaint', () => {
    // The charset rule below would also reject this, but the descent message is the useful
    // one. Asserting the message pins the ordering so the clearer diagnostic cannot be lost.
    expect(() => assertRemoteTempDir(
      remote,
      '/tmp/knowledge-linux-node-a-0.0.0-test-Ab3De9/nested',
      template,
    )).toThrow(/descends below the directory the template would create/);
  });

  test('requires at least three X, the POSIX minimum the template rule cites', () => {
    // Pins the documented boundary: without this, X{3,} could be relaxed to X{1,} unnoticed.
    expect(() => assertRemoteTempDir(remote, '/tmp/k-A', '/tmp/k-X')).toThrow(/at least three X/);
    expect(() => assertRemoteTempDir(remote, '/tmp/k-AB', '/tmp/k-XX')).toThrow(/at least three X/);
    expect(assertRemoteTempDir(remote, '/tmp/k-ABC', '/tmp/k-XXX')).toBe('/tmp/k-ABC');
  });

  test('rejects a relative path even though the template bound implies absoluteness', () => {
    expect(() => assertRemoteTempDir(remote, 'tmp/knowledge-linux-node-a-0.0.0-test-Ab3De9', template))
      .toThrow(/not absolute/);
  });
});
