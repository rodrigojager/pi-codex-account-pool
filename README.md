# pi-codex-account-pool

Pool de contas ChatGPT Plus/Pro via OAuth para o provider `openai-codex` do Pi.

> Use somente contas e assinaturas que você está autorizado a usar. Tokens ficam locais em `~/.pi/agent/codex-account-pool/accounts.json`.

## Recursos

- Várias contas ChatGPT com login Browser OAuth ou Device Code.
- Conta sticky por sessão do Pi.
- Renovação automática de tokens.
- Rotação para outra conta após falhas 401/403/429/5xx.
- Seleção de conta pelo TUI e ferramentas para o agente.
- Estado separado por projeto/sessão, sem expor tokens ao modelo.
- Summarizer configurável com qualquer provider/modelo disponível no Pi.
- Lista de fallbacks para o summarizer; se o primary falhar, o próximo modelo é tentado.
- Handoff automático quando o failover troca a conta Codex, além de handoff manual para uma nova sessão.
- Consulta de quota, failover preventivo e espera persistida por reset de quota.
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

`/codex-handoff-config` lista todos os modelos autenticados/configurados no Pi. Escolha um modelo primary e informe fallbacks no formato `provider/model,provider/model`. Esses modelos podem ser de providers diferentes (OpenAI, Anthropic, Google, OpenRouter etc.).

Quando uma conta Codex falha e outra é selecionada, o plugin gera um resumo usando o primary e tenta cada fallback configurado. O handoff pendente é injetado no próximo request sem apagar o histórico da sessão.

No menu, adicione as contas e escolha **Usar nesta sessão**. O agente também pode usar:

- `codex_accounts_list`
- `codex_account_current`
- `codex_account_set_active`

Por segurança, a extensão só intercepta o provider `openai-codex`. Para incluir outro provider explicitamente:

```bash
PI_CODEX_ACCOUNT_POOL_PROVIDERS=openai-codex,meu-provider pi
```

Comandos adicionais:

```text
/codex-handoff-status
/codex-waiting
/codex-waiting cancel
```

Variáveis opcionais:

```bash
PI_CODEX_QUOTA_ENDPOINT=https://chatgpt.com/backend-api/wham/usage
```

Diretório de dados alternativo:

```bash
PI_CODEX_ACCOUNT_POOL_DATA_DIR=/caminho/seguro pi
```

## Desenvolvimento

```bash
npm install
npm run typecheck
pi -e ./src/index.ts
```

## Diferenças em relação ao plugin OpenCode

O Pi não expõe uma camada `fetch` substituível por plugin nem o mesmo sistema de TUI/provider hooks do OpenCode. Esta versão usa os hooks `before_provider_headers` e `after_provider_response` do Pi, mantém a seleção por sessão e oferece comandos/ferramentas nativos. O handoff/summarizer e a UI específica do OpenCode não são copiados porque não possuem equivalente direto e seguro no Pi.
