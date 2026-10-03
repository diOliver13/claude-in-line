"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { core, tmpEnv } = require("../helpers");

test("pesoDoUso: os mesmos pesos do medidor, com o peso do modelo", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());
  const cfg = env.cfg();
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10000, cache_creation_input_tokens: 400 };
  // 1000*1 + 100*5 + 10000*0.1 + 400*1.25 = 3000
  assert.strictEqual(core.pesoDoUso(usage, "sonnet", cfg), 3000);
  assert.strictEqual(Math.round(core.pesoDoUso(usage, "opus", cfg)), 5010, "opus pesa 1,67");
  assert.strictEqual(core.pesoDoUso(null, "sonnet", cfg), 0);
});

test("analisarTarefa: pontos da semana = peso × fator da calibração", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());
  const lote = { nome: "x", repo: env.root, base: "main", branch: null, estado: "concluido", criado: 0, bloqueio: null, puladas: [], commits: {} };
  const task = { id: "t1", title: "T", model: "sonnet", ordem: 1 };
  const ledger = {
    id: "t1", model: "sonnet", start: 100, end: 400, ok: true, reason: "concluída", filesChanged: 1, costUsd: 0.5,
    usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } },
    pesoTokens: 2e6,
    medidor: { antes: null, depois: { semana: 40, cinco: 20, fatorSemana: 1.5, fatorCinco: 4 } },
  };
  const a = core.analisarTarefa(lote, task, ledger);
  assert.strictEqual(a.pctSemana, 3);
  assert.strictEqual(a.pctCinco, 8);
  assert.strictEqual(a.duracao, 300);
  assert.strictEqual(a.tokens.raciocinio, 5);
  assert.strictEqual(a.situacao, "concluída");

  const semCalibracao = core.analisarTarefa(lote, task, { ...ledger, medidor: { antes: null, depois: { semana: 40, cinco: 20, fatorSemana: null, fatorCinco: null } } });
  assert.strictEqual(semCalibracao.pctSemana, null, "sem fator, não inventa número");
  assert.strictEqual(core.analisarTarefa({ ...lote, puladas: ["t1"] }, task, ledger).situacao, "pulada");
  assert.strictEqual(core.analisarTarefa(lote, task, null).situacao, "não rodou");
});

test("analisarLote: linha do tempo com início e fim de cada execução, inclusive retentativas", (t) => {
  const fs = require("fs");
  const path = require("path");
  const env = tmpEnv();
  t.after(() => env.cleanup());
  const cfg = env.cfg();
  const repo = env.root.split("\\").join("/");
  core.salvarLote({ nome: "linha", repo: env.root, base: "main", branch: null, estado: "concluido", criado: 0, bloqueio: null, puladas: [], commits: {} });
  for (const [id, ordem] of [["t1", 1], ["t2", 2]]) {
    fs.writeFileSync(
      path.join(env.home, "done", `${id}.md`),
      `---\ntitle: Tarefa ${ordem}\nrepo: ${repo}\nlote: linha\nordem: ${ordem}\ncreated: ${ordem}\n---\n\nCorpo.\n`
    );
  }
  const linha = (id, start, end, ok, reason) => JSON.stringify({ id, model: "sonnet", start, end, ok, reason, filesChanged: 0 });
  fs.writeFileSync(
    path.join(env.home, "ledger.jsonl"),
    [
      linha("t1", 1000, 1100, true, "concluída"),
      linha("t2", 1200, 1300, false, "limite five_hour atingido\nfatal: segunda linha | com barra"),
      linha("t2", 5000, 5500, true, "concluída"),
    ].join("\n") + "\n"
  );
  const q = (ts) => new Date(ts * 1000).toLocaleString("pt-BR");

  const md = core.analisarLote(cfg, "linha").markdown;
  const tempo = md.split("## Linha do tempo")[1].split("\n## ")[0];
  const linhas = tempo.split("\n").filter((l) => /^\| \d/.test(l));
  assert.strictEqual(linhas.length, 3, "uma linha por execução, não por tarefa");
  assert.ok(linhas[0].includes(`| Tarefa 1 | ${q(1000)} | ${q(1100)} |`));
  assert.ok(linhas[1].includes(`Tarefa 2 (tentativa 1) | ${q(1200)} | ${q(1300)} |`) && linhas[1].includes("✗ limite five_hour atingido fatal: segunda linha \\| com barra"), "quebra de linha e | não desmontam a tabela");
  assert.ok(linhas[2].includes(`Tarefa 2 (tentativa 2) | ${q(5000)} | ${q(5500)} |`) && linhas[2].includes("✓ concluída"));

  // o resumo conta o lote desde a primeira execução, e soma todas as tentativas
  assert.ok(md.includes(`(de ${q(1000)} a ${q(5500)})`));
  assert.match(md, /\| Tempo de execução somado \| 11m \|/);
  // e a seção da tarefa mostra a execução que valeu
  assert.ok(md.includes(`Início ${q(5000)} · fim ${q(5500)} · 8m (2ª tentativa)`));
});
