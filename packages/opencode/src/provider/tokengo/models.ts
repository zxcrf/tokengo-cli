import path from "path"
import { randomUUID } from "crypto"
import { mkdir, rename, rm } from "fs/promises"
import { Schema } from "effect"
import type { Provider } from "@/provider/provider"
import { Global } from "@opencode-ai/core/global"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { TOKENGO_MODEL_PRIORITY, make, type Fetch, type Pricing } from "./client"

export const ID = "token-go"
export const NAME = "TokenGo"

// Same freshness window as upstream models.dev; the provider refresh loop renews it while running.
const DEFAULT_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000
const ANTHROPIC_NPM = "@ai-sdk/anthropic"
const OPENAI_NPM = "@ai-sdk/openai"
const COMPAT_NPM = "@ai-sdk/openai-compatible"
const FALLBACK_CONTEXT = 128_000
// Catalog vendors searched first so a model's own vendor metadata wins over resellers.
const CANONICAL_VENDORS = ["anthropic", "openai", "google", "deepseek", "zai", "moonshotai", "xai"]
const REASONING = /o[1-9]|gpt-5|reason|think|r1|claude-(opus|sonnet)-4|gemini-2\.5|gemini-3/

export interface Cache {
  fetchedAt: number
  baseURL: string
  group: string
  userId?: string
  models: Record<string, Provider.Model>
}

const CacheFile = Schema.Struct({
  fetchedAt: Schema.Number,
  baseURL: Schema.String,
  group: Schema.String,
  userId: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Schema.Any),
})

export function info(): Provider.Info {
  return {
    id: ProviderV2.ID.make(ID),
    name: NAME,
    source: "custom",
    // PAT-only: an env key would collide with models.dev's unrelated `tokengo` provider and the env alias.
    env: [],
    options: {},
    models: {},
  }
}

export function build(input: {
  names: string[]
  pricing: Pricing[]
  catalog: Record<string, Provider.Info>
  baseURL: string
  // Price multiplier of the selected group (`group_ratio[group]` from /api/pricing).
  groupRatio?: number
}): Record<string, Provider.Model> {
  const rows = new Map(input.pricing.map((p) => [p.model_name, p]))
  const index = catalogIndex(input.catalog)
  return Object.fromEntries(
    input.names.flatMap((name) => {
      const row = rows.get(name)
      const npm = selectNpm(name, row?.supported_endpoint_types ?? ["openai"])
      if (!npm) return []
      const hit = index.exact.get(name) ?? index.normalized.get(normalize(name))
      const meta: Meta = hit
        ? structuredClone({
            name: hit.name.replace(/\s*\(latest\)\s*$/i, ""),
            family: hit.family,
            capabilities: hit.capabilities,
            limit: hit.limit,
            release_date: hit.release_date,
          })
        : fallback(name)
      const model: Provider.Model = {
        id: ModelV2.ID.make(name),
        providerID: ProviderV2.ID.make(ID),
        api: { id: name, url: `${input.baseURL}/v1`, npm },
        name: meta.name,
        family: meta.family,
        capabilities: meta.capabilities,
        cost: cost(row, input.groupRatio ?? 1),
        limit: meta.limit,
        // Availability comes from /api/user/models, not the catalog's lifecycle status.
        status: "active",
        options: {},
        headers: {},
        release_date: meta.release_date,
        // Claude (@ai-sdk/anthropic) keeps `variants` unset so Provider applies adaptive-thinking logic upstream.
      }
      const variants = variantsFor(name, npm)
      if (variants) model.variants = variants
      return [[name, model] as const]
    }),
  )
}

const encryptedReasoning = ["reasoning.encrypted_content"] as const

function effortsFor(id: string): string[] | undefined {
  const bare = (id.split("/").pop() ?? id).toLowerCase()
  if (bare.includes("deepseek")) return ["low", "high", "max"]
  if (bare.startsWith("gpt-5.5")) return ["low", "medium", "high", "xhigh", "max"]
  if (bare.startsWith("gpt-5.6")) return ["minimal", "low", "medium", "high", "xhigh", "max"]
  if (bare.startsWith("gpt-6")) return ["low", "medium", "high", "xhigh", "max"]
  if (/^(gpt-|o[1-9])/.test(bare) || bare.includes("codex")) return ["low", "medium", "high"]
  if (bare.startsWith("gemini-3.6-flash")) return ["minimal", "low", "medium", "high"]
  if (bare.startsWith("gemini-")) return ["low", "medium", "high"]
  const grok = /^grok-(\d+)(?:\.(\d+))?/.exec(bare)
  if (grok) {
    const [major, minor] = [Number(grok[1]), Number(grok[2] ?? 0)]
    return major > 4 || (major === 4 && minor >= 6) ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high"]
  }
  return undefined
}

// Explicit per-family reasoning variants (vendor docs plus live probes through the relay).
// Undefined means "let upstream ProviderTransform compute them".
export function variantsFor(id: string, npm: string): Record<string, Record<string, unknown>> | undefined {
  if (npm !== "@ai-sdk/openai-compatible" && npm !== "@ai-sdk/openai") return undefined
  const efforts = effortsFor(id)
  if (!efforts) return undefined
  return Object.fromEntries(
    efforts.map((effort) => [
      effort,
      npm === "@ai-sdk/openai"
        ? { reasoningEffort: effort, reasoningSummary: "auto", include: encryptedReasoning }
        : { reasoningEffort: effort },
    ]),
  )
}

export function cachePath() {
  return path.join(Global.Path.cache, "tokengo-models.json")
}

export async function readCache(): Promise<Cache | undefined> {
  const json: unknown = await Bun.file(cachePath())
    .json()
    .catch(() => undefined)
  const parsed = Schema.decodeUnknownOption(CacheFile)(json)
  if (parsed._tag === "None") return undefined
  return { ...parsed.value, models: parsed.value.models as Record<string, Provider.Model> }
}

export async function writeCache(c: Cache) {
  const file = cachePath()
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(tmp, JSON.stringify(c))
  await rename(tmp, file).catch(async (error) => {
    await rm(tmp, { force: true })
    throw error
  })
}

export async function clearCache() {
  await rm(cachePath(), { force: true })
}

type DiscoverInput = {
  baseURL: string
  pat: string
  group: string
  userId?: string
  catalog: Record<string, Provider.Info>
  fetch?: Fetch
  ttlMs?: number
  force?: boolean
}

// Startup path: any cached list for this account is served immediately, stale or not, so the
// TUI opens without waiting on the relay. `refresh` (run by the provider loop) renews it.
export async function discover(input: DiscoverInput): Promise<Record<string, Provider.Model>> {
  const usable = await readUsable(input)
  if (usable && !input.force) return usable.models
  return fetchAndCache(input).catch(() => usable?.models ?? {})
}

// Returns the freshly fetched models, or undefined when the cache is still within the TTL.
// Fetch failures reject so the caller keeps its current list.
export async function refresh(input: DiscoverInput): Promise<Record<string, Provider.Model> | undefined> {
  const usable = await readUsable(input)
  if (!input.force && usable && Date.now() - usable.fetchedAt < (input.ttlMs ?? DEFAULT_TTL_MS)) return
  return fetchAndCache(input)
}

async function readUsable(input: DiscoverInput) {
  const cached = await readCache()
  return cached &&
    cached.baseURL === input.baseURL &&
    cached.group === input.group &&
    (cached.userId ?? "") === (input.userId ?? "")
    ? cached
    : undefined
}

async function fetchAndCache(input: DiscoverInput) {
  const client = make({ baseURL: input.baseURL, pat: input.pat, fetch: input.fetch, timeoutMs: FETCH_TIMEOUT_MS })
  const [names, pricing] = await Promise.allSettled([client.userModels(input.group), client.pricingEnvelope()])
  if (names.status === "rejected") throw names.reason
  // Pricing is optional: some deployments hide it (403 / disabled nav module).
  const envelope = pricing.status === "fulfilled" ? pricing.value : { data: [], group_ratio: {} }
  const models = build({
    names: names.value,
    pricing: envelope.data,
    catalog: input.catalog,
    baseURL: input.baseURL,
    groupRatio: envelope.group_ratio[input.group] ?? 1,
  })
  // A read-only or full cache dir must not hide freshly discovered models; there is no
  // logger outside Effect fibers here, so the failure is dropped and the next refresh refetches.
  await writeCache({
    fetchedAt: Date.now(),
    baseURL: input.baseURL,
    group: input.group,
    userId: input.userId,
    models,
  }).catch(() => undefined)
  return models
}

export function defaultModelID(models: Record<string, Provider.Model>): string | undefined {
  const ids = Object.keys(models).sort()
  return TOKENGO_MODEL_PRIORITY.map((p) => ids.find((id) => id.includes(p))).find((id) => id !== undefined) ?? ids[0]
}

type Meta = Pick<Provider.Model, "name" | "family" | "capabilities" | "limit" | "release_date">

function selectNpm(name: string, types: readonly string[]): string | undefined {
  // Endpoint types are a union across channels (GPT rows often list "anthropic" too), so the
  // model family picks the SDK and the endpoint types only confirm it is reachable.
  const id = name.toLowerCase().replace(/^.*\//, "")
  const compat = types.includes("openai") ? COMPAT_NPM : undefined
  if (/^claude/.test(id)) return types.includes("anthropic") ? ANTHROPIC_NPM : compat
  if (/^(gpt|o[1-9]|codex|chatgpt)/.test(id)) return types.includes("openai-response") ? OPENAI_NPM : compat
  return compat
}

function cost(row: Pricing | undefined, groupRatio: number): Provider.Model["cost"] {
  // quota_type 1 is per-request pricing, which has no per-token equivalent.
  if (!row || row.quota_type !== 0) return { input: 0, output: 0, cache: { read: 0, write: 0 } }
  if (row.billing_mode === "tiered_expr" && row.billing_expr) {
    const tiered = exprCost(row.billing_expr, groupRatio)
    if (tiered) return tiered
  }
  const input = (row.model_ratio ?? 0) * 2 * groupRatio
  return {
    input,
    output: input * (row.completion_ratio ?? 1),
    cache: {
      read: input * (row.cache_ratio ?? 1),
      write: input * (row.create_cache_ratio ?? 1.25),
    },
  }
}

// Reads NewAPI billing expressions such as
//   len <= 272000 ? tier("standard", p * 10 + c * 50 + cr * 1 + cc * 12.5) : tier("long_context", p * 20 + ...)
// Coefficients are USD per 1M tokens: p input, c output, cr cache read, cc cache write (5m).
// Time-of-day multipliers (peak-hour surcharges) have no equivalent in the cost model and are ignored.
function exprCost(expr: string, groupRatio: number): Provider.Model["cost"] | undefined {
  const tiers = [...expr.matchAll(/tier\(\s*"[^"]*"\s*,([^)]*)\)/g)].map((match) => {
    const coef = Object.fromEntries(
      [...match[1].matchAll(/\b(p|c|cr|cc)\s*\*\s*([\d.]+)/g)].map((term) => [term[1], Number(term[2]) * groupRatio]),
    )
    return { input: coef.p ?? 0, output: coef.c ?? 0, cache: { read: coef.cr ?? 0, write: coef.cc ?? 0 } }
  })
  if (!tiers[0]) return
  // `len < N ? base : long` switches once the prompt exceeds N - 1 tokens, `len <= N` once it exceeds N.
  const threshold = expr.match(/\blen\s*(<=|<)\s*(\d+)/)
  if (!threshold || !tiers[1]) return tiers[0]
  const size = Number(threshold[2]) - (threshold[1] === "<" ? 1 : 0)
  return { ...tiers[0], tiers: [{ ...tiers[1], tier: { type: "context" as const, size } }] }
}

function fallback(name: string): Meta {
  const none = { text: false, image: false, audio: false, video: false, pdf: false }
  return {
    name,
    family: "",
    capabilities: {
      toolcall: true,
      temperature: true,
      attachment: false,
      reasoning: REASONING.test(name.toLowerCase()),
      interleaved: false,
      input: { ...none, text: true },
      output: { ...none, text: true },
    },
    limit: { context: FALLBACK_CONTEXT, output: 32000 },
    release_date: "",
  }
}

function normalize(name: string) {
  return name
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/(-\d{8}|-latest|-preview)+$/, "")
    .replace(/[^a-z0-9]+/g, "")
}

function catalogIndex(catalog: Record<string, Provider.Info>) {
  const exact = new Map<string, Provider.Model>()
  const normalized = new Map<string, Provider.Model>()
  const ids = [
    ...CANONICAL_VENDORS.filter((id) => id in catalog),
    ...Object.keys(catalog).filter((id) => !CANONICAL_VENDORS.includes(id)),
  ]
  for (const id of ids)
    for (const [key, model] of Object.entries(catalog[id].models)) {
      if (model.status === "deprecated" || model.status === "alpha") continue
      if (!exact.has(model.id)) exact.set(model.id, model)
      if (!exact.has(key)) exact.set(key, model)
      const n = normalize(model.id)
      if (!normalized.has(n)) normalized.set(n, model)
    }
  return { exact, normalized }
}

export * as Tokengo from "./models"
