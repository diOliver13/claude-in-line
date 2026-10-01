import * as vscode from "vscode";
import { WindowGauge } from "../core/gauge";
import { listTasks } from "../core/queue";
import { fmtDuration, fmtPct, nowSec } from "../core/util";
import { Engine } from "../services/engine";
import { Store } from "../services/store";

const INTERVALO_MS = 30 * 1000;
const AMARELO = 60;
const VERMELHO = 80;

/** Título curto o bastante para caber na barra junto com os dois percentuais. */
function encurtar(texto: string, max = 22): string {
  return texto.length <= max ? texto : texto.slice(0, max - 1) + "…";
}

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;

  constructor(private readonly engine: Engine, private readonly store: Store) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "claudeQueue.showStatus";
    this.item.show();
    this.timer = setInterval(() => this.refresh(), INTERVALO_MS);
    this.refresh();
  }

  refresh(): void {
    let decisao;
    try {
      decisao = this.engine.decide();
    } catch (e) {
      this.item.text = "$(pulse) Claude in Line: erro";
      this.item.tooltip = `Não consegui ler o medidor: ${e instanceof Error ? e.message : String(e)}`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      return;
    }

    const cfg = this.engine.config();
    const pendentes = listTasks(cfg, "queued").length;
    const rodando = this.engine.running;

    const partes: string[] = [];
    if (decisao.five !== null) partes.push(`5h ${Math.round(decisao.five)}%`);
    if (decisao.week !== null) partes.push(`7d ${Math.round(decisao.week)}%`);
    if (!partes.length) partes.push("sem leitura");
    partes.push(`fila ${pendentes}`);

    const prefixo = rodando ? `⟳ ${encurtar(rodando.title)} · ` : this.store.paused ? "⏸ " : "";
    this.item.text = `$(pulse) ${prefixo}${partes.join(" · ")}`;

    // o pior dos dois lados manda na cor
    const pior = Math.max(decisao.five ?? 0, decisao.week ?? 0);
    this.item.backgroundColor =
      pior >= VERMELHO
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : pior >= AMARELO
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;

    this.item.tooltip = this.tooltip(decisao, pendentes);
  }

  private linhaDaJanela(rotulo: string, g: WindowGauge): string {
    if (!g.known) return `**${rotulo}** — sem leitura ainda`;
    const agora = nowSec();
    const reset = g.resetsAt ? `reset em ${fmtDuration(g.resetsAt - agora)}` : "reset desconhecido";
    const idade = g.snapshotAgeMin === null ? "?" : fmtDuration(g.snapshotAgeMin * 60);

    // Sem calibração o número não se mexe entre leituras, e depois de uma virada
    // de janela ele é um piso, não uma medição. Chamar isso de "leitura direta"
    // faria um número enganoso parecer confiável.
    let origem: string;
    if (g.confidence === "calibrated") origem = "estimado sobre leitura calibrada";
    else if (g.confidence === "stale") origem = "**desatualizado**";
    else if (g.rolledOver) origem = "**piso**: a janela virou e o consumo desde então não vira % sem calibração";
    else origem = "leitura direta, parada até a próxima (sem calibração)";

    const desde = this.tokensDesde(g);
    return `**${rotulo}** ${fmtPct(g.pct)} — ${reset}  \n&nbsp;&nbsp;${origem}  \n&nbsp;&nbsp;último snapshot há ${idade}${desde}`;
  }

  /** O consumo medido depois da última leitura: é o que prova que o painel conta. */
  private tokensDesde(g: WindowGauge): string {
    if (!g.weightedSinceSnapshot) return "";
    const mtok = (g.weightedSinceSnapshot / 1e6).toFixed(2);
    return ` · ${mtok} Mtok desde então`;
  }

  private tooltip(d: ReturnType<Engine["decide"]>, pendentes: number): vscode.MarkdownString {
    const m = new vscode.MarkdownString();
    m.supportThemeIcons = true;
    m.isTrusted = true;

    m.appendMarkdown(`${this.linhaDaJanela("5 horas", d.gauge.five_hour)}\n\n`);
    m.appendMarkdown(`${this.linhaDaJanela("7 dias", d.gauge.seven_day)}\n\n`);

    // As duas janelas calibram separado, e podem calibrar por caminhos
    // diferentes: a de 5h quase nunca tem um par de leituras dentro da mesma
    // janela, então costuma vir do início dela.
    const calibracao = (rotulo: string, g: WindowGauge): string =>
      g.factor === null
        ? `${rotulo}: sem calibração`
        : `${rotulo}: ${g.factor.toFixed(2)} pp/Mtok, ${g.samples} amostra(s)`;

    m.appendMarkdown(
      `${calibracao("Calibração 5h", d.gauge.five_hour)}  \n${calibracao("Calibração 7d", d.gauge.seven_day)}\n\n`
    );

    m.appendMarkdown(`---\n\n`);
    m.appendMarkdown(
      `**Hoje:** ${fmtPct(d.usedToday)} de ${fmtPct(d.dailyCap)} — teto da semana ${d.weekCeiling}%\n\n`
    );
    m.appendMarkdown(`**Fila:** ${pendentes} pendente(s)\n\n`);

    const rodando = this.engine.running;
    if (rodando) m.appendMarkdown(`**Em execução:** ${rodando.title}\n\n`);
    if (this.store.paused) m.appendMarkdown(`$(debug-pause) **Fila pausada por você**\n\n`);

    m.appendMarkdown(`---\n\n`);
    if (d.ok && !this.store.paused) {
      m.appendMarkdown(`$(check) **Pode executar**`);
    } else {
      m.appendMarkdown(`$(clock) **Aguardando**\n`);
      for (const r of d.reasons) m.appendMarkdown(`\n- ${r}`);
      if (this.store.paused) m.appendMarkdown(`\n- fila pausada manualmente`);
    }
    return m;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
  }
}
