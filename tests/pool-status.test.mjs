import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import ts from "typescript"

const source = await readFile(new URL("../src/pool-status.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { setPoolStatus, registerPoolStatus } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

function fixture(provider = "codex-account-pool") {
  let model = provider ? { provider } : undefined
  const statuses = new Map()
  const ctx = {
    hasUI: true,
    get model() { return model },
    ui: { setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value) } },
  }
  const handlers = new Map()
  const pi = { on(event, handler) { handlers.set(event, handler) } }
  return {
    ctx, pi, statuses,
    switchTo(provider) { model = provider ? { provider } : undefined; return handlers.get("model_select")?.({}, ctx) },
  }
}

test("session account activation and rotation never display the pool label on another provider", () => {
  for (const provider of ["openai-codex", "opencode-direct", "amazon-bedrock", undefined]) {
    const h = fixture(provider)
    if (provider === undefined) h.switchTo(undefined)
    h.statuses.set("unrelated", "Keep this status")
    h.statuses.set("codex-account-pool", "Codex Pool: previous account")
    setPoolStatus(h.ctx, "Conta gmail")
    assert.equal(h.statuses.has("codex-account-pool"), false)
    assert.equal(h.statuses.get("unrelated"), "Keep this status")
    setPoolStatus(h.ctx, "Rotated account")
    assert.equal(h.statuses.has("codex-account-pool"), false)
  }
})

test("model changes clear the whole pool status and restore the current account when returning", async () => {
  const h = fixture()
  let label = "Conta gmail", reads = 0
  registerPoolStatus(h.pi, async () => { reads++; return label })
  setPoolStatus(h.ctx, label)
  assert.equal(h.statuses.get("codex-account-pool"), "Codex Pool: Conta gmail")
  await h.switchTo("openai-codex")
  assert.equal(h.statuses.has("codex-account-pool"), false)
  assert.equal(reads, 0)
  label = "Second account"
  await h.switchTo("codex-account-pool")
  assert.equal(h.statuses.get("codex-account-pool"), "Codex Pool: Second account")
  label = undefined
  await h.switchTo("codex-account-pool")
  assert.equal(h.statuses.has("codex-account-pool"), false)
})

test("an account read finishing after a provider switch cannot bring the pool footer back", async () => {
  const h = fixture()
  let resolveAccount
  registerPoolStatus(h.pi, () => new Promise((resolve) => { resolveAccount = resolve }))
  const pending = h.switchTo("codex-account-pool")
  await h.switchTo("opencode-direct")
  resolveAccount("Conta gmail")
  await pending
  assert.equal(h.statuses.has("codex-account-pool"), false)
})

test("headless sessions do not issue status updates", () => {
  const h = fixture()
  h.ctx.hasUI = false
  h.ctx.ui.setStatus = () => assert.fail("No status update without UI")
  setPoolStatus(h.ctx, "Conta gmail")
  setPoolStatus(undefined, "Conta gmail")
})
