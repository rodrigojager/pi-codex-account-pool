import { openBrowser } from "./browser"
import { accountMenuRows } from "./account-menu"
import { pickHandoffModel } from "./model-picker"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { Type } from "typebox"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { AccountStore, type Account } from "./store"
import { browserAuthorization, cancelBrowserAuthorization, deviceAuthorization, tokenIdentity, refreshTokens } from "./oauth"
import { atomicWrite, paths } from "./storage"
import { QuotaService, blockedUntil, nearLimit } from "./quota"
import { addHandoffNote, clearPendingHandoff, completeWithFailover, createHandoff, getPendingHandoff, handoffContextMessage, loadHandoffSettings, saveHandoffSettings, type ModelRef } from "./handoff"

const PROVIDERS = new Set((process.env.PI_CODEX_ACCOUNT_POOL_PROVIDERS ?? "openai-codex").split(",").map((x) => x.trim()).filter(Boolean))
const store = new AccountStore()
const quota = new QuotaService(store)
const bindingsPath = join(paths.root, "bindings.json")
const waitingPath = join(paths.root, "waiting.json")
type WaitingJob = { sessionID: string; resumeAt: number; accountID?: string; reason: string }
let waiting: Record<string, WaitingJob> = {}
let waitLoaded = false
let bindings: Record<string, string> = {}
let initialized = false

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
async function saveWaiting() { await atomicWrite(waitingPath, waiting, false) }
async function queueQuotaWait(ctx: ExtensionContext, reason: string) {
  await loadWaiting()
  const snapshot = await accounts()
  const next = snapshot.accounts.filter((a) => a.enabled).map((a) => ({ a, at: Math.max(blockedUntil(a), a.health.cooldownUntil ?? 0) })).sort((x, y) => x.at - y.at)[0]
  waiting[sessionId(ctx)] = { sessionID: sessionId(ctx), resumeAt: next?.at ?? Date.now() + 60_000, accountID: next?.a.id, reason }
  await saveWaiting()
}
async function saveBindings() {
  await mkdir(paths.root, { recursive: true })
  await writeFile(bindingsPath, JSON.stringify(bindings, null, 2), { mode: 0o600 })
}
function sessionId(ctx: ExtensionContext) { return ctx.sessionManager.getSessionId() }
function publicAccount(account: Account) {
  return { id: account.id, label: account.label, email: account.email, plan: account.planType, enabled: account.enabled, expiresAt: account.expiresAt, health: account.health, quota: account.quota }
}
async function accounts() { await store.initialize(); return store.snapshot() }
async function usableAccount(ctx: ExtensionContext) {
  await loadBindings()
  const data = await accounts()
  const now = Date.now()
  const preferred = bindings[sessionId(ctx)] ?? data.defaultAccountID
  const ordered = data.order.map((id) => data.accounts.find((a) => a.id === id)).filter((a): a is Account => Boolean(a))
  const candidates = [...ordered.filter((a) => a.id === preferred), ...ordered.filter((a) => a.id !== preferred)]
  return candidates.find((a) => a.enabled && (a.health.cooldownUntil ?? 0) <= now && blockedUntil(a, now) <= now) ?? candidates.find((a) => a.enabled && (a.health.cooldownUntil ?? 0) <= now)
}
async function refreshIfNeeded(account: Account) {
  if (account.expiresAt > Date.now() + 30_000) return account
  const tokens = await refreshTokens(account.refreshToken)
  const identity = tokenIdentity(tokens)
  await store.updateTokens(account.id, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? account.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    workspaceAccountID: identity.accountId ?? account.workspaceAccountID,
    email: identity.email ?? account.email,
    subjectID: identity.subjectID ?? account.subjectID,
  })
  return (await store.snapshot()).accounts.find((a) => a.id === account.id) ?? account
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
  await store.add({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, label: label || undefined, email: identity.email, subjectID: identity.subjectID, workspaceAccountID: identity.accountId, organizationID: identity.organizationID })
  ctx.ui.notify(`Conta adicionada${identity.email ? `: ${identity.email}` : ""}`, "info")
}
async function menu(ctx: ExtensionContext) {
  if (!ctx.hasUI) return
  for (;;) {
    const data = await accounts()
    const active = await usableAccount(ctx)
    const rows = accountMenuRows(data.accounts, data.order, active?.id)
    const choices = ["+ Adicionar conta", "Atualizar tokens", ...rows.map((row) => row.label), "Fechar"]
    const choice = await ctx.ui.select("Codex Account Pool", choices)
    if (!choice || choice === "Fechar") return
    if (choice === "+ Adicionar conta") { try { await addAccount(ctx) } catch (e) { ctx.ui.notify(String(e), "error") }; continue }
    if (choice === "Atualizar tokens") { ctx.ui.notify("Tokens são renovados automaticamente antes de expirar.", "info"); continue }
    const account = rows.find((row) => row.label === choice)?.account
    if (!account) continue
    const action = await ctx.ui.select(account.label, ["Usar nesta sessão", account.enabled ? "Desativar" : "Ativar", "Definir como principal", "Alterar prioridade", "Renomear", "Remover", "Voltar"])
    if (action === "Usar nesta sessão") { await loadBindings(); bindings[sessionId(ctx)] = account.id; await saveBindings(); ctx.ui.notify(`Conta ativa: ${account.label}`, "info") }
    else if (action === "Desativar") await store.setEnabled(account.id, false)
    else if (action === "Ativar") await store.setEnabled(account.id, true)
    else if (action === "Definir como principal") await store.setDefault(account.id)
    else if (action === "Alterar prioridade") {
      const positions = rows.map((_, index) => `${index + 1}${index === 0 ? " — Principal" : ""}`)
      const position = await ctx.ui.select("Prioridade (1 = maior)", positions)
      if (position) await store.setPriority(account.id, positions.indexOf(position))
    }
    else if (action === "Renomear") { const label = await ctx.ui.input("Novo nome", account.label); if (label) await store.renameAccount(account.id, label) }
    else if (action === "Remover" && await ctx.ui.confirm("Remover conta?", "Os tokens locais serão apagados.")) await store.remove(account.id)
  }
}

export default function (pi: ExtensionAPI) {
  let waitTimer: ReturnType<typeof setInterval> | undefined
  pi.on("session_start", async (_event, ctx) => {
    await store.initialize()
    await loadWaiting()
    const account = await usableAccount(ctx)
    if (account && ctx.hasUI) ctx.ui.setStatus("codex-account-pool", `Codex: ${account.label}`)
    waitTimer = setInterval(() => void (async () => {
      const job = waiting[sessionId(ctx)]
      if (!job || job.resumeAt > Date.now() || !ctx.isIdle()) return
      await quota.refreshAll(true).catch(() => {})
      const available = await usableAccount(ctx)
      if (!available) return
      await loadBindings(); bindings[sessionId(ctx)] = available.id; await saveBindings()
      delete waiting[sessionId(ctx)]; await saveWaiting()
      await pi.sendUserMessage(`A quota Codex foi liberada na conta ${available.label}. Continue o trabalho a partir do handoff salvo.`, { deliverAs: "followUp" })
    })().catch(() => {}), 30_000)
    waitTimer.unref?.()
  })
  pi.on("session_shutdown", async () => {
    if (waitTimer) clearInterval(waitTimer)
    waitTimer = undefined
    cancelBrowserAuthorization("Login cancelado porque a sessão foi encerrada ou recarregada")
  })
  pi.on("before_provider_headers", async (event, ctx) => {
    if (!ctx.model || !PROVIDERS.has(ctx.model.provider)) return
    const account = await usableAccount(ctx)
    if (!account) return
    const fresh = await refreshIfNeeded(account)
    await loadBindings()
    if (!bindings[sessionId(ctx)]) { bindings[sessionId(ctx)] = fresh.id; await saveBindings() }
    event.headers.Authorization = `Bearer ${fresh.accessToken}`
    if (fresh.workspaceAccountID) event.headers["ChatGPT-Account-Id"] = fresh.workspaceAccountID
    if (ctx.hasUI) ctx.ui.setStatus("codex-account-pool", `Codex: ${fresh.label}`)
  })
  pi.on("context", async (event, ctx) => {
    const pending = await getPendingHandoff(sessionId(ctx))
    if (!pending) return
    await clearPendingHandoff(sessionId(ctx))
    // After a handoff, keep the checkpoint and a short recent tail instead of
    // resending the whole pre-failover transcript.
    return { messages: [handoffContextMessage(pending), ...event.messages.slice(-8)] }
  })
  pi.on("after_provider_response", async (event, ctx) => {
    if (!ctx.model || !PROVIDERS.has(ctx.model.provider)) return
    await loadBindings()
    const previousID = bindings[sessionId(ctx)]
    const previous = (await accounts()).accounts.find((a) => a.id === previousID)
    const account = await usableAccount(ctx)
    if (!account) return
    if (event.status >= 200 && event.status < 400) {
      await store.recordOutcome(account.id, event.status, true)
      // Quota polling is deliberately best-effort and never blocks normal work.
      void quota.refresh(account).then(async () => {
        const refreshed = (await accounts()).accounts.find((a) => a.id === account.id) ?? account
        if (!nearLimit(refreshed, 90, 95)) return
        const alternative = (await accounts()).accounts.find((a) => a.enabled && a.id !== refreshed.id && blockedUntil(a) <= Date.now())
        if (!alternative || await getPendingHandoff(sessionId(ctx))) return
        try {
          await createHandoff(ctx, refreshed.id, alternative.id, "quota próxima do limite")
          bindings[sessionId(ctx)] = alternative.id
          await saveBindings()
          if (ctx.hasUI) ctx.ui.notify(`Handoff preventivo: quota de ${refreshed.label} próxima do limite`, "warning")
        } catch { /* quota handoff remains best-effort */ }
      }).catch(() => {})
    } else if ([401, 403, 429].includes(event.status) || event.status >= 500) {
      await store.recordOutcome(account.id, event.status, false, Date.now() + (event.status === 429 ? 30_000 : 300_000))
      const next = await usableAccount(ctx)
      if (!next) {
        await quota.refreshAll(true).catch(() => {})
        await queueQuotaWait(ctx, `todas as contas indisponíveis após ${event.status}`)
        if (ctx.hasUI) ctx.ui.notify("Todas as contas Codex estão indisponíveis; aguardando quota.", "warning")
      } else if (previous && next && next.id !== previous.id) {
        try {
          await createHandoff(ctx, previous.id, next.id, `falha ${event.status} da conta ${previous.label}`)
          bindings[sessionId(ctx)] = next.id
          await saveBindings()
          if (ctx.hasUI) ctx.ui.notify(`Failover Codex: handoff preparado para ${next.label}`, "warning")
        } catch (error) {
          if (ctx.hasUI) ctx.ui.notify(`Failover sem summarizer: ${error instanceof Error ? error.message : String(error)}`, "warning")
        }
      }
    }
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
    for (;;) {
      const action = await ctx.ui.select(`Fallbacks do handoff (${fallbacks.length} configurados)`, ["Adicionar fallback", "Remover fallback", "Limpar fallbacks", "Salvar", "Cancelar"])
      if (!action || action === "Cancelar") return
      if (action === "Salvar") break
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
    await saveHandoffSettings({ primary: primary as ModelRef | undefined, fallbacks, maxInputChars: current.maxInputChars })
    ctx.ui.notify(`Summarizer salvo: ${primary ?? "modelo atual + fallbacks"}`, "info")
  } })
  pi.registerCommand("codex-handoff", { description: "Gerar handoff e abrir uma nova sessão", handler: async (args, ctx) => {
    if (!ctx.hasUI) return
    const result = await createHandoff(ctx, undefined, undefined, args.trim() || "handoff manual")
    if (!result) return ctx.ui.notify("Não há conversa para transferir.", "warning")
    const prompt = `${result.text}${args.trim() ? `\\n\\n## Próximo objetivo\\n${args.trim()}` : ""}`
    const replacement = await ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile(), withSession: async (next) => { next.ui.setEditorText(prompt); next.ui.notify(`Handoff gerado com ${result.model}. Revise e envie.`, "info") } })
    if (replacement.cancelled) ctx.ui.notify("Handoff cancelado.", "info")
  } })
  pi.registerCommand("codex-accounts", { description: "Gerenciar contas ChatGPT Codex", handler: async (_args, ctx) => menu(ctx) })
  pi.registerCommand("codex-account-add", { description: "Adicionar uma conta ChatGPT Codex", handler: async (_args, ctx) => addAccount(ctx) })
  pi.registerTool({ name: "codex_accounts_list", label: "Codex accounts", description: "List configured Codex accounts without credentials", parameters: Type.Object({}), async execute() { const data = await accounts(); return { content: [{ type: "text", text: JSON.stringify(data.accounts.map(publicAccount), null, 2) }], details: {} } } })
  pi.registerTool({ name: "codex_account_current", label: "Current Codex account", description: "Show the Codex account assigned to this Pi session", parameters: Type.Object({}), async execute(_id, _params, _signal, _onUpdate, ctx) { await loadBindings(); const id = bindings[sessionId(ctx)]; const account = (await accounts()).accounts.find((a) => a.id === id); return { content: [{ type: "text", text: account ? JSON.stringify(publicAccount(account), null, 2) : "No Codex account assigned" }], details: {} } } })
  pi.registerTool({ name: "codex_account_set_active", label: "Set Codex account", description: "Assign an enabled Codex account to this Pi session", parameters: Type.Object({ accountId: Type.String() }), async execute(_id, params, _signal, _onUpdate, ctx) { const account = (await accounts()).accounts.find((a) => a.id === params.accountId); if (!account || !account.enabled) return { content: [{ type: "text", text: "Account not found or disabled" }], isError: true, details: {} }; await loadBindings(); bindings[sessionId(ctx)] = account.id; await saveBindings(); return { content: [{ type: "text", text: `Active account: ${account.label}` }], details: {} } } })
  pi.registerTool({ name: "codex_quota_refresh", label: "Refresh Codex quota", description: "Refresh quota for one account or all enabled accounts", parameters: Type.Object({ accountId: Type.Optional(Type.String()) }), async execute(_id, params) { if (params.accountId) { const account = (await accounts()).accounts.find((a) => a.id === params.accountId); if (!account) return { content: [{ type: "text", text: "Account not found" }], isError: true, details: {} }; await quota.refresh(account, true) } else await quota.refreshAll(true); return { content: [{ type: "text", text: JSON.stringify((await accounts()).accounts.map(publicAccount), null, 2) }], details: {} } } })
  pi.registerTool({ name: "codex_account_enable", label: "Enable or disable Codex account", description: "Enable or disable an account in the pool", parameters: Type.Object({ accountId: Type.String(), enabled: Type.Boolean() }), async execute(_id, params) { const ok = await store.setEnabled(params.accountId, params.enabled); return { content: [{ type: "text", text: ok ? `Account ${params.enabled ? "enabled" : "disabled"}` : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_account_rename", label: "Rename Codex account", description: "Change an account display label", parameters: Type.Object({ accountId: Type.String(), label: Type.String() }), async execute(_id, params) { const ok = await store.renameAccount(params.accountId, params.label); return { content: [{ type: "text", text: ok ? "Account renamed" : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_account_set_priority", label: "Set Codex account priority", description: "Move an account to a 1-based priority position", parameters: Type.Object({ accountId: Type.String(), priority: Type.Integer({ minimum: 1 }) }), async execute(_id, params) { const ok = await store.setPriority(params.accountId, params.priority - 1); return { content: [{ type: "text", text: ok ? "Priority updated" : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_handoff_now", label: "Create Codex handoff", description: "Generate a provider-agnostic context handoff using the configured primary/fallback models", parameters: Type.Object({ reason: Type.Optional(Type.String()) }), async execute(_id, params, _signal, _onUpdate, ctx) { try { const result = await createHandoff(ctx, undefined, undefined, params.reason ?? "manual agent request"); return { content: [{ type: "text", text: result?.text ?? "No conversation available" }], details: { model: result?.model } } } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true, details: {} } } } })
  pi.registerTool({ name: "codex_accounts_set_default", label: "Set primary Codex account", description: "Make an account primary for new sessions", parameters: Type.Object({ accountId: Type.String() }), async execute(_id, params) { const ok = await store.setDefault(params.accountId); return { content: [{ type: "text", text: ok ? "Primary account updated" : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_accounts_remove", label: "Remove Codex account", description: "Remove an account and its local OAuth tokens", parameters: Type.Object({ accountId: Type.String() }), async execute(_id, params) { const ok = await store.remove(params.accountId); return { content: [{ type: "text", text: ok ? "Account removed" : "Account not found" }], isError: !ok, details: {} } } })
  pi.registerTool({ name: "codex_handoff_status", label: "Codex handoff status", description: "Inspect the current account and pending handoff", parameters: Type.Object({}), async execute(_id, _params, _signal, _onUpdate, ctx) { await loadBindings(); const current = (await accounts()).accounts.find((a) => a.id === bindings[sessionId(ctx)]); const pending = await getPendingHandoff(sessionId(ctx)); const settings = await loadHandoffSettings(); return { content: [{ type: "text", text: JSON.stringify({ account: current ? publicAccount(current) : undefined, pending: Boolean(pending), primary: settings.primary, fallbacks: settings.fallbacks }, null, 2) }], details: {} } } })
  pi.registerTool({ name: "codex_handoff_note", label: "Save handoff note", description: "Save a durable note to include in future handoffs", parameters: Type.Object({ note: Type.String() }), async execute(_id, params, _signal, _onUpdate, ctx) { await addHandoffNote(sessionId(ctx), params.note); return { content: [{ type: "text", text: "Handoff note saved" }], details: {} } } })
  pi.registerCommand("codex-handoff-status", { description: "Mostrar status da conta e do handoff", handler: async (_args, ctx) => { await loadBindings(); const current = (await accounts()).accounts.find((a) => a.id === bindings[sessionId(ctx)]); const settings = await loadHandoffSettings(); const pending = await getPendingHandoff(sessionId(ctx)); ctx.ui.notify(`Conta: ${current?.label ?? "nenhuma"} | primary: ${settings.primary ?? "modelo atual"} | fallbacks: ${settings.fallbacks.length} | handoff pendente: ${pending ? "sim" : "não"}`, "info") } })
  pi.registerCommand("codex-waiting", { description: "Mostrar ou cancelar espera por quota Codex", handler: async (args, ctx) => { await loadWaiting(); const job = waiting[sessionId(ctx)]; if (args.trim() === "cancel") { delete waiting[sessionId(ctx)]; await saveWaiting(); ctx.ui.notify("Espera cancelada.", "info"); return } ctx.ui.notify(job ? `Aguardando quota até ${new Date(job.resumeAt).toLocaleString()} (${job.reason}). Use /codex-waiting cancel para cancelar.` : "Nenhuma espera ativa.", "info") } })
}
