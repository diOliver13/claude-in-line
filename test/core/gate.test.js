"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { core, tmpEnv, writeJson } = require("../helpers");

const now = Math.floor(Date.now() / 1000);
const inicioDoDia = (() => {
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
})();
// Reset exatamente daqui a 5 dias: assim "dias até o reset" é 5, sem arredondamento.
const resetSemanal = inicioDoDia + 5 * 86400;

/** Uma leitura recente de semana, sem histórico: leitura direta, sem calibração. */
function leituraDaSemana(env, pct) {
  writeJson(path.join(env.home, "usage.json"), {
    ts: now,
    source: "statusline",
    seven_day: { pct, resetsAt: resetSemanal },
  });
}

function baseDoDia(env, pct) {
  writeJson(path.join(env.home, "state.json"), {
    day: core.localDay(new Date(now * 1000)),
    dayStartWeekPct: pct,
    dayWeekResetsAt: resetSemanal,
  });
}

test("orçamento dinâmico: o que sobra da semana dividido pelos dias até o reset", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 15);
  baseDoDia(env, 10);

  const d = core.evaluate(env.cfg(), now);
  // teto 75 (100 - reserva 25), menos os 10 do início do dia, em 5 dias
  assert.strictEqual(d.dailyCap, 13);
  assert.strictEqual(d.usedToday, 5);
  assert.strictEqual(d.weekCeiling, 75);
  assert.deepStrictEqual(d.reasons, []);
  assert.strictEqual(d.ok, true);
});

test("orçamento dinâmico: gastar o do dia segura a fila", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 30);
  baseDoDia(env, 10);

  const d = core.evaluate(env.cfg(), now);
  assert.strictEqual(d.usedToday, 20);
  assert.strictEqual(d.ok, false);
  assert.match(d.reasons.join(" "), /orçamento de hoje esgotado/);
});

test("o uso manual conta: ele entra no mesmo orçamento do dia", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  // ninguém rodou tarefa nenhuma, mas a semana subiu 20 pontos desde a virada do dia
  leituraDaSemana(env, 30);
  baseDoDia(env, 10);

  const d = core.evaluate(env.cfg(), now);
  assert.strictEqual(d.usedToday, 20, "a conta é sobre a janela semanal, não sobre o que a fila gastou");
  assert.strictEqual(d.ok, false);
});

test("orçamento fixo: usa o percentual configurado, sem dividir por dia nenhum", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 30);
  baseDoDia(env, 25);

  const d = core.evaluate(env.cfg({ dailyBudget: { mode: "fixed", fixedPct: 15 } }), now);
  assert.strictEqual(d.dailyCap, 15);
  assert.strictEqual(d.usedToday, 5);
  assert.strictEqual(d.ok, true);
});

test("a reserva é intocável: acima do teto semanal a fila para", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 80);
  baseDoDia(env, 80);

  const d = core.evaluate(env.cfg(), now);
  assert.strictEqual(d.ok, false);
  assert.match(d.reasons.join(" "), /teto da fila é 75%/);
});

test("a janela de 5h é um freio de vazão independente do orçamento", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  writeJson(path.join(env.home, "usage.json"), {
    ts: now,
    source: "statusline",
    seven_day: { pct: 15, resetsAt: resetSemanal },
    five_hour: { pct: 70, resetsAt: now + 3600 },
  });
  baseDoDia(env, 10);

  const d = core.evaluate(env.cfg(), now);
  assert.strictEqual(d.ok, false, "sobra orçamento na semana, mas a vazão de 5h estourou");
  assert.match(d.reasons.join(" "), /janela de 5h em 70\.0%/);
  assert.strictEqual(d.dailyCap, 13, "o orçamento do dia continua intacto");
});

test("freio: enquanto durar, nada roda", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 15);
  baseDoDia(env, 10);
  core.setBrake(now + 3600, "aviso de proximidade do limite seven_day");

  const d = core.evaluate(env.cfg(), now);
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.reasons.length, 1, "o freio é o único motivo");
  assert.match(d.reasons[0], /pausado por 1h00m: aviso de proximidade/);
});

test("freio: um aviso curto não encurta uma pausa longa já ativa", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  core.setBrake(now + 6 * 3600, "recusa por seven_day");
  core.setBrake(now + 60, "aviso qualquer");

  assert.strictEqual(core.loadState().brake.until, now + 6 * 3600);
  assert.strictEqual(core.loadState().brake.reason, "recusa por seven_day");
});

test("freio vencido deixa a fila seguir", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 15);
  baseDoDia(env, 10);
  core.setBrake(now - 10, "já passou");

  assert.strictEqual(core.evaluate(env.cfg(), now).ok, true);
});

test("fora do horário permitido a fila espera", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 15);
  baseDoDia(env, 10);
  const h = new Date(now * 1000).getHours();

  const dentro = core.evaluate(env.cfg({ allowedHours: [[h, h + 1]] }), now);
  assert.strictEqual(dentro.ok, true);

  const faixaDeFora = h < 23 ? [[h + 1, h + 2]] : [[0, 1]];
  const fora = core.evaluate(env.cfg({ allowedHours: faixaDeFora }), now);
  assert.strictEqual(fora.ok, false);
  assert.match(fora.reasons.join(" "), /fora do horário permitido/);
});

test("ajuste de hoje troca o horário permitido, sem depender do geral", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 15);
  baseDoDia(env, 10);
  const hoje = new Date(now * 1000).getDay();
  const h = new Date(now * 1000).getHours();

  const ajustes = () => [null, null, null, null, null, null, null];

  // geral proíbe a hora atual, mas o ajuste de hoje libera
  const dentro = ajustes();
  dentro[hoje] = { horas: [[h, h + 1]], pctDia: null };
  const faixaDeFora = h < 23 ? [[h + 1, h + 2]] : [[0, 1]];
  assert.strictEqual(
    core.evaluate(env.cfg({ allowedHours: faixaDeFora, weekdayOverrides: dentro }), now).ok,
    true
  );

  // o inverso: geral libera, mas o ajuste de hoje proíbe
  const fora = ajustes();
  fora[hoje] = { horas: faixaDeFora, pctDia: null };
  const d = core.evaluate(env.cfg({ allowedHours: [[h, h + 1]], weekdayOverrides: fora }), now);
  assert.strictEqual(d.ok, false);
  assert.match(d.reasons.join(" "), /fora do horário permitido/);
});

test("ajuste de hoje troca o orçamento do dia pelo valor fixo dele, sem calcular o dinâmico", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 14);
  baseDoDia(env, 10);
  const hoje = new Date(now * 1000).getDay();
  const ajustes = [null, null, null, null, null, null, null];
  ajustes[hoje] = { horas: null, pctDia: 5 };

  const d = core.evaluate(env.cfg({ weekdayOverrides: ajustes }), now);
  assert.strictEqual(d.dailyCap, 5, "usou o pctDia do dia, não a fórmula dinâmica (que daria 13)");
  assert.strictEqual(d.usedToday, 4);
  assert.strictEqual(d.ok, true);

  // gastando mais que o teto do dia, o porteiro segura mesmo sobrando semana
  leituraDaSemana(env, 16);
  const esgotado = core.evaluate(env.cfg({ weekdayOverrides: ajustes }), now);
  assert.strictEqual(esgotado.ok, false);
  assert.match(esgotado.reasons.join(" "), /orçamento de hoje esgotado/);
});

test("ajuste noutro dia da semana não muda nada em hoje", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 15);
  baseDoDia(env, 10);
  const outroDia = (new Date(now * 1000).getDay() + 1) % 7;
  const ajustes = [null, null, null, null, null, null, null];
  ajustes[outroDia] = { horas: [[0, 1]], pctDia: 1 };

  const semAjuste = core.evaluate(env.cfg(), now);
  const comAjusteNoutroDia = core.evaluate(env.cfg({ weekdayOverrides: ajustes }), now);
  assert.deepStrictEqual(comAjusteNoutroDia, semAjuste);
});

test("sem leitura nenhuma, o porteiro manda rodar o claude no terminal", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const d = core.evaluate(env.cfg(), now);
  assert.strictEqual(d.ok, false);
  assert.match(d.reasons.join(" "), /sem leitura de uso ainda/);
});

test("a conta do orçamento é a mesma para o porteiro e para a tela", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  leituraDaSemana(env, 15);
  baseDoDia(env, 10);

  // a tela chama dailyBudget direto, com valores que você ainda não salvou
  const cfg = env.cfg();
  assert.strictEqual(core.dailyBudget(cfg, 10, resetSemanal, now), 13);
  assert.strictEqual(core.evaluate(cfg, now).dailyCap, 13, "o porteiro chega ao mesmo número");

  // mexer na reserva muda o teto, e o dia inteiro junto
  const maisFolgado = env.cfg({ reservePct: 10 });
  assert.strictEqual(core.dailyBudget(maisFolgado, 10, resetSemanal, now), 16);

  // no modo fixo, os dias até o reset não entram na conta
  const fixo = env.cfg({ dailyBudget: { mode: "fixed", fixedPct: 15 } });
  assert.strictEqual(core.dailyBudget(fixo, 10, resetSemanal, now), 15);
  assert.strictEqual(core.dailyBudget(fixo, 70, null, now), 15);
});

test("orçamento nunca fica negativo, mesmo estourando o teto", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());
  assert.strictEqual(core.dailyBudget(env.cfg(), 90, resetSemanal, now), 0);
});
