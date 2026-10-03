#!/usr/bin/env node
// Simula `claude -p --output-format stream-json` para testes.
//
// O modo vem de FAKE_MODE, ou de uma linha `MODO: <modo>` no corpo da tarefa —
// esta última é o que permite, num lote, uma tarefa falhar e as outras não.
// `ARQUIVO: <nome>` troca o nome do arquivo que a tarefa cria (padrão FEITO.txt),
// para tarefas do mesmo lote não escreverem umas por cima das outras.
const fs = require("fs"), path = require("path");
let input = "";
process.stdin.on("data", d => input += d);
process.stdin.on("end", () => {
  const marcador = (nome) => (input.match(new RegExp(`^${nome}: (.+)$`, "m")) || [])[1]?.trim();
  const mode = marcador("MODO") || process.env.FAKE_MODE || "ok";
  const arquivo = marcador("ARQUIVO") || "FEITO.txt";
  const out = o => process.stdout.write(JSON.stringify(o) + "\n");
  const now = Math.floor(Date.now()/1000);
  out({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-x" });
  if (mode === "hang") { setInterval(()=>{}, 1000); return; }
  const status = mode === "warning" ? "allowed_warning" : mode === "rejected" ? "rejected" : "allowed";
  const info = { rateLimitType: "seven_day", resetsAt: now + 3*86400, status };
  if (mode === "warning") info.utilization = 0.76;
  out({ type: "rate_limit_event", rate_limit_info: info });
  if (mode === "rejected") { setInterval(()=>{}, 1000); return; }

  // o que existia na pasta antes: prova de que a tarefa enxerga as anteriores do lote
  const antes = fs.readdirSync(process.cwd()).filter(f => f !== ".git").sort().join(",");
  fs.writeFileSync(path.join(process.cwd(), arquivo), `arquivos antes: ${antes}\nprompt recebido:\n` + input);

  // `MODO: orfao`: deixa um processo vivo, desligado da árvore, com a pasta da
  // worktree como diretório atual -- como o Postgres embutido de um teste Java.
  // `PIDFILE: <caminho>` diz onde anotar o pid dele.
  if (mode === "orfao") {
    const { spawn } = require("child_process");
    setTimeout(() => {
      const filho = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
      filho.unref();
      fs.writeFileSync(marcador("PIDFILE") || process.env.FAKE_PIDFILE, String(filho.pid));
      out({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, result: "Deixei um processo rodando." });
      process.exit(0);
    }, 4000); // dá tempo de a fila prender o processo num job, como na vida real
    return;
  }

  // `COMANDO: <cmd>`: um comando de terminal que rodou e passou — o que a análise chama de verificação
  const comando = marcador("COMANDO");
  if (comando) {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu0", name: "Bash", input: { command: comando } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu0", is_error: false, content: "ok" }] } });
  }
  if (mode === "negado") {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la" } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true,
      content: "Permission to use Bash has been denied because Claude Code is running in don't ask mode." }] } });
  }
  if (mode === "fora") {
    const destino = marcador("FORA");
    fs.writeFileSync(destino, "escrito fora da worktree\n");
    out({ type: "assistant", message: { content: [
      { type: "text", text: "Vou gravar o guia." },
      { type: "tool_use", id: "tu2", name: "Write", input: { file_path: destino, content: "x" } },
    ] } });
  }
  if (mode === "falha") {
    out({ type: "assistant", message: { content: [
      { type: "text", text: "Tentei rodar os testes e eles quebraram na compilação." },
      { type: "tool_use", id: "tu3", name: "Bash", input: { command: "npm test" } },
    ] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu3", is_error: true, content: "Error: exit code 1" }] } });
  }

  // transcript como o Claude Code grava
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "fake");
  fs.mkdirSync(dir, { recursive: true });
  const line = { type: "assistant", timestamp: new Date().toISOString(), requestId: "r" + Date.now(),
    message: { id: "m" + Date.now(), model: "claude-sonnet-x", usage: { input_tokens: 1000, output_tokens: 20000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
  fs.appendFileSync(path.join(dir, "s.jsonl"), JSON.stringify(line) + "\n" + JSON.stringify(line) + "\n"); // duplicada de propósito
  out({ type: "assistant", message: line.message });
  if (mode === "falha") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 5, total_cost_usd: 0.3, result: "Não consegui terminar.", usage: line.message.usage });
    process.exit(0);
  }
  out({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.42, result: `Criei ${arquivo}. Nada pendente.`, usage: line.message.usage });
  process.exit(0);
});
