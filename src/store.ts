/**
 * @hasna/knowledge
 * Copyright 2026 Hasna Inc.
 * Licensed under the Apache License, Version 2.0
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ensureParentDir, globalKnowledgeHome, legacyGlobalStorePath, workspaceForHome } from './workspace';

export interface KnowledgeItem {
  id: string;
  short_id?: string | null;
  title: string;
  content: string;
  url: string | null;
  tags: string[];
  metadata?: Record<string, unknown>;
  archived?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Store {
  items: KnowledgeItem[];
}

export function defaultStorePath(): string {
  return workspaceForHome(globalKnowledgeHome()).jsonStorePath;
}

export function ensureStore(path: string): void {
  if (!existsSync(path)) {
    ensureParentDir(path);
    if (path === defaultStorePath() && existsSync(legacyGlobalStorePath())) {
      writeFileAtomic(path, readFileSync(legacyGlobalStorePath(), 'utf8'));
    } else {
      writeFileAtomic(path, `${JSON.stringify({ items: [] }, null, 2)}\n`);
    }
  }
}

export function loadStoreIfExists(path: string): Store & { exists: boolean } {
  if (!existsSync(path)) return { exists: false, items: [] };
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Store;
  if (!parsed || !Array.isArray(parsed.items)) {
    return { exists: true, items: [] };
  }
  return { exists: true, items: parsed.items };
}

function lockPath(path: string): string {
  return `${path}.lock`;
}

const LOCK_MAX_WAIT_MS = 10000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 120000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function errCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function syncParentDir(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort across platforms/filesystems.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function writeFileAtomic(path: string, contents: string): void {
  ensureParentDir(path);
  const tmp = join(dirname(path), `.${basename(path)}.tmp.${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    syncParentDir(path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function processIsAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errCode(error) !== 'ESRCH';
  }
}

function lockIsStale(path: string, now: number): boolean {
  try {
    const raw = readFileSync(path, 'utf8');
    const lock = JSON.parse(raw) as { pid?: unknown; ts?: unknown };
    if (typeof lock.ts === 'number') {
      return now - lock.ts > LOCK_STALE_MS && !processIsAlive(lock.pid);
    }
  } catch {}

  try {
    return now - lstatSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function moveStaleLock(path: string): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const stalePath = `${path}.stale.${stamp}.${randomUUID()}`;
  try {
    renameSync(path, stalePath);
  } catch (error) {
    if (errCode(error) !== 'ENOENT') throw error;
    return;
  }
}

function breakStaleLock(lockPath: string): void {
  const owner = randomUUID();
  const breakerPath = `${lockPath}.breaker`;
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_WAIT_MS) {
    if (tryAcquireLock(breakerPath, owner)) {
      try {
        if (lockIsStale(lockPath, Date.now())) {
          moveStaleLock(lockPath);
        }
      } finally {
        releaseLock(breakerPath, owner);
      }
      return;
    }
    sleepSync(LOCK_RETRY_MS);
  }
  throw new Error(`Could not acquire stale-lock breaker on ${breakerPath} after ${LOCK_MAX_WAIT_MS}ms`);
}

function tryAcquireLock(path: string, ownerId: string): boolean {
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(path, 'wx', 0o600);
    created = true;
    writeFileSync(fd, `${JSON.stringify({ owner: ownerId, pid: process.pid, ts: Date.now() })}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    syncParentDir(path);
    return true;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (created) {
      try {
        unlinkSync(path);
      } catch {}
    }
    if (errCode(error) === 'EEXIST') return false;
    throw error;
  }
}

function acquireLock(lockPath: string, ownerId: string): void {
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_WAIT_MS) {
    if (tryAcquireLock(lockPath, ownerId)) return;
    if (lockIsStale(lockPath, Date.now())) {
      breakStaleLock(lockPath);
    }
    sleepSync(LOCK_RETRY_MS);
  }
  throw new Error(`Could not acquire lock on ${lockPath} after ${LOCK_MAX_WAIT_MS}ms`);
}

function releaseLock(lockPath: string, ownerId: string): void {
  try {
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { owner: string; ts: number };
      if (lock.owner === ownerId) {
        unlinkSync(lockPath);
      }
    }
  } catch {}
}

export function loadStore(path: string): Store {
  ensureStore(path);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Store;
  if (!parsed || !Array.isArray(parsed.items)) {
    return { items: [] };
  }
  return parsed;
}

export function saveStore(path: string, store: Store): void {
  writeFileAtomic(path, `${JSON.stringify(store, null, 2)}\n`);
}

export function withLock<T>(path: string, fn: () => T, options: { createParent?: boolean } = {}): T {
  const owner = randomUUID();
  const lpath = lockPath(path);
  if (options.createParent) ensureParentDir(lpath);
  acquireLock(lpath, owner);
  try {
    return fn();
  } finally {
    releaseLock(lpath, owner);
  }
}

export function makeId(): string {
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeShortId(id: string): string {
  return id.replace(/^k_/, '').slice(0, 12);
}
