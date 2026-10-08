/**
 * BuildTrack Video Factory - VS2 Chatterbox Path Safety
 *
 * The Chatterbox adapter hands file paths to a foreign process (a Python
 * worker) and receives paths back from it. Both directions must be constrained:
 *
 *   - manifest paths are PORTABLE (repo-relative, no absolute paths at all —
 *     a portable manifest can be moved between hosts), so an absolute path in a
 *     request/response is a hard error, never "helpfully" accepted;
 *   - traversal (`..`, `.`, empty segments) is rejected lexically;
 *   - the resolved path must live inside an EXPLICIT approved root for its role
 *     (reference recordings / output artifacts / scratch);
 *   - a SYMLINK that escapes the approved root is detected by comparing the
 *     realpath of the nearest existing ancestor against the realpath of the
 *     root, so a link cannot smuggle a write outside the approved tree;
 *   - repository SOURCE (`packages/`, `apps/`, `tools/`, `scripts/`, `tests/`,
 *     `.git/`, `node_modules/`) can never be a reference/output/scratch path:
 *     the worker must not be able to overwrite repo source through the adapter.
 *
 * Node-only (fs/path) — imported exclusively by the adapter and its tests.
 */

import fs from 'node:fs';
import path from 'node:path';

export type ChatterboxPathRole = 'reference' | 'output' | 'scratch';

export type ChatterboxPathSafetyCode =
  | 'EMPTY_PATH'
  | 'NON_STRING_PATH'
  | 'ABSOLUTE_PATH'
  | 'TRAVERSAL'
  | 'UNSAFE_CHARS'
  | 'OUTSIDE_APPROVED_ROOTS'
  | 'SYMLINK_ESCAPE'
  | 'PROTECTED_SOURCE_PATH';

export class ChatterboxPathSafetyError extends Error {
  public readonly code: ChatterboxPathSafetyCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: ChatterboxPathSafetyCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ChatterboxPathSafetyError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/*  Approved roots (repo-relative, trailing-slash normalized)          */
/* ------------------------------------------------------------------ */

/** Reference recordings of consenting speakers (Git-ignored). */
export const CHATTERBOX_APPROVED_REFERENCE_ROOTS: readonly string[] = Object.freeze([
  '.voice-references/',
  '.stills/',
]);

/** Output artifacts: dialogue audio and canonical audio live under these. */
export const CHATTERBOX_APPROVED_OUTPUT_ROOTS: readonly string[] = Object.freeze([
  'audio/',
  'output/',
  '.stills/',
  '.chatterbox/',
]);

/** Scratch area the raw engine output is written to before normalization. */
export const CHATTERBOX_APPROVED_SCRATCH_ROOTS: readonly string[] = Object.freeze([
  '.chatterbox/',
  '.stills/',
]);

/** Repository source trees that must never be written through this adapter. */
export const CHATTERBOX_PROTECTED_SOURCE_ROOTS: readonly string[] = Object.freeze([
  'packages/',
  'apps/',
  'tools/',
  'scripts/',
  'tests/',
  '.git/',
  'node_modules/',
]);

export interface ChatterboxPathPolicy {
  /** Absolute repository root the relative paths resolve against. */
  repoRoot: string;
  approvedReferenceRoots?: readonly string[];
  approvedOutputRoots?: readonly string[];
  approvedScratchRoots?: readonly string[];
  /** Test-only escape hatch; production callers must leave this unset. */
  allowProtectedSourcePaths?: boolean;
}

function normalizeRoot(root: string): string {
  const trimmed = root.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return `${trimmed}/`;
}

/** Approved roots for a role, normalized with trailing slashes. */
export function chatterboxApprovedRootsFor(
  role: ChatterboxPathRole,
  policy: ChatterboxPathPolicy
): readonly string[] {
  const roots =
    role === 'reference'
      ? policy.approvedReferenceRoots ?? CHATTERBOX_APPROVED_REFERENCE_ROOTS
      : role === 'output'
        ? policy.approvedOutputRoots ?? CHATTERBOX_APPROVED_OUTPUT_ROOTS
        : policy.approvedScratchRoots ?? CHATTERBOX_APPROVED_SCRATCH_ROOTS;
  return roots.map(normalizeRoot);
}

/* ------------------------------------------------------------------ */
/*  Lexical (portable) checks                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate a portable repo-relative path for a role. Pure lexical checks only;
 * filesystem-level checks happen in `resolveChatterboxPath`.
 */
export function assertPortableRelativePath(value: unknown, role: ChatterboxPathRole): string {
  if (typeof value !== 'string') {
    throw new ChatterboxPathSafetyError('NON_STRING_PATH', `Chatterbox ${role} path must be a string.`, {
      role,
      value,
    });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ChatterboxPathSafetyError('EMPTY_PATH', `Chatterbox ${role} path must not be empty.`, { role });
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new ChatterboxPathSafetyError(
      'ABSOLUTE_PATH',
      `Chatterbox ${role} path must be repo-relative, got absolute: '${trimmed}'.`,
      { role, path: trimmed }
    );
  }
  if (/^[a-zA-Z]:/.test(trimmed)) {
    throw new ChatterboxPathSafetyError(
      'ABSOLUTE_PATH',
      `Chatterbox ${role} path must be repo-relative, got drive path: '${trimmed}'.`,
      { role, path: trimmed }
    );
  }
  const segments = trimmed.split(/[/\\]/);
  if (segments.some((s) => s === '..' || s === '.' || s === '')) {
    throw new ChatterboxPathSafetyError(
      'TRAVERSAL',
      `Chatterbox ${role} path contains forbidden traversal: '${trimmed}'.`,
      { role, path: trimmed }
    );
  }
  if (/[\u0000-\u001f<>:"|?*]/.test(trimmed)) {
    throw new ChatterboxPathSafetyError(
      'UNSAFE_CHARS',
      `Chatterbox ${role} path contains forbidden characters: '${trimmed}'.`,
      { role, path: trimmed }
    );
  }
  return trimmed;
}

/* ------------------------------------------------------------------ */
/*  Filesystem-level checks                                            */
/* ------------------------------------------------------------------ */

/** True when `candidateAbs` is inside `rootAbs` (or equals it). */
export function isPathInside(candidateAbs: string, rootAbs: string): boolean {
  const candidate = path.resolve(candidateAbs);
  const root = path.resolve(rootAbs);
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** realpath of the deepest existing ancestor of a (possibly missing) path. */
function realpathNearestExisting(absolutePath: string): string {
  let current = path.resolve(absolutePath);
  for (;;) {
    if (fs.existsSync(current)) {
      try {
        return fs.realpathSync(current);
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function assertNotProtectedSource(
  relativePath: string,
  role: ChatterboxPathRole,
  policy: ChatterboxPathPolicy
): void {
  if (policy.allowProtectedSourcePaths === true) return;
  const normalized = normalizeRoot(relativePath);
  const protectedRoot = CHATTERBOX_PROTECTED_SOURCE_ROOTS.find((root) =>
    normalized.startsWith(normalizeRoot(root))
  );
  if (protectedRoot) {
    throw new ChatterboxPathSafetyError(
      'PROTECTED_SOURCE_PATH',
      `Chatterbox ${role} path resolves into repository source ('${protectedRoot}') and is refused: '${relativePath}'.`,
      { role, path: relativePath, protectedRoot }
    );
  }
}

function assertInsideApprovedRoot(
  absolutePath: string,
  role: ChatterboxPathRole,
  policy: ChatterboxPathPolicy
): void {
  const repoRootAbs = path.resolve(policy.repoRoot);
  const approved = chatterboxApprovedRootsFor(role, policy);
  if (approved.length === 0) {
    throw new ChatterboxPathSafetyError(
      'OUTSIDE_APPROVED_ROOTS',
      `No approved roots are configured for Chatterbox ${role} paths.`,
      { role }
    );
  }

  const lexicalMatch = approved.find((root) => isPathInside(absolutePath, path.join(repoRootAbs, root)));
  if (!lexicalMatch) {
    throw new ChatterboxPathSafetyError(
      'OUTSIDE_APPROVED_ROOTS',
      `Chatterbox ${role} path is outside the approved roots (${approved.join(', ')}): '${absolutePath}'.`,
      { role, approvedRoots: approved }
    );
  }

  /*
   * Symlink escape check: compare the realpath of the nearest existing ancestor
   * of the target against the realpath of the approved root. A symlinked
   * directory that points outside the root is therefore refused even though its
   * lexical form looked fine.
   */
  const rootAbs = path.join(repoRootAbs, lexicalMatch);
  const realTargetAncestor = realpathNearestExisting(absolutePath);
  const realRoot = realpathNearestExisting(rootAbs);
  const realRepoRoot = realpathNearestExisting(repoRootAbs);
  if (!isPathInside(realTargetAncestor, realRoot) && !isPathInside(realRoot, realTargetAncestor)) {
    throw new ChatterboxPathSafetyError(
      'SYMLINK_ESCAPE',
      `Chatterbox ${role} path escapes its approved root through a symlink: '${absolutePath}'.`,
      { role, approvedRoot: rootAbs, resolvedAncestor: realTargetAncestor, resolvedRoot: realRoot }
    );
  }
  if (!isPathInside(realRoot, realRepoRoot) && !isPathInside(realRepoRoot, realRoot)) {
    throw new ChatterboxPathSafetyError(
      'SYMLINK_ESCAPE',
      `Chatterbox ${role} approved root itself resolves outside the repository: '${rootAbs}'.`,
      { role, approvedRoot: rootAbs, resolvedRoot: realRoot }
    );
  }
}

export interface ResolvedChatterboxPath {
  /** The portable repo-relative path (POSIX separators). */
  relativePath: string;
  /** Absolute path on this machine (adapter-internal; never packaged). */
  absolutePath: string;
}

/**
 * Full validation of one data path: portable lexical form + approved root +
 * symlink-escape + source protection. Throws `ChatterboxPathSafetyError`.
 */
export function resolveChatterboxPath(
  policy: ChatterboxPathPolicy,
  value: unknown,
  role: ChatterboxPathRole
): ResolvedChatterboxPath {
  const relativePath = assertPortableRelativePath(value, role);
  assertNotProtectedSource(relativePath, role, policy);
  const absolutePath = path.resolve(policy.repoRoot, relativePath);
  assertInsideApprovedRoot(absolutePath, role, policy);
  return { relativePath: relativePath.replace(/\\/g, '/'), absolutePath };
}
