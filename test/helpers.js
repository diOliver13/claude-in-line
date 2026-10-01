"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// Os testes carregam o bundle do núcleo, que é o mesmo código que vai no .vsix.
const core = require("../out/core.js");

/** Uma pasta de dados e uma pasta do Claude Code novas, isoladas por teste. */
function tmpEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cq-test-"));
  const home = path.join(root, "cq");
  const claudeDir = path.join(root, "claude");
  fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
  core.setHome(home);
  core.ensureDirs();
  return {
    root,
    home,
    claudeDir,
    cfg(overrides) {
      return core.loadConfig({ claudeConfigDir: claudeDir, ...(overrides || {}) });
    },
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* no Windows um arquivo pode ficar preso; não é falha do teste */
      }
    },
  };
}

/** Escreve linhas de transcript no formato que o Claude Code grava. */
function writeTranscript(claudeDir, sessao, linhas) {
  const dir = path.join(claudeDir, "projects", sessao);
  fs.mkdirSync(dir, { recursive: true });
  const texto = linhas
    .map((l) =>
      JSON.stringify({
        type: l.type || "assistant",
        timestamp: new Date((l.ts || 0) * 1000).toISOString(),
        requestId: l.requestId || "req-" + l.id,
        message: {
          id: l.id,
          model: l.model || "claude-sonnet-4-5",
          usage: {
            input_tokens: l.input || 0,
            output_tokens: l.output || 0,
            cache_creation_input_tokens: l.cacheWrite || 0,
            cache_read_input_tokens: l.cacheRead || 0,
          },
        },
      })
    )
    .join("\n");
  fs.appendFileSync(path.join(dir, "s.jsonl"), texto + "\n");
}

function writeHistory(home, snaps) {
  fs.writeFileSync(path.join(home, "snapshots.jsonl"), snaps.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

module.exports = { core, tmpEnv, writeTranscript, writeHistory, writeJson };
