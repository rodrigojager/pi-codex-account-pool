import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile, readdir } from "node:fs/promises"

async function sourceFiles(directory) {
  const entries = await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && /\.(?:ts|md)$/u.test(entry.name)).map((entry) => new URL(`../${directory}/${entry.name}`, import.meta.url))
}

test("fontes e documentação permanecem em UTF-8 sem mojibake", async () => {
  const files = [new URL("../README.md", import.meta.url), ...await sourceFiles("src")]
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (const file of files) {
    const text = decoder.decode(await readFile(file))
    assert.doesNotMatch(text, /(?:Ã.|Â.|�)/u, file.pathname)
  }
})
