import type { BypassAPI } from "./types";

/**
 * Committed inert stub.
 *
 * Production builds use this file as-is: every method returns null and
 * `isActive` is false. Every bypass branch in production code becomes a
 * no-op, so an accidental `NEXT_PUBLIC_DEV_BYPASS_AUTH=true` on a deployed
 * backend cannot activate the bypass: the activation logic isn't here.
 *
 * To activate locally:
 *   1. Replace this file's `bypass` export with a real implementation that
 *      reads NEXT_PUBLIC_DEV_BYPASS_AUTH and returns fixtures from
 *      `./fixtures`. The exact code lives in CLAUDE.md > Local development.
 *   2. `git update-index --skip-worktree src/lib/devBypass/local.ts`
 *      so your local activation never gets committed.
 *
 * The committed stub stays here. Your local override never reaches GitHub.
 */
export const bypass: BypassAPI = {
  isActive: false,
  getAuthUser: () => null,
  getAuthSnapshot: () => null,
  getServerUser: () => null,
  getUsers: () => null,
  getProjects: () => null,
  getTasks: () => null,
  getTask: () => null,
};
