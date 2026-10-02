# Claude in Line

Fila de tarefas de desenvolvimento para o Claude Code que **só executa quando há cota sobrando** no seu plano Pro/Max. Você enfileira melhorias quando está sem limite; a extensão executa cada uma quando o orçamento permite, numa branch própria para você revisar depois.

```
statusline do Claude Code ──► snapshot (% 5h / % 7d)  ─┐
transcripts locais (~/.claude/projects) ──► tokens ────┼─► medidor ─► porteiro ─► claude -p numa worktree
eventos de limite do próprio claude -p ──► freio ──────┘                        └─► commit na branch cq/<id>
```

A extensão **só opera com o VS Code aberto**. Fechar o editor para tudo, de propósito — veja [Limitações conhecidas](#limitações-conhecidas).

Os dados ficam em `~/.cq`.

> **Projeto independente, sem vínculo com a Anthropic.** "Claude" é marca da Anthropic; o nome aqui
> é só para identificar que a extensão automatiza o Claude Code. Não é um produto oficial, nem
> endossado por eles.

## Instalação

Baixe o `.vsix` mais recente na aba **[Releases](../../releases)** deste repositório e instale:

```powershell
code --install-extension caminho\para\claude-queue-X.Y.Z.vsix
```

Ou pela interface: **Extensões** → menu `...` no topo do painel → **Install from VSIX…**.

Requisitos: VS Code 1.90+, Node.js 18+ no PATH, git, e o Claude Code instalado e logado.

### Sobre o executável do `claude`

Se você usa o Claude Code **só pelo painel do VS Code**, o comando `claude` não existe no seu
terminal: o executável fica dentro da pasta da extensão, e o caminho muda a cada atualização
dela. A fila sabe procurar ali, então ela funciona mesmo assim — a ordem de busca é PATH, depois
a pasta da extensão (versão mais nova primeiro), depois `~/.local/bin`.

Mas o **medidor depende de você rodar `claude` num terminal** de vez em quando. Para isso valer
a pena, instale o CLI de uma vez:

```powershell
claude install
```

Se o `claude` ainda não estiver no PATH, chame o embutido pelo caminho completo uma única vez:

```powershell
& "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe" install
```

Depois feche e reabra o terminal. **Claude in Line: Mostrar status** diz qual executável a fila vai
usar — é o primeiro lugar para olhar se algo não roda.

## Primeiro uso

São três passos, nesta ordem.

**1. Configure o medidor.** Paleta de comandos (`Ctrl+Shift+P`) → **Claude in Line: Configurar medidor (statusline)**.

O comando copia um script autossuficiente para `~/.cq/statusline.js`, mostra num diff o que vai mudar em `~/.claude/settings.json`, e só grava depois da sua confirmação. Se já existir uma `statusLine` diferente, ela aparece no diff antes de ser trocada, e um backup `settings.json.bak-<data>` fica ao lado.

**2. Gere a primeira leitura.** Abra o terminal integrado, rode `claude` e mande uma mensagem curta. Existe um atalho para isso: **Claude in Line: Atualizar leitura agora** — ele abre o terminal com o comando pronto, mas não envia nada; quem escreve é você.

Esse passo é obrigatório e vai se repetir de vez em quando. O motivo está em [Como o medidor funciona](#como-o-medidor-funciona).

**3. Adicione uma tarefa.** **Claude in Line: Adicionar tarefa**. Você informa o título, escolhe o repositório, e a extensão abre um `.md` com o frontmatter preenchido e um roteiro no corpo. **Ao salvar, a tarefa entra na fila.**

A partir daí o ícone da Claude in Line na barra lateral mostra a fila, e a barra de status mostra o medidor:

```
5h 23% · 7d 41% · fila 3
```

Amarelo a partir de 60%, vermelho a partir de 80%. `⏸` quando a fila está pausada, `⟳ <título>` quando há tarefa rodando. Clicar abre o relatório completo.

## Como escrever uma tarefa

O corpo do `.md` é o prompt. Tarefa vaga desperdiça cota, então o modelo já vem com as quatro seções que importam:

```markdown
---
title: Validação no endpoint de lançamentos
repo: D:/dev/meu-projeto
priority: 1
model: sonnet
maxTurns: 40
timeoutMin: 45
allowedTools: Read, Edit, Write, Glob, Grep, Bash(mvn -q test:*)
---

## Objetivo
No LancamentoController, valide valor > 0 e data não futura. Retorne 400 com mensagem clara.

## Arquivos envolvidos
- `src/main/java/.../LancamentoController.java`

## Critério de pronto
- Requisição inválida devolve 400 com a mensagem, não 500.
- Existe teste cobrindo os dois casos.

## Como testar
`mvn -q test -Dtest=LancamentoControllerTest`
```

`allowedTools` separa por vírgula, mas **não** dentro de parênteses: `Bash(mvn -q test -Dtest=A,B:*)` é uma ferramenta só.

Se a tarefa precisa de um arquivo ou pasta de **fora** do repositório (uma imagem, um binário, material de referência), não peça no objetivo para copiá-lo com `cp`/`Copy-Item` — a origem fica fora da worktree, e esse comando é **sempre negado**, mesmo liberado em `allowedTools`. Use `anexos` no frontmatter: a fila copia antes de chamar o Claude, fora do sandbox de permissão.

```
anexos: D:/materiais/logo.svg -> frontend/src/componentes/Logo.svg, D:/materiais/telas -> frontend/public/site
```

Cada par é `origem absoluta -> destino relativo à raiz do repositório`, separados por vírgula. Se a origem não existir, a tarefa falha antes de gastar um turno.

Dois atalhos para criar tarefa sem sair do código:

- **Adicionar a partir da seleção** — leva o trecho selecionado, o arquivo e as linhas como contexto.
- **Adicionar TODO sob o cursor** — lê o `// TODO`, `# TODO` ou `<!-- TODO` da linha atual.

## Enfileirar conversando, pelo painel do Claude Code

Rode **Claude in Line: Conectar ao painel do Claude Code** uma vez. Depois **abra uma conversa nova**
no painel — a que já estava aberta não enxerga o que acabou de ser registrado.

A partir daí você pede em português:

> *olha esse LancamentoController, tá sem validação nenhuma. Enfileira uma tarefa pra resolver.*

O Claude do painel já leu o seu código, então ele preenche os arquivos envolvidos e o modo de
testar sozinho, te mostra o card e pergunta se confirma. Também dá para conversar sobre a fila:
*"o que tem na fila?"*, *"tenho cota agora?"*, *"sobe a prioridade daquela do endpoint"*.

### São dois Claudes diferentes

| | **O do painel** | **O da fila** |
|---|---|---|
| Quando trabalha | agora, com você olhando | depois, quando houver cota |
| Onde | no seu repositório | numa worktree isolada, na branch `cq/…` |
| Pode perguntar? | sim | **não** — não há ninguém para responder |

O que você escreve no painel **vira o prompt do segundo**. É por isso que a ferramenta **recusa
tarefa vaga**: sem objetivo, arquivos, critério de pronto e como testar, ela devolve erro. Chato de
propósito — a conversa torna fácil demais enfileirar qualquer coisa, e tarefa vaga desperdiça cota.

**O painel não executa a fila.** Ele compõe, lista, reordena e remove. Quem decide quando rodar
continua sendo o agendador, obedecendo o porteiro.

Para tirar: **Claude in Line: Desconectar do painel do Claude Code**.

## Como o medidor funciona

O medidor combina, nesta ordem de preferência:

1. **O uso oficial da conta**, que o painel do Claude Code busca sozinho a cada poucos minutos e
   guarda em `~/.claude.json`. São os mesmos números da tela **Account & Usage**. É a fonte
   principal, e não exige nada de você além de usar o painel.
2. **Snapshots da statusline**, gravados sempre que você usa `claude` num terminal. Não são mais
   obrigatórios, mas continuam valendo: a leitura mais nova ganha, venha de onde vier.
3. **Tokens de todas as sessões** — painel, terminal e as execuções da fila — lidos dos
   transcripts em `~/.claude/projects`, para estimar o consumo entre uma leitura e a seguinte.
4. **Calibração**: comparando duas leituras da mesma janela com diferença de pelo menos 2 pontos,
   e os tokens gastos entre elas, a extensão aprende quantos pontos percentuais custa cada milhão
   de tokens. O fator é a média das últimas 8 amostras, e cada janela calibra separado.

Enquanto não houver calibração, a fila é conservadora: **uma tarefa por ciclo**, e ela bloqueia se
a última leitura tiver mais de 180 minutos.

O tooltip da barra de status diz sempre de onde veio o número: leitura direta, estimativa
calibrada ou desatualizado.

> O campo que o Claude Code usa para guardar o uso é estado interno dele, não uma interface
> publicada. Se ele mudar numa versão futura, a extensão volta a depender da statusline e da
> estimativa — e o aviso aparece na tela. A extensão nunca escreve nesse arquivo.
## O porteiro

Antes de cada tarefa, a extensão checa, nesta ordem:

| Checagem | Configuração |
|---|---|
| Freio ativo por aviso ou recusa do Claude Code | — |
| Horário permitido | `allowedHours` |
| Teto semanal (100% − reserva) | `reservePct` |
| Orçamento do dia | `dailyBudget.*` |
| Janela de 5h | `fiveHourMaxPct` |

**Orçamento dinâmico** (padrão) é `(teto − uso no início do dia) ÷ dias até o reset semanal`, recalculado todo dia. Um dia parado não queima cota: aumenta o teto de amanhã. Seu **uso manual conta no mesmo orçamento** — é por isso que o modo dinâmico é o padrão, e não um percentual fixo por dia (15% fixos somariam 105% na semana).

**Por dia da semana.** Na tela de configurações (seção **Por dia da semana**) dá para ajustar segunda a
domingo individualmente: um horário permitido e/ou um percentual fixo da semana, que **substituem**
`allowedHours`/`dailyBudget` só naquele dia. Dia sem nada preenchido segue o geral, sem mudar nada — é
o valor de fábrica. Dá para preencher só o horário, só o percentual, ou os dois.

**Freio.** Se o Claude Code avisar que o limite está perto (`allowed_warning`), a fila pausa por até 6 horas ou até o reset, e a tarefa atual termina (ou é interrompida, se `onWarning` for `abort`). Se ele recusar (`rejected`), o processo é morto e a fila pausa até o reset.

## Isolamento

Cada tarefa roda numa `git worktree` separada, em `~/.cq/worktrees/`, na branch `cq/<id>`. O prompt leva as regras de isolamento junto: trabalhar só naquele diretório, não fazer push, não trocar de branch, não commitar. O modo de permissão é `dontAsk` com a lista fechada de `allowedTools` — o que não estiver na lista é negado.

Ao final, a extensão commita tudo (`cq:` se deu certo, `cq(wip):` se falhou ou foi cancelada) e remove a worktree. **Branch sem alteração nenhuma é apagada**, para não poluir o repositório.

A extensão **nunca** usa `--dangerously-skip-permissions`, nunca faz push e nunca mexe em remotos.

## O nome das branches

O padrão é `Dev_Branches/{data}/{slug}`, que produz:

```
Dev_Branches/
  2026-09-29/
    regime-invalido-na-listagem-devolve-400
    validar-data-futura-em-lancamento
  2026-09-30/
    corrigir-filtro-competencia
```

A `/` cria níveis de verdade no git, então o VS Code e o `git branch` mostram isso como árvore de
pastas. A data invertida ordena sozinha, em ordem cronológica.

Dá para mudar em `claudeQueue.branchTemplate`, e a tela de configuração mostra a prévia enquanto
você digita. Marcadores: `{data}`, `{hora}`, `{repo}`, `{slug}` e `{id}`.

Duas coisas que valem saber:

- **A data é a da execução**, não a de quando você enfileirou — é quando a branch nasce.
- **Evite data com barras.** `{repo}-29/09/26` não quebra, mas vira três níveis de pasta sem você
  querer, e o git não deixa coexistir uma branch `a/b` com uma branch `a/b/c`.

## Lotes: uma entrega, uma branch

Tarefa avulsa nasce numa branch própria. Isso isola trabalhos independentes, mas quando as
tarefas são partes de um conjunto — um site: página, SEO, imagem — você fica com várias
branches para juntar à mão, o mesmo conflito repetido em cada uma, e nenhuma tarefa enxerga o
que a outra fez.

Para isso existe o **lote**. Ao enfileirar pelo painel do Claude Code, peça que as tarefas
entrem no mesmo lote (o parâmetro `lote` do `enfileirar_tarefa`). Então:

- **Rodam em sequência, na ordem em que entraram**, sobre uma branch só:
  `Dev_Branches/2026-09-30/pagina-de-vendas` no modelo padrão, com `{slug}` virando o nome do lote.
- **Cada tarefa vira um commit.** Você revisa uma branch, commit a commit, e pode desfazer um sem perder o resto.
- **Cada tarefa enxerga as anteriores.** O prompt diz quais já foram commitadas e pede para construir sobre elas.
- **Cada uma mantém o próprio modelo.** Um lote pode ter uma tarefa em opus e outra em haiku.
- **Mesmo repositório e mesma base**, conferidos na hora de enfileirar — não horas depois, quando a fila rodar.
- **A ordem do lote vale mais que a prioridade**: a tarefa seguinte pode depender da anterior.

### Quando uma tarefa do lote falha

1. **O trabalho parcial dela não entra na branch do lote.** Vai para uma branch à parte,
   `…-falha-<tarefa>`, em cima do que as anteriores fizeram, para você olhar.
2. **As seguintes param.** O lote fica **bloqueado** e a fila não decide sozinha, porque elas podem
   depender da que falhou. Tarefas fora do lote continuam rodando.
3. **Um relatório da falha** (`falha.md`) conta, em um minuto de leitura: o motivo, o que o modelo
   disse por último, os comandos negados, os erros de ferramenta, o que ficou e onde, e quais
   tarefas do lote estão paradas.
4. **Você escolhe**, com o botão direito na tarefa com falha:
   - **Tentar de novo** — ela volta para a fila e o lote continua de onde parou. Ajuste o pedido antes, se for o caso.
   - **Pular no lote** — o lote segue sem ela.
   - **Cancelar lote** — nada mais roda; as pendentes vão para Com falha, e a branch fica com o que já foi commitado.

**Exceção: bloqueio só por limite (janela de 5h ou semana) não espera você.** Quando o próprio
Claude Code recusa a chamada por ter batido no teto — não um problema da tarefa — a fila sabe
distinguir isso, e assim que o orçamento libera de novo ela já devolve a tarefa para a fila e
destrava o lote sozinha, sem precisar de **Tentar de novo**. Bloqueio por qualquer outro motivo
(teste quebrado, ferramenta negada, o que for) continua esperando sua decisão — é inevitável não
dar pra saber, só pelo tipo de erro, se repetir o mesmo pedido resolve ou repete o problema.

### Revisando um lote

O grupo **Lotes** mostra cada lote com as tarefas dentro, na ordem, com o commit de cada uma.
Clicar no lote abre o **relatório do lote**: estado, branch, uma linha por tarefa (situação,
commit, arquivos, comandos negados) e os comandos git para revisar. No menu do lote: **Ver diff
do lote** (a base contra a branch inteira) e **Fazer checkout da branch do lote**. Na tarefa,
**Ver diff** mostra só o commit dela.

**Enquanto a branch do lote estiver em checkout, a próxima tarefa espera** — o git não abre uma
worktree numa branch em uso. Isso não é falha: a fila avisa no log e retoma quando você sair dela.

### A análise do lote

Quando o lote termina, a notificação oferece **Ver análise do lote**. É o relatório para quem vai
revisar e juntar:

- **Consumo**: por tarefa e somado — tokens (entrada, saída, cache, raciocínio), custo equivalente
  em API e **pontos estimados da semana e da janela de 5h**, pela mesma calibração do medidor. Ao
  lado, a variação medida da semana durante o lote, que inclui qualquer outro uso da conta.
- **Por modelo**: opus, sonnet e haiku lado a lado, para saber se a escolha de modelo por tarefa valeu.
- **O que cada tarefa fez**: o começo da resposta final, os arquivos com `+/-`, e os **comandos que
  ela rodou, com o resultado** — é o que responde "ela testou mesmo?".
- **Pontos de atenção**: tarefa que concluiu sem nenhum comando que passasse, comando que falhou ou
  foi negado, e arquivo alterado por mais de uma tarefa.

No menu do lote, **Copiar descrição de PR** leva o que foi feito e como foi verificado, sem a
contabilidade. A análise de um lote bloqueado ou cancelado também sai pelo menu, a qualquer momento.

## Limpando o histórico

**Limpar histórico…**, no menu `···` do topo do painel, pergunta três coisas:

1. **O quê**: concluídas, com falha, lotes encerrados e pendentes. Pendentes vem desmarcado: é
   trabalho pedido e ainda não feito.
2. **Como**: **arquivar** (recomendado) move para `~/.cq/arquivo/<data>/`, de onde dá para consultar
   ou recuperar; **apagar de vez** pede confirmação.
3. **Branches**: se alguma branch criada pela fila já estiver inteira na base, ela é oferecida para
   apagar junto. Só essas: o git confirma que nada se perde. Esc mantém todas.

Lote em andamento ou bloqueado nunca entra, nem as tarefas dele. O medidor e a calibração também
não. Com a fila executando, a limpeza espera. **Esvaziar arquivo** apaga o que foi arquivado.

Para não precisar lembrar, `claudeQueue.retencaoDias` arquiva sozinho, uma vez por dia, o que tiver
mais de N dias. O padrão é 0, desligado.

**Grupo Arquivo**, abaixo de Com falha na árvore, mostra os últimos 50 itens arquivados (manual ou
pela retenção), mais recente primeiro — título, se era concluída/com falha/pendente/lote, e a data
em que saiu. Só para consultar: sem ação nenhuma, já que o item não está mais na fila. Para abrir o
que ficou (o `.md`, o resultado, o relatório do lote), vá até `~/.cq/arquivo/<data>/`.

## Revisando o que a fila fez

Menu de contexto na tarefa concluída:

- **Ver resultado** — o resumo da execução e a resposta final do Claude. Se algum comando foi
  negado, ele aparece listado ali: a tarefa pode ter terminado sem rodar a verificação pedida.
- **Ver diff** — um arquivo alterado abre no comparador lado a lado; vários abrem como um diff em texto.
- **Fazer checkout da branch** — recusa se houver alteração não commitada no repositório.
- **Apagar branch** — com confirmação, porque não há push e portanto não há cópia em lugar nenhum.

Nas tarefas com falha: **Ver relatório da falha** (clicar na tarefa abre direto), **Ver log** (o
`stderr`, ou o stream de eventos cru) e **Tentar de novo**, que devolve a tarefa para a fila.

**Escrever fora da worktree é falha.** O prompt informa o caminho absoluto da worktree, e ao fim
a fila confere no registro da execução se alguma escrita caiu fora dela. Antes, uma tarefa assim
saía como "concluída, 0 arquivos", com o arquivo perdido numa pasta que nenhuma branch vê.

## Configurações

A forma amigável é o painel: **Claude in Line: Configurações**, ou a engrenagem no topo da view.
Ele agrupa tudo por assunto, mostra o medidor e calcula ao vivo o efeito de mexer na reserva ou
no teto. A tabela abaixo é a referência; tudo ali também aparece na tela nativa do VS Code.


| Configuração | Padrão | O que faz |
|---|---|---|
| `claudeQueue.intervalMinutes` | 20 | intervalo do agendador interno |
| `claudeQueue.reservePct` | 25 | % da semana que a fila nunca usa |
| `claudeQueue.dailyBudget.mode` | `dynamic` | `dynamic` ou `fixed` |
| `claudeQueue.dailyBudget.fixedPct` | 15 | usado só no modo `fixed` |
| `claudeQueue.fiveHourMaxPct` | 60 | teto da janela de 5h para a fila |
| `claudeQueue.allowedHours` | `[]` | ex.: `[[0,7],[12,14]]`; vazio = qualquer hora |
| `claudeQueue.weekdayOverrides` | 7 posições `null` | ajuste por dia (índice 0=domingo…6=sábado); editar pelo painel, seção **Por dia da semana** |
| `claudeQueue.maxTasksPerRun` | 3 | tarefas por ciclo (1 enquanto não houver calibração) |
| `claudeQueue.onWarning` | `finish` | no aviso de limite: terminar ou abortar a tarefa atual |
| `claudeQueue.defaults.model` | `sonnet` | modelo padrão das tarefas novas |
| `claudeQueue.defaults.maxTurns` | 40 | |
| `claudeQueue.defaults.timeoutMin` | 45 | |
| `claudeQueue.defaults.allowedTools` | Read, Edit, Write, Glob, Grep, git status/diff/log, `mvn -q test` | |
| `claudeQueue.claudePath` | `""` | vazio = autodetectar com `where claude` |
| `claudeQueue.dataDir` | `""` | vazio = `~/.cq`; mudar exige recarregar a janela |
| `claudeQueue.retencaoDias` | 0 | arquivar sozinho o histórico com mais de N dias; 0 desliga |

Essas configurações substituem o `config.json` da CLI. O `config.json` continua sendo lido como fallback para o que não aparece aqui: `maxSnapshotAgeMin`, `warningPauseHours`, `tokenWeights` e `modelWeights`.

`onWarning` é decisão do ciclo, não da tarefa: escrever `onWarning: abort` no frontmatter de um `.md` não tem efeito.

## Limitações conhecidas

- **Nada roda com o VS Code fechado.** É a decisão de projeto, não um defeito. Para operar com tudo fechado existe a CLI `cq schedule install`, que usa a mesma pasta `~/.cq` e o mesmo lock — as duas não se atropelam.
- **Fechar o VS Code encerra a tarefa em andamento.** O processo é morto, o que já foi escrito vira commit `cq(wip):` e a tarefa vai para **Com falha** com o motivo "VS Code fechado". Use **Tentar de novo**. A alternativa seria deixar o `claude` órfão, gastando cota sem ninguém para commitar nem remover a worktree.
- **O medidor precisa do terminal para ter verdade de campo.** Use `claude` num terminal de vez em quando — uma vez por dia basta. Sem isso a leitura envelhece e, sem calibração, a fila para.
- **Uso no claude.ai (web ou app) não aparece nos transcripts locais**, mas consome o mesmo limite. A calibração absorve isso como média, o que deixa a estimativa mais conservadora.
- **Cobrança do modo headless.** Hoje o `claude -p` consome os limites da assinatura. Se a Anthropic voltar a separar esse uso, a fila passa a consumir outro saldo.
- **Trocar `claudeQueue.dataDir` exige recarregar a janela.** Os observadores de arquivo e o lock apontam para o caminho resolvido na ativação.
- **Tarefa vaga desperdiça cota.** Escreva cada uma como um card: objetivo, arquivos, critério de pronto e como testar.

## Onde ficam os arquivos

| Caminho | Conteúdo |
|---|---|
| `~/.cq/queue`, `done`, `failed` | as tarefas, como arquivos `.md` |
| `~/.cq/runs/<id>/` | `stream.jsonl`, `result.md`, `detalhes.json` (comandos rodados), `stderr.txt` e, na falha, `falha.md` |
| `~/.cq/lotes/` | `<lote>.json` (estado, branch, commits), `<lote>.md` (o relatório) e `<lote>-analise.md` |
| `~/.cq/arquivo/<data>/` | o que foi arquivado pela limpeza, com a mesma estrutura |
| `~/.cq/ledger.jsonl` | histórico de execuções |
| `~/.cq/snapshots.jsonl` | histórico de leituras do medidor |
| `~/.cq/usage.json` | última leitura |
| `~/.cq/statusline.js` | o script do medidor |
| `~/.cq/cq.log` | log |

**Claude in Line: Abrir pasta de dados** abre isso no explorador.

## Desenvolvimento

```powershell
npm install
npm run check     # TypeScript strict
npm run test      # 43 testes: núcleo + integração com o simulador
npm run build     # esbuild: out/extension.js e out/statusline.js
npm run package   # gera o .vsix
```

Os testes de integração usam `test/fake-claude.js`, que simula o `claude -p` nos modos `ok`, `warning`, `rejected` e `hang`. Nenhum teste chama o `claude` de verdade nem toca no seu `~/.claude/settings.json`.
