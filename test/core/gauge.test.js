"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { core, tmpEnv, writeTranscript, writeHistory } = require("../helpers");

const SEMANA = 7 * 86400;
const now = Math.floor(Date.now() / 1000);

/**
 * Um milhão de tokens de entrada, no sonnet, pesa exatamente 1.000.000 na
 * conta ponderada (input = 1, sonnet = 1). Isso deixa o fator esperado óbvio.
 */
function umMilhao(id, ts) {
  return { id, ts, input: 1_000_000 };
}

test("calibração: dois snapshots e os tokens entre eles viram pontos por milhão", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const reset = now + 3 * 86400;
  writeHistory(env.home, [
    { ts: now - 7200, source: "statusline", seven_day: { pct: 10, resetsAt: reset } },
    { ts: now - 3600, source: "statusline", seven_day: { pct: 20, resetsAt: reset } },
  ]);
  // 5 milhões de tokens ponderados entre os dois snapshots, para 10 pontos
  writeTranscript(env.claudeDir, "a", [
    umMilhao("m1", now - 7000),
    umMilhao("m2", now - 6000),
    umMilhao("m3", now - 5000),
    umMilhao("m4", now - 4500),
    umMilhao("m5", now - 3700),
  ]);

  const g = core.computeGauge(env.cfg(), now);
  assert.strictEqual(g.seven_day.factor, 2, "10 pontos por 5 milhões = 2 pp/Mtok");
  assert.strictEqual(g.seven_day.samples, 1);
  assert.strictEqual(g.seven_day.confidence, "calibrated");
  assert.strictEqual(g.seven_day.pct, 20, "sem consumo depois do snapshot, fica na leitura");
});

test("a mesma resposta contada duas vezes não infla o consumo", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const reset = now + 3 * 86400;
  writeHistory(env.home, [
    { ts: now - 7200, source: "statusline", seven_day: { pct: 10, resetsAt: reset } },
    { ts: now - 3600, source: "statusline", seven_day: { pct: 20, resetsAt: reset } },
  ]);
  const linhas = [
    umMilhao("m1", now - 7000),
    umMilhao("m2", now - 6000),
    umMilhao("m3", now - 5000),
    umMilhao("m4", now - 4500),
    umMilhao("m5", now - 3700),
  ];
  // o Claude Code grava uma linha por bloco de conteúdo: mesmo id, mesmo requestId
  writeTranscript(env.claudeDir, "a", [...linhas, linhas[0], linhas[1]]);
  // e o modelo interno não consome cota
  writeTranscript(env.claudeDir, "a", [{ id: "s1", ts: now - 5500, input: 50_000_000, model: "<synthetic>" }]);

  const g = core.computeGauge(env.cfg(), now);
  assert.strictEqual(g.seven_day.factor, 2, "duplicatas e <synthetic> não entram na conta");
});

test("estimativa: o consumo depois do último snapshot é somado à leitura", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const reset = now + 3 * 86400;
  writeHistory(env.home, [
    { ts: now - 7200, source: "statusline", seven_day: { pct: 10, resetsAt: reset } },
    { ts: now - 3600, source: "statusline", seven_day: { pct: 20, resetsAt: reset } },
  ]);
  writeTranscript(env.claudeDir, "a", [
    umMilhao("m1", now - 7000),
    umMilhao("m2", now - 6000),
    umMilhao("m3", now - 5000),
    umMilhao("m4", now - 4500),
    umMilhao("m5", now - 3700),
    // 1 milhão depois do snapshot: 2 pontos a mais, estimados
    umMilhao("depois", now - 1800),
  ]);

  const g = core.computeGauge(env.cfg(), now);
  assert.strictEqual(g.seven_day.factor, 2);
  assert.strictEqual(g.seven_day.pct, 22);
  assert.strictEqual(g.seven_day.weightedSinceSnapshot, 1_000_000);
});

test("virada de janela: a estimativa recomeça do zero no reset, não na última leitura", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  // janela que já virou: o reset ficou para trás
  const resetVelho = now - 3600;
  writeHistory(env.home, [
    { ts: now - 14400, source: "statusline", seven_day: { pct: 10, resetsAt: resetVelho } },
    { ts: now - 10800, source: "statusline", seven_day: { pct: 20, resetsAt: resetVelho } },
  ]);
  writeTranscript(env.claudeDir, "a", [
    umMilhao("m1", now - 14000),
    umMilhao("m2", now - 13000),
    umMilhao("m3", now - 12000),
    umMilhao("m4", now - 11500),
    umMilhao("m5", now - 11000),
    // consumo já na janela nova
    umMilhao("novo", now - 1800),
  ]);

  const g = core.computeGauge(env.cfg(), now);
  assert.strictEqual(g.seven_day.factor, 2, "a calibração sobrevive à virada");
  assert.strictEqual(g.seven_day.pct, 2, "0% no reset + 1 Mtok x 2 pp");
  assert.strictEqual(g.seven_day.resetsAt, resetVelho + SEMANA, "o próximo reset é uma semana adiante");
});

test("sem duas leituras não há calibração, e o medidor envelhece", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  writeHistory(env.home, [
    { ts: now - 4 * 3600, source: "statusline", seven_day: { pct: 30, resetsAt: now + 86400 } },
  ]);
  const g = core.computeGauge(env.cfg(), now);
  assert.strictEqual(g.seven_day.factor, null);
  assert.strictEqual(g.seven_day.pct, 30, "sem fator, repete a leitura crua");
  assert.strictEqual(g.seven_day.confidence, "stale", "4h passa dos 180 min padrão");
});

test("entre duas leituras, uma diferença menor que 2 pontos é ruído", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const reset = now + 3 * 86400;
  const historia = [
    { ts: now - 7200, source: "statusline", seven_day: { pct: 10, resetsAt: reset } },
    { ts: now - 3600, source: "statusline", seven_day: { pct: 11, resetsAt: reset } },
  ];
  writeHistory(env.home, historia);
  writeTranscript(env.claudeDir, "a", [umMilhao("m1", now - 5000)]);

  // o par não vira amostra: 1 ponto de diferença é ruído de arredondamento
  const eventos = core.loadUsageEvents(env.cfg(), now - 8 * 86400);
  const porPares = core.calibrate(historia, "seven_day", eventos);
  assert.strictEqual(porPares.factor, null);
  assert.strictEqual(porPares.samples, 0);

  // e sem par não há fator: o número fica na leitura crua
  assert.strictEqual(core.computeGauge(env.cfg(), now).seven_day.factor, null);
});

test("os pesos por tipo de token e por modelo entram na conta", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const reset = now + 3 * 86400;
  writeHistory(env.home, [
    { ts: now - 7200, source: "statusline", seven_day: { pct: 10, resetsAt: reset } },
    { ts: now - 3600, source: "statusline", seven_day: { pct: 20, resetsAt: reset } },
  ]);
  // 1M saída no opus: 1M x 5 (output) x 1.67 (opus) = 8.35M ponderados
  writeTranscript(env.claudeDir, "a", [
    { id: "o1", ts: now - 5000, output: 1_000_000, model: "claude-opus-5" },
  ]);

  const g = core.computeGauge(env.cfg(), now);
  assert.ok(Math.abs(g.seven_day.factor - 10 / 8.35) < 1e-9, `fator inesperado: ${g.seven_day.factor}`);
});

test("o cache de transcripts não segura consumo novo", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const reset = now + 3 * 86400;
  writeHistory(env.home, [
    { ts: now - 7200, source: "statusline", seven_day: { pct: 10, resetsAt: reset } },
    { ts: now - 3600, source: "statusline", seven_day: { pct: 20, resetsAt: reset } },
  ]);
  writeTranscript(env.claudeDir, "a", [
    umMilhao("m1", now - 7000),
    umMilhao("m2", now - 6000),
    umMilhao("m3", now - 5000),
    umMilhao("m4", now - 4500),
    umMilhao("m5", now - 3700),
  ]);

  assert.strictEqual(core.computeGauge(env.cfg(), now).seven_day.pct, 20);

  // uma sessão do painel do VS Code acabou de gastar 1 Mtok, no mesmo arquivo
  writeTranscript(env.claudeDir, "a", [umMilhao("depois", now - 60)]);

  const g = core.computeGauge(env.cfg(), now);
  assert.strictEqual(g.seven_day.pct, 22, "a releitura enxerga o consumo novo");
  assert.strictEqual(g.seven_day.weightedSinceSnapshot, 1_000_000);
});

test("a virada de janela fica marcada, para a tela não chamar o piso de medição", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  // uma leitura só, de uma janela que já virou: sem calibração, pct vai a zero
  writeHistory(env.home, [
    { ts: now - 7200, source: "statusline", five_hour: { pct: 91, resetsAt: now - 3600 } },
  ]);
  writeTranscript(env.claudeDir, "a", [umMilhao("depois", now - 1800)]);

  const g = core.computeGauge(env.cfg(), now);
  assert.strictEqual(g.five_hour.rolledOver, true);
  assert.strictEqual(g.five_hour.pct, 0, "a base zera no reset");
  assert.strictEqual(g.five_hour.factor, null, "e não há fator para converter o consumo");
  assert.strictEqual(
    g.five_hour.weightedSinceSnapshot,
    1_000_000,
    "mas o consumo foi medido: é isso que a tela precisa mostrar para o 0% não enganar"
  );
});

test("janela que não virou não é marcada", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  writeHistory(env.home, [
    { ts: now - 600, source: "statusline", five_hour: { pct: 30, resetsAt: now + 3600 } },
  ]);
  assert.strictEqual(core.computeGauge(env.cfg(), now).five_hour.rolledOver, false);
});





