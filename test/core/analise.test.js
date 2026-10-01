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
