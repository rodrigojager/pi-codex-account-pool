# pi-codex-account-pool

Pool de contas ChatGPT Plus/Pro via OAuth exposto como provider próprio `codex-account-pool` no Pi.

> Use somente contas e assinaturas que você está autorizado a usar. Tokens ficam locais em `~/.pi/agent/codex-account-pool/accounts.json`.

## Recursos

- Provider separado `codex-account-pool`, sem sobrescrever `openai-codex`.
- Catálogo oficial e dinâmico de modelos Codex, visível diretamente em `/model`.
- Catálogo aditivo de três fontes independentes: modelos do Pi (`openai-codex` e `models-store.json`), cache local do Codex CLI (`$CODEX_HOME/models_cache.json` ou `~/.codex/models_cache.json`) e catálogo oficial Codex por conta autenticada (`chatgpt.com/backend-api/codex/models`). O catálogo oficial é consultado ao iniciar (TTL de 4 horas) e manualmente com `/codex-pool-models-refresh`; o cache do CLI é relido quando muda. Só modelos visíveis e compatíveis com a API são adicionados. A disponibilidade efetiva depende da conta autenticada.
- Várias contas ChatGPT com login Browser OAuth ou Device Code.
- Importação automática da conta OAuth já autenticada no Pi.
- Conta sticky por sessão do Pi.
- Renovação automática de tokens.
- Rotação imediata para outra conta após falhas 401/403/429/5xx, com repetição da mesma solicitação.
- Compatibilidade com os transportes SSE e WebSocket do Codex.
- Seleção de conta pelo TUI e ferramentas para o agente.
- Estado separado por projeto/sessão, sem expor tokens ao modelo.
- Summarizer configurável com qualquer provider/modelo disponível no Pi.
- Lista de fallbacks para o summarizer; se o primary falhar, o próximo modelo é tentado.
- Opções por modelo para o summarizer: reasoning, máximo de tokens, temperature, timeout e parâmetros de sampling em JSON.
- Limite configurável do contexto enviado ao summarizer.
- Handoff manual para uma nova sessão, independente da troca de conta.
- Consulta de quota, rotação preventiva e espera persistida por reset de quota.
- Notas duráveis, trimming do contexto após handoff e ferramentas completas de administração.

## Instalação

```bash
pi install git:github.com/rodrigojager/pi-codex-account-pool
```

Depois reinicie o Pi ou execute `/reload`.

## Compatibilidade com o Pi

O pool usa o transporte, o catálogo e a normalização de contexto fornecidos pelo
Pi em execução, através da API pública disponibilizada às extensões. Não seleciona
o comportamento pelo número da versão e não importa uma cópia privada dos módulos
internos de transporte. As dependências Pi de desenvolvimento servem aos testes;
em produção, o host fornece essas APIs.

São aceitos tanto `systemPrompt`/`tools` quanto mensagens de sistema com
`sections`, `toolsAdded` e `toolsRemoved`. Instruções e ferramentas também são
preservadas quando o handoff encurta o histórico. O transporte do host mantém as
atualizações de sistema no decorrer da conversa quando o modelo as suporta.

A matriz de regressão cobre Pi 0.85.1 e 0.86.1 com captura offline do payload real,
sem credenciais ou chamadas de rede. Atualizações que preservem essas capacidades
públicas não exigem uma nova regra por versão. Uma futura quebra da API do Pi ou
do protocolo do serviço poderá exigir adaptação; capacidades obrigatórias ausentes
produzem um erro explícito ao carregar a extensão.

## Uso

```text
/codex-accounts
/codex-account-add
/codex-handoff-config
/codex-handoff [próximo objetivo opcional]
```

`/codex-handoff-config` lista dinamicamente todos os modelos autenticados/configurados no Pi. Escolha um modelo primary e os fallbacks; eles podem ser de providers diferentes (OpenAI, Anthropic, Google, OpenRouter, extensões de terceiros etc.). Modelos adicionados por outra extensão, como `opencode-free`, aparecem automaticamente no seletor — não existe uma lista fixa no pool.

O mesmo configurador permite definir opções independentes por modelo: nível de reasoning (`auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh` ou `max`), máximo de tokens, temperature, timeout e parâmetros avançados de sampling em JSON. Também é possível limitar o número de caracteres da conversa enviados ao summarizer e restaurar as opções padrão de um modelo.

Quando uma conta Codex falha antes de começar a resposta, a extensão repete a mesma solicitação com a próxima conta disponível. Não é necessário gerar resumo nem trocar de sessão, pois o modelo e o histórico continuam os mesmos.

O summarizer é usado somente pelo comando manual `/codex-handoff`. Ele tenta o modelo principal e, se necessário, cada fallback configurado.

Em `/model`, escolha entradas como `codex-account-pool/gpt-6.1-sol`. O provider original `openai-codex` continua disponível separadamente. O Codex CLI é opcional: o pool consulta diretamente, com o OAuth das contas já cadastradas, o catálogo do backend usado pelo cliente oficial. Só metadados públicos dos modelos são salvos em `~/.pi/agent/codex-account-pool/official-models.json`; nenhum token é salvo nesse arquivo. Se o endpoint falhar, mantém o catálogo anterior. O backend filtra por versão do cliente; sem CLI usa `0.159.0` como versão-base, ajustável por `PI_CODEX_MODEL_CLIENT_VERSION`. `GET https://api.openai.com/v1/models` usa uma **chave de API separada** e lista modelos de API, que não são necessariamente aceitos pelo Codex/ChatGPT; não são misturados ao pool.

No menu, adicione as contas e escolha **Usar nesta sessão**. O agente também pode usar:

- `codex_accounts_list`
- `codex_account_current`
- `codex_account_set_active`

A extensão registra um provider independente e não altera autenticação, modelos ou streams de `openai`, `openai-codex`, OpenRouter, OpenCode ou outros providers.

Quando a versão `rodrigojager/pi-check-agent-quota` está instalada, as duas extensões usam o event bus do Pi para exibir a quota da conta realmente ativa. Tokens nunca são enviados pelo event bus; somente identidade local, rótulo e snapshot sanitizado de quota.

### Usage ao vivo

Atualize **os dois forks** (`pi-codex-account-pool` e `pi-check-agent-quota`). A barra recebe imediatamente cada nova leitura do pool, inclusive refresh manual e erro 429. Enquanto o provider do pool estiver selecionado, consulta a conta ativa aproximadamente a cada **15 segundos durante execução** e **60 segundos em repouso**, sem precisar de `/aqauto`. Também consulta ao terminar cada turno com ferramentas e força uma leitura ao encerrar a tarefa.

O cache do pool dura 15 segundos e requisições simultâneas para a mesma conta são agrupadas. O horário exibido é o da leitura original, não o da reutilização do cache. Uma resposta atrasada da conta anterior não pode substituir a conta ativa. Falhas de consulta ficam visíveis também durante execução; a atualização ainda depende da rede e da disponibilidade/atualização do endpoint do ChatGPT.

`Usage` indica a porcentagem **usada** (100% usada = 0% restante). `/checkaq` força uma consulta imediata.

```bash
pi update https://github.com/rodrigojager/pi-codex-account-pool
pi update https://github.com/rodrigojager/pi-check-agent-quota
```

Depois execute `/reload`.

Comandos adicionais:

```text
/codex-handoff-status
/codex-waiting
/codex-waiting cancel
```

Variáveis opcionais:

```bash
PI_CODEX_QUOTA_ENDPOINT=https://chatgpt.com/backend-api/wham/usage
# desativa a importação automática da conta OAuth já salva no Pi
PI_CODEX_ACCOUNT_POOL_IMPORT_AUTH=0
```

Diretório de dados alternativo:

```bash
PI_CODEX_ACCOUNT_POOL_DATA_DIR=/caminho/seguro pi
```

## Desenvolvimento

```bash
npm install
npm test
pi -e ./src/index.ts
```

## Diferenças em relação ao plugin OpenCode

O provider Codex monta os headers de autenticação depois dos hooks genéricos e o transporte WebSocket não emite todas as respostas HTTP para extensões. Por isso, o provider próprio `codex-account-pool` registra um wrapper do stream `openai-codex-responses`, injeta o token selecionado diretamente na chamada e controla o failover antes de qualquer conteúdo ser emitido. A seleção continua isolada por sessão e os tokens permanecem fora do contexto enviado ao modelo.
