import { describe, expect, test } from "bun:test"
import {
  TOKENGO_CLI_GROUP,
  TOKENGO_SUBSCRIBE_URL,
  make,
  requireGroup,
  provision,
  quotaToUSD,
  type Client,
  type Fetch,
  type Group,
  type Token,
  type User,
} from "@/provider/tokengo/client"

const PAT = "pat-secret-value"
const user: User = { id: 7, username: "alice", group: "default" }

function ok(data: unknown) {
  return Response.json({ success: true, message: "", data })
}

function fake(routes: Record<string, (req: { method: string; headers: Headers; body: unknown }) => Response>) {
  const calls: string[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString())
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`
    calls.push(key)
    const route = routes[key]
    if (!route) return new Response("not found", { status: 404 })
    return route({
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
  }) as Fetch
  return { fetch, calls }
}

const group = (ratio: number | string = 1): Group => ({ ratio, desc: "" })

describe("tokengo client", () => {
  test("self sends bearer PAT and decodes user", async () => {
    const f = fake({
      "GET /api/user/self": (req) => {
        expect(req.headers.get("authorization")).toBe(`Bearer ${PAT}`)
        expect(req.headers.get("accept")).toBe("application/json")
        return ok({ id: 7, username: "alice", display_name: "Alice", group: "default", quota: 500000, used_quota: 0 })
      },
    })
    const client = make({ pat: PAT, fetch: f.fetch, baseURL: "https://example.test/" })
    expect((await client.self()).username).toBe("alice")
  })

  test("self surfaces server message on failure without leaking PAT", async () => {
    const f = fake({
      "GET /api/user/self": () => Response.json({ success: false, message: "invalid token" }, { status: 401 }),
    })
    const error = await make({ pat: PAT, fetch: f.fetch })
      .self()
      .catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("invalid token")
    expect((error as Error).message).not.toContain(PAT)
  })

  test("non-JSON failure becomes HTTP error", async () => {
    const f = fake({ "GET /api/user/self": () => new Response("<html>", { status: 502 }) })
    const error = await make({ pat: PAT, fetch: f.fetch })
      .self()
      .catch((e: Error) => e)
    expect((error as Error).message).toContain("502")
    expect((error as Error).message).not.toContain(PAT)
  })

  test("groups accepts number and string ratios", async () => {
    const f = fake({
      "GET /api/user/self/groups": () => ok({ tokengo: { ratio: 1.5, desc: "x" }, auto: { ratio: "自动", desc: "y" } }),
    })
    const groups = await make({ pat: PAT, fetch: f.fetch }).groups()
    expect(groups.tokengo.ratio).toBe(1.5)
    expect(groups.auto.ratio).toBe("自动")
  })

  test("userModels encodes group and pricing decodes rows", async () => {
    const f = fake({
      "GET /api/user/models?group=a%20b": () => ok(["m1", "m2"]),
      "GET /api/pricing": () =>
        ok([{ model_name: "m1", quota_type: 0, model_ratio: 1, completion_ratio: 5, enable_groups: ["tokengo"] }]),
    })
    const client = make({ pat: PAT, fetch: f.fetch })
    expect(await client.userModels("a b")).toEqual(["m1", "m2"])
    expect((await client.pricing())[0].completion_ratio).toBe(5)
  })

  test("pricingEnvelope returns rows plus numeric group ratios", async () => {
    const f = fake({
      "GET /api/pricing": () =>
        Response.json({
          success: true,
          data: [{ model_name: "m1", quota_type: 0, model_ratio: 1 }],
          group_ratio: { cli: 0.8, default: 1, auto: "自动" },
        }),
    })
    const envelope = await make({ pat: PAT, fetch: f.fetch }).pricingEnvelope()
    expect(envelope.data.map((row) => row.model_name)).toEqual(["m1"])
    expect(envelope.group_ratio).toEqual({ cli: 0.8, default: 1 })
  })

  test("tokens paginates until a short page", async () => {
    const page = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: start + i, name: `t${start + i}`, status: 1 }))
    const f = fake({
      "GET /api/token/?p=1&size=100": () => ok({ page: 1, page_size: 100, total: 130, items: page(1, 100) }),
      "GET /api/token/?p=2&size=100": () => ok({ page: 2, page_size: 100, total: 130, items: page(101, 30) }),
    })
    const all = await make({ pat: PAT, fetch: f.fetch }).tokens()
    expect(all).toHaveLength(130)
    expect(f.calls).toEqual(["GET /api/token/?p=1&size=100", "GET /api/token/?p=2&size=100"])
  })

  test("tokens terminates when the server ignores p and omits total", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `t${i}`, status: 1 }))
    let n = 0
    const fetch = (async () => {
      n++
      return ok({ items })
    }) as unknown as Fetch
    const all = await make({ pat: PAT, fetch }).tokens()
    expect(all).toHaveLength(100)
    expect(n).toBeLessThanOrEqual(2)
  })

  test("tokens stops once total is reached", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `t${i}`, status: 1 }))
    const f = fake({ "GET /api/token/?p=1&size=100": () => ok({ total: 100, items }) })
    expect(await make({ pat: PAT, fetch: f.fetch }).tokens()).toHaveLength(100)
    expect(f.calls).toHaveLength(1)
  })

  test("tokenKey posts to the key endpoint", async () => {
    const f = fake({ "POST /api/token/9/key": () => ok({ key: "sk-abc" }) })
    expect(await make({ pat: PAT, fetch: f.fetch }).tokenKey(9)).toBe("sk-abc")
  })
})

describe("tokengo requireGroup", () => {
  test("returns the fixed group when the account can use it", () => {
    expect(requireGroup({ default: group(), tokengo: group(), vip: group() })).toBe("tokengo")
    expect(TOKENGO_CLI_GROUP).toBe("tokengo")
  })
  test("throws with the subscribe URL when the group is absent", () => {
    expect(() => requireGroup({ default: group(), cli: group() })).toThrow(TOKENGO_SUBSCRIBE_URL)
    expect(() => requireGroup({})).toThrow('no active subscription')
  })
})

describe("tokengo provision", () => {
  function stub(lists: Token[][]) {
    const created: unknown[] = []
    let n = 0
    const client: Client = {
      self: async () => user,
      groups: async () => ({}),
      userModels: async () => [],
      pricing: async () => [],
      pricingEnvelope: async () => ({ data: [], group_ratio: {} }),
      tokens: async () => lists[Math.min(n++, lists.length - 1)],
      createToken: async (body) => void created.push(body),
      tokenKey: async (id) => `sk-${id}`,
    }
    return { client, created }
  }
  const token = (over: Partial<Token>): Token => ({ id: 1, name: "tokengo-cli", group: "tokengo", status: 1, ...over })

  test("reuses an existing enabled token", async () => {
    const s = stub([[token({ id: 5 })]])
    const out = await provision({ client: s.client, baseURL: "https://x", pat: PAT, group: "tokengo" })
    expect(s.created).toHaveLength(0)
    expect(out.key).toBe("sk-5")
    expect(out.metadata).toEqual({ baseURL: "https://x", group: "tokengo", username: "alice", userId: "7", pat: PAT })
  })

  test("reuses the matching token even when an earlier one is in another group", async () => {
    const s = stub([[token({ id: 3, group: "vip" }), token({ id: 4 })]])
    const out = await provision({ client: s.client, baseURL: "https://x", pat: PAT, group: "tokengo" })
    expect(s.created).toHaveLength(0)
    expect(out.key).toBe("sk-4")
  })

  test("ignores disabled or other-group tokens and creates one", async () => {
    const s = stub([[token({ id: 2, status: 2 }), token({ id: 3, group: "vip" })], [token({ id: 8 })]])
    const out = await provision({ client: s.client, baseURL: "https://x", pat: PAT, group: "tokengo", user })
    expect(s.created).toEqual([
      {
        name: "tokengo-cli",
        group: "tokengo",
        unlimited_quota: true,
        remain_quota: 0,
        expired_time: -1,
        model_limits_enabled: false,
        model_limits: "",
        allow_ips: "",
      },
    ])
    expect(out.key).toBe("sk-8")
  })

  test("fails when the created token cannot be found", async () => {
    const s = stub([[]])
    const error = await provision({ client: s.client, baseURL: "https://x", pat: PAT, group: "tokengo" }).catch(
      (e: Error) => e,
    )
    expect((error as Error).message).not.toContain(PAT)
    expect(error).toBeInstanceOf(Error)
  })
})

test("quotaToUSD", () => {
  expect(quotaToUSD(500000)).toBe(1)
  expect(quotaToUSD(250000)).toBe(0.5)
})
