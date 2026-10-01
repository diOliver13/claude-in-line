import * as path from "path";
import * as vscode from "vscode";
import { ItemArquivado, listarArquivados } from "../core/limpeza";
import { Lote, listarLotes, tarefasDoLote } from "../core/lote";
import { Task, listTasks } from "../core/queue";
import { Engine } from "../services/engine";
import { LedgerEntry, ledgerById } from "../services/store";

const MAX_CONCLUIDAS = 20;
const MAX_LOTES = 10;
const MAX_ARQUIVADOS = 50;

export type Grupo = "queued" | "running" | "done" | "failed";

export class GroupItem extends vscode.TreeItem {
  constructor(readonly grupo: Grupo | "lotes" | "arquivo", rotulo: string, quantidade: number) {
    super(`${rotulo} (${quantidade})`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = `grupo:${grupo}`;
  }
}

export class TaskItem extends vscode.TreeItem {
  /**
   * Dentro de um lote o `contextValue` ganha o sufixo `:lote`. É o que tira do
   * menu as ações que não fazem sentido ali — apagar a branch de uma tarefa
   * apagaria a do lote inteiro — e acrescenta as que só existem ali.
   */
  constructor(readonly task: Task, readonly grupo: Grupo, ledger?: LedgerEntry, lote?: Lote) {
    super(lote ? `${task.ordem}. ${task.title}` : task.title, vscode.TreeItemCollapsibleState.None);
    const pulada = !!lote && lote.puladas.includes(task.id);
    this.id = `${lote ? `lote:${lote.nome}:` : ""}${grupo}:${task.id}`;
    this.contextValue = `tarefa:${grupo}${lote ? ":lote" : ""}`;
    this.description = lote
      ? `${task.model}${pulada ? " · pulada" : ""}${lote.commits[task.id] ? ` · ${lote.commits[task.id].slice(0, 7)}` : ""}`
      : `${path.basename(task.repo)} · ${task.model} · p${task.priority}`;
    this.iconPath = pulada
      ? new vscode.ThemeIcon("debug-step-over", new vscode.ThemeColor("descriptionForeground"))
      : grupo === "queued" && lote && (lote.estado === "bloqueado" || lote.estado === "cancelado")
        ? new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("descriptionForeground"))
        : iconeDe(grupo, ledger);
    this.tooltip = tooltipDe(task, grupo, ledger);
    if (grupo === "done" || grupo === "failed") {
      this.command = {
        command: grupo === "failed" ? "claudeQueue.showFailureReport" : "claudeQueue.showResult",
        title: "Ver resultado",
        arguments: [this],
      };
    }
  }
}

export class LoteItem extends vscode.TreeItem {
  constructor(readonly lote: Lote, feitas: number, total: number) {
    super(lote.nome, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `lote:${lote.nome}`;
    this.contextValue = `lote:${lote.estado}`;
    const rotulo = { andamento: "em andamento", bloqueado: "bloqueado", concluido: "concluído", cancelado: "cancelado" }[lote.estado];
    this.description = `${rotulo} · ${feitas}/${total}`;
    this.iconPath =
      lote.estado === "bloqueado"
        ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.red"))
        : lote.estado === "concluido"
          ? new vscode.ThemeIcon("check-all", new vscode.ThemeColor("charts.green"))
          : lote.estado === "cancelado"
            ? new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("descriptionForeground"))
            : new vscode.ThemeIcon("layers");
    const m = new vscode.MarkdownString();
    m.appendMarkdown(`**Lote ${lote.nome}** — ${rotulo}\n\n`);
    m.appendMarkdown(`Base \`${lote.base}\` · branch ${lote.branch ? `\`${lote.branch}\`` : "ainda não criada"}\n\n`);
    if (lote.bloqueio) m.appendMarkdown(`---\n\nParou em **${lote.bloqueio.titulo}**: ${lote.bloqueio.motivo}`);
    this.tooltip = m;
    this.command = { command: "claudeQueue.showBatchReport", title: "Ver relatório do lote", arguments: [this] };
  }
}

const ROTULO_CATEGORIA: Record<ItemArquivado["categoria"], string> = {
  concluidas: "concluída",
  falhas: "com falha",
  pendentes: "pendente",
  lotes: "lote",
};

const ICONE_CATEGORIA: Record<ItemArquivado["categoria"], string> = {
  concluidas: "check",
  falhas: "error",
  pendentes: "circle-outline",
  lotes: "layers",
};

/** Só leitura: o item já saiu da fila, não há ação de tarefa que faça sentido nele. */
export class ArquivadoItem extends vscode.TreeItem {
  constructor(readonly item: ItemArquivado) {
    super(item.titulo, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "arquivado";
    this.description = `${ROTULO_CATEGORIA[item.categoria]} · ${item.data}`;
    this.iconPath = new vscode.ThemeIcon(ICONE_CATEGORIA[item.categoria], new vscode.ThemeColor("descriptionForeground"));
    const m = new vscode.MarkdownString();
    m.appendMarkdown(`**${item.titulo}**\n\n${ROTULO_CATEGORIA[item.categoria]} · arquivada em ${item.data}`);
    if (item.branches.length) {
      m.appendMarkdown(`\n\n${item.branches.map((b) => `\`${b.branch}\` em \`${b.repo}\``).join("\n\n")}`);
    }
    this.tooltip = m;
  }
}

function iconeDe(grupo: Grupo, ledger?: LedgerEntry): vscode.ThemeIcon {
  switch (grupo) {
    case "running":
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.blue"));
    case "done":
      // concluída sem alteração nenhuma merece outro ícone: não há o que revisar
      return ledger && ledger.filesChanged === 0
        ? new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("descriptionForeground"))
        : new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
    case "failed":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

function tooltipDe(task: Task, grupo: Grupo, ledger?: LedgerEntry): vscode.MarkdownString {
  const m = new vscode.MarkdownString();
  m.appendMarkdown(`**${task.title}**\n\n`);
  m.appendMarkdown(`Repositório: \`${task.repo}\`\n\n`);
  m.appendMarkdown(`Modelo ${task.model} · prioridade ${task.priority} · até ${task.maxTurns} turnos · ${task.timeoutMin} min\n\n`);
  if (ledger) {
    m.appendMarkdown(`---\n\n`);
    m.appendMarkdown(`${ledger.ok ? "Concluída" : "Falhou"}: ${ledger.reason}\n\n`);
    m.appendMarkdown(`Branch: ${ledger.branch ? `\`${ledger.branch}\`` : "nenhuma (sem alterações)"}\n\n`);
    m.appendMarkdown(`${ledger.filesChanged} arquivo(s) alterado(s)`);
    if (ledger.negadas) m.appendMarkdown(` · ${ledger.negadas} comando(s) negado(s)`);
  } else if (grupo === "queued") {
    m.appendMarkdown(`---\n\n${task.prompt.split("\n").slice(0, 6).join("\n")}`);
  }
  return m;
}

export class QueueTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly engine: Engine) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }

  /** Os lotes aparecem num grupo próprio; as tarefas deles não se repetem nos outros. */
  private lotesVisiveis(): Lote[] {
    return listarLotes().slice(0, MAX_LOTES);
  }

  getChildren(elemento?: vscode.TreeItem): vscode.TreeItem[] {
    const cfg = this.engine.config();
    const rodando = this.engine.running;
    const avulsa = (t: Task) => !t.lote;

    if (!elemento) {
      const pendentes = listTasks(cfg, "queued").filter((t) => t.id !== rodando?.id && avulsa(t));
      const lotes = this.lotesVisiveis();
      return [
        ...(lotes.length ? [new GroupItem("lotes", "Lotes", lotes.length)] : []),
        new GroupItem("queued", "Pendentes", pendentes.length),
        new GroupItem("running", "Em execução", rodando ? 1 : 0),
        new GroupItem("done", "Concluídas", Math.min(listTasks(cfg, "done").filter(avulsa).length, MAX_CONCLUIDAS)),
        new GroupItem("failed", "Com falha", listTasks(cfg, "failed").filter(avulsa).length),
        new GroupItem("arquivo", "Arquivo", listarArquivados(MAX_ARQUIVADOS).length),
      ];
    }

    const ledger = ledgerById();

    if (elemento instanceof LoteItem) {
      return tarefasDoLote(cfg, elemento.lote.nome).map((t) => {
        const grupo: Grupo = t.id === rodando?.id ? "running" : t.status;
        return new TaskItem(t, grupo, ledger.get(t.id), elemento.lote);
      });
    }

    if (!(elemento instanceof GroupItem)) return [];

    switch (elemento.grupo) {
      case "lotes":
        return this.lotesVisiveis().map((l) => {
          const tarefas = tarefasDoLote(cfg, l.nome);
          const feitas = tarefas.filter((t) => t.status === "done" || l.puladas.includes(t.id)).length;
          return new LoteItem(l, feitas, tarefas.length);
        });
      case "running":
        return rodando ? [new TaskItem(rodando, "running")] : [];
      case "queued":
        return listTasks(cfg, "queued")
          .filter((t) => t.id !== rodando?.id && avulsa(t))
          .map((t) => new TaskItem(t, "queued"));
      case "failed":
        return listTasks(cfg, "failed")
          .filter(avulsa)
          .sort((a, b) => b.created - a.created)
          .map((t) => new TaskItem(t, "failed", ledger.get(t.id)));
      case "done":
        return listTasks(cfg, "done")
          .filter(avulsa)
          .sort((a, b) => b.created - a.created)
          .slice(0, MAX_CONCLUIDAS)
          .map((t) => new TaskItem(t, "done", ledger.get(t.id)));
      case "arquivo":
        return listarArquivados(MAX_ARQUIVADOS).map((i) => new ArquivadoItem(i));
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
