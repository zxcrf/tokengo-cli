import { Flag } from "@opencode-ai/core/flag/flag"

export const DEFAULT_PROVIDER_IDS = ["token-go"] as const

type Cfg = {
  provider?: Record<string, unknown>
  enabled_providers?: readonly string[]
  disabled_providers?: readonly string[]
}

// models.dev ids that collide with unrelated companies and must never be offered.
export const DENIED_PROVIDER_IDS = ["tokengo"] as const

// Providers that may activate. When enabled_providers is set it is the exact list; otherwise defaults + config-declared.
// disabled_providers and the denylist always win.
export function ids(cfg: Cfg): Set<string> {
  const result = new Set<string>(cfg.enabled_providers ?? [...DEFAULT_PROVIDER_IDS, ...Object.keys(cfg.provider ?? {})])
  for (const id of [...(cfg.disabled_providers ?? []), ...DENIED_PROVIDER_IDS]) result.delete(id)
  return result
}

export function allowed(cfg: Cfg): (id: string) => boolean {
  if (Flag.OPENCODE_ALL_PROVIDERS) {
    // Upstream semantics: enabled_providers restricts, disabled_providers excludes.
    const disabled = new Set<string>([...(cfg.disabled_providers ?? []), ...DENIED_PROVIDER_IDS])
    const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : undefined
    return (id) => (!enabled || enabled.has(id)) && !disabled.has(id)
  }
  const set = ids(cfg)
  return (id) => set.has(id)
}

export * as ProviderGate from "./gate"
