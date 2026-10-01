/**
 * Bundle autossuficiente, copiado para dentro da pasta de dados e chamado pelo
 * Claude Code como statusLine. Recebe o JSON de estado no stdin e devolve uma
 * linha curta; o efeito que interessa é gravar o snapshot de cota, porque esse
 * percentual não chega por nenhum outro caminho.
 *
 * Nunca pode falhar: se a statusline quebra, o Claude Code mostra o erro no
 * lugar da linha. Por isso tudo está dentro de try/catch e a saída de fallback
 * é apenas "cq".
 */
import { handleStatusline } from "./core/snapshot";
import { ensureDirs, setHome } from "./core/util";

// O script vive dentro da pasta de dados, então grava ao lado de si mesmo.
// Assim ele continua certo mesmo se `claudeQueue.dataDir` não for ~/.cq.
setHome(process.env.CQ_HOME || __dirname);

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

async function main(): Promise<void> {
  let line = "cq";
  try {
    ensureDirs();
    line = handleStatusline(await readStdin());
  } catch {
    /* fallback acima */
  }
  process.stdout.write(line + "\n");
}

void main();
