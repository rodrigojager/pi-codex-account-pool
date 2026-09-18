import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { uuidv7 } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent"
import { atomicWrite, paths } from "./storage"

export type ModelRef = `${string}/${string}`
export type HandoffSettings = { primary?: ModelRef; fallbacks: ModelRef[]; maxInputChars: number }
type SavedHandoff = { id: string; sessionID: string; sourceAccount?: string; targetAccount?: string; summary: string; createdAt: number }

const settingsPath = join(paths.root, "handoff.json")
const handoffsPath = join(paths.root, "handoffs.json")
const notesPath = join(paths.root, "notes.json")
const defaults: HandoffSettings = { fallbacks: [], maxInputChars: 80_000 }

export async function loadHandoffSettings(): Promise<HandoffSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8"))
    return { ...defaults, ...raw, fallbacks: Array.isArray(raw.fallbacks) ? raw.fallbacks : [] }
  } catch { return defaults }
}
export async function saveHandoffSettings(settings: HandoffSettings) {
  await atomicWrite(settingsPath, { ...defaults, ...settings }, false)
}
function parseModel(ref: string | undefined) {
  if (!ref) return undefined
  const slash = ref.indexOf("/")
  if (slash < 1 || slash === ref.length - 1) return undefined
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) }
}
function textOf(response: { content: Array<{ type: string; text?: string }> }) {
  return response.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim()
}
async function readSaved(): Promise<Record<string, SavedHandoff>> {
  try { return JSON.parse(await readFile(handoffsPath, "utf8")) } catch { return {} }
}
export async function addHandoffNote(sessionID: string, note: string) {
  let notes: Record<string, string[]> = {}
  try { notes = JSON.parse(await readFile(notesPath, "utf8")) } catch { /* first note */ }
  notes[sessionID] = [...(notes[sessionID] ?? []), note.trim()].filter(Boolean).slice(-50)
  await atomicWrite(notesPath, notes, false)
}
async function getNotes(sessionID: string) {
  try { const notes = JSON.parse(await readFile(notesPath, "utf8")) as Record<string, string[]>; return notes[sessionID] ?? [] } catch { return [] }
}
export async function getPendingHandoff(sessionID: string) {
  const data = await readSaved()
  return data[sessionID]
}
export async function clearPendingHandoff(sessionID: string) {
  const data = await readSaved()
  delete data[sessionID]
  await atomicWrite(handoffsPath, data, false)
}

export async function completeWithFailover(ctx: ExtensionContext, prompt: string, signal?: AbortSignal) {
  const settings = await loadHandoffSettings()
  const refs = [settings.primary, ...settings.fallbacks, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` as ModelRef : undefined].filter(Boolean) as string[]
  const unique = [...new Set(refs)]
  const errors: string[] = []
  for (const ref of unique) {
    const parsed = parseModel(ref)
    const model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) { errors.push(`${ref}: indisponível`); continue }
    try {
      const response = await ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { signal, cacheRetention: "none", sessionId: uuidv7(), maxTokens: 4096 })
      const text = textOf(response)
      if (text) return { text, model: ref }
      errors.push(`${ref}: resposta vazia`)
    } catch (error) { errors.push(`${ref}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  throw new Error(`Todos os modelos de summarizer falharam. ${errors.join("; ")}`)
}

export async function createHandoff(ctx: ExtensionContext, sourceAccount?: string, targetAccount?: string, reason = "failover") {
  const settings = await loadHandoffSettings()
  const branch = ctx.sessionManager.getBranch()
  if (!branch.length) return undefined
  const conversation = serializeConversation(convertToLlm(branch.map((entry) => entry.type === "message" ? entry.message : undefined).filter(Boolean) as never[])).slice(-settings.maxInputChars)
  const notes = await getNotes(ctx.sessionManager.getSessionId())
  const prompt = `Você é um summarizer de continuidade para um agente de programação. Gere um handoff conciso e acionável em Markdown. Preserve objetivo, decisões, arquivos alterados, testes/verificações, bloqueios e próximos passos. Não invente fatos.\n\nMotivo da troca: ${reason}\n\nNotas duráveis:\n${notes.map((note) => `- ${note}`).join("\\n") || "(nenhuma)"}\n\n<conversation>\n${conversation}\n</conversation>`
  const result = await completeWithFailover(ctx, prompt, ctx.signal)
  const sessionID = ctx.sessionManager.getSessionId()
  const data = await readSaved()
  data[sessionID] = { id: randomUUID(), sessionID, sourceAccount, targetAccount, summary: result.text, createdAt: Date.now() }
  await atomicWrite(handoffsPath, data, false)
  return result
}

export function handoffContextMessage(handoff: SavedHandoff) {
  return { role: "user" as const, content: [{ type: "text" as const, text: `## Contexto de continuidade (handoff automático)\n\n${handoff.summary}` }], timestamp: Date.now() }
}
