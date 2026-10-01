"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { core, tmpEnv, writeHistory, writeJson } = require("../helpers");

const now = Math.floor(Date.now() / 1000);

/** O estado do Claude Code fica ao lado da pasta de configuração, não dentro. */
function escreverEstado(env, dados) {
  writeJson(env.claudeDir + ".json", dados);
}

const estadoCom = (cinco, sete, buscadoEmMs) => ({
  numStartups: 7,
  cachedUsageUtilization: {
    fetchedAtMs: buscadoEmMs,
    accountUuid: "b2887292-0000-0000-0000-000000000000",
    utilization: {
      five_hour: { utilization: cinco, resets_at: new Date((now + 2 * 3600) * 1000).toISOString() },
      seven_day: { utilization: sete, resets_at: new Date((now + 2 * 86400) * 1000).toISOString() },
      extra_usage: { utilization: null },
    },
  },
});

test("o percentual oficial do painel vira leitura do medidor", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  escreverEstado(env, estadoCom(42, 46, now * 1000));

  const g = core.computeGauge(env.cfg(), now);
  assert.strictEqual(g.five_hour.pct, 42, "sem terminal, sem statusline, sem estimativa");
  assert.strictEqual(g.seven_day.pct, 46);
  assert.strictEqual(g.five_hour.resetsAt, now + 2 * 3600);
  assert.strictEqual(g.seven_day.known, true);
});

test("a leitura oficial é gravada no histórico, e é ela que calibra", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  escreverEstado(env, estadoCom(42, 46, now * 1000));
  core.computeGauge(env.cfg(), now);

  const historico = fs
    .readFileSync(path.join(env.home, "snapshots.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  assert.strictEqual(historico.length, 1);
  assert.strictEqual(historico[0].source, "claude-cache", "fica marcada de onde veio");
  assert.strictEqual(historico[0].five_hour.pct, 42);
});

test("a leitura mais nova ganha, venha de onde vier", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  // statusline antiga dizendo 10%, cache do painel dizendo 42% agora
  writeHistory(env.home, [
    { ts: now - 7200, source: "statusline", five_hour: { pct: 10, resetsAt: now + 2 * 3600 } },
  ]);
  escreverEstado(env, estadoCom(42, 46, now * 1000));

  assert.strictEqual(core.computeGauge(env.cfg(), now).five_hour.pct, 42);
});

test("estado ausente ou corrompido não derruba o medidor", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  // arquivo nenhum
  assert.strictEqual(core.lerCacheDoClaudeCode(env.cfg()), null);
  assert.strictEqual(core.computeGauge(env.cfg(), now).seven_day.known, false);

  // arquivo que não é JSON
  fs.writeFileSync(env.claudeDir + ".json", "{isto nao e json");
  assert.strictEqual(core.lerCacheDoClaudeCode(env.cfg()), null);

  // JSON válido, mas sem o campo que interessa
  writeJson(env.claudeDir + ".json", { numStartups: 3, projects: {} });
  assert.strictEqual(core.lerCacheDoClaudeCode(env.cfg()), null);

  // o campo existe mas veio vazio
  writeJson(env.claudeDir + ".json", { cachedUsageUtilization: { fetchedAtMs: now * 1000, utilization: {} } });
  assert.strictEqual(core.lerCacheDoClaudeCode(env.cfg()), null);
});

test("uma janela sem número não inventa leitura", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  writeJson(env.claudeDir + ".json", {
    cachedUsageUtilization: {
      fetchedAtMs: now * 1000,
      utilization: {
        five_hour: { utilization: 42, resets_at: null },
        seven_day: { utilization: null, resets_at: null },
      },
    },
  });

  const snap = core.lerCacheDoClaudeCode(env.cfg());
  assert.strictEqual(snap.five_hour.pct, 42);
  assert.strictEqual(snap.five_hour.resetsAt, null, "reset desconhecido é null, não zero");
  assert.strictEqual(snap.seven_day, undefined);
});

test("duas leituras oficiais calibram por par, que é o caminho confiável", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const reset5 = now + 2 * 3600;
  writeHistory(env.home, [
    { ts: now - 3600, source: "claude-cache", five_hour: { pct: 20, resetsAt: reset5 } },
    { ts: now - 1800, source: "claude-cache", five_hour: { pct: 30, resetsAt: reset5 } },
  ]);
  // 2 Mtok entre as duas leituras: 10 pontos por 2 Mtok = 5 pp/Mtok
  const { writeTranscript } = require("../helpers");
  writeTranscript(env.claudeDir, "a", [
    { id: "m1", ts: now - 3000, input: 1_000_000 },
    { id: "m2", ts: now - 2000, input: 1_000_000 },
  ]);

  const g = core.computeGauge(env.cfg(), now);
  assert.strictEqual(g.five_hour.factor, 5, "a janela de 5h agora calibra como a semana");
  assert.strictEqual(g.five_hour.confidence, "calibrated");
});

test("o cache não segura um valor novo", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  escreverEstado(env, estadoCom(42, 46, now * 1000));
  assert.strictEqual(core.lerCacheDoClaudeCode(env.cfg()).five_hour.pct, 42);

  // o painel buscou de novo, 5 minutos depois
  escreverEstado(env, estadoCom(47, 47, (now + 300) * 1000));
  assert.strictEqual(core.lerCacheDoClaudeCode(env.cfg()).five_hour.pct, 47);
});
