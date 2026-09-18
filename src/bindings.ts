import type { Account } from "./domain"
import { blockedUntil } from "./quota"

export function orderAccounts(accounts: Account[], order: string[] = []): Account[] {
  const byID = new Map(accounts.map((account) => [account.id, account]))
  const seen = new Set<string>()
  const result: Account[] = []
  for (const id of order) {
    const account = byID.get(id)
    if (!account || seen.has(id)) continue
    seen.add(id)
    result.push(account)
  }
  for (const account of accounts) {
    if (seen.has(account.id)) continue
    seen.add(account.id)
    result.push(account)
  }
  return result
}

export function rotateAccounts(accounts: Account[], preferred?: string): Account[] {
  if (!preferred) return [...accounts]
  const index = accounts.findIndex((account) => account.id === preferred)
  if (index <= 0) return [...accounts]
  return [...accounts.slice(index), ...accounts.slice(0, index)]
}

export function selectAccount(accounts: Account[], preferred?: string, now = Date.now()) {
  const enabled = accounts.filter((item) => item.enabled)
  const available = enabled.filter((item) => blockedUntil(item, now) <= now && (item.health.cooldownUntil ?? 0) <= now)
  if (!available.length) return undefined
  const sticky = preferred ? available.find((item) => item.id === preferred) : undefined
  if (sticky) return sticky
  return available[0]
}

export function earliestAccount(accounts: Account[], now = Date.now()) {
  return accounts.filter((item) => item.enabled).map((account) => ({ account, at: Math.max(blockedUntil(account, now), account.health.cooldownUntil ?? 0) })).sort((a, b) => a.at - b.at)[0]
}
