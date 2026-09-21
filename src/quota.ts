import type { Account, AccountQuota, QuotaWindow } from "./domain"
import type { AccountStore } from "./store"

export const QUOTA_CACHE_MS = 15_000

function number(value: unknown) {
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined
}

function epoch(value: unknown) {
  const parsed = number(value)
  if (!parsed || parsed <= 0) return undefined
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed
}

function parseWindow(value: unknown): QuotaWindow | undefined {
  if (!value || typeof value !== "object") return
  const row = value as Record<string, unknown>
  const usedPercent = number(row.used_percent ?? row.usedPercent)
  if (usedPercent === undefined) return
  const resetAfter = number(row.reset_after_seconds ?? row.resetAfterSeconds)
  return {
    usedPercent,
    windowSeconds: number(row.limit_window_seconds ?? row.window_seconds ?? row.windowSeconds),
    resetAt: epoch(row.reset_at ?? row.resetAt) ?? (resetAfter ? Date.now() + resetAfter * 1000 : undefined),
  }
}

export function parseQuotaPayload(payload: unknown, now = Date.now()): AccountQuota {
  const root = payload && typeof payload === "object" ? payload as Record<string, any> : {}
  const rate = root.rate_limit ?? root.rate_limits ?? root
  const codeReview = root.code_review_rate_limit
  return {
    planType: typeof root.plan_type === "string" ? root.plan_type : undefined,
    allowed: typeof rate.allowed === "boolean" ? rate.allowed : undefined,
    limitReached: typeof rate.limit_reached === "boolean" ? rate.limit_reached : undefined,
    reachedType: typeof root.rate_limit_reached_type === "string" ? root.rate_limit_reached_type : undefined,
    primary: parseWindow(rate.primary_window ?? rate.primary ?? rate.five_hour ?? rate.five_hour_limit),
    secondary: parseWindow(rate.secondary_window ?? rate.secondary ?? rate.weekly ?? rate.weekly_limit),
    codeReview: parseWindow(codeReview?.primary_window ?? codeReview?.primary),
    credits: root.credits && typeof root.credits === "object" ? {
      hasCredits: root.credits.has_credits,
      unlimited: root.credits.unlimited,
      balance: root.credits.balance,
    } : undefined,
    fetchedAt: now,
    source: "usage-endpoint",
  }
}

export function blockedUntil(account: Account, now = Date.now()) {
  const quota = account.quota
  const windows = [quota?.primary, quota?.secondary]
  const hardBlocked = quota?.allowed === false || quota?.limitReached === true || windows.some((window) => (window?.usedPercent ?? 0) >= 100)
  if (!hardBlocked) return 0
  const resets = windows.filter((window) => (window?.usedPercent ?? 0) >= 100).map((window) => window?.resetAt ?? 0).filter((value) => value > now)
  return resets.length ? Math.max(...resets) : now + 60_000
}

export function nearLimit(account: Account, primary: number, secondary: number) {
  return (account.quota?.primary?.usedPercent ?? 0) >= primary || (account.quota?.secondary?.usedPercent ?? 0) >= secondary
}

export function headroom(account: Account) {
  return Math.min(100 - (account.quota?.primary?.usedPercent ?? 0), 100 - (account.quota?.secondary?.usedPercent ?? 0))
}

export class QuotaService {
  private inflight = new Map<string, Promise<AccountQuota>>()
  private listeners = new Set<(account: Account, quota: AccountQuota) => void>()
  constructor(private accounts: AccountStore, private fetchFn: typeof fetch = fetch) {}

  onUpdate(listener: (account: Account, quota: AccountQuota) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(account: Account, force = false) {
    // Streams retain an old Account object. Read the latest persisted snapshot
    // before checking TTL, including updates made by another Pi process.
    account = (await this.accounts.snapshot()).accounts.find((item) => item.id === account.id) ?? account
    let pending = this.inflight.get(account.id)
    if (pending) return pending
    if (!force && account.quota && Date.now() - account.quota.fetchedAt < QUOTA_CACHE_MS) return account.quota
    if (!pending) {
      pending = this.fetchFn(process.env.PI_CODEX_QUOTA_ENDPOINT ?? "https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "ChatGPT-Account-Id": account.workspaceAccountID ?? "",
          Accept: "application/json",
          originator: "pi",
        },
        signal: AbortSignal.timeout(10_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`Quota request failed: ${response.status}`)
        const quota = parseQuotaPayload(await response.json())
        if (await this.accounts.updateQuota(account.id, quota)) {
          for (const listener of this.listeners) {
            try { listener(account, quota) } catch { /* UI listeners cannot fail the quota refresh. */ }
          }
        }
        return quota
      }).finally(() => this.inflight.delete(account.id))
      this.inflight.set(account.id, pending)
    }
    return pending
  }

  async refreshAll(force = false) {
    const snapshot = await this.accounts.snapshot()
    return Promise.allSettled(snapshot.accounts.filter((item) => item.enabled).map((item) => this.refresh(item, force)))
  }
}
