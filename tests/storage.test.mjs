import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import ts from "typescript"

const source = await readFile(new URL("../src/storage.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { FileLock } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

test("login locks recover exited owners but preserve live and remote owners", async () => {
  const previous = process.env.PI_CODEX_ACCOUNT_POOL_DATA_DIR
  const root = await mkdtemp(join(tmpdir(), "pi-pool-lock-test-"))
  process.env.PI_CODEX_ACCOUNT_POOL_DATA_DIR = root
  try {
    await mkdir(join(root, "locks"))
    const path = join(root, "locks", "oauth-login.lock")
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    await once(child, "exit")
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" })
    await writeFile(path, JSON.stringify({ owner: "exited", hostname: hostname(), pid: child.pid }))
    const recovered = await FileLock.acquire("oauth-login", 100, 600_000)
    assert.equal(JSON.parse(await readFile(path, "utf8")).owner, recovered.owner)
    await assert.rejects(FileLock.acquire("oauth-login", 50, 600_000), /Timed out acquiring lock/)
    await recovered.release()
    await assert.rejects(readFile(path), { code: "ENOENT" })
    await writeFile(path, JSON.stringify({ owner: "remote", hostname: "another-host", pid: child.pid }))
    await assert.rejects(FileLock.acquire("oauth-login", 50, 600_000), /Timed out acquiring lock/)
    assert.equal(JSON.parse(await readFile(path, "utf8")).owner, "remote")
  } finally {
    if (previous === undefined) delete process.env.PI_CODEX_ACCOUNT_POOL_DATA_DIR
    else process.env.PI_CODEX_ACCOUNT_POOL_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
