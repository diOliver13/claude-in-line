"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { core, tmpEnv } = require("../helpers");

function escreveTarefa(env, nome, conteudo) {
  const file = path.join(env.home, "queue", nome);
  fs.writeFileSync(file, conteudo);
  return file;
}

test("frontmatter: aceita CRLF, aspas e ignora o que não for chave: valor", () => {
  const { meta, body } = core.parseFrontmatter(
    '---\r\ntitle: "Validação no endpoint"\r\nrepo: D:/dev/x\r\npriority: 1\r\nisto nao e chave\r\n---\r\n\r\nCorpo da tarefa.\r\nSegunda linha.\r\n'
  );
  assert.strictEqual(meta.title, "Validação no endpoint", "as aspas saem");
  assert.strictEqual(meta.repo, "D:/dev/x");
  assert.strictEqual(meta.priority, "1");
  assert.strictEqual(meta.isto, undefined);
  assert.strictEqual(body, "Corpo da tarefa.\nSegunda linha.");
});

test("frontmatter: texto sem bloco vira corpo inteiro", () => {
  const { meta, body } = core.parseFrontmatter("Só o corpo, sem frontmatter.");
  assert.deepStrictEqual(meta, {});
  assert.strictEqual(body, "Só o corpo, sem frontmatter.");
});

test("ida e volta do frontmatter não perde nada", () => {
  const texto = core.renderFrontmatter({ title: "X", repo: "D:/dev/x", vazio: "" }, "corpo");
  const { meta, body } = core.parseFrontmatter(texto);
  assert.strictEqual(meta.title, "X");
  assert.strictEqual(meta.vazio, undefined, "campo vazio não é escrito");
  assert.strictEqual(body, "corpo");
});

test("allowedTools: a vírgula dentro dos parênteses não separa ferramenta", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const file = escreveTarefa(
    env,
    "t1.md",
    "---\ntitle: Com ferramentas\nrepo: D:/dev/x\nallowedTools: Read, Edit, Bash(mvn -q test -Dtest=A,B:*), Bash(git log --oneline -n 5:*)\n---\n\nFaça algo.\n"
  );
  const t1 = core.readTask(file, "queued", env.cfg());
  assert.deepStrictEqual(t1.allowedTools, [
    "Read",
    "Edit",
    "Bash(mvn -q test -Dtest=A,B:*)",
    "Bash(git log --oneline -n 5:*)",
  ]);
});

test("anexos: lê 'de -> para' separados por vírgula, e tarefa sem o campo vem vazia", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const comAnexos = escreveTarefa(
    env,
    "t-anexos.md",
    "---\ntitle: Com anexos\nrepo: D:/dev/x\nanexos: D:/materiais/logo.svg -> frontend/src/logo.svg, D:/materiais/telas -> frontend/public/site\n---\n\nFaça algo.\n"
  );
  const t1 = core.readTask(comAnexos, "queued", env.cfg());
  assert.deepStrictEqual(t1.anexos, [
    { de: "D:/materiais/logo.svg", para: "frontend/src/logo.svg" },
    { de: "D:/materiais/telas", para: "frontend/public/site" },
  ]);

  const semAnexos = escreveTarefa(env, "t-sem-anexos.md", "---\ntitle: Sem anexos\nrepo: D:/dev/x\n---\n\nFaça algo.\n");
  const t2 = core.readTask(semAnexos, "queued", env.cfg());
  assert.deepStrictEqual(t2.anexos, []);
});

test("anexos: addTask escreve no formato que readTask entende de volta", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const id = core.addTask({
    title: "Tarefa com anexo",
    repo: "D:/dev/x",
    prompt: "Faça algo.",
    anexos: [{ de: "D:/materiais/icone.png", para: "frontend/public/icone.png" }],
  });
  const t1 = core.readTask(path.join(env.home, "queue", `${id}.md`), "queued", env.cfg());
  assert.deepStrictEqual(t1.anexos, [{ de: "D:/materiais/icone.png", para: "frontend/public/icone.png" }]);
});

test("sugerirMaxTurns: objetivo pequeno fica no padrão, sem motivo", () => {
  const r = core.sugerirMaxTurns("Valide o campo X e devolva 400 em erro.", ["a.java", "b.java"], 40);
  assert.strictEqual(r.maxTurns, 40);
  assert.strictEqual(r.motivo, null);
});

test("sugerirMaxTurns: mais de 6 passos numerados sobe o teto, mesmo com poucos arquivos", () => {
  const objetivo = Array.from({ length: 7 }, (_, i) => `${i + 1}. Passo ${i + 1}.`).join("\n");
  const r = core.sugerirMaxTurns(objetivo, ["a.java"], 40);
  assert.strictEqual(r.maxTurns, 70);
  assert.match(r.motivo, /7 passo/);
});

test("sugerirMaxTurns: mais de 8 arquivos sobe o teto, mesmo sem passo numerado", () => {
  const arquivos = Array.from({ length: 9 }, (_, i) => `arquivo${i}.java`);
  const r = core.sugerirMaxTurns("Objetivo sem lista numerada.", arquivos, 40);
  assert.strictEqual(r.maxTurns, 70);
  assert.match(r.motivo, /9 arquivo/);
});

test("sugerirMaxTurns: nunca sugere menos que o padrão configurado", () => {
  const objetivo = Array.from({ length: 7 }, (_, i) => `${i + 1}. Passo ${i + 1}.`).join("\n");
  const r = core.sugerirMaxTurns(objetivo, [], 90);
  assert.strictEqual(r.maxTurns, 90, "padrão já maior que a sugestão fixa de 70 não deve regredir");
});

test("o que a tarefa não disser vem dos padrões", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const file = escreveTarefa(env, "t2.md", "---\ntitle: Mínima\nrepo: D:/dev/x\n---\n\nFaça algo.\n");
  const cfg = env.cfg({ defaults: { model: "opus", maxTurns: 7, timeoutMin: 9, allowedTools: ["Read"] } });
  const t2 = core.readTask(file, "queued", cfg);

  assert.strictEqual(t2.model, "opus");
  assert.strictEqual(t2.maxTurns, 7);
  assert.strictEqual(t2.timeoutMin, 9);
  assert.deepStrictEqual(t2.allowedTools, ["Read"]);
  assert.strictEqual(t2.priority, 3);
  assert.strictEqual(t2.base, null);
  assert.strictEqual(t2.id, "t2");
});

test("a fila sai por prioridade e, empatando, pela ordem de chegada", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const corpo = (p, criado) =>
    `---\ntitle: p${p}-${criado}\nrepo: D:/dev/x\npriority: ${p}\ncreated: ${criado}\n---\n\nFaça algo.\n`;
  escreveTarefa(env, "c.md", corpo(3, 100));
  escreveTarefa(env, "a.md", corpo(1, 300));
  escreveTarefa(env, "b.md", corpo(1, 200));

  const titulos = core.listTasks(env.cfg(), "queued").map((t) => t.title);
  assert.deepStrictEqual(titulos, ["p1-200", "p1-300", "p3-100"]);
});

test("arquivo sem repo ou sem corpo não entra na fila, mas é apontado", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  escreveTarefa(env, "sem-repo.md", "---\ntitle: Sem repo\n---\n\nCorpo.\n");
  escreveTarefa(env, "sem-corpo.md", "---\ntitle: Sem corpo\nrepo: D:/dev/x\n---\n\n");
  escreveTarefa(env, "boa.md", "---\ntitle: Boa\nrepo: D:/dev/x\n---\n\nCorpo.\n");

  assert.strictEqual(core.listTasks(env.cfg(), "queued").length, 1);
  assert.deepStrictEqual(core.invalidQueueFiles(env.cfg()).sort(), ["sem-corpo.md", "sem-repo.md"]);
});

test("mover a tarefa entre fila, concluídas e com falha leva o arquivo junto", (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  const id = core.addTask({ title: "Mudar de pasta", repo: "D:/dev/x", prompt: "Faça algo." });
  const tarefa = core.listTasks(env.cfg(), "queued")[0];
  assert.strictEqual(tarefa.id, id);

  core.moveTask(tarefa, "failed");
  assert.strictEqual(core.listTasks(env.cfg(), "queued").length, 0);
  assert.strictEqual(core.listTasks(env.cfg(), "failed").length, 1);
  assert.ok(fs.existsSync(path.join(env.home, "failed", `${id}.md`)));

  core.moveTask(tarefa, "queued");
  assert.strictEqual(core.listTasks(env.cfg(), "queued").length, 1);
});

test("o id carrega data e título, e sobrevive a acento e pontuação", () => {
  const id = core.slugId("Validação: preço não pode ser negativo!");
  assert.match(id, /^\d{8}-\d{6}-validacao-preco-nao-pode-ser-negativo$/);
});

test("a versão mais nova da extensão do Claude Code vem primeiro", () => {
  const nomes = [
    "anthropic.claude-code-2.1.9-win32-x64",
    "anthropic.claude-code-2.1.283-win32-x64",
    "anthropic.claude-code-2.0.100-win32-x64",
    "anthropic.claude-code-10.0.1-win32-x64",
  ];
  assert.deepStrictEqual(core.ordenarPorVersao(nomes), [
    "anthropic.claude-code-10.0.1-win32-x64",
    "anthropic.claude-code-2.1.283-win32-x64",
    "anthropic.claude-code-2.1.9-win32-x64",
    "anthropic.claude-code-2.0.100-win32-x64",
  ]);
});

test("o executável do painel é encontrado quando o PATH não tem claude", () => {
  // Na máquina de quem só usa o painel, o PATH não tem `claude`. Se este teste
  // achar zero candidatos, a fila não roda tarefa nenhuma aqui.
  const achados = core.candidatosDoClaude();
  for (const c of achados) assert.ok(require("fs").existsSync(c), `candidato inexistente: ${c}`);
});
