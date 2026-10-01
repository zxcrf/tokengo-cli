import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, rm } from "fs/promises"
import path from "path"
import { Schema } from "effect"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import type { Fetch, Pricing } from "@/provider/tokengo/client"
import {
  ID,
  build,
  cachePath,
  clearCache,
  defaultModelID,
  discover,
  info,
  readCache,
  variantsFor,
  writeCache,
} from "@/provider/tokengo/models"
import { ProviderTransform } from "@/provider/transform"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import fixture from "./../tool/fixtures/models-api.json"

const baseURL = "https://relay.test"
const catalog = {
  anthropic: Provider.fromModelsDevProvider((fixture as unknown as Record<string, ModelsDev.Provider>)["anthropic"]),
}

const row = (over: Partial<Pricing> & { model_name: string }): Pricing => ({
  quota_type: 0,
  model_ratio: 1.5,
  completion_ratio: 5,
  supported_endpoint_types: ["openai"],
  ...over,
})

describe("tokengo models build", () => {
  test("info", () => {
    expect(info()).toMatchObject({ id: ID, name: "TokenGo", source: "custom", env: [], models: {} })
  })

  test("npm follows the model family; endpoint types only confirm availability", () => {
    const all = ["openai", "openai-response", "anthropic"]
    const models = build({
      names: [
        "claude-sonnet-4-5",
        "claude-compat-only",
        "gpt-5",
        "o3-mini",
        "gpt-chat-only",
        "gemini-2.5-pro",
        "deepseek-chat",
        "embed-only",
        "anthropic-only-gemini",
        "no-row",
      ],
      pricing: [
        row({ model_name: "claude-sonnet-4-5", supported_endpoint_types: all }),
        row({ model_name: "claude-compat-only", supported_endpoint_types: ["openai"] }),
        // Union across channels: GPT/Gemini rows often carry "anthropic" too.
        row({ model_name: "gpt-5", supported_endpoint_types: all }),
        row({ model_name: "o3-mini", supported_endpoint_types: ["openai", "openai-response"] }),
        row({ model_name: "gpt-chat-only", supported_endpoint_types: ["openai", "anthropic"] }),
        row({ model_name: "gemini-2.5-pro", supported_endpoint_types: all }),
        row({ model_name: "deepseek-chat", supported_endpoint_types: ["openai"] }),
        row({ model_name: "embed-only", supported_endpoint_types: ["embeddings"] }),
        row({ model_name: "anthropic-only-gemini", supported_endpoint_types: ["anthropic"] }),
      ],
      catalog: {},
      baseURL,
    })
    expect(models["claude-sonnet-4-5"].api).toEqual({
      id: "claude-sonnet-4-5",
      url: `${baseURL}/v1`,
      npm: "@ai-sdk/anthropic",
    })
    expect(models["claude-compat-only"].api.npm).toBe("@ai-sdk/openai-compatible")
    expect(models["gpt-5"].api.npm).toBe("@ai-sdk/openai")
    expect(models["o3-mini"].api.npm).toBe("@ai-sdk/openai")
    expect(models["gpt-chat-only"].api.npm).toBe("@ai-sdk/openai-compatible")
    expect(models["gemini-2.5-pro"].api.npm).toBe("@ai-sdk/openai-compatible")
    expect(models["deepseek-chat"].api.npm).toBe("@ai-sdk/openai-compatible")
    expect(models["embed-only"]).toBeUndefined()
    expect(models["anthropic-only-gemini"]).toBeUndefined()
    // no pricing row: treated as openai-only, zero cost
    expect(models["no-row"].api.npm).toBe("@ai-sdk/openai-compatible")
    expect(models["no-row"].cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  })

  test("cost math, per-request and fallback metadata", () => {
    const models = build({
      names: ["m", "per-call", "o3-mini"],
      pricing: [
        row({ model_name: "m", model_ratio: 1.5, completion_ratio: 5, cache_ratio: 0.1 }),
        row({ model_name: "per-call", quota_type: 1, model_price: 0.2 }),
        row({ model_name: "o3-mini" }),
      ],
      catalog: {},
      baseURL,
    })
    expect(models.m.cost.input).toBeCloseTo(3)
    expect(models.m.cost.output).toBeCloseTo(15)
    expect(models.m.cost.cache.read).toBeCloseTo(0.3)
    expect(models.m.cost.cache.write).toBeCloseTo(3.75)
    expect(models["per-call"].cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    expect(models.m.limit).toEqual({ context: 128000, output: 32000 })
    expect(models.m.capabilities.reasoning).toBe(false)
    expect(models["o3-mini"].capabilities.reasoning).toBe(true)
    expect(models.m).toMatchObject({
      status: "active",
      release_date: "",
      family: "",
      name: "m",
      options: {},
      headers: {},
    })
  })

  test("catalog exact and normalized hits keep limit, override cost", () => {
    const sonnet = catalog.anthropic.models["claude-sonnet-4-5"]
    expect(sonnet).toBeDefined()
    const models = build({
      names: ["claude-sonnet-4-5", "Anthropic/Claude-Sonnet-4.5-20250929", "claude-sonnet-4-5-latest"],
      pricing: [
        row({ model_name: "claude-sonnet-4-5", model_ratio: 1.5 }),
        row({ model_name: "Anthropic/Claude-Sonnet-4.5-20250929", model_ratio: 1.5 }),
        row({ model_name: "claude-sonnet-4-5-latest", model_ratio: 1.5 }),
      ],
      catalog,
      baseURL,
    })
    for (const m of Object.values(models)) {
      expect(m.limit).toEqual(sonnet.limit)
      expect(m.name).toBe(sonnet.name.replace(/ \(latest\)$/, ""))
      expect(m.capabilities).toEqual(sonnet.capabilities)
      expect(m.cost.input).toBeCloseTo(3)
    }
    expect(models["claude-sonnet-4-5"].cost).not.toEqual(sonnet.cost)
  })

  test("strips a trailing (latest) alias suffix from catalog names only", () => {
    const base = catalog.anthropic.models["claude-sonnet-4-5"]
    const make = (name: string) => ({
      anthropic: { ...catalog.anthropic, models: { "claude-haiku-4-5": { ...base, id: ModelV2.ID.make("claude-haiku-4-5"), name } } },
    })
    const run = (name: string) =>
      build({
        names: ["claude-haiku-4-5"],
        pricing: [row({ model_name: "claude-haiku-4-5" })],
        catalog: make(name),
        baseURL,
      })["claude-haiku-4-5"].name
    expect(run("Claude Haiku 4.5 (latest)")).toBe("Claude Haiku 4.5")
    expect(run("Claude Haiku 4.5 (LATEST) ")).toBe("Claude Haiku 4.5")
    expect(run("Claude Haiku 4.5")).toBe("Claude Haiku 4.5")
  })

  test("variantsFor gives explicit per-family efforts and leaves Claude to upstream", () => {
    const compat = "@ai-sdk/openai-compatible"
    const table: [string, string[] | undefined][] = [
      ["gpt-5.5", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-5.6-sol", ["minimal", "low", "medium", "high", "xhigh", "max"]],
      ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
      ["openai/gpt-5.5", ["low", "medium", "high", "xhigh", "max"]],
      ["gpt-5-codex", ["low", "medium", "high"]],
      ["gemini-3.6-flash", ["minimal", "low", "medium", "high"]],
      ["gemini-3.8-flash", ["low", "medium", "high"]],
      ["gemini-3.1-pro", ["low", "medium", "high"]],
      ["grok-4.5", ["low", "medium", "high"]],
      ["grok-4.6", ["low", "medium", "high", "xhigh"]],
      ["grok-4.7", ["low", "medium", "high", "xhigh"]],
      ["deepseek-flash", ["low", "high", "max"]],
      ["claude-sonnet-5", undefined],
    ]
    for (const [id, efforts] of table) {
      const npm = id.startsWith("claude") ? "@ai-sdk/anthropic" : compat
      const v = variantsFor(id, npm)
      expect(v ? Object.keys(v) : undefined).toEqual(efforts)
      for (const [effort, value] of Object.entries(v ?? {})) expect(value).toEqual({ reasoningEffort: effort })
    }
    expect(variantsFor("claude-sonnet-5", compat)).toBeUndefined()
    expect(variantsFor("mystery-model", compat)).toBeUndefined()
  })

  test("variantsFor matches the upstream @ai-sdk/openai shape", () => {
    const m = build({
      names: ["gpt-5.5"],
      pricing: [row({ model_name: "gpt-5.5", supported_endpoint_types: ["openai-response"] })],
      catalog: {},
      baseURL,
    })["gpt-5.5"]
    expect(m.api.npm).toBe("@ai-sdk/openai")
    expect(m.variants).toBeDefined()
    const upstream = ProviderTransform.variants({ ...m, variants: undefined })
    // Upstream does not know `max` for GPT; every other effort must match its shape exactly.
    for (const [effort, value] of Object.entries(m.variants ?? {}))
      if (effort !== "max") expect(upstream[effort]).toEqual(value)
    expect(Object.keys(m.variants ?? {})).toContain("max")
    expect(m.variants?.xhigh).toEqual({
      reasoningEffort: "xhigh",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    })
  })

  test("cache costs default to 1.0x read / 1.25x write and scale with the group ratio", () => {
    const models = build({
      names: ["m"],
      pricing: [row({ model_name: "m", model_ratio: 1.5, completion_ratio: 5 })],
      catalog: {},
      baseURL,
      groupRatio: 0.5,
    })
    expect(models.m.cost.input).toBeCloseTo(1.5)
    expect(models.m.cost.output).toBeCloseTo(7.5)
    expect(models.m.cost.cache.read).toBeCloseTo(1.5)
    expect(models.m.cost.cache.write).toBeCloseTo(1.875)
  })

  test("canonical vendor wins, deprecated/alpha entries are skipped, catalog options/headers are not copied", () => {
    const anthropic = catalog.anthropic
    const sonnet = anthropic.models["claude-sonnet-4-5"]
    const reseller: Provider.Info = {
      ...anthropic,
      id: ProviderV2.ID.make("aaa-reseller"),
      models: {
        "claude-sonnet-4-5": {
          ...sonnet,
          name: "Reseller Sonnet",
          limit: { context: 1, output: 1 },
          options: { reseller: true },
          headers: { "x-reseller": "1" },
        },
        "legacy-model": { ...sonnet, id: ModelV2.ID.make("legacy-model"), name: "Reseller Legacy" },
      },
    }
    const vendor: Provider.Info = {
      ...anthropic,
      models: {
        "claude-sonnet-4-5": { ...sonnet, status: "beta" },
        "legacy-model": { ...sonnet, id: ModelV2.ID.make("legacy-model"), name: "Vendor Legacy", status: "deprecated" },
      },
    }
    // Reseller listed first on purpose: the canonical vendor must still win.
    const models = build({
      names: ["claude-sonnet-4-5", "legacy-model"],
      pricing: [],
      catalog: { "aaa-reseller": reseller, anthropic: vendor },
      baseURL,
    })
    expect(models["claude-sonnet-4-5"].name).toBe(sonnet.name.replace(/ \(latest\)$/, ""))
    expect(models["claude-sonnet-4-5"].limit).toEqual(sonnet.limit)
    expect(models["claude-sonnet-4-5"].status).toBe("active")
    expect(models["claude-sonnet-4-5"].options).toEqual({})
    expect(models["claude-sonnet-4-5"].headers).toEqual({})
    expect(models["legacy-model"].name).toBe("Reseller Legacy")
    expect(models["legacy-model"].status).toBe("active")
  })

  test("every record satisfies Provider.Model", () => {
    const models = build({
      names: ["claude-sonnet-4-5", "unknown-model", "gpt-5"],
      pricing: [row({ model_name: "claude-sonnet-4-5", cache_ratio: 0.1, create_cache_ratio: 1.25 })],
      catalog,
      baseURL,
    })
    expect(Object.keys(models)).toHaveLength(3)
    for (const m of Object.values(models)) {
      expect(Schema.is(Provider.Model)(m)).toBe(true)
      expect(m.providerID).toBe(ProviderV2.ID.make(ID))
    }
  })
})

describe("tokengo defaultModelID", () => {
  const ids = (...names: string[]) =>
    Object.fromEntries(names.map((n) => [n, { id: ModelV2.ID.make(n) } as Provider.Model]))

  test("priority order by substring", () => {
    expect(defaultModelID(ids("gpt-5", "claude-opus-4-5-x", "zzz"))).toBe("claude-opus-4-5-x")
    expect(defaultModelID(ids("gpt-5", "gpt-5-codex"))).toBe("gpt-5-codex")
  })
  test("falls back to first sorted id, undefined when empty", () => {
    expect(defaultModelID(ids("zeta", "alpha"))).toBe("alpha")
    expect(defaultModelID({})).toBeUndefined()
  })
})

describe("tokengo discover cache", () => {
  const failing = (async () => {
    throw new Error("offline")
  }) as unknown as Fetch
  const model = build({ names: ["cached"], pricing: [row({ model_name: "cached" })], catalog: {}, baseURL })
  const args = { baseURL, pat: "pat", group: "tokengo", catalog: {} }
  const until = async (check: () => Promise<boolean>, ms = 3000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await check()) return
      await Bun.sleep(10)
    }
    throw new Error(`condition not met within ${ms}ms`)
  }

  let backup: Awaited<ReturnType<typeof readCache>>
  beforeEach(async () => {
    backup = await readCache()
    await clearCache()
  })
  afterEach(async () => {
    await rm(cachePath(), { recursive: true, force: true })
    if (backup) await writeCache(backup)
  })

  const okFetch: Fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    if (url.pathname === "/api/user/models") return Response.json({ success: true, data: ["fresh"] })
    if (url.pathname === "/api/pricing")
      return Response.json({
        success: true,
        data: [{ model_name: "fresh", quota_type: 0, model_ratio: 1 }],
        group_ratio: { tokengo: 0.5, default: 1 },
      })
    return new Response("nope", { status: 404 })
  }) as Fetch

  const pricingForbidden: Fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    if (url.pathname === "/api/user/models") return Response.json({ success: true, data: ["claude-x", "gpt-5"] })
    return Response.json({ success: false, message: "forbidden" }, { status: 403 })
  }) as Fetch

  test("fresh cache is returned without fetching", async () => {
    await writeCache({ fetchedAt: Date.now(), baseURL, group: "tokengo", models: model })
    expect(Object.keys(await discover({ ...args, fetch: failing }))).toEqual(["cached"])
  })

  test("missing cache fetches, builds and writes", async () => {
    const models = await discover({ ...args, userId: "7", fetch: okFetch })
    expect(Object.keys(models)).toEqual(["fresh"])
    // group_ratio[tokengo] = 0.5 from the pricing envelope
    expect(models.fresh.cost.input).toBeCloseTo(1)
    const cache = await readCache()
    expect(cache?.models.fresh.id).toBe(ModelV2.ID.make("fresh"))
    expect(cache?.userId).toBe("7")
  })

  test("pricing is optional: a 403 still yields models with zero cost", async () => {
    const models = await discover({ ...args, fetch: pricingForbidden })
    expect(Object.keys(models).sort()).toEqual(["claude-x", "gpt-5"])
    expect(models["claude-x"].api.npm).toBe("@ai-sdk/openai-compatible")
    expect(models["claude-x"].cost.input).toBe(0)
  })

  test("a cache write failure still returns the discovered models", async () => {
    // A directory at the cache path makes the final rename fail.
    await mkdir(path.join(cachePath(), "blocker"), { recursive: true })
    const models = await discover({ ...args, fetch: okFetch })
    expect(Object.keys(models)).toEqual(["fresh"])
    const leftovers = (await readdir(path.dirname(cachePath()))).filter((f) => f.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  })

  test("cache for another user is not used", async () => {
    await writeCache({ fetchedAt: Date.now(), baseURL, group: "tokengo", userId: "1", models: model })
    expect(await discover({ ...args, userId: "2", fetch: failing })).toEqual({})
  })

  test("fetch failure with no cache yields empty", async () => {
    expect(await discover({ ...args, fetch: failing })).toEqual({})
  })

  test("stale cache is served immediately and refreshed in the background", async () => {
    await writeCache({ fetchedAt: 0, baseURL, group: "tokengo", models: model })
    expect(Object.keys(await discover({ ...args, fetch: okFetch }))).toEqual(["cached"])
    await until(async () => Object.keys((await readCache())?.models ?? {}).includes("fresh"))
    expect(Object.keys((await readCache())!.models)).toEqual(["fresh"])
  })

  test("stale cache survives a failing refresh; force falls back to it", async () => {
    await writeCache({ fetchedAt: 0, baseURL, group: "tokengo", models: model })
    expect(Object.keys(await discover({ ...args, fetch: failing }))).toEqual(["cached"])
    expect(Object.keys(await discover({ ...args, fetch: failing, force: true }))).toEqual(["cached"])
  })

  test("cache for another group is not used", async () => {
    await writeCache({ fetchedAt: Date.now(), baseURL, group: "other", models: model })
    expect(await discover({ ...args, fetch: failing })).toEqual({})
  })
})
