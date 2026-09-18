import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import ts from "typescript"

const source = await readFile(new URL("../src/account-menu.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { accountMenuRows } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
const accounts = [
  { id: "a", label: "Conta", enabled: true },
  { id: "b", label: "Conta", enabled: true },
  { id: "c", label: "Outra", enabled: false },
]

test("priority order is independent of insertion order and active account", () => {
  const rows = accountMenuRows(accounts, ["b", "c", "a"], "a")
  assert.deepEqual(rows.map((row) => row.account.id), ["b", "c", "a"])
  assert.deepEqual(rows.map((row) => row.label), ["○ 1. Conta", "○ 2. Outra (desativada)", "● 3. Conta"])
})

test("switching accounts moves only the filled circle, not the priority", () => {
  const rows = accountMenuRows(accounts, ["b", "a", "c"], "b")
  assert.equal(rows[0].label, "● 1. Conta")
  assert.equal(rows[1].label, "○ 2. Conta")
  assert.equal(rows.filter((row) => row.label.startsWith("●")).length, 1)
})

test("duplicate account names still have unambiguous selections", () => {
  const rows = accountMenuRows(accounts, ["b", "a", "c"])
  assert.equal(new Set(rows.map((row) => row.label)).size, 3)
  for (const row of rows) assert.equal(rows.find((candidate) => candidate.label === row.label).account.id, row.account.id)
})

test("disabled or missing active accounts never show a filled circle", () => {
  for (const activeId of [undefined, "missing", "c"]) {
    assert.ok(accountMenuRows(accounts, ["a", "b", "c"], activeId).every((row) => row.label.startsWith("○")))
  }
})

test("stale order entries are ignored and unlisted accounts appear once", () => {
  assert.deepEqual(accountMenuRows(accounts, ["missing", "b", "b"]).map((row) => row.account.id), ["b", "a", "c"])
})
