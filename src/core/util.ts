import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let home: string = process.env.CQ_HOME || path.join(os.homedir(), ".cq");

/**
 * A CLI resolve a pasta de dados uma vez por processo. O extension host vive
 * horas e tem a configuração `claudeQueue.dataDir`, e o statusline.js roda de
 * dentro da própria pasta de dados. Por isso `P` é feito de getters: quem
 * chamar `setHome` antes do primeiro acesso muda o destino de todo o núcleo.
 */
export function setHome(dir: string): void {
  home = dir;
}

export function getHome(): string {
  return home;
}

export const P = {
  get home(): string { return home; },
  get config(): string { return path.join(home, "config.json"); },
  get state(): string { return path.join(home, "state.json"); },
  get latest(): string { return path.join(home, "usage.json"); },
  get history(): string { return path.join(home, "snapshots.jsonl"); },
  get ledger(): string { return path.join(home, "ledger.jsonl"); },
  get lock(): string { return path.join(home, "run.lock"); },
  get queue(): string { return path.join(home, "queue"); },
  get done(): string { return path.join(home, "done"); },
  get failed(): string { return path.join(home, "failed"); },
  get runs(): string { return path.join(home, "runs"); },
  get worktrees(): string { return path.join(home, "worktrees"); },
  get lotes(): string { return path.join(home, "lotes"); },
  get arquivo(): string { return path.join(home, "arquivo"); },
  get log(): string { return path.join(home, "cq.log"); },
};

export function ensureDirs(): void {
  for (const d of [P.home, P.queue, P.done, P.failed, P.runs, P.worktrees, P.lotes]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Escrita atômica: grava num temporário e renomeia. */
export function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function appendJsonl(file: string, data: unknown): void {
  fs.appendFileSync(file, JSON.stringify(data) + "\n");
}

export function readJsonl<T>(file: string): T[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* linha corrompida: ignora */
    }
  }
  return out;
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.appendFileSync(P.log, line + "\n");
  } catch {
    /* sem log não é fatal */
  }
}

// ---------- frontmatter simples (chave: valor) ----------

export type Frontmatter = Record<string, string>;

export function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const norm = text.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) return { meta: {}, body: norm.trim() };
  const end = norm.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: norm.trim() };
  const meta: Frontmatter = {};
  for (const line of norm.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: norm.slice(end + 4).replace(/^\n/, "").trim() };
}

export function renderFrontmatter(meta: Frontmatter, body: string): string {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

// ---------- tempo ----------

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfLocalDaySec(d = new Date()): number {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return Math.floor(s.getTime() / 1000);
}

/** Normaliza timestamps: aceita epoch em s ou ms, ou string ISO. */
export function toEpochSec(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return toEpochSec(Number(v));
    const t = Date.parse(v);
    return isNaN(t) ? null : Math.floor(t / 1000);
  }
  return null;
}

export function fmtDuration(sec: number): string {
  if (sec <= 0) return "agora";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined || !isFinite(v) ? "?" : `${v.toFixed(1)}%`;
}

// ---------- lock para evitar execuções simultâneas ----------

export function acquireLock(maxAgeSec = 6 * 3600): boolean {
  try {
    const fd = fs.openSync(P.lock, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: nowSec() }));
    fs.closeSync(fd);
    return true;
  } catch {
    const cur = readJson<{ pid?: number; ts?: number }>(P.lock, {});
    const stale = !cur.ts || nowSec() - cur.ts > maxAgeSec || !pidAlive(cur.pid);
    if (stale) {
      try {
        fs.unlinkSync(P.lock);
      } catch {
        /* outro processo pode ter removido */
      }
      return acquireLock(maxAgeSec);
    }
    return false;
  }
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(P.lock);
  } catch {
    /* ok */
  }
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
