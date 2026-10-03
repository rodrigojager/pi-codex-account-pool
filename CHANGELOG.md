# Changelog

## 0.2.3 - 2026-10-03

- Exibe `Codex Pool: <conta>` somente quando o modelo atual usa `codex-account-pool`.
- Limpa o status ao trocar de provider e restaura a conta da sessão ao voltar ao pool.
- Impede que ativação, rotação ou leitura atrasada de conta exibam o status em outro provider.
- Adiciona regressões para troca de modelo, ausência de conta/modelo e sessões sem UI.

## 0.2.1 - 2026-09-21

- Usa transporte Codex, catálogo, normalizador e limpeza de sessão do Pi host,
  removendo os imports de módulos internos de uma cópia privada do SDK.
- Adapta o contexto por capacidades, sem condicionais por número de versão:
  formato plano e formato de mensagens de sistema, incluindo deltas de ferramentas.
- Preserva instruções e ferramentas ao cortar o histórico depois de um handoff.
- Move os pacotes Pi de runtime para peers opcionais fornecidos pelo host.
- Adiciona regressões offline com os transportes reais 0.85.1 e 0.86.1.
