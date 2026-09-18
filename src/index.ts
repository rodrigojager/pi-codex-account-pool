import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { promisify } from "node:util"
import { Type } from "typebox"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { AccountStore, type Account } from "./store"
import { browserAuthorization, deviceAuthorization, tokenIdentity, refreshTokens } from "./oauth"
import { paths } from "./storage"

const exec = promisify(execFile)
const PROVIDERS = new Set((process.env.PI_CODEX_ACCOUNT_POOL_PROVIDERS ?? "openai-codex").split(",").map((x) => x.trim()).filter(Boolean))
const store = new AccountStore()
const bindingsPath = join(paths.root, "bindings.json")
let bindings: Record<string, string> = {}
let initialized = false

async function loadBindings() {
  if (initialized) return
  initialized = true
  try { bindings = JSON.parse(await readFile(bindingsPath, "utf8")) } catch { bindings = {} }
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
  return candidates.find((a) => a.enabled && (a.health.cooldownUntil ?? 0) <= now) ?? candidates.find((a) => a.enabled)
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
function openBrowser(url: string) {
  if (process.platform === "win32") return exec("cmd", ["/c", "start", "", url]).catch(() => {})
  return exec(process.platform === "darwin" ? "open" : "xdg-open", [url]).catch(() => {})
}
async function addAccount(ctx: ExtensionContext) {
  if (!ctx.hasUI) throw new Error("Adicionar conta requer o modo interativo do Pi")
  const method = await ctx.ui.select("Login Codex", ["Browser OAuth", "Device code"])
  if (!method) return
  let tokens
  if (method === "Browser OAuth") {
    const auth = await browserAuthorization()
    await openBrowser(auth.url)
    ctx.ui.notify("A janela de login do ChatGPT foi aberta.", "info")
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
    const choices = ["+ Adicionar conta", "Atualizar tokens", ...data.accounts.map((a) => `${a.enabled ? "●" : "○"} ${a.label}${a.email ? ` — ${a.email}` : ""}`), "Fechar"]
    const choice = await ctx.ui.select("Codex Account Pool", choices)
    if (!choice || choice === "Fechar") return
    if (choice === "+ Adicionar conta") { try { await addAccount(ctx) } catch (e) { ctx.ui.notify(String(e), "error") }; continue }
    if (choice === "Atualizar tokens") { ctx.ui.notify("Tokens são renovados automaticamente antes de expirar.", "info"); continue }
    const account = data.accounts.find((a) => choice.includes(a.label))
    if (!account) continue
    const action = await ctx.ui.select(account.label, ["Usar nesta sessão", account.enabled ? "Desativar" : "Ativar", "Definir como principal", "Renomear", "Remover", "Voltar"])
    if (action === "Usar nesta sessão") { await loadBindings(); bindings[sessionId(ctx)] = account.id; await saveBindings(); ctx.ui.notify(`Conta ativa: ${account.label}`, "info") }
    else if (action === "Desativar") await store.setEnabled(account.id, false)
    else if (action === "Ativar") await store.setEnabled(account.id, true)
    else if (action === "Definir como principal") await store.setDefault(account.id)
    else if (action === "Renomear") { const label = await ctx.ui.input("Novo nome", account.label); if (label) await store.renameAccount(account.id, label) }
    else if (action === "Remover" && await ctx.ui.confirm("Remover conta?", "Os tokens locais serão apagados.")) await store.remove(account.id)
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await store.initialize()
    const account = await usableAccount(ctx)
    if (account && ctx.hasUI) ctx.ui.setStatus("codex-account-pool", `Codex: ${account.label}`)
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
  pi.on("after_provider_response", async (event, ctx) => {
    if (!ctx.model || !PROVIDERS.has(ctx.model.provider)) return
    const account = await usableAccount(ctx)
    if (!account) return
    if (event.status >= 200 && event.status < 400) await store.recordOutcome(account.id, event.status, true)
    else if ([401, 403, 429].includes(event.status) || event.status >= 500) await store.recordOutcome(account.id, event.status, false, Date.now() + (event.status === 429 ? 30_000 : 300_000))
  })
  pi.registerCommand("codex-accounts", { description: "Gerenciar contas ChatGPT Codex", handler: async (_args, ctx) => menu(ctx) })
  pi.registerCommand("codex-account-add", { description: "Adicionar uma conta ChatGPT Codex", handler: async (_args, ctx) => addAccount(ctx) })
  pi.registerTool({ name: "codex_accounts_list", label: "Codex accounts", description: "List configured Codex accounts without credentials", parameters: Type.Object({}), async execute() { const data = await accounts(); return { content: [{ type: "text", text: JSON.stringify(data.accounts.map(publicAccount), null, 2) }], details: {} } } })
  pi.registerTool({ name: "codex_account_current", label: "Current Codex account", description: "Show the Codex account assigned to this Pi session", parameters: Type.Object({}), async execute(_id, _params, _signal, _onUpdate, ctx) { await loadBindings(); const id = bindings[sessionId(ctx)]; const account = (await accounts()).accounts.find((a) => a.id === id); return { content: [{ type: "text", text: account ? JSON.stringify(publicAccount(account), null, 2) : "No Codex account assigned" }], details: {} } } })
  pi.registerTool({ name: "codex_account_set_active", label: "Set Codex account", description: "Assign an enabled Codex account to this Pi session", parameters: Type.Object({ accountId: Type.String() }), async execute(_id, params, _signal, _onUpdate, ctx) { const account = (await accounts()).accounts.find((a) => a.id === params.accountId); if (!account || !account.enabled) return { content: [{ type: "text", text: "Account not found or disabled" }], isError: true, details: {} }; await loadBindings(); bindings[sessionId(ctx)] = account.id; await saveBindings(); return { content: [{ type: "text", text: `Active account: ${account.label}` }], details: {} } } })
}
