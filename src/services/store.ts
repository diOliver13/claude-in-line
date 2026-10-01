import * as fs from "fs";
import * as vscode from "vscode";
import { P, readJson, writeJson } from "../core/util";
import { State, loadState, saveState } from "../core/gate";

type Ouvinte = () => void;

/**
 * Observa a pasta de dados. Duas correntes separadas porque quem escuta é
 * diferente: a fila move a árvore, o medidor move a barra de status. Um
 * debounce curto porque uma única operação gera vários eventos (a escrita é
 * atômica: grava temporário e renomeia).
 */
export class Store implements vscode.Disposable {
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly filaEmitter = new vscode.EventEmitter<void>();
  private readonly usoEmitter = new vscode.EventEmitter<void>();
  private timers = new Map<Ouvinte, NodeJS.Timeout>();

  readonly onDidChangeQueue = this.filaEmitter.event;
  readonly onDidChangeUsage = this.usoEmitter.event;

  constructor() {
    this.observarPasta(P.queue, () => this.filaEmitter.fire());
    this.observarPasta(P.done, () => this.filaEmitter.fire());
    this.observarPasta(P.failed, () => this.filaEmitter.fire());
    // o estado do lote (bloqueado, pulada, commit) muda sem mover arquivo de tarefa
    this.observarPasta(P.lotes, () => this.filaEmitter.fire());
    this.observarPasta(P.home, (arquivo) => {
      if (arquivo === "usage.json" || arquivo === "state.json") this.usoEmitter.fire();
    });
  }

  private observarPasta(dir: string, aoMudar: (arquivo: string) => void): void {
    try {
      const w = fs.watch(dir, { persistent: false }, (_evento, nome) => {
        const arquivo = String(nome || "");
        this.debounce(() => aoMudar(arquivo));
      });
      w.on("error", () => {
        /* a pasta pode sumir; a UI segue com o que tem */
      });
      this.watchers.push(w);
    } catch {
      /* sem observador, resta o intervalo de 30s da barra de status */
    }
  }

  private debounce(fn: Ouvinte): void {
    const anterior = this.timers.get(fn);
    if (anterior) clearTimeout(anterior);
    const t = setTimeout(() => {
      this.timers.delete(fn);
      fn();
    }, 250);
    this.timers.set(fn, t);
  }

  // ---------- pausa, persistida para sobreviver ao fechamento ----------

  get paused(): boolean {
    return loadState().paused === true;
  }

  setPaused(valor: boolean): void {
    const s: State = loadState();
    s.paused = valor;
    saveState(s);
    this.usoEmitter.fire();
  }

  /** Freio ativo posto por aviso ou recusa do próprio Claude Code. */
  get brake(): { until: number; reason: string } | null {
    const b = loadState().brake;
    return b && b.until > Math.floor(Date.now() / 1000) ? b : null;
  }

  dispose(): void {
    for (const w of this.watchers) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.filaEmitter.dispose();
    this.usoEmitter.dispose();
  }
}

/** Linha do ledger.jsonl, para a árvore saber a branch de cada tarefa concluída. */
export interface LedgerEntry {
  id: string;
  title: string;
  repo: string;
  branch: string | null;
  base?: string;
  model: string;
  start: number;
  end: number;
  ok: boolean;
  reason: string;
  filesChanged: number;
  lote?: string | null;
  /** O commit que a tarefa deixou: é o que o diff mostra quando ela é parte de um lote. */
  commit?: string | null;
  branchFalha?: string | null;
  negadas?: number;
}

export function ledgerById(): Map<string, LedgerEntry> {
  const mapa = new Map<string, LedgerEntry>();
  let bruto = "";
  try {
    bruto = fs.readFileSync(P.ledger, "utf8");
  } catch {
    return mapa;
  }
  for (const linha of bruto.split("\n")) {
    if (!linha.trim()) continue;
    try {
      const e = JSON.parse(linha) as LedgerEntry;
      // a última execução de um id é a que vale (retentativas sobrescrevem)
      if (e && e.id) mapa.set(e.id, e);
    } catch {
      /* linha corrompida */
    }
  }
  return mapa;
}

export { readJson, writeJson };
