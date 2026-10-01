import * as fs from "fs";
import * as path from "path";
import { Config } from "./config";
import { P, parseFrontmatter, renderFrontmatter } from "./util";

/**
 * Um arquivo ou pasta de fora do repositório que a fila copia para dentro da
 * worktree ANTES de chamar o Claude -- nunca pelo sandbox de permissão, que
 * nega sistematicamente um `cp`/`Copy-Item` com origem fora da worktree
 * (5 tentativas diferentes, todas negadas, no caso real que motivou isto).
 */
export interface Anexo {
  /** Caminho absoluto, fora da worktree. */
  de: string;
  /** Caminho relativo à raiz da worktree. */
  para: string;
}

export interface Task {
  id: string;
  file: string;
  title: string;
  repo: string;
  base: string | null;
  priority: number;
  model: string;
  maxTurns: number;
  timeoutMin: number;
  allowedTools: string[];
  prompt: string;
  created: number;
  status: "queued" | "done" | "failed";
  /** Nome do lote, quando a tarefa faz parte de um. Ver `lote.ts`. */
  lote: string | null;
  /** Posição dentro do lote. É ela que ordena a execução, não a prioridade. */
  ordem: number;
  anexos: Anexo[];
}

/** Resolvido a cada chamada: `P` é lazy e a pasta de dados pode ser trocada na ativação. */
function dirOf(status: Task["status"]): string {
  return status === "queued" ? P.queue : status === "done" ? P.done : P.failed;
}

/** Texto virando peda\u00e7o de nome: sem acento, sem mai\u00fascula, sem pontua\u00e7\u00e3o. */
export function slugify(texto: string, max = 40): string {
  const limpo = texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max)
    .replace(/-$/, "");
  return limpo || "tarefa";
}

export function slugId(title: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${slugify(title)}`;
}

function parseTools(v: string | undefined, fallback: string[]): string[] {
  if (!v) return fallback;
  // separa por vírgula fora de parênteses: "Read, Bash(mvn -q test:*), Edit"
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Frontmatter é linha única, chave: valor -- sem lista aninhada (ver
 * `parseFrontmatter`). O formato guarda vários anexos como
 * "de1 -> para1, de2 -> para2", no mesmo espírito de `allowedTools`.
 */
export function parseAnexos(v: string | undefined): Anexo[] {
  if (!v) return [];
  return v
    .split(",")
    .map((par) => {
      const [de, para] = par.split("->").map((s) => s.trim());
      return { de, para };
    })
    .filter((a): a is Anexo => !!a.de && !!a.para);
}

export function formatAnexos(anexos: Anexo[] | undefined): string {
  if (!anexos || !anexos.length) return "";
  return anexos.map((a) => `${a.de} -> ${a.para}`).join(", ");
}

/**
 * Estimativa de tamanho só pelo texto que a tarefa já tem -- sem ler código,
 * sem chamada externa. O caso real que motivou isto: um objetivo com 10
 * passos numerados, 14 arquivos, estourou o teto padrão (40) sem nada ter
 * pedido explicitamente mais turnos.
 *
 * É sugestão, não regra: tamanho de tarefa é estimativa, diferente de "falta
 * o critério de pronto", que é fato observável no texto.
 */
export function sugerirMaxTurns(
  objetivo: string,
  arquivos: string[],
  padrao: number
): { maxTurns: number; motivo: string | null } {
  const passos = (objetivo.match(/^\s*\d+[.)]\s+/gm) || []).length;
  const numArquivos = arquivos.length;
  if (passos > 6 || numArquivos > 8) {
    const sugestao = Math.max(padrao, 70);
    return {
      maxTurns: sugestao,
      motivo:
        `o objetivo tem ${passos} passo(s) numerado(s) e ${numArquivos} arquivo(s) -- maior do que o padrão de ` +
        `${padrao} turnos costuma dar conta, então usei ${sugestao}. Ajuste com o parâmetro maxTurns se achar pouco ou demais`,
    };
  }
  return { maxTurns: padrao, motivo: null };
}

export function readTask(file: string, status: Task["status"], cfg: Config): Task | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  const id = path.basename(file, ".md");
  if (!meta.repo || !body) return null;
  return {
    id,
    file,
    title: meta.title || id,
    repo: meta.repo,
    base: meta.base || null,
    priority: Number(meta.priority) || 3,
    model: meta.model || cfg.defaults.model,
    maxTurns: Number(meta.maxTurns) || cfg.defaults.maxTurns,
    timeoutMin: Number(meta.timeoutMin) || cfg.defaults.timeoutMin,
    allowedTools: parseTools(meta.allowedTools, cfg.defaults.allowedTools),
    prompt: body,
    created: Number(meta.created) || fs.statSync(file).mtimeMs / 1000,
    status,
    lote: meta.lote || null,
    ordem: Number(meta.ordem) || 0,
    anexos: parseAnexos(meta.anexos),
  };
}

export function listTasks(cfg: Config, status: Task["status"] = "queued"): Task[] {
  const dir = dirOf(status);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const tasks = files.map((f) => readTask(path.join(dir, f), status, cfg)).filter((t): t is Task => !!t);
  return tasks.sort((a, b) => a.priority - b.priority || a.created - b.created);
}

/** Arquivos na fila que não puderam ser lidos (sem repo ou sem prompt). */
export function invalidQueueFiles(cfg: Config): string[] {
  try {
    return fs
      .readdirSync(P.queue)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => !readTask(path.join(P.queue, f), "queued", cfg));
  } catch {
    return [];
  }
}

export function addTask(opts: {
  title: string;
  repo: string;
  prompt: string;
  priority?: number;
  model?: string;
  maxTurns?: number;
  timeoutMin?: number;
  allowedTools?: string;
  base?: string;
  lote?: string;
  ordem?: number;
  anexos?: Anexo[];
}): string {
  const id = slugId(opts.title);
  const meta: Record<string, string> = {
    title: opts.title,
    repo: path.resolve(opts.repo),
    base: opts.base || "",
    priority: String(opts.priority ?? 3),
    model: opts.model || "",
    maxTurns: opts.maxTurns ? String(opts.maxTurns) : "",
    timeoutMin: opts.timeoutMin ? String(opts.timeoutMin) : "",
    allowedTools: opts.allowedTools || "",
    lote: opts.lote || "",
    ordem: opts.ordem ? String(opts.ordem) : "",
    anexos: formatAnexos(opts.anexos),
    created: String(Math.floor(Date.now() / 1000)),
  };
  const file = path.join(P.queue, `${id}.md`);
  fs.writeFileSync(file, renderFrontmatter(meta, opts.prompt));
  return id;
}

export function moveTask(task: Task, to: "done" | "failed" | "queued"): void {
  const dest = path.join(dirOf(to), path.basename(task.file));
  fs.renameSync(task.file, dest);
  task.file = dest;
}

export function findTask(cfg: Config, id: string): Task | null {
  for (const s of ["queued", "failed", "done"] as const) {
    const t = listTasks(cfg, s).find((x) => x.id === id || x.id.startsWith(id));
    if (t) return t;
  }
  return null;
}
