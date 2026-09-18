import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import ts from "typescript"

const source = await readFile(new URL("../src/browser.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { openBrowser } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
const url = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=test&code_challenge_method=S256&state=test&special=%26%22%25%27&literal='$()"

test("Windows passes the complete OAuth URL as data, without cmd parsing", async () => {
  await openBrowser(url, "win32", async (command, args, options) => {
    assert.equal(command, "powershell.exe")
    assert.equal(options.env.PI_CODEX_LOGIN_URL, url)
    assert.equal(options.windowsHide, true)
    assert.equal(args.at(-1), "Start-Process -FilePath $env:PI_CODEX_LOGIN_URL -ErrorAction Stop")
    assert.ok(!args.some((arg) => arg.includes(url)))
  })
})

test("Windows PowerShell receives every character intact (without opening a browser)", {
  skip: process.platform !== "win32",
}, async () => {
  await openBrowser(url, "win32", async (command, args, options) => {
    const safeArgs = [...args]
    safeArgs[safeArgs.length - 1] = "function Start-Process { param($FilePath, $ErrorAction) [Console]::Write($FilePath) }; " + args.at(-1)
    const { stdout } = await promisify(execFile)(command, safeArgs, options)
    assert.equal(stdout, url)
  })
})

for (const [platform, expected] of [["darwin", "open"], ["linux", "xdg-open"]]) {
  test(`${platform} passes the URL as one argument`, async () => {
    await openBrowser(url, platform, async (command, args) => {
      assert.equal(command, expected)
      assert.deepEqual(args, [url])
    })
  })
}

test("launcher failures propagate so the UI can offer manual login", async () => {
  await assert.rejects(openBrowser(url, "win32", async () => {
    throw new Error("launcher failed")
  }), /launcher failed/)
})
