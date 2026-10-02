import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Config } from "./config";
import { Lote, lerLote, nomeDoLote, tarefasDoLote } from "./lote";
import { Task } from "./queue";
import { loadHistory } from "./snapshot";
import { P, fmtDuration, readJson, readJsonl } from "./util";

/**
 * A análise de um lote: o que custou, o que foi feito e o que merece atenção.
 *
 * O relatório do lote (`lote.ts`) responde "em que pé está?". Esta responde a
 * pergunta de quem vai revisar e juntar: quanto do limite isso gastou, qual
 * modelo pagou o quê, o que cada tarefa rodou de verdade, e onde é mais
 * provável haver defeito.
 *
 * Tudo aqui é leitura do que já foi registrado — ledger, `detalhes.json`,
 * `result.md` e o git. Nada é recalculado a partir do `claude`.
 */

interface Uso {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

interface Medicao {
  semana: number | null;
  cinco: number | null;
  fatorSemana: number | null;
  fatorCinco: number | null;
}

interface LinhaDoLedger {
  id: string;
  model: string;
  start: number;
  end: number;
  ok: boolean;
  reason: string;
  filesChanged: number;
  turns?: number | null;
  costUsd?: number | null;
  usage?: Uso | null;
  commit?: string | null;
  negadas?: number;
  pesoTokens?: number;
  medidor?: { antes: Medicao | null; depois: Medicao | null };
}

interface Comando {
  comando: string;
  ok: boolean | null;
  negado: boolean;
}

interface Detalhes {
  comandos: Comando[];
  ferramentas: Record<string, number>;
  errosDeFerramenta: number;
}

interface Alteracao {
  arquivo: string;
  mais: number;
  menos: number;
}

export interface AnaliseDaTarefa {
  task: Task;
  situacao: "concluída" | "falhou" | "pulada" | "não rodou";
  ledger: LinhaDoLedger | null;
  /** Todas as execuções, em ordem; a última é `ledger`. Mais de uma quando houve nova tentativa. */
  execucoes: LinhaDoLedger[];
  duracao: number | null;
  tokens: { entrada: number; saida: number; cacheLido: number; cacheEscrito: number; raciocinio: number } | null;
  custo: number | null;
  /** Pontos percentuais estimados pela calibração; null sem calibração. */
  pctSemana: number | null;
  pctCinco: number | null;
  alteracoes: Alteracao[];
  detalhes: Detalhes | null;
  resumo: string;
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

function alteracoesDoCommit(repo: string, commit: string): Alteracao[] {
  const saida = git(repo, ["show", "--numstat", "--format=", commit]);
  if (!saida) return [];
  return saida
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [mais, menos, ...resto] = l.split("\t");
      // arquivo binário aparece como "-": conta como zero linha
      return { arquivo: resto.join("\t"), mais: Number(mais) || 0, menos: Number(menos) || 0 };
    });
}

/** O começo da resposta final: o suficiente para dizer o que foi feito. */
function resumoDaResposta(id: string): string {
  let texto = "";
  try {
    texto = fs.readFileSync(path.join(P.runs, id, "result.md"), "utf8");
  } catch {
    return "";
  }
  const i = texto.indexOf("## Resposta final do Claude");
  if (i < 0) return "";
  const corpo = texto.slice(i + "## Resposta final do Claude".length).trim();
  const paragrafos = corpo.split(/\n\s*\n/).filter((p) => p.trim() && !/^#/.test(p.trim()));
  const curto = paragrafos.slice(0, 2).join("\n\n");
  return curto.length > 700 ? curto.slice(0, 700).trimEnd() + "…" : curto;
}

const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);

export function analisarTarefa(
  lote: Lote,
  task: Task,
  ledger: LinhaDoLedger | null,
  execucoes: LinhaDoLedger[] = ledger ? [ledger] : []
): AnaliseDaTarefa {
  const pulada = lote.puladas.includes(task.id);
  const situacao = pulada ? "pulada" : !ledger ? "não rodou" : ledger.ok ? "concluída" : "falhou";
  const u = ledger?.usage ?? null;
  const fator = (campo: "fatorSemana" | "fatorCinco") => ledger?.medidor?.depois?.[campo] ?? ledger?.medidor?.antes?.[campo] ?? null;
  const pct = (f: number | null) => (f !== null && ledger?.pesoTokens ? (f * ledger.pesoTokens) / 1e6 : null);
  const commit = lote.commits[task.id] ?? ledger?.commit ?? null;

  return {
    task,
    situacao,
    ledger,
    execucoes,
    duracao: ledger ? ledger.end - ledger.start : null,
    tokens: u
      ? {
          entrada: n(u.input_tokens),
          saida: n(u.output_tokens),
          cacheLido: n(u.cache_read_input_tokens),
          cacheEscrito: n(u.cache_creation_input_tokens),
          raciocinio: n(u.output_tokens_details?.thinking_tokens),
        }
      : null,
    custo: typeof ledger?.costUsd === "number" ? ledger.costUsd : null,
    pctSemana: pct(fator("fatorSemana")),
    pctCinco: pct(fator("fatorCinco")),
    alteracoes: commit ? alteracoesDoCommit(lote.repo, commit) : [],
    detalhes: ledger ? readJson<Detalhes | null>(path.join(P.runs, task.id, "detalhes.json"), null) : null,
    resumo: ledger ? resumoDaResposta(task.id) : "",
  };
}

// ---------- formatação ----------

function tokens(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2).replace(".", ",")} mi`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} mil`;
  return String(v);
}
const dinheiro = (v: number | null) => (v === null ? "—" : `US$ ${v.toFixed(2)}`);
const pontos = (v: number | null) => (v === null ? "—" : `${v.toFixed(1).replace(".", ",")} pp`);
const duracao = (s: number | null) => (s === null ? "—" : fmtDuration(Math.max(0, s)));
const quando = (ts: number) => new Date(ts * 1000).toLocaleString();
const soma = <T>(xs: T[], f: (x: T) => number | null) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);
const algum = <T>(xs: T[], f: (x: T) => number | null) => xs.some((x) => f(x) !== null);
const cmdCurto = (c: string) => c.replace(/`/g, "'").replace(/\s+/g, " ").slice(0, 120);

function sinalDoComando(c: Comando): string {
  return c.negado ? "⛔" : c.ok === true ? "✓" : c.ok === false ? "✗" : "?";
}

/**
 * A variação medida da semana entre o início e o fim do lote, pelas leituras
 * do medidor. Inclui qualquer outro uso da conta no período — por isso vem ao
 * lado da estimativa, e não no lugar dela.
 */
function variacaoMedida(inicio: number, fim: number): { antes: number; depois: number } | null {
  const leituras = loadHistory().filter((s) => s.seven_day && typeof s.seven_day.pct === "number");
  const antes = [...leituras].reverse().find((s) => s.ts <= inicio);
  const depois = leituras.find((s) => s.ts >= fim);
  if (!antes || !depois) return null;
  const mesmaJanela =
    antes.seven_day!.resetsAt === null || depois.seven_day!.resetsAt === null ||
    Math.abs(antes.seven_day!.resetsAt - depois.seven_day!.resetsAt) <= 120;
  if (!mesmaJanela) return null;
  return { antes: antes.seven_day!.pct, depois: depois.seven_day!.pct };
}

export const analiseDoLotePath = (nome: string) => path.join(P.lotes, `${nomeDoLote(nome)}-analise.md`);

export interface Analise {
  lote: Lote;
  tarefas: AnaliseDaTarefa[];
  markdown: string;
}

export function analisarLote(cfg: Config, nome: string): Analise | null {
  const lote = lerLote(nome);
  if (!lote) return null;
  const porId = new Map<string, LinhaDoLedger[]>();
  for (const l of readJsonl<LinhaDoLedger>(P.ledger)) porId.set(l.id, [...(porId.get(l.id) ?? []), l]);
  const tarefas = tarefasDoLote(cfg, nome).map((t) => {
    const execucoes = (porId.get(t.id) ?? []).sort((a, b) => a.start - b.start);
    return analisarTarefa(lote, t, execucoes[execucoes.length - 1] ?? null, execucoes);
  });
  const rodaram = tarefas.filter((t) => t.ledger);
  const todasExecucoes = tarefas.flatMap((t) => t.execucoes);

  const inicio = todasExecucoes.length ? Math.min(...todasExecucoes.map((e) => e.start)) : null;
  const fim = todasExecucoes.length ? Math.max(...todasExecucoes.map((e) => e.end)) : null;
  const todasAlteracoes = tarefas.flatMap((t) => t.alteracoes);
  const geral = lote.branch ? git(lote.repo, ["diff", "--shortstat", `${lote.base}...${lote.branch}`]) : null;
  const medida = inicio !== null && fim !== null ? variacaoMedida(inicio, fim) : null;

  const L: string[] = [];
  L.push(`# Análise do lote ${lote.nome}`, "");
  L.push(
    `Estado **${lote.estado}** · base \`${lote.base}\` · branch ${lote.branch ? `\`${lote.branch}\`` : "—"}`,
    ""
  );

  // ---------- resumo ----------
  L.push("## Resumo", "", "| | |", "|---|---|");
  L.push(`| Tarefas | ${tarefas.length} (${tarefas.filter((t) => t.situacao === "concluída").length} concluídas, ${tarefas.filter((t) => t.situacao === "falhou").length} com falha, ${tarefas.filter((t) => t.situacao === "pulada").length} puladas) |`);
  L.push(`| Tempo do lote | ${inicio !== null && fim !== null ? `${duracao(fim - inicio)} (de ${quando(inicio)} a ${quando(fim)})` : "—"} |`);
  L.push(`| Tempo de execução somado | ${duracao(soma(todasExecucoes, (e) => e.end - e.start))} |`);
  L.push(`| Commits | ${Object.keys(lote.commits).length} |`);
  L.push(`| Alterações | ${geral || `${new Set(todasAlteracoes.map((a) => a.arquivo)).size} arquivo(s)`} |`);
  L.push(`| Custo equivalente em API | ${dinheiro(algum(rodaram, (t) => t.custo) ? soma(rodaram, (t) => t.custo) : null)} |`);
  L.push(`| Limite da semana, estimado | ${pontos(algum(rodaram, (t) => t.pctSemana) ? soma(rodaram, (t) => t.pctSemana) : null)} |`);
  L.push(
    `| Limite da semana, medido | ${medida ? `${medida.antes.toFixed(1)}% → ${medida.depois.toFixed(1)}% (${pontos(medida.depois - medida.antes)}; inclui outro uso da conta no período)` : "sem leituras do medidor antes e depois do lote"} |`
  );
  L.push("");

  // ---------- linha do tempo ----------
  // Uma linha por execução, não por tarefa: uma nova tentativa aparece como
  // outra linha, e o intervalo entre elas mostra quanto tempo o lote esperou.
  if (todasExecucoes.length) {
    L.push("## Linha do tempo", "", "| # | Tarefa | Início | Fim | Duração | Resultado |", "|---|---|---|---|---|---|");
    const linhas = tarefas
      .flatMap((t) => t.execucoes.map((e, i) => ({ t, e, tentativa: i + 1, total: t.execucoes.length })))
      .sort((a, b) => a.e.start - b.e.start);
    for (const { t, e, tentativa, total } of linhas) {
      const rotulo = total > 1 ? `${t.task.title} (tentativa ${tentativa})` : t.task.title;
      L.push(
        `| ${t.task.ordem} | ${rotulo} | ${quando(e.start)} | ${quando(e.end)} | ${duracao(e.end - e.start)} | ${e.ok ? "✓ concluída" : `✗ ${e.reason}`} |`
      );
    }
    L.push("");
  }

  // ---------- consumo ----------
  L.push("## Consumo por tarefa", "");
  L.push("| # | Tarefa | Modelo | Duração | Turnos | Entrada | Saída | Cache lido | Cache escrito | Raciocínio | Custo | Semana | 5h |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const t of tarefas) {
    const k = t.tokens;
    L.push(
      `| ${t.task.ordem} | ${t.task.title} | ${t.task.model} | ${duracao(t.duracao)} | ${t.ledger?.turns ?? "—"} | ` +
        `${k ? tokens(k.entrada) : "—"} | ${k ? tokens(k.saida) : "—"} | ${k ? tokens(k.cacheLido) : "—"} | ${k ? tokens(k.cacheEscrito) : "—"} | ${k ? tokens(k.raciocinio) : "—"} | ` +
        `${dinheiro(t.custo)} | ${pontos(t.pctSemana)} | ${pontos(t.pctCinco)} |`
    );
  }
  L.push(
    "",
    "*Semana* e *5h* são estimativas: tokens ponderados pelos mesmos pesos do medidor, vezes o fator da calibração no fim de cada tarefa. " +
      "\"—\" quando ainda não havia calibração. O custo em US$ é o equivalente de API que o próprio Claude Code informa; no plano de assinatura, ele serve para comparar tarefas, não é cobrança.",
    ""
  );

  // ---------- por modelo ----------
  const modelos = [...new Set(rodaram.map((t) => t.task.model))];
  if (modelos.length) {
    L.push("## Por modelo", "", "| Modelo | Tarefas | Custo | Semana | Duração média | Turnos em média |", "|---|---|---|---|---|---|");
    for (const m of modelos) {
      const doModelo = rodaram.filter((t) => t.task.model === m);
      L.push(
        `| ${m} | ${doModelo.length} | ${dinheiro(soma(doModelo, (t) => t.custo))} | ${pontos(algum(doModelo, (t) => t.pctSemana) ? soma(doModelo, (t) => t.pctSemana) : null)} | ` +
          `${duracao(soma(doModelo, (t) => t.duracao) / doModelo.length)} | ${(soma(doModelo, (t) => t.ledger?.turns ?? null) / doModelo.length).toFixed(0)} |`
      );
    }
    L.push("");
  }

  // ---------- pontos de atenção ----------
  const atencao: string[] = [];
  for (const t of tarefas) {
    if (t.situacao === "falhou") atencao.push(`**${t.task.ordem}. ${t.task.title}** falhou: ${t.ledger?.reason}. Relatório em \`${path.join(P.runs, t.task.id, "falha.md")}\`.`);
    if (t.situacao === "pulada") atencao.push(`**${t.task.ordem}. ${t.task.title}** foi pulada: as seguintes rodaram sem ela.`);
    if (t.situacao === "concluída" && t.detalhes) {
      const passaram = t.detalhes.comandos.filter((c) => c.ok === true && !c.negado).length;
      if (!passaram) atencao.push(`**${t.task.ordem}. ${t.task.title}** concluiu sem nenhum comando de terminal que passasse — a verificação pedida pode não ter rodado.`);
      const falharam = t.detalhes.comandos.filter((c) => c.ok === false && !c.negado);
      if (falharam.length) atencao.push(`**${t.task.ordem}. ${t.task.title}** concluiu, mas ${falharam.length} comando(s) falharam no caminho: ${falharam.slice(0, 3).map((c) => `\`${cmdCurto(c.comando)}\``).join(", ")}.`);
    }
    if (t.ledger?.negadas) atencao.push(`**${t.task.ordem}. ${t.task.title}** teve ${t.ledger.negadas} comando(s) negado(s).`);
    if (t.situacao === "concluída" && t.detalhes === null) atencao.push(`**${t.task.ordem}. ${t.task.title}** rodou numa versão anterior da fila: comandos não registrados.`);
  }
  const porArquivo = new Map<string, number[]>();
  for (const t of tarefas) for (const a of t.alteracoes) porArquivo.set(a.arquivo, [...(porArquivo.get(a.arquivo) ?? []), t.task.ordem]);
  for (const [arquivo, ordens] of porArquivo) {
    if (ordens.length > 1) atencao.push(`\`${arquivo}\` foi alterado pelas tarefas ${ordens.join(", ")} — é o ponto mais provável de uma desfazer parte da outra.`);
  }
  L.push("## Pontos de atenção", "", ...(atencao.length ? atencao.map((a) => `- ${a}`) : ["Nenhum."]), "");

  // ---------- por tarefa ----------
  L.push("## O que cada tarefa fez", "");
  for (const t of tarefas) {
    const commit = lote.commits[t.task.id];
    L.push(`### ${t.task.ordem}. ${t.task.title}`, "");
    L.push(`${t.situacao} · ${t.task.model}${commit ? ` · commit \`${commit.slice(0, 7)}\`` : ""}${t.ledger ? ` · ${t.ledger.turns ?? "?"} turnos` : ""}`, "");
    if (t.ledger) {
      const tentativas = t.execucoes.length > 1 ? ` (${t.execucoes.length}ª tentativa)` : "";
      L.push(`Início ${quando(t.ledger.start)} · fim ${quando(t.ledger.end)} · ${duracao(t.duracao)}${tentativas}`, "");
    }
    if (t.resumo) L.push(t.resumo.split("\n").map((l) => `> ${l}`).join("\n"), "");
    if (t.alteracoes.length) {
      L.push("Arquivos:", "");
      for (const a of t.alteracoes) L.push(`- \`${a.arquivo}\` +${a.mais} −${a.menos}`);
      L.push("");
    }
    if (t.detalhes) {
      if (t.detalhes.comandos.length) {
        L.push("Comandos:", "");
        for (const c of t.detalhes.comandos.slice(0, 25)) L.push(`- ${sinalDoComando(c)} \`${cmdCurto(c.comando)}\``);
        if (t.detalhes.comandos.length > 25) L.push(`- … e mais ${t.detalhes.comandos.length - 25}`);
        L.push("");
      } else L.push("Nenhum comando de terminal.", "");
      const usadas = Object.entries(t.detalhes.ferramentas).sort((a, b) => b[1] - a[1]);
      if (usadas.length) L.push(`Ferramentas: ${usadas.map(([f, q]) => `${f} ${q}×`).join(", ")}.`, "");
    }
    L.push(`Resultado completo: \`${path.join(P.runs, t.task.id, "result.md")}\``, "");
  }

  // ---------- para revisar ----------
  if (lote.branch) {
    L.push(
      "## Para revisar e juntar",
      "",
      "```",
      `git log --reverse --stat ${lote.base}..${lote.branch}`,
      `git diff ${lote.base}...${lote.branch}`,
      `git checkout ${lote.base} && git merge --no-ff ${lote.branch}`,
      "```",
      ""
    );
  }

  return { lote, tarefas, markdown: L.join("\n") };
}

export function escreverAnaliseDoLote(cfg: Config, nome: string): string | null {
  const a = analisarLote(cfg, nome);
  if (!a) return null;
  const destino = analiseDoLotePath(nome);
  fs.mkdirSync(P.lotes, { recursive: true });
  fs.writeFileSync(destino, a.markdown + "\n");
  return destino;
}

/**
 * A mesma análise enxugada para virar descrição de pull request: o que foi
 * feito e como foi verificado, sem a contabilidade de consumo, que interessa a
 * você e não a quem revisa o PR.
 */
export function descricaoDePR(cfg: Config, nome: string): string | null {
  const a = analisarLote(cfg, nome);
  if (!a) return null;
  const L: string[] = [];
  const concluidas = a.tarefas.filter((t) => t.situacao === "concluída");
  L.push(`## ${a.lote.nome}`, "", `${concluidas.length} tarefa(s), um commit cada, executadas em sequência pelo Claude in Line.`, "");
  for (const t of a.tarefas) {
    if (t.situacao !== "concluída") {
      L.push(`### ${t.task.ordem}. ${t.task.title} — ${t.situacao}`, "");
      continue;
    }
    L.push(`### ${t.task.ordem}. ${t.task.title}`, "");
    if (t.resumo) L.push(t.resumo.split(/\n\s*\n/)[0], "");
    if (t.alteracoes.length) L.push(t.alteracoes.map((x) => `\`${x.arquivo}\``).join(", "), "");
    const verificados = t.detalhes?.comandos.filter((c) => c.ok === true && !c.negado) ?? [];
    if (verificados.length) L.push("Verificado com: " + [...new Set(verificados.map((c) => `\`${cmdCurto(c.comando)}\``))].slice(0, 5).join(", "), "");
  }
  const atencao = a.markdown.split("## Pontos de atenção")[1]?.split("\n## ")[0]?.trim();
  if (atencao && atencao !== "Nenhum.") L.push("### Pontos de atenção", "", atencao, "");
  return L.join("\n");
}
