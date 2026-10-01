import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { descricaoDePR, escreverAnaliseDoLote } from "./core/analise";
import { cancelarLote, lerLote, pularNoLote, tarefasDoLote } from "./core/lote";
import { Task } from "./core/queue";
import { RunResult } from "./core/runner";
import { ensureDirs, getHome, setHome } from "./core/util";
import { Engine } from "./services/engine";
import { Scheduler } from "./services/scheduler";
import { Store, ledgerById } from "./services/store";
import { branchExists, currentBranch, git } from "./services/git";
import { ESQUEMA, GitContentProvider, mostrarDiff } from "./ui/diff";
import { atualizarLeitura, configurarMedidor } from "./ui/meter";
import { atualizarServidorInstalado, conectarAoPainel, desconectarDoPainel, espelharConfiguracoes } from "./ui/panelBridge";
import { mostrarStatus } from "./ui/status";
import { SettingsPanel } from "./ui/settingsPanel";
import { StatusBar } from "./ui/statusBar";
import { LoteItem, QueueTree, TaskItem } from "./ui/tree";
import * as tarefas from "./ui/tasks";
import { esvaziarOArquivo, limparHistorico } from "./ui/limpeza";

/** Quanto esperamos, ao fechar, antes de desistir de encerrar com elegância. */
const ESPERA_AO_FECHAR_MS = 4000;

let engine: Engine | null = null;

/**
 * A pasta de dados é resolvida uma vez, na ativação, e vale para todo o núcleo.
 * Trocar `claudeQueue.dataDir` pede recarregar a janela: os observadores de
 * arquivo e o lock apontam para o caminho resolvido aqui.
 */
function resolverPastaDeDados(): string {
  const configurado = vscode.workspace.getConfiguration("claudeQueue").get<string>("dataDir") || "";
  if (configurado.trim()) return path.resolve(configurado.trim());
  return process.env.CQ_HOME || path.join(os.homedir(), ".cq");
}

export function activate(contexto: vscode.ExtensionContext): void {
  setHome(resolverPastaDeDados());
  ensureDirs();

  const saida = vscode.window.createOutputChannel("Claude in Line");
  const store = new Store();
  const motor = new Engine(store, saida);
  engine = motor;
  const arvore = new QueueTree(motor);
  const barra = new StatusBar(motor, store);
  const agendador = new Scheduler(motor, store);

  contexto.subscriptions.push(saida, store, motor, arvore, barra, agendador);
  contexto.subscriptions.push(
    vscode.window.createTreeView("claudeQueue.tasks", { treeDataProvider: arvore, showCollapseAll: false }),
    vscode.workspace.registerTextDocumentContentProvider(ESQUEMA, new GitContentProvider()),
    tarefas.vigiarRascunhos(contexto, motor)
  );

  const redesenhar = () => {
    arvore.refresh();
    barra.refresh();
  };
  contexto.subscriptions.push(
    store.onDidChangeQueue(redesenhar),
    store.onDidChangeUsage(redesenhar),
    motor.onDidChange(redesenhar)
  );

  // ---------- notificações ----------

  contexto.subscriptions.push(
    motor.onDidFinishTask(({ task, result }) => void notificarFim(motor, task, result)),
    motor.onDidPauseQueue((motivo) => {
      void vscode.window.showWarningMessage(`Fila pausada: ${motivo}`, "Ver status").then((escolha) => {
        if (escolha === "Ver status") void vscode.commands.executeCommand("claudeQueue.showStatus");
      });
    })
  );

  void vscode.commands.executeCommand("setContext", "claudeQueue.paused", store.paused);

  // ---------- comandos ----------

  const registrar = (nome: string, fn: (...args: never[]) => unknown) =>
    contexto.subscriptions.push(vscode.commands.registerCommand(nome, fn));

  registrar("claudeQueue.addTask", () => tarefas.adicionarTarefa(contexto, motor));
  registrar("claudeQueue.addFromSelection", () => tarefas.adicionarDaSelecao(contexto, motor));
  registrar("claudeQueue.addFromTodo", () => tarefas.adicionarTodo(contexto, motor));
  registrar("claudeQueue.openDataFolder", () => vscode.env.openExternal(vscode.Uri.file(getHome())));
  registrar("claudeQueue.showStatus", () => mostrarStatus(motor, store, saida));
  registrar("claudeQueue.setupMeter", () => configurarMedidor(contexto));
  registrar("claudeQueue.openSettings", () => SettingsPanel.mostrar(motor, store));
  registrar("claudeQueue.connectPanel", () => conectarAoPainel(contexto));
  registrar("claudeQueue.disconnectPanel", () => desconectarDoPainel());
  registrar("claudeQueue.refreshReading", () => atualizarLeitura());
  registrar("claudeQueue.refresh", redesenhar);

  registrar("claudeQueue.runNow", async () => {
    if (motor.busy) {
      void vscode.window.showInformationMessage("Já tem um ciclo rodando.");
      return;
    }
    const decisao = motor.decide();
    if (!decisao.ok || store.paused) {
      const motivos = [...decisao.reasons, ...(store.paused ? ["fila pausada manualmente"] : [])];
      const escolha = await vscode.window.showWarningMessage(
        "O porteiro segurou a fila.",
        { modal: true, detail: motivos.map((m) => `• ${m}`).join("\n") },
        "Forçar próxima tarefa"
      );
      if (escolha !== "Forçar próxima tarefa") return;
      await rodarComProgresso(motor, { force: true });
      return;
    }
    await rodarComProgresso(motor, {});
  });

  registrar("claudeQueue.pause", () => {
    store.setPaused(true);
    void vscode.commands.executeCommand("setContext", "claudeQueue.paused", true);
    motor.log("fila pausada");
    redesenhar();
  });

  registrar("claudeQueue.resume", () => {
    store.setPaused(false);
    void vscode.commands.executeCommand("setContext", "claudeQueue.paused", false);
    motor.log("fila retomada");
    redesenhar();
  });

  registrar("claudeQueue.cancel", async () => {
    const rodando = motor.running;
    if (!rodando) {
      void vscode.window.showInformationMessage("Não há tarefa em execução.");
      return;
    }
    const escolha = await vscode.window.showWarningMessage(
      `Cancelar "${rodando.title}"?`,
      {
        modal: true,
        detail: "O que já foi escrito vira um commit cq(wip): na branch, e a tarefa vai para Com falha.",
      },
      "Cancelar tarefa"
    );
    if (escolha === "Cancelar tarefa") motor.cancel("cancelada por você");
  });

  // ---------- ações sobre um item da árvore ----------

  registrar("claudeQueue.runTaskNow", async (item: TaskItem) => {
    // Sobe a tarefa para o topo e cai no mesmo fluxo do "Executar agora" geral:
    // se o porteiro segurar, você vê os motivos antes de decidir forçar.
    tarefas.mudarPrioridade(item.task, -5);
    redesenhar();
    await vscode.commands.executeCommand("claudeQueue.runNow");
  });

  registrar("claudeQueue.editTask", (item: TaskItem) => tarefas.editarTarefa(item.task));
  registrar("claudeQueue.priorityUp", (item: TaskItem) => {
    tarefas.mudarPrioridade(item.task, -1);
    redesenhar();
  });
  registrar("claudeQueue.priorityDown", (item: TaskItem) => {
    tarefas.mudarPrioridade(item.task, 1);
    redesenhar();
  });
  registrar("claudeQueue.removeTask", async (item: TaskItem) => {
    if (await tarefas.removerTarefa(item.task)) redesenhar();
  });
  registrar("claudeQueue.retryTask", (item: TaskItem) => {
    tarefas.tentarDeNovo(item.task);
    redesenhar();
  });
  registrar("claudeQueue.showResult", (item: TaskItem) => tarefas.verResultado(item.task));
  registrar("claudeQueue.showLog", (item: TaskItem) => tarefas.verLog(item.task));
  registrar("claudeQueue.showDiff", (item: TaskItem) => verDiffDaTarefa(item.task));
  registrar("claudeQueue.checkout", (item: TaskItem) => fazerCheckout(item.task));
  registrar("claudeQueue.deleteBranch", (item: TaskItem) => apagarBranch(item.task));
  registrar("claudeQueue.showFailureReport", (item: TaskItem) => tarefas.verRelatorioDeFalha(item.task));

  // ---------- lotes ----------

  registrar("claudeQueue.skipInBatch", async (item: TaskItem) => {
    const escolha = await vscode.window.showWarningMessage(
      `Pular "${item.task.title}" e seguir com o lote?`,
      {
        modal: true,
        detail:
          "As tarefas seguintes vão rodar sem o que esta deveria ter feito. Se alguma depende dela, " +
          "prefira Tentar de novo ou Cancelar lote.",
      },
      "Pular"
    );
    if (escolha !== "Pular") return;
    pularNoLote(motor.config(), item.task);
    fecharAnaliseSeEncerrou(motor, item.task.lote);
    redesenhar();
  });
  registrar("claudeQueue.cancelBatch", async (item: LoteItem | TaskItem) => {
    const nome = item instanceof LoteItem ? item.lote.nome : item.task.lote;
    if (!nome) return;
    const escolha = await vscode.window.showWarningMessage(
      `Cancelar o lote ${nome}?`,
      {
        modal: true,
        detail:
          "Nenhuma tarefa dele roda mais; as pendentes vão para Com falha. A branch do lote fica como está, " +
          "com o que já foi commitado.",
      },
      "Cancelar lote"
    );
    if (escolha !== "Cancelar lote") return;
    const quantas = cancelarLote(motor.config(), nome);
    escreverAnaliseDoLote(motor.config(), nome);
    void vscode.window.showInformationMessage(`Lote ${nome} cancelado. ${quantas} tarefa(s) pendente(s) parada(s).`);
    redesenhar();
  });
  registrar("claudeQueue.showBatchReport", (item: LoteItem) => tarefas.verRelatorioDoLote(motor.config(), item.lote.nome));
  registrar("claudeQueue.showBatchDiff", (item: LoteItem) => verDiffDoLote(item.lote.nome));
  registrar("claudeQueue.checkoutBatch", (item: LoteItem) => checkoutDoLote(item.lote.nome));
  registrar("claudeQueue.showBatchAnalysis", (item: LoteItem) => tarefas.verAnaliseDoLote(motor.config(), item.lote.nome));
  registrar("claudeQueue.copyPrDescription", (item: LoteItem) => copiarDescricaoDePR(motor, item.lote.nome));

  // ---------- limpeza ----------

  registrar("claudeQueue.clearHistory", async () => {
    if (await limparHistorico(motor)) redesenhar();
  });
  registrar("claudeQueue.emptyArchive", () => esvaziarOArquivo(motor));

  // ---------- reagir a mudanças de configuração ----------

  contexto.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      espelharConfiguracoes();
      if (e.affectsConfiguration("claudeQueue.intervalMinutes")) agendador.reschedule();
      if (e.affectsConfiguration("claudeQueue.dataDir")) {
        void vscode.window
          .showInformationMessage("A pasta de dados mudou. Recarregue a janela para valer.", "Recarregar")
          .then((escolha) => {
            if (escolha === "Recarregar") void vscode.commands.executeCommand("workbench.action.reloadWindow");
          });
      }
      redesenhar();
    })
  );

  espelharConfiguracoes();
  if (atualizarServidorInstalado(contexto)) {
    motor.log("ferramentas do painel atualizadas; valem a partir da próxima conversa do Claude Code");
  }
  agendador.start();
  motor.log(`pronto. Pasta de dados: ${getHome()}`);
}

function rodarComProgresso(motor: Engine, opts: { force?: boolean }): Thenable<void> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Claude in Line: executando a fila" },
    async () => {
      const quantas = await motor.cycle(opts);
      if (quantas === 0) motor.log("nenhuma tarefa executada neste ciclo");
    }
  );
}

// ---------- ações que dependem do git ----------

/**
 * A base e a branch de uma tarefa vêm do ledger, que é o registro da execução.
 * Numa tarefa de lote, o que é "dela" é o commit, não a branch: o diff compara
 * o commit com o pai, e mostra só o que aquela tarefa fez.
 */
function dadosDaExecucao(task: Task): { branch: string; base: string } | null {
  const entrada = ledgerById().get(task.id);
  if (entrada?.lote && entrada.commit) return { branch: entrada.commit, base: `${entrada.commit}~1` };
  if (!entrada || !entrada.branch) return null;
  return { branch: entrada.branch, base: entrada.base || "HEAD" };
}

/** Pular a última tarefa pendente encerra o lote sem nenhuma execução: a análise sai aqui. */
function fecharAnaliseSeEncerrou(motor: Engine, nome: string | null): void {
  if (!nome) return;
  if (lerLote(nome)?.estado === "concluido") escreverAnaliseDoLote(motor.config(), nome);
}

async function copiarDescricaoDePR(motor: Engine, nome: string): Promise<void> {
  const texto = descricaoDePR(motor.config(), nome);
  if (!texto) {
    void vscode.window.showInformationMessage(`Não achei o lote ${nome}.`);
    return;
  }
  await vscode.env.clipboard.writeText(texto);
  void vscode.window.showInformationMessage(`Descrição do lote ${nome} copiada. Cole no pull request.`);
}

async function verDiffDoLote(nome: string): Promise<void> {
  const lote = lerLote(nome);
  if (!lote?.branch) {
    void vscode.window.showInformationMessage(`O lote ${nome} ainda não tem branch: nenhuma tarefa rodou.`);
    return;
  }
  await mostrarDiff(lote.repo, lote.base, lote.branch, `lote ${lote.nome}`);
}

async function checkoutDoLote(nome: string): Promise<void> {
  const lote = lerLote(nome);
  if (!lote?.branch) {
    void vscode.window.showInformationMessage(`O lote ${nome} ainda não tem branch.`);
    return;
  }
  const sujo = await git(lote.repo, ["status", "--porcelain"]);
  if (sujo.out) {
    void vscode.window.showWarningMessage(
      `${path.basename(lote.repo)} tem alterações não commitadas. Resolva antes de trocar de branch.`
    );
    return;
  }
  const r = await git(lote.repo, ["checkout", lote.branch]);
  if (!r.ok) {
    void vscode.window.showErrorMessage(`Não consegui fazer checkout: ${r.err}`);
    return;
  }
  // A worktree da próxima tarefa não abre numa branch que está em checkout aqui.
  const aindaPendentes = lote.estado === "andamento";
  void vscode.window.showInformationMessage(
    `Agora em ${lote.branch}.` +
      (aindaPendentes ? " Enquanto estiver nela, a fila não consegue rodar a próxima tarefa do lote." : "")
  );
}

async function verDiffDaTarefa(task: Task): Promise<void> {
  const dados = dadosDaExecucao(task);
  if (!dados) {
    void vscode.window.showInformationMessage(`"${task.title}" não deixou branch: nada foi alterado.`);
    return;
  }
  await mostrarDiff(task.repo, dados.base, dados.branch, task.title);
}

async function fazerCheckout(task: Task): Promise<void> {
  const dados = dadosDaExecucao(task);
  if (!dados) {
    void vscode.window.showInformationMessage(`"${task.title}" não deixou branch.`);
    return;
  }
  const sujo = await git(task.repo, ["status", "--porcelain"]);
  if (sujo.out) {
    void vscode.window.showWarningMessage(
      `${path.basename(task.repo)} tem alterações não commitadas. Resolva antes de trocar de branch.`
    );
    return;
  }
  const r = await git(task.repo, ["checkout", dados.branch]);
  void (r.ok
    ? vscode.window.showInformationMessage(`Agora em ${dados.branch}.`)
    : vscode.window.showErrorMessage(`Não consegui fazer checkout: ${r.err}`));
}

async function apagarBranch(task: Task): Promise<void> {
  const dados = dadosDaExecucao(task);
  if (!dados) {
    void vscode.window.showInformationMessage(`"${task.title}" não deixou branch.`);
    return;
  }
  if (!(await branchExists(task.repo, dados.branch))) {
    void vscode.window.showInformationMessage(`A branch ${dados.branch} já não existe.`);
    return;
  }
  if ((await currentBranch(task.repo)) === dados.branch) {
    void vscode.window.showWarningMessage(`${dados.branch} é a branch atual. Saia dela antes de apagar.`);
    return;
  }

  const escolha = await vscode.window.showWarningMessage(
    `Apagar a branch ${dados.branch}?`,
    { modal: true, detail: "O trabalho feito nela vai junto. Não há push, então não existe cópia em lugar nenhum." },
    "Apagar"
  );
  if (escolha !== "Apagar") return;

  const r = await git(task.repo, ["branch", "-D", dados.branch]);
  void (r.ok
    ? vscode.window.showInformationMessage(`Branch ${dados.branch} apagada.`)
    : vscode.window.showErrorMessage(`Não consegui apagar: ${r.err}`));
}

// ---------- notificação de fim ----------

async function notificarFim(motor: Engine, task: Task, resultado: RunResult): Promise<void> {
  if (task.lote) return notificarFimNoLote(motor, task, resultado);
  if (resultado.ok) {
    const onde = resultado.branch
      ? `${resultado.filesChanged} arquivo(s) alterado(s) na branch ${resultado.branch}`
      : "nenhum arquivo alterado";
    const botoes = resultado.branch ? ["Ver diff", "Ver resultado", "Checkout"] : ["Ver resultado"];
    const escolha = await vscode.window.showInformationMessage(`✓ ${task.title} — ${onde}`, ...botoes);
    if (escolha === "Ver diff") await verDiffDaTarefa(task);
    if (escolha === "Ver resultado") await tarefas.verResultado(task);
    if (escolha === "Checkout") await fazerCheckout(task);
    return;
  }

  const escolha = await vscode.window.showErrorMessage(
    `✗ ${task.title} — ${resultado.reason}`,
    "Ver relatório da falha",
    "Tentar de novo"
  );
  if (escolha === "Ver relatório da falha") await tarefas.verRelatorioDeFalha(task);
  if (escolha === "Tentar de novo") {
    tarefas.tentarDeNovo(task);
    await vscode.commands.executeCommand("claudeQueue.refresh");
  }
}

/**
 * No lote, a notificação fala do conjunto: em que ponto ele está e, se parou,
 * o que você pode fazer. Tarefa intermediária que deu certo não interrompe
 * ninguém com botão — só o fim do lote e as falhas pedem atenção.
 */
async function notificarFimNoLote(motor: Engine, task: Task, resultado: RunResult): Promise<void> {
  const cfg = motor.config();
  const lote = lerLote(task.lote!);
  const nome = lote?.nome ?? task.lote!;
  const todas = tarefasDoLote(cfg, nome);
  const feitas = todas.filter((t) => t.status === "done").length;

  if (resultado.ok) {
    if (lote?.estado !== "concluido") {
      motor.log(`  lote ${nome}: ${feitas}/${todas.length} concluída(s)`);
      return;
    }
    const escolha = await vscode.window.showInformationMessage(
      `✓ Lote ${nome} concluído — ${Object.keys(lote.commits).length} commit(s) em ${lote.branch}`,
      "Ver análise do lote",
      "Ver diff do lote",
      "Copiar descrição de PR"
    );
    if (escolha === "Ver análise do lote") await tarefas.verAnaliseDoLote(cfg, nome);
    if (escolha === "Ver diff do lote") await verDiffDoLote(nome);
    if (escolha === "Copiar descrição de PR") await copiarDescricaoDePR(motor, nome);
    return;
  }

  const paradas = todas.filter((t) => t.status === "queued").length;
  const escolha = await vscode.window.showErrorMessage(
    `✗ ${task.title} — ${resultado.reason}. Lote ${nome} parado` + (paradas ? ` com ${paradas} tarefa(s) esperando.` : "."),
    "Ver relatório da falha",
    "Tentar de novo",
    "Pular no lote"
  );
  if (escolha === "Ver relatório da falha") await tarefas.verRelatorioDeFalha(task);
  if (escolha === "Tentar de novo") {
    tarefas.tentarDeNovo(task);
    await vscode.commands.executeCommand("claudeQueue.refresh");
  }
  if (escolha === "Pular no lote") {
    pularNoLote(cfg, task);
    fecharAnaliseSeEncerrou(motor, task.lote);
    await vscode.commands.executeCommand("claudeQueue.refresh");
  }
}

/**
 * Fechar o VS Code para a fila: é a decisão de projeto. Deixar o `claude` órfão
 * seria pior — gastaria cota sem ninguém para fazer o commit nem remover a
 * worktree. Então cancelamos, o que já faz o núcleo commitar como `cq(wip):`.
 */
export async function deactivate(): Promise<void> {
  const motor = engine;
  engine = null;
  if (!motor || !motor.busy) return;
  motor.cancel("VS Code fechado");
  await motor.waitForIdle(ESPERA_AO_FECHAR_MS);
}
