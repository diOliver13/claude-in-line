/**
 * Superfície do núcleo. Serve para dois consumidores: a extensão, que importa
 * os módulos direto, e os testes `node:test`, que carregam o bundle CommonJS
 * gerado a partir daqui — assim os testes exercitam exatamente o código que
 * vai dentro do .vsix, e não uma segunda compilação.
 */
export * from "./util";
export * from "./config";
export * from "./snapshot";
export * from "./transcripts";
export * from "./gauge";
export * from "./gate";
export * from "./queue";
export * from "./lote";
export * from "./analise";
export * from "./limpeza";
export * from "./runner";
