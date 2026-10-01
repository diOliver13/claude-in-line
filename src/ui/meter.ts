import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { getHome } from "../core/util";

const run = promisify(execFile);
/** Caminho com barras normais: é assim que ele vai para dentro de um JSON. */
const barras = (p: string) => p.split("\\").join("/");

/**
 * O node do PATH, não o executável do VS Code: o Claude Code chama a statusline
 * fora daqui, e `code.exe` não roda script nenhum.
 */
async function resolverNode(): Promise<string | null> {
  try {
    const { stdout } = await run(process.platform === "win32" ? "where" : "which", ["node"], { windowsHide: true });
    const linhas = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!linhas.length) return null;
    return linhas.find((l) => l.toLowerCase().endsWith("node.exe")) || linhas[0];
  } catch {
    return null;
  }
}

function pastaDoClaude(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function carimbo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function mostrarMudanca(arquivo: string, antes: unknown, depois: unknown): Promise<void> {
  const linhas = [
    `--- ${barras(arquivo)}  (agora)`,
    `+++ ${barras(arquivo)}  (depois)`,
    "@@ statusLine @@",
    ...(antes === undefined
      ? ["-  (não existe)"]
      : JSON.stringify(antes, null, 2).split("\n").map((l) => `-  ${l}`)),
    ...JSON.stringify(depois, null, 2).split("\n").map((l) => `+  ${l}`),
  ];
  const doc = await vscode.workspace.openTextDocument({ content: linhas.join("\n") + "\n", language: "diff" });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Instala o medidor. São três passos que precisam acontecer juntos: o script
 * autossuficiente vai para a pasta de dados (caminho estável, porque o da
 * extensão muda a cada atualização), o settings.json do Claude Code passa a
 * chamá-lo, e o backup fica ao lado.
 */
export async function configurarMedidor(contexto: vscode.ExtensionContext): Promise<void> {
  const origem = path.join(contexto.extensionPath, "out", "statusline.js");
  if (!fs.existsSync(origem)) {
    void vscode.window.showErrorMessage(`Não encontrei o script do medidor em ${origem}.`);
    return;
  }

  const node = await resolverNode();
  if (!node) {
    void vscode.window.showErrorMessage(
      "Não encontrei o `node` no PATH. Instale o Node.js 18+ e abra o VS Code de novo — a statusline do Claude Code roda fora daqui e precisa dele."
    );
    return;
  }

  const destino = path.join(getHome(), "statusline.js");
  fs.mkdirSync(getHome(), { recursive: true });
  fs.copyFileSync(origem, destino);

  const arquivo = path.join(pastaDoClaude(), "settings.json");
  let atual: Record<string, unknown> = {};
  let existia = false;
  if (fs.existsSync(arquivo)) {
    existia = true;
    try {
      atual = JSON.parse(fs.readFileSync(arquivo, "utf8")) as Record<string, unknown>;
    } catch {
      void vscode.window.showErrorMessage(
        `${barras(arquivo)} não é um JSON válido. Corrija antes, para eu não sobrescrever nada.`
      );
      return;
    }
  }

  const novo = { type: "command", command: `"${barras(node)}" "${barras(destino)}"` };
  const anterior = atual.statusLine;

  if (anterior && JSON.stringify(anterior) === JSON.stringify(novo)) {
    void vscode.window.showInformationMessage(
      "O medidor já estava configurado. Abra um terminal, rode `claude` e mande uma mensagem curta para gerar a primeira leitura."
    );
    return;
  }

  await mostrarMudanca(arquivo, anterior, novo);

  const aviso = anterior
    ? "Já existe uma statusLine diferente configurada. Ela será substituída — o valor atual aparece no diff aberto ao lado, e um backup será gravado."
    : "Isto liga o medidor: o Claude Code passa a gravar o percentual de uso a cada atualização da statusline.";

  const resposta = await vscode.window.showWarningMessage(
    `Alterar ${barras(arquivo)}?`,
    { modal: true, detail: `${aviso}\n\nstatusLine: ${novo.command}` },
    "Alterar"
  );
  if (resposta !== "Alterar") return;

  if (existia) {
    const backup = `${arquivo}.bak-${carimbo()}`;
    fs.copyFileSync(arquivo, backup);
  }
  atual.statusLine = novo;
  fs.writeFileSync(arquivo, JSON.stringify(atual, null, 2) + "\n");

  const acao = await vscode.window.showInformationMessage(
    "Medidor configurado. Falta a primeira leitura: abra o terminal integrado, rode `claude` e mande uma mensagem curta.",
    "Abrir terminal"
  );
  if (acao === "Abrir terminal") await vscode.commands.executeCommand("claudeQueue.refreshReading");
}

/** Abre um terminal com o `claude`, sem mandar nada: quem escreve é você. */
export async function atualizarLeitura(): Promise<void> {
  const terminal = vscode.window.createTerminal({ name: "Claude in Line — leitura" });
  terminal.show();
  terminal.sendText("claude", false);
  void vscode.window.showInformationMessage(
    "Aperte Enter para abrir o `claude` e mande uma mensagem curta. Isso gera uma leitura nova do medidor."
  );
}
