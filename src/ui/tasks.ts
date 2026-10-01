import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { escreverAnaliseDoLote } from "../core/analise";
import { desbloquearLote, escreverRelatorioDoLote } from "../core/lote";
import { Config } from "../core/config";
import { Task, moveTask, slugId } from "../core/queue";
import { P, parseFrontmatter, renderFrontmatter } from "../core/util";
import { Engine } from "../services/engine";
import { isRepo } from "../services/git";

const MODELO_DO_CORPO = [
  "## Objetivo",
  "",
  "",
  "",
  "## Arquivos envolvidos",
  "",
  "",
  "",
  "## Critério de pronto",
  "",
  "",
  "",
  "## Como testar",
  "",
  "",
].join("\n");

/**
 * O rascunho não nasce dentro de `queue/`: enquanto você digita, o agendador
 * poderia pegá-lo pela metade. Ele mora na área da extensão e só atravessa
 * para a fila quando você salva.
 */
export function pastaDeRascunhos(contexto: vscode.ExtensionContext): string {
  const dir = path.join(contexto.globalStorageUri.fsPath, "rascunhos");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function escolherRepositorio(): Promise<string | undefined> {
  const pastas = vscode.workspace.workspaceFolders ?? [];
  if (!pastas.length) {
    const escolha = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: "Usar este repositório",
      title: "Qual repositório a tarefa vai mexer?",
    });
    return escolha?.[0]?.fsPath;
  }
  if (pastas.length === 1) return pastas[0].uri.fsPath;

  const item = await vscode.window.showQuickPick(
    pastas.map((p) => ({ label: p.name, description: p.uri.fsPath, valor: p.uri.fsPath })),
    { title: "Qual repositório a tarefa vai mexer?", matchOnDescription: true }
  );
  return item?.valor;
}

interface Rascunho {
  titulo: string;
  repo: string;
  corpo: string;
}

async function abrirRascunho(contexto: vscode.ExtensionContext, engine: Engine, r: Rascunho): Promise<void> {
  const cfg = engine.config();
  const id = slugId(r.titulo);
  const meta: Record<string, string> = {
    title: r.titulo,
    repo: r.repo.split("\\").join("/"),
    priority: "3",
    model: cfg.defaults.model,
    maxTurns: String(cfg.defaults.maxTurns),
    timeoutMin: String(cfg.defaults.timeoutMin),
    allowedTools: cfg.defaults.allowedTools.join(", "),
    created: String(Math.floor(Date.now() / 1000)),
  };

  const arquivo = path.join(pastaDeRascunhos(contexto), `${id}.md`);
  fs.writeFileSync(arquivo, renderFrontmatter(meta, r.corpo));
  const doc = await vscode.workspace.openTextDocument(arquivo);
  await vscode.window.showTextDocument(doc, { preview: false });

  void vscode.window.showInformationMessage(
    "Preencha a tarefa e salve (Ctrl+S). Ela entra na fila ao salvar.",
  );
}

/**
 * Liga o salvar do rascunho à entrada na fila. Fica ativo enquanto a extensão
 * estiver viva; salvar de novo depois de enfileirado atualiza o mesmo arquivo.
 */
export function vigiarRascunhos(contexto: vscode.ExtensionContext, engine: Engine): vscode.Disposable {
  const rascunhos = pastaDeRascunhos(contexto);

  return vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const arquivo = doc.uri.fsPath;
    if (path.dirname(arquivo) !== rascunhos || !arquivo.endsWith(".md")) return;

    const { meta, body } = parseFrontmatter(doc.getText());
    if (!meta.repo) {
      void vscode.window.showWarningMessage("A tarefa não entrou na fila: falta o campo `repo` no frontmatter.");
      return;
    }
    if (!body.trim() || body.trim() === MODELO_DO_CORPO.trim()) {
      void vscode.window.showWarningMessage(
        "A tarefa não entrou na fila: o corpo ainda é só o modelo. Descreva o que deve ser feito."
      );
      return;
    }

    const destino = path.join(P.queue, path.basename(arquivo));
    fs.writeFileSync(destino, doc.getText());

    // Fecha o editor do rascunho ANTES de apagar o arquivo: mostrar um documento
    // que já não existe no disco faz o VS Code reclamar.
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    fs.rmSync(arquivo, { force: true });

    const naFila = await vscode.workspace.openTextDocument(destino);
    await vscode.window.showTextDocument(naFila, { preview: false });

    engine.log(`tarefa enfileirada: ${meta.title || path.basename(destino)}`);
    void vscode.window.showInformationMessage(`Na fila: ${meta.title || path.basename(destino, ".md")}`);
  });
}

export async function adicionarTarefa(contexto: vscode.ExtensionContext, engine: Engine): Promise<void> {
  const titulo = await vscode.window.showInputBox({
    title: "Nova tarefa",
    prompt: "Um título curto, que você reconheça na lista depois",
    placeHolder: "Ex.: validar valor e data no endpoint de lançamentos",
    validateInput: (v) => (v.trim().length < 3 ? "Escreva um título um pouco maior." : undefined),
  });
  if (!titulo) return;

  const repo = await escolherRepositorio();
  if (!repo) return;
  if (!(await isRepo(repo))) {
    void vscode.window.showErrorMessage(`${repo} não é um repositório git. A fila trabalha em branch, então precisa de um.`);
    return;
  }

  await abrirRascunho(contexto, engine, { titulo: titulo.trim(), repo, corpo: MODELO_DO_CORPO });
}

export async function adicionarDaSelecao(contexto: vscode.ExtensionContext, engine: Engine): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showWarningMessage("Selecione um trecho de código primeiro.");
    return;
  }

  const titulo = await vscode.window.showInputBox({
    title: "Nova tarefa a partir da seleção",
    prompt: "Um título curto para a tarefa",
  });
  if (!titulo) return;

  const repo = await escolherRepositorio();
  if (!repo) return;

  const arquivo = vscode.workspace.asRelativePath(editor.document.uri, false);
  const inicio = editor.selection.start.line + 1;
  const fim = editor.selection.end.line + 1;
  const trecho = editor.document.getText(editor.selection);
  const linguagem = editor.document.languageId;

  const corpo = [
    "## Objetivo",
    "",
    "",
    "",
    "## Arquivos envolvidos",
    "",
    `- \`${arquivo}\`, linhas ${inicio}-${fim}`,
    "",
    "## Trecho de referência",
    "",
    "```" + linguagem,
    trecho,
    "```",
    "",
    "## Critério de pronto",
    "",
    "",
    "",
    "## Como testar",
    "",
    "",
  ].join("\n");

  await abrirRascunho(contexto, engine, { titulo: titulo.trim(), repo, corpo });
}

const PADRAO_TODO = /(?:\/\/|#|<!--|\/\*|\*)\s*TODO\b[:\s]*(.*)$/i;

export async function adicionarTodo(contexto: vscode.ExtensionContext, engine: Engine): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Abra um arquivo e deixe o cursor na linha do TODO.");
    return;
  }

  const linha = editor.document.lineAt(editor.selection.active.line);
  const achou = linha.text.match(PADRAO_TODO);
  if (!achou) {
    void vscode.window.showWarningMessage(
      `Não achei um TODO na linha ${linha.lineNumber + 1}. Procuro por // TODO, # TODO ou <!-- TODO.`
    );
    return;
  }

  const textoDoTodo = achou[1].replace(/-->\s*$/, "").replace(/\*\/\s*$/, "").trim();
  const arquivo = vscode.workspace.asRelativePath(editor.document.uri, false);
  const numero = linha.lineNumber + 1;

  const titulo = await vscode.window.showInputBox({
    title: "Nova tarefa a partir do TODO",
    prompt: "Confirme ou ajuste o título",
    value: textoDoTodo || `TODO em ${path.basename(arquivo)}:${numero}`,
  });
  if (!titulo) return;

  const repo = await escolherRepositorio();
  if (!repo) return;

  const corpo = [
    "## Objetivo",
    "",
    textoDoTodo || "(o TODO não tinha texto; descreva aqui)",
    "",
    "## Arquivos envolvidos",
    "",
    `- \`${arquivo}\`, linha ${numero}`,
    "",
    "## Critério de pronto",
    "",
    "- O comentário TODO sai do código, resolvido.",
    "",
    "## Como testar",
    "",
    "",
  ].join("\n");

  await abrirRascunho(contexto, engine, { titulo: titulo.trim(), repo, corpo });
}

// ---------- ações sobre uma tarefa já existente ----------

export async function editarTarefa(task: Task): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(task.file);
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** Prioridade é um número no frontmatter; mexer nele reordena a fila. */
export function mudarPrioridade(task: Task, delta: number): void {
  const texto = fs.readFileSync(task.file, "utf8");
  const { meta, body } = parseFrontmatter(texto);
  const atual = Number(meta.priority) || 3;
  const nova = Math.min(5, Math.max(1, atual + delta));
  if (nova === atual) return;
  meta.priority = String(nova);
  fs.writeFileSync(task.file, renderFrontmatter(meta, body));
}

export async function removerTarefa(task: Task): Promise<boolean> {
  const resposta = await vscode.window.showWarningMessage(
    `Remover "${task.title}" da fila?`,
    { modal: true, detail: "O arquivo da tarefa é apagado. Isso não desfaz nada que já tenha rodado." },
    "Remover"
  );
  if (resposta !== "Remover") return false;
  fs.rmSync(task.file, { force: true });
  return true;
}

/** Num lote, tentar de novo também destrava o lote: a tarefa volta a ser a próxima dele. */
export function tentarDeNovo(task: Task): void {
  moveTask(task, "queued");
  if (task.lote) desbloquearLote(task.lote);
}

/**
 * O relatório da falha, legível em um minuto. Sem ele (execução de uma versão
 * anterior), cai no resultado, que ao menos tem a resposta final.
 */
export async function verRelatorioDeFalha(task: Task): Promise<void> {
  const falha = path.join(P.runs, task.id, "falha.md");
  if (!fs.existsSync(falha)) return verResultado(task);
  await abrirMarkdown(falha);
}

export async function verRelatorioDoLote(cfg: Config, nome: string): Promise<void> {
  const arquivo = escreverRelatorioDoLote(cfg, nome);
  if (!arquivo) {
    void vscode.window.showInformationMessage(`Não achei o lote ${nome}.`);
    return;
  }
  await abrirMarkdown(arquivo);
}

/** A análise é reescrita a cada abertura: vale para lote em andamento, bloqueado ou cancelado. */
export async function verAnaliseDoLote(cfg: Config, nome: string): Promise<void> {
  const arquivo = escreverAnaliseDoLote(cfg, nome);
  if (!arquivo) {
    void vscode.window.showInformationMessage(`Não achei o lote ${nome}.`);
    return;
  }
  await abrirMarkdown(arquivo);
}

/** Relatório tem tabela: renderizado se lê; cru, não. O texto fica de reserva. */
async function abrirMarkdown(arquivo: string): Promise<void> {
  try {
    await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(arquivo));
  } catch {
    const doc = await vscode.workspace.openTextDocument(arquivo);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}

export async function verResultado(task: Task): Promise<void> {
  const arquivo = path.join(P.runs, task.id, "result.md");
  if (!fs.existsSync(arquivo)) {
    void vscode.window.showInformationMessage(`Ainda não há resultado gravado para "${task.title}".`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(arquivo);
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** O log cru: o stderr quando existe, senão o stream de eventos da execução. */
export async function verLog(task: Task): Promise<void> {
  const dir = path.join(P.runs, task.id);
  const candidatos = [path.join(dir, "stderr.txt"), path.join(dir, "stream.jsonl")];
  const arquivo = candidatos.find((c) => fs.existsSync(c));
  if (!arquivo) {
    void vscode.window.showInformationMessage(`Não há log gravado para "${task.title}".`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(arquivo);
  await vscode.window.showTextDocument(doc, { preview: false });
}

