import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { loadConfig } from "../core/config";
import { resolveClaude } from "../core/runner";
import { P, getHome, writeJson } from "../core/util";
import { readSettings } from "../services/settings";

const run = promisify(execFile);
const barras = (p: string) => p.split("\\").join("/");
const NOME_DO_SERVIDOR = "claude-queue";

/**
 * O servidor MCP roda em outro processo e não enxerga as configurações do VS
 * Code. Espelhamos aqui o que ele precisa, para as duas pontas concordarem
 * sobre modelo padrão, reserva e ferramentas liberadas.
 */
export function espelharConfiguracoes(): void {
  try {
    writeJson(path.join(P.home, "extension-settings.json"), readSettings().overrides);
  } catch {
    /* sem o espelho o servidor cai nos padrões; não vale derrubar a ativação */
  }
}

/**
 * Atualizar a extensão não atualizava o servidor: a cópia em `~/.cq/mcp.js`
 * só era feita no "Conectar ao painel", e o painel seguia com as ferramentas
 * da versão anterior — sem erro nenhum, só sem o que foi acrescentado. Se o
 * servidor já está instalado, a ativação troca a cópia pela do pacote. O
 * registro no Claude Code aponta para o mesmo caminho, então não muda nada lá;
 * a versão nova vale a partir da próxima conversa do painel.
 */
export function atualizarServidorInstalado(contexto: vscode.ExtensionContext): boolean {
  const origem = path.join(contexto.extensionPath, "out", "mcp.js");
  const destino = path.join(getHome(), "mcp.js");
  try {
    if (!fs.existsSync(destino) || !fs.existsSync(origem)) return false;
    if (fs.readFileSync(origem).equals(fs.readFileSync(destino))) return false;
    fs.copyFileSync(origem, destino);
    return true;
  } catch {
    return false;
  }
}

async function resolverNode(): Promise<string | null> {
  try {
    const { stdout } = await run(process.platform === "win32" ? "where" : "which", ["node"], { windowsHide: true });
    const linhas = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return linhas.find((l) => l.toLowerCase().endsWith("node.exe")) || linhas[0] || null;
  } catch {
    return null;
  }
}

/**
 * Instala as ferramentas de fila no painel do Claude Code. O registro é feito
 * pelo próprio `claude mcp add`, e não editando o arquivo de configuração dele
 * à mão: o formato é dele, e ele sabe onde guardar.
 */
export async function conectarAoPainel(contexto: vscode.ExtensionContext): Promise<void> {
  const origem = path.join(contexto.extensionPath, "out", "mcp.js");
  if (!fs.existsSync(origem)) {
    void vscode.window.showErrorMessage(`Não encontrei o servidor em ${origem}.`);
    return;
  }

  const node = await resolverNode();
  if (!node) {
    void vscode.window.showErrorMessage(
      "Não encontrei o `node` no PATH. Ele é quem executa o servidor, fora do VS Code."
    );
    return;
  }

  let claude: string;
  try {
    claude = resolveClaude(loadConfig(readSettings().overrides));
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Não encontrei o executável do Claude Code: ${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }

  // caminho estável: o da extensão muda a cada atualização
  const destino = path.join(getHome(), "mcp.js");
  fs.mkdirSync(getHome(), { recursive: true });
  fs.copyFileSync(origem, destino);
  espelharConfiguracoes();

  const comando = `claude mcp add -s user ${NOME_DO_SERVIDOR} -- "${barras(node)}" "${barras(destino)}"`;

  const resposta = await vscode.window.showWarningMessage(
    "Dar ao painel do Claude Code as ferramentas da fila?",
    {
      modal: true,
      detail:
        `Isto registra um programa local no Claude Code, no escopo do seu usuário. Ele sobe junto com a ` +
        `conversa do painel, mexe apenas nos arquivos de ${getHome()}, e some quando você fecha a conversa.\n\n` +
        `Comando que será executado:\n${comando}\n\n` +
        `O painel ganha sete ferramentas: enfileirar tarefa, listar fila, consultar cota, mudar ` +
        `prioridade, remover tarefa, ver resultado e ver lote. Ele não passa a executar a fila — quem decide ` +
        `quando rodar continua sendo o agendador, obedecendo o porteiro.`,
    },
    "Conectar"
  );
  if (resposta !== "Conectar") return;

  const r = await run(claude, ["mcp", "add", "-s", "user", NOME_DO_SERVIDOR, "--", node, destino], {
    windowsHide: true,
  }).catch((e: { stdout?: string; stderr?: string; message?: string }) => ({
    stdout: e.stdout || "",
    stderr: e.stderr || e.message || "",
  }));

  const saida = `${r.stdout || ""}${r.stderr || ""}`.trim();
  if (/already exists/i.test(saida)) {
    void vscode.window.showInformationMessage(
      `As ferramentas já estavam conectadas. O arquivo em ${barras(destino)} foi atualizado para esta versão.`
    );
    return;
  }
  if (r.stderr && !r.stdout) {
    void vscode.window.showErrorMessage(`Não consegui registrar: ${saida}`);
    return;
  }

  const escolha = await vscode.window.showInformationMessage(
    "Ferramentas conectadas. Abra uma conversa NOVA no painel do Claude Code — a atual não enxerga o que acabou de ser registrado.",
    "Entendi"
  );
  void escolha;
}

/** Tira o registro. O arquivo em ~/.cq fica, porque não atrapalha ninguém. */
export async function desconectarDoPainel(): Promise<void> {
  let claude: string;
  try {
    claude = resolveClaude(loadConfig(readSettings().overrides));
  } catch {
    void vscode.window.showErrorMessage("Não encontrei o executável do Claude Code.");
    return;
  }

  const resposta = await vscode.window.showWarningMessage(
    "Tirar as ferramentas da fila do painel do Claude Code?",
    { modal: true, detail: "O painel volta a não saber enfileirar nada. A fila e as tarefas continuam intactas." },
    "Desconectar"
  );
  if (resposta !== "Desconectar") return;

  const r = await run(claude, ["mcp", "remove", "-s", "user", NOME_DO_SERVIDOR], { windowsHide: true }).catch(
    (e: { stdout?: string; stderr?: string; message?: string }) => ({
      stdout: e.stdout || "",
      stderr: e.stderr || e.message || "",
    })
  );
  const saida = `${r.stdout || ""}${r.stderr || ""}`.trim();
  void vscode.window.showInformationMessage(saida || "Ferramentas desconectadas.");
}
