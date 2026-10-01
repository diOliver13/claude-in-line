"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { core } = require("../helpers");

const dir = path.resolve("/tmp/cq/worktrees/repo-tarefa");

test("foraDaWorktree: relativo e absoluto dentro são dentro", () => {
  assert.strictEqual(core.foraDaWorktree(dir, "docs/guia.md"), false);
  assert.strictEqual(core.foraDaWorktree(dir, path.join(dir, "docs", "guia.md")), false);
  assert.strictEqual(core.foraDaWorktree(dir, dir), false);
});

test("foraDaWorktree: pasta vizinha com nome parecido é fora", () => {
  // o erro de 29/09: a pasta certa era "...-colocar-o-", a gravada era "...-colocar-o-site-no-google"
  assert.strictEqual(core.foraDaWorktree(dir, `${dir}-site-no-google${path.sep}docs${path.sep}guia.md`), true);
  assert.strictEqual(core.foraDaWorktree(dir, "../outra/arquivo.md"), true);
  assert.strictEqual(core.foraDaWorktree(dir, path.resolve("/etc/passwd")), true);
});

test("foraDaWorktree: no Windows, caminho do Git Bash e maiúsculas não enganam", { skip: process.platform !== "win32" }, () => {
  const win = "D:\\dados\\cq\\worktrees\\repo-tarefa";
  assert.strictEqual(core.foraDaWorktree(win, "/d/dados/cq/worktrees/repo-tarefa/a.txt"), false);
  assert.strictEqual(core.foraDaWorktree(win, "d:\\DADOS\\cq\\worktrees\\repo-tarefa\\a.txt"), false);
  assert.strictEqual(core.foraDaWorktree(win, "/c/Users/alguem/a.txt"), true);
});

test("nomeDoLote: grafias diferentes do mesmo nome são o mesmo lote", () => {
  assert.strictEqual(core.nomeDoLote("Site Acme"), "site-acme");
  assert.strictEqual(core.nomeDoLote("site  acme "), "site-acme");
  assert.strictEqual(core.nomeDoLote("Página Inicial"), "pagina-inicial");
});

test("podeRodar: fora de lote sempre; no lote, só a primeira pendente", () => {
  const t = (id, lote, ordem) => ({ id, lote, ordem, created: ordem });
  const pendentes = [t("x", null, 0), t("b", "l-sem-arquivo", 2), t("a", "l-sem-arquivo", 1)];
  assert.strictEqual(core.podeRodar(pendentes[0], pendentes), true);
  assert.strictEqual(core.podeRodar(pendentes[2], pendentes), true, "a de ordem 1");
  assert.strictEqual(core.podeRodar(pendentes[1], pendentes), false, "a de ordem 2 espera");
});
