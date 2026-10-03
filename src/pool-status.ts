import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

export const POOL_PROVIDER_ID = "codex-account-pool"

/** An account can stay bound to the session while another provider is selected. */
export function setPoolStatus(ctx: ExtensionContext | undefined, label?: string) {
  if (!ctx?.hasUI) return
  ctx.ui.setStatus(POOL_PROVIDER_ID,
    ctx.model?.provider === POOL_PROVIDER_ID && label ? `Codex Pool: ${label}` : undefined)
}

export function registerPoolStatus(
  pi: ExtensionAPI,
  accountLabelFor: (ctx: ExtensionContext) => Promise<string | undefined>,
) {
  pi.on("model_select", async (_event, ctx) => {
    if (ctx.model?.provider !== POOL_PROVIDER_ID) {
      setPoolStatus(ctx)
      return
    }
    const label = await accountLabelFor(ctx)
    // Recheck the live model after storage resolves: the user may have switched away.
    setPoolStatus(ctx, label)
  })
}
