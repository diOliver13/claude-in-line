"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { core, tmpEnv } = require("../helpers");

const agora = () => Math.floor(Date.now() / 1000);
const usage = (env) => JSON.parse(fs.readFileSync(path.join(env.home, "usage.json"), "utf8"));

test("statusline: grava as duas janelas e devolve a linha curta", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const linha = core.handleStatusline(
    JSON.stringify({
      model: { display_name: "Opus" },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
    })
  );
  assert.strictEqual(linha, "[Opus] 5h 24% · 7d 41%");
  const u = usage(env);
  assert.strictEqual(u.five_hour.pct, 23.5);
  assert.strictEqual(u.seven_day.pct, 41.2);
});

test("resets_at: segundos, milissegundos e ISO chegam ao mesmo epoch", () => {
  assert.strictEqual(core.toEpochSec(1738425600), 1738425600);
  assert.strictEqual(core.toEpochSec(1738425600000), 1738425600);
  assert.strictEqual(core.toEpochSec("2025-02-01T16:00:00Z"), 1738425600);
  assert.strictEqual(core.toEpochSec("1738425600"), 1738425600);
  assert.strictEqual(core.toEpochSec("nao e data"), null);
  assert.strictEqual(core.toEpochSec(undefined), null);
});

test("uma janela ausente não apaga a leitura anterior, se ela ainda vale", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const futuro = agora() + 3600;
  core.handleStatusline(
    JSON.stringify({ rate_limits: { five_hour: { used_percentage: 20, resets_at: futuro }, seven_day: { used_percentage: 40, resets_at: futuro } } })
  );
  // a chamada seguinte só traz a semana
  core.handleStatusline(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 42, resets_at: futuro } } }));

  const u = usage(env);
  assert.strictEqual(u.seven_day.pct, 42);
  assert.strictEqual(u.five_hour.pct, 20, "a janela de 5h anterior ainda não virou, então continua valendo");
});

test("leitura vencida não é arrastada para a frente", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const passado = agora() - 10;
  core.handleStatusline(
    JSON.stringify({ rate_limits: { five_hour: { used_percentage: 90, resets_at: passado }, seven_day: { used_percentage: 40, resets_at: agora() + 3600 } } })
  );
  core.handleStatusline(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 41, resets_at: agora() + 3600 } } }));

  assert.strictEqual(usage(env).five_hour, undefined, "a janela de 5h já virou: sumiu em vez de mentir 90%");
});

test("statusline nunca quebra: entrada inválida ou sem limites ainda devolve linha", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  assert.strictEqual(core.handleStatusline("isto nao e json"), "cq");
  assert.strictEqual(core.handleStatusline("{}"), "sem dados de limite");
  assert.strictEqual(core.handleStatusline(JSON.stringify({ model: { display_name: "Sonnet" } })), "[Sonnet] sem dados de limite");
});

test("rate_limit_event com utilization vira snapshot; sem utilization, não", () => {
  const s = core.snapshotFromRateLimitEvent({ rateLimitType: "seven_day", resetsAt: 1738857600, status: "allowed_warning", utilization: 0.76 });
  assert.strictEqual(s.seven_day.pct, 76, "0.76 é fração, vira 76%");
  assert.strictEqual(s.seven_day.resetsAt, 1738857600);
  assert.strictEqual(s.source, "rate_limit_event");

  assert.strictEqual(core.snapshotFromRateLimitEvent({ rateLimitType: "seven_day", status: "rejected" }), null);
  assert.strictEqual(core.snapshotFromRateLimitEvent({ rateLimitType: "outra_coisa", utilization: 0.5 }), null);
});

test("o histórico não engorda a cada chamada da statusline", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const payload = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 40, resets_at: agora() + 3600 } } });
  for (let i = 0; i < 20; i++) core.handleStatusline(payload);

  const linhas = fs.readFileSync(path.join(env.home, "snapshots.jsonl"), "utf8").trim().split("\n");
  assert.strictEqual(linhas.length, 1, "a statusline roda a cada segundo; só mudança vira linha");
});
