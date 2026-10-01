import { Config } from "./config";
import { Gauge, computeGauge } from "./gauge";
import { P, readJson, writeJson, nowSec, localDay, startOfLocalDaySec, fmtDuration, fmtPct } from "./util";

export interface State {
  day?: string;
  dayStartWeekPct?: number;
  dayWeekResetsAt?: number | null;
  brake?: { until: number; reason: string } | null;
  /** Pausa manual da extensão. O porteiro não olha para ela: quem decide é o agendador. */
  paused?: boolean;
}

export interface Decision {
  ok: boolean;
  reasons: string[];
  gauge: Gauge;
  week: number | null;
  five: number | null;
  dailyCap: number | null;
  usedToday: number | null;
  weekCeiling: number;
}

export const loadState = (): State => readJson<State>(P.state, {});
export const saveState = (s: State): void => writeJson(P.state, s);

export function setBrake(until: number, reason: string): void {
  const s = loadState();
  if (!s.brake || s.brake.until < until) s.brake = { until, reason };
  saveState(s);
}

/**
 * Quanto a fila pode gastar hoje, em pontos percentuais da janela semanal.
 * Fica separado do porteiro porque a tela de configuração precisa da mesma
 * conta para mostrar o efeito de uma mudança antes de você salvar — e duas
 * cópias da fórmula divergiriam na primeira alteração.
 */
export function dailyBudget(
  cfg: Config,
  dayStartWeekPct: number,
  weekResetsAt: number | null,
  now = nowSec()
): number {
  if (cfg.dailyBudget.mode === "fixed") return cfg.dailyBudget.fixedPct;
  const reset = weekResetsAt ?? now + 7 * 86400;
  const diasRestantes = Math.max(1, Math.ceil((reset - startOfLocalDaySec(new Date(now * 1000))) / 86400));
  return Math.max(0, 100 - cfg.reservePct - dayStartWeekPct) / diasRestantes;
}

export function evaluate(cfg: Config, now = nowSec()): Decision {
  const gauge = computeGauge(cfg, now);
  const reasons: string[] = [];
  const state = loadState();
  const weekCeiling = 100 - cfg.reservePct;

  // freio acionado por evento de limite do próprio Claude Code
  if (state.brake && state.brake.until > now) {
    reasons.push(`pausado por ${fmtDuration(state.brake.until - now)}: ${state.brake.reason}`);
  }

  // dia da semana: um ajuste aqui vale só para hoje, por cima do horário e do orçamento gerais
  const hoje = new Date(now * 1000).getDay();
  const ajusteHoje = cfg.weekdayOverrides[hoje];

  // janelas de horário
  const horasDeHoje = ajusteHoje?.horas ?? cfg.allowedHours;
  if (horasDeHoje && horasDeHoje.length) {
    const h = new Date(now * 1000).getHours();
    if (!horasDeHoje.some(([a, b]) => h >= a && h < b)) {
      reasons.push(`fora do horário permitido (${horasDeHoje.map(([a, b]) => `${a}h-${b}h`).join(", ")})`);
    }
  }

  const wk = gauge.seven_day;
  const fh = gauge.five_hour;

  if (!wk.known) {
    reasons.push(
      "sem leitura de uso ainda: use o painel do Claude Code, que busca o uso da conta sozinho, ou rode `claude` num terminal"
    );
  } else if (wk.confidence === "stale") {
    reasons.push(
      `medidor desatualizado (última leitura há ${fmtDuration((wk.snapshotAgeMin || 0) * 60)} e ainda sem calibração): ` +
        "abra o painel do Claude Code ou rode `claude` num terminal"
    );
  }

  const week = wk.known ? wk.pct : null;
  const five = fh.known ? fh.pct : null;

  // linha de base do dia (primeira leitura do dia, ou reset da semana)
  if (week !== null) {
    const today = localDay(new Date(now * 1000));
    const weekChanged =
      state.dayWeekResetsAt != null && wk.resetsAt != null && Math.abs(state.dayWeekResetsAt - wk.resetsAt) > 3600;
    if (state.day !== today || weekChanged || state.dayStartWeekPct === undefined) {
      state.day = today;
      state.dayStartWeekPct = week;
      state.dayWeekResetsAt = wk.resetsAt;
      saveState(state);
    }
  }

  let dailyCap: number | null = null;
  let usedToday: number | null = null;
  if (week !== null && state.dayStartWeekPct !== undefined) {
    usedToday = Math.max(0, week - state.dayStartWeekPct);
    dailyCap =
      ajusteHoje?.pctDia != null ? ajusteHoje.pctDia : dailyBudget(cfg, state.dayStartWeekPct, wk.resetsAt, now);
    if (week >= weekCeiling) {
      reasons.push(`semana em ${fmtPct(week)}, teto da fila é ${weekCeiling}% (reserva de ${cfg.reservePct}%)`);
    }
    if (usedToday >= dailyCap) {
      reasons.push(`orçamento de hoje esgotado: ${fmtPct(usedToday)} de ${fmtPct(dailyCap)}`);
    }
  }

  if (five !== null && five >= cfg.fiveHourMaxPct) {
    const r = fh.resetsAt ? ` (reset em ${fmtDuration(fh.resetsAt - now)})` : "";
    reasons.push(`janela de 5h em ${fmtPct(five)}, limite da fila é ${cfg.fiveHourMaxPct}%${r}`);
  }

  return { ok: reasons.length === 0, reasons, gauge, week, five, dailyCap, usedToday, weekCeiling };
}
