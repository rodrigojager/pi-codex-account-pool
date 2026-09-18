# pi-codex-account-pool

Pool de contas ChatGPT Plus/Pro via OAuth exposto como provider próprio `codex-account-pool` no Pi.

> Use somente contas e assinaturas que você está autorizado a usar. Tokens ficam locais em `~/.pi/agent/codex-account-pool/accounts.json`.

## Recursos

- Provider separado `codex-account-pool`, sem sobrescrever `openai-codex`.
- Catálogo oficial e dinâmico de modelos Codex, visível diretamente em `/model`.
- Espelhamento do catálogo efetivo de `openai-codex` e do `models-store.json`, com fallback offline embarcado.
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

Em `/model`, escolha entradas como `codex-account-pool/gpt-5.6-luna`. O provider original `openai-codex` continua disponível separadamente.

No menu, adicione as contas e escolha **Usar nesta sessão**. O agente também pode usar:

- `codex_accounts_list`
- `codex_account_current`
- `codex_account_set_active`

A extensão registra um provider independente e não altera autenticação, modelos ou streams de `openai`, `openai-codex`, OpenRouter, OpenCode ou outros providers.

Quando a versão `rodrigojager/pi-check-agent-quota` está instalada, as duas extensões usam o event bus do Pi para exibir a quota da conta realmente ativa. Tokens nunca são enviados pelo event bus; somente identidade local, rótulo e snapshot sanitizado de quota.

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
