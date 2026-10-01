import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Config } from "./config";
import { Task, listTasks, moveTask, slugify } from "./queue";
import { P, nowSec, readJson, readJsonl, writeJson } from "./util";

/**
 * Lote: tarefas que formam uma entrega só.
 *
 * Sem lote, cada tarefa nasce numa branch própria a partir da base. Isso isola
 * execuções independentes, mas quando as tarefas são partes de um conjunto (um
 * site: página, SEO, imagem) quem revisa precisa juntar tudo à mão, resolvendo
 * o mesmo conflito várias vezes — e nenhuma tarefa enxerga o que a anterior fez.
 *
 * Num lote as tarefas rodam em sequência, na ordem em que entraram, sobre UMA
 * branch. Cada tarefa vira um commit. Quem revisa lê uma branch, commit a
 * commit, e pode desfazer um sem perder o resto.
 *
 * A regra que protege o resto: se uma tarefa falha, o trabalho parcial dela NÃO
 * entra na branch do lote (vai para uma branch à parte) e as seguintes ficam
 * bloqueadas até alguém decidir: tentar de novo, pular ou cancelar. A fila não
 * decide sozinha, porque as tarefas seguintes podem depender da que falhou.
 */

export type EstadoDoLote = "andamento" | "bloqueado" | "concluido" | "cancelado";

export interface Bloqueio {
  tarefa: string;
  titulo: string;
  motivo: string;
  /** Onde ficou o trabalho parcial, quando houve algum. */
  branchFalha: string | null;
  /** O commit de verdade deixado em `branchFalha` -- ausente em lotes salvos antes deste campo existir. */
  commitFalha?: string | null;
  em: number;
}

export interface Lote {
  /** Chave e nome de arquivo: o nome normalizado. */
  nome: string;
  repo: string;
  base: string;
  /** Nasce na primeira execução: a data do nome é a de quando a branch nasce. */
  branch: string | null;
  estado: EstadoDoLote;
  criado: number;
  bloqueio: Bloqueio | null;
  puladas: string[];
  /** id da tarefa → commit que ela deixou na branch do lote. */
  commits: Record<string, string>;
}

/** Nome digitado virando chave: sem acento, sem espaço, sem maiúscula. */
export function nomeDoLote(nome: string): string {
  return slugify(nome, 60);
}

const arquivoDoLote = (nome: string) => path.join(P.lotes, `${nomeDoLote(nome)}.json`);
export const relatorioDoLotePath = (nome: string) => path.join(P.lotes, `${nomeDoLote(nome)}.md`);

export function lerLote(nome: string): Lote | null {
  const l = readJson<Lote | null>(arquivoDoLote(nome), null);
  if (!l) return null;
  // arquivos de uma versão anterior podem não ter todos os campos
  return { ...l, puladas: l.puladas || [], commits: l.commits || {}, bloqueio: l.bloqueio || null };
}

export function salvarLote(l: Lote): void {
  fs.mkdirSync(P.lotes, { recursive: true });
  writeJson(arquivoDoLote(l.nome), l);
}

export function listarLotes(): Lote[] {
  let arquivos: string[] = [];
  try {
    arquivos = fs.readdirSync(P.lotes).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return arquivos
    .map((f) => lerLote(path.basename(f, ".json")))
    .filter((l): l is Lote => !!l)
    .sort((a, b) => b.criado - a.criado);
}

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** Mesmo repositório escrito de dois jeitos (barra, maiúscula no Windows) é o mesmo. */
export function mesmoRepo(a: string, b: string): boolean {
  const n = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
}

/** Todas as tarefas do lote, em qualquer estado, na ordem de execução. */
export function tarefasDoLote(cfg: Config, nome: string): Task[] {
  const chave = nomeDoLote(nome);
  return (["queued", "done", "failed"] as const)
    .flatMap((s) => listTasks(cfg, s))
    .filter((t) => t.lote !== null && nomeDoLote(t.lote) === chave)
    .sort((a, b) => a.ordem - b.ordem || a.created - b.created);
}

export type EntradaNoLote = { ok: true; lote: Lote; ordem: number } | { ok: false; erro: string };

/**
 * Valida e registra a entrada de uma tarefa no lote, na hora de enfileirar.
 *
 * É aqui, e não na execução, que repositório e base diferentes são recusados:
 * descobrir o problema só quando a fila rodar, horas depois e sem ninguém
 * olhando, deixaria o lote bloqueado por um erro que era de digitação.
 */
export function entrarNoLote(cfg: Config, opts: { nome: string; repo: string; base?: string }): EntradaNoLote {
  const chave = nomeDoLote(opts.nome);
  const existente = lerLote(chave);

  if (existente) {
    if (existente.estado === "cancelado") {
      return { ok: false, erro: `o lote "${chave}" foi cancelado. Use outro nome para começar um lote novo.` };
    }
    if (!mesmoRepo(existente.repo, opts.repo)) {
      return {
        ok: false,
        erro: `o lote "${chave}" é do repositório ${existente.repo}. Todas as tarefas de um lote ficam no mesmo repositório.`,
      };
    }
    if (opts.base && opts.base !== existente.base) {
      return {
        ok: false,
        erro: `o lote "${chave}" parte de ${existente.base}, não de ${opts.base}. Todas as tarefas de um lote partem da mesma base.`,
      };
    }
    // Um lote concluído que recebe tarefa nova volta a andar, na mesma branch:
    // é o caso da correção pedida depois de revisar.
    if (existente.estado === "concluido") {
      existente.estado = "andamento";
      salvarLote(existente);
    }
    const ultima = tarefasDoLote(cfg, chave).reduce((m, t) => Math.max(m, t.ordem), 0);
    return { ok: true, lote: existente, ordem: ultima + 1 };
  }

  // A base é resolvida agora, e não na execução: se cada tarefa lesse "a branch
  // atual" na hora de rodar, uma troca de branch no meio mudaria a base do lote.
  const base = opts.base || git(opts.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "HEAD";
  const lote: Lote = {
    nome: chave,
    repo: path.resolve(opts.repo),
    base,
    branch: null,
    estado: "andamento",
    criado: nowSec(),
    bloqueio: null,
    puladas: [],
    commits: {},
  };
  salvarLote(lote);
  return { ok: true, lote, ordem: 1 };
}

/**
 * Lote da tarefa, criado na hora se o arquivo não existir — uma tarefa escrita
 * à mão com `lote:` no frontmatter não passou por `entrarNoLote`.
 */
export function loteDaTarefa(task: Task): Lote | null {
  if (!task.lote) return null;
  const existente = lerLote(task.lote);
  if (existente) return existente;
  const base = task.base || git(task.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "HEAD";
  const lote: Lote = {
    nome: nomeDoLote(task.lote),
    repo: path.resolve(task.repo),
    base,
    branch: null,
    estado: "andamento",
    criado: nowSec(),
    bloqueio: null,
    puladas: [],
    commits: {},
  };
  salvarLote(lote);
  return lote;
}

/**
 * A tarefa pode rodar agora? Fora de lote, sempre. Dentro, só se o lote estiver
 * andando e ela for a primeira pendente dele — a ordem do lote vale mais que a
 * prioridade, porque a tarefa seguinte pode depender da anterior.
 */
export function podeRodar(task: Task, pendentes: Task[]): boolean {
  if (!task.lote) return true;
  const lote = lerLote(task.lote);
  if (lote && (lote.estado === "bloqueado" || lote.estado === "cancelado")) return false;
  const chave = nomeDoLote(task.lote);
  const primeira = pendentes
    .filter((t) => t.lote !== null && nomeDoLote(t.lote) === chave)
    .sort((a, b) => a.ordem - b.ordem || a.created - b.created)[0];
  return primeira?.id === task.id;
}

/**
 * A branch do lote está aberta (checkout) no repositório? O git não deixa abrir
 * uma worktree numa branch em uso. Isso não é falha da tarefa — é você
 * revisando — então a fila espera em vez de bloquear o lote.
 */
export function loteEmCheckout(task: Task): boolean {
  if (!task.lote) return false;
  const lote = lerLote(task.lote);
  if (!lote?.branch) return false;
  return git(task.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out === lote.branch;
}

export function proximaTarefa(pendentes: Task[]): Task | null {
  return pendentes.find((t) => podeRodar(t, pendentes) && !loteEmCheckout(t)) ?? null;
}

/** Por que cada lote com tarefa pendente não anda: é o que explica uma fila parada. */
export function lotesParados(pendentes: Task[]): string[] {
  const porNome = new Map<string, Task>();
  for (const t of pendentes) if (t.lote && !porNome.has(nomeDoLote(t.lote))) porNome.set(nomeDoLote(t.lote), t);
  const motivos: string[] = [];
  for (const [nome, t] of porNome) {
    const l = lerLote(nome);
    if (l?.estado === "bloqueado") motivos.push(`lote ${nome} bloqueado, esperando sua decisão`);
    else if (l?.estado === "cancelado") motivos.push(`lote ${nome} cancelado`);
    else if (loteEmCheckout(t)) motivos.push(`lote ${nome} esperando você sair da branch ${l?.branch}`);
  }
  return motivos;
}

/** Depois de uma tarefa terminar bem: registra o commit e fecha o lote se acabou. */
export function registrarSucesso(cfg: Config, task: Task, commit: string | null): void {
  const lote = lerLote(task.lote!);
  if (!lote) return;
  if (commit) lote.commits[task.id] = commit;
  salvarLote(lote);
  atualizarEstado(cfg, lote.nome);
}

export function bloquearLote(nome: string, b: Bloqueio): void {
  const lote = lerLote(nome);
  if (!lote) return;
  lote.estado = "bloqueado";
  lote.bloqueio = b;
  salvarLote(lote);
}

/** Tentar de novo: a tarefa volta para a fila e o lote volta a andar. */
export function desbloquearLote(nome: string): void {
  const lote = lerLote(nome);
  if (!lote || lote.estado !== "bloqueado") return;
  lote.estado = "andamento";
  lote.bloqueio = null;
  salvarLote(lote);
}

/**
 * Pular: a tarefa que falhou fica registrada como pulada e o lote segue sem
 * ela. O arquivo dela continua em "Com falha", para o registro do que houve.
 */
export function pularNoLote(cfg: Config, task: Task): void {
  const lote = lerLote(task.lote!);
  if (!lote) return;
  if (!lote.puladas.includes(task.id)) lote.puladas.push(task.id);
  if (lote.bloqueio?.tarefa === task.id) {
    lote.bloqueio = null;
    lote.estado = "andamento";
  }
  salvarLote(lote);
  atualizarEstado(cfg, lote.nome);
}

/**
 * Cancelar: o lote para de vez. As pendentes vão para "Com falha", visíveis, em
 * vez de sumirem — apagar trabalho descrito não é decisão que a fila tome. A
 * branch fica: o que já foi commitado nela continua disponível para revisão.
 */
export function cancelarLote(cfg: Config, nome: string): number {
  const lote = lerLote(nome);
  if (!lote) return 0;
  lote.estado = "cancelado";
  salvarLote(lote);
  const pendentes = tarefasDoLote(cfg, nome).filter((t) => t.status === "queued");
  for (const t of pendentes) moveTask(t, "failed");
  escreverRelatorioDoLote(cfg, nome);
  return pendentes.length;
}

/** Sem pendente e sem bloqueio, o lote está concluído. */
export function atualizarEstado(cfg: Config, nome: string): void {
  const lote = lerLote(nome);
  if (!lote || lote.estado === "cancelado" || lote.estado === "bloqueado") return;
  const pendentes = tarefasDoLote(cfg, nome).filter((t) => t.status === "queued");
  const novo: EstadoDoLote = pendentes.length ? "andamento" : "concluido";
  if (novo !== lote.estado) {
    lote.estado = novo;
    salvarLote(lote);
  }
}

// ---------- relatório ----------

interface LinhaDoLedger {
  id: string;
  ok: boolean;
  reason: string;
  model: string;
  filesChanged: number;
  commit?: string | null;
  branchFalha?: string | null;
  negadas?: number;
  costUsd?: number | null;
}

const ROTULO: Record<EstadoDoLote, string> = {
  andamento: "em andamento",
  bloqueado: "BLOQUEADO — esperando sua decisão",
  concluido: "concluído",
  cancelado: "cancelado",
};

/**
 * Uma página por lote, reescrita a cada tarefa. É o ponto de entrada da
 * revisão: o que rodou, o que cada uma verificou, e onde está cada coisa.
 */
export function escreverRelatorioDoLote(cfg: Config, nome: string): string | null {
  const lote = lerLote(nome);
  if (!lote) return null;
  const tarefas = tarefasDoLote(cfg, nome);
  const ultimas = new Map<string, LinhaDoLedger>();
  for (const l of readJsonl<LinhaDoLedger>(P.ledger)) ultimas.set(l.id, l);

  const situacao = (t: Task): string => {
    if (lote.puladas.includes(t.id)) return "⤼ pulada";
    if (t.status === "queued") return lote.estado === "bloqueado" || lote.estado === "cancelado" ? "⏸ parada" : "… pendente";
    if (t.status === "done") return "✓ concluída";
    return ultimas.has(t.id) ? "✗ falhou" : "✗ não rodou";
  };

  const linhas = [
    `# Lote ${lote.nome}`,
    "",
    `- Estado: **${ROTULO[lote.estado]}**`,
    `- Repositório: \`${lote.repo}\``,
    `- Base: \`${lote.base}\``,
    `- Branch: ${lote.branch ? `\`${lote.branch}\`` : "ainda não criada (nasce na primeira tarefa)"}`,
    "",
  ];

  if (lote.bloqueio) {
    const b = lote.bloqueio;
    linhas.push(
      "## Por que parou",
      "",
      `A tarefa **${b.titulo}** falhou: ${b.motivo}.`,
      "",
      b.branchFalha
        ? `O trabalho parcial dela foi commitado como \`cq(wip)${b.commitFalha ? ` ${b.commitFalha.slice(0, 7)}` : ""}\` em \`${b.branchFalha}\`, fora da branch do lote.`
        : "Ela não deixou alteração nenhuma.",
      "",
      `O relatório da falha está em \`${path.join(P.runs, b.tarefa, "falha.md")}\`.`,
      "",
      "As tarefas seguintes estão paradas. Escolha no painel, clicando com o botão direito na tarefa com falha:",
      "",
      "- **Tentar de novo** — ela volta para a fila e o lote continua de onde parou.",
      "- **Pular no lote** — o lote segue sem ela.",
      "- **Cancelar lote** — nada mais roda; o que já foi commitado continua na branch.",
      ""
    );
  }

  linhas.push("## Tarefas", "", "| # | Tarefa | Modelo | Situação | Commit | Arquivos | Comandos negados |", "|---|---|---|---|---|---|---|");
  for (const t of tarefas) {
    const l = ultimas.get(t.id);
    const commit = lote.commits[t.id] ? `\`${lote.commits[t.id].slice(0, 7)}\`` : "—";
    linhas.push(
      `| ${t.ordem} | ${t.title} | ${t.model} | ${situacao(t)} | ${commit} | ${l ? l.filesChanged : "—"} | ${l?.negadas ?? "—"} |`
    );
  }
  linhas.push(
    "",
    "Comando negado não é erro por si só, mas quer dizer que algo pode não ter sido verificado:",
    "confira na resposta de cada tarefa o que ela diz que rodou.",
    "",
    "## Como revisar",
    "",
    lote.branch ? `- Tudo junto: \`git diff ${lote.base}...${lote.branch}\`` : "- Ainda não há branch.",
    lote.branch ? `- Commit a commit: \`git log --reverse ${lote.base}..${lote.branch}\`` : "",
    "",
    "## Resultado de cada tarefa",
    ""
  );
  for (const t of tarefas) {
    const arquivo = path.join(P.runs, t.id, "result.md");
    linhas.push(`- ${t.ordem}. ${t.title}: ${fs.existsSync(arquivo) ? `\`${arquivo}\`` : "ainda não rodou"}`);
  }

  const destino = relatorioDoLotePath(nome);
  fs.mkdirSync(P.lotes, { recursive: true });
  fs.writeFileSync(destino, linhas.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n");
  return destino;
}
