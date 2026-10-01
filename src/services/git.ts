import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

/** Sem shell, para não depender de aspas nem de PATH do cmd. */
export async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, out: stdout.trim(), err: stderr.trim() };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: (err.stdout || "").trim(), err: (err.stderr || err.message || "").trim() };
  }
}

export async function isRepo(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--git-dir"])).ok;
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ["rev-parse", "--verify", "--quiet", branch])).ok;
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).out || "HEAD";
}

/** Arquivos tocados pela branch em relação à base, pelo ponto em que divergiram. */
export async function changedFiles(repo: string, base: string, branch: string): Promise<string[]> {
  const r = await git(repo, ["diff", "--name-only", `${base}...${branch}`]);
  return r.ok && r.out ? r.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}
