/**
 * The edge's on-disk layout.
 *
 * IFLOWONE-ARCHITECTURE.md fixes these names. Append-only NDJSON plus a
 * compacted checkpoint was chosen over SQLite so an edge stays portable to any
 * host that can write text — including ones with no native module support.
 *
 * Paths are joined with '/' regardless of platform: the host's StoragePort
 * resolves them, and every filesystem this targets accepts forward slashes.
 */

export const EDGE_DIR = '.iflow/edge'

export interface EdgePaths {
  /** Every fact this node asserts, in origin order. */
  origin: string
  /** Facts queued for a Community that has not acknowledged them yet. */
  outbox: string
  /** Command receipts, for at-most-once execution across restarts. */
  commands: string
  /** Compacted cursors so a restart does not re-read the whole journal. */
  checkpoint: string
  /** Directory cache of peers the Community vouched for. */
  trustedDirectory: string
  /** Scratch files handed to the identity binary; never product state. */
  tmpDir: string
}

export function edgePaths(workspaceRoot: string): EdgePaths {
  const base = `${trimTrailingSlash(workspaceRoot)}/${EDGE_DIR}`
  return {
    origin: `${base}/origin.ndjson`,
    outbox: `${base}/outbox.ndjson`,
    commands: `${base}/commands.ndjson`,
    checkpoint: `${base}/checkpoint.json`,
    trustedDirectory: `${base}/trusted-directory.json`,
    tmpDir: `${base}/tmp`,
  }
}

function trimTrailingSlash(path: string): string {
  return path.replace(/[/\\]+$/, '').replace(/\\/g, '/')
}
