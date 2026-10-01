/**
 * Ferramentas de fila para o Claude do painel do VS Code.
 *
 * Roda como processo separado, ligado pelo Claude Code junto com a conversa, e
 * conversa com ele por linhas de JSON no stdin/stdout. Não abre porta, não sai
 * da máquina: só mexe nos arquivos de `~/.cq`.
 *
 * O protocolo é simples o bastante para ser escrito à mão — três mensagens que
 * importam: apresentar-se, listar as ferramentas e executar uma. Fazer isso
 * sem biblioteca mantém a extensão sem nenhuma dependência de runtime.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ConfigOverrides, loadConfig } from "./core/config";
import { evaluate } from "./core/gate";
import { WindowGauge } from "./core/gauge";
import { analisarLote } from "./core/analise";
import { entrarNoLote, escreverRelatorioDoLote, lerLote, listarLotes, nomeDoLote } from "./core/lote";
import { Anexo, Task, addTask, findTask, listTasks, sugerirMaxTurns } from "./core/queue";
import { P, ensureDirs, fmtDuration, fmtPct, nowSec, parseFrontmatter, readJson, renderFrontmatter, setHome } from "./core/util";

// O script vive dentro da pasta de dados, como a statusline.
setHome(process.env.CQ_HOME || __dirname);

const VERSAO_PADRAO = "2025-06-18";

/**
 * As configurações do VS Code não existem neste processo. A extensão as espelha
 * neste arquivo justamente para as duas pontas concordarem sobre modelo padrão,
 * reserva e ferramentas liberadas.
 */
function configuracao() {
  const espelho = readJson<ConfigOverrides>(path.join(P.home, "extension-settings.json"), {});
  return loadConfig(espelho);
}

// ---------- validação ----------

function ehRepositorioGit(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, windowsHide: true }).status === 0;
}

interface Problema {
  campo: string;
  explicacao: string;
}

/**
 * A conversa torna fácil demais enfileirar qualquer coisa, e tarefa vaga
 * desperdiça cota — quem vai executá-la não pode perguntar nada. Por isso a
 * recusa é regra do código, não pedido no texto.
 */
function validarTarefa(a: Record<string, unknown>): Problema[] {
  const problemas: Problema[] = [];
  const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  if (texto(a.titulo).length < 5) {
    problemas.push({ campo: "titulo", explicacao: "um título curto que se reconheça na lista depois" });
  }

  const repo = texto(a.repo);
  if (!repo) {
    problemas.push({ campo: "repo", explicacao: "o caminho absoluto do repositório que a tarefa vai mexer" });
  } else if (!ehRepositorioGit(repo)) {
    problemas.push({
      campo: "repo",
      explicacao: `"${repo}" não existe ou não é um repositório git. A fila trabalha em branch, então precisa de um`,
    });
  }

  if (texto(a.objetivo).length < 20) {
    problemas.push({
      campo: "objetivo",
      explicacao: "o que deve mudar, em uma ou duas frases concretas. Quem for executar não poderá perguntar nada",
    });
  }

  const arquivos = Array.isArray(a.arquivos) ? a.arquivos.filter((x) => texto(x)) : [];
  if (!arquivos.length) {
    problemas.push({
      campo: "arquivos",
      explicacao: "pelo menos um arquivo que a tarefa deve tocar, mesmo que ainda não exista",
    });
  }

  if (texto(a.criterio_de_pronto).length < 15) {
    problemas.push({
      campo: "criterio_de_pronto",
      explicacao: "como se sabe que terminou: o comportamento observável, não 'implementar X'",
    });
  }

  if (texto(a.como_testar).length < 5) {
    problemas.push({
      campo: "como_testar",
      explicacao: "o comando ou o passo que prova que funcionou",
    });
  }

  if (a.anexos !== undefined) {
    const lista = Array.isArray(a.anexos) ? a.anexos : [];
    lista.forEach((item, i) => {
      const de = texto((item as any)?.de);
      const para = texto((item as any)?.para);
      if (!de || !path.isAbsolute(de)) {
        problemas.push({ campo: `anexos[${i}].de`, explicacao: "caminho absoluto de um arquivo ou pasta que existe fora do repositório" });
      } else if (!fs.existsSync(de)) {
        problemas.push({ campo: `anexos[${i}].de`, explicacao: `"${de}" não existe` });
      }
      if (!para || path.isAbsolute(para)) {
        problemas.push({ campo: `anexos[${i}].para`, explicacao: "caminho relativo à raiz do repositório (ex.: frontend/public/logo.svg)" });
      }
    });
  }

  return problemas;
}

function montarCorpo(a: Record<string, unknown>): string {
  const arquivos = (Array.isArray(a.arquivos) ? a.arquivos : [])
    .map((x) => String(x).trim())
    .filter(Boolean)
    .map((x) => `- \`${x}\``)
    .join("\n");

  return [
    "## Objetivo",
    "",
    String(a.objetivo).trim(),
    "",
    "## Arquivos envolvidos",
    "",
    arquivos,
    "",
    "## Critério de pronto",
    "",
    String(a.criterio_de_pronto).trim(),
    "",
    "## Como testar",
    "",
    String(a.como_testar).trim(),
    "",
  ].join("\n");
}

// ---------- as ferramentas ----------

function descreverJanela(rotulo: string, g: WindowGauge, agora: number): string {
  if (!g.known) return `${rotulo}: sem leitura ainda`;
  const reset = g.resetsAt ? `reset em ${fmtDuration(g.resetsAt - agora)}` : "reset desconhecido";
  const origem =
    g.confidence === "calibrated"
      ? "estimativa calibrada"
      : g.confidence === "stale"
        ? "DESATUALIZADO"
        : g.rolledOver
          ? "piso: a janela virou e o consumo desde então não vira % sem calibração"
          : "leitura direta, parada até a próxima";
  return `${rotulo}: ${fmtPct(g.pct)} (${reset}; ${origem})`;
}

function calibracaoEmTexto(rotulo: string, g: WindowGauge): string {
  if (g.factor === null) return `Calibração ${rotulo}: ainda não há; a fila roda uma tarefa por ciclo`;
  return `Calibração ${rotulo}: ${g.factor.toFixed(2)} pontos por milhão de tokens (${g.samples} amostra(s))`;
}

function linhaDaTarefa(t: Task): string {
  const lote = t.lote ? `, lote ${nomeDoLote(t.lote)} #${t.ordem}` : "";
  return `  [p${t.priority}] ${t.id} — ${t.title} (${path.basename(t.repo)}, ${t.model}${lote})`;
}

const FERRAMENTAS = [
  {
    name: "enfileirar_tarefa",
    description:
      "Coloca uma tarefa de programação na fila do Claude in Line. Ela NÃO roda agora: fica guardada e é " +
      "executada depois, sozinha, quando houver cota sobrando, numa git worktree isolada. Quem executar " +
      "não poderá fazer perguntas, então o pedido precisa ser completo. Antes de chamar, leia o código " +
      "envolvido para preencher os arquivos e o modo de testar com precisão.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Título curto, reconhecível numa lista" },
        repo: { type: "string", description: "Caminho absoluto do repositório git" },
        objetivo: { type: "string", description: "O que deve mudar, concreto" },
        arquivos: { type: "array", items: { type: "string" }, description: "Arquivos que a tarefa deve tocar" },
        criterio_de_pronto: { type: "string", description: "Comportamento observável que prova que terminou" },
        como_testar: { type: "string", description: "Comando ou passo que verifica" },
        prioridade: { type: "number", description: "1 (mais urgente) a 5. Padrão 3" },
        modelo: { type: "string", description: "haiku, sonnet ou opus. Padrão vem das configurações" },
        maxTurns: {
          type: "number",
          description:
            "Teto de turnos de execução. Sem isto, uma tarefa com objetivo claramente grande (muitos passos " +
            "numerados, muitos arquivos) ganha um teto maior automaticamente, para não estourar no meio sem " +
            "ter commitado nada. Informe explicitamente para ter a palavra final.",
        },
        allowedTools: {
          type: "string",
          description: "Ferramentas liberadas, separadas por vírgula. O que não estiver aqui é negado",
        },
        base: { type: "string", description: "Branch de origem. Padrão: a branch atual do repositório" },
        anexos: {
          type: "array",
          description:
            "Arquivos ou pastas de FORA do repositório que a tarefa precisa (imagens, binários, material de referência). " +
            "A fila copia cada um para dentro da worktree antes de começar. Nunca peça no objetivo para copiar algo de " +
            "fora do repositório com cp/Copy-Item: a origem fica fora da worktree e o comando é sempre negado.",
          items: {
            type: "object",
            properties: {
              de: { type: "string", description: "Caminho absoluto da origem, fora do repositório" },
              para: { type: "string", description: "Caminho relativo à raiz do repositório, ex.: frontend/public/logo.svg" },
            },
            required: ["de", "para"],
          },
        },
        lote: {
          type: "string",
          description:
            "Nome do lote, quando a tarefa é parte de uma entrega maior. Tarefas do mesmo lote rodam em " +
            "sequência, na ordem em que foram enfileiradas, numa branch só, com um commit por tarefa; cada " +
            "uma enxerga o que as anteriores fizeram. Se uma falha, as seguintes param até o usuário decidir. " +
            "Todas precisam do mesmo repo e da mesma base. Enfileire na ordem de dependência",
        },
      },
      required: ["titulo", "repo", "objetivo", "arquivos", "criterio_de_pronto", "como_testar"],
    },
  },
  {
    name: "ver_lote",
    description:
      "O relatório de um lote: estado, branch, cada tarefa com situação, commit e comandos negados, e por " +
      "que parou, se parou. Com analise=true, a análise completa: consumo por tarefa e por modelo, o que " +
      "cada uma fez, os comandos que rodou e se passaram, e os pontos de atenção. Sem nome, lista os lotes.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Nome do lote" },
        analise: { type: "boolean", description: "true para a análise completa em vez do relatório de situação" },
      },
    },
  },
  {
    name: "listar_fila",
    description: "Mostra o que está pendente, concluído e com falha na fila do Claude in Line.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "consultar_cota",
    description:
      "Quanto do plano já foi usado, qual o orçamento de hoje e se a fila pode executar agora. " +
      "Usa a mesma conta da barra de status, com calibração quando existe.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mudar_prioridade",
    description: "Muda a prioridade de uma tarefa pendente, reordenando a fila.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id da tarefa, ou o começo dele" },
        prioridade: { type: "number", description: "1 (mais urgente) a 5" },
      },
      required: ["id", "prioridade"],
    },
  },
  {
    name: "remover_tarefa",
    description:
      "Tira da fila uma tarefa pendente ou com falha. Não mexe em tarefas já concluídas, nem desfaz " +
      "nada que já tenha rodado.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Id da tarefa, ou o começo dele" } },
      required: ["id"],
    },
  },
  {
    name: "ver_resultado",
    description: "O resumo da execução de uma tarefa: o que mudou, em que branch e a resposta final.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Id da tarefa. Sem id, mostra a última execução" } },
    },
  },
];

function executar(nome: string, a: Record<string, unknown>): { texto: string; erro?: boolean } {
  const cfg = configuracao();

  switch (nome) {
    case "enfileirar_tarefa": {
      const problemas = validarTarefa(a);
      if (problemas.length) {
        return {
          erro: true,
          texto:
            "A tarefa não entrou na fila. Falta o seguinte:\n\n" +
            problemas.map((p) => `- **${p.campo}**: ${p.explicacao}`).join("\n") +
            "\n\nPergunte ao usuário o que faltar, ou leia o código para preencher, e chame de novo. " +
            "Tarefa vaga desperdiça cota, porque quem a executar não poderá pedir esclarecimento.",
        };
      }

      const repo = String(a.repo).trim();
      const base = typeof a.base === "string" && a.base.trim() ? a.base.trim() : undefined;
      const nomeLote = typeof a.lote === "string" ? a.lote.trim() : "";

      let lote: { nome: string; ordem: number; base: string } | null = null;
      if (nomeLote) {
        const entrada = entrarNoLote(cfg, { nome: nomeLote, repo, base });
        if (!entrada.ok) return { erro: true, texto: `A tarefa não entrou na fila: ${entrada.erro}` };
        lote = { nome: entrada.lote.nome, ordem: entrada.ordem, base: entrada.lote.base };
      }

      const anexos: Anexo[] = Array.isArray(a.anexos)
        ? a.anexos.map((item: any) => ({ de: String(item.de).trim(), para: String(item.para).trim() }))
        : [];

      const arquivos = Array.isArray(a.arquivos) ? a.arquivos.map(String) : [];
      const maxTurnsExplicito = typeof a.maxTurns === "number" ? a.maxTurns : undefined;
      const sugestao =
        maxTurnsExplicito === undefined ? sugerirMaxTurns(String(a.objetivo || ""), arquivos, cfg.defaults.maxTurns) : null;

      const id = addTask({
        title: String(a.titulo).trim(),
        repo,
        prompt: montarCorpo(a),
        priority: typeof a.prioridade === "number" ? a.prioridade : undefined,
        model: typeof a.modelo === "string" ? a.modelo : undefined,
        // Só grava quando há sugestão de verdade (motivo != null). Gravar o
        // padrão de hoje sem motivo congelaria a tarefa nele, em vez de
        // herdar o padrão das configurações no momento em que ela rodar.
        maxTurns: maxTurnsExplicito ?? (sugestao?.motivo ? sugestao.maxTurns : undefined),
        allowedTools: typeof a.allowedTools === "string" ? a.allowedTools : undefined,
        // No lote, a base gravada é a do lote: resolvida uma vez, igual para todas.
        base: lote ? lote.base : base,
        lote: lote?.nome,
        ordem: lote?.ordem,
        anexos,
      });
      if (lote) escreverRelatorioDoLote(cfg, lote.nome);

      const d = evaluate(cfg);
      const quando = d.ok
        ? "Há cota agora: ela deve rodar no próximo ciclo."
        : `A fila está aguardando: ${d.reasons.join("; ")}.`;
      const onde = lote
        ? `Ela é a tarefa ${lote.ordem} do lote ${lote.nome}: roda depois das anteriores, na branch do lote (base ${lote.base}), ` +
          "com um commit só dela. Se falhar, as seguintes param até o usuário decidir."
        : "Ela roda numa branch própria.";
      return {
        texto:
          `Na fila: ${a.titulo}\nId: ${id}\nArquivo: ${path.join(P.queue, id + ".md")}\n\n${quando}\n\n` +
          `${onde} Só executa com o VS Code aberto.` +
          (sugestao?.motivo ? `\n\nAviso de tamanho: ${sugestao.motivo}.` : ""),
      };
    }

    case "ver_lote": {
      const nome = typeof a.nome === "string" ? a.nome.trim() : "";
      if (!nome) {
        const lotes = listarLotes();
        if (!lotes.length) return { texto: "Não há lotes." };
        return {
          texto: ["Lotes:", ...lotes.map((l) => `  ${l.nome} — ${l.estado}${l.branch ? `, branch ${l.branch}` : ""}`)].join("\n"),
        };
      }
      if (!lerLote(nome)) return { erro: true, texto: `Não há lote "${nomeDoLote(nome)}". Use ver_lote sem nome para listar.` };
      if (a.analise === true) {
        const analise = analisarLote(cfg, nome);
        return { texto: analise ? analise.markdown : "Não consegui montar a análise." };
      }
      const arquivo = escreverRelatorioDoLote(cfg, nome);
      return { texto: arquivo ? fs.readFileSync(arquivo, "utf8") : "Não consegui montar o relatório." };
    }

    case "listar_fila": {
      const pendentes = listTasks(cfg, "queued");
      const falhas = listTasks(cfg, "failed");
      const feitas = listTasks(cfg, "done");
      const partes = [
        `Pendentes (${pendentes.length})`,
        ...(pendentes.length ? pendentes.map(linhaDaTarefa) : ["  (nenhuma)"]),
        "",
        `Com falha (${falhas.length})`,
        ...(falhas.length ? falhas.map(linhaDaTarefa) : ["  (nenhuma)"]),
        "",
        `Concluídas (${feitas.length})`,
        ...feitas
          .sort((x, y) => y.created - x.created)
          .slice(0, 10)
          .map(linhaDaTarefa),
      ];
      return { texto: partes.join("\n") };
    }

    case "consultar_cota": {
      const d = evaluate(cfg);
      const agora = nowSec();
      const linhas = [
        descreverJanela("Janela de 5 horas", d.gauge.five_hour, agora),
        descreverJanela("Janela de 7 dias", d.gauge.seven_day, agora),
        "",
        `Orçamento de hoje: ${fmtPct(d.usedToday)} usados de ${fmtPct(d.dailyCap)} — teto da semana ${d.weekCeiling}%`,
        calibracaoEmTexto("5h", d.gauge.five_hour),
        calibracaoEmTexto("7d", d.gauge.seven_day),
        "",
        d.ok ? "Pode executar agora." : "Aguardando:",
        ...(d.ok ? [] : d.reasons.map((r) => `  - ${r}`)),
      ];
      return { texto: linhas.join("\n") };
    }

    case "mudar_prioridade": {
      const t = findTask(cfg, String(a.id));
      if (!t) return { erro: true, texto: `Não achei tarefa com id "${a.id}". Use listar_fila para ver os ids.` };
      if (t.status !== "queued") return { erro: true, texto: `"${t.title}" não está pendente, então não tem lugar na fila.` };

      const nova = Math.min(5, Math.max(1, Number(a.prioridade)));
      const { meta, body } = parseFrontmatter(fs.readFileSync(t.file, "utf8"));
      meta.priority = String(nova);
      fs.writeFileSync(t.file, renderFrontmatter(meta, body));
      return { texto: `"${t.title}" agora é prioridade ${nova}.` };
    }

    case "remover_tarefa": {
      const t = findTask(cfg, String(a.id));
      if (!t) return { erro: true, texto: `Não achei tarefa com id "${a.id}". Use listar_fila para ver os ids.` };
      if (t.status === "done") {
        return {
          erro: true,
          texto: `"${t.title}" já foi executada. Remover o registro não desfaz a branch; use o painel da extensão para isso.`,
        };
      }
      fs.rmSync(t.file, { force: true });
      return { texto: `Removida da fila: ${t.title}` };
    }

    case "ver_resultado": {
      const id = a.id ? String(a.id) : "";
      const t = id ? findTask(cfg, id) : null;
      if (id && !t) return { erro: true, texto: `Não achei tarefa com id "${id}".` };

      const alvo = t ? t.id : ultimaExecucao();
      if (!alvo) return { texto: "Nenhuma execução registrada ainda." };

      const arquivo = path.join(P.runs, alvo, "result.md");
      if (!fs.existsSync(arquivo)) return { texto: `Sem resultado gravado para ${alvo}.` };
      // Na falha, o relatório vem junto: ele diz o que a tarefa estava fazendo e o que foi negado.
      const falha = path.join(P.runs, alvo, "falha.md");
      const extra = fs.existsSync(falha) ? "\n\n---\n\n" + fs.readFileSync(falha, "utf8") : "";
      return { texto: fs.readFileSync(arquivo, "utf8") + extra };
    }

    default:
      return { erro: true, texto: `Ferramenta desconhecida: ${nome}` };
  }
}

function ultimaExecucao(): string | null {
  try {
    const linhas = fs.readFileSync(P.ledger, "utf8").trim().split("\n").filter(Boolean);
    if (!linhas.length) return null;
    return (JSON.parse(linhas[linhas.length - 1]) as { id: string }).id;
  } catch {
    return null;
  }
}

// ---------- a conversa com o Claude Code ----------

interface Mensagem {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function responder(id: number | string, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function responderErro(id: number | string, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function tratar(m: Mensagem): void {
  // notificação (sem id) não espera resposta
  if (m.id === undefined || m.id === null) return;

  switch (m.method) {
    case "initialize": {
      const pedida = (m.params?.protocolVersion as string) || VERSAO_PADRAO;
      responder(m.id, {
        protocolVersion: pedida,
        capabilities: { tools: {} },
        serverInfo: { name: "claude-queue", version: "0.1.0" },
      });
      break;
    }

    case "tools/list":
      responder(m.id, { tools: FERRAMENTAS });
      break;

    case "tools/call": {
      const nome = String(m.params?.name || "");
      const args = (m.params?.arguments as Record<string, unknown>) || {};
      let saida: { texto: string; erro?: boolean };
      try {
        ensureDirs();
        saida = executar(nome, args);
      } catch (e) {
        saida = { erro: true, texto: `Falhou: ${e instanceof Error ? e.message : String(e)}` };
      }
      // erro de ferramenta volta como conteúdo, não como erro de protocolo:
      // assim o Claude lê o motivo e corrige em vez de só falhar
      responder(m.id, { content: [{ type: "text", text: saida.texto }], isError: !!saida.erro });
      break;
    }

    case "ping":
      responder(m.id, {});
      break;

    default:
      responderErro(m.id, -32601, `Método não suportado: ${m.method}`);
  }
}

function main(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (pedaco: string) => {
    buffer += pedaco;
    let quebra: number;
    while ((quebra = buffer.indexOf("\n")) >= 0) {
      const linha = buffer.slice(0, quebra).trim();
      buffer = buffer.slice(quebra + 1);
      if (!linha) continue;
      try {
        tratar(JSON.parse(linha) as Mensagem);
      } catch {
        /* linha ilegível: ignorar é melhor que derrubar a conversa inteira */
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

main();
