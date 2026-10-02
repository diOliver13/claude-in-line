"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { core, tmpEnv, writeJson } = require("../helpers");

/**
 * O lote contra o simulador e um repositório de verdade: é o comportamento que
 * decide se o que fica para revisar é uma branch arrumada ou um problema.
 */

const ehWindows = process.platform === "win32";
const FAKE = path.resolve(__dirname, "..", "fake-claude.js");
const now = Math.floor(Date.now() / 1000);
const inicioDoDia = (() => {
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
})();

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function criarRepo(raiz) {
  const repo = path.join(raiz, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "teste@exemplo.local"]);
  git(repo, ["config", "user.name", "Teste"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "README.md"), "repositório de teste\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "inicial"]);
  return repo;
}

function criarSimulador(raiz) {
  if (!ehWindows) return FAKE;
  const cmd = path.join(raiz, "claude-falso.cmd");
  fs.writeFileSync(cmd, `@echo off\r\nnode "${FAKE}" %*\r\n`);
  return cmd;
}

function medidorComFolga(env) {
  const resetSemanal = inicioDoDia + 5 * 86400;
  writeJson(path.join(env.home, "usage.json"), {
    ts: now,
    source: "statusline",
    seven_day: { pct: 10, resetsAt: resetSemanal },
    five_hour: { pct: 5, resetsAt: now + 3600 },
  });
  writeJson(path.join(env.home, "state.json"), {
    day: core.localDay(new Date(now * 1000)),
    dayStartWeekPct: 10,
    dayWeekResetsAt: resetSemanal,
  });
}

/** Cenário isolado: dados, repositório, simulador e medidor com folga. */
function cenario(t) {
  const env = tmpEnv();
  const claudeAnterior = process.env.CLAUDE_CONFIG_DIR;
  const modoAnterior = process.env.FAKE_MODE;
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = claudeAnterior;
    process.env.FAKE_MODE = modoAnterior;
    env.cleanup();
  });
  process.env.CLAUDE_CONFIG_DIR = env.claudeDir;
  delete process.env.FAKE_MODE;
  const repo = criarRepo(env.root);
  medidorComFolga(env);
  const cfg = env.cfg({ claudePath: criarSimulador(env.root), maxTasksPerRun: 5 });
  return { env, repo, cfg };
}

let seq = 0;
/** Escreve a tarefa como a fila guarda. `created` crescente mantém a ordem estável. */
function enfileirar(env, repo, { titulo, lote, ordem, corpo = "", extras = "" }) {
  const id = `t${String(++seq).padStart(3, "0")}-${titulo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const meta = [
    `title: ${titulo}`,
    `repo: ${repo.split("\\").join("/")}`,
    "priority: 3",
    lote ? `lote: ${lote}` : "",
    ordem ? `ordem: ${ordem}` : "",
    `created: ${now + seq}`,
    extras,
  ].filter(Boolean);
  fs.writeFileSync(path.join(env.home, "queue", `${id}.md`), `---\n${meta.join("\n")}\n---\n\nFaça a parte ${titulo}.\n${corpo}\n`);
  return id;
}

/**
 * Sem calibração o porteiro roda uma tarefa por ciclo — como na vida real no
 * começo. Então o teste roda ciclos até a fila parar de andar.
 */
async function rodarAteParar(cfg, limite = 6) {
  const eventos = [];
  for (let i = 0; i < limite; i++) {
    const n = await core.runQueue(cfg, { onEvent: (e) => eventos.push(e) });
    if (n === 0) break;
  }
  return eventos;
}

const fins = (eventos) => eventos.filter((e) => e.kind === "task-end");
const lerLote = (env, nome) => JSON.parse(fs.readFileSync(path.join(env.home, "lotes", `${nome}.json`), "utf8"));

test("lote: três tarefas viram uma branch com três commits, em ordem", async (t) => {
  const { env, repo, cfg } = cenario(t);
  const ids = ["A", "B", "C"].map((l, i) =>
    enfileirar(env, repo, { titulo: `Parte ${l}`, lote: "site", ordem: i + 1, corpo: `ARQUIVO: parte-${l}.txt` })
  );

  const eventos = await rodarAteParar(cfg);
  const resultados = fins(eventos).map((e) => e.result);
  assert.strictEqual(resultados.length, 3);
  assert.ok(resultados.every((r) => r.ok), resultados.map((r) => r.reason).join("; "));

  const lote = lerLote(env, "site");
  assert.strictEqual(lote.estado, "concluido");
  const branch = lote.branch;
  assert.strictEqual(branch, core.nomeDaBranch({ id: "site", title: "site" }, "repo", cfg.branchTemplate));
  assert.ok(resultados.every((r) => r.branch === branch), "todas na mesma branch");

  // um commit por tarefa, na ordem de entrada, e nada em main
  const log = git(repo, ["log", "--reverse", "--format=%s", `main..${branch}`]).split("\n");
  assert.deepStrictEqual(log, ["cq: Parte A", "cq: Parte B", "cq: Parte C"]);
  assert.strictEqual(git(repo, ["rev-list", "--count", `main..${branch}`]), "3");
  assert.deepStrictEqual(Object.keys(lote.commits).sort(), [...ids].sort());

  // cada tarefa enxergou o que as anteriores fizeram
  const c = git(repo, ["show", `${branch}:parte-C.txt`]);
  assert.match(c, /arquivos antes: .*parte-A\.txt.*parte-B\.txt/);
  assert.match(c, /LOTE: site\. Esta é a tarefa 3 de 3\./);
  assert.match(c, /- 1\. Parte A \(commit [0-9a-f]{7}\)/);
  assert.match(c, /- 2\. Parte B/);

  // o diff de uma tarefa é o commit dela contra o pai
  const linha = fs
    .readFileSync(path.join(env.home, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .find((l) => l.id === ids[1]);
  assert.strictEqual(linha.lote, "site");
  assert.strictEqual(git(repo, ["diff", "--name-only", `${linha.commit}~1`, linha.commit]), "parte-B.txt");

  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "worktrees")), [], "nenhuma worktree sobrou");
  const relatorio = fs.readFileSync(path.join(env.home, "lotes", "site.md"), "utf8");
  assert.match(relatorio, /Estado: \*\*concluído\*\*/);
  assert.match(relatorio, /\| 2 \| Parte B \| .* \| ✓ concluída \| `[0-9a-f]{7}` \|/);
});

test("lote: a ordem do lote vale mais que a prioridade", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Primeira", lote: "ordem", ordem: 1, extras: "priority: 5" });
  enfileirar(env, repo, { titulo: "Segunda", lote: "ordem", ordem: 2, extras: "priority: 1" });
  // `priority` repetido: o último vence no frontmatter; o que importa é que a urgente é a segunda
  const eventos = await rodarAteParar(cfg);
  assert.deepStrictEqual(
    fins(eventos).map((e) => e.task.title),
    ["Primeira", "Segunda"],
    "a segunda depende da primeira, então espera"
  );
});

test("lote: falha no meio bloqueia o resto, e o trabalho parcial fica fora da branch do lote", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Parte A", lote: "quebra", ordem: 1, corpo: "ARQUIVO: a.txt" });
  const idB = enfileirar(env, repo, { titulo: "Parte B", lote: "quebra", ordem: 2, corpo: "ARQUIVO: b.txt\nMODO: falha" });
  const idC = enfileirar(env, repo, { titulo: "Parte C", lote: "quebra", ordem: 3, corpo: "ARQUIVO: c.txt" });

  const eventos = await rodarAteParar(cfg);
  const resultados = fins(eventos).map((e) => e.result);
  assert.strictEqual(resultados.length, 2, "C não rodou");
  assert.strictEqual(resultados[0].ok, true);
  assert.strictEqual(resultados[1].ok, false);

  const bloqueio = eventos.find((e) => e.kind === "blocked");
  assert.ok(bloqueio, "o ciclo seguinte diz por que não andou");
  assert.match(bloqueio.motivos[0], /lote quebra bloqueado/);

  const lote = lerLote(env, "quebra");
  assert.strictEqual(lote.estado, "bloqueado");
  assert.strictEqual(lote.bloqueio.tarefa, idB);

  // a branch do lote só tem A
  assert.deepStrictEqual(git(repo, ["log", "--format=%s", `main..${lote.branch}`]).split("\n"), ["cq: Parte A"]);
  // o parcial de B está à parte, em cima de A, para quem quiser olhar
  const falha = resultados[1].branchFalha;
  assert.ok(falha && falha.startsWith(`${lote.branch}-falha-`), falha);
  assert.strictEqual(lote.bloqueio.branchFalha, falha);
  assert.deepStrictEqual(git(repo, ["log", "--format=%s", `main..${falha}`]).split("\n"), ["cq(wip): Parte B", "cq: Parte A"]);

  // C continua na fila, esperando
  assert.deepStrictEqual(core.listTasks(cfg, "queued").map((x) => x.id), [idC]);

  // o relatório da falha responde "o que aconteceu?" sem abrir o JSON
  const relatorio = fs.readFileSync(path.join(env.home, "runs", idB, "falha.md"), "utf8");
  assert.match(relatorio, /# Falha: Parte B/);
  assert.match(relatorio, /Motivo: \*\*erro: error_during_execution\*\*/);
  assert.match(relatorio, /Tentei rodar os testes e eles quebraram/, "o que o modelo disse por último");
  assert.match(relatorio, /\*\*Bash\*\* `npm test`/, "o erro de ferramenta, com o comando");
  assert.match(relatorio, /Error: exit code 1/);
  // o trabalho parcial é commitado de verdade -- "guardados em" deixava
  // parecer que podia estar solto, sem commit nenhum (ver runner.ts)
  const hashCurto = git(repo, ["rev-parse", "--short", falha]);
  assert.match(
    relatorio,
    new RegExp(`commitados como \`cq\\(wip\\) ${hashCurto}\` em \`${falha.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\``)
  );
  assert.match(relatorio, /Já commitadas em .*1\. Parte A/);
  assert.match(relatorio, /Paradas até você decidir: 3\. Parte C/);
  assert.match(fs.readFileSync(path.join(env.home, "runs", idB, "result.md"), "utf8"), /Relatório da falha: .*falha\.md/);

  const doLote = fs.readFileSync(path.join(env.home, "lotes", "quebra.md"), "utf8");
  assert.match(doLote, /BLOQUEADO/);
  assert.match(doLote, /## Por que parou/);
  assert.match(
    doLote,
    new RegExp(`foi commitado como \`cq\\(wip\\) ${hashCurto}\` em \`${falha.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\``)
  );
  assert.match(doLote, /\| 3 \| Parte C \| .* \| ⏸ parada \|/);
});

test("lote bloqueado só por limite: quando o freio passa, a tarefa volta sozinha", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Parte A", lote: "limite", ordem: 1, corpo: "ARQUIVO: a.txt" });
  const idB = enfileirar(env, repo, { titulo: "Parte B", lote: "limite", ordem: 2, corpo: "ARQUIVO: b.txt\nMODO: rejected" });
  enfileirar(env, repo, { titulo: "Parte C", lote: "limite", ordem: 3, corpo: "ARQUIVO: c.txt" });

  await rodarAteParar(cfg);
  assert.strictEqual(core.findTask(cfg, idB).status, "failed");
  let lote = lerLote(env, "limite");
  assert.strictEqual(lote.estado, "bloqueado");
  assert.strictEqual(lote.bloqueio.tarefa, idB);
  assert.strictEqual(lote.bloqueio.porLimite, true, "o Claude Code recusou por limite, não foi um problema da tarefa");

  // o freio ainda vale: nada muda sozinho
  assert.strictEqual(await core.runQueue(cfg, {}), 0);
  assert.strictEqual(lerLote(env, "limite").estado, "bloqueado");

  // a janela "zera": o freio deixa de valer
  const estado = JSON.parse(fs.readFileSync(path.join(env.home, "state.json"), "utf8"));
  delete estado.brake;
  writeJson(path.join(env.home, "state.json"), estado);

  // sem clicar em "Tentar de novo", o próximo ciclo já retoma sozinho
  const eventos = [];
  await core.runQueue(cfg, { onEvent: (e) => eventos.push(e) });
  assert.ok(
    eventos.some((e) => e.kind === "task-start" && e.task.id === idB),
    "retomou a tarefa parada sem ação manual"
  );
});

test("lote bloqueado por um problema de verdade (não limite) nunca retoma sozinho", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Parte A", lote: "quebra2", ordem: 1, corpo: "ARQUIVO: a.txt" });
  const idB = enfileirar(env, repo, { titulo: "Parte B", lote: "quebra2", ordem: 2, corpo: "ARQUIVO: b.txt\nMODO: falha" });
  enfileirar(env, repo, { titulo: "Parte C", lote: "quebra2", ordem: 3, corpo: "ARQUIVO: c.txt" });

  await rodarAteParar(cfg);
  const lote = lerLote(env, "quebra2");
  assert.strictEqual(lote.estado, "bloqueado");
  assert.ok(!lote.bloqueio.porLimite, "falha de teste comum não é bloqueio por limite");

  // sem freio nenhum ativo, mesmo assim nada roda sozinho: só "Tentar de novo" decide
  assert.strictEqual(await core.runQueue(cfg, {}), 0);
  assert.strictEqual(lerLote(env, "quebra2").estado, "bloqueado");
  assert.strictEqual(core.findTask(cfg, idB).status, "failed");
});

test("lote bloqueado: pular segue sem a tarefa; a que falhou não entra na branch", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Parte A", lote: "pula", ordem: 1, corpo: "ARQUIVO: a.txt" });
  const idB = enfileirar(env, repo, { titulo: "Parte B", lote: "pula", ordem: 2, corpo: "ARQUIVO: b.txt\nMODO: falha" });
  enfileirar(env, repo, { titulo: "Parte C", lote: "pula", ordem: 3, corpo: "ARQUIVO: c.txt" });
  await rodarAteParar(cfg);

  const b = core.findTask(cfg, idB);
  assert.strictEqual(b.status, "failed");
  core.pularNoLote(cfg, b);
  await rodarAteParar(cfg);

  const lote = lerLote(env, "pula");
  assert.strictEqual(lote.estado, "concluido");
  assert.deepStrictEqual(lote.puladas, [idB]);
  assert.deepStrictEqual(git(repo, ["log", "--reverse", "--format=%s", `main..${lote.branch}`]).split("\n"), ["cq: Parte A", "cq: Parte C"]);
  assert.throws(() => git(repo, ["show", `${lote.branch}:b.txt`]), "o parcial de B não está na branch do lote");
});

test("lote bloqueado: tentar de novo retoma de onde parou", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Parte A", lote: "retoma", ordem: 1, corpo: "ARQUIVO: a.txt" });
  const idB = enfileirar(env, repo, { titulo: "Parte B", lote: "retoma", ordem: 2, corpo: "ARQUIVO: b.txt\nMODO: falha" });
  await rodarAteParar(cfg);

  // a correção: tira o modo de falha, como quem ajusta o pedido antes de repetir
  const b = core.findTask(cfg, idB);
  fs.writeFileSync(b.file, fs.readFileSync(b.file, "utf8").replace("MODO: falha", ""));
  core.moveTask(b, "queued");
  core.desbloquearLote("retoma");
  await rodarAteParar(cfg);

  const lote = lerLote(env, "retoma");
  assert.strictEqual(lote.estado, "concluido");
  assert.deepStrictEqual(git(repo, ["log", "--reverse", "--format=%s", `main..${lote.branch}`]).split("\n"), ["cq: Parte A", "cq: Parte B"]);
});

test("lote com a branch em checkout no repositório: a fila espera, não falha", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Parte A", lote: "revisando", ordem: 1, corpo: "ARQUIVO: a.txt" });
  await rodarAteParar(cfg);
  const lote = lerLote(env, "revisando");
  git(repo, ["checkout", lote.branch]);

  // pelo mesmo caminho do MCP: um lote concluído que recebe tarefa volta a andar
  const entrada = core.entrarNoLote(cfg, { nome: "revisando", repo });
  assert.strictEqual(entrada.ok, true);
  assert.strictEqual(entrada.ordem, 2);
  enfileirar(env, repo, { titulo: "Parte B", lote: "revisando", ordem: entrada.ordem, corpo: "ARQUIVO: b.txt" });
  const eventos = await rodarAteParar(cfg);
  assert.strictEqual(fins(eventos).length, 0, "não tentou rodar");
  assert.match(eventos.find((e) => e.kind === "blocked").motivos[0], /esperando você sair da branch/);
  assert.strictEqual(lerLote(env, "revisando").estado, "andamento", "o lote não ficou bloqueado por isso");

  git(repo, ["checkout", "main"]);
  const depois = await rodarAteParar(cfg);
  assert.strictEqual(fins(depois).length, 1);
  assert.strictEqual(fins(depois)[0].result.ok, true);
});

test("escrita fora da worktree vira falha, com o caminho no relatório", async (t) => {
  const { env, repo, cfg } = cenario(t);
  const fora = path.join(env.root, "fora-da-worktree", "guia.md");
  fs.mkdirSync(path.dirname(fora), { recursive: true });
  const id = enfileirar(env, repo, { titulo: "Guia", corpo: `MODO: fora\nFORA: ${fora}` });

  const r = fins(await rodarAteParar(cfg))[0].result;
  assert.strictEqual(r.ok, false, "antes, isto saía como concluída com 0 arquivos");
  assert.match(r.reason, /gravou fora da worktree/);
  const relatorio = fs.readFileSync(path.join(env.home, "runs", id, "falha.md"), "utf8");
  assert.match(relatorio, /## Escritas fora da worktree/);
  assert.ok(relatorio.includes(fora), "o caminho aparece, para você recuperar o arquivo");
});

test("comando negado aparece no resultado, mesmo com a tarefa concluída", async (t) => {
  const { env, repo, cfg } = cenario(t);
  const id = enfileirar(env, repo, { titulo: "Negada", corpo: "MODO: negado" });

  const r = fins(await rodarAteParar(cfg))[0].result;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.negadas, 1);
  const resultado = fs.readFileSync(path.join(env.home, "runs", id, "result.md"), "utf8");
  assert.match(resultado, /## Comandos negados \(1\)/);
  assert.match(resultado, /\*\*Bash\*\* `ls -la`/);
});

test("o prompt diz onde trabalhar, o que está liberado e o que fazer com uma negação", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Prompt", extras: "allowedTools: Read,Edit,Bash(npm:*)" });
  const r = fins(await rodarAteParar(cfg))[0].result;
  const recebido = git(repo, ["show", `${r.branch}:FEITO.txt`]);
  assert.match(recebido, /Seu diretório de trabalho é .*worktrees/);
  assert.match(recebido, /Ferramentas liberadas: Read, Edit, Bash\(npm:\*\)/);
  assert.match(recebido, /Uma negação vale só para aquele comando/);
  assert.match(recebido, /Não faça push/, "as regras antigas continuam");
});

test("tarefa avulsa continua como antes: branch própria", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Avulsa" });
  const r = fins(await rodarAteParar(cfg))[0].result;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.lote, undefined);
  assert.match(git(repo, ["log", "-1", "--format=%s", r.branch]), /^cq: Avulsa$/);
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "lotes")), []);
});

// ---------- análise ----------

test("análise do lote: sai ao concluir, com consumo, comandos e pontos de atenção", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Pagina", lote: "analisado", ordem: 1, corpo: "ARQUIVO: pagina.txt\nCOMANDO: npm test" });
  // mesma saída da primeira: as duas tarefas mexem no mesmo arquivo
  enfileirar(env, repo, { titulo: "Ajuste", lote: "analisado", ordem: 2, corpo: "ARQUIVO: pagina.txt\nCOMANDO: npm run build", extras: "model: opus" });
  enfileirar(env, repo, { titulo: "Guia", lote: "analisado", ordem: 3, corpo: "ARQUIVO: guia.txt", extras: "model: haiku" });
  await rodarAteParar(cfg);

  const arquivo = path.join(env.home, "lotes", "analisado-analise.md");
  assert.ok(fs.existsSync(arquivo), "a análise foi escrita ao concluir, sem ninguém pedir");
  const md = fs.readFileSync(arquivo, "utf8");

  assert.match(md, /# Análise do lote analisado/);
  assert.match(md, /\| Commits \| 3 \|/);
  assert.match(md, /\| Custo equivalente em API \| US\$ 1\.26 \|/, "0,42 por tarefa, somado");
  assert.match(md, /## Consumo por tarefa/);
  assert.match(md, /\| 1 \| Pagina \| sonnet \| .* \| 3 \| 1 mil \| 20 mil \|/, "tokens do usage do resultado");
  assert.match(md, /## Por modelo/);
  for (const m of ["sonnet", "opus", "haiku"]) assert.match(md, new RegExp(`\| ${m} \| 1 \| US\$ 0\.42 \|`));

  // o que cada uma rodou, com o resultado
  assert.match(md, /- ✓ `npm test`/);
  assert.match(md, /- ✓ `npm run build`/);
  assert.match(md, /`pagina\.txt` \+\d+ −\d+/);

  // atenção: a 3 não verificou nada; pagina.txt foi mexido por duas
  assert.match(md, /\*\*3\. Guia\*\* concluiu sem nenhum comando de terminal que passasse/);
  assert.match(md, /`pagina\.txt` foi alterado pelas tarefas 1, 2/);
  assert.doesNotMatch(md, /\*\*1\. Pagina\*\* concluiu sem/);
  assert.match(md, /git merge --no-ff Dev_Branches\//);

  // sem calibração, a estimativa em pontos não é inventada
  assert.match(md, /\| Limite da semana, estimado \| — \|/);
});

test("descrição de PR: o que foi feito e como foi verificado, sem contabilidade", async (t) => {
  const { env, repo, cfg } = cenario(t);
  enfileirar(env, repo, { titulo: "Pagina", lote: "pr", ordem: 1, corpo: "ARQUIVO: pagina.txt\nCOMANDO: npm test" });
  await rodarAteParar(cfg);
  const pr = core.descricaoDePR(cfg, "pr");
  assert.match(pr, /## pr/);
  assert.match(pr, /### 1\. Pagina/);
  assert.match(pr, /Criei pagina\.txt/);
  assert.match(pr, /Verificado com: `npm test`/);
  assert.doesNotMatch(pr, /US\$|tokens|Semana/, "consumo interessa a você, não a quem revisa o PR");
});

test("comandos rodados aparecem no resultado de toda tarefa", async (t) => {
  const { env, repo, cfg } = cenario(t);
  const id = enfileirar(env, repo, { titulo: "Com teste", corpo: "COMANDO: npm test" });
  await rodarAteParar(cfg);
  const resultado = fs.readFileSync(path.join(env.home, "runs", id, "result.md"), "utf8");
  assert.match(resultado, /## Comandos rodados \(1\)/);
  assert.match(resultado, /- ✓ `npm test`/);
  const detalhes = JSON.parse(fs.readFileSync(path.join(env.home, "runs", id, "detalhes.json"), "utf8"));
  assert.deepStrictEqual(detalhes.comandos, [{ ferramenta: "Bash", comando: "npm test", ok: true, negado: false }]);
  assert.strictEqual(detalhes.ferramentas.Bash, 1);
});
