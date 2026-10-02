# Changelog

## 2026-10-02 (noite) — 0.2.5: horário de início e fim na análise do lote

- **Seção "Linha do tempo" na análise do lote**: uma linha por execução, com início, fim, duração e
  resultado. Antes só havia a duração de cada tarefa e o intervalo total do lote.
- **Retentativas deixaram de sumir.** A análise lia só a última execução de cada tarefa; uma
  tarefa que falhou por limite e rodou de novo horas depois aparecia como se tivesse rodado uma
  vez. Agora cada tentativa é uma linha, e o "Tempo do lote" e o "Tempo de execução somado"
  contam todas.
- **Cada tarefa, em "O que cada tarefa fez", mostra início e fim** da execução que valeu, e de
  qual tentativa ela foi.

## 2026-10-02 (noite) — 0.2.4: "already exists" ao tentar de novo

**Por que.** Uma tarefa de lote falhou por limite de 5h, deixou o trabalho parcial commitado numa
branch à parte (como devia) e removeu a worktree — só que, no Windows, o processo do `claude`
recém-morto ainda segurava um identificador de arquivo, e o `git worktree remove` falhou em
silêncio. A pasta sobrou no disco. Horas depois, **Tentar de novo** batia em "already exists" sem
explicação nenhuma, porque o caminho da worktree é fixo por id de tarefa.

- **Falha ao remover a worktree agora aparece no log**, em vez de ser engolida, e a extensão tenta
  de novo na força (`fs.rmSync` + `git worktree prune`) antes de desistir.
- **Reforço na próxima tentativa:** se o caminho da worktree já existir de uma sobra assim, ela é
  limpa automaticamente antes do `git worktree add` — então mesmo que a limpeza do fim tivesse
  falhado, "Tentar de novo" (manual ou automático, da 0.2.3) não trava mais nisso.

## 2026-10-02 — 0.2.3: lote bloqueado por limite retoma sozinho

**Por que.** Um lote travou na tarefa 3 de 6 porque o Claude Code recusou por limite da janela de
5h. Mesmo depois de a janela zerar, ele continuou parado esperando **Tentar de novo** — e esse
clique manual é exatamente o que o projeto existe para evitar.

- **Bloqueio causado só pelo limite (não por um problema real da tarefa) retoma sozinho.** A fila
  já sabia a diferença — é o mesmo sinal que pausa a fila inteira (`stopQueue`) — só não usava essa
  informação para decidir sozinha. Agora, a cada ciclo, se o orçamento já libera de novo, a tarefa
  parada volta para a fila e o lote é destravado, sem esperar o clique.
- **Bloqueio por qualquer outro motivo continua manual.** Teste quebrado, ferramenta negada, o que
  for: a fila genuinamente não tem como saber se repetir o pedido resolve ou repete o problema, e
  errar para esse lado (esperar demais) é mais seguro que errar para o outro (repetir sozinha algo
  que não era para repetir).
- **Lotes bloqueados antes desta versão não ganham isso de graça** — o sinal só existe a partir de
  agora; o antigo continua precisando do clique manual, uma vez.

## 2026-10-01 (noite) — 0.2.2: grupo Arquivo na árvore

- **Grupo Arquivo, abaixo de Com falha.** Até aqui, consultar o que foi arquivado (pela limpeza
  manual ou pela retenção automática) exigia abrir `~/.cq/arquivo/<data>/` no explorador — pedido
  depois de usar a limpeza pela primeira vez e não achar onde ver o resultado dentro do próprio
  painel. Mostra os últimos 50 itens, mais recente primeiro, lendo os manifestos
  `limpeza-<hora>.json` que a limpeza já grava — sem reabrir `.md` nenhum. Só leitura: o item já
  saiu da fila, não há ação que faça sentido nele ali.

## 2026-10-01 — 0.2.1: primeira publicação pública

- **Comando corrompido no README corrigido.** O caminho do `claude.exe` embutido, na seção
  "Sobre o executável do `claude`", tinha perdido as barras invertidas e ganhado uma quebra de
  linha no meio — rodar como estava não funcionava.

## 2026-09-30 (noite) — limite por dia da semana

- **Tela de configurações ganhou a seção "Por dia da semana"**: segunda a domingo, cada dia aceita
  um horário permitido e/ou um percentual fixo da semana, que substituem `allowedHours` e
  `dailyBudget` só naquele dia. Dia em branco continua igual a hoje — segue o geral, sem mudar
  nada.
- **`claudeQueue.weekdayOverrides`**, uma configuração nova (7 posições, índice 0=domingo a
  6=sábado); editada só pelo painel, como já era `allowedHours`.
- **`cq status` e o canal de saída mostram o ajuste de hoje**, quando existe, ao lado do orçamento
  do dia.
- **A tabela soma, ao vivo, os percentuais preenchidos e compara com o teto da semana**, avisando
  quando a soma passa do que a reserva libera. Motivado por um caso real: 15% de segunda a sábado
  mais 10% no domingo somam 100%, mas com a reserva em 30% o teto da fila é 70% — os últimos dias da
  configuração nunca chegariam a rodar, e a tela não dizia isso antes.

## 2026-09-30 (tarde) — a extensão passou a se chamar Claude in Line

- **Renomeada de "Claude Queue" para "Claude in Line"**: título da view, categoria dos comandos na
  paleta, tela de configuração, canal de saída e as demais telas. O `name` interno do pacote
  (`claude-queue`), os ids de comando (`claudeQueue.*`) e as configurações (`claudeQueue.*`) não
  mudaram — só o nome que aparece para quem usa.

## 2026-09-30 — 0.2.0: lotes, análise do lote, limpeza do histórico e relatório de falha

**Por que.** Um site foi enfileirado em 29/09 como cinco tarefas avulsas. Saíram
quatro branches para juntar à mão, com o mesmo conflito de CHANGELOG em cada uma; uma tarefa
disse que terminou sem ter rodado teste nenhum; e o guia foi gravado numa pasta que nenhuma
branch via, registrado como "concluída, 0 arquivos". Tudo isso foi descartado e refeito sobre
esta versão.

### Lote

- **`enfileirar_tarefa` ganhou o parâmetro `lote`.** Tarefas do mesmo lote rodam em sequência, na
  ordem de entrada, numa branch só, com um commit por tarefa. Cada uma enxerga o que as anteriores
  fizeram, e o prompt lista quais já foram commitadas. Cada tarefa mantém o próprio modelo.
- **Repositório e base diferentes são recusados ao enfileirar**, não na execução. A base é
  resolvida uma vez, na primeira tarefa, e gravada: trocar de branch no meio não muda o lote.
- **A ordem do lote vale mais que a prioridade.**
- **Falha no meio para o lote.** O trabalho parcial vai para `…-falha-<tarefa>`, fora da branch do
  lote, e as seguintes ficam bloqueadas até você escolher **Tentar de novo**, **Pular no lote** ou
  **Cancelar lote**. Tarefas fora do lote seguem rodando.
- **Branch do lote em checkout não é falha.** O git não abre worktree numa branch em uso, então a
  fila espera, diz no log por quê e retoma quando você sair dela.
- **Grupo Lotes na árvore**, com as tarefas em ordem e o commit de cada uma; relatório do lote em
  `~/.cq/lotes/<lote>.md`; **Ver diff do lote** e checkout da branch do lote. Na tarefa de lote,
  **Ver diff** mostra só o commit dela.
- **Ferramenta nova no MCP, `ver_lote`**: o relatório de um lote, ou a lista deles.
- **Lote concluído que recebe tarefa nova volta a andar**, na mesma branch — é a correção pedida
  depois da revisão.

### Análise do lote

- **Ao concluir, o lote ganha uma análise** em `~/.cq/lotes/<lote>-analise.md`, aberta pelo botão
  **Ver análise do lote** da notificação ou pelo menu do lote — que também gera a de um lote
  bloqueado ou cancelado, a qualquer momento.
- **O que ela mostra:** resumo (tempo do lote e de execução, commits, linhas, custo); consumo por
  tarefa (tokens de entrada, saída, cache e raciocínio, custo e **pontos estimados da semana e da
  janela de 5h**); comparação por modelo; o que cada tarefa fez, com arquivos `+/-`, os comandos
  que rodou e se passaram, e as ferramentas usadas; pontos de atenção; e os comandos git para
  revisar e juntar.
- **A estimativa em pontos** usa os mesmos pesos de token e o mesmo fator de calibração do medidor.
  Sem calibração ela aparece como "—", em vez de inventar número. Ao lado vem a **variação medida**
  da semana durante o lote, pelas leituras do medidor, com o aviso de que inclui outro uso da conta.
- **Pontos de atenção** apontam: tarefa que concluiu sem nenhum comando de terminal que passasse
  (a verificação pedida pode não ter rodado), comandos que falharam no caminho, comandos negados,
  e **arquivo alterado por mais de uma tarefa**, o ponto mais provável de uma desfazer a outra.
- **Copiar descrição de PR** põe na área de transferência o que foi feito e com que comandos foi
  verificado, sem a contabilidade de consumo.
- `ver_lote` no MCP aceita `analise: true`.
- **Registro novo por execução,** que a análise usa: `runs/<id>/detalhes.json` (comandos rodados e
  resultado, contagem de ferramentas) e, no ledger, o peso em tokens e o medidor no início e no fim.
  O `result.md` passou a listar os comandos rodados. Execuções anteriores aparecem na análise como
  "não registrado".

### Limpeza do histórico

- **Limpar histórico…**, no menu `···` do painel, em três passos: o quê (concluídas, com falha,
  lotes encerrados, pendentes — esta desmarcada), como (**arquivar**, recomendado, ou **apagar de
  vez**, com confirmação) e, se houver, quais branches já mescladas apagar junto.
- **Arquivar** move tudo para `~/.cq/arquivo/<data>/`, com a mesma estrutura de pastas e um
  `limpeza-<hora>.json` dizendo o que saiu. **Esvaziar arquivo** apaga isso de vez.
- **Branch só é apagada se o git confirmar que está inteira na base** (`merge-base --is-ancestor`),
  conferido de novo na hora de apagar. Branch não mesclada, em checkout ou juntada por squash fica.
- **Nunca tocados:** lote em andamento ou bloqueado e as tarefas dele (a próxima tarefa do lote lê o
  que as anteriores fizeram), o ledger, e o medidor — leituras, calibração e estado do dia.
- **Com a fila executando, a limpeza recusa**: ela usa o mesmo lock da execução.
- **Retenção automática:** `claudeQueue.retencaoDias` (0 desliga, o padrão) arquiva sozinho, uma vez
  por dia, o histórico com mais de N dias. Só arquiva, nunca apaga, e nunca toca pendentes.

### Relatório de falha

- **Toda tarefa que falha ganha um `falha.md`**: motivo, duração, o que o modelo disse por último,
  comandos negados, erros de ferramenta (com o comando e a resposta), o que ficou e onde, a saída
  de erro do processo e, no lote, o que já foi commitado e o que está parado. Clicar numa tarefa
  com falha abre ele; a notificação de falha tem o botão **Ver relatório da falha**.
- **Comandos negados aparecem no `result.md` mesmo quando a tarefa conclui.** Foi o que escondeu
  em 29/09 uma tarefa "concluída" que nunca rodou os testes.
- **O relatório de falha no lote dizia "guardados em `…-falha-<tarefa>`", mas o trabalho já estava
  commitado ali — só não chegou na branch do lote.** Agora diz **"commitados como `cq(wip) <hash>`
  em `…-falha-<tarefa>`"**, com o hash real. O commit sempre existiu; era só a frase que escondia
  isso.

### Escrita fora da worktree

- **O prompt informa o caminho absoluto da worktree**, e ao fim a fila confere no registro da
  execução se alguma escrita (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) caiu fora dela. Se caiu,
  a tarefa é **falha**, com o caminho no relatório. Antes o modelo deduzia o caminho pelo nome da
  branch, gravava numa pasta vizinha, e a fila registrava "concluída, 0 arquivos".
- Escrita feita por comando de terminal não é detectada: só as ferramentas de arquivo.

### Negação de comando

- **O prompt lista as ferramentas liberadas e diz que uma negação vale só para aquele comando.**
  Medido no registro de 29/09: a tarefa abriu com `ls`, `head`, `grep` e `find`, que não estavam
  liberados, e concluiu que o terminal inteiro estava bloqueado — sem tentar o `npm`, que estava.
  Outra tarefa, com as mesmas permissões, rodou `cd frontend && npx vitest` sem problema.

### Atualização do painel

- **Atualizar a extensão agora atualiza as ferramentas do painel.** A cópia em `~/.cq/mcp.js` só
  era feita no "Conectar ao painel", então uma versão nova da extensão seguia servindo as
  ferramentas da anterior, sem erro nenhum. Se o servidor já está instalado, a ativação troca a
  cópia; a versão nova vale a partir da próxima conversa do Claude Code.

### CLI

- **A `cq` ignora tarefas de lote**, com aviso: rodá-las ali criaria branches avulsas e quebraria a
  sequência. Elas esperam o VS Code.

### Anexos

- **`enfileirar_tarefa` ganhou o parâmetro `anexos`**: pares `{ de, para }` copiados para dentro da
  worktree **antes** de chamar o Claude, no processo da extensão — nunca pelo sandbox de permissão,
  que nega sistematicamente um `cp`/`Copy-Item` com origem fora da worktree (5 tentativas
  diferentes, todas negadas, no caso real que motivou isto).
- **O prompt avisa quais arquivos já chegaram** e pede para não copiá-los de novo.
- **Origem inexistente falha antes de gastar turno**, sem chamar o Claude; a worktree e a branch
  criadas para a tentativa são desfeitas.
- No frontmatter, `anexos` é uma lista `de -> para` separada por vírgula, no mesmo espírito de
  `allowedTools` (frontmatter não tem estrutura aninhada).

### Sugestão de tamanho da tarefa

- **`enfileirar_tarefa` ganhou o parâmetro `maxTurns`.** Quando não informado, a ferramenta estima
  pelo texto do objetivo (passos numerados) e pela lista de arquivos: mais de 6 passos ou mais de 8
  arquivos sobe o teto para pelo menos 70, e a resposta explica por quê. Objetivo pequeno não grava
  nada no frontmatter — a tarefa continua herdando o padrão das configurações, em vez de congelar
  no valor de hoje.

## 2026-09-29 (madrugada) — o percentual oficial sem precisar do terminal

**A premissa do projeto estava errada, e isso é uma boa notícia.** O documento original dizia que
o percentual oficial de uso só chega ao script de statusline. Não é verdade: o painel do Claude
Code busca o uso da conta sozinho, a cada poucos minutos, e guarda em `~/.claude.json`, no campo
`cachedUsageUtilization`. São os mesmos números da tela "Account & Usage".

- **Essa leitura passou a ser a fonte principal do medidor**, gravada no histórico como
  `claude-cache`. A statusline continua valendo, e a leitura mais nova ganha, venha de onde vier.
- **Rodar `claude` no terminal deixou de ser obrigatório.** Continua útil — é uma leitura a mais —
  mas o medidor agora funciona só com o painel aberto.
- **A calibração ficou confiável.** Com leituras a cada poucos minutos, a janela de 5h passou a
  calibrar por pares, como a semana. Antes ela quase nunca calibrava, porque reseta a cada 5 horas
  e era improvável haver duas leituras de terminal dentro da mesma.
- **Removida a calibração pelo início da janela**, introduzida horas antes. Ela trocava um número
  congelado por um número inflado: mostrava 83% onde a verdade era 42%. Era um contorno para a
  falta de leituras, e a falta de leituras deixou de existir.
- **É estado interno do Claude Code, não uma interface publicada.** Se o campo mudar de nome ou de
  formato, a leitura devolve nada e o medidor volta a depender da statusline e da estimativa.
  Nunca escrevemos nesse arquivo.
- **Correção de isolamento nos testes:** o servidor MCP subia sem `CLAUDE_CONFIG_DIR` apontado para
  o temporário e lia a conta real da máquina. Só apareceu quando passamos a ler esse arquivo.
## 2026-09-29 (noite) — a janela de 5h estava congelada

**Correção de medição, não de tela.** A janela de 5h mostrava a última leitura e não se mexia:
12% na barra enquanto o consumo real já estava perto de 43%. Como é ela que decide se a fila pode
começar uma tarefa (limite de 60%), o porteiro enxergava folga que não existia.

- **A causa:** a calibração só sabia comparar duas leituras da mesma janela, e a de 5h reseta a
  cada 5 horas — é improvável haver duas leituras de terminal dentro da mesma. Então ela nunca
  calibrava, e sem fator o número fica parado entre leituras.
- **A correção:** toda janela começa em zero, e isso é informação. Uma leitura só de 12% já é a
  medição de quanto custou o gasto do início da janela até ali. O medidor passa a usar isso
  quando não existe um par de leituras.
- **O par continua tendo preferência.** Ele isola um trecho e não depende de a contagem de tokens
  cobrir a janela inteira. O início da janela é o caminho reserva, e as telas dizem quando o fator
  veio de lá.
- **Errar para cima é o lado certo de errar.** O que falta nos transcripts (uso no claude.ai, por
  exemplo) infla o fator, e fator inflado superestima o consumo — segura a fila em vez de soltar.
- **As duas janelas calibram separado**, com fatores próprios, e o tooltip mostra os dois.

## 2026-09-29 (noite) — nome de branch configurável

- **As branches passaram a se chamar `Dev_Branches/2026-09-29/regime-invalido-na-listagem`**, em vez
  de `cq/20260929-205217-regime-invalido…`. A `/` cria níveis de verdade no git, então o VS Code
  mostra isso como árvore de pastas: uma pasta por dia dentro de `Dev_Branches`.
- **O formato é configurável** em `claudeQueue.branchTemplate`, com os marcadores `{data}`,
  `{hora}`, `{repo}`, `{slug}` e `{id}`. A tela de configuração mostra a prévia do nome enquanto
  você digita. Quem quiser o formato antigo usa `cq/{id}`.
- **A data é a da execução, no formato 2026-09-29.** Data com barras viraria hierarquia sem querer
  (`29/09/26` são três níveis), e o formato brasileiro ordena errado em `git branch` — a data
  invertida se organiza sozinha.
- **O nome do repositório saiu da branch.** Ele é redundante: você só vê aquela branch estando
  dentro daquele repositório. Continua na pasta da worktree, que é compartilhada entre projetos.
- **Nomes inválidos são limpos antes de virar branch** (espaço, os sinais `~^:?*[\`,
  `..`, `@{`, nível começando com ponto, final `.lock`). Um nome inválido faria o
  `worktree add` falhar com uma mensagem que não explica nada.
- **A pasta da worktree passou a usar o id da tarefa**, que é único por construção. Antes usava o
  fim do nome da branch, que com o modelo novo poderia repetir.

## 2026-09-29 (noite) — enfileirar conversando com o painel

- **O painel do Claude Code ganhou seis ferramentas de fila**: enfileirar tarefa, listar fila,
  consultar cota, mudar prioridade, remover tarefa e ver resultado. Agora dá para pedir uma tarefa
  em português, no painel, e o Claude que está ali — que já leu o seu código — monta o card com os
  arquivos e o modo de testar preenchidos. `Claude in Line: Conectar ao painel do Claude Code`.
- **São dois Claudes, e isso é de propósito.** O do painel compõe, lista e reordena; ele **não
  executa** a fila. Quem decide quando rodar continua sendo o agendador, obedecendo o porteiro. Se
  o painel pudesse mandar executar, o projeto perderia o sentido: voltaria a gastar cota na hora
  do pedido.
- **A ferramenta recusa tarefa vaga.** Sem objetivo, arquivos, critério de pronto e como testar,
  ela devolve erro explicando o que falta. A conversa torna fácil demais enfileirar qualquer coisa,
  e quem executa a tarefa não pode pedir esclarecimento — então a recusa é regra do código, não
  pedido no texto.
- **O servidor é escrito à mão sobre JSON-RPC no stdin/stdout**, sem SDK, para manter a regra de
  zero dependências de runtime. Vive em `~/.cq/mcp.js` pelo mesmo motivo da statusline: o caminho
  da extensão muda a cada atualização.
- **A extensão espelha suas configurações em `~/.cq/extension-settings.json`.** O servidor roda em
  outro processo e não enxerga as configurações do VS Code; sem o espelho, as duas pontas
  discordariam sobre modelo padrão, reserva e ferramentas liberadas.

## 2026-09-29 (tarde) — tela de configuração e medidor honesto

- **Painel de configuração próprio** (`Claude in Line: Configurações`, ou a engrenagem no topo da
  view). Agrupa os controles por assunto, mostra o medidor com barras, e calcula ao vivo o efeito
  de mexer na reserva ou no teto: *"com esses valores, hoje a fila pode usar até X%"*. Os horários
  permitidos viraram texto (`0-7, 12-14`) em vez de JSON aninhado.
- **A conta do orçamento saiu do porteiro para uma função própria** (`dailyBudget`), usada pelos
  dois. A tela precisa simular valores ainda não salvos, e duas cópias da fórmula divergiriam na
  primeira alteração.
- **Correção: o medidor mentia depois da virada de janela.** Sem calibração, quando a janela de 5h
  resetava, a base voltava a zero e a tela mostrava `5h 0%` com o rótulo "leitura direta" — um
  piso apresentado como medição, escondendo o consumo já ocorrido. Agora o núcleo marca a virada
  (`rolledOver`) e as telas dizem que aquilo é um piso.
- **O tooltip mostra o consumo em tokens desde a última leitura.** Sem calibração o percentual não
  se mexe entre leituras, o que parecia um travamento. Os tokens provam que o painel do VS Code
  está sendo medido, e a linha de calibração agora explica que as leituras precisam ser
  **espaçadas**, não em sequência.

## 2026-09-29 — primeira versão instalável (0.1.0)

### Decisões que valem para sempre

- **A fila só opera com o VS Code aberto.** Fechar o editor para tudo: não há execução em
  segundo plano. A janela de 5h é um freio de vazão, não um saldo que evapora, e o orçamento
  diário é recalculado como "o que sobra da semana ÷ dias até o reset" — então um dia parado
  não queima cota, só adia. Para rodar com tudo fechado existe a CLI `cq schedule install`,
  que grava nos mesmos `~/.cq` e disputa o mesmo lock.
- **Fechar o VS Code encerra a tarefa em andamento.** O processo é morto, o que foi feito vira
  um commit `cq(wip):` e a tarefa vai para "com falha" com o motivo "VS Code fechado",
  recuperável com Tentar de novo. A alternativa — deixar o `claude` órfão — gastaria cota sem
  ninguém para commitar nem remover a worktree.
- **A pasta de dados é resolvida na ativação.** `claudeQueue.dataDir` vazio significa `~/.cq`.
  Mudar a configuração exige recarregar a janela, porque os observadores de arquivo e o lock
  apontam para o caminho resolvido ali.
- **O `statusline.js` mora dentro da pasta de dados e grava ao lado de si mesmo.** É um bundle
  dos mesmos módulos do núcleo, não um script à parte, para não poder divergir do formato que
  o medidor lê.
- **`onWarning` é decisão do ciclo, não da tarefa.** Escrever `onWarning: abort` no frontmatter
  não tem efeito, e há um teste guardando isso — seria uma armadilha silenciosa.

### O que a extensão faz

- Barra de status com as duas janelas, tamanho da fila, cor por severidade (60% e 80%) e
  tooltip com origem da leitura, idade do snapshot, orçamento do dia e motivos de bloqueio.
- Painel na barra de atividades com Pendentes, Em execução, Concluídas (últimas 20) e Com
  falha, cada grupo com seu menu de contexto.
- Adicionar tarefa por título, a partir da seleção ou do TODO sob o cursor. O rascunho fica
  fora da fila até você salvar, para o agendador não pegar um texto pela metade.
- Executar agora, Pausar/Retomar (a pausa sobrevive ao fechamento), Mostrar status,
  Configurar medidor, Atualizar leitura, Abrir pasta de dados.
- Agendador interno a cada 20 min, mais uma passada 2 min depois de abrir. Uma instância só,
  mesmo com várias janelas, pelo lock de arquivo.
- Ver diff: um arquivo abre no comparador lado a lado, vários abrem como diff em texto.

### Correção

- **A detecção do `claude` não para no PATH.** Quem usa o Claude Code só pelo painel do VS
  Code não tem `claude` no PATH: o executável vive dentro da pasta da extensão
  (`~/.vscode/extensions/anthropic.claude-code-<versão>/resources/native-binary/`), e o caminho
  muda a cada atualização. A busca agora é PATH → pasta da extensão, da versão mais nova para a
  mais velha → `~/.local/bin`. Sem isso, toda tarefa falharia com "não encontrei o executável"
  numa máquina onde o Claude Code funciona perfeitamente.
- **Mostrar status diz qual executável será usado**, ou explica por que não achou. Era o
  diagnóstico que faltava.

### Mudanças no núcleo herdado da CLI

- `util.ts`: `P` virou getters sobre um `home` mutável, com `setHome()`. A CLI resolvia a pasta
  uma vez por processo; o extension host vive horas e o `statusline.js` roda de dentro da pasta
  de dados.
- `queue.ts`: os três diretórios eram congelados no carregamento do módulo, o que faria a
  extensão escrever no lugar errado depois do `setHome`. Viraram função.
- `config.ts`: `loadConfig(overrides)` em três camadas — padrões, `config.json`, configurações
  do VS Code. Chave `undefined` não apaga mais a camada de baixo.
- `runner.ts`: `console.log` virou eventos tipados, porque a mesma informação vai para três
  lugares. Ganhou `AbortSignal`, que é o que faz Cancelar e o fechamento do VS Code
  terminarem limpos. O ledger passou a gravar a `base`, sem a qual o Ver diff não tem com o
  que comparar.
- `transcripts.ts`: cache por arquivo, com invalidação por mtime e tamanho. A CLI lia tudo uma
  vez e morria; a extensão consulta o medidor a cada 30 s, e reparsear megabytes de transcript
  na thread da interface travaria o editor.
