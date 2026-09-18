import type { Account } from "./store"

type MenuAccount = Pick<Account, "id" | "label" | "email" | "enabled">

export function accountMenuRows<T extends MenuAccount>(accounts: T[], order: string[], activeId?: string) {
  const byId = new Map(accounts.map((account) => [account.id, account]))
  const ids = [...new Set([...order, ...accounts.map((account) => account.id)])]
  return ids.flatMap((id) => {
    const account = byId.get(id)
    return account ? [account] : []
  }).map((account, index) => ({
    account,
    label: `${account.enabled && account.id === activeId ? "●" : "○"} ${index + 1}. ${account.label}${account.email ? ` — ${account.email}` : ""}${account.enabled ? "" : " (desativada)"}`,
  }))
}
