"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { core, tmpEnv } = require("../helpers");

/**
 * A limpeza mexe em histórico que não volta (no modo apagar) e em branches de
 * repositório de verdade. Os testes montam o estado à mão — tarefas, ledger,
 * resultados, lotes — e conferem o que sai e, principalmente, o que fica.
 */

const agora = Math.floor(Date.now() / 1000);
const DIA = 86400;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function criarRepo(raiz) {
  const repo = path.join(raiz, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "teste@exemplo.local"]);
  git(repo, ["config", "user.name", "Teste"]);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "inicial"]);
  return repo;
}

/** Uma tarefa já executada: arquivo na pasta do status, resultado e linha no ledger. */
function tarefa(env, repo, { id, status, lote, ordem, fim = agora, branch = null }) {
  const pasta = { queued: "queue", done: "done", failed: "failed" }[status];
  const meta = [`title: Tarefa ${id}`, `repo: ${repo.split("\\").join("/")}`, lote ? `lote: ${lote}` : "", ordem ? `ordem: ${ordem}` : "", `created: ${fim - 60}`]
    .filter(Boolean)
    .join("\n");
  fs.writeFileSync(path.join(env.home, pasta, `${id}.md`), `---\n${meta}\n---\n\nCorpo.\n`);
  if (status !== "queued") {
    fs.mkdirSync(path.join(env.home, "runs", id), { recursive: true });
    fs.writeFileSync(path.join(env.home, "runs", id, "result.md"), `# ${id}\n`);
    fs.appendFileSync(
      path.join(env.home, "ledger.jsonl"),
      JSON.stringify({ id, repo, branch, base: "main", model: "sonnet", start: fim - 60, end: fim, ok: status === "done", reason: "x", filesChanged: 1, lote: lote || null }) + "\n"
    );
  }
}

function lote(nome, repo, estado, extra = {}) {
  core.salvarLote({ nome, repo, base: "main", branch: null, estado, criado: agora - 100, bloqueio: null, puladas: [], commits: {}, ...extra });
}

function cenario(t) {
  const env = tmpEnv();
  t.after(() => env.cleanup());
  const repo = criarRepo(env.root);
  // o que a limpeza nunca pode tocar
  fs.writeFileSync(path.join(env.home, "snapshots.jsonl"), '{"ts":1}\n');
  fs.writeFileSync(path.join(env.home, "usage.json"), "{}");
  fs.writeFileSync(path.join(env.home, "state.json"), '{"day":"x"}');
  return { env, repo, cfg: env.cfg() };
}

const ids = (itens) => itens.map((i) => i.id).sort();

test("planejar: pendentes e lotes vivos ficam de fora", (t) => {
  const { env, repo, cfg } = cenario(t);
  tarefa(env, repo, { id: "feita", status: "done" });
  tarefa(env, repo, { id: "quebrou", status: "failed" });
  tarefa(env, repo, { id: "esperando", status: "queued" });
  lote("acabou", repo, "concluido");
  tarefa(env, repo, { id: "acabou-1", status: "done", lote: "acabou", ordem: 1 });
  lote("andando", repo, "andamento");
  tarefa(env, repo, { id: "andando-1", status: "done", lote: "andando", ordem: 1 });
  tarefa(env, repo, { id: "andando-2", status: "queued", lote: "andando", ordem: 2 });
  lote("travado", repo, "bloqueado");
  tarefa(env, repo, { id: "travado-1", status: "failed", lote: "travado", ordem: 1 });

  const plano = core.planejarLimpeza(cfg, ["concluidas", "falhas", "lotes"]);
  assert.deepStrictEqual(ids(plano), ["acabou", "feita", "quebrou"]);
  const doLote = plano.find((i) => i.id === "acabou");
  assert.ok(doLote.arquivos.some((a) => a.endsWith("acabou-1.md")), "o lote leva as tarefas dele");
  assert.ok(doLote.arquivos.some((a) => a.endsWith(path.join("runs", "acabou-1"))));

  assert.deepStrictEqual(ids(core.planejarLimpeza(cfg, ["pendentes"])), ["esperando"], "pendente só se pedir, e a do lote vivo não");
});

test("arquivar: sai do painel, fica em arquivo/<dia> com a mesma estrutura, e o medidor não é tocado", (t) => {
  const { env, repo, cfg } = cenario(t);
  tarefa(env, repo, { id: "feita", status: "done" });
  lote("acabou", repo, "cancelado");
  tarefa(env, repo, { id: "acabou-1", status: "failed", lote: "acabou", ordem: 1 });
  lote("andando", repo, "andamento");
  tarefa(env, repo, { id: "andando-1", status: "done", lote: "andando", ordem: 1 });
  const ledgerAntes = fs.readFileSync(path.join(env.home, "ledger.jsonl"), "utf8");

  const r = core.executarLimpeza(core.planejarLimpeza(cfg, ["concluidas", "falhas", "lotes"]), "arquivar", new Date(2026, 8, 30, 10, 0, 0));
  assert.strictEqual(r.itens, 2);
  const destino = path.join(env.home, "arquivo", "2026-09-30");
  assert.strictEqual(r.destino, destino);

  assert.ok(fs.existsSync(path.join(destino, "done", "feita.md")));
  assert.ok(fs.existsSync(path.join(destino, "runs", "feita", "result.md")));
  assert.ok(fs.existsSync(path.join(destino, "failed", "acabou-1.md")));
  assert.ok(fs.existsSync(path.join(destino, "lotes", "acabou.json")));
  assert.ok(fs.readdirSync(destino).some((f) => /^limpeza-\d{6}\.json$/.test(f)), "registro do que saiu");

  // o painel: só o lote vivo continua
  assert.deepStrictEqual(core.listTasks(cfg, "done").map((x) => x.id), ["andando-1"]);
  assert.deepStrictEqual(core.listTasks(cfg, "failed"), []);
  assert.deepStrictEqual(core.listarLotes().map((l) => l.nome), ["andando"]);

  // intocados
  assert.strictEqual(fs.readFileSync(path.join(env.home, "ledger.jsonl"), "utf8"), ledgerAntes);
  assert.strictEqual(fs.readFileSync(path.join(env.home, "snapshots.jsonl"), "utf8"), '{"ts":1}\n');
  assert.strictEqual(fs.readFileSync(path.join(env.home, "state.json"), "utf8"), '{"day":"x"}');
});

test("arquivar duas vezes no mesmo dia não sobrescreve", (t) => {
  const { env, repo, cfg } = cenario(t);
  const dia = new Date(2026, 8, 30, 10, 0, 0);
  tarefa(env, repo, { id: "mesma", status: "done" });
  core.executarLimpeza(core.planejarLimpeza(cfg, ["concluidas"]), "arquivar", dia);
  tarefa(env, repo, { id: "mesma", status: "done" });
  core.executarLimpeza(core.planejarLimpeza(cfg, ["concluidas"]), "arquivar", dia);
  const done = fs.readdirSync(path.join(env.home, "arquivo", "2026-09-30", "done")).sort();
  assert.deepStrictEqual(done, ["mesma.md", "mesma.md-2"]);
});

test("listarArquivados: lê os manifestos, mais recente primeiro, sem reler .md", (t) => {
  const { env, repo, cfg } = cenario(t);
  tarefa(env, repo, { id: "ontem", status: "done", fim: agora - DIA });
  core.executarLimpeza(core.planejarLimpeza(cfg, ["concluidas"]), "arquivar", new Date(2026, 8, 29, 10, 0, 0));
  tarefa(env, repo, { id: "hoje", status: "failed" });
  core.executarLimpeza(core.planejarLimpeza(cfg, ["falhas"]), "arquivar", new Date(2026, 8, 30, 11, 0, 0));

  const itens = core.listarArquivados();
  assert.deepStrictEqual(
    itens.map((i) => [i.id, i.categoria, i.data]),
    [
      ["hoje", "falhas", "2026-09-30"],
      ["ontem", "concluidas", "2026-09-29"],
    ]
  );
  assert.strictEqual(itens[0].titulo, "Tarefa hoje");
});

test("listarArquivados: respeita o limite", (t) => {
  const { env, repo, cfg } = cenario(t);
  for (const id of ["a", "b", "c"]) tarefa(env, repo, { id, status: "done" });
  core.executarLimpeza(core.planejarLimpeza(cfg, ["concluidas"]), "arquivar", new Date(2026, 8, 30, 10, 0, 0));

  assert.strictEqual(core.listarArquivados(2).length, 2);
  assert.strictEqual(core.listarArquivados().length, 3);
});

test("listarArquivados: sem nada arquivado, devolve vazio sem quebrar", (t) => {
  cenario(t);
  assert.deepStrictEqual(core.listarArquivados(), []);
});

test("apagar: some de vez, sem criar arquivo", (t) => {
  const { env, repo, cfg } = cenario(t);
  tarefa(env, repo, { id: "feita", status: "done" });
  const r = core.executarLimpeza(core.planejarLimpeza(cfg, ["concluidas"]), "apagar");
  assert.strictEqual(r.destino, null);
  assert.strictEqual(fs.existsSync(path.join(env.home, "done", "feita.md")), false);
  assert.strictEqual(fs.existsSync(path.join(env.home, "runs", "feita")), false);
  assert.strictEqual(fs.existsSync(path.join(env.home, "arquivo")), false);
});

test("com a fila executando, a limpeza recusa e não mexe em nada", (t) => {
  const { env, repo, cfg } = cenario(t);
  tarefa(env, repo, { id: "feita", status: "done" });
  assert.ok(core.acquireLock());
  t.after(() => core.releaseLock());
  assert.throws(() => core.executarLimpeza(core.planejarLimpeza(cfg, ["concluidas"]), "arquivar"), /executando agora/);
  assert.ok(fs.existsSync(path.join(env.home, "done", "feita.md")));
});

test("branches: só as mescladas na base são oferecidas e apagadas", (t) => {
  const { env, repo, cfg } = cenario(t);
  git(repo, ["branch", "juntada"]); // no mesmo commit de main: mesclada
  git(repo, ["checkout", "-b", "solta"]);
  fs.writeFileSync(path.join(repo, "novo.txt"), "y\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "trabalho não revisado"]);
  git(repo, ["checkout", "main"]);
  tarefa(env, repo, { id: "a", status: "done", branch: "juntada" });
  tarefa(env, repo, { id: "b", status: "done", branch: "solta" });
  tarefa(env, repo, { id: "c", status: "done", branch: "ja-apagada" });

  const itens = core.planejarLimpeza(cfg, ["concluidas"]);
  const mescladas = core.branchesMescladas(itens);
  assert.deepStrictEqual(mescladas.map((b) => b.branch), ["juntada"], "a não mesclada e a inexistente ficam de fora");

  const r = core.apagarBranches(mescladas);
  assert.deepStrictEqual(r.apagadas, ["juntada"]);
  assert.throws(() => git(repo, ["rev-parse", "--verify", "juntada"]));
  assert.ok(git(repo, ["rev-parse", "--verify", "solta"]), "o trabalho não revisado continua");
});

test("branch em checkout nunca é oferecida", (t) => {
  const { env, repo, cfg } = cenario(t);
  git(repo, ["checkout", "-b", "atual"]);
  tarefa(env, repo, { id: "a", status: "done", branch: "atual" });
  assert.deepStrictEqual(core.branchesMescladas(core.planejarLimpeza(cfg, ["concluidas"])), []);
});

test("retenção: desligada não faz nada; ligada arquiva só o velho, e nunca pendentes", (t) => {
  const { env, repo } = cenario(t);
  tarefa(env, repo, { id: "velha", status: "done", fim: agora - 10 * DIA });
  tarefa(env, repo, { id: "nova", status: "done", fim: agora - 1 * DIA });
  tarefa(env, repo, { id: "falha-velha", status: "failed", fim: agora - 30 * DIA });
  tarefa(env, repo, { id: "pendente-velha", status: "queued", fim: agora - 30 * DIA });

  assert.strictEqual(core.aplicarRetencao(env.cfg({ retencaoDias: 0 }), agora), null);
  assert.strictEqual(fs.readdirSync(path.join(env.home, "done")).length, 2);

  const r = core.aplicarRetencao(env.cfg({ retencaoDias: 7 }), agora);
  assert.strictEqual(r.itens, 2);
  assert.ok(r.destino.includes(path.join("arquivo", "")), "arquiva, não apaga");
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "done")), ["nova.md"]);
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "failed")), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "queue")), ["pendente-velha.md"]);
});

test("esvaziar o arquivo apaga o que foi arquivado e nada mais", (t) => {
  const { env, repo, cfg } = cenario(t);
  tarefa(env, repo, { id: "feita", status: "done" });
  tarefa(env, repo, { id: "fica", status: "failed" });
  core.executarLimpeza(core.planejarLimpeza(cfg, ["concluidas"]), "arquivar");
  assert.strictEqual(core.esvaziarArquivo(), 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "arquivo")), []);
  assert.ok(fs.existsSync(path.join(env.home, "failed", "fica.md")));
});
