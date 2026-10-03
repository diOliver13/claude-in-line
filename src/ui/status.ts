import * as vscode from "vscode";
import { WindowGauge } from "../core/gauge";
import { invalidQueueFiles, listTasks } from "../core/queue";
import { resolveClaude } from "../core/runner";
import { fmtDuration, fmtPct, getHome, nowSec } from "../core/util";
import { Engine } from "../services/engine";
import { Store } from "../services/store";

const NOMES_DIA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

const ORIGEM: Record<WindowGauge["confidence"], string> = {
  calibrated: "estimado+calibrado",
  snapshot: "leitura direta",
  stale: "DESATUALIZADO",
  none: "-",
};

function linha(rotulo: string, g: WindowGauge, agora: number): string {
  if (!g.known) return `  ${rotulo}: sem leitura`;
  const reset = g.resetsAt ? `reset em ${fmtDuration(g.resetsAt - agora)}` : "reset ?";
  const idade = fmtDuration((g.snapshotAgeMin || 0) * 60);
  const cal =
    g.factor !== null
      ? `, ${g.factor.toFixed(2)} pp/Mtok (${g.samples} amostras)`
      : ", sem calibração";
  const origem = g.rolledOver && g.confidence !== "calibrated" ? "PISO (janela virou)" : ORIGEM[g.confidence];
  const desde = g.weightedSinceSnapshot
    ? `; ${(g.weightedSinceSnapshot / 1e6).toFixed(2)} Mtok desde então`
    : "";
  return `  ${rotulo}: ${fmtPct(g.pct)}  (${reset}; ${origem}; último snapshot há ${idade}${desde}${cal})`;
}

/** O mesmo relatório do `cq status`, no canal de saída da extensão. */
export function mostrarStatus(engine: Engine, store: Store, saida: vscode.OutputChannel): void {
  const cfg = engine.config();
  const d = engine.decide();
  const agora = nowSec();
  const L = (t = "") => saida.appendLine(t);

  saida.clear();
  L(`Claude in Line — ${new Date().toLocaleString("pt-BR")}`);
  L(`Pasta de dados: ${getHome()}`);
  L();
  L("Uso do plano");
  L(linha("5h  ", d.gauge.five_hour, agora));
  L(linha("7d  ", d.gauge.seven_day, agora));
  L();
  L("Política");
  L(`  Teto semanal da fila: ${d.weekCeiling}% (reserva ${cfg.reservePct}%)`);
  L(
    `  Orçamento de hoje (${cfg.dailyBudget.mode === "dynamic" ? "dinâmico" : "fixo"}): ` +
      `${fmtPct(d.dailyCap)}, usado ${fmtPct(d.usedToday)}`
  );
  const ajusteHoje = cfg.weekdayOverrides[new Date(agora * 1000).getDay()];
  if (ajusteHoje) {
    const partes: string[] = [];
    if (ajusteHoje.horas) partes.push(`horário ${ajusteHoje.horas.map(([a, b]) => `${a}h-${b}h`).join(", ")}`);
    if (ajusteHoje.pctDia != null) partes.push(`orçamento fixo de ${ajusteHoje.pctDia}%`);
    if (partes.length) {
      L(`  Ajuste de hoje (${NOMES_DIA[new Date(agora * 1000).getDay()]}): ${partes.join("; ")}`);
    }
  }
  L(`  Limite da janela de 5h para a fila: ${cfg.fiveHourMaxPct}%`);
  L(`  Tarefas por ciclo: ${cfg.maxTasksPerRun}${d.gauge.seven_day.confidence !== "calibrated" ? " (1 enquanto não houver calibração)" : ""}`);

  const freio = store.brake;
  if (freio) L(`  Freio: ${freio.reason} (${fmtDuration(freio.until - agora)})`);
  if (store.paused) L("  Fila pausada por você.");

  L();
  L("Executável");
  try {
    L(`  ${resolveClaude(cfg)}`);
  } catch (e) {
    L(`  NÃO ENCONTRADO — ${e instanceof Error ? e.message : String(e)}`);
    L("  Sem ele nenhuma tarefa roda. O painel do Claude Code usa um binário próprio,");
    L("  que não fica no PATH; `claude install` resolve de vez.");
  }

  L();
  const pendentes = listTasks(cfg, "queued");
  L(
    `Fila: ${pendentes.length} pendente(s), ${listTasks(cfg, "failed").length} com falha, ` +
      `${listTasks(cfg, "done").length} concluída(s)`
  );
  const invalidos = invalidQueueFiles(cfg);
  if (invalidos.length) L(`  Ignorados (sem repo ou sem prompt): ${invalidos.join(", ")}`);

  const rodando = engine.running;
  if (rodando) L(`  Em execução agora: ${rodando.title}`);

  L();
  const impedida = !d.ok || store.paused;
  L(`Decisão agora: ${impedida ? "AGUARDAR" : "PODE EXECUTAR"}`);
  for (const r of d.reasons) L(`  - ${r}`);
  if (store.paused) L("  - fila pausada manualmente (Claude in Line: Retomar fila)");

  saida.show(true);
}
