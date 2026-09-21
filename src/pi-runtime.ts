/** Public host capabilities, not a bundled copy of Pi's transport internals. */
type Host = Record<string, any>

/** A handoff may trim dialogue, but must retain the active system/tool state. */
export function handoffMessages(messages: any[], checkpoint: any, host: Host): any[] {
  const system = typeof host.getCurrentSystemMessage === "function"
    ? [host.getCurrentSystemMessage(messages)].filter(Boolean)
    : messages.filter((message) => message.role === "system")
  return [...system, checkpoint, ...messages.filter((message) => message.role !== "system").slice(-8)]
}

/**
 * Old Pi uses Context.systemPrompt/tools; newer Pi carries ordered system
 * messages with section/tool deltas. Prefer the host's own normalizer. Only
 * legacy hosts need the transcript folded into their flat context contract.
 */
export function prepareContext(context: any, host: Host): any {
  if (typeof host.normalizeContext === "function") return host.normalizeContext(context)
  if (!context.messages.some((message: any) => message.role === "system")) return context

  const content: string[] = context.systemPrompt ? [context.systemPrompt] : []
  const sections = new Map<string, string>()
  const tools = new Map<string, any>((context.tools ?? []).map((tool: any) => [tool.name, tool]))
  for (const message of context.messages) {
    if (message.role !== "system") continue
    const text = typeof message.content === "string" ? message.content
      : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("")
    if (text) content.push(text)
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name)
      else if (typeof value === "string") sections.set(name, value)
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  return {
    ...context,
    systemPrompt: [...content, ...sections.values()].filter(Boolean).join("\n\n"),
    tools: [...tools.values()],
    messages: context.messages.filter((message: any) => message.role !== "system"),
  }
}

export function createCodexRuntime(host: Host) {
  for (const name of ["openAICodexResponsesApi", "lazyStream", "getModels"]) {
    if (typeof host[name] !== "function") {
      throw new Error(`Codex Pool: o Pi não fornece a capacidade pública ${name}; não é seguro iniciar o provider sem ela.`)
    }
  }
  // A dedicated native API instance avoids recursion through the custom
  // provider registry. Its implementation and context contract come from Pi.
  const api = host.openAICodexResponsesApi()
  if (typeof api?.streamSimple !== "function") throw new Error("Codex Pool: transporte Codex indisponível no Pi")
  return {
    models: () => host.getModels("openai-codex"),
    streamSimple: (model: any, context: any, options: any) => api.streamSimple(model, prepareContext(context, host), options),
    lazyStream: (model: any, setup: () => Promise<any>) => host.lazyStream(model, setup),
    cleanupSession: (sessionId: string) => host.cleanupSessionResources?.(sessionId),
  }
}
