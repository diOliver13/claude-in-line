import { Config } from "./config";
import { Snapshot, WindowName, WindowReading, lerCacheDoClaudeCode, loadHistory, recordSnapshot } from "./snapshot";
import { UsageEvent, loadUsageEvents, sumWeighted } from "./transcripts";
import { P, readJson, nowSec } from "./util";

export interface WindowGauge {
  known: boolean;
  pct: number | null;
  resetsAt: number | null;
  snapshotAgeMin: number | null;
  /** pontos percentuais por milhão de tokens ponderados */
  factor: number | null;
  samples: number;
  confidence: "calibrated" | "snapshot" | "stale" | "none";
  weightedSinceSnapshot: number;
  /**
   * A janela virou depois do último snapshot, então a base voltou a zero. Sem
   * calibração isso deixa `pct` num piso, não numa medição: houve consumo que
   * ninguém sabe converter em pontos. Quem mostra o número precisa dizer isso.
   */
  rolledOver: boolean;
}

export interface Gauge {
  five_hour: WindowGauge;
  seven_day: WindowGauge;
  events: UsageEvent[];
}

const WEEK = 7 * 86400;
const MIN_DELTA_PCT = 2;
const MAX_SAMPLES = 8;

function sameWindow(a: WindowReading, b: WindowReading): boolean {
  if (a.resetsAt === null || b.resetsAt === null) return a.resetsAt === b.resetsAt;
  return Math.abs(a.resetsAt - b.resetsAt) <= 120;
}

/**
 * Aprende quantos pontos percentuais cada milhão de tokens ponderados custa,
 * comparando snapshots consecutivos da mesma janela com os tokens gastos entre eles.
 */
export function calibrate(history: Snapshot[], w: WindowName, events: UsageEvent[]) {
  const readings = history.filter((s) => s[w]).map((s) => ({ ts: s.ts, r: s[w]! }));
  const samples: { dp: number; tok: number }[] = [];
  let anchor = readings[0];
  for (let i = 1; i < readings.length; i++) {
    const cur = readings[i];
    if (!anchor || !sameWindow(anchor.r, cur.r)) {
      anchor = cur;
      continue;
    }
    const dp = cur.r.pct - anchor.r.pct;
    if (dp < 0) {
      anchor = cur;
      continue;
    }
    if (dp >= MIN_DELTA_PCT) {
      const tok = sumWeighted(events, anchor.ts, cur.ts);
      if (tok > 0) samples.push({ dp, tok });
      anchor = cur;
    }
  }
  return agregar(samples);
}

/** Média das últimas amostras: soma os pontos, soma os tokens, divide. */
function agregar(samples: { dp: number; tok: number }[]) {
  const recent = samples.slice(-MAX_SAMPLES);
  const sumDp = recent.reduce((s, x) => s + x.dp, 0);
  const sumTok = recent.reduce((s, x) => s + x.tok, 0);
  return { factor: sumTok > 0 ? sumDp / (sumTok / 1e6) : null, samples: recent.length };
}

function latestReading(history: Snapshot[], w: WindowName): { ts: number; r: WindowReading } | null {
  const latest = readJson<Snapshot | null>(P.latest, null);
  let best: { ts: number; r: WindowReading } | null = latest?.[w] ? { ts: latest.ts, r: latest[w]! } : null;
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i];
    if (s[w]) {
      if (!best || s.ts > best.ts) best = { ts: s.ts, r: s[w]! };
      break;
    }
  }
  return best;
}

export function computeGauge(cfg: Config, now = nowSec()): Gauge {
  // O painel do Claude Code busca o uso da conta sozinho, a cada poucos
  // minutos. Guardar isso no histórico dá ao medidor leituras oficiais e
  // frequentes — sem depender de você abrir um terminal.
  const oficial = lerCacheDoClaudeCode(cfg);
  if (oficial) recordSnapshot(oficial);

  const history = loadHistory();
  const events = loadUsageEvents(cfg, now - 8 * 86400);

  const one = (w: WindowName): WindowGauge => {
    const cal = calibrate(history, w, events);
    const last = latestReading(history, w);
    if (!last) {
      return {
        known: false, pct: null, resetsAt: null, snapshotAgeMin: null,
        factor: cal.factor, samples: cal.samples, confidence: "none", weightedSinceSnapshot: 0,
        rolledOver: false,
      };
    }
    let base = last.r.pct;
    let from = last.ts;
    let resetsAt = last.r.resetsAt;
    let rolledOver = false;
    if (resetsAt !== null && now >= resetsAt) {
      rolledOver = true;
      // a janela virou desde o último snapshot
      base = 0;
      from = resetsAt;
      resetsAt = w === "seven_day" ? resetsAt + WEEK * Math.ceil((now - resetsAt + 1) / WEEK) : null;
    }
    const tok = sumWeighted(events, from, now);
    const ageMin = (now - last.ts) / 60;
    const pct = cal.factor !== null ? base + (cal.factor * tok) / 1e6 : base;
    const confidence =
      cal.factor !== null ? "calibrated" : ageMin <= cfg.maxSnapshotAgeMin ? "snapshot" : "stale";
    return {
      known: true, pct: Math.min(pct, 100), resetsAt, snapshotAgeMin: ageMin,
      factor: cal.factor, samples: cal.samples, confidence, weightedSinceSnapshot: tok,
      rolledOver,
    };
  };

  return { five_hour: one("five_hour"), seven_day: one("seven_day"), events };
}
