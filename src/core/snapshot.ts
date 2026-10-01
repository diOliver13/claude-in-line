import * as fs from "fs";
import { Config } from "./config";
import { P, appendJsonl, readJson, readJsonl, writeJson, nowSec, toEpochSec } from "./util";

export type WindowName = "five_hour" | "seven_day";

export interface WindowReading {
  pct: number;
  resetsAt: number | null;
}

export interface Snapshot {
  ts: number;
  source: "statusline" | "rate_limit_event" | "claude-cache";
  five_hour?: WindowReading;
  seven_day?: WindowReading;
}

// ---------- o percentual oficial, direto do estado do Claude Code ----------

/** `~/.claude` guarda a configuração; `~/.claude.json` guarda o estado. */
export function caminhoDoEstadoDoClaudeCode(cfg: Config): string {
  return cfg.claudeConfigDir.replace(/[\\/]+$/, "") + ".json";
}

let cacheDoEstado: { arquivo: string; mtimeMs: number; snap: Snapshot | null } | null = null;

/**
 * O painel do Claude Code busca o uso da conta a cada poucos minutos e guarda o
 * resultado em `~/.claude.json`, em `cachedUsageUtilization`. É o mesmo número
 * que a tela "Account & Usage" mostra — percentual oficial, sem estimativa.
 *
 * Isto é estado interno do Claude Code, não uma interface publicada: se o campo
 * mudar de nome ou de formato numa versão futura, a leitura simplesmente
 * devolve null e o medidor volta a depender da statusline e da estimativa.
 * Nunca escrevemos neste arquivo.
 */
export function lerCacheDoClaudeCode(cfg: Config): Snapshot | null {
  const arquivo = caminhoDoEstadoDoClaudeCode(cfg);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(arquivo);
  } catch {
    return null;
  }
  // a chave inclui o caminho: dois arquivos diferentes podem ter o mesmo mtime
  if (cacheDoEstado && cacheDoEstado.arquivo === arquivo && cacheDoEstado.mtimeMs === stat.mtimeMs) {
    return cacheDoEstado.snap;
  }

  let snap: Snapshot | null = null;
  try {
    const estado = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    const c = estado?.cachedUsageUtilization;
    const ts = toEpochSec(c?.fetchedAtMs);
    const u = c?.utilization;
    if (ts !== null && u) {
      // aqui `utilization` já vem em pontos percentuais (42 = 42%), ao
      // contrário do rate_limit_event, que às vezes manda fração
      const janela = (raw: any): WindowReading | undefined =>
        raw && typeof raw.utilization === "number"
          ? { pct: Math.max(0, Math.min(100, raw.utilization)), resetsAt: toEpochSec(raw.resets_at) }
          : undefined;
      const cinco = janela(u.five_hour);
      const sete = janela(u.seven_day);
      if (cinco || sete) snap = { ts, source: "claude-cache", five_hour: cinco, seven_day: sete };
    }
  } catch {
    snap = null;
  }

  cacheDoEstado = { arquivo, mtimeMs: stat.mtimeMs, snap };
  return snap;
}

function readWindow(raw: any): WindowReading | undefined {
  if (!raw || typeof raw.used_percentage !== "number") return undefined;
  return { pct: raw.used_percentage, resetsAt: toEpochSec(raw.resets_at) };
}

/**
 * Registra um snapshot. latest.json é sempre sobrescrito; o histórico só
 * recebe uma linha quando algo mudou ou passaram 10 min (a statusline é
 * chamada muitas vezes por minuto).
 */
export function recordSnapshot(snap: Snapshot): void {
  const prev = readJson<Snapshot | null>(P.latest, null);
  const merged: Snapshot = {
    ts: snap.ts,
    source: snap.source,
    five_hour: snap.five_hour ?? (prev && isCurrent(prev.five_hour) ? prev.five_hour : undefined),
    seven_day: snap.seven_day ?? (prev && isCurrent(prev.seven_day) ? prev.seven_day : undefined),
  };
  writeJson(P.latest, merged);

  const hist = readJsonl<Snapshot>(P.history);
  const last = hist[hist.length - 1];
  const changed =
    !last ||
    last.five_hour?.pct !== snap.five_hour?.pct ||
    last.seven_day?.pct !== snap.seven_day?.pct ||
    last.seven_day?.resetsAt !== snap.seven_day?.resetsAt;
  if (changed || snap.ts - last.ts >= 600) appendJsonl(P.history, snap);
}

function isCurrent(w?: WindowReading): boolean {
  return !!w && (w.resetsAt === null || w.resetsAt > nowSec());
}

/** Chamado pelo Claude Code a cada atualização da statusline (JSON no stdin). */
export function handleStatusline(input: string): string {
  let data: any = {};
  try {
    data = JSON.parse(input);
  } catch {
    return "cq";
  }
  const rl = data.rate_limits || {};
  const five = readWindow(rl.five_hour);
  const week = readWindow(rl.seven_day);
  if (five || week) {
    recordSnapshot({ ts: nowSec(), source: "statusline", five_hour: five, seven_day: week });
  }
  const model = data?.model?.display_name ? `[${data.model.display_name}] ` : "";
  const parts: string[] = [];
  if (five) parts.push(`5h ${Math.round(five.pct)}%`);
  if (week) parts.push(`7d ${Math.round(week.pct)}%`);
  return `${model}${parts.join(" · ") || "sem dados de limite"}`;
}

/**
 * Converte um rate_limit_event do stream-json em snapshot, quando ele traz
 * utilization (o Claude Code só envia isso perto dos limiares).
 */
export function snapshotFromRateLimitEvent(info: any): Snapshot | null {
  const type = info?.rateLimitType;
  if ((type !== "five_hour" && type !== "seven_day") || typeof info.utilization !== "number") return null;
  const pct = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
  return {
    ts: nowSec(),
    source: "rate_limit_event",
    [type]: { pct, resetsAt: toEpochSec(info.resetsAt) },
  } as Snapshot;
}

export function loadHistory(): Snapshot[] {
  return readJsonl<Snapshot>(P.history).sort((a, b) => a.ts - b.ts);
}
