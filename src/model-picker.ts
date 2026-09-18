import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Input, SelectList, fuzzyFilter, matchesKey, truncateToWidth, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui"

export type ModelChoice = { provider: string; id: string; name: string }

type PickerOptions = {
  title: string
  models: ModelChoice[]
  current?: string
  rows: () => number
  theme: SelectListTheme
  accent: (text: string) => string
  matches: (data: string, action: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel") => boolean
  done: (value: string | undefined) => void
}

export class HandoffModelPicker {
  private input = new Input()
  private items: SelectItem[]
  private filtered: SelectItem[]
  private list!: SelectList
  private height = 0
  get focused() { return this.input.focused }
  set focused(value: boolean) { this.input.focused = value }

  constructor(private options: PickerOptions) {
    this.items = [...options.models].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)).map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: `${model.id} [${model.provider}]`,
      description: model.name,
    }))
    this.filtered = this.items
    this.rebuild(options.current)
  }

  private rebuild(selected?: string) {
    this.height = Math.max(1, Math.min(10, this.options.rows() - 10))
    this.list = new SelectList(this.filtered, this.height, this.options.theme)
    this.list.setSelectedIndex(Math.max(0, this.filtered.findIndex((item) => item.value === selected)))
    this.list.onSelect = (item) => this.options.done(item.value)
    this.list.onCancel = () => this.options.done(undefined)
  }

  render(width: number) {
    if (this.height !== Math.max(1, Math.min(10, this.options.rows() - 10))) this.rebuild(this.list.getSelectedItem()?.value)
    const border = this.options.accent("─".repeat(Math.max(0, width)))
    return [border, this.options.accent(this.options.title), ...this.input.render(width), "",
      ...this.list.render(width), "↑↓ navegar · PgUp/PgDn página · Enter escolher · Esc voltar", border,
    ].map((line) => truncateToWidth(line, width))
  }

  handleInput(data: string) {
    const kb = this.options.matches
    const index = this.filtered.findIndex((item) => item.value === this.list.getSelectedItem()?.value)
    if (kb(data, "tui.select.cancel")) return this.options.done(undefined)
    if (kb(data, "tui.select.confirm")) {
      const selected = this.list.getSelectedItem()
      if (selected) this.options.done(selected.value)
      return
    }
    if (kb(data, "tui.select.up") || kb(data, "tui.select.down")) {
      const delta = kb(data, "tui.select.up") ? -1 : 1
      if (this.filtered.length) this.list.setSelectedIndex((index + delta + this.filtered.length) % this.filtered.length)
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.list.setSelectedIndex(Math.max(0, Math.min(this.filtered.length - 1, index + (matchesKey(data, "pageUp") ? -this.height : this.height))))
    } else {
      this.input.handleInput(data)
      this.filtered = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.value} ${item.description}`)
      this.rebuild()
    }
  }

  invalidate() { this.input.invalidate(); this.list.invalidate() }
}

export async function pickHandoffModel(ctx: ExtensionContext, title: string, models: ModelChoice[], current?: string) {
  if (ctx.mode !== "tui") {
    return ctx.ui.select(title, models.map((model) => `${model.provider}/${model.id}`))
  }
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const picker = new HandoffModelPicker({
      title, models, current, rows: () => tui.terminal.rows,
      accent: (text) => theme.fg("accent", text),
      matches: (data, action) => keybindings.matches(data, action), done,
      theme: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    })
    return {
      get focused() { return picker.focused },
      set focused(value: boolean) { picker.focused = value },
      render: (width) => picker.render(width),
      invalidate: () => picker.invalidate(),
      handleInput: (data) => { picker.handleInput(data); tui.requestRender() },
    }
  })
}
