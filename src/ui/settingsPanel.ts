import * as vscode from "vscode";
import { Config } from "../core/config";
import { dailyBudget, loadState } from "../core/gate";
import { WindowGauge } from "../core/gauge";
import { listTasks } from "../core/queue";
import { nomeDaBranch, resolveClaude } from "../core/runner";
import { fmtDuration, nowSec } from "../core/util";
import { Engine } from "../services/engine";
import { Store } from "../services/store";

/** O que o painel mostra de uma janela do medidor. */
interface JanelaNaTela {
  conhecida: boolean;
  pct: number | null;
  resetEm: string | null;
  origem: string;
  idadeMin: number | null;
  tokensDesde: number;
}

interface EstadoDaTela {
  valores: Record<string, unknown>;
  medidor: {
    cinco: JanelaNaTela;
    sete: JanelaNaTela;
    calibrado: boolean;
    fator: number | null;
    amostras: number;
  };
  orcamento: { hoje: number | null; usado: number | null; tetoSemanal: number };
  executavel: { caminho: string | null; erro: string | null };
  fila: { pendentes: number; pausada: boolean };
}

const CAMPOS = [
  "intervalMinutes",
  "reservePct",
  "dailyBudget.mode",
  "dailyBudget.fixedPct",
  "fiveHourMaxPct",
  "allowedHours",
  "weekdayOverrides",
  "maxTasksPerRun",
  "onWarning",
  "branchTemplate",
  "defaults.model",
  "defaults.maxTurns",
  "defaults.timeoutMin",
  "defaults.allowedTools",
  "claudePath",
  "dataDir",
] as const;

function descreverJanela(g: WindowGauge, agora: number): JanelaNaTela {
  let origem: string;
  if (!g.known) origem = "sem leitura";
  else if (g.confidence === "calibrated") origem = "estimado sobre leitura calibrada";
  else if (g.confidence === "stale") origem = "desatualizado";
  else if (g.rolledOver) origem = "piso: a janela virou e o consumo desde então não vira % sem calibração";
  else origem = "leitura direta, parada até a próxima";

  return {
    conhecida: g.known,
    pct: g.pct,
    resetEm: g.resetsAt ? fmtDuration(g.resetsAt - agora) : null,
    origem,
    idadeMin: g.snapshotAgeMin,
    tokensDesde: g.weightedSinceSnapshot,
  };
}

export class SettingsPanel {
  private static aberto: SettingsPanel | undefined;

  static mostrar(engine: Engine, store: Store): void {
    if (SettingsPanel.aberto) {
      SettingsPanel.aberto.painel.reveal(vscode.ViewColumn.One);
      SettingsPanel.aberto.atualizar();
      return;
    }
    SettingsPanel.aberto = new SettingsPanel(engine, store);
  }

  private readonly painel: vscode.WebviewPanel;
  private readonly descartaveis: vscode.Disposable[] = [];

  private constructor(
    private readonly engine: Engine,
    private readonly store: Store
  ) {
    this.painel = vscode.window.createWebviewPanel(
      "claudeQueue.settings",
      "Claude in Line — Configuração",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.painel.webview.html = this.html();
    this.descartaveis.push(
      this.painel.webview.onDidReceiveMessage((m) => void this.aoReceber(m)),
      // o medidor muda sozinho; a tela acompanha
      this.store.onDidChangeUsage(() => this.atualizar()),
      this.store.onDidChangeQueue(() => this.atualizar()),
      this.engine.onDidChange(() => this.atualizar())
    );

    this.painel.onDidDispose(() => {
      for (const d of this.descartaveis) d.dispose();
      SettingsPanel.aberto = undefined;
    });

    this.atualizar();
  }

  // ---------- estado ----------

  private estado(): EstadoDaTela {
    const c = vscode.workspace.getConfiguration("claudeQueue");
    const valores: Record<string, unknown> = {};
    for (const campo of CAMPOS) valores[campo] = c.get(campo);

    const cfg = this.engine.config();
    const decisao = this.engine.decide();
    const agora = nowSec();

    let caminho: string | null = null;
    let erro: string | null = null;
    try {
      caminho = resolveClaude(cfg);
    } catch (e) {
      erro = e instanceof Error ? e.message : String(e);
    }

    return {
      valores,
      medidor: {
        cinco: descreverJanela(decisao.gauge.five_hour, agora),
        sete: descreverJanela(decisao.gauge.seven_day, agora),
        calibrado: decisao.gauge.seven_day.confidence === "calibrated",
        fator: decisao.gauge.seven_day.factor,
        amostras: decisao.gauge.seven_day.samples,
      },
      orcamento: { hoje: decisao.dailyCap, usado: decisao.usedToday, tetoSemanal: decisao.weekCeiling },
      executavel: { caminho, erro },
      fila: { pendentes: this.pendentes(), pausada: this.store.paused },
    };
  }

  private pendentes(): number {
    try {
      return listTasks(this.engine.config(), "queued").length;
    } catch {
      return 0;
    }
  }

  private atualizar(): void {
    if (!this.painel.visible && !this.painel.active) return;
    void this.painel.webview.postMessage({ tipo: "estado", estado: this.estado() });
  }

  // ---------- mensagens vindas da tela ----------

  private async aoReceber(m: { tipo: string; campo?: string; valor?: unknown; cfg?: Partial<Config> }): Promise<void> {
    switch (m.tipo) {
      case "pronto":
        this.atualizar();
        break;

      case "salvar": {
        if (!m.campo) return;
        await vscode.workspace
          .getConfiguration("claudeQueue")
          .update(m.campo, m.valor, vscode.ConfigurationTarget.Global);
        this.atualizar();
        break;
      }

      /**
       * Simula o orçamento com valores que você ainda não salvou. A conta é a
       * mesma do porteiro, chamada aqui: duas cópias da fórmula divergiriam.
       */
      case "simular": {
        const base = this.engine.config();
        const candidato: Config = {
          ...base,
          reservePct: Number(m.cfg?.reservePct ?? base.reservePct),
          dailyBudget: { ...base.dailyBudget, ...(m.cfg?.dailyBudget || {}) },
        };
        const estado = loadState();
        const inicioDoDia = estado.dayStartWeekPct ?? 0;
        const cap = dailyBudget(candidato, inicioDoDia, estado.dayWeekResetsAt ?? null);
        void this.painel.webview.postMessage({
          tipo: "simulacao",
          hoje: cap,
          tetoSemanal: 100 - candidato.reservePct,
        });
        break;
      }

      case "previsaoBranch": {
        const modelo = String((m as { modelo?: string }).modelo || "");
        void this.painel.webview.postMessage({
          tipo: "previsaoBranch",
          exemplo: nomeDaBranch(
            { id: "20260929-205300-x", title: "Regime inválido na listagem devolve 400" } as never,
            "meu-repo",
            modelo
          ),
        });
        break;
      }

      case "gerarLeitura":
        await vscode.commands.executeCommand("claudeQueue.refreshReading");
        break;

      case "configurarMedidor":
        await vscode.commands.executeCommand("claudeQueue.setupMeter");
        this.atualizar();
        break;

      case "testarExecutavel":
        this.atualizar();
        break;

      case "abrirSettingsJson":
        await vscode.commands.executeCommand("workbench.action.openSettings", "claudeQueue");
        break;
    }
  }

  // ---------- html ----------

  private html(): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Claude in Line — Configuração</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 24px 24px 64px;
    line-height: 1.5;
  }
  .envelope { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 4px; }
  .subtitulo { color: var(--vscode-descriptionForeground); margin: 0 0 28px; }

  section {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 8px;
    padding: 18px 20px;
    margin-bottom: 18px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  h2 {
    font-size: .75rem; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 14px;
  }

  .campo { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; align-items: center; padding: 9px 0; }
  .campo + .campo { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
  .campo .rotulo { font-weight: 500; }
  .campo .ajuda { grid-column: 1 / -1; color: var(--vscode-descriptionForeground); font-size: .85em; margin-top: -2px; }

  input[type="number"], input[type="text"], select {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 4px 8px; font-family: inherit; font-size: inherit;
  }
  input[type="number"] { width: 82px; }
  input[type="text"] { width: 320px; max-width: 46vw; }
  input[type="range"] { width: 190px; vertical-align: middle; accent-color: var(--vscode-progressBar-background); }
  .comSlider { display: flex; align-items: center; gap: 12px; }
  .valor { min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }

  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer;
    font-family: inherit; font-size: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secundario {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
  }
  .botoes { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }

  .medidor { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; }
  .janela .numero { font-size: 2rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .janela .nome { color: var(--vscode-descriptionForeground); font-size: .85em; }
  .janela .detalhe { color: var(--vscode-descriptionForeground); font-size: .85em; margin-top: 6px; }
  .barra { height: 6px; border-radius: 3px; background: var(--vscode-panel-border, rgba(128,128,128,.3)); margin: 8px 0 4px; overflow: hidden; }
  .barra > div { height: 100%; border-radius: 3px; transition: width .3s; }

  .aviso {
    border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 10%, transparent);
    padding: 10px 14px; border-radius: 0 4px 4px 0; margin-top: 14px; font-size: .9em;
  }
  .erro {
    border-left-color: var(--vscode-editorError-foreground, #f14c4c);
    background: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 10%, transparent);
  }
  .destaque {
    background: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 12%, transparent);
    border-radius: 6px; padding: 12px 16px; margin-top: 14px; font-size: .95em;
  }
  code { font-family: var(--vscode-editor-font-family); font-size: .9em; }
  .caminho { word-break: break-all; }

  .diaSemana { display: grid; grid-template-columns: 90px 1fr 100px; gap: 10px; align-items: center; padding: 6px 0; }
  .diaSemana + .diaSemana { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
  .diaSemana .rotulo { font-weight: 500; }
  .diaSemanaCabecalho { color: var(--vscode-descriptionForeground); font-size: .8em; padding-bottom: 4px; }
  .diaSemana input[type="text"], .diaSemana input[type="number"] { width: 100%; box-sizing: border-box; }
</style>
</head>
<body>
<div class="envelope">
  <h1>Claude in Line</h1>
  <p class="subtitulo">A fila só roda com o VS Code aberto. As mudanças aqui valem na hora.</p>

  <section>
    <h2>Medidor</h2>
    <div class="medidor">
      <div class="janela" id="j5"></div>
      <div class="janela" id="j7"></div>
    </div>
    <div id="calibracao"></div>
    <div class="botoes">
      <button id="btGerar">Gerar leitura no terminal</button>
      <button class="secundario" id="btMedidor">Configurar statusline</button>
    </div>
  </section>

  <section>
    <h2>Quanto a fila pode gastar</h2>

    <div class="campo">
      <span class="rotulo">Reserva para você</span>
      <span class="comSlider">
        <input type="range" id="reservePct" min="0" max="80" step="5">
        <span class="valor" id="reservePctValor"></span>
      </span>
      <span class="ajuda">A fatia da semana que a fila nunca encosta. O teto dela é o que sobra.</span>
    </div>

    <div class="campo">
      <span class="rotulo">Teto da janela de 5 horas</span>
      <span class="comSlider">
        <input type="range" id="fiveHourMaxPct" min="0" max="100" step="5">
        <span class="valor" id="fiveHourMaxPctValor"></span>
      </span>
      <span class="ajuda">Freio de vazão: acima disso a fila não começa tarefa, mesmo sobrando orçamento.</span>
    </div>

    <div class="campo">
      <span class="rotulo">Orçamento diário</span>
      <select id="dailyBudget.mode">
        <option value="dynamic">Dinâmico</option>
        <option value="fixed">Fixo</option>
      </select>
      <span class="ajuda" id="ajudaOrcamento"></span>
    </div>

    <div class="campo" id="linhaFixo">
      <span class="rotulo">Percentual fixo por dia</span>
      <span class="comSlider">
        <input type="range" id="dailyBudget.fixedPct" min="1" max="50" step="1">
        <span class="valor" id="dailyBudget.fixedPctValor"></span>
      </span>
      <span class="ajuda">Cuidado: 15% por dia somam 105% na semana. É por isso que o padrão é dinâmico.</span>
    </div>

    <div class="destaque" id="simulacao"></div>
  </section>

  <section>
    <h2>Execução</h2>

    <div class="campo">
      <span class="rotulo">Ciclo a cada</span>
      <span><input type="number" id="intervalMinutes" min="1" max="720"> min</span>
      <span class="ajuda">De quanto em quanto tempo a fila olha se pode rodar.</span>
    </div>

    <div class="campo">
      <span class="rotulo">Tarefas por ciclo</span>
      <input type="number" id="maxTasksPerRun" min="1" max="20">
      <span class="ajuda" id="ajudaTarefas"></span>
    </div>

    <div class="campo">
      <span class="rotulo">Horários permitidos</span>
      <input type="text" id="allowedHours" placeholder="qualquer hora">
      <span class="ajuda">Ex.: <code>0-7, 12-14</code> para madrugada e almoço. Vazio = qualquer hora.</span>
    </div>

    <div class="campo">
      <span class="rotulo">Nome da branch</span>
      <input type="text" id="branchTemplate">
      <span class="ajuda">
        Marcadores: <code>{data}</code>, <code>{hora}</code>, <code>{repo}</code>,
        <code>{slug}</code>, <code>{id}</code>. A <code>/</code> cria níveis, e o VS Code mostra
        isso como árvore de pastas. Fica assim: <strong id="previaBranch"></strong>
      </span>
    </div>

    <div class="campo">
      <span class="rotulo">No aviso de limite</span>
      <select id="onWarning">
        <option value="finish">Terminar a tarefa atual</option>
        <option value="abort">Interromper na hora</option>
      </select>
      <span class="ajuda">Nos dois casos a fila pausa. A escolha é sobre o que já começou.</span>
    </div>
  </section>

  <section>
    <h2>Por dia da semana</h2>
    <p class="ajuda" style="margin:-4px 0 12px;">
      Dia sem nada aqui usa o horário e o orçamento gerais, acima. Dá para preencher só um dos dois.
    </p>
    <div class="diaSemana diaSemanaCabecalho"><span></span><span>Horário</span><span>% da semana</span></div>
    <div class="diaSemana">
      <span class="rotulo">Segunda</span>
      <input type="text" id="dia1Horas" placeholder="geral">
      <input type="number" id="dia1Pct" min="0" max="100" placeholder="geral">
    </div>
    <div class="diaSemana">
      <span class="rotulo">Terça</span>
      <input type="text" id="dia2Horas" placeholder="geral">
      <input type="number" id="dia2Pct" min="0" max="100" placeholder="geral">
    </div>
    <div class="diaSemana">
      <span class="rotulo">Quarta</span>
      <input type="text" id="dia3Horas" placeholder="geral">
      <input type="number" id="dia3Pct" min="0" max="100" placeholder="geral">
    </div>
    <div class="diaSemana">
      <span class="rotulo">Quinta</span>
      <input type="text" id="dia4Horas" placeholder="geral">
      <input type="number" id="dia4Pct" min="0" max="100" placeholder="geral">
    </div>
    <div class="diaSemana">
      <span class="rotulo">Sexta</span>
      <input type="text" id="dia5Horas" placeholder="geral">
      <input type="number" id="dia5Pct" min="0" max="100" placeholder="geral">
    </div>
    <div class="diaSemana">
      <span class="rotulo">Sábado</span>
      <input type="text" id="dia6Horas" placeholder="geral">
      <input type="number" id="dia6Pct" min="0" max="100" placeholder="geral">
    </div>
    <div class="diaSemana">
      <span class="rotulo">Domingo</span>
      <input type="text" id="dia0Horas" placeholder="geral">
      <input type="number" id="dia0Pct" min="0" max="100" placeholder="geral">
    </div>
    <span class="ajuda">Horário no mesmo formato de cima, ex.: <code>0-7, 12-14</code>. % da semana é o orçamento daquele dia, substituindo o cálculo dinâmico/fixo só nele.</span>
    <div id="resumoPorDia"></div>
  </section>

  <section>
    <h2>Padrões das tarefas novas</h2>

    <div class="campo">
      <span class="rotulo">Modelo</span>
      <select id="defaults.model">
        <option value="haiku">Haiku — barato, tarefas simples</option>
        <option value="sonnet">Sonnet — equilíbrio</option>
        <option value="opus">Opus — caro, tarefas difíceis</option>
      </select>
      <span class="ajuda">Cada tarefa pode sobrescrever isso no próprio frontmatter.</span>
    </div>

    <div class="campo">
      <span class="rotulo">Limite de turnos</span>
      <input type="number" id="defaults.maxTurns" min="1" max="200">
      <span class="ajuda">Quantas idas e voltas o Claude pode dar antes de parar.</span>
    </div>

    <div class="campo">
      <span class="rotulo">Tempo máximo</span>
      <span><input type="number" id="defaults.timeoutMin" min="1" max="600"> min</span>
      <span class="ajuda">Passou disso, o processo é morto e a tarefa vira falha.</span>
    </div>

    <div class="campo">
      <span class="rotulo">Ferramentas liberadas</span>
      <input type="text" id="defaults.allowedTools">
      <span class="ajuda">
        Separe por vírgula. O que não estiver aqui é <strong>negado</strong>, sem perguntar —
        é isso que mantém a fila dentro de tarefas de programação.
      </span>
    </div>
  </section>

  <section>
    <h2>Executável e dados</h2>
    <div id="executavel"></div>

    <div class="campo">
      <span class="rotulo">Caminho do claude</span>
      <input type="text" id="claudePath" placeholder="vazio = detectar sozinho">
      <span class="ajuda">Só preencha se a detecção automática errar.</span>
    </div>

    <div class="campo">
      <span class="rotulo">Pasta de dados</span>
      <input type="text" id="dataDir" placeholder="vazio = ~/.cq">
      <span class="ajuda">Compartilhada com a CLI <code>cq</code>. Mudar exige recarregar a janela.</span>
    </div>

    <div class="botoes">
      <button class="secundario" id="btTestar">Testar detecção</button>
      <button class="secundario" id="btJson">Abrir no settings.json</button>
    </div>
  </section>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let carregando = false;

const salvar = (campo, valor) => { if (!carregando) vscode.postMessage({ tipo: "salvar", campo, valor }); };
const pct = (v) => (v === null || v === undefined || !isFinite(v)) ? "?" : v.toFixed(1) + "%";

// ---------- horários: "0-7, 12-14" <-> [[0,7],[12,14]] ----------

function horasParaTexto(faixas) {
  if (!Array.isArray(faixas) || !faixas.length) return "";
  return faixas.map((f) => f[0] + "-" + f[1]).join(", ");
}

function textoParaHoras(texto) {
  const limpo = texto.trim();
  if (!limpo) return [];
  const faixas = [];
  for (const parte of limpo.split(",")) {
    const m = parte.trim().match(/^(\\d{1,2})\\s*-\\s*(\\d{1,2})$/);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 24 || b > 24 || a >= b) return null;
    faixas.push([a, b]);
  }
  return faixas;
}

// ---------- resumo do "por dia da semana": soma contra o teto da semana ----------

function atualizarResumoPorDia() {
  let soma = 0, preenchidos = 0;
  for (let i = 0; i < 7; i++) {
    const v = $("dia" + i + "Pct").value;
    if (v.trim() !== "") { soma += Number(v); preenchidos++; }
  }
  const el = $("resumoPorDia");
  if (!preenchidos) { el.innerHTML = ""; return; }

  const teto = 100 - (Number($("reservePct").value) || 0);
  const somaTxt = soma.toFixed(0) + "%", tetoTxt = teto.toFixed(0) + "%";
  el.innerHTML = soma > teto
    ? '<div class="aviso">Soma dos dias preenchidos: <strong>' + somaTxt + '</strong> — acima do teto da ' +
      'semana (<strong>' + tetoTxt + '</strong>, com a reserva atual). Alguns dias podem não chegar a rodar: ' +
      'quem manda por cima do % de cada dia continua sendo o teto semanal.</div>'
    : '<div class="destaque">Soma dos dias preenchidos: <strong>' + somaTxt + '</strong> — dentro do teto da ' +
      'semana (<strong>' + tetoTxt + '</strong>).</div>';
}

// ---------- desenho ----------

function corDaBarra(v) {
  if (v >= 80) return "var(--vscode-editorError-foreground, #f14c4c)";
  if (v >= 60) return "var(--vscode-editorWarning-foreground, #cca700)";
  return "var(--vscode-charts-green, #89d185)";
}

function desenharJanela(el, nome, j) {
  if (!j.conhecida) {
    el.innerHTML = '<div class="nome">' + nome + '</div><div class="numero">—</div>' +
      '<div class="detalhe">sem leitura ainda: use o painel do Claude Code, ou rode <code>claude</code> num terminal</div>';
    return;
  }
  const v = j.pct || 0;
  const desde = j.tokensDesde ? " · " + (j.tokensDesde / 1e6).toFixed(2) + " Mtok desde então" : "";
  const idade = j.idadeMin === null ? "?" : (j.idadeMin < 1 ? "agora" : Math.round(j.idadeMin) + " min atrás");
  el.innerHTML =
    '<div class="nome">' + nome + '</div>' +
    '<div class="numero">' + pct(j.pct) + '</div>' +
    '<div class="barra"><div style="width:' + Math.min(v, 100) + '%;background:' + corDaBarra(v) + '"></div></div>' +
    '<div class="detalhe">' + (j.resetEm ? "reset em " + j.resetEm : "reset desconhecido") + '</div>' +
    '<div class="detalhe">' + j.origem + '</div>' +
    '<div class="detalhe">leitura ' + idade + desde + '</div>';
}

function desenhar(e) {
  carregando = true;

  desenharJanela($("j5"), "Janela de 5 horas", e.medidor.cinco);
  desenharJanela($("j7"), "Janela de 7 dias", e.medidor.sete);

  $("calibracao").innerHTML = e.medidor.calibrado
    ? '<div class="destaque">Calibrado: <strong>' + e.medidor.fator.toFixed(2) +
      ' pontos por milhão de tokens</strong>, de ' + e.medidor.amostras + ' amostra(s). ' +
      'O consumo do painel do VS Code entra na conta entre uma leitura e outra.</div>'
    : '<div class="aviso"><strong>Sem calibração ainda.</strong> Os percentuais ficam parados entre ' +
      'leituras, e a fila roda só uma tarefa por ciclo. Para calibrar, rode <code>claude</code> no ' +
      'terminal em <strong>momentos espaçados</strong> — duas leituras precisam diferir em pelo menos ' +
      '2 pontos, com consumo entre elas.</div>';

  for (const campo of ["intervalMinutes","reservePct","dailyBudget.mode","dailyBudget.fixedPct",
                       "fiveHourMaxPct","maxTasksPerRun","onWarning","defaults.model",
                       "defaults.maxTurns","defaults.timeoutMin","claudePath","dataDir",
                       "branchTemplate"]) {
    const el = $(campo);
    if (el) el.value = e.valores[campo];
  }
  $("defaults.allowedTools").value = (e.valores["defaults.allowedTools"] || []).join(", ");
  $("allowedHours").value = horasParaTexto(e.valores["allowedHours"]);

  const porDia = e.valores["weekdayOverrides"] || [];
  for (let i = 0; i < 7; i++) {
    const ov = porDia[i];
    $("dia" + i + "Horas").value = ov && ov.horas ? horasParaTexto(ov.horas) : "";
    $("dia" + i + "Pct").value = ov && ov.pctDia != null ? ov.pctDia : "";
  }
  atualizarResumoPorDia();

  for (const campo of ["reservePct","fiveHourMaxPct","dailyBudget.fixedPct"]) {
    $(campo + "Valor").textContent = $(campo).value + "%";
  }

  const dinamico = e.valores["dailyBudget.mode"] === "dynamic";
  $("linhaFixo").style.display = dinamico ? "none" : "grid";
  $("ajudaOrcamento").textContent = dinamico
    ? "O que sobra da semana dividido pelos dias até o reset, recalculado todo dia. Um dia parado não queima cota: aumenta o teto de amanhã."
    : "O mesmo percentual todo dia, independente do que sobrou.";

  $("ajudaTarefas").textContent = e.medidor.calibrado
    ? "Quantas tarefas podem rodar em sequência num ciclo."
    : "Enquanto não houver calibração, é sempre 1 — a fila não enxerga o próprio consumo.";

  $("simulacao").innerHTML =
    'Com esses valores, hoje a fila pode usar até <strong>' + pct(e.orcamento.hoje) + '</strong>' +
    ' da janela semanal. Já foram usados <strong>' + pct(e.orcamento.usado) + '</strong>' +
    ' (contando o seu uso manual). Teto da semana: <strong>' + e.orcamento.tetoSemanal + '%</strong>.';

  vscode.postMessage({ tipo: "previsaoBranch", modelo: e.valores["branchTemplate"] });

  $("executavel").innerHTML = e.executavel.caminho
    ? '<div class="destaque">A fila vai usar:<br><code class="caminho">' + e.executavel.caminho + '</code></div>'
    : '<div class="aviso erro"><strong>Nenhum executável encontrado.</strong> ' + e.executavel.erro +
      '<br>Sem ele, nenhuma tarefa roda.</div>';

  carregando = false;
}

// ---------- ligações ----------

for (const campo of ["reservePct","fiveHourMaxPct","dailyBudget.fixedPct"]) {
  $(campo).addEventListener("input", () => {
    $(campo + "Valor").textContent = $(campo).value + "%";
    vscode.postMessage({
      tipo: "simular",
      cfg: {
        reservePct: Number($("reservePct").value),
        dailyBudget: { mode: $("dailyBudget.mode").value, fixedPct: Number($("dailyBudget.fixedPct").value) },
      },
    });
    if (campo === "reservePct") atualizarResumoPorDia();
  });
  $(campo).addEventListener("change", () => salvar(campo, Number($(campo).value)));
}

for (const campo of ["intervalMinutes","maxTasksPerRun","defaults.maxTurns","defaults.timeoutMin"]) {
  $(campo).addEventListener("change", () => salvar(campo, Number($(campo).value)));
}

for (const campo of ["dailyBudget.mode","onWarning","defaults.model"]) {
  $(campo).addEventListener("change", () => salvar(campo, $(campo).value));
}

$("branchTemplate").addEventListener("input", () => {
  vscode.postMessage({ tipo: "previsaoBranch", modelo: $("branchTemplate").value });
});
$("branchTemplate").addEventListener("change", () => salvar("branchTemplate", $("branchTemplate").value.trim()));

for (const campo of ["claudePath","dataDir"]) {
  $(campo).addEventListener("change", () => salvar(campo, $(campo).value.trim()));
}

$("defaults.allowedTools").addEventListener("change", (ev) => {
  // vírgula dentro de parênteses não separa: Bash(mvn test -Dtest=A,B:*) é uma só
  const bruto = ev.target.value;
  const lista = [];
  let nivel = 0, atual = "";
  for (const ch of bruto) {
    if (ch === "(") nivel++;
    if (ch === ")") nivel--;
    if (ch === "," && nivel === 0) { if (atual.trim()) lista.push(atual.trim()); atual = ""; }
    else atual += ch;
  }
  if (atual.trim()) lista.push(atual.trim());
  salvar("defaults.allowedTools", lista);
});

$("allowedHours").addEventListener("change", (ev) => {
  const faixas = textoParaHoras(ev.target.value);
  if (faixas === null) {
    ev.target.style.borderColor = "var(--vscode-editorError-foreground, #f14c4c)";
    return;
  }
  ev.target.style.borderColor = "";
  salvar("allowedHours", faixas);
});

function salvarPorDia() {
  const out = [];
  let valido = true;
  for (let i = 0; i < 7; i++) {
    const elHoras = $("dia" + i + "Horas");
    const elPct = $("dia" + i + "Pct");
    const faixas = elHoras.value.trim() ? textoParaHoras(elHoras.value) : [];
    if (faixas === null) {
      elHoras.style.borderColor = "var(--vscode-editorError-foreground, #f14c4c)";
      valido = false;
      continue;
    }
    elHoras.style.borderColor = "";
    const pctDia = elPct.value.trim() !== "" ? Number(elPct.value) : null;
    const horas = faixas.length ? faixas : null;
    out.push(horas || pctDia !== null ? { horas, pctDia } : null);
  }
  if (valido) salvar("weekdayOverrides", out);
}

for (let i = 0; i < 7; i++) {
  $("dia" + i + "Horas").addEventListener("change", salvarPorDia);
  $("dia" + i + "Pct").addEventListener("change", salvarPorDia);
  $("dia" + i + "Pct").addEventListener("input", atualizarResumoPorDia);
}

$("btGerar").addEventListener("click", () => vscode.postMessage({ tipo: "gerarLeitura" }));
$("btMedidor").addEventListener("click", () => vscode.postMessage({ tipo: "configurarMedidor" }));
$("btTestar").addEventListener("click", () => vscode.postMessage({ tipo: "testarExecutavel" }));
$("btJson").addEventListener("click", () => vscode.postMessage({ tipo: "abrirSettingsJson" }));

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.tipo === "estado") desenhar(m.estado);
  if (m.tipo === "previsaoBranch") $("previaBranch").textContent = m.exemplo;
  if (m.tipo === "simulacao") {
    $("simulacao").innerHTML =
      'Com esses valores, hoje a fila poderia usar até <strong>' + pct(m.hoje) + '</strong>' +
      ' da janela semanal. Teto da semana: <strong>' + m.tetoSemanal + '%</strong>.' +
      ' <em>(ainda não salvo)</em>';
  }
});

vscode.postMessage({ tipo: "pronto" });
</script>
</body>
</html>`;
  }
}
