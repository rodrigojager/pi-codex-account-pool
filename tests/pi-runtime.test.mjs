import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import ts from "typescript"
import * as legacy from "@earendil-works/pi-ai/compat"
import * as transcript from "pi-ai-transcript-test/compat"

const source = await readFile(new URL("../src/pi-runtime.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { prepareContext, createCodexRuntime, handoffMessages } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
const tool = (name) => ({ name, description: `Tool ${name}`, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } })
const user = { role: "user", content: "Read the local file with read.", timestamp: 1 }
const oldContext = { systemPrompt: "You are a local coding agent with filesystem tools.", tools: [tool("read")], messages: [user] }
const newContext = { messages: [{ role: "system", content: "", sections: { preamble: oldContext.systemPrompt }, toolsAdded: oldContext.tools, timestamp: 0 }, user] }
const changedContext = { messages: [
  { role: "system", content: "Base instructions", sections: { cwd: "OLD_DIRECTORY", obsolete: "REMOVE_THIS" }, toolsAdded: [tool("read"), tool("old_tool")], timestamp: 0 },
  user,
  { role: "system", content: "Additional instructions", sections: { cwd: "NEW_DIRECTORY", obsolete: null }, toolsRemoved: [{ name: "old_tool" }], toolsAdded: [tool("edit")], timestamp: 2 },
  { ...user, timestamp: 3 },
] }

// The hook aborts before HTTP/WebSocket creation. No real auth or request is used.
async function capture(host, context, compat) {
  const runtime = createCodexRuntime(host)
  const model = runtime.models().find((model) => model.id === "gpt-6-astra") ?? runtime.models()[0]
  const apiKey = `offline.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64url")}.offline`
  let payload
  let attemptedNetwork = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { attemptedNetwork++; throw new Error("UNEXPECTED_NETWORK") }
  try {
    const stream = runtime.streamSimple({ ...model, provider: "codex-account-pool", compat: { ...model.compat, ...compat } }, context, {
      apiKey, transport: "sse", reasoning: "xhigh", maxRetries: 0,
      onPayload(value) { payload = value; throw new Error("OFFLINE_CAPTURE_COMPLETE") },
    })
    for await (const _event of stream) { /* drain without networking */ }
    const result = await stream.result()
    assert.match(result.errorMessage, /OFFLINE_CAPTURE_COMPLETE/)
    assert.equal(attemptedNetwork, 0)
    assert.ok(payload)
    return payload
  } finally {
    globalThis.fetch = originalFetch
  }
}

for (const [label, host] of [["0.85.1", legacy], ["0.86.1", transcript]]) {
  for (const [format, context] of [["flat", oldContext], ["transcript", newContext]]) {
    test(`host ${label}: ${format} context sends instructions and filesystem tools`, async () => {
      const payload = await capture(host, context)
      assert.match(payload.instructions, /local coding agent with filesystem tools/)
      assert.deepEqual(payload.tools.map((tool) => tool.name), ["read"])
      assert.equal(payload.reasoning.effort, "xhigh")
      assert.match(JSON.stringify(payload.input), /Read the local file/)
    })
  }
  test(`host ${label}: ordered section and tool deltas survive`, async () => {
    const payload = await capture(host, changedContext, { supportsMidConvoSystemMessages: false })
    assert.match(payload.instructions, /Base instructions/)
    assert.match(payload.instructions, /Additional instructions/)
    assert.match(payload.instructions, /NEW_DIRECTORY/)
    assert.doesNotMatch(payload.instructions, /OLD_DIRECTORY|REMOVE_THIS/)
    assert.deepEqual(payload.tools.map((tool) => tool.name).sort(), ["edit", "read"])
  })
  test(`host ${label}: handoff retains system state beyond the dialogue tail`, async () => {
    const messages = [...changedContext.messages, ...Array.from({ length: 20 }, (_, i) => ({ ...user, content: `Dialogue ${i}`, timestamp: 10 + i }))]
    const checkpoint = { ...user, content: "HANDOFF_CHECKPOINT" }
    const trimmed = handoffMessages(messages, checkpoint, host)
    assert.equal(trimmed.filter((message) => message.role !== "system").length, 9)
    const payload = await capture(host, { messages: trimmed })
    assert.match(payload.instructions, /NEW_DIRECTORY/)
    assert.deepEqual(payload.tools.map((tool) => tool.name).sort(), ["edit", "read"])
    assert.match(JSON.stringify(payload.input), /HANDOFF_CHECKPOINT/)
    assert.doesNotMatch(JSON.stringify(payload.input), /Dialogue 11\b/)
  })
}

test("transcript host preserves in-conversation system updates when the model supports them", async () => {
  const payload = await capture(transcript, changedContext, { supportsMidConvoSystemMessages: true })
  assert.match(payload.instructions, /Base instructions/)
  const updates = payload.input.filter((message) => message.role === "developer" || message.role === "system")
  assert.match(JSON.stringify(updates), /Additional instructions/)
  assert.match(JSON.stringify(updates), /NEW_DIRECTORY/)
  assert.deepEqual(payload.tools.map((tool) => tool.name).sort(), ["edit", "read"])
})

test("legacy flat context and conversation objects stay intact", () => {
  assert.equal(prepareContext(oldContext, legacy), oldContext)
  const mixed = { ...oldContext, messages: changedContext.messages }
  const normalized = prepareContext(mixed, legacy)
  assert.match(normalized.systemPrompt, /local coding agent/)
  assert.equal(normalized.messages[0], user)
  assert.deepEqual(mixed.messages, changedContext.messages)
})

test("host normalizer and transport are selected by capabilities, not version strings", () => {
  const calls = []
  const normalized = { messages: [] }
  const host = {
    normalizeContext: (context) => { assert.equal(context, oldContext); return normalized },
    getModels: (provider) => { assert.equal(provider, "openai-codex"); return ["host-model"] },
    openAICodexResponsesApi: () => ({ streamSimple: (...args) => { calls.push(args); return "stream" } }),
    lazyStream: (_model, setup) => setup(),
    cleanupSessionResources: (id) => calls.push(id),
  }
  const runtime = createCodexRuntime(host)
  const options = { reasoning: "xhigh", signal: new AbortController().signal }
  assert.deepEqual(runtime.models(), ["host-model"])
  assert.equal(runtime.streamSimple("model", oldContext, options), "stream")
  assert.deepEqual(calls[0], ["model", normalized, options])
  runtime.cleanupSession("only-this-session")
  assert.equal(calls[1], "only-this-session")
  for (const missing of ["openAICodexResponsesApi", "getModels", "lazyStream"]) {
    assert.throws(() => createCodexRuntime({ ...host, [missing]: undefined }), new RegExp(missing))
  }
})

test("pool entry does not resolve a private SDK transport or model catalog", async () => {
  const entry = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.doesNotMatch(entry, /from ["']@earendil-works\/pi-ai\/(?:api|providers)\//)
  assert.match(entry, /handoffMessages\(event.messages/)
})
