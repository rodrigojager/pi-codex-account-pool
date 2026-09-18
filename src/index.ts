import { openBrowser } from "./browser"
import { accountMenuRows } from "./account-menu"
import { pickHandoffModel } from "./model-picker"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { Type } from "typebox"
import { z } from "zod"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ProviderResponse, SimpleStreamOptions } from "@earendil-works/pi-ai"
import { lazyStream } from "@earendil-works/pi-ai/api/lazy"
import { closeOpenAICodexWebSocketSessions, streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses"
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models"
import { AccountStore, type Account } from "./store"
import { browserAuthorization, cancelBrowserAuthorization, deviceAuthorization, tokenIdentity, refreshTokens } from "./oauth"
import { paths, transact } from "./storage"
import { QuotaService, blockedUntil, nearLimit } from "./quota"
import { addHandoffNote, clearPendingHandoff, completeWithFailover, createHandoff, getPendingHandoff, handoffContextMessage, loadHandoffSettings, saveHandoffSettings, type HandoffModelOptions, type ModelRef } from "./handoff"
import { orderAccounts, rotateAccounts } from "./bindings"
import { cooldownUntil, failureMessage, failureStatus, shouldRotateAccount } from "./failover"

const PROVIDER_ID = "codex-account-pool"
const QUOTA_REQUEST_EVENT = "pi-quota:request"
const QUOTA_RESPONSE_EVENT = "pi-quota:response"
const ACCOUNT_CHANGED_EVENT = "codex-account-pool:account-changed"
const store = new AccountStore()
const quota = new QuotaService(store)
const bindingsPath = join(paths.root, "bindings.json")
const waitingPath = join(paths.root, "waiting.json")
type WaitingJob = { sessionID: string; resumeAt: number; accountID?: string; reason: string }
const bindingsSchema = z.record(z.string(), z.string())
const waitingSchema = z.record(z.string(), z.object({ sessionID: z.string(), resumeAt: z.number(), accountID: z.string().optional(), reason: z.string() }))
let waiting: Record<string, WaitingJob> = {}
let waitLoaded = false
let bindings: Record<string, string> = {}
let initialized = false
const tokenRefreshes = new Map<string, Promise<Account>>()
const sessionContexts = new Map<string, ExtensionContext>()
let extensionAPI: ExtensionAPI | undefined
let sourceModelRegistry: ExtensionContext["modelRegistry"] | undefined

function poolModelConfig(model: Model<any>) {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
  }
}
function currentCodexModels() {
  return sourceModelRegistry?.getAll().filter((model) => model.provider === "openai-codex") ?? []
}
function validStoredModel(value: unknown): value is Model<any> {
  if (!value || typeof value !== "object") return false
  const model = value as Partial<Model<any>>
  return typeof model.id === "string" && typeof model.name === "string" && typeof model.api === "string" &&
    typeof model.reasoning === "boolean" && Array.isArray(model.input) && typeof model.contextWindow === "number" &&
    typeof model.maxTokens === "number" && !!model.cost && typeof model.cost === "object"
}
async function refreshedCodexModelConfigs() {
  const byID = new Map<string, Model<any>>()
  for (const model of Object.values(OPENAI_CODEX_MODELS)) byID.set(model.id, model)
  try {
    const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent")
    const raw = JSON.parse(await readFile(join(agentDir, "models-store.json"), "utf8")) as Record<string, any>
    const stored = raw["openai-codex"]?.models
    if (Array.isArray(stored)) for (const model of stored) if (validStoredModel(model)) byID.set(model.id, model)
  } catch {
    // O catálogo embarcado mantém o provider disponível offline.
  }
  for (const model of currentCodexModels()) byID.set(model.id, model)
  return [...byID.values()].map(poolModelConfig)
}

async function loadBindings() {
  if (initialized) return
  initialized = true
  try { bindings = JSON.parse(await readFile(bindingsPath, "utf8")) } catch { bindings = {} }
}
async function loadWaiting() {
  if (waitLoaded) return
  waitLoaded = true
  try { waiting = JSON.parse(await readFile(waitingPath, "utf8")) } catch { waiting = {} }
}
async function updateWaiting(update: (data: Record<string, WaitingJob>) => void) {
  waiting = await transact({
    key: "waiting", path: waitingPath, schema: waitingSchema, fallback: () => ({}),
    update(data) { update(data); return structuredClone(data) },
  })
  waitLoaded = true
}
async function queueQuotaWait(sessionID: string, reason: string) {
  const snapshot = await accounts()
  const next = snapshot.accounts.filter((a) => a.enabled).map((a) => ({ a, at: Math.max(blockedUntil(a), a.health.cooldownUntil ?? 0) })).sort((x, y) => x.at - y.at)[0]
  await updateWaiting((data) => { data[sessionID] = { sessionID, resumeAt: next?.at ?? Date.now() + 60_000, accountID: next?.a.id, reason } })
}
async function updateBindings(update: (data: Record<string, string>) => void) {
  bindings = await transact({
    key: "session-bindings", path: bindingsPath, schema: bindingsSchema, fallback: () => ({}), secret: true,
    update(data) { update(data); return structuredClone(data) },
  })
  initialized = true
}
function sessionId(ctx: ExtensionContext) { return ctx.sessionManager.getSessionId() }
function publicAccount(account: Account) {
  return { id: account.id, label: account.label, email: account.email, plan: account.planType, enabled: account.enabled, expiresAt: account.expiresAt, health: account.health, quota: account.quota }
}
async function accounts() { await store.initialize(); await importPiCodexAuth(); return store.snapshot() }

/**
 * Pi already stores the currently authenticated Codex account in auth.json.
 * Import it on first use so installing this extension does not leave the pool
 * empty (and silently falls back to Pi's single-account credential).
 */
async function importPiCodexAuth() {
  if (process.env.PI_CODEX_ACCOUNT_POOL_IMPORT_AUTH === "0") return
  const current = await store.snapshot()
  if (current.accounts.length > 0) return
  const authPath = join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json")
  try {
    const raw = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>
    const entry = raw["openai-codex"]
    if (!entry || typeof entry !== "object") return
    const auth = entry as Record<string, unknown>
    if (auth.type !== "oauth" || typeof auth.access !== "string" || typeof auth.refresh !== "string" || typeof auth.expires !== "number") return
    const identity = tokenIdentity({ access_token: auth.access })
    await store.add({
      accessToken: auth.access,
      refreshToken: auth.refresh,
      expiresAt: auth.expires,
      label: identity.email ?? "Conta Codex importada do Pi",
      email: identity.email,
      subjectID: identity.subjectID,
      workspaceAccountID: (typeof auth.accountId === "string" ? auth.accountId : identity.accountId),
      organizationID: identity.organizationID,
    })
  } catch {
    // auth.json may not exist yet; /codex-account-add remains available.
  }
}

async function candidateAccounts(sessionID: string, excluded = new Set<string>()) {
  await loadBindings()
  const data = await accounts()
  const now = Date.now()
  const preferred = bindings[sessionID] ?? data.defaultAccountID
  return rotateAccounts(orderAccounts(data.accounts, data.order), preferred)
    .filter((account) => account.enabled && !excluded.has(account.id) && (account.health.cooldownUntil ?? 0) <= now && blockedUntil(account, now) <= now)
}
async function usableAccount(ctx: ExtensionContext) {
  return (await candidateAccounts(sessionId(ctx)))[0]
}
async function assignedAccountForSession(sessionID: string) {
  await loadBindings()
  const data = await accounts()
  const id = bindings[sessionID] ?? data.defaultAccountID
  return data.accounts.find((account) => account.id === id)
}
async function assignedAccount(ctx: ExtensionContext) {
  return assignedAccountForSession(sessionId(ctx))
}
async function activateAccount(sessionID: string, account: Account, clearHandoff = false) {
  await updateBindings((data) => { data[sessionID] = account.id })
  await loadWaiting()
  if (waiting[sessionID]) await updateWaiting((data) => { delete data[sessionID] })
  if (clearHandoff) await clearPendingHandoff(sessionID)
  const ctx = sessionContexts.get(sessionID)
  if (ctx?.hasUI) ctx.ui.setStatus("codex-account-pool", `Codex Pool: ${account.label}`)
  extensionAPI?.events.emit(ACCOUNT_CHANGED_EVENT, {
    provider: PROVIDER_ID,
    sessionId: sessionID,
    accountId: account.id,
    accountLabel: account.label,
  })
}
async function removeAccount(accountID: string) {
  const removed = await store.remove(accountID)
  if (!removed) return false
  await loadBindings()
  if (Object.values(bindings).includes(accountID)) {
    await updateBindings((data) => {
      for (const [sessionID, boundAccountID] of Object.entries(data)) if (boundAccountID === accountID) delete data[sessionID]
    })
  }
  return true
}
async function refreshIfNeeded(account: Account) {
  if (account.expiresAt > Date.now() + 30_000) return account
  let pending = tokenRefreshes.get(account.id)
  if (!pending) {
    pending = (async () => {
      const latest = (await store.snapshot()).accounts.find((item) => item.id === account.id) ?? account
      if (latest.expiresAt > Date.now() + 30_000) return latest
      const tokens = await refreshTokens(latest.refreshToken)
      const identity = tokenIdentity(tokens)
      await store.updateTokens(latest.id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? latest.refreshToken,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        workspaceAccountID: identity.accountId ?? latest.workspaceAccountID,
        email: identity.email ?? latest.email,
        subjectID: identity.subjectID ?? latest.subjectID,
      })
      return (await store.snapshot()).accounts.find((item) => item.id === latest.id) ?? latest
    })().finally(() => tokenRefreshes.delete(account.id))
    tokenRefreshes.set(account.id, pending)
  }
  return pending
}

function poolError(model: Model<"openai-codex-responses">, message: string): AssistantMessageEvent {
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  }
  return { type: "error", reason: "error", error }
}

async function refreshQuotaAndRotate(sessionID: string, account: Account) {
  try {
    await quota.refresh(account)
    const refreshed = (await accounts()).accounts.find((item) => item.id === account.id) ?? account
    if (!nearLimit(refreshed, 90, 95)) return
    await loadBindings()
    if (bindings[sessionID] !== account.id) return
    const alternative = (await candidateAccounts(sessionID, new Set([account.id])))[0]
    if (!alternative) return
    await activateAccount(sessionID, alternative)
    const ctx = sessionContexts.get(sessionID)
    if (ctx?.hasUI) ctx.ui.notify(`Quota de ${refreshed.label} próxima do limite; próxima requisição usará ${alternative.label}.`, "warning")
  } catch {
    // A leitura preventiva de quota não deve interromper uma resposta válida.
  }
}

async function* streamWithAccountPool(
  model: Model<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions = {},
): AsyncGenerator<AssistantMessageEvent> {
  const data = await accounts()
  if (!data.accounts.length) {
    yield* streamCodex(model, context, options)
    return
  }

  const sessionID = options.sessionId ?? "unbound"
  const managedSession = sessionContexts.has(sessionID)
  const candidates = await candidateAccounts(sessionID)
  if (!candidates.length) {
    if (managedSession) await queueQuotaWait(sessionID, "todas as contas estão em cooldown ou sem quota")
    yield poolError(model, "Todas as contas Codex estão temporariamente indisponíveis ou sem quota.")
    return
  }

  let lastFailure: AssistantMessageEvent | undefined
  for (let index = 0; index < candidates.length; index++) {
    const selected = candidates[index]
    let account: Account
    try {
      account = await refreshIfNeeded(selected)
    } catch (error) {
      const message = failureMessage(error)
      await store.recordOutcome(selected.id, 401, false, cooldownUntil(401))
      lastFailure = poolError(model, `Falha ao renovar ${selected.label}: ${message}`)
      const next = candidates[index + 1]
      if (next && managedSession) {
        await activateAccount(sessionID, next)
        const ctx = sessionContexts.get(sessionID)
        if (ctx?.hasUI) ctx.ui.notify(`Falha de autenticação em ${selected.label}; tentando ${next.label}.`, "warning")
      }
      continue
    }

    if (managedSession && bindings[sessionID] !== account.id) await activateAccount(sessionID, account)
    const ctx = sessionContexts.get(sessionID)
    if (ctx?.hasUI) ctx.ui.setStatus("codex-account-pool", `Codex Pool: ${account.label}`)

    let response: ProviderResponse | undefined
    const source = streamCodex(model, context, {
      ...options,
      apiKey: account.accessToken,
      // O retry precisa voltar ao pool. O retry interno reutiliza o mesmo token.
      maxRetries: 0,
      onResponse: async (value, responseModel) => {
        response = value
        await options.onResponse?.(value, responseModel)
      },
    })

    let started = false
    let completed = false
    let failure: Extract<AssistantMessageEvent, { type: "error" }> | undefined
    for await (const event of source) {
      if (event.type === "start") started = true
      if (event.type === "done") completed = true
      if (event.type === "error") {
        if (started) {
          const message = failureMessage(event.error)
          const status = failureStatus(response, message)
          await store.recordOutcome(account.id, status ?? 520, false, cooldownUntil(status, response))
          yield event
          return
        }
        failure = event
        break
      }
      yield event
    }

    if (completed && !failure) {
      await store.recordOutcome(account.id, response?.status ?? 200, true)
      if (managedSession) void refreshQuotaAndRotate(sessionID, account)
      return
    }

    if (!failure) {
      lastFailure = poolError(model, `A resposta da conta ${account.label} terminou inesperadamente.`)
      continue
    }

    const message = failureMessage(failure.error)
    const status = failureStatus(response, message)
    if (!shouldRotateAccount(status, message)) {
      await store.recordOutcome(account.id, status ?? 520, false, cooldownUntil(status, response))
      yield failure
      return
    }

    await store.recordOutcome(account.id, status ?? 520, false, cooldownUntil(status, response))
    if (status === 429) void quota.refresh(account, true).catch(() => {})
    lastFailure = failure
    const next = candidates[index + 1]
    if (next) {
      if (managedSession) {
        await activateAccount(sessionID, next)
        if (ctx?.hasUI) ctx.ui.notify(`Conta ${account.label} indisponível; repetindo a solicitação com ${next.label}.`, "warning")
      }
      continue
    }
  }

  if (managedSession) {
    await queueQuotaWait(sessionID, "todas as contas falharam durante o failover")
    const ctx = sessionContexts.get(sessionID)
    if (ctx?.hasUI) ctx.ui.notify("Todas as contas Codex estão indisponíveis; aguardando liberação de quota.", "warning")
  }
  yield lastFailure ?? poolError(model, "Todas as contas Codex falharam antes de iniciar a resposta.")
}

type RuntimeModelRegistry = {
  runtime?: { setRuntimeApiKey(providerID: string, apiKey: string, options?: { signal?: AbortSignal }): Promise<void> }
}

async function enablePoolRuntime(ctx: ExtensionContext, account: Account) {
  const runtime = (ctx.modelRegistry as unknown as RuntimeModelRegistry).runtime
  if (!runtime?.setRuntimeApiKey) throw new Error("Esta versão do Pi não expõe o runtime necessário para alternar contas Codex")
  await runtime.setRuntimeApiKey(PROVIDER_ID, account.accessToken, { signal: ctx.signal })
}

function quotaWindowLabel(seconds: number | undefined, fallback: string) {
  if (!seconds || seconds <= 0) return fallback
  return seconds >= 86_400 ? `${Math.round(seconds / 86_400)}d` : `${Math.round(seconds / 3_600)}h`
}
function quotaResetText(resetAt: number | undefined) {
  if (!resetAt || resetAt <= Date.now()) return ""
  const totalMinutes = Math.max(0, Math.floor((resetAt - Date.now()) / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`
}
function quotaPayload(account: Account) {
  const windows = [
    { window: account.quota?.primary, fallback: "5h" },
    { window: account.quota?.secondary, fallback: "7d" },
  ]
  const items: Array<Record<string, unknown>> = []
  const metrics: Record<string, number> = {}
  const resetAt: Record<string, number> = {}
  for (const { window, fallback } of windows) {
    if (!window) continue
    const label = quotaWindowLabel(window.windowSeconds, fallback)
    items.push({ kind: "text", text: items.length === 0 ? `Usage: ${label} ` : ` / ${label} ` })
    items.push({ kind: "pct", pct: window.usedPercent, metric: label })
    const reset = quotaResetText(window.resetAt)
    if (reset) items.push({ kind: "text", text: ` (${reset})` })
    metrics[label] = window.usedPercent
    if (window.resetAt) resetAt[label] = window.resetAt
  }
  if (account.quota?.planType ?? account.planType) {
    items.push({ kind: "text", text: ` (${account.quota?.planType ?? account.planType})` })
  }
  if (items.length === 0) throw new Error("A conta ativa não retornou janelas de quota")
  return {
    kind: "quota" as const,
    items,
    metrics,
    resetAt: Object.keys(resetAt).length ? resetAt : undefined,
  }
}

type QuotaRequest = { requestId?: unknown; provider?: unknown; sessionId?: unknown; force?: unknown }
function registerQuotaBridge(pi: ExtensionAPI) {
  return pi.events.on(QUOTA_REQUEST_EVENT, (raw) => {
    const request = raw as QuotaRequest
    if (request?.provider !== PROVIDER_ID || typeof request.requestId !== "string" || typeof request.sessionId !== "string") return
    void (async () => {
      try {
        const selected = await assignedAccountForSession(request.sessionId as string)
        if (!selected || !selected.enabled) throw new Error("Nenhuma conta Codex ativa para esta sessão")
        const account = await refreshIfNeeded(selected)
        await quota.refresh(account, request.force === true)
        const fresh = (await accounts()).accounts.find((item) => item.id === account.id) ?? account
        pi.events.emit(QUOTA_RESPONSE_EVENT, {
          requestId: request.requestId,
          provider: PROVIDER_ID,
          identityKey: fresh.id,
          accountLabel: fresh.label,
          payload: quotaPayload(fresh),
        })
      } catch (error) {
        pi.events.emit(QUOTA_RESPONSE_EVENT, {
          requestId: request.requestId,
          provider: PROVIDER_ID,
          error: failureMessage(error),
        })
      }
    })()
  })
}

async function addAccount(ctx: ExtensionContext) {
  if (!ctx.hasUI) throw new Error("Adicionar conta requer o modo interativo do Pi")
  const method = await ctx.ui.select("Login Codex", ["Browser OAuth", "Device code"])
  if (!method) return
  let tokens
  if (method === "Browser OAuth") {
    const auth = await browserAuthorization()
    // Attach a handler immediately, including while the browser launcher is running.
    void auth.callback.catch(() => {})
    try {
      await openBrowser(auth.url)
      ctx.ui.notify("A janela de login do ChatGPT foi aberta.", "info")
    } catch {
      ctx.ui.notify(`Não foi possível abrir o navegador. Abra este link completo para continuar:\n${auth.url}`, "warning")
    }
    tokens = await auth.callback
  } else {
    const auth = await deviceAuthorization()
    ctx.ui.notify(`Abra ${auth.url} e informe o código: ${auth.code}`, "info")
    tokens = await auth.callback()
  }
  const identity = tokenIdentity(tokens)
  const label = await ctx.ui.input("Nome da conta (opcional)", identity.email ?? "")
  const account = await store.add({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, label: label || undefined, email: identity.email, subjectID: identity.subjectID, workspaceAccountID: identity.accountId, organizationID: identity.organizationID })
  await activateAccount(sessionId(ctx), account, true)
  await enablePoolRuntime(ctx, account)
  ctx.ui.notify(`Conta adicionada${identity.email ? `: ${identity.email}` : ""}`, "info")
}
async function configureHandoffModelOptions(ctx: ExtensionContext, ref: ModelRef, current: HandoffModelOptions = {}) {
  const reasoning = await ctx.ui.select(`Reasoning do summarizer · ${ref}`, ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"])
  if (!reasoning) return undefined
  const maxTokensRaw = await ctx.ui.input("Máximo de tokens da resposta", String(current.maxTokens ?? 4096))
  if (maxTokensRaw === undefined) return undefined
  const maxTokens = Number(maxTokensRaw)
  if (!Number.isInteger(maxTokens) || maxTokens < 256) throw new Error("maxTokens deve ser um inteiro maior ou igual a 256")
  const temperatureRaw = await ctx.ui.input("Temperature (vazio = padrão do provider)", current.temperature === undefined ? "" : String(current.temperature))
  if (temperatureRaw === undefined) return undefined
  const temperature = temperatureRaw.trim() === "" ? undefined : Number(temperatureRaw)
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error("Temperature deve estar entre 0 e 2")
  const timeoutRaw = await ctx.ui.input("Timeout em segundos", String(Math.round((current.timeoutMs ?? 60_000) / 1000)))
  if (timeoutRaw === undefined) return undefined
  const timeoutSeconds = Number(timeoutRaw)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error("Timeout deve estar entre 1 e 600 segundos")
  const samplingRaw = await ctx.ui.input("Sampling params JSON (vazio = nenhum)", current.samplingParams ? JSON.stringify(current.samplingParams) : "")
  if (samplingRaw === undefined) return undefined
  let samplingParams: Record<string, unknown> | undefined
  if (samplingRaw.trim()) {
    const parsed = JSON.parse(samplingRaw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Sampling params deve ser um objeto JSON")
    samplingParams = parsed
  }
  return { reasoning: reasoning as HandoffModelOptions["reasoning"], maxTokens, temperature, timeoutMs: Math.round(timeoutSeconds * 1000), samplingParams }
}

async function menu(ctx: ExtensionContext) {
  if (!ctx.hasUI) return
  for (;;) {
    const data = await accounts()
    const active = await assignedAccount(ctx)
    const rows = accountMenuRows(data.accounts, data.order, active?.id)
    const choices = ["+ Adicionar conta", "Verificar tokens agora", ...rows.map((row) => row.label), "Fechar"]
    const choice = await ctx.ui.select("Codex Account Pool", choices)
    if (!choice || choice === "Fechar") return
    if (choice === "+ Adicionar conta") { try { await addAccount(ctx) } catch (e) { ctx.ui.notify(String(e), "error") }; continue }
    if (choice === "Verificar tokens agora") {
      const results = await Promise.allSettled(data.accounts.filter((item) => item.enabled).map(refreshIfNeeded))
      const failures = results.filter((result) => result.status === "rejected").length
      ctx.ui.notify(failures ? `${failures} conta(s) não puderam renovar o token.` : "Tokens verificados com sucesso.", failures ? "warning" : "info")
      continue
    }
    const account = rows.find((row) => row.label === choice)?.account
    if (!account) continue
    const action = await ctx.ui.select(account.label, ["Usar nesta sessão", account.enabled ? "Desativar" : "Ativar", "Definir como principal", "Alterar prioridade", "Renomear", "Remover", "Voltar"])
    if (action === "Usar nesta sessão") {
      if (!account.enabled) ctx.ui.notify("Ative a conta antes de selecioná-la.", "warning")
      else {
        await activateAccount(sessionId(ctx), account, true)
        ctx.ui.notify(`Conta ativa: ${account.label}. A próxima requisição usará esta credencial.`, "info")
      }
    }
    else if (action === "Desativar") await store.setEnabled(account.id, false)
    else if (action === "Ativar") await store.setEnabled(account.id, true)
    else if (action === "Definir como principal") await store.setDefault(account.id)
    else if (action === "Alterar prioridade") {
      const positions = rows.map((_, index) => `${index + 1}${index === 0 ? " — Principal" : ""}`)
      const position = await ctx.ui.select("Prioridade (1 = maior)", positions)
      if (position) await store.setPriority(account.id, positions.indexOf(position))
    }
    else if (action === "Renomear") { const label = await ctx.ui.input("Novo nome", account.label); if (label) await store.renameAccount(account.id, label) }
    else if (action === "Remover" && await ctx.ui.confirm("Remover conta?", "Os tokens locais serão apagados.")) await removeAccount(account.id)
  }
}

export default function (pi: ExtensionAPI) {
  let waitTimer: ReturnType<typeof setInterval> | undefined
  extensionAPI = pi
  const unregisterQuotaBridge = registerQuotaBridge(pi)

  pi.registerProvider(PROVIDER_ID, {
    name: "Codex Account Pool",
    baseUrl: "https://chatgpt.com/backend-api",
    api: "openai-codex-responses",
    // Mantém o provider visível antes da primeira conta ser ativada. O stream
    // sempre injeta a credencial da conta vinculada à sessão.
    apiKey: "codex-account-pool-runtime",
    // Bootstrap offline com o catálogo embarcado; em cada refresh do Pi,
    // espelha o catálogo efetivo de openai-codex (inclusive models-store).
    models: Object.values(OPENAI_CODEX_MODELS).map(poolModelConfig),
    async refreshModels() {
      return refreshedCodexModelConfigs()
    },
    streamSimple: (model, context, options) => lazyStream(model, async () => streamWithAccountPool(
      model as Model<"openai-codex-responses">,
      context,
      options,
    )),
  })

  pi.on("session_start", async (_event, ctx) => {
    sourceModelRegistry = ctx.modelRegistry
    await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [PROVIDER_ID], signal: ctx.signal })
    await store.initialize()
    await importPiCodexAuth()
    await loadWaiting()
    sessionContexts.set(sessionId(ctx), ctx)
    const account = await usableAccount(ctx)
    if (account) {
      await activateAccount(sessionId(ctx), account)
      try {
        await enablePoolRuntime(ctx, account)
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`O pool não pôde assumir a autenticação do Codex: ${failureMessage(error)}`, "error")
      }
      if (ctx.hasUI) ctx.ui.setStatus("codex-account-pool", `Codex Pool: ${account.label}`)
    }
    waitTimer = setInterval(() => void (async () => {
      const job = waiting[sessionId(ctx)]
      if (!job || job.resumeAt > Date.now() || !ctx.isIdle()) return
      const current = await accounts()
      await Promise.allSettled(current.accounts.filter((item) => item.enabled).map(refreshIfNeeded))
      await quota.refreshAll(true).catch(() => {})
      const available = await usableAccount(ctx)
      if (!available) return
      await activateAccount(sessionId(ctx), available)
      await pi.sendUserMessage(`A quota Codex foi liberada na conta ${available.label}. Continue o trabalho.`, { deliverAs: "followUp" })
    })().catch(() => {}), 30_000)
    waitTimer.unref?.()
  })
  pi.on("session_shutdown", async (_event, ctx) => {
    if (waitTimer) clearInterval(waitTimer)
    waitTimer = undefined
    closeOpenAICodexWebSocketSessions(sessionId(ctx))
    sessionContexts.delete(sessionId(ctx))
    cancelBrowserAuthorization("Login cancelado porque a sessão foi encerrada ou recarregada")
    extensionAPI = undefined
    sourceModelRegistry = undefined
    unregisterQuotaBridge()
  })
  pi.on("context", async (event, ctx) => {
    const pending = await getPendingHandoff(sessionId(ctx))
    if (!pending) return
    await clearPendingHandoff(sessionId(ctx))
    // After a handoff, keep the checkpoint and a short recent tail instead of
    // resending the whole pre-failover transcript.
    return { messages: [handoffContextMessage(pending), ...event.messages.slice(-8)] }
  })
  pi.registerCommand("codex-handoff-config", { description: "Configurar modelos primary/fallback do summarizer", handler: async (_args, ctx) => {
    if (!ctx.hasUI) return
    const available = ctx.modelRegistry.getAvailable()
    const refs = available.map((model) => `${model.provider}/${model.id}` as ModelRef)
    const current = await loadHandoffSettings()
    const mode = await ctx.ui.select("Modelo principal do handoff", ["Escolher modelo", "Usar modelo atual"])
    if (!mode) return
    const primary = mode === "Escolher modelo"
      ? await pickHandoffModel(ctx, "Handoff · principal · digite para filtrar", available, current.primary)
      : undefined
    if (mode === "Escolher modelo" && !primary) return
    let fallbacks = [...current.fallbacks]
    let maxInputChars = current.maxInputChars
    const modelOptions = { ...current.modelOptions }
    for (;;) {
      const action = await ctx.ui.select(`Handoff · ${fallbacks.length} fallback(s) · entrada ${maxInputChars} chars`, ["Configurar opções do modelo", "Restaurar opções do modelo", "Configurar tamanho da entrada", "Adicionar fallback", "Remover fallback", "Limpar fallbacks", "Salvar", "Cancelar"])
      if (!action || action === "Cancelar") return
      if (action === "Salvar") break
      if (action === "Configurar tamanho da entrada") {
        const raw = await ctx.ui.input("Máximo de caracteres enviados ao summarizer", String(maxInputChars))
        if (raw === undefined) continue
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 1_000 || value > 2_000_000) { ctx.ui.notify("Use um inteiro entre 1000 e 2000000.", "warning"); continue }
        maxInputChars = value
        continue
      }
      if (action === "Configurar opções do modelo" || action === "Restaurar opções do modelo") {
        const currentRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` as ModelRef : undefined
        const configuredRefs = [...new Set([primary as ModelRef | undefined, ...fallbacks, !primary ? currentRef : undefined].filter(Boolean))] as ModelRef[]
        if (!configuredRefs.length) { ctx.ui.notify("Escolha um modelo principal ou fallback primeiro.", "warning"); continue }
        const selected = await ctx.ui.select("Modelo para configurar", configuredRefs)
        if (!selected) continue
        const ref = selected as ModelRef
        if (action === "Restaurar opções do modelo") {
          delete modelOptions[ref]
          ctx.ui.notify(`Opções restauradas: ${ref}`, "info")
          continue
        }
        try {
          const options = await configureHandoffModelOptions(ctx, ref, modelOptions[ref])
          if (options) modelOptions[ref] = options
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error") }
        continue
      }
      if (action === "Limpar fallbacks") { fallbacks = []; continue }
      if (action === "Remover fallback") {
        const candidates = available.filter((model) => fallbacks.includes(`${model.provider}/${model.id}` as ModelRef)).map(({ provider, id, name }) => ({ provider, id, name }))
        // Keep saved, currently unavailable models removable as well.
        for (const ref of fallbacks.filter((ref) => !refs.includes(ref))) {
          const slash = ref.indexOf("/")
          candidates.push({ provider: ref.slice(0, slash), id: ref.slice(slash + 1), name: ref })
        }
        const selected = await pickHandoffModel(ctx, "Handoff · remover fallback", candidates)
        if (selected) fallbacks = fallbacks.filter((ref) => ref !== selected)
      } else {
        const candidates = available.filter((model) => {
          const ref = `${model.provider}/${model.id}` as ModelRef
          return ref !== primary && !fallbacks.includes(ref)
        })
        const selected = await pickHandoffModel(ctx, "Handoff · adicionar fallback · digite para filtrar", candidates)
        if (selected) fallbacks.push(selected as ModelRef)
      }
    }
    await saveHandoffSettings({ primary: primary as ModelRef | undefined, fallbacks, maxInputChars, modelOptions })
    ctx.ui.notify(`Summarizer salvo: ${primary ?? "modelo atual + fallbacks"}`, "info")
  } })
  pi.registerCommand("codex-handoff", { description: "Gerar handoff e abrir uma nova sessão", handler: async (args, ctx) => {
    if (!ctx.hasUI) return
    const result = await createHandoff(ctx, undefined, undefined, args.trim() || "handoff manual")
    if (!result) return ctx.ui.notify("Não há conversa para transferir.", "warning")
    const prompt = `${result.text}${args.trim() ? `\n\n## Próximo objetivo\n${args.trim()}` : ""}`
    const replacement = await ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile(), withSession: async (next) => { next.ui.setEditorText(prompt); next.ui.notify(`Handoff gerado com ${result.model}. Revise e envie.`, "info") } })
    if (replacement.cancelled) ctx.ui.notify("Handoff cancelado.", "info")
  } })
  pi.registerCommand("codex-accounts", { description: "Gerenciar contas ChatGPT Codex", handler: async (_args, ctx) => menu(ctx) })
  pi.registerCommand("codex-account-add", { description: "Adicionar uma conta ChatGPT Codex", handler: async (_args, ctx) => addAccount(ctx) })
  pi.registerTool({ name: "codex_accounts_list", label: "Codex accounts", description: "List configured Codex accounts without credentials", parameters: Type.Object({}), async execute() { const data = await accounts(); return { content: [{ type: "text", text: JSON.stringify(data.accounts.map(publicAccount), null, 2) }], details: {} } } })
  pi.registerTool({ name: "codex_account_current", label: "Current Codex account", description: "Show the Codex account assigned to this Pi session", parameters: Type.Object({}), async execute(_id, _params, _signal, _onUpdate, ctx) { const account = await assignedAccount(ctx); return { content: [{ type: "text", text: account ? JSON.stringify(publicAccount(account), null, 2) : "No Codex account assigned" }], details: {} } } })
  pi.registerTool({ name: "codex_account_set_active", label: "Set Codex account", description: "Assign an enabled Codex account to this Pi session", parameters: Type.Object({ accountId: Type.String() }), async execute(_id, params, _signal, _onUpdate, ctx) { const account = (await accounts()).accounts.find((a) => a.id === params.accountId); if (!account || !account.enabled) return { content: [{ type: "text", text: "Account not found or disabled" }], isError: true, details: {} }; await activateAccount(sessionId(ctx), account, true); await enablePoolRuntime(ctx, account); return { content: [{ type: "text", text: `Active account: ${account.label}` }], details: {} } } })
  pi.registerTool({ name: "codex_quota_refresh", label: "Refresh Codex quota", description: "Refresh quota for one account or all enabled accounts", parameters: Type.Object({ accountId: Type.Optional(Type.String()) }), async execute(_id, params) { if (params.accountId) { const account = (await accounts()).accounts.find((a) => a.id === params.accountId); if (!account) return { content: [{ type: "text", text: "Account not found" }], isError: true, details: {} }; await quota.refresh(await refreshIfNeeded(account), true) } else { const data = await accounts(); await Promise.allSettled(data.accounts.filter((item) => item.enabled).map(refreshIfNeeded)); await quota.refreshAll(true) } return { content: [{ type: "text", text: JSON.stringify((await accounts()).accounts.map(publicAccount), null, 2) }], details: {} } } })
  pi.registerTool({ name: "codex_account_enable", label: "Enable or disable Codex account", description: "Enable or disable an account in the pool", parameters: Type.Object({ accountId: Type.String(), enabled: Type.Boolean() }), async execute(_id, params) { const ok = await store.setEnabled(params.accountId, params.enabled); return { content: [{ type: "text", text: ok ? `Account ${params.enabled ? "enabled" : "disabled"}` : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_account_rename", label: "Rename Codex account", description: "Change an account display label", parameters: Type.Object({ accountId: Type.String(), label: Type.String() }), async execute(_id, params) { const ok = await store.renameAccount(params.accountId, params.label); return { content: [{ type: "text", text: ok ? "Account renamed" : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_account_set_priority", label: "Set Codex account priority", description: "Move an account to a 1-based priority position", parameters: Type.Object({ accountId: Type.String(), priority: Type.Integer({ minimum: 1 }) }), async execute(_id, params) { const ok = await store.setPriority(params.accountId, params.priority - 1); return { content: [{ type: "text", text: ok ? "Priority updated" : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_handoff_now", label: "Create Codex handoff", description: "Generate a provider-agnostic context handoff using the configured primary/fallback models", parameters: Type.Object({ reason: Type.Optional(Type.String()) }), async execute(_id, params, _signal, _onUpdate, ctx) { try { const result = await createHandoff(ctx, undefined, undefined, params.reason ?? "manual agent request"); return { content: [{ type: "text", text: result?.text ?? "No conversation available" }], details: { model: result?.model } } } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true, details: {} } } } })
  pi.registerTool({ name: "codex_accounts_set_default", label: "Set primary Codex account", description: "Make an account primary for new sessions", parameters: Type.Object({ accountId: Type.String() }), async execute(_id, params) { const ok = await store.setDefault(params.accountId); return { content: [{ type: "text", text: ok ? "Primary account updated" : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_accounts_remove", label: "Remove Codex account", description: "Remove an account and its local OAuth tokens", parameters: Type.Object({ accountId: Type.String() }), async execute(_id, params) { const ok = await removeAccount(params.accountId); return { content: [{ type: "text", text: ok ? "Account removed" : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_handoff_status", label: "Codex handoff status", description: "Inspect the current account and pending handoff", parameters: Type.Object({}), async execute(_id, _params, _signal, _onUpdate, ctx) { const current = await assignedAccount(ctx); const pending = await getPendingHandoff(sessionId(ctx)); const settings = await loadHandoffSettings(); return { content: [{ type: "text", text: JSON.stringify({ account: current ? publicAccount(current) : undefined, pending: Boolean(pending), primary: settings.primary, fallbacks: settings.fallbacks }, null, 2) }], details: {} } } })
  pi.registerTool({ name: "codex_handoff_note", label: "Save handoff note", description: "Save a durable note to include in future handoffs", parameters: Type.Object({ note: Type.String() }), async execute(_id, params, _signal, _onUpdate, ctx) { await addHandoffNote(sessionId(ctx), params.note); return { content: [{ type: "text", text: "Handoff note saved" }], details: {} } } })
  pi.registerCommand("codex-handoff-status", { description: "Mostrar status da conta e do handoff", handler: async (_args, ctx) => { const current = await assignedAccount(ctx); const settings = await loadHandoffSettings(); const pending = await getPendingHandoff(sessionId(ctx)); ctx.ui.notify(`Conta: ${current?.label ?? "nenhuma"} | primary: ${settings.primary ?? "modelo atual"} | fallbacks: ${settings.fallbacks.length} | handoff pendente: ${pending ? "sim" : "não"}`, "info") } })
  pi.registerCommand("codex-waiting", { description: "Mostrar ou cancelar espera por quota Codex", handler: async (args, ctx) => { await loadWaiting(); const job = waiting[sessionId(ctx)]; if (args.trim() === "cancel") { await updateWaiting((data) => { delete data[sessionId(ctx)] }); ctx.ui.notify("Espera cancelada.", "info"); return } ctx.ui.notify(job ? `Aguardando quota até ${new Date(job.resumeAt).toLocaleString()} (${job.reason}). Use /codex-waiting cancel para cancelar.` : "Nenhuma espera ativa.", "info") } })
}
