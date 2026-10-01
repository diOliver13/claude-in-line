# Roteiro de teste manual — Claude in Line 0.2.0

Doze passos, na ordem. Cada um diz **o que fazer** e **o que tem que acontecer**. Se algum falhar, pare nele: os seguintes dependem do anterior.

Antes de começar, tenha à mão um repositório git pequeno, com tudo commitado, para servir de cobaia.

---

## 1. Instalar

```powershell
code --install-extension claude-queue-0.2.0.vsix
```

Feche e reabra o VS Code.

**Esperado:** um ícone novo na barra de atividades (à esquerda). Clicando nele, a view **Fila** com os quatro grupos: Pendentes, Em execução, Concluídas, Com falha — todos em `(0)`.

Na barra de status, à direita, algo como `sem leitura · fila 0`.

---

## 2. Ver o estado inicial

Clique no item da barra de status.

**Esperado:** o painel **Output** abre no canal "Claude in Line" com o relatório. Nas duas janelas deve aparecer `sem leitura`, e no fim:

```
Decisão agora: AGUARDAR
  - sem leitura de uso ainda: abra `claude` num terminal ...
```

Isso confirma que a fila **não roda sem medidor** — que é o comportamento certo.

---

## 3. Configurar o medidor

`Ctrl+Shift+P` → **Claude in Line: Configurar medidor (statusline)**.

**Esperado, em ordem:**

1. Abre um documento em modo diff mostrando o que vai mudar em `~/.claude/settings.json` — com `- (não existe)` se você ainda não tinha statusline, ou com o valor atual se tinha.
2. Uma caixa **modal** perguntando se pode alterar, com o comando completo no detalhe.
3. Ao confirmar, a mensagem "Medidor configurado" com o botão **Abrir terminal**.

**Confira à mão:**

- `~/.cq/statusline.js` existe.
- `~/.claude/settings.json` tem o bloco `statusLine` apontando para ele, com o caminho do `node` do PATH (não o `code.exe`).
- Se o arquivo já existia, há um `settings.json.bak-<data>` ao lado.

**Teste a recusa também:** rode o comando de novo e clique em **Cancelar** na modal. Nada pode mudar no `settings.json`.

---

## 4. Gerar a primeira leitura

Abra o terminal integrado, rode `claude`, mande uma mensagem curta ("oi" serve) e saia.

**Esperado:** a barra de status passa a mostrar percentuais reais, tipo `5h 4% · 7d 12% · fila 0`.

Passe o mouse por cima. O tooltip deve mostrar as duas janelas com tempo até o reset, a origem como **leitura direta**, a idade do snapshot, o orçamento de hoje e a decisão.

Se continuar em `sem leitura`, o medidor não está ligado — volte ao passo 3.

---

## 5. Criar uma tarefa

Abra o repositório cobaia. `Ctrl+Shift+P` → **Claude in Line: Adicionar tarefa**.

Título: `Escrever um arquivo de teste`. Escolha o repositório.

**Esperado:** abre um `.md` com o frontmatter preenchido (title, repo, priority, model, maxTurns, timeoutMin, allowedTools) e o corpo com as quatro seções vazias.

**Salve sem preencher nada** (`Ctrl+S`).

**Esperado:** um aviso dizendo que a tarefa **não** entrou na fila porque o corpo ainda é só o modelo. A fila continua em 0. *(Esse é o ponto: rascunho pela metade não vira tarefa.)*

Agora escreva algo concreto no Objetivo, por exemplo:

```
## Objetivo
Crie um arquivo NOTAS.md na raiz com três linhas explicando o que este repositório faz.
```

Salve de novo.

**Esperado:** notificação "Na fila: Escrever um arquivo de teste". O grupo **Pendentes** vai para `(1)`, com o item mostrando `<repo> · sonnet · p3`. A barra de status mostra `fila 1`.

---

## 6. Mexer na fila sem executar

No item da tarefa, botão direito.

**Esperado:** o menu tem Executar agora, Editar, Subir prioridade, Descer prioridade, Remover.

- **Subir prioridade** duas vezes → a descrição do item vira `p1`.
- **Editar** → abre o `.md` da tarefa, agora em `~/.cq/queue/`.

Crie uma segunda tarefa qualquer e confirme que **a de p1 aparece acima** da de p3.

---

## 7. Pausar e retomar

Botão **Pausar fila** no topo da view (ícone de pause).

**Esperado:** a barra de status ganha o prefixo `⏸`. O botão vira **Retomar fila**.

Rode **Claude in Line: Executar agora**.

**Esperado:** uma modal "O porteiro segurou a fila" listando `fila pausada manualmente` entre os motivos, com o botão **Forçar próxima tarefa**. **Clique em Cancelar** — nada deve executar.

Retome a fila. O `⏸` some.

**Confira que a pausa persiste:** pause, feche o VS Code, reabra. O `⏸` tem que estar lá. Retome.

---

## 8. Executar de verdade

**Claude in Line: Executar agora**.

**Esperado:**

- A barra de status ganha `⟳ Escrever um arquivo…`, o grupo **Em execução** vai para `(1)` e **Pendentes** cai para `(1)`.
- Aparece um indicador de progresso discreto na barra.
- O canal Output mostra `→ Escrever um arquivo de teste  [semana X%, hoje Y% de Z%]`.
- **A interface continua respondendo** o tempo todo — role um arquivo, digite em algum lugar. Se travar, é defeito.
- Ao terminar, uma notificação: `✓ Escrever um arquivo de teste — 1 arquivo(s) alterado(s) na branch cq/<id>`, com os botões **Ver diff**, **Ver resultado** e **Checkout**.

**Confira no repositório:**

```powershell
git branch --list "cq/*"
git log -1 --format=%s cq/<id>      # tem que começar com "cq: "
git status                          # limpo: você continua na sua branch
```

E que `~/.cq/worktrees/` está **vazia** — a worktree foi removida.

---

## 9. Revisar o resultado

Na tarefa agora em **Concluídas**:

- **Ver diff** → como só um arquivo mudou, tem que abrir o **comparador lado a lado**, base à esquerda e branch à direita.
- **Ver resultado** → abre o `result.md` com status, branch, arquivos alterados, turnos, custo e a resposta final do Claude.
- **Fazer checkout da branch** → você vai para `cq/<id>`. Confirme com `git branch --show-current`.
- Volte para a sua branch (`git checkout main`) e use **Apagar branch**. Deve pedir confirmação modal antes.

**Teste a recusa útil:** com a branch `cq/<id>` ainda existindo, faça uma alteração qualquer no repositório **sem commitar** e tente **Fazer checkout da branch**. Tem que recusar, avisando que há alteração não commitada.

---

## 10. Cancelar, e o fechamento do VS Code

Crie uma tarefa deliberadamente longa (por exemplo: "leia todos os arquivos do projeto e escreva um resumo de cada um"). Execute.

Com ela rodando, botão direito no item em **Em execução** → **Cancelar**.

**Esperado:** modal avisando que o que já foi escrito vira commit `cq(wip):`. Ao confirmar:

- A tarefa aparece em **Com falha**.
- `git log -1 --format=%s cq/<id>` começa com `cq(wip):` — ou a branch foi apagada, se nada tinha sido escrito ainda.
- `~/.cq/worktrees/` está vazia.
- **Tentar de novo** devolve a tarefa para Pendentes.

**Agora o fechamento:** execute a tarefa longa de novo e, com ela rodando, **feche o VS Code**. Reabra.

**Esperado:** a tarefa está em **Com falha** com o motivo `VS Code fechado`, a worktree foi removida e não sobrou nenhum processo `claude` no Gerenciador de Tarefas.

---

## 11. Lote

No painel do Claude Code, peça duas tarefas pequenas **no mesmo lote**, por exemplo `cobaia`: a primeira cria `a.txt`, a segunda cria `b.txt` e diz na resposta se `a.txt` já existia.

**Esperado ao enfileirar:** a resposta diz "tarefa 1 do lote cobaia" e depois "tarefa 2". O grupo **Lotes** aparece na árvore com as duas dentro, numeradas, e elas **não** aparecem em Pendentes.

Execute a fila (uma tarefa por ciclo, se o medidor ainda não calibrou).

**Esperado:**

- Uma branch só, `Dev_Branches/<data>/cobaia`, com dois commits: `git log --oneline main..Dev_Branches/<data>/cobaia`.
- A segunda tarefa diz que `a.txt` já existia.
- O lote fica **concluído**; clicar nele abre o relatório com as duas linhas e os commits.
- Na tarefa 2, **Ver diff** mostra só `b.txt`.

**Agora a falha:** enfileire mais duas no mesmo lote, a primeira com um pedido impossível de verificar (por exemplo, "rode um comando que não está liberado e falhe se ele não rodar").

**Esperado:** a primeira falha; a notificação diz "Lote cobaia parado com 1 tarefa(s) esperando"; clicar nela abre o **relatório da falha**, com o motivo e o comando negado; a branch do lote continua com os mesmos dois commits; com o botão direito, **Pular no lote** faz a última rodar.

**E a análise:** na notificação de lote concluído, **Ver análise do lote**.

**Esperado:** a análise tem o consumo das duas tarefas, uma linha por modelo, os comandos que cada uma rodou com ✓ ou ✗, e, em Pontos de atenção, as tarefas que concluíram sem rodar comando nenhum. **Copiar descrição de PR** põe um texto sem valores de consumo na área de transferência.

---

## 12. Limpar o histórico

No menu `···` do painel: **Limpar histórico…**. Deixe marcadas Concluídas e Lotes encerrados, escolha **Arquivar**.

**Esperado:** o painel fica sem Concluídas e sem o lote `cobaia`; `~/.cq/arquivo/<data>/` tem `done/`, `runs/`, `lotes/` e um `limpeza-<hora>.json`; o medidor na barra de status não muda. Se a branch do lote já tiver sido juntada à `main`, o terceiro passo a oferece para apagar; se não, ele nem aparece.

---

## Se algo der errado

- **Canal Output "Claude in Line"** — tem o log da sessão.
- **`~/.cq/cq.log`** — o log que sobrevive ao fechamento.
- **`~/.cq/runs/<id>/falha.md`** — o relatório da falha, legível.
- **`~/.cq/runs/<id>/stderr.txt`** e **`stream.jsonl`** — o que o `claude` disse, cru.
- **Claude in Line: Mostrar status** — o estado do medidor e todos os motivos de bloqueio.
