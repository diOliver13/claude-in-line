"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { core, tmpEnv, writeJson } = require("../helpers");

const SERVIDOR = path.resolve(__dirname, "..", "..", "out", "mcp.js");

const now = Math.floor(Date.now() / 1000);
const inicioDoDia = (() => {
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
})();

function criarRepo(raiz) {
  const repo = path.join(raiz, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "teste@exemplo.local"]);
  git(["config", "user.name", "Teste"]);
  fs.writeFileSync(path.join(repo, "README.md"), "teste\n");
  git(["add", "-A"]);
  git(["commit", "-m", "inicial"]);
  return repo;
}

/**
 * Fala com o servidor do mesmo jeito que o Claude Code fala: uma linha de JSON
 * por mensagem, no stdin, e as respostas voltam pelo stdout.
 */
function abrirServidor(home, claudeDir) {
  const proc = spawn(process.execPath, [SERVIDOR], {
    // sem CLAUDE_CONFIG_DIR apontado para o temporário, o servidor leria o
    // ~/.claude.json de verdade e o teste passaria a depender da conta real
    env: { ...process.env, CQ_HOME: home, CLAUDE_CONFIG_DIR: claudeDir },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let buffer = "";
  const pendentes = new Map();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const linha = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!linha) continue;
      const m = JSON.parse(linha);
      const resolver = pendentes.get(m.id);
      if (resolver) {
        pendentes.delete(m.id);
        resolver(m);
      }
    }
  });

  let proximoId = 1;
  return {
    pedir(method, params) {
      const id = proximoId++;
      const espera = new Promise((r) => pendentes.set(id, r));
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return espera;
    },
    async chamar(name, args) {
      const r = await this.pedir("tools/call", { name, arguments: args || {} });
      return { texto: r.result.content[0].text, erro: !!r.result.isError };
    },
    fechar() {
      proc.stdin.end();
      proc.kill();
    },
  };
}

function medidorComFolga(home) {
  const resetSemanal = inicioDoDia + 5 * 86400;
  writeJson(path.join(home, "usage.json"), {
    ts: now,
    source: "statusline",
    seven_day: { pct: 15, resetsAt: resetSemanal },
    five_hour: { pct: 5, resetsAt: now + 3600 },
  });
  writeJson(path.join(home, "state.json"), {
    day: core.localDay(new Date(now * 1000)),
    dayStartWeekPct: 10,
    dayWeekResetsAt: resetSemanal,
  });
}

const tarefaCompleta = (repo) => ({
  titulo: "Validar o endpoint de lançamentos",
  repo,
  objetivo: "Validar valor maior que zero e data não futura, devolvendo 400 com mensagem clara.",
  arquivos: ["src/LancamentoController.java", "src/LancamentoControllerTest.java"],
  criterio_de_pronto: "Requisição inválida devolve 400 com a mensagem, e não 500. Há teste para os dois casos.",
  como_testar: "mvn -q test -Dtest=LancamentoControllerTest",
});

async function comServidor(t, fn) {
  const env = tmpEnv();
  const s = abrirServidor(env.home, env.claudeDir);
  t.after(() => {
    s.fechar();
    env.cleanup();
  });
  await s.pedir("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste" } });
  return fn(s, env);
}

test("o servidor se apresenta e lista as sete ferramentas", async (t) => {
  const env = tmpEnv();
  const s = abrirServidor(env.home, env.claudeDir);
  t.after(() => {
    s.fechar();
    env.cleanup();
  });

  const inicio = await s.pedir("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "teste", version: "1" },
  });
  assert.strictEqual(inicio.result.protocolVersion, "2025-06-18", "aceita a versão que o cliente pediu");
  assert.strictEqual(inicio.result.serverInfo.name, "claude-queue");
  assert.ok(inicio.result.capabilities.tools);

  const lista = await s.pedir("tools/list", {});
  const nomes = lista.result.tools.map((f) => f.name).sort();
  assert.deepStrictEqual(nomes, [
    "consultar_cota",
    "enfileirar_tarefa",
    "listar_fila",
    "mudar_prioridade",
    "remover_tarefa",
    "ver_lote",
    "ver_resultado",
  ]);
});

test("tarefa completa entra na fila, com as quatro seções no corpo", async (t) => {
  await comServidor(t, async (s, env) => {
    medidorComFolga(env.home);
    const repo = criarRepo(env.root);

    const r = await s.chamar("enfileirar_tarefa", tarefaCompleta(repo));
    assert.strictEqual(r.erro, false, r.texto);
    assert.match(r.texto, /Na fila: Validar o endpoint/);
    assert.match(r.texto, /Há cota agora/);

    const arquivos = fs.readdirSync(path.join(env.home, "queue"));
    assert.strictEqual(arquivos.length, 1);
    const conteudo = fs.readFileSync(path.join(env.home, "queue", arquivos[0]), "utf8");
    for (const secao of ["## Objetivo", "## Arquivos envolvidos", "## Critério de pronto", "## Como testar"]) {
      assert.ok(conteudo.includes(secao), `faltou ${secao}`);
    }
    assert.match(conteudo, /- `src\/LancamentoController\.java`/);
    assert.match(conteudo, /mvn -q test/);
  });
});

test("objetivo com muitos passos ganha maxTurns maior sozinho, e a resposta avisa", async (t) => {
  await comServidor(t, async (s, env) => {
    medidorComFolga(env.home);
    const repo = criarRepo(env.root);

    const objetivoGrande = [
      "1. Copie as imagens para a pasta de assets.",
      "2. Crie o componente de logo.",
      "3. Reescreva a página inicial com as novas seções.",
      "4. Ajuste o CSS responsivo.",
      "5. Atualize os testes da página.",
      "6. Atualize a documentação do site.",
      "7. Atualize o CHANGELOG.",
    ].join("\n");

    const r = await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), objetivo: objetivoGrande });
    assert.strictEqual(r.erro, false, r.texto);
    assert.match(r.texto, /Aviso de tamanho/);
    assert.match(r.texto, /7 passo/);

    const arquivos = fs.readdirSync(path.join(env.home, "queue"));
    const conteudo = fs.readFileSync(path.join(env.home, "queue", arquivos[0]), "utf8");
    assert.match(conteudo, /maxTurns: 70/);
  });
});

test("maxTurns explícito vale mesmo com objetivo grande, sem aviso", async (t) => {
  await comServidor(t, async (s, env) => {
    medidorComFolga(env.home);
    const repo = criarRepo(env.root);

    const objetivoGrande = Array.from({ length: 8 }, (_, i) => `${i + 1}. Passo ${i + 1}.`).join("\n");

    const r = await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), objetivo: objetivoGrande, maxTurns: 55 });
    assert.strictEqual(r.erro, false, r.texto);
    assert.doesNotMatch(r.texto, /Aviso de tamanho/);

    const arquivos = fs.readdirSync(path.join(env.home, "queue"));
    const conteudo = fs.readFileSync(path.join(env.home, "queue", arquivos[0]), "utf8");
    assert.match(conteudo, /maxTurns: 55/);
  });
});

test("objetivo pequeno não ganha aviso nem muda o maxTurns padrão", async (t) => {
  await comServidor(t, async (s, env) => {
    medidorComFolga(env.home);
    const repo = criarRepo(env.root);

    const r = await s.chamar("enfileirar_tarefa", tarefaCompleta(repo));
    assert.strictEqual(r.erro, false, r.texto);
    assert.doesNotMatch(r.texto, /Aviso de tamanho/);

    const arquivos = fs.readdirSync(path.join(env.home, "queue"));
    const conteudo = fs.readFileSync(path.join(env.home, "queue", arquivos[0]), "utf8");
    assert.doesNotMatch(conteudo, /maxTurns:/, "sem sugestão, o campo fica vazio e cai no padrão das configurações");
  });
});

test("tarefa vaga é recusada, e o erro diz o que falta", async (t) => {
  await comServidor(t, async (s, env) => {
    const repo = criarRepo(env.root);

    const r = await s.chamar("enfileirar_tarefa", {
      titulo: "ok",
      repo,
      objetivo: "melhorar",
      arquivos: [],
      criterio_de_pronto: "",
      como_testar: "",
    });

    assert.strictEqual(r.erro, true);
    for (const campo of ["titulo", "objetivo", "arquivos", "criterio_de_pronto", "como_testar"]) {
      assert.match(r.texto, new RegExp(campo), `o erro não menciona ${campo}`);
    }
    assert.match(r.texto, /desperdiça cota/, "explica por que a regra existe");
    assert.strictEqual(fs.readdirSync(path.join(env.home, "queue")).length, 0, "nada entrou na fila");
  });
});

test("repositório que não é git é recusado", async (t) => {
  await comServidor(t, async (s, env) => {
    const naoRepo = path.join(env.root, "pasta-qualquer");
    fs.mkdirSync(naoRepo, { recursive: true });

    const r = await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(naoRepo) });
    assert.strictEqual(r.erro, true);
    assert.match(r.texto, /não é um repositório git/);
    assert.strictEqual(fs.readdirSync(path.join(env.home, "queue")).length, 0);
  });
});

test("listar, repriorizar e remover", async (t) => {
  await comServidor(t, async (s, env) => {
    medidorComFolga(env.home);
    const repo = criarRepo(env.root);

    const criada = await s.chamar("enfileirar_tarefa", tarefaCompleta(repo));
    const id = criada.texto.match(/Id: (\S+)/)[1];

    const lista = await s.chamar("listar_fila");
    assert.match(lista.texto, /Pendentes \(1\)/);
    assert.match(lista.texto, /Validar o endpoint/);
    assert.match(lista.texto, /\[p3\]/, "prioridade padrão");

    const subiu = await s.chamar("mudar_prioridade", { id, prioridade: 1 });
    assert.strictEqual(subiu.erro, false, subiu.texto);
    assert.match((await s.chamar("listar_fila")).texto, /\[p1\]/);

    // fora da faixa é apertado para dentro, não recusado
    await s.chamar("mudar_prioridade", { id, prioridade: 99 });
    assert.match((await s.chamar("listar_fila")).texto, /\[p5\]/);

    const removeu = await s.chamar("remover_tarefa", { id });
    assert.strictEqual(removeu.erro, false, removeu.texto);
    assert.match((await s.chamar("listar_fila")).texto, /Pendentes \(0\)/);
  });
});

test("id que não existe devolve erro legível, não quebra", async (t) => {
  await comServidor(t, async (s) => {
    const r = await s.chamar("mudar_prioridade", { id: "nao-existe", prioridade: 1 });
    assert.strictEqual(r.erro, true);
    assert.match(r.texto, /Não achei tarefa/);
    assert.match(r.texto, /listar_fila/, "diz como descobrir o id certo");
  });
});

test("consultar cota usa a mesma conta da barra de status", async (t) => {
  await comServidor(t, async (s, env) => {
    medidorComFolga(env.home);

    const r = await s.chamar("consultar_cota");
    assert.match(r.texto, /Janela de 5 horas: 5\.0%/);
    assert.match(r.texto, /Janela de 7 dias: 15\.0%/);
    assert.match(r.texto, /5\.0% usados de 13\.0%/, "o mesmo orçamento dinâmico do porteiro");
    assert.match(r.texto, /teto da semana 75%/);
    assert.match(r.texto, /Calibração 5h: ainda não há/);
    assert.match(r.texto, /Calibração 7d: ainda não há/);
    assert.match(r.texto, /Pode executar agora/);
  });
});

test("cota estourada aparece com os motivos", async (t) => {
  await comServidor(t, async (s, env) => {
    const resetSemanal = inicioDoDia + 5 * 86400;
    writeJson(path.join(env.home, "usage.json"), {
      ts: now,
      source: "statusline",
      seven_day: { pct: 15, resetsAt: resetSemanal },
      five_hour: { pct: 88, resetsAt: now + 1800 },
    });
    writeJson(path.join(env.home, "state.json"), {
      day: core.localDay(new Date(now * 1000)),
      dayStartWeekPct: 10,
      dayWeekResetsAt: resetSemanal,
    });

    const r = await s.chamar("consultar_cota");
    assert.match(r.texto, /Aguardando/);
    assert.match(r.texto, /janela de 5h em 88\.0%/);
  });
});

test("o servidor sobrevive a uma linha ilegível", async (t) => {
  await comServidor(t, async (s, env) => {
    medidorComFolga(env.home);
    // simula lixo no meio da conversa
    const r = await s.chamar("listar_fila");
    assert.strictEqual(r.erro, false);
    assert.match(r.texto, /Pendentes \(0\)/);
  });
});

test("método desconhecido não derruba a conversa", async (t) => {
  await comServidor(t, async (s) => {
    const r = await s.pedir("coisa/inexistente", {});
    assert.strictEqual(r.error.code, -32601);
    const depois = await s.pedir("tools/list", {});
    assert.strictEqual(depois.result.tools.length, 7, "continua respondendo");
  });
});

// ---------- lote ----------

const lerTarefas = (home) =>
  fs
    .readdirSync(path.join(home, "queue"))
    .sort()
    .map((f) => fs.readFileSync(path.join(home, "queue", f), "utf8"));

test("lote: as tarefas entram em ordem, com a mesma base resolvida na primeira", async (t) => {
  await comServidor(t, async (s, env) => {
    medidorComFolga(env.home);
    const repo = criarRepo(env.root);

    const a = await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), titulo: "Primeira do lote", lote: "Site Novo" });
    assert.strictEqual(a.erro, false, a.texto);
    assert.match(a.texto, /tarefa 1 do lote site-novo/);
    const b = await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), titulo: "Segunda do lote", lote: "site novo" });
    assert.strictEqual(b.erro, false, b.texto);
    assert.match(b.texto, /tarefa 2 do lote site-novo/, "o nome é normalizado: as duas grafias são o mesmo lote");

    const [t1, t2] = lerTarefas(env.home);
    assert.match(t1, /^lote: site-novo$/m);
    assert.match(t1, /^ordem: 1$/m);
    assert.match(t2, /^ordem: 2$/m);
    assert.match(t1, /^base: main$/m, "sem base informada, vale a branch atual — gravada, não lida na hora de rodar");
    assert.match(t2, /^base: main$/m);

    const lote = JSON.parse(fs.readFileSync(path.join(env.home, "lotes", "site-novo.json"), "utf8"));
    assert.strictEqual(lote.estado, "andamento");
    assert.strictEqual(lote.branch, null, "a branch só nasce na primeira execução");
  });
});

test("lote: repositório diferente é recusado na hora de enfileirar", async (t) => {
  await comServidor(t, async (s, env) => {
    const repo = criarRepo(env.root);
    const outro = criarRepo(path.join(env.root, "outro"));

    await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), lote: "misturado" });
    const r = await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(outro), lote: "misturado" });
    assert.strictEqual(r.erro, true);
    assert.match(r.texto, /mesmo repositório/);
    assert.strictEqual(lerTarefas(env.home).length, 1, "a segunda não entrou");
  });
});

test("lote: base diferente é recusada", async (t) => {
  await comServidor(t, async (s, env) => {
    const repo = criarRepo(env.root);
    await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), lote: "bases", base: "main" });
    const r = await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), lote: "bases", base: "dev" });
    assert.strictEqual(r.erro, true);
    assert.match(r.texto, /parte de main, não de dev/);
  });
});

test("lote cancelado não aceita tarefa nova", async (t) => {
  await comServidor(t, async (s, env) => {
    const repo = criarRepo(env.root);
    await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), lote: "encerrado" });
    const arquivo = path.join(env.home, "lotes", "encerrado.json");
    const lote = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    fs.writeFileSync(arquivo, JSON.stringify({ ...lote, estado: "cancelado" }));

    const r = await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), lote: "encerrado" });
    assert.strictEqual(r.erro, true);
    assert.match(r.texto, /foi cancelado/);
  });
});

test("ver_lote mostra o relatório, e sem nome lista os lotes", async (t) => {
  await comServidor(t, async (s, env) => {
    const repo = criarRepo(env.root);
    await s.chamar("enfileirar_tarefa", { ...tarefaCompleta(repo), titulo: "Tarefa do relatório", lote: "relatado" });

    const lista = await s.chamar("ver_lote");
    assert.match(lista.texto, /relatado — andamento/);

    const r = await s.chamar("ver_lote", { nome: "relatado" });
    assert.strictEqual(r.erro, false, r.texto);
    assert.match(r.texto, /# Lote relatado/);
    assert.match(r.texto, /| 1 | Tarefa do relatório |/);

    const nada = await s.chamar("ver_lote", { nome: "inexistente" });
    assert.strictEqual(nada.erro, true);
  });
});
