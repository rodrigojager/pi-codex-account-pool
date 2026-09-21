import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import vm from "node:vm"
import ts from "typescript"

const source = await readFile(new URL("../src/quota.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { QuotaService, QUOTA_CACHE_MS } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
const account = (id = "a") => ({ id, label: `Account ${id}`, enabled: true, accessToken: "SECRET_ACCESS", refreshToken: "SECRET_REFRESH", expiresAt: Date.now() + 3_600_000, workspaceAccountID: id })
const payload = (used) => ({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000 } } })
class MemoryStore {
  data = [account()]
  async initialize() {}
  async snapshot() { return { accounts: structuredClone(this.data), defaultAccountID: "a" } }
  async updateQuota(id, quota) {
    const row = this.data.find((item) => item.id === id)
    if (!row) return false
    row.quota = quota
    return true
  }
}

test("fresh quota is read from store, expires in 15s, and forced refresh publishes 98 -> 20 -> 0 remaining", async () => {
  assert.equal(QUOTA_CACHE_MS, 15_000)
  const store = new MemoryStore()
  let used = 2, calls = 0
  const service = new QuotaService(store, async () => { calls++; return Response.json(payload(used)) })
  const observed = []
  const stop = service.onUpdate((_account, quota) => observed.push(100 - quota.primary.usedPercent))
  const staleAccount = account()
  const first = await service.refresh(staleAccount)
  assert.equal((await service.refresh(staleAccount)).fetchedAt, first.fetchedAt)
  assert.equal(calls, 1, "old stream objects must not bypass the current store cache")
  store.data[0].quota.fetchedAt = Date.now() - QUOTA_CACHE_MS - 1
  used = 80
  await service.refresh(staleAccount)
  used = 100
  await service.refresh(staleAccount, true)
  assert.deepEqual(observed, [98, 20, 0])
  stop()
  await service.refresh(staleAccount, true)
  assert.equal(observed.length, 3)
})

test("concurrent requests are coalesced per account, failed refreshes never renew cache age", async () => {
  const store = new MemoryStore()
  let release, calls = 0
  const service = new QuotaService(store, () => { calls++; return new Promise((resolve) => { release = resolve }) })
  const first = service.refresh(account(), true)
  const second = service.refresh(account(), true)
  await new Promise(setImmediate)
  assert.equal(calls, 1)
  release(Response.json(payload(2)))
  assert.equal((await first).fetchedAt, (await second).fetchedAt)
  const saved = structuredClone(store.data[0].quota)
  const failed = service.refresh(account(), true)
  await new Promise(setImmediate)
  release(new Response("unavailable", { status: 503 }))
  await assert.rejects(failed, /503/)
  assert.deepEqual(store.data[0].quota, saved)
  const retry = service.refresh(account(), true)
  await new Promise(setImmediate)
  release(Response.json(payload(100)))
  assert.equal((await retry).primary.usedPercent, 100)
})

test("bridge pushes sanitized updates and preserves source fetchedAt on cached responses", async () => {
  const require = createRequire(import.meta.url)
  const entry = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(entry + "\nexport { registerQuotaBridge, quota };", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  let used = 2
  const exported = {}
  vm.runInNewContext(compiled, {
    exports: exported, process, structuredClone, Date,
    require(name) {
      if (name === "./store") return { AccountStore: MemoryStore }
      if (name === "./quota") return { QuotaService: class extends QuotaService { constructor(store) { super(store, async () => Response.json(payload(used))) } } }
      if (name === "./pi-runtime") return { createCodexRuntime: () => ({}) }
      if (name === "./storage") return { paths: { root: "offline" } }
      if (name === "node:fs/promises") return { readFile: async () => "{}" }
      if (name.startsWith("./") || name === "@earendil-works/pi-ai/compat") return {}
      return require(name)
    },
  })
  const listeners = new Map(), events = []
  const pi = { events: {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    emit(name, data) { events.push({ name, data }); listeners.get(name)?.(data) },
  } }
  const stop = exported.registerQuotaBridge(pi)
  await exported.quota.refresh(account(), true)
  const pushed = events.find((e) => e.name === "pi-quota:updated").data
  assert.equal(pushed.payload.metrics["5h"], 2)
  assert.equal(pushed.identityKey, "a")
  pi.events.emit("pi-quota:request", { provider: "codex-account-pool", sessionId: "s", requestId: "r" })
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  const response = events.find((e) => e.name === "pi-quota:response").data
  assert.equal(response.fetchedAt, pushed.fetchedAt)
  used = 100
  await exported.quota.refresh(account(), true)
  assert.equal(events.filter((e) => e.name === "pi-quota:updated").at(-1).data.payload.metrics["5h"], 100)
  assert.doesNotMatch(JSON.stringify(events), /SECRET_|accessToken|refreshToken|workspaceAccountID/)
  stop()
  const count = events.length
  await exported.quota.refresh(account(), true)
  assert.equal(events.length, count, "shutdown removes the quota listener")
})
