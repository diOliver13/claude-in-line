import * as vscode from "vscode";
import { ConfigOverrides, WeekdayOverride } from "../core/config";

export interface Settings {
  intervalMinutes: number;
  overrides: ConfigOverrides;
}

/** Texto em branco significa "não configurado", e aí o config.json volta a valer. */
function texto(c: vscode.WorkspaceConfiguration, chave: string): string | undefined {
  const v = c.get<string>(chave);
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * As configurações do VS Code mandam, porque sempre têm valor (o padrão do
 * manifesto). O `config.json` da pasta de dados sobra como fallback para o que
 * não aparece na tela: pesos de token, idade máxima do snapshot, pausa após
 * aviso — e para o caminho do `claude`, quando o campo está vazio aqui.
 */
export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration("claudeQueue");
  const horas = c.get<number[][]>("allowedHours") ?? [];
  const porDiaBruto = c.get<(WeekdayOverride | null)[]>("weekdayOverrides") ?? [];
  // manifesto garante 7 posições, mas um settings.json editado à mão pode não garantir
  const porDia: (WeekdayOverride | null)[] =
    porDiaBruto.length === 7 ? porDiaBruto : [null, null, null, null, null, null, null];

  return {
    intervalMinutes: c.get<number>("intervalMinutes") ?? 20,
    overrides: {
      reservePct: c.get<number>("reservePct"),
      dailyBudget: {
        mode: c.get<"dynamic" | "fixed">("dailyBudget.mode"),
        fixedPct: c.get<number>("dailyBudget.fixedPct"),
      },
      fiveHourMaxPct: c.get<number>("fiveHourMaxPct"),
      // vazio = qualquer hora; o núcleo espera null para isso
      allowedHours: horas.length ? (horas as [number, number][]) : null,
      weekdayOverrides: porDia,
      maxTasksPerRun: c.get<number>("maxTasksPerRun"),
      onWarning: c.get<"finish" | "abort">("onWarning"),
      branchTemplate: texto(c, "branchTemplate"),
      retencaoDias: c.get<number>("retencaoDias"),
      claudePath: texto(c, "claudePath"),
      defaults: {
        model: c.get<string>("defaults.model"),
        maxTurns: c.get<number>("defaults.maxTurns"),
        timeoutMin: c.get<number>("defaults.timeoutMin"),
        allowedTools: c.get<string[]>("defaults.allowedTools"),
      },
    },
  };
}
