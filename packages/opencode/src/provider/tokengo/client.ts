import { Schema } from "effect"

export const TOKENGO_BASE_URL = "https://api.token-go.click"
export const TOKENGO_CLI_GROUP = "tokengo"
export const TOKENGO_SUBSCRIBE_URL = "https://token-go.click/wallet"
export const TOKENGO_TOKEN_NAME = "tokengo-cli"
// Substring match, in order, when choosing the default model.
export const TOKENGO_MODEL_PRIORITY = [
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "gpt-5-codex",
  "gpt-5",
  "claude-sonnet-4",
  "gemini-2.5-pro",
]

// NewAPI quota unit: 500000 = 1 USD.
const QUOTA_PER_USD = 500000

const MAX_TOKEN_PAGES = 50

export type Fetch = typeof globalThis.fetch

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
})

const User = Schema.Struct({
  id: Schema.Number,
  username: Schema.String,
  display_name: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  quota: Schema.optional(Schema.Number),
  used_quota: Schema.optional(Schema.Number),
})
export type User = typeof User.Type

const Group = Schema.Struct({
  // The `auto` group reports a localized string instead of a number.
  ratio: Schema.Union([Schema.Number, Schema.String]),
  desc: Schema.optional(Schema.String),
})
export type Group = typeof Group.Type

const Pricing = Schema.Struct({
  model_name: Schema.String,
  quota_type: Schema.Number,
  model_ratio: Schema.optional(Schema.Number),
  model_price: Schema.optional(Schema.Number),
  completion_ratio: Schema.optional(Schema.Number),
  cache_ratio: Schema.optional(Schema.Number),
  create_cache_ratio: Schema.optional(Schema.Number),
  // "tiered_expr" rows are billed by `billing_expr`; their ratio fields are stale leftovers.
  billing_mode: Schema.optional(Schema.String),
  billing_expr: Schema.optional(Schema.String),
  enable_groups: Schema.optional(Schema.Array(Schema.String)),
  supported_endpoint_types: Schema.optional(Schema.Array(Schema.String)),
  owner_by: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.String),
})
export type Pricing = typeof Pricing.Type

// `/api/pricing` carries the per-group price multipliers next to `data`.
export interface PricingEnvelope {
  data: Pricing[]
  group_ratio: Record<string, number>
}

const Token = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  key: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  status: Schema.Number,
  unlimited_quota: Schema.optional(Schema.Boolean),
  remain_quota: Schema.optional(Schema.Number),
  expired_time: Schema.optional(Schema.Number),
})
export type Token = typeof Token.Type

const TokenPage = Schema.Struct({
  page: Schema.optional(Schema.Number),
  page_size: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
  items: Schema.Array(Token),
})

export interface CreateToken {
  name: string
  group: string
  unlimited_quota: boolean
  remain_quota: number
  expired_time: number
  model_limits_enabled: boolean
  model_limits: string
  allow_ips: string
}

export interface Client {
  self(): Promise<User>
  groups(): Promise<Record<string, Group>>
  userModels(group: string): Promise<string[]>
  pricing(): Promise<Pricing[]>
  pricingEnvelope(): Promise<PricingEnvelope>
  tokens(): Promise<Token[]>
  createToken(body: CreateToken): Promise<void>
  tokenKey(id: number): Promise<string>
}

const PAGE_SIZE = 100
const TOKEN_ENABLED = 1

export function make(input: { baseURL?: string; pat: string; fetch?: Fetch; timeoutMs?: number }): Client {
  const base = (input.baseURL ?? TOKENGO_BASE_URL).replace(/\/+$/, "")
  const run = input.fetch ?? globalThis.fetch

  // Never include the PAT in thrown messages. Returns the raw JSON body after the envelope check.
  async function send(method: string, path: string, body?: unknown): Promise<{ data: unknown; raw: unknown }> {
    const res = await run(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${input.pat}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    })
    const json: unknown = await res.json().catch(() => undefined)
    const parsed = Schema.decodeUnknownOption(Envelope)(json)
    if (parsed._tag === "None") throw new Error(`TokenGo ${path}: unexpected response (HTTP ${res.status})`)
    if (!res.ok || !parsed.value.success)
      throw new Error(parsed.value.message || `TokenGo ${path}: request failed (HTTP ${res.status})`)
    return { data: parsed.value.data, raw: json }
  }

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    return (await send(method, path, body)).data
  }

  async function pricingEnvelope(): Promise<PricingEnvelope> {
    const { data, raw } = await send("GET", "/api/pricing")
    const ratios = (raw as { group_ratio?: unknown }).group_ratio
    return {
      data: [...Schema.decodeUnknownSync(Schema.Array(Pricing))(data)],
      group_ratio: Object.fromEntries(
        Object.entries(ratios && typeof ratios === "object" ? ratios : {}).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ),
      ),
    }
  }

  return {
    async self() {
      return Schema.decodeUnknownSync(User)(await call("GET", "/api/user/self"))
    },
    async groups() {
      return Schema.decodeUnknownSync(Schema.Record(Schema.String, Group))(await call("GET", "/api/user/self/groups"))
    },
    async userModels(group) {
      return [
        ...Schema.decodeUnknownSync(Schema.Array(Schema.String))(
          await call("GET", `/api/user/models?group=${encodeURIComponent(group)}`),
        ),
      ]
    },
    async pricing() {
      return (await pricingEnvelope()).data
    },
    pricingEnvelope,
    async tokens() {
      const all: Token[] = []
      const seen = new Set<number>()
      // Bounded: a server that ignores `p` and omits `total` would otherwise loop forever.
      for (let page = 1; page <= MAX_TOKEN_PAGES; page++) {
        const data = Schema.decodeUnknownSync(TokenPage)(await call("GET", `/api/token/?p=${page}&size=${PAGE_SIZE}`))
        const fresh = data.items.filter((t) => !seen.has(t.id))
        for (const t of fresh) seen.add(t.id)
        all.push(...fresh)
        if (fresh.length === 0 || data.items.length < PAGE_SIZE || all.length >= (data.total ?? Infinity)) break
      }
      return all
    },
    async createToken(body) {
      await call("POST", "/api/token/", body)
    },
    async tokenKey(id) {
      const data = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
        await call("POST", `/api/token/${id}/key`),
      )
      return data.key
    },
  }
}

// The CLI always bills to one fixed group; the server grants it through a subscription.
export function requireGroup(groups: Record<string, Group>): string {
  if (TOKENGO_CLI_GROUP in groups) return TOKENGO_CLI_GROUP
  throw new Error(
    `Your TokenGo account has no active subscription for the CLI ("${TOKENGO_CLI_GROUP}" group). Check your subscription at ${TOKENGO_SUBSCRIBE_URL}, then run \`tokengo login\` again.`,
  )
}

export interface Provisioned {
  key: string
  metadata: Record<string, string>
}

export async function provision(input: {
  client: Client
  baseURL: string
  pat: string
  group: string
  user?: User
}): Promise<Provisioned> {
  const name = TOKENGO_TOKEN_NAME
  const user = input.user ?? (await input.client.self())
  const find = async () =>
    (await input.client.tokens()).find((t) => t.name === name && t.group === input.group && t.status === TOKEN_ENABLED)
  const existing = await find()
  if (!existing)
    await input.client.createToken({
      name,
      group: input.group,
      unlimited_quota: true,
      remain_quota: 0,
      expired_time: -1,
      model_limits_enabled: false,
      model_limits: "",
      allow_ips: "",
    })
  const token = existing ?? (await find())
  if (!token) throw new Error(`TokenGo token ${name} was created but not found`)
  return {
    key: await input.client.tokenKey(token.id),
    metadata: {
      baseURL: input.baseURL,
      group: input.group,
      username: user.username,
      userId: String(user.id),
      pat: input.pat,
    },
  }
}

export function quotaToUSD(quota: number): number {
  return quota / QUOTA_PER_USD
}
