// In-process fake of the token-go (NewAPI) dashboard API used by login, the
// plugin auth hook and model discovery. Bind to port 0 and use `url`.
export type FakeTokengoOptions = {
  pat?: string
  groups?: Record<string, { ratio: number | string; desc?: string }>
  models?: string[]
  pricing?: Record<string, unknown>[]
}

export const FAKE_TOKENGO_MODELS = ["claude-sonnet-4-5", "claude-haiku-4-5", "gpt-5", "deepseek-chat"]

export const FAKE_TOKENGO_PRICING = [
  {
    model_name: "claude-sonnet-4-5",
    quota_type: 0,
    model_ratio: 1.5,
    completion_ratio: 5,
    supported_endpoint_types: ["anthropic", "openai"],
  },
  {
    model_name: "claude-haiku-4-5",
    quota_type: 0,
    model_ratio: 0.5,
    completion_ratio: 5,
    supported_endpoint_types: ["anthropic", "openai"],
  },
  {
    model_name: "gpt-5",
    quota_type: 0,
    model_ratio: 0.625,
    completion_ratio: 8,
    supported_endpoint_types: ["openai", "openai-response"],
  },
  {
    model_name: "deepseek-chat",
    quota_type: 0,
    model_ratio: 0.135,
    completion_ratio: 4,
    supported_endpoint_types: ["openai"],
  },
]

export function fakeTokengo(options: FakeTokengoOptions = {}) {
  const pat = options.pat ?? "pat-test"
  const groups = options.groups ?? {
    default: { ratio: 1, desc: "Default" },
    tokengo: { ratio: 0.8, desc: "TokenGo" },
  }
  const tokens: { id: number; name: string; group: string; status: number }[] = []
  const calls: string[] = []
  const ok = (data: unknown) => Response.json({ success: true, message: "", data })

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      calls.push(`${req.method} ${url.pathname}${url.search}`)
      if (req.headers.get("authorization") !== `Bearer ${pat}`)
        return Response.json({ success: false, message: "invalid access token" }, { status: 401 })
      if (req.method === "GET" && url.pathname === "/api/user/self")
        return ok({ id: 7, username: "alice", group: "default", quota: 2_500_000, used_quota: 0 })
      if (req.method === "GET" && url.pathname === "/api/user/self/groups") return ok(groups)
      if (req.method === "GET" && url.pathname === "/api/user/models") return ok(options.models ?? FAKE_TOKENGO_MODELS)
      if (req.method === "GET" && url.pathname === "/api/pricing") return ok(options.pricing ?? FAKE_TOKENGO_PRICING)
      if (req.method === "GET" && url.pathname === "/api/token/")
        return ok({ page: 1, page_size: 100, total: tokens.length, items: tokens })
      if (req.method === "POST" && url.pathname === "/api/token/") {
        const body = (await req.json()) as { name: string; group: string }
        tokens.push({ id: tokens.length + 1, name: body.name, group: body.group, status: 1 })
        return ok(null)
      }
      const key = /^\/api\/token\/(\d+)\/key$/.exec(url.pathname)
      if (req.method === "POST" && key) return ok({ key: `sk-fake-${key[1]}` })
      return Response.json({ success: false, message: "not found" }, { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    pat,
    calls,
    tokens,
    stop: () => server.stop(true),
  }
}
