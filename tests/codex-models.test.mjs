import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import ts from "typescript"

const source = await readFile(new URL("../src/codex-models.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
const { mergeCodexModels, refreshedCodexModelConfigs, fetchOfficialCodexCatalog } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
const base = { id: "gpt-6-sol", name: "Pi Sol", provider: "openai-codex", api: "openai-codex-responses", reasoning: true,
  input: ["text", "image"], contextWindow: 272000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsAdditionalTools: true } }
const cacheModel = { slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", visibility: "list", supported_in_api: true,
  context_window: 300000, supported_reasoning_levels: [{ effort: "high" }], input_modalities: ["text", "image"] }

test("new visible CLI models join Pi models without advertising unsupported capabilities", () => {
  const models = mergeCodexModels([base], [], { models: [cacheModel] })
  assert.deepEqual(models.map(x => x.id), ["gpt-6-sol", "gpt-6.1-sol"])
  assert.equal(models[1].contextWindow, 300000)
  assert.equal(models[1].maxTokens, 128000)
  assert.equal(models[1].reasoning, true)
  assert.deepEqual(models[1].compat, { supportsOpenAIGrammarTools: true })
})

test("hidden, unsupported, malformed and existing models are not imported from CLI", () => {
  const models = mergeCodexModels([base], [], { models: [
    { ...cacheModel, slug: "hidden", visibility: "hide" },
    { ...cacheModel, slug: "disabled", supported_in_api: false },
    { ...cacheModel, slug: "../../escape" },
    { ...cacheModel, slug: base.id, display_name: "Do not replace Pi metadata" },
  ] })
  assert.deepEqual(models, [base])
})

test("effective Pi registry overrides stored metadata and invalid stored APIs are ignored", () => {
  const current = { ...base, name: "Registry" }
  const models = mergeCodexModels([base], [{ ...base, name: "Stored" }, { ...base, id: "bad", api: "unrelated" }], null, [current])
  assert.deepEqual(models, [current])
})

test("official account-scoped catalog is additive even without Codex CLI cache", () => {
  const models = mergeCodexModels([base], [], undefined, [], { models: [cacheModel] })
  assert.equal(models.find(model => model.id === "gpt-6.1-sol")?.provider, "openai-codex")
})

test("official Codex backend uses account credentials only in headers and persists sanitized visible entries", async () => {
  const result = await fetchOfficialCodexCatalog("secret-token", "workspace-123", "0.159.0", async (url, options) => {
    assert.equal(url.origin, "https://chatgpt.com")
    assert.equal(url.pathname, "/backend-api/codex/models")
    assert.equal(url.searchParams.get("client_version"), "0.159.0")
    assert.doesNotMatch(String(url), /secret-token/)
    assert.equal(options.headers.Authorization, "Bearer secret-token")
    assert.equal(options.headers["ChatGPT-Account-Id"], "workspace-123")
    assert.equal(options.redirect, "error")
    return new Response(JSON.stringify({ models: [
      { ...cacheModel, secret: "not persisted" },
      { ...cacheModel, slug: "hidden", visibility: "hide" },
    ] }), { status: 200 })
  })
  assert.deepEqual(result.models.map(model => model.slug), ["gpt-6.1-sol"])
  assert.doesNotMatch(JSON.stringify(result), /secret/)
})

test("without Codex CLI the official request still uses a supported client version", async () => {
  await fetchOfficialCodexCatalog("token", undefined, undefined, async (url) => {
    assert.equal(url.searchParams.get("client_version"), "0.159.0")
    return new Response(JSON.stringify({ models: [] }), { status: 200 })
  })
})

test("official catalog errors do not include credentials", async () => {
  await assert.rejects(fetchOfficialCodexCatalog("secret-token", undefined, "0.0.0", async () => new Response("no", { status: 401 })), /HTTP 401/)
})

test("local CLI cache is read on refresh without network or credentials", async () => {
  const dir = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const tmp = await dir.mkdtemp(path.join(os.tmpdir(), "pi-codex-models-"))
  const old = process.env.CODEX_HOME
  try {
    process.env.CODEX_HOME = tmp
    await dir.writeFile(path.join(tmp, "models_cache.json"), JSON.stringify({ models: [cacheModel] }))
    const configs = await refreshedCodexModelConfigs([base], [])
    assert.ok(configs.some(model => model.id === "gpt-6.1-sol"))
  } finally {
    if (old === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = old
    await dir.rm(tmp, { recursive: true, force: true })
  }
})
