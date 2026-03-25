import { execFileSync } from "node:child_process";
import type { GitCommit, FileChange } from "../parsers/types.js";

/**
 * Run a git command using execFileSync (no shell) and return stdout trimmed.
 * Returns null if the command fails (e.g. not a git repo).
 */
function gitExec(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse git's --numstat output into FileChange[].
 */
function parseNumstat(raw: string): FileChange[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [added, deleted, path] = line.split("\t");
      const linesAdded = added === "-" ? 0 : parseInt(added, 10);
      const linesDeleted = deleted === "-" ? 0 : parseInt(deleted, 10);
      const status: FileChange["status"] = "modified";
      return { path, status, linesAdded, linesDeleted };
    });
}

/**
 * Get the status (added/modified/deleted) for files in a commit using --name-status.
 */
function getFileStatuses(
  sha: string,
  cwd: string,
): Record<string, FileChange["status"]> {
  const raw = gitExec(
    ["diff-tree", "--no-commit-id", "-r", "--name-status", sha],
    cwd,
  );
  if (!raw) return {};
  const map: Record<string, FileChange["status"]> = {};
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [flag, ...pathParts] = line.split("\t");
    const path = pathParts[pathParts.length - 1]; // handle renames — take destination
    if (flag.startsWith("A")) map[path] = "added";
    else if (flag.startsWith("D")) map[path] = "deleted";
    else map[path] = "modified";
  }
  return map;
}

/**
 * Return commits since the given date.
 * Gracefully returns [] if the directory is not a git repo or the repo is empty.
 */
export function getCommitsSince(
  since: Date,
  cwd: string = process.cwd(),
): GitCommit[] {
  const iso = since.toISOString();
  const raw = gitExec(
    ["log", `--after=${iso}`, "--no-merges", "--format=%H%x00%s%x00%aI%x00%aN%x00"],
    cwd,
  );
  if (!raw) return [];

  const commits: GitCommit[] = [];
  const entries = raw.split("\n").filter((l) => l.length > 0);

  for (const entry of entries) {
    const [sha, message, timestamp, author] = entry.split("\0");
    if (!sha) continue;
    const filesChanged = getFilesChanged(sha, cwd);
    commits.push({ sha, message, timestamp, author, filesChanged });
  }

  return commits;
}

/**
 * Return the files changed in a single commit.
 */
export function getFilesChanged(
  commitSha: string,
  cwd: string = process.cwd(),
): FileChange[] {
  const numstatRaw = gitExec(
    ["diff-tree", "--no-commit-id", "-r", "--numstat", commitSha],
    cwd,
  );
  if (!numstatRaw) return [];

  const changes = parseNumstat(numstatRaw);
  const statuses = getFileStatuses(commitSha, cwd);

  for (const change of changes) {
    if (statuses[change.path]) {
      change.status = statuses[change.path];
    }
  }

  return changes;
}

/**
 * Filter commits whose timestamp falls within [startTime, endTime].
 * Both bounds are ISO-8601 strings.
 */
export function correlateCommitToTimeRange(
  commits: GitCommit[],
  startTime: string,
  endTime: string,
): GitCommit[] {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();

  return commits.filter((c) => {
    const t = new Date(c.timestamp).getTime();
    return t >= start && t <= end;
  });
}
