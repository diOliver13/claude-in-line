import * as vscode from "vscode";
import { Config, loadConfig } from "../core/config";
import { Decision, evaluate } from "../core/gate";
import { Task } from "../core/queue";
import { RunEvent, RunResult, runQueue } from "../core/runner";
import { fmtDuration, fmtPct, nowSec } from "../core/util";
import { readSettings } from "./settings";
import { Store } from "./store";

export interface TaskFinished {
  task: Task;
  result: RunResult;
}

/**
 * Um ciclo por vez dentro desta janela; o lock de arquivo do núcleo cuida das
 * outras janelas do VS Code. Tudo é assíncrono: o extension host nunca fica
 * parado esperando o `claude`.
 */
export class Engine implements vscode.Disposable {
  private emExecucao: { task: Task; controller: AbortController } | null = null;
  private cicloAtivo: Promise<number> | null = null;

  private readonly mudouEmitter = new vscode.EventEmitter<void>();
  private readonly concluiuEmitter = new vscode.EventEmitter<TaskFinished>();
  private readonly pausouEmitter = new vscode.EventEmitter<string>();

  /** A árvore e a barra de status se redesenham com isto. */
  readonly onDidChange = this.mudouEmitter.event;
  readonly onDidFinishTask = this.concluiuEmitter.event;
  readonly onDidPauseQueue = this.pausouEmitter.event;

  constructor(private readonly store: Store, private readonly saida: vscode.OutputChannel) {}

  get running(): Task | null {
    return this.emExecucao?.task ?? null;
  }

  get busy(): boolean {
    return this.cicloAtivo !== null;
  }

  config(): Config {
    return loadConfig(readSettings().overrides);
  }

  decide(): Decision {
    return evaluate(this.config());
  }

  /**
   * Roda o ciclo. Devolve quantas tarefas executaram. `force` ignora o porteiro
   * só na primeira tarefa — o freio do Claude Code continua valendo, porque ele
   * vem do outro lado.
   */
  async cycle(opts: { force?: boolean; dryRun?: boolean } = {}): Promise<number> {
    if (this.cicloAtivo) return this.cicloAtivo;
    if (this.store.paused && !opts.force) {
      this.log("fila pausada; ciclo ignorado");
      return 0;
    }

    const cfg = this.config();
    const controller = new AbortController();
    this.cicloAtivo = runQueue(cfg, {
      force: opts.force,
      dryRun: opts.dryRun,
      signal: controller.signal,
      onEvent: (e) => this.aoEvento(e, controller),
    })
      .catch((erro: unknown) => {
        this.log(`erro no ciclo: ${erro instanceof Error ? erro.message : String(erro)}`);
        return 0;
      })
      .finally(() => {
        this.cicloAtivo = null;
        this.emExecucao = null;
        this.mudouEmitter.fire();
      });

    this.mudouEmitter.fire();
    return this.cicloAtivo;
  }

  private aoEvento(e: RunEvent, controller: AbortController): void {
    switch (e.kind) {
      case "log":
        this.log(e.message);
        break;
      case "busy":
        this.log("outra janela do VS Code já está executando a fila");
        break;
      case "queue-empty":
        this.log("fila vazia");
        break;
      case "blocked":
        this.log(`nada pode rodar agora: ${e.motivos.join("; ")}`);
        break;
      case "waiting":
        this.log(`aguardando cota: ${e.reasons.join("; ")}`);
        break;
      case "uncalibrated":
        this.log("medidor ainda sem calibração: uma tarefa por ciclo até haver leituras suficientes");
        break;
      case "task-start": {
        this.emExecucao = { task: e.task, controller };
        const d = e.decision;
        this.log(
          `→ ${e.task.title}  [semana ${fmtPct(d.week)}, hoje ${fmtPct(d.usedToday)} de ${fmtPct(d.dailyCap)}]`
        );
        this.mudouEmitter.fire();
        break;
      }
      case "task-end":
        this.emExecucao = null;
        this.log(
          `  ${e.result.ok ? "✓" : "✗"} ${e.result.reason}` +
            `${e.result.branch ? `, branch ${e.result.branch}` : ""}` +
            `${e.result.filesChanged !== undefined ? `, ${e.result.filesChanged} arquivo(s)` : ""}`
        );
        this.concluiuEmitter.fire({ task: e.task, result: e.result });
        this.mudouEmitter.fire();
        break;
      case "queue-paused": {
        const freio = this.store.brake;
        const ate = freio ? ` até ${new Date(freio.until * 1000).toLocaleString()} (${fmtDuration(freio.until - nowSec())})` : "";
        this.log(`fila pausada por aviso de limite do Claude Code${ate}`);
        this.pausouEmitter.fire(`${e.reason}${ate}`);
        break;
      }
    }
  }

  /** Cancela a tarefa em andamento. O que já foi escrito vira commit `cq(wip):`. */
  cancel(motivo = "cancelada"): boolean {
    if (!this.emExecucao) return false;
    this.log(`cancelando ${this.emExecucao.task.title}: ${motivo}`);
    this.emExecucao.controller.abort();
    return true;
  }

  /** Espera o ciclo corrente terminar, no máximo o tempo dado. */
  async waitForIdle(limiteMs: number): Promise<boolean> {
    if (!this.cicloAtivo) return true;
    let pronto = false;
    await Promise.race([
      this.cicloAtivo.then(() => {
        pronto = true;
      }),
      new Promise((r) => setTimeout(r, limiteMs)),
    ]);
    return pronto;
  }

  log(mensagem: string): void {
    this.saida.appendLine(`[${new Date().toLocaleTimeString()}] ${mensagem}`);
  }

  dispose(): void {
    this.mudouEmitter.dispose();
    this.concluiuEmitter.dispose();
    this.pausouEmitter.dispose();
  }
}
