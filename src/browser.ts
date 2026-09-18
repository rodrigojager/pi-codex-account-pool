import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

export async function openBrowser(url: string, platform = process.platform, run = exec): Promise<void> {
  if (platform === "win32") {
    // Never pass OAuth URLs through cmd/start: & splits the query into commands.
    // Keep the URL as data, not PowerShell source, preserving all query parameters.
    await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Start-Process -FilePath $env:PI_CODEX_LOGIN_URL -ErrorAction Stop",
    ], {
      env: { ...process.env, PI_CODEX_LOGIN_URL: url },
      windowsHide: true,
      timeout: 15_000,
    })
    return
  }
  await run(platform === "darwin" ? "open" : "xdg-open", [url], { timeout: 15_000 })
}
