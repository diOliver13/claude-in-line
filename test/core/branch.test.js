"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { core } = require("../helpers");

const dia = new Date(2026, 8, 29, 20, 53); // 29/09/2026, 20:53
const tarefa = (title) => ({ id: "20260929-205300-x", title });

test("o modelo padrão agrupa por pasta e por dia", () => {
  const nome = core.nomeDaBranch(
    tarefa("Acme: regime inválido na listagem devolve 400"),
    "acme",
    "Dev_Branches/{data}/{slug}",
    dia
  );
  assert.strictEqual(nome, "Dev_Branches/2026-09-29/acme-regime-invalido-na-listagem-devolve-400");
});

test("todos os marcadores são substituídos", () => {
  const nome = core.nomeDaBranch(tarefa("Corrigir filtro"), "Acme", "{repo}/{data}/{hora}-{slug}", dia);
  assert.strictEqual(nome, "acme/2026-09-29/2053-corrigir-filtro");
});

test("o id continua disponível para quem quiser o formato antigo", () => {
  assert.strictEqual(core.nomeDaBranch(tarefa("Qualquer"), "r", "cq/{id}", dia), "cq/20260929-205300-x");
});

test("acento e pontuação saem do nome", () => {
  const nome = core.nomeDaBranch(tarefa("Validação: não aceitar data futura!"), "r", "{slug}", dia);
  assert.strictEqual(nome, "validacao-nao-aceitar-data-futura");
});

test("o que o git recusa é limpo antes de virar branch", () => {
  // espaço, til, circunflexo, dois-pontos, interrogação, asterisco, colchete e barra invertida
  assert.strictEqual(core.sanitizarRef("tem espaco"), "tem-espaco");
  assert.strictEqual(core.sanitizarRef("a~b^c:d?e*f[g]h"), "a-b-c-d-e-f-g-h");

  // sequências que o git proíbe
  assert.strictEqual(core.sanitizarRef("a..b"), "a.b");
  assert.strictEqual(core.sanitizarRef("ref@{1}"), "ref-1}");

  // nível não pode começar com ponto nem terminar com ponto ou .lock
  assert.strictEqual(core.sanitizarRef(".oculto"), "oculto");
  assert.strictEqual(core.sanitizarRef("fim."), "fim");
  assert.strictEqual(core.sanitizarRef("algo.lock"), "algolock");

  // nível vazio some, e a barra final também
  assert.strictEqual(core.sanitizarRef("a//b"), "a/b");
  assert.strictEqual(core.sanitizarRef("termina/"), "termina");

  // nome que sobraria vazio ainda dá uma branch válida
  assert.strictEqual(core.sanitizarRef("///"), "tarefa");
  assert.strictEqual(core.sanitizarRef("..."), "tarefa");
});

test("um modelo com data em barras não quebra, mas vira hierarquia", () => {
  // é por isso que o padrão usa 2026-09-29 e não 29/09/26:
  // com barras, cada pedaço da data vira um nível de pasta no git
  const nome = core.nomeDaBranch(tarefa("Teste"), "acme", "Dev_Branches/{repo}-29/09/26", dia);
  assert.strictEqual(nome, "Dev_Branches/acme-29/09/26");
  assert.strictEqual(nome.split("/").length, 4, "quatro níveis, e o git não deixa coexistir pasta e branch de mesmo nome");
});

test("slug longo é cortado sem deixar traço solto no fim", () => {
  const titulo = "Uma tarefa com um titulo absurdamente longo que passa do limite estabelecido";
  const nome = core.nomeDaBranch(tarefa(titulo), "r", "{slug}", dia);
  assert.ok(nome.length <= 60, `passou do limite: ${nome.length}`);
  assert.doesNotMatch(nome, /-$/, "não termina em traço");
});
