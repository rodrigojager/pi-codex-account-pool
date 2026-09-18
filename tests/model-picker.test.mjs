import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { visibleWidth } from "@earendil-works/pi-tui"
import ts from "typescript"

const source = await readFile(new URL("../src/model-picker.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const code = outputText.replaceAll('"@earendil-works/pi-tui"', JSON.stringify(import.meta.resolve("@earendil-works/pi-tui")))
const { HandoffModelPicker, pickHandoffModel } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)
const models = Array.from({ length: 300 }, (_, i) => ({ provider: "provider", id: `model-${String(i).padStart(3, "0")}`, name: `Friendly ${i}` }))
const identity = (s) => s
function setup() {
  let rows = 24
  let result = "pending"
  const picker = new HandoffModelPicker({
    title: "Handoff · digite para filtrar", models, rows: () => rows,
    theme: Object.fromEntries(["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"].map((k) => [k, identity])),
    accent: identity,
    matches: (data, action) => data === action,
    done: (value) => { result = value },
  })
  return { picker, result: () => result, resize: (n) => { rows = n } }
}

test("handoff selector replaces the editor instead of overlaying chat", async () => {
  let opened = false
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory, options) => {
        opened = true
        assert.notEqual(options?.overlay, true)
        let selected
        const component = factory(
          { terminal: { rows: 24 }, requestRender() {} },
          { fg: (_color, text) => text },
          { matches: (data, action) => data === action },
          (value) => { selected = value },
        )
        component.focused = true
        assert.equal(component.focused, true)
        assert.ok(component.render(80).length <= 22)
        component.handleInput("tui.select.confirm")
        return selected
      },
    },
  }
  assert.equal(await pickHandoffModel(ctx, "Handoff", models), "provider/model-000")
  assert.equal(opened, true)
})

test("300 models scroll down and back up without leaving the viewport", () => {
  const { picker, result } = setup()
  for (let i = 0; i < 250; i++) picker.handleInput("tui.select.down")
  assert.ok(picker.render(80).length <= 22)
  assert.match(picker.render(80).join("\n"), /model-250/)
  for (let i = 0; i < 250; i++) picker.handleInput("tui.select.up")
  picker.handleInput("tui.select.confirm")
  assert.equal(result(), "provider/model-000")
})

test("live search matches provider, model ID and friendly name", () => {
  for (const query of ["model-237", "provider model-237", "Friendly 237"]) {
    const { picker, result } = setup()
    for (const char of query) picker.handleInput(char)
    picker.handleInput("tui.select.confirm")
    assert.equal(result(), "provider/model-237", query)
  }
})

test("empty search results cannot select, Escape cancels", () => {
  const { picker, result } = setup()
  picker.handleInput("zzzzzzzzzzzz")
  picker.handleInput("tui.select.confirm")
  assert.equal(result(), "pending")
  picker.handleInput("tui.select.cancel")
  assert.equal(result(), undefined)
})

test("provider stays visible when a long model label is truncated", () => {
  const long = [{ provider: "codex-account-pool", id: "a-model-id-that-is-deliberately-much-longer-than-the-picker-row", name: "Long model" }]
  const picker = new HandoffModelPicker({
    title: "Handoff", models: long, rows: () => 24,
    theme: Object.fromEntries(["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"].map((k) => [k, identity])),
    accent: identity, matches: () => false, done: () => {},
  })
  const rendered = picker.render(35).join("\n")
  assert.match(rendered, /codex-account-pool/)
  assert.ok(picker.render(35).every((line) => visibleWidth(line) <= 35))
})

test("resize keeps selection visible and lines within terminal bounds", () => {
  const { picker, result, resize } = setup()
  for (let i = 0; i < 150; i++) picker.handleInput("tui.select.down")
  resize(12)
  const lines = picker.render(35)
  assert.ok(lines.length <= 10)
  assert.ok(lines.every((line) => visibleWidth(line) <= 35))
  assert.match(lines.join("\n"), /model-150/)
  picker.handleInput("tui.select.confirm")
  assert.equal(result(), "provider/model-150")
})

test("PageDown and PageUp return to the same selection", () => {
  const { picker, result } = setup()
  picker.handleInput("\x1b[6~")
  assert.match(picker.render(80).join("\n"), /model-010/)
  picker.handleInput("\x1b[5~")
  picker.handleInput("tui.select.confirm")
  assert.equal(result(), "provider/model-000")
})
