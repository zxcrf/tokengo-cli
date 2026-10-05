import path from "path"
import { Option, Schema } from "effect"
import { createSignal, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { Global } from "@opencode-ai/core/global"
import { Auth } from "@/auth"
import { ID } from "@/provider/tokengo/models"
import { TOKENGO_BASE_URL, TOKENGO_SUBSCRIBE_URL, make, quotaToUSD, type Fetch } from "@/provider/tokengo/client"

const REFRESH_MS = 60_000
// At or below this balance the sidebar switches to a warning and shows the wallet link.
const LOW_BALANCE_USD = 1

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const decodeAuth = Schema.decodeUnknownOption(Auth.Info)

// Returns undefined when the user is not logged in to TokenGo.
export async function readBalance(input: { file?: string; fetch?: Fetch } = {}) {
  const raw = await Bun.file(input.file ?? path.join(Global.Path.data, "auth.json"))
    .json()
    .catch(() => undefined)
  // Decode only our entry so a malformed entry for another provider cannot hide the balance.
  const info = Option.getOrUndefined(decodeAuth(raw?.[ID]))
  const meta = info?.type === "api" ? info.metadata : undefined
  if (!meta?.pat) return
  const user = await make({ baseURL: meta.baseURL || TOKENGO_BASE_URL, pat: meta.pat, fetch: input.fetch }).self()
  return quotaToUSD(user.quota ?? 0)
}

function View(props: { api: TuiPluginApi; usd: number }) {
  const theme = () => props.api.theme.current
  const low = () => props.usd <= LOW_BALANCE_USD
  return (
    <box>
      <text fg={low() ? theme().warning : theme().textMuted}>{money.format(props.usd)} balance</text>
      <Show when={low()}>
        <text fg={theme().warning}>Top up: {TOKENGO_SUBSCRIBE_URL}</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const [usd, setUsd] = createSignal<number>()
  // A failed refresh keeps the last known balance instead of blanking the sidebar.
  const refresh = () => readBalance().then((value) => setUsd(value), () => {})
  void refresh()
  const timer = setInterval(refresh, REFRESH_MS)
  api.lifecycle.onDispose(() => clearInterval(timer))

  api.slots.register({
    order: 110,
    slots: {
      sidebar_content() {
        return (
          // A zero balance must still render, so test for undefined rather than truthiness.
          <Show when={usd() !== undefined}>
            <View api={api} usd={usd() ?? 0} />
          </Show>
        )
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id: "internal:tokengo-balance",
  tui,
}

export default plugin
