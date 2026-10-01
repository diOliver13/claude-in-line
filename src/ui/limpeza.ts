import * as fs from "fs";
import * as vscode from "vscode";
import {
  Categoria,
  apagarBranches,
  branchesMescladas,
  esvaziarArquivo,
  executarLimpeza,
  planejarLimpeza,
} from "../core/limpeza";
import { P } from "../core/util";
import { Engine } from "../services/engine";

const ROTULOS: Record<Categoria, string> = {
  concluidas: "Concluídas",
  falhas: "Com falha",
  lotes: "Lotes encerrados (concluídos ou cancelados), com as tarefas deles",
  pendentes: "Pendentes — tarefas que ainda não rodaram",
};

/**
 * Três perguntas, nesta ordem: o quê, como (arquivar ou apagar) e se as
 * branches já mescladas vão junto. Cada uma só aparece se fizer sentido, e
 * Esc em qualquer ponto cancela sem mexer em nada.
 */
export async function limparHistorico(motor: Engine): Promise<boolean> {
  if (motor.busy) {
    void vscode.window.showWarningMessage("A fila está executando agora. Limpe quando ela terminar.");
    return false;
  }
  const cfg = motor.config();

  const opcoes = (["concluidas", "falhas", "lotes", "pendentes"] as Categoria[])
    .map((c) => ({ categoria: c, quantos: planejarLimpeza(cfg, [c]).length }))
    .filter((o) => o.quantos > 0)
    .map((o) => ({
      label: `${ROTULOS[o.categoria]} (${o.quantos})`,
      categoria: o.categoria,
      // pendente é trabalho pedido e não feito: só sai se você marcar
      picked: o.categoria !== "pendentes",
    }));
  if (!opcoes.length) {
    void vscode.window.showInformationMessage(
      "Não há nada para limpar. Lotes em andamento ou bloqueados nunca entram na limpeza."
    );
    return false;
  }

  const escolhidas = await vscode.window.showQuickPick(opcoes, {
    canPickMany: true,
    title: "Limpar histórico da fila (1/3): o quê",
    placeHolder: "Lotes em andamento ou bloqueados não aparecem aqui: a próxima tarefa deles depende do histórico",
  });
  if (!escolhidas?.length) return false;

  const itens = planejarLimpeza(cfg, escolhidas.map((e) => e.categoria));
  const modo = await vscode.window.showQuickPick(
    [
      {
        label: "$(archive) Arquivar",
        description: "recomendado",
        detail: `Sai do painel e vai para ${P.arquivo}. Dá para consultar e recuperar depois.`,
        modo: "arquivar" as const,
      },
      {
        label: "$(trash) Apagar de vez",
        detail: "Tarefas, resultados e relatórios somem. Não há como recuperar.",
        modo: "apagar" as const,
      },
    ],
    { title: `Limpar histórico da fila (2/3): ${itens.length} item(ns)` }
  );
  if (!modo) return false;

  let branches = branchesMescladas(itens);
  if (branches.length) {
    const marcadas = await vscode.window.showQuickPick(
      branches.map((b) => ({ label: b.branch, description: `mesclada em ${b.base}`, picked: true, b })),
      {
        canPickMany: true,
        title: "Limpar histórico da fila (3/3): apagar também estas branches?",
        placeHolder: "Todas já estão inteiras na base, então nada se perde. Desmarque as que quer manter; Esc mantém todas",
      }
    );
    branches = marcadas ? marcadas.map((m) => m.b) : [];
  }

  if (modo.modo === "apagar") {
    const ok = await vscode.window.showWarningMessage(
      `Apagar de vez ${itens.length} item(ns) do histórico?`,
      { modal: true, detail: "Resultados, relatórios de falha e análises de lote vão junto. Não há como recuperar." },
      "Apagar"
    );
    if (ok !== "Apagar") return false;
  }

  let resultado;
  try {
    resultado = executarLimpeza(itens, modo.modo);
  } catch (e) {
    void vscode.window.showErrorMessage(`Não limpei nada: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const { apagadas, falhas } = apagarBranches(branches);

  const partes = [
    `${resultado.itens} item(ns) ${modo.modo === "arquivar" ? "arquivado(s)" : "apagado(s)"}`,
    ...(apagadas.length ? [`${apagadas.length} branch(es) mesclada(s) apagada(s)`] : []),
    ...(falhas.length ? [`${falhas.length} branch(es) não apagada(s): ${falhas.join("; ")}`] : []),
  ];
  motor.log(`limpeza: ${partes.join(", ")}${resultado.destino ? ` — em ${resultado.destino}` : ""}`);
  const botao = resultado.destino ? ["Abrir arquivo"] : [];
  void vscode.window.showInformationMessage(`Histórico limpo: ${partes.join(", ")}.`, ...botao).then((e) => {
    if (e === "Abrir arquivo" && resultado.destino) void vscode.env.openExternal(vscode.Uri.file(resultado.destino));
  });
  return true;
}

export async function esvaziarOArquivo(motor: Engine): Promise<void> {
  let dias = 0;
  try {
    dias = fs.readdirSync(P.arquivo).length;
  } catch {
    /* sem arquivo ainda */
  }
  if (!dias) {
    void vscode.window.showInformationMessage("O arquivo já está vazio.");
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Esvaziar o arquivo da fila (${dias} dia(s) arquivado(s))?`,
    { modal: true, detail: `Tudo em ${P.arquivo} some de vez. O painel não muda: ele já não mostrava nada disso.` },
    "Esvaziar"
  );
  if (ok !== "Esvaziar") return;
  const n = esvaziarArquivo();
  motor.log(`arquivo esvaziado: ${n} dia(s)`);
  void vscode.window.showInformationMessage(`Arquivo esvaziado: ${n} dia(s) apagado(s).`);
}
