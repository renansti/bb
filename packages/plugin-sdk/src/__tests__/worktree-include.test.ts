import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { experimental_copyWorktreeIncludeFiles as copyWorktreeIncludeFiles } from "../host.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeNestedFile(
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initRepo(gitignore: string): Promise<string> {
  const repoPath = await makeTempDir("bb-worktree-include-repo-");
  await git(repoPath, "init");
  await writeNestedFile(path.join(repoPath, "README.md"), "hello\n");
  await writeNestedFile(path.join(repoPath, ".gitignore"), gitignore);
  await git(repoPath, "add", ".");
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("experimental_copyWorktreeIncludeFiles", () => {
  it("copies ignored matches and leaves unmatched files behind", async () => {
    const sourcePath = await initRepo(".env*\nsecrets/\nbuild/\n");
    await writeNestedFile(path.join(sourcePath, ".env"), "TOKEN=1\n");
    await writeNestedFile(path.join(sourcePath, ".env.local"), "TOKEN=2\n");
    await writeNestedFile(path.join(sourcePath, "secrets/key.pem"), "pem\n");
    await writeNestedFile(path.join(sourcePath, "build/output.js"), "built\n");
    await writeNestedFile(
      path.join(sourcePath, ".worktreeinclude"),
      "# local credentials\n\n.env*\nsecrets/\n",
    );
    const targetPath = await makeTempDir("bb-worktree-include-target-");

    const result = await copyWorktreeIncludeFiles({ sourcePath, targetPath });

    expect(result.ran).toBe(true);
    expect([...result.copied].sort()).toEqual([
      ".env",
      ".env.local",
      "secrets/key.pem",
    ]);
    await expect(
      readFile(path.join(targetPath, "secrets/key.pem"), "utf8"),
    ).resolves.toBe("pem\n");
    await expect(
      stat(path.join(targetPath, "build/output.js")),
    ).rejects.toThrow();
  });

  it("honors negation patterns", async () => {
    const sourcePath = await initRepo("secrets/\n");
    await writeNestedFile(path.join(sourcePath, "secrets/keep.pem"), "keep\n");
    await writeNestedFile(path.join(sourcePath, "secrets/skip.pem"), "skip\n");
    await writeNestedFile(
      path.join(sourcePath, ".worktreeinclude"),
      "secrets/*.pem\n!secrets/skip.pem\n",
    );
    const targetPath = await makeTempDir("bb-worktree-include-target-");

    const result = await copyWorktreeIncludeFiles({ sourcePath, targetPath });

    expect(result.copied).toEqual(["secrets/keep.pem"]);
  });

  it("skips symlinks instead of copying what they point at", async () => {
    const sourcePath = await initRepo(".env\n");
    const outsideDir = await makeTempDir("bb-worktree-include-outside-");
    await writeNestedFile(path.join(outsideDir, "real.env"), "OUTSIDE=1\n");
    await symlink(
      path.join(outsideDir, "real.env"),
      path.join(sourcePath, ".env"),
    );
    await writeNestedFile(path.join(sourcePath, ".worktreeinclude"), ".env\n");
    const targetPath = await makeTempDir("bb-worktree-include-target-");

    const result = await copyWorktreeIncludeFiles({ sourcePath, targetPath });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([".env: symlink"]);
    await expect(stat(path.join(targetPath, ".env"))).rejects.toThrow();
  });

  it("does not write through a symlink already in the target", async () => {
    const sourcePath = await initRepo(".env\n");
    await writeNestedFile(path.join(sourcePath, ".env"), "SECRET=1\n");
    await writeNestedFile(path.join(sourcePath, ".worktreeinclude"), ".env\n");
    const outsideDir = await makeTempDir("bb-worktree-include-outside-");
    const hostFile = path.join(outsideDir, "host-file");
    await writeNestedFile(hostFile, "untouched\n");
    const targetPath = await makeTempDir("bb-worktree-include-target-");
    await symlink(hostFile, path.join(targetPath, ".env"));

    const result = await copyWorktreeIncludeFiles({ sourcePath, targetPath });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([".env: already exists in the worktree"]);
    await expect(readFile(hostFile, "utf8")).resolves.toBe("untouched\n");
  });

  it("does not replace a file the target already has", async () => {
    const sourcePath = await initRepo("config.json\n");
    await writeNestedFile(
      path.join(sourcePath, "config.json"),
      '{"from":"source"}\n',
    );
    await writeNestedFile(
      path.join(sourcePath, ".worktreeinclude"),
      "config.json\n",
    );
    const targetPath = await makeTempDir("bb-worktree-include-target-");
    await writeNestedFile(
      path.join(targetPath, "config.json"),
      '{"from":"branch"}\n',
    );

    const result = await copyWorktreeIncludeFiles({ sourcePath, targetPath });

    expect(result.copied).toEqual([]);
    await expect(
      readFile(path.join(targetPath, "config.json"), "utf8"),
    ).resolves.toBe('{"from":"branch"}\n');
  });

  it("rejects when git cannot list files instead of reporting zero matches", async () => {
    const sourcePath = await makeTempDir("bb-worktree-include-nonrepo-");
    await writeNestedFile(path.join(sourcePath, ".worktreeinclude"), ".env\n");
    const targetPath = await makeTempDir("bb-worktree-include-target-");

    await expect(
      copyWorktreeIncludeFiles({ sourcePath, targetPath }),
    ).rejects.toThrow(/git ls-files failed/u);
  });

  it("rejects with the abort reason once the signal aborts", async () => {
    const sourcePath = await initRepo("secrets/\n");
    await writeNestedFile(path.join(sourcePath, "secrets/a.pem"), "a\n");
    await writeNestedFile(
      path.join(sourcePath, ".worktreeinclude"),
      "secrets/\n",
    );
    const targetPath = await makeTempDir("bb-worktree-include-target-");
    const controller = new AbortController();
    const reason = new Error("cancelled by test");
    const copying = copyWorktreeIncludeFiles({
      sourcePath,
      targetPath,
      signal: controller.signal,
    });
    controller.abort(reason);

    await expect(copying).rejects.toBe(reason);
  });

  it("does nothing when the file holds no patterns", async () => {
    const sourcePath = await initRepo(".env\n");
    await writeNestedFile(path.join(sourcePath, ".env"), "TOKEN=1\n");
    await writeNestedFile(
      path.join(sourcePath, ".worktreeinclude"),
      "# nothing here\n\n",
    );
    const targetPath = await makeTempDir("bb-worktree-include-target-");

    const result = await copyWorktreeIncludeFiles({ sourcePath, targetPath });

    expect(result).toEqual({ ran: false, copied: [], skipped: [] });
    await expect(stat(path.join(targetPath, ".env"))).rejects.toThrow();
  });
});
