import type { ProviderResponse } from "@earendil-works/pi-ai"

const LIMIT_PATTERN = /(?:usage[_ -]?limit|rate[_ -]?limit|too many requests|quota|limite de uso)/iu
const AUTH_PATTERN = /(?:unauthori[sz]ed|forbidden|authentication|invalid[_ -]?token|expired[_ -]?token|token[^\n]*(?:invalid|expired|revoked))/iu
const SERVER_PATTERN = /(?:internal server error|bad gateway|service unavailable|gateway timeout|server error)/iu

export function failureStatus(response: ProviderResponse | undefined, message: string): number | undefined {
  if (response) return response.status
  if (LIMIT_PATTERN.test(message)) return 429
  if (AUTH_PATTERN.test(message)) return 401
  if (SERVER_PATTERN.test(message)) return 503
  return undefined
}

export function shouldRotateAccount(status: number | undefined, message: string) {
  return status === 401 || status === 403 || status === 429 || (status !== undefined && status >= 500) ||
    LIMIT_PATTERN.test(message) || AUTH_PATTERN.test(message) || SERVER_PATTERN.test(message)
}

export function cooldownUntil(status: number | undefined, response?: ProviderResponse, now = Date.now()) {
  if (status === 429) {
    const retryAfter = response?.headers["retry-after"] ?? response?.headers["Retry-After"]
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date) && date > now) return date
    }
    return now + 60_000
  }
  if (status === 401 || status === 403) return now + 5 * 60_000
  return now + 30_000
}

export function failureMessage(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "Falha desconhecida")
  const value = error as { errorMessage?: unknown; message?: unknown }
  if (typeof value.errorMessage === "string") return value.errorMessage
  if (typeof value.message === "string") return value.message
  return String(error)
}
