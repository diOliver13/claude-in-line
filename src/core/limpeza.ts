import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { analiseDoLotePath } from "./analise";
import { Config } from "./config";
import { Lote, lerLote, listarLotes, nomeDoLote, relatorioDoLotePath, tarefasDoLote } from "./lote";
import { Task, listTasks } from "./queue";
import { P, acquireLock, nowSec, readJsonl, releaseLock } from "./util";

/**
 * Limpar o histórico da fila.
 *
 * O padrão é ARQUIVAR: tudo vai para `~/.cq/arquivo/<data>/`, com a mesma
 * estrutura de pastas, e o painel fica limpo. Apagar de vez é uma escolha
 * explícita. O motivo é o mesmo do relatório de falha: a pergunta "por que
 * aquilo falhou?" costuma aparecer depois de o painel já ter sido limpo.
 *
 * O que a limpeza nunca toca: o medidor (leituras, calibração, estado do dia),
 * o ledger — que o porteiro não usa, mas é o histórico de consumo — e qualquer
 * lote em andamento ou bloqueado, com as tarefas dele. Tarefa concluída de um
 * lote que ainda anda é o que a próxima tarefa do lote lê para saber o que já
 * foi feito; tirá-la do lugar quebraria o lote.
 */

export type Categoria = "concluidas" | "falhas" | "pendentes" | "lotes";

export interface BranchDaFila {
  repo: string;
  branch: string;
  base: string;
}

export interface ItemDeLimpeza {
  tipo: "tarefa" | "lote";
  id: string;
  titulo: string;
  categoria: Categoria;
  /** Caminhos absolutos, todos dentro da pasta de dados. */
  arquivos: string[];
  /** Última atividade conhecida: é o que a retenção compara. */
  fim: number;
  branches: BranchDaFila[];
}

interface LinhaDoLedger {
  id: string;
  repo: string;
  branch: string | null;
  base?: string | null;
  end: number;
  branchFalha?: string | null;
}

function ultimasDoLedger(): Map<string, LinhaDoLedger> {
  const m = new Map<string, LinhaDoLedger>();
  for (const l of readJsonl<LinhaDoLedger>(P.ledger)) if (l?.id) m.set(l.id, l);
  return m;
}

const existe = (p: string) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

function arquivosDaTarefa(t: Task): string[] {
  return [t.file, path.join(P.runs, t.id)].filter(existe);
}

/** Tarefa de lote só sai junto com o lote — e só se o lote existir de fato. */
function ehDeLote(t: Task): boolean {
  return !!t.lote && !!lerLote(t.lote);
}

const encerrado = (l: Lote) => l.estado === "concluido" || l.estado === "cancelado";

export function planejarLimpeza(cfg: Config, categorias: Categoria[], opts: { maisVelhoQue?: number } = {}): ItemDeLimpeza[] {
  const ledger = ultimasDoLedger();
  const itens: ItemDeLimpeza[] = [];
  const quer = new Set(categorias);
  const velho = (fim: number) => opts.maisVelhoQue === undefined || fim < opts.maisVelhoQue;

  const avulsas: [Categoria, Task["status"]][] = [
    ["concluidas", "done"],
    ["falhas", "failed"],
    ["pendentes", "queued"],
  ];
  for (const [categoria, status] of avulsas) {
    if (!quer.has(categoria)) continue;
    for (const t of listTasks(cfg, status)) {
      if (ehDeLote(t)) continue;
      const l = ledger.get(t.id);
      const fim = l?.end ?? t.created;
      if (!velho(fim)) continue;
      itens.push({
        tipo: "tarefa",
        id: t.id,
        titulo: t.title,
        categoria,
        arquivos: arquivosDaTarefa(t),
        fim,
        branches: l?.branch ? [{ repo: t.repo, branch: l.branch, base: l.base || "HEAD" }] : [],
      });
    }
  }

  if (quer.has("lotes")) {
    for (const lote of listarLotes()) {
      if (!encerrado(lote)) continue;
      const tarefas = tarefasDoLote(cfg, lote.nome);
      const fins = tarefas.map((t) => ledger.get(t.id)?.end ?? t.created);
      const fim = Math.max(lote.criado, ...fins);
      if (!velho(fim)) continue;
      const branches: BranchDaFila[] = [];
      if (lote.branch) branches.push({ repo: lote.repo, branch: lote.branch, base: lote.base });
      for (const t of tarefas) {
        const falha = ledger.get(t.id)?.branchFalha;
        if (falha) branches.push({ repo: lote.repo, branch: falha, base: lote.base });
      }
      const chave = nomeDoLote(lote.nome);
      itens.push({
        tipo: "lote",
        id: chave,
        titulo: `lote ${chave} (${tarefas.length} tarefa(s))`,
        categoria: "lotes",
        arquivos: [
          path.join(P.lotes, `${chave}.json`),
          relatorioDoLotePath(chave),
          analiseDoLotePath(chave),
          ...tarefas.flatMap(arquivosDaTarefa),
        ].filter(existe),
        fim,
        branches,
      });
    }
  }

  return itens;
}

export interface ResultadoDaLimpeza {
  itens: number;
  arquivos: number;
  /** Onde ficou, quando arquivado. */
  destino: string | null;
}

function dia(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Mover entre pastas; em volumes diferentes o rename falha e vira cópia. */
function mover(de: string, para: string): void {
  fs.mkdirSync(path.dirname(para), { recursive: true });
  let destino = para;
  for (let i = 2; existe(destino); i++) destino = `${para}-${i}`;
  try {
    fs.renameSync(de, destino);
  } catch {
    fs.cpSync(de, destino, { recursive: true });
    fs.rmSync(de, { recursive: true, force: true });
  }
}

/**
 * Executa com o lock da fila: limpar no meio de uma execução tiraria do lugar
 * o arquivo da tarefa que está rodando.
 */
export function executarLimpeza(itens: ItemDeLimpeza[], modo: "arquivar" | "apagar", agora = new Date()): ResultadoDaLimpeza {
  if (!itens.length) return { itens: 0, arquivos: 0, destino: null };
  if (!acquireLock()) throw new Error("a fila está executando agora. Tente de novo quando ela terminar");
  try {
    const destino = modo === "arquivar" ? path.join(P.arquivo, dia(agora)) : null;
    let arquivos = 0;
    for (const item of itens) {
      for (const a of item.arquivos) {
        if (!existe(a)) continue;
        // defesa: nunca mexer fora da pasta de dados, nem no próprio arquivo
        const rel = path.relative(P.home, a);
        if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep)[0] === "arquivo") continue;
        if (destino) mover(a, path.join(destino, rel));
        else fs.rmSync(a, { recursive: true, force: true });
        arquivos++;
      }
    }
    if (destino) {
      const registro = path.join(destino, `limpeza-${agora.toTimeString().slice(0, 8).replace(/:/g, "")}.json`);
      fs.mkdirSync(destino, { recursive: true });
      fs.writeFileSync(
        registro,
        JSON.stringify({ em: nowSec(), itens: itens.map(({ tipo, id, titulo, categoria, branches }) => ({ tipo, id, titulo, categoria, branches })) }, null, 2)
      );
    }
    return { itens: itens.length, arquivos, destino };
  } finally {
    releaseLock();
  }
}

export interface ItemArquivado {
  tipo: "tarefa" | "lote";
  id: string;
  titulo: string;
  categoria: Categoria;
  /** Pasta de data onde esse item caiu, ex. "2026-10-01". */
  data: string;
  branches: BranchDaFila[];
}

/**
 * Para exibir o que já foi arquivado, sem reler `.md`: cada leva de
 * `executarLimpeza`/`aplicarRetencao` já grava um `limpeza-<hora>.json` com
 * título, categoria e tipo de cada item. Mais recente primeiro.
 */
export function listarArquivados(limite = 50): ItemArquivado[] {
  let dias: string[] = [];
  try {
    dias = fs.readdirSync(P.arquivo).filter((d) => existe(path.join(P.arquivo, d)));
  } catch {
    return [];
  }
  dias.sort().reverse();

  const out: ItemArquivado[] = [];
  for (const d of dias) {
    let manifestos: string[] = [];
    try {
      manifestos = fs.readdirSync(path.join(P.arquivo, d)).filter((f) => /^limpeza-\d+\.json$/.test(f));
    } catch {
      continue;
    }
    manifestos.sort().reverse();
    for (const m of manifestos) {
      let conteudo: { itens?: Omit<ItemArquivado, "data">[] };
      try {
        conteudo = JSON.parse(fs.readFileSync(path.join(P.arquivo, d, m), "utf8"));
      } catch {
        continue;
      }
      for (const item of conteudo.itens || []) {
        out.push({ ...item, data: d });
        if (out.length >= limite) return out;
      }
    }
  }
  return out;
}

/** Esvaziar o arquivo: o que já foi arquivado some de vez. */
export function esvaziarArquivo(): number {
  let dias: string[] = [];
  try {
    dias = fs.readdirSync(P.arquivo);
  } catch {
    return 0;
  }
  for (const d of dias) fs.rmSync(path.join(P.arquivo, d), { recursive: true, force: true });
  return dias.length;
}

// ---------- branches ----------

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/**
 * Das branches que a fila criou para estes itens, as que já estão inteiras na
 * base. Só essas podem ser apagadas: o git confirma que nada se perde. Branch
 * juntada por squash não aparece aqui — o git não tem como saber que o
 * conteúdo entrou — e fica para você decidir.
 */
export function branchesMescladas(itens: ItemDeLimpeza[]): BranchDaFila[] {
  const vistas = new Set<string>();
  const out: BranchDaFila[] = [];
  for (const b of itens.flatMap((i) => i.branches)) {
    const chave = `${path.resolve(b.repo)}::${b.branch}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    if (!existe(b.repo)) continue;
    if (!git(b.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b.branch}`]).ok) continue;
    if (git(b.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out === b.branch) continue;
    if (!git(b.repo, ["rev-parse", "--verify", "--quiet", b.base]).ok) continue;
    if (git(b.repo, ["merge-base", "--is-ancestor", b.branch, b.base]).ok) out.push(b);
  }
  return out;
}

export function apagarBranches(lista: BranchDaFila[]): { apagadas: string[]; falhas: string[] } {
  const apagadas: string[] = [];
  const falhas: string[] = [];
  for (const b of lista) {
    // confere de novo: entre a lista e a confirmação, a branch pode ter mudado
    const ainda = git(b.repo, ["merge-base", "--is-ancestor", b.branch, b.base]).ok;
    const r = ainda ? git(b.repo, ["branch", "-D", b.branch]) : { ok: false, err: "deixou de estar mesclada" };
    (r.ok ? apagadas : falhas).push(r.ok ? b.branch : `${b.branch}: ${r.err}`);
  }
  return { apagadas, falhas };
}

// ---------- retenção ----------

/**
 * Arquiva sozinho o que passou de `retencaoDias`. Só arquiva, nunca apaga, e
 * nunca toca pendentes: uma tarefa esperando cota há duas semanas continua
 * sendo trabalho que você pediu.
 */
export function aplicarRetencao(cfg: Config, agora = nowSec()): ResultadoDaLimpeza | null {
  if (!cfg.retencaoDias || cfg.retencaoDias <= 0) return null;
  const itens = planejarLimpeza(cfg, ["concluidas", "falhas", "lotes"], { maisVelhoQue: agora - cfg.retencaoDias * 86400 });
  if (!itens.length) return null;
  return executarLimpeza(itens, "arquivar", new Date(agora * 1000));
}
