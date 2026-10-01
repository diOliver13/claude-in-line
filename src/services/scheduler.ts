import * as vscode from "vscode";
import { aplicarRetencao } from "../core/limpeza";
import { localDay } from "../core/util";
import { Engine } from "./engine";
import { readSettings } from "./settings";
import { Store } from "./store";

const PRIMEIRO_CICLO_MS = 2 * 60 * 1000;

/**
 * O agendador só existe enquanto o VS Code estiver aberto — é a decisão de
 * projeto, não uma limitação: fechar o editor para tudo. Para rodar com tudo
 * fechado existe a CLI `cq`, que divide a mesma pasta de dados e o mesmo lock.
 */
export class Scheduler implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private primeiro: NodeJS.Timeout | null = null;
  /** A retenção roda uma vez por dia, no primeiro tique: mais que isso não muda nada. */
  private diaDaRetencao = "";

  constructor(private readonly engine: Engine, private readonly store: Store) {}

  start(): void {
    // uma passada 2 min depois de abrir, para pegar o que ficou da sessão anterior
    this.primeiro = setTimeout(() => {
      this.primeiro = null;
      void this.tick();
    }, PRIMEIRO_CICLO_MS);
    this.reschedule();
  }

  /** Chamado também quando `claudeQueue.intervalMinutes` muda. */
  reschedule(): void {
    if (this.timer) clearInterval(this.timer);
    const minutos = Math.max(1, readSettings().intervalMinutes);
    this.timer = setInterval(() => void this.tick(), minutos * 60 * 1000);
    this.engine.log(`agendador: a cada ${minutos} min, enquanto o VS Code estiver aberto`);
  }

  private async tick(): Promise<void> {
    if (this.engine.busy) return;
    this.reter();
    if (this.store.paused) return;
    await this.engine.cycle();
  }

  /** Vale mesmo com a fila pausada: arquivar histórico velho não gasta cota. */
  private reter(): void {
    const hoje = localDay();
    if (this.diaDaRetencao === hoje) return;
    try {
      const cfg = this.engine.config();
      const r = aplicarRetencao(cfg);
      // marcado só depois de rodar: se esbarrou no lock, tenta no próximo tique
      this.diaDaRetencao = hoje;
      if (r) this.engine.log(`retenção de ${cfg.retencaoDias} dia(s): ${r.itens} item(ns) arquivado(s) em ${r.destino}`);
    } catch (e) {
      this.engine.log(`retenção não rodou: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.primeiro) clearTimeout(this.primeiro);
  }
}
