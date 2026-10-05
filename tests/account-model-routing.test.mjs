import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

test("actual Pi provider retries the same model on another account without a global cooldown", { skip: !process.env.PI_TEST_PACKAGE }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-pool-model-test-"))
  const before = process.env.PI_CODEX_ACCOUNT_POOL_DATA_DIR
  process.env.PI_CODEX_ACCOUNT_POOL_DATA_DIR = fixture
  const account = id => ({ id, label: id, workspaceAccountID: id, accessToken: `offline.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.offline`, refreshToken: "offline", expiresAt: Date.now() + 3600_000, enabled: true, createdAt: Date.now(), updatedAt: Date.now(), health: { successes: 0, failures: 0 } })
  const accountsPath = join(fixture, "accounts.json")
  await writeFile(accountsPath, JSON.stringify({ version: 2, initialized: true, revision: 0, order: ["free", "pro"], defaultAccountID: "free", accounts: [account("free"), account("pro")] }))
  try {
    const loader = await import(pathToFileURL(`${process.env.PI_TEST_PACKAGE}/dist/core/extensions/loader.js`))
    const loaded = await loader.loadExtensions([fileURLToPath(new URL("../src/index.ts", import.meta.url))], fixture)
    assert.deepEqual(loaded.errors, [])
    const provider = loaded.runtime.pendingProviderRegistrations.find(p => p.name === "codex-account-pool").config
    const baseline = provider.models.find(m => m.id === "gpt-6-sol") ?? provider.models[0]
    const model = { ...baseline, id: "gpt-6.1-sol", provider: "codex-account-pool", baseUrl: provider.baseUrl }
    const requests = []
    const fetch = async (_url, init) => {
      const id = new Headers(init.headers).get("chatgpt-account-id")
      requests.push(id)
      if (id === "free") return new Response(JSON.stringify({ detail: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." }), { status: 400 })
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "offline-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    }
    const context = { messages: [{ role: "user", content: "Offline test", timestamp: 1 }] }
    async function run(selectedModel, fetchFn) {
      const payloads = []
      let starts = 0
      const stream = provider.streamSimple(selectedModel, context, { transport: "sse", fetch: fetchFn, maxRetries: 0, onPayload: payload => { payloads.push(payload.model) } })
      for await (const event of stream) { if (event.type === "start") starts++ }
      const result = await stream.result()
      return { result, payloads, starts }
    }
    const first = await run(model, fetch)
    assert.equal(first.result.stopReason, "stop", first.result.errorMessage)
    assert.deepEqual(requests, ["free", "pro"])
    assert.deepEqual(first.payloads, ["gpt-6.1-sol", "gpt-6.1-sol"])
    requests.length = 0
    assert.equal((await run(model, fetch)).result.stopReason, "stop")
    assert.deepEqual(requests, ["pro"], "known rejection is scoped to this account/model pair")
    const stored = JSON.parse(await readFile(accountsPath, "utf8"))
    assert.equal(stored.accounts[0].health.failures, 0)
    assert.equal(stored.accounts[0].health.cooldownUntil, undefined)
    requests.length = 0
    const other = await run({ ...model, id: "gpt-6-luna" }, async (_url, init) => {
      requests.push(new Headers(init.headers).get("chatgpt-account-id"))
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    })
    assert.equal(other.result.stopReason, "stop", other.result.errorMessage)
    assert.deepEqual(requests, ["free"])
    requests.length = 0
    const streamed = await run({ ...model, id: "gpt-stream-model" }, async (_url, init) => {
      const id = new Headers(init.headers).get("chatgpt-account-id")
      requests.push(id)
      const event = id === "free"
        ? { type: "error", code: "invalid_request_error", message: "The 'gpt-stream-model' model is not supported when using Codex with a ChatGPT account." }
        : { type: "response.completed", response: { status: "completed", output: [] } }
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } })
    })
    assert.equal(streamed.result.stopReason, "stop", streamed.result.errorMessage)
    assert.deepEqual(requests, ["free", "pro"], "a transport start does not mean model output was produced")
    assert.deepEqual(streamed.payloads, ["gpt-stream-model", "gpt-stream-model"])
    assert.equal(streamed.starts, 1, "the parent sees one request start across an empty retry")
    requests.length = 0
    const unavailable = { ...model, id: "gpt-inaccessible" }
    const reject = async (_url, init) => {
      requests.push(new Headers(init.headers).get("chatgpt-account-id"))
      return new Response(JSON.stringify({ detail: "The 'gpt-inaccessible' model is not supported when using Codex with a ChatGPT account." }), { status: 400 })
    }
    assert.equal((await run(unavailable, reject)).result.stopReason, "error")
    assert.deepEqual(requests, ["free", "pro"])
    requests.length = 0
    const repeated = await run(unavailable, reject)
    assert.equal(repeated.result.stopReason, "error")
    assert.match(repeated.result.errorMessage, /modelo gpt-inaccessible foi rejeitado/)
    assert.deepEqual(requests, [], "all rejected accounts fail clearly without repeating requests")
    const partial = await run({ ...model, id: "gpt-partial-model" }, async (_url, init) => {
      requests.push(new Headers(init.headers).get("chatgpt-account-id"))
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { id: "item-1", type: "message", role: "assistant", status: "in_progress", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "item-1", part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "item-1", delta: "partial output" },
        { type: "error", message: "The 'gpt-partial-model' model is not supported when using Codex with a ChatGPT account." },
      ]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    })
    assert.equal(partial.result.stopReason, "error")
    assert.deepEqual(requests, ["free"], "never replay a request after model output has begun")
    assert.equal(partial.result.content.find(part => part.type === "text").text, "partial output")
  } finally {
    if (before === undefined) delete process.env.PI_CODEX_ACCOUNT_POOL_DATA_DIR
    else process.env.PI_CODEX_ACCOUNT_POOL_DATA_DIR = before
    await rm(fixture, { recursive: true, force: true })
  }
})
