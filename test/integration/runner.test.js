"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { core, tmpEnv, writeJson } = require("../helpers");

/** O nome esperado vem do mesmo modelo que o runner usa, não de um texto fixo. */
function branchEsperada(cfg, id, titulo = "Tarefa de teste") {
  return core.nomeDaBranch({ id, title: titulo }, "repo", cfg.branchTemplate);
}

const ehWindows = process.platform === "win32";
const FAKE = path.resolve(__dirname, "..", "fake-claude.js");

const now = Math.floor(Date.now() / 1000);
const inicioDoDia = (() => {
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
})();

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

/** Um repositório de verdade: a fila trabalha com worktree e branch. */
function criarRepo(raiz) {
  const repo = path.join(raiz, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "teste@exemplo.local"]);
  git(repo, ["config", "user.name", "Teste"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "README.md"), "repositório de teste\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "inicial"]);
  return repo;
}

/**
 * O runner chama o executável sem shell. No Windows um .js não é executável,
 * então o simulador entra por um .cmd — que de quebra exercita o caminho de
 * `cmd.exe` com windowsVerbatimArguments, que é o que roda de verdade quando o
 * `claude` vem do npm.
 */
function criarSimulador(raiz) {
  if (!ehWindows) return FAKE;
  const cmd = path.join(raiz, "claude-falso.cmd");
  fs.writeFileSync(cmd, `@echo off\r\nnode "${FAKE}" %*\r\n`);
  return cmd;
}

/** Medidor com folga: o porteiro deixa passar, para o teste ser sobre a execução. */
function medidorComFolga(env) {
  const resetSemanal = inicioDoDia + 5 * 86400;
  writeJson(path.join(env.home, "usage.json"), {
    ts: now,
    source: "statusline",
    seven_day: { pct: 10, resetsAt: resetSemanal },
    five_hour: { pct: 5, resetsAt: now + 3600 },
  });
  writeJson(path.join(env.home, "state.json"), {
    day: core.localDay(new Date(now * 1000)),
    dayStartWeekPct: 10,
    dayWeekResetsAt: resetSemanal,
  });
}

function enfileirar(env, repo, extras = "") {
  const arquivo = path.join(env.home, "queue", "tarefa-de-teste.md");
  fs.writeFileSync(
    arquivo,
    `---\ntitle: Tarefa de teste\nrepo: ${repo.split("\\").join("/")}\npriority: 1\n${extras}---\n\nCrie o arquivo combinado.\n`
  );
  return "tarefa-de-teste";
}

/** Monta o cenário inteiro e roda um ciclo, devolvendo o que aconteceu. */
async function rodarCiclo(t, modo, extras = "") {
  const env = tmpEnv();
  const claudeAnterior = process.env.CLAUDE_CONFIG_DIR;
  const modoAnterior = process.env.FAKE_MODE;
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = claudeAnterior;
    process.env.FAKE_MODE = modoAnterior;
    env.cleanup();
  });

  // o simulador grava transcript aqui, como o Claude Code faria
  process.env.CLAUDE_CONFIG_DIR = env.claudeDir;
  process.env.FAKE_MODE = modo;

  const repo = criarRepo(env.root);
  const simulador = criarSimulador(env.root);
  medidorComFolga(env);
  const id = enfileirar(env, repo, extras);

  const eventos = [];
  const cfg = env.cfg({ claudePath: simulador, maxTasksPerRun: 1 });
  const quantas = await core.runQueue(cfg, { onEvent: (e) => eventos.push(e) });

  return { env, repo, id, cfg, eventos, quantas };
}

const fim = (eventos) => eventos.find((e) => e.kind === "task-end");
const ledger = (home) =>
  fs
    .readFileSync(path.join(home, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("modo ok: a tarefa roda, commita na branch própria e a worktree some", async (t) => {
  const { env, repo, id, cfg, eventos, quantas } = await rodarCiclo(t, "ok");

  assert.strictEqual(quantas, 1);
  const r = fim(eventos).result;
  assert.strictEqual(r.ok, true, `falhou: ${r.reason}`);
  const branch = branchEsperada(cfg, id);
  assert.strictEqual(r.branch, branch);
  assert.strictEqual(r.filesChanged, 1);

  // o commit existe, na branch, e não em main
  const arquivos = git(repo, ["show", "--name-only", "--format=", branch]);
  assert.match(arquivos, /FEITO\.txt/);
  assert.match(git(repo, ["log", "-1", "--format=%s", branch]), /^cq: Tarefa de teste$/);
  assert.doesNotMatch(git(repo, ["show", "--name-only", "--format=", "main"]), /FEITO\.txt/);

  // a worktree foi removida
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "worktrees")), []);

  // a tarefa saiu da fila e o registro ficou
  assert.strictEqual(core.listTasks(cfg, "queued").length, 0);
  assert.strictEqual(core.listTasks(cfg, "done").length, 1);
  assert.ok(fs.existsSync(path.join(env.home, "runs", id, "result.md")));
  assert.ok(fs.existsSync(path.join(env.home, "runs", id, "stream.jsonl")));

  const linha = ledger(env.home)[0];
  assert.strictEqual(linha.ok, true);
  assert.strictEqual(linha.branch, branch);
  assert.strictEqual(linha.base, "main", "a base fica registrada, para o diff saber com o que comparar");
});

test("modo ok: o prompt vai pelo stdin, com as regras de isolamento", async (t) => {
  const { repo, id, cfg } = await rodarCiclo(t, "ok");

  // o simulador grava o que recebeu no stdin
  const recebido = git(repo, ["show", `${branchEsperada(cfg, id)}:FEITO.txt`]);
  assert.match(recebido, /Crie o arquivo combinado\./, "o corpo da tarefa chegou");
  assert.match(recebido, /Não faça push/);
  assert.match(recebido, /Não faça commit/);
  assert.match(recebido, /TAREFA: Tarefa de teste/);
});

test("anexos: arquivo de fora do repo é copiado para dentro da worktree antes de chamar o claude", async (t) => {
  const env = tmpEnv();
  const claudeAnterior = process.env.CLAUDE_CONFIG_DIR;
  const modoAnterior = process.env.FAKE_MODE;
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = claudeAnterior;
    process.env.FAKE_MODE = modoAnterior;
    env.cleanup();
  });
  process.env.CLAUDE_CONFIG_DIR = env.claudeDir;
  process.env.FAKE_MODE = "ok";

  const repo = criarRepo(env.root);
  const simulador = criarSimulador(env.root);
  medidorComFolga(env);

  // vive ao lado do repo, não dentro dele: é "de fora" de verdade
  const fonte = path.join(env.root, "logo.svg");
  fs.writeFileSync(fonte, "<svg>conteúdo do logo</svg>");
  const id = enfileirar(env, repo, `anexos: ${fonte.split("\\").join("/")} -> frontend/public/logo.svg\n`);

  const eventos = [];
  const cfg = env.cfg({ claudePath: simulador, maxTasksPerRun: 1 });
  const quantas = await core.runQueue(cfg, { onEvent: (e) => eventos.push(e) });

  assert.strictEqual(quantas, 1);
  const r = fim(eventos).result;
  assert.strictEqual(r.ok, true, `falhou: ${r.reason}`);

  const branch = branchEsperada(cfg, id);
  // o anexo chegou no commit, no caminho pedido
  assert.strictEqual(git(repo, ["show", `${branch}:frontend/public/logo.svg`]), "<svg>conteúdo do logo</svg>");

  // o prompt avisa que o arquivo já está lá, para o modelo não tentar copiar de novo
  const recebido = git(repo, ["show", `${branch}:FEITO.txt`]);
  assert.match(recebido, /já foram copiados/);
  assert.match(recebido, /frontend\/public\/logo\.svg/);
});

test("processo órfão deixado pela tarefa é encerrado, e a worktree sai do disco", { skip: !ehWindows && "Job Object é do Windows" }, async (t) => {
  const pidfile = path.join(require("node:os").tmpdir(), `cq-orfao-${process.pid}-${Date.now()}.txt`);
  const anterior = process.env.FAKE_PIDFILE;
  process.env.FAKE_PIDFILE = pidfile;
  t.after(() => {
    process.env.FAKE_PIDFILE = anterior;
    try {
      const pid = Number(fs.readFileSync(pidfile, "utf8"));
      if (pid) process.kill(pid);
    } catch {
      /* já morreu, que é o esperado */
    }
    fs.rmSync(pidfile, { force: true });
  });

  const { env, id, eventos } = await rodarCiclo(t, "orfao");
  assert.strictEqual(fim(eventos).result.ok, true, fim(eventos).result.reason);

  const pid = Number(fs.readFileSync(pidfile, "utf8"));
  const vivo = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.strictEqual(vivo(), false, "o processo que ficou rodando foi encerrado junto com a tarefa");
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "worktrees")), [], `a worktree de ${id} não sobrou no disco`);
});

test("anexos: arquivo de origem inexistente falha antes de chamar o claude, sem gastar turno", async (t) => {
  const env = tmpEnv();
  const claudeAnterior = process.env.CLAUDE_CONFIG_DIR;
  const modoAnterior = process.env.FAKE_MODE;
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = claudeAnterior;
    process.env.FAKE_MODE = modoAnterior;
    env.cleanup();
  });
  process.env.CLAUDE_CONFIG_DIR = env.claudeDir;
  process.env.FAKE_MODE = "ok";

  const repo = criarRepo(env.root);
  const simulador = criarSimulador(env.root);
  medidorComFolga(env);

  const fonteInexistente = path.join(env.root, "nao-existe.svg").split("\\").join("/");
  const id = enfileirar(env, repo, `anexos: ${fonteInexistente} -> frontend/public/logo.svg\n`);

  const eventos = [];
  const cfg = env.cfg({ claudePath: simulador, maxTasksPerRun: 1 });
  await core.runQueue(cfg, { onEvent: (e) => eventos.push(e) });

  const r = fim(eventos).result;
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /anexo não encontrado/);
  assert.strictEqual(r.filesChanged, 0);

  // nada foi pra frente: nem branch, nem worktree, nem tentativa de rodar o simulador
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "worktrees")), []);
  assert.strictEqual(git(repo, ["branch", "--list", branchEsperada(cfg, id)]), "");
  assert.strictEqual(core.listTasks(cfg, "failed").length, 1);
});

test("modo warning: a fila pausa, mas a tarefa em andamento termina", async (t) => {
  const { env, eventos, cfg } = await rodarCiclo(t, "warning");

  const r = fim(eventos).result;
  assert.strictEqual(r.ok, true, "onWarning padrão é `finish`: termina o que começou");
  assert.strictEqual(r.stopQueue, true);
  assert.ok(eventos.some((e) => e.kind === "queue-paused"));

  const freio = core.loadState().brake;
  assert.ok(freio, "o freio ficou armado");
  assert.ok(freio.until > now, "e vale para o futuro");
  assert.match(freio.reason, /aviso de proximidade/);

  // o utilization do evento virou leitura do medidor
  const uso = JSON.parse(fs.readFileSync(path.join(env.home, "usage.json"), "utf8"));
  assert.strictEqual(uso.seven_day.pct, 76, "0.76 do evento virou 76%");

  // e com o freio armado, o porteiro segura o próximo ciclo
  assert.strictEqual(core.evaluate(cfg).ok, false);
});

test("onWarning é decisão do ciclo, não da tarefa: o frontmatter não muda isso", async (t) => {
  // Um `onWarning: abort` escrito na tarefa seria uma armadilha silenciosa:
  // parece configurar e não configura. O comportamento continua sendo o do ciclo.
  const { eventos } = await rodarCiclo(t, "warning", "onWarning: abort\n");
  assert.strictEqual(fim(eventos).result.ok, true, "seguiu o `finish` padrão do ciclo");
  assert.ok(core.loadState().brake, "e o freio foi armado do mesmo jeito");
});

test("modo rejected: o processo é morto, a fila para e nada fica pela metade", async (t) => {
  const { env, repo, id, cfg, eventos } = await rodarCiclo(t, "rejected");

  const r = fim(eventos).result;
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /limite seven_day atingido/);
  assert.strictEqual(r.stopQueue, true);

  const freio = core.loadState().brake;
  assert.match(freio.reason, /recusou por seven_day/);

  // sem alteração nenhuma, a branch não fica sujando o repositório
  assert.strictEqual(r.filesChanged, 0);
  assert.throws(() => git(repo, ["rev-parse", "--verify", branchEsperada(cfg, id)]), "a branch vazia foi apagada");
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "worktrees")), [], "a worktree foi removida");

  assert.strictEqual(core.listTasks(cfg, "failed").length, 1, "a tarefa pode ser tentada de novo");
});

test("modo hang: o timeout mata a árvore de processos e a tarefa vira falha", async (t) => {
  const inicio = Date.now();
  const { env, cfg, eventos } = await rodarCiclo(t, "hang", "timeoutMin: 0.05\n");
  const duracao = Date.now() - inicio;

  const r = fim(eventos).result;
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /timeout de 0\.05 min/);
  assert.ok(duracao < 60_000, `o timeout agiu em ${duracao}ms, não esperou o processo`);

  assert.strictEqual(core.listTasks(cfg, "failed").length, 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "worktrees")), []);
});

test("cancelar no meio derruba a tarefa como o fechamento do VS Code faria", async (t) => {
  const env = tmpEnv();
  const claudeAnterior = process.env.CLAUDE_CONFIG_DIR;
  const modoAnterior = process.env.FAKE_MODE;
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = claudeAnterior;
    process.env.FAKE_MODE = modoAnterior;
    env.cleanup();
  });
  process.env.CLAUDE_CONFIG_DIR = env.claudeDir;
  process.env.FAKE_MODE = "hang";

  const repo = criarRepo(env.root);
  const simulador = criarSimulador(env.root);
  medidorComFolga(env);
  enfileirar(env, repo);

  const controller = new AbortController();
  const eventos = [];
  const cfg = env.cfg({ claudePath: simulador, maxTasksPerRun: 1 });
  const ciclo = core.runQueue(cfg, {
    signal: controller.signal,
    abortReason: "VS Code fechado",
    onEvent: (e) => eventos.push(e),
  });

  // deixa o processo subir antes de puxar o tapete
  await new Promise((r) => setTimeout(r, 1500));
  controller.abort();
  await ciclo;

  const r = fim(eventos).result;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "VS Code fechado");
  assert.strictEqual(core.listTasks(cfg, "failed").length, 1, "volta como falha, recuperável com Tentar de novo");
  assert.deepStrictEqual(fs.readdirSync(path.join(env.home, "worktrees")), [], "não sobra worktree");
});

test("o lock impede duas janelas de rodarem a fila ao mesmo tempo", async (t) => {
  const env = tmpEnv();
  t.after(() => env.cleanup());

  assert.strictEqual(core.acquireLock(), true);
  const eventos = [];
  const quantas = await core.runQueue(env.cfg(), { onEvent: (e) => eventos.push(e) });
  assert.strictEqual(quantas, 0);
  assert.ok(eventos.some((e) => e.kind === "busy"));
  core.releaseLock();
});
