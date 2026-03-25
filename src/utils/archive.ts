import {
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { join, basename } from "node:path";

/**
 * Format a Date as YYYYMMDD-HHMM.
 */
function formatTimestamp(date: Date): string {
  const yyyy = date.getFullYear().toString();
  const mm = (date.getMonth() + 1).toString().padStart(2, "0");
  const dd = date.getDate().toString().padStart(2, "0");
  const hh = date.getHours().toString().padStart(2, "0");
  const min = date.getMinutes().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

/**
 * If any of the given file paths exist, move them into an archive subdirectory
 * named with a YYYYMMDD-HHMM timestamp. Returns the archive path if files
 * were archived, or undefined if nothing to archive.
 */
export function archivePrevious(
  files: string[],
  archiveBaseDir: string,
): string | undefined {
  const existing = files.filter((f) => existsSync(f));
  if (existing.length === 0) {
    return undefined;
  }

  const timestamp = formatTimestamp(new Date());
  const archiveDir = join(archiveBaseDir, timestamp);
  mkdirSync(archiveDir, { recursive: true });

  for (const filePath of existing) {
    const dest = join(archiveDir, basename(filePath));
    try {
      renameSync(filePath, dest);
    } catch {
      // Cross-device fallback: copy then delete
      copyFileSync(filePath, dest);
      unlinkSync(filePath);
    }
  }

  // Derive a friendly relative label for the log message
  const relativeArchive = archiveDir.includes("archive")
    ? archiveDir.slice(archiveDir.indexOf("archive"))
    : archiveDir;

  console.log(`Archived previous reports to ${relativeArchive}/`);
  return archiveDir;
}
