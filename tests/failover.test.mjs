import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import ts from "typescript"

const source = await readFile(new URL("../src/failover.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { cooldownUntil, failureMessage, failureStatus, shouldRotateAccount } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

test("rotates on HTTP auth, quota and server failures", () => {
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    assert.equal(shouldRotateAccount(status, ""), true, String(status))
  }
  for (const status of [400, 404, 422]) {
    assert.equal(shouldRotateAccount(status, "invalid request"), false, String(status))
  }
})

test("recognizes quota and auth errors emitted only by WebSocket", () => {
  assert.equal(failureStatus(undefined, "You have hit your ChatGPT usage limit"), 429)
  assert.equal(failureStatus(undefined, "usage_limit_reached"), 429)
  assert.equal(failureStatus(undefined, "rate limit exceeded"), 429)
  assert.equal(failureStatus(undefined, "token expired"), 401)
  assert.equal(shouldRotateAccount(undefined, "service unavailable"), true)
})

test("HTTP status has priority over message inference", () => {
  assert.equal(failureStatus({ status: 403, headers: {} }, "rate limit exceeded"), 403)
})

test("429 honors numeric and date Retry-After values", () => {
  const now = Date.parse("2026-09-18T12:00:00Z")
  assert.equal(cooldownUntil(429, { status: 429, headers: { "retry-after": "12" } }, now), now + 12_000)
  assert.equal(cooldownUntil(429, { status: 429, headers: { "Retry-After": "Fri, 18 Sep 2026 12:02:00 GMT" } }, now), now + 120_000)
  assert.equal(cooldownUntil(429, undefined, now), now + 60_000)
})

test("extracts provider error messages without losing Unicode", () => {
  assert.equal(failureMessage({ errorMessage: "Limite de uso atingido" }), "Limite de uso atingido")
  assert.equal(failureMessage(new Error("Autenticação inválida")), "Autenticação inválida")
})
