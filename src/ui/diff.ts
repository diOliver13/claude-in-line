import * as path from "path";
import * as vscode from "vscode";
import { changedFiles, git } from "../services/git";

export const ESQUEMA = "claude-queue-git";

/**
 * Serve o conteúdo de um arquivo numa revisão do git, para o `vscode.diff`
 * poder comparar base e branch lado a lado sem checkout nenhum.
 * URI: claude-queue-git:/<caminho>?repo=<repo>&rev=<rev>
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const repo = params.get("repo") || "";
    const rev = params.get("rev") || "HEAD";
    const arquivo = uri.path.replace(/^\//, "");
    const r = await git(repo, ["show", `${rev}:${arquivo}`]);
    // arquivo que não existe na base é um arquivo novo: o vazio é a resposta certa
    return r.ok ? r.out : "";
  }
}

function uriDe(repo: string, rev: string, arquivo: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: ESQUEMA,
    path: "/" + arquivo,
    query: new URLSearchParams({ repo, rev }).toString(),
  });
}

/**
 * Um arquivo só abre no comparador lado a lado, que é onde dá para ler de
 * verdade. Vários arquivos viram um diff em texto, que é o formato que permite
 * varrer a mudança inteira de uma vez.
 */
export async function mostrarDiff(repo: string, base: string, branch: string, titulo: string): Promise<void> {
  const arquivos = await changedFiles(repo, base, branch);

  if (arquivos.length === 0) {
    void vscode.window.showInformationMessage(`${titulo}: a branch ${branch} não alterou nenhum arquivo.`);
    return;
  }

  if (arquivos.length === 1) {
    const arquivo = arquivos[0];
    await vscode.commands.executeCommand(
      "vscode.diff",
      uriDe(repo, base, arquivo),
      uriDe(repo, branch, arquivo),
      `${path.basename(arquivo)} — ${base} ↔ ${branch}`
    );
    return;
  }

  const r = await git(repo, ["diff", `${base}...${branch}`]);
  if (!r.ok && !r.out) {
    void vscode.window.showErrorMessage(`Não consegui gerar o diff: ${r.err}`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ content: r.out, language: "diff" });
  await vscode.window.showTextDocument(doc, { preview: false });
}
