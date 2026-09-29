import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Model } from "@earendil-works/pi-ai"

type CodexCacheModel = {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  supported_in_api?: unknown
  context_window?: unknown
  input_modalities?: unknown
  supported_reasoning_levels?: unknown
}

export const codexCachePath = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json")
export const officialCatalogPath = () => join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "codex-account-pool", "official-models.json")
export const OFFICIAL_CATALOG_TTL_MS = 4 * 60 * 60 * 1000
// The backend filters models by client version. 0.0.0 returns an older subset;
// allow overriding this fallback without requiring a Codex CLI installation.
export const DEFAULT_CODEX_CLIENT_VERSION = "0.159.0"

export function poolModelConfig(model: Model<any>) {
  return {
    id: model.id, name: model.name, api: model.api, reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap, input: [...model.input], cost: model.cost,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, compat: model.compat,
  }
}

function validStoredModel(value: unknown): value is Model<any> {
  if (!value || typeof value !== "object") return false
  const model = value as Partial<Model<any>>
  return typeof model.id === "string" && typeof model.name === "string" && model.api === "openai-codex-responses" &&
    typeof model.reasoning === "boolean" && Array.isArray(model.input) && typeof model.contextWindow === "number" &&
    typeof model.maxTokens === "number" && !!model.cost && typeof model.cost === "object"
}

/** Fetch the account-scoped catalog from the official Codex backend (not the API-key /v1/models).
 * Only public model metadata is persisted; credentials never leave the request headers.
 */
export async function fetchOfficialCodexCatalog(
  accessToken: string, accountID: string | undefined, clientVersion = DEFAULT_CODEX_CLIENT_VERSION,
  fetchFn: typeof fetch = fetch, signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<{ models: CodexCacheModel[] }> {
  const url = new URL("https://chatgpt.com/backend-api/codex/models")
  url.searchParams.set("client_version", /^[0-9]+\.[0-9]+\.[0-9]+$/.test(clientVersion) ? clientVersion : DEFAULT_CODEX_CLIENT_VERSION)
  const response = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(accountID ? { "ChatGPT-Account-Id": accountID } : {}),
      Accept: "application/json",
      originator: "codex_cli_rs",
    },
    redirect: "error",
    signal,
  })
  if (!response.ok) throw new Error(`Codex model catalog request failed: HTTP ${response.status}`)
  if (Number(response.headers.get("content-length")) > 1024 * 1024) throw new Error("Codex model catalog exceeds 1 MiB")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Empty Codex model catalog")
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error("Codex model catalog exceeds 1 MiB") }
    chunks.push(value)
  }
  const raw = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as { models?: unknown }
  if (!Array.isArray(raw.models)) throw new Error("Invalid Codex model catalog")
  return { models: raw.models.filter((model: unknown): model is CodexCacheModel => {
    if (!model || typeof model !== "object") return false
    const row = model as CodexCacheModel
    return typeof row.slug === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(row.slug) &&
      row.visibility === "list" && row.supported_in_api === true
  }).map((row: CodexCacheModel) => ({
    slug: row.slug, display_name: row.display_name, visibility: row.visibility,
    supported_in_api: row.supported_in_api, context_window: row.context_window,
    input_modalities: row.input_modalities, supported_reasoning_levels: row.supported_reasoning_levels,
  })) }
}

/** Merge the independently fetched Codex backend catalog, CLI cache, and Pi models.
 * Keep Pi's metadata where available; never expose hidden/internal models.
 */
export function mergeCodexModels(baseline: Model<any>[], stored: unknown, cache: unknown, current: Model<any>[] = [], official: unknown = undefined): Model<any>[] {
  const byID = new Map<string, Model<any>>()
  for (const model of baseline) byID.set(model.id, model)
  if (Array.isArray(stored)) for (const model of stored) if (validStoredModel(model)) byID.set(model.id, model)
  for (const model of current) byID.set(model.id, model)
  for (const catalog of [official, cache]) {
    const models = catalog && typeof catalog === "object" && "models" in catalog ? (catalog as { models: unknown }).models : undefined
    if (!Array.isArray(models)) continue
    for (const value of models as CodexCacheModel[]) {
    if (!value || typeof value.slug !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(value.slug) ||
      value.visibility !== "list" || value.supported_in_api !== true || byID.has(value.slug)) continue
    const prefix = value.slug.match(/^(gpt-[\d.]+)/)?.[1]
    const template = [...byID.values()].find((model) => prefix && model.id.startsWith(prefix)) ?? baseline[0]
    if (!template) continue
    const contextWindow = value.context_window
    const input = Array.isArray(value.input_modalities)
      ? value.input_modalities.filter((item): item is "text" | "image" => item === "text" || item === "image")
      : ["text"]
    byID.set(value.slug, {
      ...template,
      id: value.slug,
      name: typeof value.display_name === "string" && value.display_name.trim() ? value.display_name : value.slug,
      provider: "openai-codex",
      api: "openai-codex-responses",
      input: input.length ? input : ["text"],
      reasoning: Array.isArray(value.supported_reasoning_levels) && value.supported_reasoning_levels.length > 0,
      contextWindow: typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : template.contextWindow,
      // Codex's cache does not expose max output tokens. Retain Pi's conservative limit.
      maxTokens: template.maxTokens,
      // Do not infer advanced wire capabilities from an unrelated model.
      compat: { supportsOpenAIGrammarTools: true },
    } as Model<any>)
    }
  }
  return [...byID.values()]
}

export async function refreshedCodexModelConfigs(baseline: Model<any>[], current: Model<any>[]) {
  let stored: unknown
  let cache: unknown
  let official: unknown
  try {
    const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent")
    const raw = JSON.parse(await readFile(join(agentDir, "models-store.json"), "utf8"))
    stored = raw["openai-codex"]?.models
  } catch { /* offline: keep Pi's embedded catalog */ }
  try {
    cache = JSON.parse(await readFile(codexCachePath(), "utf8"))
  } catch { /* Codex CLI not installed or its cache is temporarily being replaced */ }
  try {
    official = JSON.parse(await readFile(officialCatalogPath(), "utf8"))
  } catch { /* No previous account-specific catalog. */ }
  return mergeCodexModels(baseline, stored, cache, current, official).map(poolModelConfig)
}
