import * as os from "os";
import * as path from "path";
import { P, readJson, writeJson } from "./util";
import * as fs from "fs";

/**
 * Ajuste de um dia da semana: horário e/ou fatia da semana que aquele dia
 * pode usar, por cima do que vale nos outros dias. Campo ausente naquele dia
 * = usa o geral (`allowedHours`/`dailyBudget`) sem mudança nenhuma.
 */
export interface WeekdayOverride {
  horas: [number, number][] | null;
  pctDia: number | null;
}

export interface Config {
  /** % da semana que nunca é usado pela fila (fica para o seu uso manual). */
  reservePct: number;
  /** "dynamic": divide o que sobra da semana pelos dias até o reset. "fixed": usa fixedPct por dia. */
  dailyBudget: { mode: "dynamic" | "fixed"; fixedPct: number };
  /** Não inicia tarefa se a janela de 5h estiver acima disso. */
  fiveHourMaxPct: number;
  /** Sem calibração, um snapshot mais velho que isso bloqueia a fila. */
  maxSnapshotAgeMin: number;
  /** Janelas de horário permitidas, ex.: [[0,7],[12,13]]. null = qualquer hora. */
  allowedHours: [number, number][] | null;
  /**
   * Ajuste por dia da semana, índice 0 (domingo) a 6 (sábado), igual
   * `Date#getDay()`. Dia sem ajuste (posição `null`) segue `allowedHours` e
   * `dailyBudget` normalmente.
   */
  weekdayOverrides: (WeekdayOverride | null)[];
  maxTasksPerRun: number;
  /** O que fazer se o Claude Code avisar que o limite está perto: terminar a tarefa atual ou abortar. */
  onWarning: "finish" | "abort";
  /** Após aviso de limite, pausa a fila por no máximo estas horas (ou até o reset, o que vier antes). */
  warningPauseHours: number;
  /**
   * Modelo do nome da branch. Marcadores: {data} (2026-09-29), {hora} (2053),
   * {repo}, {slug} (o título, normalizado) e {id}. A data é a da execução,
   * porque é quando a branch nasce.
   */
  branchTemplate: string;
  /**
   * Arquivar sozinho o histórico (concluídas, falhas, lotes encerrados) com mais
   * de N dias. 0 desliga. A retenção só arquiva, nunca apaga: apagar de vez é
   * decisão sua, pelo comando Limpar histórico.
   */
  retencaoDias: number;
  claudePath: string | null;
  claudeConfigDir: string;
  defaults: {
    model: string;
    maxTurns: number;
    timeoutMin: number;
    allowedTools: string[];
  };
  /** Pesos para converter tokens em "custo relativo" (proporcional ao preço da API). */
  tokenWeights: { input: number; cacheWrite: number; cacheRead: number; output: number };
  /** Multiplicador por família de modelo (casamento por substring). */
  modelWeights: Record<string, number>;
}

export const DEFAULT_CONFIG: Config = {
  reservePct: 25,
  dailyBudget: { mode: "dynamic", fixedPct: 15 },
  fiveHourMaxPct: 60,
  maxSnapshotAgeMin: 180,
  allowedHours: null,
  weekdayOverrides: [null, null, null, null, null, null, null],
  maxTasksPerRun: 3,
  onWarning: "finish",
  warningPauseHours: 6,
  branchTemplate: "Dev_Branches/{data}/{slug}",
  retencaoDias: 0,
  claudePath: null,
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  defaults: {
    model: "sonnet",
    maxTurns: 40,
    timeoutMin: 45,
    allowedTools: [
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
    ],
  },
  tokenWeights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  modelWeights: { opus: 1.67, sonnet: 1, haiku: 0.33 },
};

export type ConfigOverrides = Partial<Omit<Config, "dailyBudget" | "defaults" | "tokenWeights" | "modelWeights">> & {
  dailyBudget?: Partial<Config["dailyBudget"]>;
  defaults?: Partial<Config["defaults"]>;
  tokenWeights?: Partial<Config["tokenWeights"]>;
  /** Record ja tem todas as chaves opcionais; Partial<> aqui viraria number|undefined. */
  modelWeights?: Config["modelWeights"];
};

/**
 * Três camadas, nesta ordem: padrões, `config.json` da pasta de dados e o que
 * vier por cima. Na extensão a última camada são as configurações do VS Code,
 * que mandam; o `config.json` continua valendo como fallback para quem usa a
 * CLI na mesma pasta.
 */
/** Sem isto, uma chave com `undefined` apagaria a camada de baixo no spread. */
function defined<T extends object>(o: T | undefined): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const user = readJson<ConfigOverrides>(P.config, {});
  return {
    ...DEFAULT_CONFIG,
    ...defined(user),
    ...defined(overrides),
    dailyBudget: { ...DEFAULT_CONFIG.dailyBudget, ...defined(user.dailyBudget), ...defined(overrides.dailyBudget) },
    defaults: { ...DEFAULT_CONFIG.defaults, ...defined(user.defaults), ...defined(overrides.defaults) },
    tokenWeights: { ...DEFAULT_CONFIG.tokenWeights, ...defined(user.tokenWeights), ...defined(overrides.tokenWeights) },
    modelWeights: { ...DEFAULT_CONFIG.modelWeights, ...(user.modelWeights || {}), ...(overrides.modelWeights || {}) },
  };
}

export function writeDefaultConfigIfMissing(): boolean {
  if (fs.existsSync(P.config)) return false;
  writeJson(P.config, DEFAULT_CONFIG);
  return true;
}
