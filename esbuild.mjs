import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/**
 * Dois bundles a partir do mesmo núcleo:
 * - out/extension.js  roda no extension host (a API do vscode vem de fora)
 * - out/statusline.js  é copiado para ~/.cq e roda no node do PATH, chamado
 *   pelo Claude Code. Precisa ser autossuficiente porque o caminho da
 *   extensão muda a cada atualização.
 */
const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  logLevel: "info",
  minify: false,
  sourcemap: false,
};

const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "out/extension.js", external: ["vscode"] },
  { ...common, entryPoints: ["src/statusline.ts"], outfile: "out/statusline.js" },
  { ...common, entryPoints: ["src/mcp.ts"], outfile: "out/mcp.js" },
  // usado pelos testes node:test, fora do .vsix
  { ...common, entryPoints: ["src/core/index.ts"], outfile: "out/core.js" },
];

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
