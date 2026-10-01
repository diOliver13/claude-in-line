import * as fs from "fs";
import * as path from "path";
import { Config } from "./config";
import { toEpochSec } from "./util";

export interface UsageEvent {
  ts: number;
  model: string;
  /** tokens ponderados pelo preço relativo (input=1) */
  weighted: number;
  raw: { input: number; cacheWrite: number; cacheRead: number; output: number };
}

function walk(dir: string, minMtimeMs: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, minMtimeMs, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) {
      try {
        if (fs.statSync(full).mtimeMs >= minMtimeMs) out.push(full);
      } catch {
        /* arquivo sumiu */
      }
    }
  }
}

function modelWeight(model: string, cfg: Config): number {
  const m = model.toLowerCase();
  for (const [key, w] of Object.entries(cfg.modelWeights)) if (m.includes(key.toLowerCase())) return w;
  return 1;
}

/**
 * Lê todas as respostas do assistente registradas desde `sinceSec`.
 * Vale para sessões do painel do VS Code, do terminal e do `claude -p`,
 * porque todas gravam em <claudeConfigDir>/projects.
 * Uso feito no claude.ai (web/app) NÃO aparece aqui; a calibração absorve isso.
 */
/** Um evento ainda com a chave de deduplicação, que só serve na hora de juntar. */
interface EventoLido extends UsageEvent {
  key: string;
}

interface ArquivoLido {
  mtimeMs: number;
  size: number;
  pesos: string;
  eventos: EventoLido[];
}

/**
 * A CLI lia tudo uma vez por execução e morria. A extensão fica viva e consulta
 * o medidor a cada 30 s, então reler e reparsear megabytes de transcript seria
 * I/O síncrono na thread da interface. O cache guarda o que já foi lido por
 * arquivo; um `stat` diz se ele mudou. Arquivo antigo não muda nunca.
 */
const cacheDeArquivos = new Map<string, ArquivoLido>();

function lerArquivo(file: string, cfg: Config, pesos: string): EventoLido[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }

  const guardado = cacheDeArquivos.get(file);
  if (guardado && guardado.mtimeMs === stat.mtimeMs && guardado.size === stat.size && guardado.pesos === pesos) {
    return guardado.eventos;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const w = cfg.tokenWeights;
  const eventos: EventoLido[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj.message;
    const u = msg?.usage;
    if (obj.type !== "assistant" || !u) continue;
    const ts = toEpochSec(obj.timestamp);
    if (ts === null) continue;
    const model = String(msg.model || "");
    if (model === "<synthetic>") continue;

    const r = {
      input: u.input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
    };
    const base = r.input * w.input + r.cacheWrite * w.cacheWrite + r.cacheRead * w.cacheRead + r.output * w.output;
    // o mesmo request aparece em várias linhas, uma por bloco de conteúdo
    const key = `${msg.id ?? ""}:${obj.requestId ?? ""}`;
    eventos.push({ ts, model, weighted: base * modelWeight(model, cfg), raw: r, key });
  }

  cacheDeArquivos.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, pesos, eventos });
  return eventos;
}

export function loadUsageEvents(cfg: Config, sinceSec: number): UsageEvent[] {
  const files: string[] = [];
  walk(path.join(cfg.claudeConfigDir, "projects"), sinceSec * 1000 - 60_000, files);

  // os pesos entram na conta na hora de ler, então mudá-los invalida o cache
  const pesos = JSON.stringify([cfg.tokenWeights, cfg.modelWeights]);

  const seen = new Set<string>();
  const events: UsageEvent[] = [];
  for (const file of files) {
    for (const e of lerArquivo(file, cfg, pesos)) {
      if (e.ts < sinceSec) continue;
      if (e.key !== ":" && seen.has(e.key)) continue;
      seen.add(e.key);
      events.push({ ts: e.ts, model: e.model, weighted: e.weighted, raw: e.raw });
    }
  }

  // sessões velhas saem da varredura; não faz sentido guardá-las na memória
  if (cacheDeArquivos.size > files.length * 2) {
    const vivos = new Set(files);
    for (const chave of cacheDeArquivos.keys()) if (!vivos.has(chave)) cacheDeArquivos.delete(chave);
  }

  return events.sort((a, b) => a.ts - b.ts);
}

export function sumWeighted(events: UsageEvent[], fromSec: number, toSec: number): number {
  let s = 0;
  for (const e of events) if (e.ts >= fromSec && e.ts < toSec) s += e.weighted;
  return s;
}

/**
 * O uso total de uma execução (o `usage` do evento `result`) na mesma unidade
 * do medidor: tokens ponderados. Multiplicado pelo fator da calibração, vira
 * pontos percentuais da janela — é assim que a análise do lote diz quanto do
 * limite cada tarefa custou.
 */
export function pesoDoUso(usage: any, model: string, cfg: Config): number {
  if (!usage || typeof usage !== "object") return 0;
  const w = cfg.tokenWeights;
  const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
  const bruto =
    n(usage.input_tokens) * w.input +
    n(usage.cache_creation_input_tokens) * w.cacheWrite +
    n(usage.cache_read_input_tokens) * w.cacheRead +
    n(usage.output_tokens) * w.output;
  return bruto * modelWeight(model, cfg);
}
