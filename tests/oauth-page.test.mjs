import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import ts from "typescript"

const source = await readFile(new URL("../src/oauth-page.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { oauthSuccessPage, oauthPageHeaders } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

test("success page uses Pi branding and embedded official logo", () => {
  const html = oauthSuccessPage()
  assert.match(html, /<!doctype html>/i)
  assert.match(html, /lang="pt-BR"/)
  assert.match(html, /Logo do Pi/)
  assert.match(html, /M165\.29 165\.29H517\.36V400H400V282\.65H165\.29Z/)
  assert.doesNotMatch(html, /opencode/i)
  assert.match(html, /Volte ao Pi para finalizar/)
})

test("page is self-contained, responsive and respects reduced motion", () => {
  const html = oauthSuccessPage()
  assert.doesNotMatch(html, /<script|<link|<iframe|\ssrc=|@import|url\(/i)
  assert.match(html, /name="viewport"/)
  assert.match(html, /prefers-reduced-motion: reduce/)
  assert.match(html, /aria-labelledby="title"/)
  assert.match(html, /color-scheme: dark/)
})

test("callback page cannot leak OAuth URL through caching or external resources", () => {
  assert.equal(oauthPageHeaders["Cache-Control"], "no-store")
  assert.equal(oauthPageHeaders["Referrer-Policy"], "no-referrer")
  assert.match(oauthPageHeaders["Content-Security-Policy"], /default-src 'none'/)
  assert.match(oauthPageHeaders["Content-Security-Policy"], /frame-ancestors 'none'/)
})
