import {
  sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess,
} from "@bb/process-utils";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const WORKTREE_INCLUDE_FILE_NAME = ".worktreeinclude";
const MAX_LIST_OUTPUT_BYTES = 16 * 1024 * 1024;

interface CopyWorktreeIncludeFilesArgs {
  sourcePath: string;
  targetPath: string;
  signal?: AbortSignal | undefined;
}

interface CopyWorktreeIncludeFilesResult {
  ran: boolean;
  copied: string[];
  skipped: string[];
}

const EMPTY_RESULT: CopyWorktreeIncludeFilesResult = {
  ran: false,
  copied: [],
  skipped: [],
};

function hasPattern(contents: string): boolean {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#"));
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readIncludeFile(sourcePath: string): Promise<string | null> {
  try {
    return await fs.readFile(
      path.join(sourcePath, WORKTREE_INCLUDE_FILE_NAME),
      "utf8",
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function listMatchingFiles(
  sourcePath: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnPortableOutputProcess({
      command: "git",
      args: [
        "ls-files",
        "--others",
        "--ignored",
        `--exclude-from=${WORKTREE_INCLUDE_FILE_NAME}`,
        "-z",
      ],
      cwd: sourcePath,
      env: sanitizeInheritedChildProcessEnv({ env: process.env }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_LIST_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.aborted ? signal.reason : error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (stdoutBytes > MAX_LIST_OUTPUT_BYTES) {
        reject(
          new Error(
            `git ls-files produced more than ${MAX_LIST_OUTPUT_BYTES} bytes of output`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`git ls-files failed${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(
        Buffer.concat(stdout).toString("utf8").split("\0").filter(Boolean),
      );
    });
  });
}

async function pathPresent(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isInside(parentRealPath: string, childRealPath: string): boolean {
  const relative = path.relative(parentRealPath, childRealPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function copyWorktreeIncludeFiles(
  args: CopyWorktreeIncludeFilesArgs,
): Promise<CopyWorktreeIncludeFilesResult> {
  const contents = await readIncludeFile(args.sourcePath);
  if (contents === null || !hasPattern(contents)) {
    return EMPTY_RESULT;
  }

  const relativePaths = await listMatchingFiles(args.sourcePath, args.signal);
  if (relativePaths.length === 0) {
    return { ran: true, copied: [], skipped: [] };
  }

  let targetRealPath: string;
  try {
    targetRealPath = await fs.realpath(args.targetPath);
  } catch (error) {
    return {
      ran: true,
      copied: [],
      skipped: [`${args.targetPath}: ${describeError(error)}`],
    };
  }

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const relativePath of relativePaths) {
    args.signal?.throwIfAborted();
    const sourceFile = path.join(args.sourcePath, relativePath);
    const targetFile = path.join(targetRealPath, relativePath);
    try {
      const stats = await fs.lstat(sourceFile);
      if (stats.isSymbolicLink()) {
        skipped.push(`${relativePath}: symlink`);
        continue;
      }
      if (await pathPresent(targetFile)) {
        skipped.push(`${relativePath}: already exists in the worktree`);
        continue;
      }
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      const parentRealPath = await fs.realpath(path.dirname(targetFile));
      if (!isInside(targetRealPath, parentRealPath)) {
        skipped.push(`${relativePath}: destination escapes the worktree`);
        continue;
      }
      await fs.copyFile(sourceFile, targetFile, fsConstants.COPYFILE_EXCL);
      copied.push(relativePath);
    } catch (error) {
      skipped.push(`${relativePath}: ${describeError(error)}`);
    }
  }

  return { ran: true, copied, skipped };
}
