import { spawn, spawnSync, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "./config";
import { Decision, evaluate, setBrake } from "./gate";
import {
  Lote,
  bloquearLote,
  desbloquearLote,
  escreverRelatorioDoLote,
  lerLote,
  listarLotes,
  loteDaTarefa,
  lotesParados,
  proximaTarefa,
  registrarSucesso,
  salvarLote,
  tarefasDoLote,
} from "./lote";
import { Task, listTasks, moveTask, slugify } from "./queue";
import { escreverAnaliseDoLote } from "./analise";
import { conterProcesso } from "./job";
import { computeGauge } from "./gauge";
import { recordSnapshot, snapshotFromRateLimitEvent } from "./snapshot";
import { pesoDoUso } from "./transcripts";
import { P, appendJsonl, fmtDuration, log, nowSec, readJsonl, toEpochSec, acquireLock, releaseLock } from "./util";

const isWin = process.platform === "win32";

// ---------- localizar e iniciar o claude ----------

/**
 * Ordena pastas `anthropic.claude-code-<versão>-<plataforma>` da mais nova para
 * a mais velha. Comparar como texto colocaria a 2.1.9 na frente da 2.1.283.
 */
export function ordenarPorVersao(nomes: string[]): string[] {
  const numeros = (nome: string): number[] => {
    const m = nome.match(/(\d+(?:\.\d+)*)/);
    return m ? m[1].split(".").map(Number) : [];
  };
  return [...nomes].sort((a, b) => {
    const va = numeros(a);
    const vb = numeros(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const diff = (vb[i] ?? 0) - (va[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

/**
 * Quem usa o Claude Code só pelo painel do VS Code não tem `claude` no PATH: o
 * executável vive dentro da pasta da extensão, com a versão no caminho. Por
 * isso a busca não para no PATH.
 */
export function candidatosDoClaude(): string[] {
  const home = os.homedir();
  const executavel = isWin ? "claude.exe" : "claude";

  // A instalação nativa (`claude install`) vem primeiro de propósito: ela fica
  // parada no mesmo lugar. O binário da extensão é o último recurso, porque o
  // caminho dele carrega a versão e muda a cada atualização do Claude Code.
  const candidatos: string[] = [path.join(home, ".local", "bin", executavel)];

  for (const base of [".vscode", ".vscode-insiders", ".vscode-server"]) {
    const dir = path.join(home, base, "extensions");
    let entradas: string[];
    try {
      entradas = fs.readdirSync(dir).filter((n) => n.startsWith("anthropic.claude-code-"));
    } catch {
      continue;
    }
    for (const nome of ordenarPorVersao(entradas)) {
      candidatos.push(path.join(dir, nome, "resources", "native-binary", executavel));
    }
  }

  return candidatos.filter((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

export function resolveClaude(cfg: Config): string {
  if (cfg.claudePath) return cfg.claudePath;

  const r = spawnSync(isWin ? "where" : "which", ["claude"], { encoding: "utf8", windowsHide: true });
  const lines = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // no Windows prefira o .exe (instalador nativo) ao .cmd (npm)
  if (lines.length) return lines.find((l) => l.toLowerCase().endsWith(".exe")) || lines[0];

  const embutido = candidatosDoClaude()[0];
  if (embutido) return embutido;

  throw new Error(
    "não encontrei o executável `claude`. Rode `claude install` uma vez para tê-lo no PATH, " +
      "ou aponte `claudeQueue.claudePath` para ele"
  );
}

function quoteCmd(a: string): string {
  return `"${a.replace(/"/g, '""')}"`;
}

function spawnClaude(bin: string, args: string[], cwd: string): ChildProcess {
  const lower = bin.toLowerCase();
  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    // .cmd exige passar pelo cmd.exe; o prompt vai pelo stdin, então só flags passam por aqui
    const line = [bin, ...args].map(quoteCmd).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd, windowsVerbatimArguments: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return spawn(bin, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (isWin) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* já terminou */
    }
  }
}

// ---------- git ----------

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/**
 * Deixa o nome dentro do que o git aceita como referência. As regras que
 * importam aqui: nada de espaço nem de `~^:?*[\`, nada de `..` ou `@{`, nenhum
 * nível vazio ou começando com ponto, e não pode terminar em `/`, `.` ou
 * `.lock`. Um nome inválido faria o `worktree add` falhar com uma mensagem que
 * não explica nada.
 */
export function sanitizarRef(nome: string): string {
  const niveis = nome
    .split("/")
    .map((n) =>
      n
        .replace(/[\s~^:?*[\]\\]+/g, "-")
        .replace(/\.\.+/g, ".")
        .replace(/@\{/g, "-")
        .replace(/^[.\-]+/, "")
        .replace(/[.\-]+$/, "")
        .replace(/\.lock$/i, "lock")
    )
    .filter(Boolean);
  return niveis.join("/") || "tarefa";
}

/** Aplica o modelo configurado. A data é a da execução: é quando a branch nasce. */
export function nomeDaBranch(task: Task, repo: string, modelo: string, agora = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const data = `${agora.getFullYear()}-${p(agora.getMonth() + 1)}-${p(agora.getDate())}`;
  const hora = `${p(agora.getHours())}${p(agora.getMinutes())}`;

  const bruto = modelo
    .replace(/\{data\}/g, data)
    .replace(/\{hora\}/g, hora)
    .replace(/\{repo\}/g, slugify(repo))
    .replace(/\{slug\}/g, slugify(task.title, 60))
    .replace(/\{id\}/g, task.id);

  return sanitizarRef(bruto);
}

interface Worktree {
  dir: string;
  branch: string;
  base: string;
  lote: Lote | null;
}

/** Acrescenta um sufixo se o nome já existir: branch nunca é sobrescrita. */
function branchLivre(repo: string, nome: string): string {
  if (!git(repo, ["rev-parse", "--verify", "--quiet", nome]).ok) return nome;
  return `${nome}-r${Date.now() % 100000}`;
}

/**
 * Resíduo de uma tentativa anterior DESTA MESMA tarefa -- o caminho é
 * derivado do id, então nunca pertence a outra. `finishWorktree` já tenta
 * remover ao final; isto é o reforço para quando aquele `git worktree
 * remove` falha em silêncio (visto no Windows, com um processo recém-morto
 * ainda segurando um identificador de arquivo) e um "Tentar de novo" bate
 * em "already exists" sem explicação nenhuma.
 */
function limparResiduoSeExistir(repo: string, dir: string): void {
  if (!fs.existsSync(dir)) return;
  log(`worktree ${dir} já existia (sobra de uma tentativa anterior); limpando antes de tentar de novo`);
  if (!removerWorktree(repo, dir)) {
    throw new Error(
      `a pasta ${dir}, de uma tentativa anterior, não pôde ser apagada: algum processo ainda a usa. ` +
        "Encerre-o (ou reinicie o Windows) e tente de novo"
    );
  }
}

/**
 * Links simbólicos e junctions, sem segui-los. Os workspaces do npm criam
 * junctions em `node_modules` apontando para pastas da própria worktree; o git
 * do Windows não consegue apagá-las, e o `fs.rmSync` volta sem erro deixando a
 * pasta no disco.
 */
function desfazerLinks(dir: string): void {
  let entradas: fs.Dirent[];
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      try {
        fs.unlinkSync(p);
      } catch {
        try {
          fs.rmdirSync(p);
        } catch {
          /* o rmSync tenta de novo */
        }
      }
    } else if (e.isDirectory()) desfazerLinks(p);
  }
}

/** Tira a worktree do git e do disco. Devolve se a pasta de fato sumiu. */
function removerWorktree(repo: string, dir: string): boolean {
  desfazerLinks(dir);
  const r = git(repo, ["worktree", "remove", "--force", dir]);
  if (fs.existsSync(dir)) {
    if (!r.ok) log(`git não removeu a worktree ${dir} (${r.err}); apagando direto`);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch (e) {
      log(`não consegui apagar ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  git(repo, ["worktree", "prune"]);
  // o rmSync pode voltar sem erro e deixar a pasta: só o disco diz a verdade
  return !fs.existsSync(dir);
}

function prepareWorktree(task: Task, cfg: Config): Worktree {
  const top = git(task.repo, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`${task.repo} não é um repositório git`);

  // A pasta da worktree é interna e compartilhada entre repositórios, então ela
  // fica com o nome do repositório e o id: único por construção.
  const dir = path.join(P.worktrees, `${path.basename(top.out)}-${task.id}`);
  limparResiduoSeExistir(task.repo, dir);

  const lote = loteDaTarefa(task);
  if (lote) return worktreeDoLote(task, cfg, lote, top.out, dir);

  const base = task.base || git(task.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "HEAD";
  const branch = branchLivre(task.repo, nomeDaBranch(task, path.basename(top.out), cfg.branchTemplate));
  const add = git(task.repo, ["worktree", "add", "-b", branch, dir, base]);
  if (!add.ok) throw new Error(`falha ao criar worktree: ${add.err}`);
  return { dir, branch, base, lote: null };
}

/**
 * A primeira tarefa do lote cria a branch a partir da base; as seguintes abrem
 * a worktree NA branch do lote, e por isso enxergam o que as anteriores fizeram.
 */
function worktreeDoLote(task: Task, cfg: Config, lote: Lote, top: string, dir: string): Worktree {
  if (lote.branch) {
    // Recriar a branch a partir da base, se ela tiver sumido, apagaria em
    // silêncio o que as tarefas anteriores commitaram. Melhor parar e contar.
    if (!git(task.repo, ["rev-parse", "--verify", "--quiet", lote.branch]).ok) {
      throw new Error(`a branch do lote, ${lote.branch}, não existe mais no repositório`);
    }
    const add = git(task.repo, ["worktree", "add", dir, lote.branch]);
    if (!add.ok) {
      const emUso = /already (checked out|used by worktree)|is already used/i.test(add.err);
      throw new Error(
        emUso
          ? `a branch do lote, ${lote.branch}, está aberta (checkout) no repositório. Troque para outra branch e tente de novo`
          : `falha ao criar worktree na branch do lote: ${add.err}`
      );
    }
    return { dir, branch: lote.branch, base: lote.base, lote };
  }

  // No modelo de nome, {slug} e {id} viram o nome do lote: a branch é dele, não da tarefa.
  const nome = nomeDaBranch({ ...task, id: lote.nome, title: lote.nome }, path.basename(top), cfg.branchTemplate);
  const branch = branchLivre(task.repo, nome);
  const add = git(task.repo, ["worktree", "add", "-b", branch, dir, lote.base]);
  if (!add.ok) throw new Error(`falha ao criar worktree: ${add.err}`);
  lote.branch = branch;
  salvarLote(lote);
  return { dir, branch, base: lote.base, lote };
}

interface Fechamento {
  changed: number;
  /** Commit deixado na branch da tarefa (ou do lote). */
  commit: string | null;
  /** Só em lote: onde foi parar o trabalho parcial de uma tarefa que falhou. */
  branchFalha: string | null;
  /**
   * O commit de verdade que ficou em `branchFalha` (sempre que houve um).
   * Existe separado de `commit` porque `commit` aqui significa "entrou na
   * branch do lote" -- e um `branchFalha` nunca entra. Sem este campo, o
   * relatório de falha não tinha como provar que o trabalho parcial foi
   * salvo, e "guardados em X" lia como se pudesse estar solto, sem commit.
   */
  commitFalha: string | null;
}

function finishWorktree(task: Task, wt: Worktree, ok: boolean): Fechamento {
  const status = git(wt.dir, ["status", "--porcelain"]);
  const changed = status.out ? status.out.split("\n").length : 0;
  let commit: string | null = null;
  let branchFalha: string | null = null;

  if (changed > 0) {
    // Num lote, o trabalho parcial de uma falha não pode ir para a branch do
    // lote: a tarefa seguinte construiria em cima de algo pela metade. Ele sai
    // numa branch à parte, para você olhar, e a do lote fica intacta.
    if (wt.lote && !ok) {
      branchFalha = branchLivre(task.repo, sanitizarRef(`${wt.branch}-falha-${slugify(task.title, 40)}`));
      const co = git(wt.dir, ["checkout", "-b", branchFalha]);
      if (!co.ok) {
        log(`não consegui separar o trabalho parcial em ${branchFalha}: ${co.err} (worktree mantida em ${wt.dir})`);
        return { changed, commit: null, branchFalha: null, commitFalha: null };
      }
    }
    git(wt.dir, ["add", "-A"]);
    const msg = `${ok ? "cq" : "cq(wip)"}: ${task.title}\n\nTarefa ${task.id} executada pelo claude-queue.` +
      (wt.lote ? `\nLote ${wt.lote.nome}, tarefa ${task.ordem}.` : "");
    const c = git(wt.dir, ["commit", "-m", msg]);
    if (!c.ok) {
      log(`commit falhou em ${wt.dir}: ${c.err} (worktree mantida para você revisar)`);
      return { changed, commit: null, branchFalha, commitFalha: null };
    }
    commit = git(wt.dir, ["rev-parse", "HEAD"]).out || null;
  }

  if (!removerWorktree(task.repo, wt.dir)) {
    // O trabalho já está commitado; a sobra só atrapalha uma nova tentativa,
    // e limparResiduoSeExistir tenta de novo antes dela.
    log(`a worktree ${wt.dir} continua no disco: algum processo ainda segura a pasta`);
  }
  // Branch sem nenhuma alteração só polui o repositório. A do lote fica: ela é
  // do conjunto, e a próxima tarefa vai precisar dela.
  if (changed === 0 && !wt.lote) git(task.repo, ["branch", "-D", wt.branch]);
  return { changed, commit: branchFalha ? null : commit, branchFalha, commitFalha: branchFalha ? commit : null };
}

// ---------- o que a execução deixou no registro ----------

export interface ChamadaNegada {
  ferramenta: string;
  entrada: string;
  resposta: string;
}

export interface Achados {
  negadas: ChamadaNegada[];
  errosDeFerramenta: ChamadaNegada[];
  escritasFora: string[];
  /** As últimas falas do modelo: é onde ele diz o que estava tentando. */
  falas: string[];
  /**
   * Os comandos de terminal que ela rodou, na ordem, e se passaram. É o que
   * responde "ela testou mesmo?" — a resposta final diz o que o modelo acha que
   * fez; isto é o que o terminal devolveu.
   */
  comandos: ComandoRodado[];
  /** Quantas vezes cada ferramenta foi chamada. */
  ferramentas: Record<string, number>;
}

export interface ComandoRodado {
  ferramenta: string;
  comando: string;
  /** null: a execução acabou antes de o resultado chegar. */
  ok: boolean | null;
  negado: boolean;
}

const FERRAMENTAS_QUE_ESCREVEM = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const FERRAMENTAS_DE_TERMINAL = new Set(["Bash", "PowerShell"]);

export const achadosVazios = (): Achados => ({
  negadas: [], errosDeFerramenta: [], escritasFora: [], falas: [], comandos: [], ferramentas: {},
});

/**
 * O caminho está fora da worktree? No Windows, o caminho no estilo do Git Bash
 * (`/d/pasta`) é convertido antes: sem isso, um arquivo dentro da worktree
 * escrito desse jeito pareceria estar fora.
 */
export function foraDaWorktree(dir: string, arquivo: string): boolean {
  let p = arquivo;
  if (isWin) {
    const m = p.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (m) p = `${m[1]}:${(m[2] || "/").replace(/\//g, "\\")}`;
  }
  const abs = path.isAbsolute(p) ? p : path.resolve(dir, p);
  const rel = path.relative(dir, abs);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

function resumirEntrada(entrada: any): string {
  if (!entrada || typeof entrada !== "object") return "";
  if (typeof entrada.command === "string") return entrada.command;
  if (typeof entrada.file_path === "string") return entrada.file_path;
  if (typeof entrada.pattern === "string") return entrada.pattern;
  return JSON.stringify(entrada).slice(0, 300);
}

function textoDoResultado(conteudo: unknown): string {
  if (typeof conteudo === "string") return conteudo;
  if (Array.isArray(conteudo)) return conteudo.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ");
  return "";
}

/** Lê o stream de eventos à medida que chega e guarda o que importa para o relatório. */
export class Observador {
  readonly achados: Achados = achadosVazios();
  private readonly usos = new Map<string, { name: string; input: any }>();
  private readonly comandoPorUso = new Map<string, ComandoRodado>();

  constructor(private readonly dir: string) {}

  evento(ev: any): void {
    const conteudo = ev?.message?.content;
    if (!Array.isArray(conteudo)) return;

    if (ev.type === "assistant") {
      for (const c of conteudo) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          this.achados.falas.push(c.text.trim());
          if (this.achados.falas.length > 3) this.achados.falas.shift();
        }
        if (c?.type === "tool_use") {
          this.usos.set(c.id, { name: c.name, input: c.input });
          this.achados.ferramentas[c.name] = (this.achados.ferramentas[c.name] ?? 0) + 1;
          if (FERRAMENTAS_DE_TERMINAL.has(c.name) && typeof c.input?.command === "string") {
            const cmd: ComandoRodado = { ferramenta: c.name, comando: c.input.command, ok: null, negado: false };
            this.achados.comandos.push(cmd);
            this.comandoPorUso.set(c.id, cmd);
          }
          const arquivo = c.input?.file_path ?? c.input?.notebook_path;
          if (FERRAMENTAS_QUE_ESCREVEM.has(c.name) && typeof arquivo === "string" && foraDaWorktree(this.dir, arquivo)) {
            if (!this.achados.escritasFora.includes(arquivo)) this.achados.escritasFora.push(arquivo);
          }
        }
      }
    }

    if (ev.type === "user") {
      for (const c of conteudo) {
        if (c?.type !== "tool_result") continue;
        const cmd = this.comandoPorUso.get(c.tool_use_id);
        if (cmd) cmd.ok = !c.is_error;
        if (!c.is_error) continue;
        const uso = this.usos.get(c.tool_use_id);
        const item: ChamadaNegada = {
          ferramenta: uso?.name ?? "?",
          entrada: resumirEntrada(uso?.input),
          resposta: textoDoResultado(c.content).slice(0, 300),
        };
        if (/denied|permission|negad/i.test(item.resposta)) {
          this.achados.negadas.push(item);
          if (cmd) cmd.negado = true;
        } else {
          this.achados.errosDeFerramenta.push(item);
          if (this.achados.errosDeFerramenta.length > 8) this.achados.errosDeFerramenta.shift();
        }
      }
    }
  }
}

// ---------- prompt ----------

function buildPrompt(task: Task, wt: Worktree, lote: string[]): string {
  const bash = task.allowedTools.filter((t) => /^(Bash|PowerShell)\(/.test(t));
  return [
    `Você está executando uma tarefa agendada, SEM supervisão humana, numa git worktree isolada (branch ${wt.branch}).`,
    "Regras:",
    `- Seu diretório de trabalho é ${wt.dir}. Todo arquivo que você criar ou alterar precisa estar dentro dele: escrita fora dele não entra na branch, e a tarefa é marcada como falha.`,
    "- Trabalhe apenas dentro deste diretório.",
    "- Não faça push, não troque de branch e não altere remotos.",
    "- Não faça commit: o agendador faz o commit ao final.",
    `- Ferramentas liberadas: ${task.allowedTools.join(", ")}. Qualquer outra é negada.`,
    ...(bash.length
      ? [
          "- Uma negação vale só para aquele comando, não para a ferramenta inteira. Se um comando for negado, " +
            "não conclua que o terminal está bloqueado: leia e procure arquivos com Read, Glob e Grep (em vez de " +
            "ls, cat, find ou grep no terminal) e continue rodando os comandos liberados acima.",
        ]
      : []),
    "- Se não conseguir rodar a verificação pedida, diga isso claramente no resumo final, com o motivo.",
    "- Se faltar informação para continuar com segurança, pare e explique o que falta.",
    "- Termine com um resumo curto: o que mudou, o que ficou pendente e como verificar.",
    ...(task.anexos.length
      ? [
          "- Os arquivos a seguir já foram copiados para dentro da sua worktree, antes de você começar. " +
            "Não tente copiá-los de novo (a origem fica fora da worktree e qualquer cópia de lá é negada):",
          ...task.anexos.map((a) => `  - ${a.para}`),
        ]
      : []),
    ...lote,
    "",
    `TAREFA: ${task.title}`,
    "",
    task.prompt,
  ].join("\n");
}

/** O trecho do prompt que situa a tarefa no lote. */
function contextoDoLote(cfg: Config, task: Task, lote: Lote): string[] {
  const todas = tarefasDoLote(cfg, lote.nome);
  const anteriores = todas.filter((t) => t.status === "done" && t.ordem < task.ordem);
  return [
    "",
    `LOTE: ${lote.nome}. Esta é a tarefa ${task.ordem} de ${todas.length}.`,
    anteriores.length
      ? "As anteriores já estão commitadas nesta branch. Construa sobre o que elas fizeram e não as refaça:"
      : "Ela é a primeira do lote a rodar.",
    ...anteriores.map((t) => `- ${t.ordem}. ${t.title}${lote.commits[t.id] ? ` (commit ${lote.commits[t.id].slice(0, 7)})` : ""}`),
    "As tarefas seguintes do lote vão construir sobre o que você entregar.",
  ];
}

// ---------- relatórios ----------

export function linhaDoComando(c: ComandoRodado): string {
  const sinal = c.negado ? "⛔ negado" : c.ok === true ? "✓" : c.ok === false ? "✗" : "?";
  return `- ${sinal} \`${c.comando.replace(/`/g, "'").replace(/\s+/g, " ").slice(0, 160)}\``;
}

/** O medidor no instante: a análise do lote compara o antes e o depois de cada tarefa. */
export interface Medicao {
  semana: number | null;
  cinco: number | null;
  fatorSemana: number | null;
  fatorCinco: number | null;
}

function medirAgora(cfg: Config): Medicao | null {
  try {
    const g = computeGauge(cfg);
    return { semana: g.seven_day.pct, cinco: g.five_hour.pct, fatorSemana: g.seven_day.factor, fatorCinco: g.five_hour.factor };
  } catch {
    return null;
  }
}

function listaDeChamadas(itens: ChamadaNegada[]): string[] {
  return itens.map((n) => `- **${n.ferramenta}** \`${n.entrada.replace(/`/g, "'").slice(0, 200)}\`\n  → ${n.resposta.replace(/\s+/g, " ").slice(0, 200)}`);
}

/**
 * O relatório de uma tarefa que falhou. Existe porque o stream cru tem
 * centenas de linhas de JSON: a pergunta "o que aconteceu?" precisa de uma
 * resposta que se lê em um minuto.
 */
function escreverRelatorioDeFalha(
  runDir: string,
  task: Task,
  d: {
    reason: string;
    code: number | null;
    inicio: number;
    turnos: number | null;
    achados: Achados;
    fechamento: Fechamento | null;
    branch: string | null;
    lote: Lote | null;
    cfg: Config;
    stderr: string;
    respostaFinal: string | null;
  }
): string {
  const f = d.fechamento;
  const linhas = [
    `# Falha: ${task.title}`,
    "",
    `- Motivo: **${d.reason}**`,
    `- Quando: ${new Date(d.inicio * 1000).toLocaleString("pt-BR")} (durou ${fmtDuration(nowSec() - d.inicio)})`,
    `- Modelo: ${task.model} · turnos: ${d.turnos ?? "?"} · código de saída: ${d.code ?? "?"}`,
    "",
    "## O que ela estava fazendo quando parou",
    "",
    ...(d.respostaFinal ? ["Resposta final:", "", "> " + d.respostaFinal.slice(0, 2000).replace(/\n/g, "\n> "), ""] : []),
    ...(d.achados.falas.length
      ? ["Últimas falas do modelo:", "", ...d.achados.falas.map((t) => "> " + t.slice(0, 1500).replace(/\n/g, "\n> ") + "\n")]
      : d.respostaFinal ? [] : ["(o modelo não chegou a escrever nada)", ""]),
    "## Comandos negados",
    "",
    ...(d.achados.negadas.length ? listaDeChamadas(d.achados.negadas) : ["Nenhum."]),
    "",
    "## Erros de ferramenta",
    "",
    ...(d.achados.errosDeFerramenta.length ? listaDeChamadas(d.achados.errosDeFerramenta) : ["Nenhum."]),
    "",
  ];

  if (d.achados.escritasFora.length) {
    linhas.push(
      "## Escritas fora da worktree",
      "",
      "Estes arquivos foram gravados fora do diretório da tarefa e **não entraram em branch nenhuma**:",
      "",
      ...d.achados.escritasFora.map((a) => `- \`${a}\``),
      ""
    );
  }

  linhas.push("## O que ficou", "");
  if (!f) linhas.push("A worktree nem chegou a ser criada: nada foi alterado.");
  else if (f.changed === 0) linhas.push("Nenhum arquivo alterado.");
  else if (f.branchFalha) linhas.push(`${f.changed} arquivo(s) alterado(s), commitados como \`cq(wip)${f.commitFalha ? ` ${f.commitFalha.slice(0, 7)}` : ""}\` em \`${f.branchFalha}\` (fora da branch do lote, para não travar as tarefas seguintes nela).`);
  else if (d.branch) linhas.push(`${f.changed} arquivo(s) alterado(s), commitados como \`cq(wip)\` em \`${d.branch}\`.`);
  linhas.push("");

  if (d.lote) {
    const todas = tarefasDoLote(d.cfg, d.lote.nome);
    const antes = todas.filter((t) => t.status === "done" && t.ordem < task.ordem);
    const depois = todas.filter((t) => t.status === "queued" && t.id !== task.id);
    linhas.push(
      `## O lote ${d.lote.nome}`,
      "",
      antes.length ? `Já commitadas em \`${d.lote.branch}\`: ${antes.map((t) => `${t.ordem}. ${t.title}`).join("; ")}.` : "Nenhuma tarefa anterior commitada.",
      "",
      depois.length ? `Paradas até você decidir: ${depois.map((t) => `${t.ordem}. ${t.title}`).join("; ")}.` : "Não há tarefas depois desta.",
      "",
      "No painel, com o botão direito nesta tarefa: **Tentar de novo**, **Pular no lote** ou **Cancelar lote**.",
      ""
    );
  }

  if (d.stderr.trim()) linhas.push("## Saída de erro do processo", "", "```", d.stderr.trim().slice(-3000), "```", "");
  linhas.push("## Registro completo", "", `\`${path.join(runDir, "stream.jsonl")}\` — um evento JSON por linha.`, "");

  const destino = path.join(runDir, "falha.md");
  fs.writeFileSync(destino, linhas.join("\n"));
  return destino;
}

// ---------- execução de uma tarefa ----------

/**
 * A CLI falava por `console.log`. A extensão precisa da mesma informação em
 * três lugares (OutputChannel, notificação e árvore), então o laço emite
 * eventos e quem chama decide o que fazer com eles.
 */
export type RunEvent =
  | { kind: "log"; message: string }
  | { kind: "queue-empty" }
  | { kind: "waiting"; reasons: string[] }
  | { kind: "uncalibrated" }
  | { kind: "busy" }
  | { kind: "blocked"; motivos: string[] }
  | { kind: "task-start"; task: Task; decision: Decision }
  | { kind: "task-end"; task: Task; result: RunResult }
  | { kind: "queue-paused"; reason: string };

export interface TaskOptions {
  onEvent?: (e: RunEvent) => void;
  /** Cancelamento pelo comando Cancelar e pelo fechamento do VS Code. */
  signal?: AbortSignal;
  /** Motivo registrado quando o sinal dispara. */
  abortReason?: string;
}

export interface QueueOptions extends TaskOptions {
  dryRun?: boolean;
  force?: boolean;
  max?: number;
}

export interface RunResult {
  ok: boolean;
  reason: string;
  branch?: string;
  filesChanged?: number;
  turns?: number;
  costUsd?: number;
  stopQueue: boolean;
  lote?: string;
  commit?: string;
  branchFalha?: string;
  commitFalha?: string;
  negadas?: number;
  /** Caminho do `falha.md`, quando falhou. */
  relatorioFalha?: string;
}

/**
 * Copia os anexos da tarefa para dentro da worktree ANTES de chamar o Claude.
 * Roda no processo da extensão, nunca pelo sandbox de permissão -- por isso
 * nunca é negado, ao contrário de um `cp`/`Copy-Item` pedido no prompt com
 * origem fora da worktree (caso real: 5 tentativas diferentes, todas
 * negadas, antes de a tarefa desistir e seguir sem os arquivos).
 */
function copiarAnexos(task: Task, wt: Worktree): void {
  for (const anexo of task.anexos) {
    if (!fs.existsSync(anexo.de)) throw new Error(`anexo não encontrado: ${anexo.de}`);
    const destino = path.resolve(wt.dir, anexo.para);
    if (foraDaWorktree(wt.dir, destino)) throw new Error(`anexo aponta para fora da worktree: ${anexo.para}`);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.cpSync(anexo.de, destino, { recursive: true });
  }
}

/** Sem worktree, sem turno gasto: mesmo formato de relatório de uma falha de verdade. */
/**
 * Uma nova execução da mesma tarefa reaproveita a pasta. O `result.md` e o
 * registro são reescritos, mas o `falha.md` (e o `stderr.txt`) de uma tentativa
 * que falhou ficariam lá com cara de estado atual -- e uma tarefa concluída na
 * segunda tentativa continuaria "parada por limite" para quem abrisse a pasta.
 * Eles ganham o número da tentativa a que pertencem: o histórico fica, sem
 * confundir.
 */
export function guardarTentativaAnterior(id: string, runDir: string): void {
  const tentativas = readJsonl<{ id: string }>(P.ledger).filter((l) => l?.id === id).length;
  for (const [nome, ext] of [["falha", "md"], ["stderr", "txt"]] as const) {
    const atual = path.join(runDir, `${nome}.${ext}`);
    if (!fs.existsSync(atual)) continue;
    let n = Math.max(1, tentativas);
    while (fs.existsSync(path.join(runDir, `${nome}-tentativa-${n}.${ext}`))) n++;
    fs.renameSync(atual, path.join(runDir, `${nome}-tentativa-${n}.${ext}`));
  }
}

function falharAntesDeComecar(task: Task, cfg: Config, runDir: string, started: number, motivo: string): RunResult {
  const lote = task.lote ? lerLote(task.lote) : null;
  const relatorioFalha = escreverRelatorioDeFalha(runDir, task, {
    reason: motivo, code: null, inicio: started, turnos: null,
    achados: achadosVazios(),
    fechamento: null, branch: null, lote, cfg, stderr: "", respostaFinal: null,
  });
  appendJsonl(P.ledger, {
    id: task.id, title: task.title, repo: task.repo, branch: null, base: task.base, model: task.model,
    start: started, end: nowSec(), ok: false, reason: motivo, filesChanged: 0, lote: lote?.nome ?? null,
  });
  log(`${task.id}: falhou antes de começar (${motivo})`);
  return { ok: false, reason: motivo, stopQueue: false, lote: lote?.nome ?? undefined, relatorioFalha, filesChanged: 0 };
}

export async function runTask(task: Task, cfg: Config, opts: TaskOptions = {}): Promise<RunResult> {
  const runDir = path.join(P.runs, task.id);
  fs.mkdirSync(runDir, { recursive: true });
  guardarTentativaAnterior(task.id, runDir);
  const started = nowSec();
  const medidorAntes = medirAgora(cfg);
  let wt: Worktree;
  try {
    wt = prepareWorktree(task, cfg);
  } catch (e: any) {
    return falharAntesDeComecar(task, cfg, runDir, started, e.message);
  }

  if (task.anexos.length) {
    try {
      copiarAnexos(task, wt);
    } catch (e: any) {
      git(task.repo, ["worktree", "remove", "--force", wt.dir]);
      // Mesma regra do fim normal (finishWorktree): branch nova e vazia não
      // fica para trás. A do lote nunca é apagada aqui -- pode já carregar
      // commit de tarefa anterior.
      if (!wt.lote) git(task.repo, ["branch", "-D", wt.branch]);
      return falharAntesDeComecar(task, cfg, runDir, started, e.message);
    }
  }

  const bin = resolveClaude(cfg);
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", task.model,
    "--max-turns", String(task.maxTurns),
    "--permission-mode", "dontAsk",
    "--allowedTools", task.allowedTools.join(","),
  ];
  log(`iniciando ${task.id} em ${wt.dir} (${wt.branch} a partir de ${wt.base}${wt.lote ? `, lote ${wt.lote.nome}` : ""})`);

  const streamFile = fs.createWriteStream(path.join(runDir, "stream.jsonl"));
  const child = spawnClaude(bin, args, wt.dir);
  const contencao = isWin && child.pid ? conterProcesso(child.pid, log) : null;
  child.stdin!.end(buildPrompt(task, wt, wt.lote ? contextoDoLote(cfg, task, wt.lote) : []));

  const observador = new Observador(wt.dir);
  let result: any = null;
  let aborted = "";
  let stopQueue = false;
  let stderr = "";
  let buf = "";

  const onLine = (line: string) => {
    if (!line.trim()) return;
    streamFile.write(line + "\n");
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    observador.evento(ev);
    if (ev.type === "result") result = ev;
    if (ev.type === "rate_limit_event") {
      const info = ev.rate_limit_info || {};
      const snap = snapshotFromRateLimitEvent(info);
      if (snap) recordSnapshot(snap);
      const resetsAt = toEpochSec(info.resetsAt);
      const kind = info.rateLimitType || "limite";
      if (info.status === "rejected") {
        setBrake(resetsAt ?? nowSec() + 3600, `Claude Code recusou por ${kind}`);
        opts.onEvent?.({ kind: "log", message: `limite ${kind} atingido: o Claude Code recusou a chamada` });
        aborted = `limite ${kind} atingido`;
        stopQueue = true;
        killTree(child);
      } else if (info.status === "allowed_warning") {
        const until = Math.min(resetsAt ?? Infinity, nowSec() + cfg.warningPauseHours * 3600);
        setBrake(until, `aviso de proximidade do limite ${kind}`);
        opts.onEvent?.({ kind: "log", message: `aviso de proximidade do limite ${kind}` });
        stopQueue = true;
        if (cfg.onWarning === "abort") {
          aborted = `aviso de limite ${kind}`;
          killTree(child);
        }
      }
    }
  };

  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => {
    stderr += d;
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });

  const timer = setTimeout(() => {
    aborted = `timeout de ${task.timeoutMin} min`;
    killTree(child);
  }, task.timeoutMin * 60_000);

  // Matar a arvore faz o processo fechar, e o fluxo normal segue: o que ja foi
  // escrito vira commit cq(wip) e a worktree e removida. E por isso que cancelar
  // nao deixa lixo para tras.
  const onAbort = () => {
    aborted = opts.abortReason || "cancelada";
    killTree(child);
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const code: number | null = await new Promise((res) => {
    child.on("close", (c) => res(c));
    child.on("error", (e) => {
      stderr += String(e);
      res(-1);
    });
  });
  clearTimeout(timer);
  // Antes de remover a worktree: o que a tarefa deixou rodando (servidor de
  // dev, banco embutido de teste) seguraria a pasta.
  await contencao?.encerrar();
  opts.signal?.removeEventListener("abort", onAbort);
  if (buf.trim()) onLine(buf);
  streamFile.end();
  if (stderr.trim()) fs.writeFileSync(path.join(runDir, "stderr.txt"), stderr);

  const achados = observador.achados;
  // Escrever fora da worktree é falha mesmo com o modelo dizendo que terminou:
  // o arquivo não entra em branch nenhuma, e "concluída, 0 arquivos" esconderia
  // isso — foi exatamente o que aconteceu com o guia do site em 29/09.
  const fora = achados.escritasFora.length
    ? `gravou fora da worktree: ${achados.escritasFora[0]}${achados.escritasFora.length > 1 ? ` e mais ${achados.escritasFora.length - 1}` : ""}`
    : "";
  const ok = !aborted && !fora && !!result && !result.is_error && code === 0;
  const reason =
    aborted ||
    fora ||
    (!result ? `claude saiu com código ${code} sem resultado` : result.is_error ? `erro: ${result.subtype || "desconhecido"}` : "concluída");
  const fechamento = finishWorktree(task, wt, ok);
  const filesChanged = fechamento.changed;
  const branchDaTarefa = wt.lote ? (ok ? wt.branch : fechamento.branchFalha) : filesChanged > 0 ? wt.branch : null;
  const branchOut = branchDaTarefa ?? "(nenhuma, sem alterações)";

  const relatorioFalha = ok
    ? undefined
    : escreverRelatorioDeFalha(runDir, task, {
        reason, code, inicio: started, turnos: result?.num_turns ?? null, achados, fechamento,
        branch: branchDaTarefa, lote: wt.lote, cfg, stderr, respostaFinal: result?.result ?? null,
      });

  const summary = [
    `# ${task.title}`,
    "",
    `- Status: ${ok ? "concluída" : "falhou"} (${reason})`,
    `- Repositório: ${task.repo}`,
    `- Branch: ${branchOut} (base ${wt.base})`,
    ...(wt.lote ? [`- Lote: ${wt.lote.nome}, tarefa ${task.ordem}${fechamento.commit ? ` · commit ${fechamento.commit.slice(0, 7)}` : ""}`] : []),
    `- Arquivos alterados: ${filesChanged}`,
    `- Turnos: ${result?.num_turns ?? "?"}`,
    `- Custo equivalente em API: ${result?.total_cost_usd !== undefined ? `US$ ${Number(result.total_cost_usd).toFixed(2)}` : "?"}`,
    ...(relatorioFalha ? [`- Relatório da falha: ${relatorioFalha}`] : []),
    "",
    ...(achados.negadas.length
      ? [
          `## Comandos negados (${achados.negadas.length})`,
          "",
          "Algo pode não ter sido verificado. Confira na resposta abaixo o que ela diz que rodou.",
          "",
          ...listaDeChamadas(achados.negadas),
          "",
        ]
      : []),
    ...(achados.escritasFora.length
      ? ["## Escritas fora da worktree", "", ...achados.escritasFora.map((a) => `- \`${a}\``), ""]
      : []),
    ...(achados.comandos.length
      ? [`## Comandos rodados (${achados.comandos.length})`, "", ...achados.comandos.map(linhaDoComando), ""]
      : ["## Comandos rodados", "", "Nenhum comando de terminal.", ""]),
    "## Resposta final do Claude",
    "",
    result?.result || "(sem resposta final)",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(runDir, "result.md"), summary);
  // Os detalhes ficam ao lado do resultado, e não no ledger: o ledger é lido
  // inteiro a cada redesenho da árvore, e uma lista de comandos por linha o
  // faria crescer à toa.
  fs.writeFileSync(
    path.join(runDir, "detalhes.json"),
    JSON.stringify({ comandos: achados.comandos, ferramentas: achados.ferramentas, errosDeFerramenta: achados.errosDeFerramenta.length }, null, 2)
  );

  appendJsonl(P.ledger, {
    id: task.id, title: task.title, repo: task.repo, branch: branchDaTarefa, base: wt.base, model: task.model,
    start: started, end: nowSec(), ok, reason, filesChanged,
    turns: result?.num_turns ?? null, costUsd: result?.total_cost_usd ?? null, usage: result?.usage ?? null,
    lote: wt.lote?.nome ?? null, commit: fechamento.commit, branchFalha: fechamento.branchFalha,
    negadas: achados.negadas.length,
    pesoTokens: pesoDoUso(result?.usage, task.model, cfg),
    medidor: { antes: medidorAntes, depois: medirAgora(cfg) },
  });
  log(`${task.id}: ${ok ? "ok" : "falhou"} (${reason}), ${filesChanged} arquivo(s), branch ${branchOut}`);

  return {
    ok, reason, branch: branchDaTarefa ?? undefined, filesChanged, turns: result?.num_turns, costUsd: result?.total_cost_usd, stopQueue,
    lote: wt.lote?.nome, commit: fechamento.commit ?? undefined, branchFalha: fechamento.branchFalha ?? undefined,
    commitFalha: fechamento.commitFalha ?? undefined,
    negadas: achados.negadas.length, relatorioFalha,
  };
}

// ---------- laço principal ----------

/** Depois de uma tarefa de lote: o lote anda, ou para esperando você. */
function fecharNoLote(cfg: Config, task: Task, r: RunResult): void {
  if (!task.lote) return;
  if (r.ok) registrarSucesso(cfg, task, r.commit ?? null);
  else {
    bloquearLote(task.lote, {
      tarefa: task.id,
      titulo: task.title,
      motivo: r.reason,
      branchFalha: r.branchFalha ?? null,
      commitFalha: r.commitFalha ?? null,
      porLimite: r.stopQueue,
      em: nowSec(),
    });
  }
  escreverRelatorioDoLote(cfg, task.lote);
  // A análise sai quando o lote termina: é o ponto em que alguém vai revisar.
  if (lerLote(task.lote)?.estado === "concluido") escreverAnaliseDoLote(cfg, task.lote);
}

/**
 * Lote bloqueado só porque o Claude Code recusou por limite (não porque a
 * tarefa teve um problema de verdade): com orçamento de novo, ela volta
 * sozinha para a fila, sem esperar "Tentar de novo". Bloqueio por qualquer
 * outro motivo (teste quebrado, ferramenta negada, o que for) nunca entra
 * aqui -- só quem nasceu com `porLimite`, e só enquanto a tarefa ainda
 * estiver em Com falha (se você já decidiu manualmente, isso não mexe).
 */
function retomarBloqueiosPorLimite(cfg: Config): void {
  if (!evaluate(cfg).ok) return;
  for (const lote of listarLotes()) {
    if (lote.estado !== "bloqueado" || !lote.bloqueio?.porLimite) continue;
    const tarefa = listTasks(cfg, "failed").find((t) => t.id === lote.bloqueio!.tarefa);
    if (!tarefa) continue;
    moveTask(tarefa, "queued");
    desbloquearLote(lote.nome);
    log(`lote ${lote.nome}: orçamento voltou, ${tarefa.id} retomada sozinha`);
  }
}

export async function runQueue(cfg: Config, opts: QueueOptions): Promise<number> {
  const emit = (e: RunEvent) => opts.onEvent?.(e);
  // Uma instancia so, mesmo com varias janelas do VS Code abertas.
  if (!acquireLock()) {
    emit({ kind: "busy" });
    return 0;
  }
  retomarBloqueiosPorLimite(cfg);
  let ran = 0;
  let force = !!opts.force;
  try {
    const max = opts.max ?? cfg.maxTasksPerRun;
    while (ran < max) {
      if (opts.signal?.aborted) break;
      const tasks = listTasks(cfg, "queued");
      if (!tasks.length) {
        if (ran === 0) emit({ kind: "queue-empty" });
        break;
      }
      // Tarefa de lote só roda na vez dela, e nunca com o lote bloqueado.
      const task = proximaTarefa(tasks);
      if (!task) {
        const motivos = lotesParados(tasks);
        emit({ kind: "blocked", motivos });
        log(`nada pode rodar agora: ${motivos.join("; ")}`);
        break;
      }
      const d = evaluate(cfg);
      if (!d.ok && !force) {
        emit({ kind: "waiting", reasons: d.reasons });
        log(`aguardando cota: ${d.reasons.join("; ")}`);
        break;
      }
      if (ran >= 1 && d.gauge.seven_day.confidence !== "calibrated") {
        // Sem calibracao o medidor nao enxerga o proprio consumo da fila:
        // roda uma por ciclo e espera uma leitura nova.
        emit({ kind: "uncalibrated" });
        break;
      }
      emit({ kind: "task-start", task, decision: d });
      if (opts.dryRun) {
        emit({ kind: "log", message: `(simulacao) rodaria: ${task.title}` });
        break;
      }
      const r = await runTask(task, cfg, opts);
      moveTask(task, r.ok ? "done" : "failed");
      fecharNoLote(cfg, task, r);
      emit({ kind: "task-end", task, result: r });
      ran++;
      if (r.stopQueue) {
        emit({ kind: "queue-paused", reason: r.reason });
        break;
      }
      force = false; // forcar vale so para a primeira tarefa
    }
  } finally {
    releaseLock();
  }
  return ran;
}
