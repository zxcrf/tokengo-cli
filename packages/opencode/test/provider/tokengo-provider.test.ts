import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { FAKE_TOKENGO_MODELS, FAKE_TOKENGO_PRICING, fakeTokengo } from "../lib/tokengo-server"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { GlobalBus } from "@/bus/global"
import type { Pricing } from "@/provider/tokengo/client"
import { ID, build, clearCache, readCache, writeCache } from "@/provider/tokengo/models"
import fixture from "./../tool/fixtures/models-api.json"

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
const tokengo = ProviderV2.ID.make(ID)
const baseURL = "http://127.0.0.1:9"

const catalog = mapCatalog(fixture as unknown as Record<string, ModelsDev.Provider>)

function mapCatalog(data: Record<string, ModelsDev.Provider>) {
  return Object.fromEntries(Object.entries(data).map(([id, item]) => [id, Provider.fromModelsDevProvider(item)]))
}

const originalEnv = new Map<string, string | undefined>()
const setEnv = (key: string, value: string) =>
  Effect.sync(() => {
    if (!originalEnv.has(key)) originalEnv.set(key, process.env[key])
    process.env[key] = value
  })

const login = (url: string, pat = "pat-test") =>
  setEnv(
    "OPENCODE_AUTH_CONTENT",
    JSON.stringify({
      [ID]: {
        type: "api",
        key: "sk-test",
        metadata: { baseURL: url, group: "tokengo", username: "alice", userId: "7", pat },
      },
    }),
  )

const seedCache = (url: string) =>
  Effect.promise(() =>
    writeCache({
      fetchedAt: Date.now(),
      baseURL: url,
      group: "tokengo",
      userId: "7",
      models: build({
        names: FAKE_TOKENGO_MODELS,
        pricing: FAKE_TOKENGO_PRICING as Pricing[],
        catalog,
        baseURL: url,
      }),
    }),
  )

const languageBaseURL = (language: unknown) => (language as { config: { baseURL: string } }).config.baseURL
const languageProvider = (language: unknown) => (language as { provider: string }).provider

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await clearCache()
  await disposeAllInstances()
})

it.instance("token-go: stored credential autoloads provider with cached models of mixed npm", () =>
  Effect.gen(function* () {
    yield* login(baseURL)
    yield* seedCache(baseURL)
    const providers = yield* Provider.use.list()
    const provider = providers[tokengo]
    expect(provider).toBeDefined()
    expect(provider.key).toBe("sk-test")
    expect(Object.keys(provider.models).sort()).toEqual([...FAKE_TOKENGO_MODELS].sort())
    expect(provider.models["claude-sonnet-4-5"].api).toEqual({
      id: "claude-sonnet-4-5",
      url: `${baseURL}/v1`,
      npm: "@ai-sdk/anthropic",
    })
    expect(provider.models["gpt-5"].api.npm).toBe("@ai-sdk/openai")
    expect(provider.models["deepseek-chat"].api.npm).toBe("@ai-sdk/openai-compatible")
    // Reasoning variants are computed by Provider from the npm package, not left empty.
    expect(Object.keys(provider.models["claude-sonnet-4-5"].variants ?? {}).length).toBeGreaterThan(0)
    expect(Object.keys(provider.models["gpt-5"].variants ?? {}).length).toBeGreaterThan(0)
  }),
)

it.instance("token-go: default and small model follow token-go priority", () =>
  Effect.gen(function* () {
    yield* login(baseURL)
    yield* seedCache(baseURL)
    expect(yield* Provider.use.defaultModel()).toEqual({
      providerID: tokengo,
      modelID: ModelV2.ID.make("claude-sonnet-4-5"),
    })
    const small = yield* Provider.use.getSmallModel(tokengo)
    expect(small?.id).toBe(ModelV2.ID.make("claude-haiku-4-5"))
  }),
)

it.instance("token-go: getLanguage picks the SDK and endpoint per model npm", () =>
  Effect.gen(function* () {
    yield* login(baseURL)
    yield* seedCache(baseURL)
    const provider = yield* Provider.Service
    const language = (id: string) =>
      provider.getModel(tokengo, ModelV2.ID.make(id)).pipe(Effect.flatMap((model) => provider.getLanguage(model)))

    const claude = yield* language("claude-sonnet-4-5")
    expect(languageBaseURL(claude)).toBe(`${baseURL}/v1`)
    expect((claude as object).constructor.name).toBe("AnthropicMessagesLanguageModel")

    const gpt = yield* language("gpt-5")
    expect(languageProvider(gpt)).toBe("token-go.responses")

    const deepseek = yield* language("deepseek-chat")
    expect(languageProvider(deepseek)).toBe("token-go.chat")
  }),
)

it.instance("token-go: discovers models from the server on cache miss and writes the cache", () => {
  const server = fakeTokengo()
  return Effect.gen(function* () {
    yield* login(server.url, server.pat)
    const providers = yield* Provider.use.list()
    expect(Object.keys(providers[tokengo].models).sort()).toEqual([...FAKE_TOKENGO_MODELS].sort())
    expect(server.calls).toContain("GET /api/user/models?group=tokengo")
    const cache = yield* Effect.promise(() => readCache())
    expect(cache?.baseURL).toBe(server.url)
    expect(Object.keys(cache?.models ?? {}).length).toBe(FAKE_TOKENGO_MODELS.length)
  }).pipe(Effect.ensuring(Effect.sync(() => server.stop())))
})

it.instance("token-go: explicit per-family variants survive the provider pipeline", () => {
  const server = fakeTokengo({ models: ["grok-4.6", "grok-4.5", "deepseek-flash", "claude-sonnet-4-5"], pricing: [] })
  return Effect.gen(function* () {
    yield* login(server.url, server.pat)
    const models = (yield* Provider.use.list())[tokengo].models
    expect(Object.keys(models["grok-4.6"].variants ?? {})).toEqual(["low", "medium", "high", "xhigh"])
    expect(Object.keys(models["grok-4.5"].variants ?? {})).toEqual(["low", "medium", "high"])
    expect(Object.keys(models["deepseek-flash"].variants ?? {})).toEqual(["low", "high", "max"])
    expect(models["grok-4.6"].variants?.xhigh).toEqual({ reasoningEffort: "xhigh" })
  }).pipe(Effect.ensuring(Effect.sync(() => server.stop())))
})

it.instance("token-go: absent without a stored credential", () =>
  Effect.gen(function* () {
    yield* setEnv("OPENCODE_AUTH_CONTENT", JSON.stringify({}))
    yield* seedCache(baseURL)
    const providers = yield* Provider.use.list()
    expect(providers[tokengo]).toBeUndefined()
  }),
)

it.instance("token-go: unreachable server and no cache leaves provider out without failing", () =>
  Effect.gen(function* () {
    yield* login(baseURL)
    const providers = yield* Provider.use.list()
    expect(providers[tokengo]).toBeUndefined()
  }),
)

it.instance(
  "token-go: config-declared model takes discovered url/npm and keeps configured limit",
  () =>
    Effect.gen(function* () {
      yield* login(baseURL)
      yield* seedCache(baseURL)
      const providers = yield* Provider.use.list()
      const model = providers[tokengo].models["claude-sonnet-4-5"]
      expect(model.api.url).toBe(`${baseURL}/v1`)
      expect(model.api.npm).toBe("@ai-sdk/anthropic")
      expect(model.limit).toMatchObject({ context: 50000, output: 4000 })
      // Discovered metadata survives the config declaration.
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.cost.input).toBeGreaterThan(0)
      expect(model.family).toBeTruthy()
      expect(Object.keys(model.variants ?? {}).length).toBeGreaterThan(0)
      expect(Object.keys(providers[tokengo].models).sort()).toEqual([...FAKE_TOKENGO_MODELS].sort())
    }),
  {
    config: {
      provider: { "token-go": { models: { "claude-sonnet-4-5": { limit: { context: 50000, output: 4000 } } } } },
    },
  },
)

it.instance(
  "token-go: config declaring only variants keeps discovered limit and applies the override",
  () =>
    Effect.gen(function* () {
      yield* login(baseURL)
      yield* seedCache(baseURL)
      const model = (yield* Provider.use.list())[tokengo].models["claude-sonnet-4-5"]
      expect(model.limit.context).toBeGreaterThan(0)
      expect(model.api.npm).toBe("@ai-sdk/anthropic")
      expect(model.variants?.high).toBeUndefined()
      expect(Object.keys(model.variants ?? {}).length).toBeGreaterThan(0)
    }),
  {
    config: {
      provider: { "token-go": { models: { "claude-sonnet-4-5": { variants: { high: { disabled: true } } } } } },
    },
  },
)

it.instance(
  "token-go: an explicitly configured npm is not overwritten by discovery",
  () =>
    Effect.gen(function* () {
      yield* login(baseURL)
      yield* seedCache(baseURL)
      const model = (yield* Provider.use.list())[tokengo].models["claude-haiku-4-5"]
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.api.url).toBe(`${baseURL}/v1`)
    }),
  {
    config: {
      provider: { "token-go": { models: { "claude-haiku-4-5": { provider: { npm: "@ai-sdk/openai-compatible" } } } } },
    },
  },
)

it.instance(
  "token-go: configured model wins over token-go default",
  () =>
    Effect.gen(function* () {
      yield* login(baseURL)
      yield* seedCache(baseURL)
      expect(yield* Provider.use.defaultModel()).toEqual({
        providerID: tokengo,
        modelID: ModelV2.ID.make("deepseek-chat"),
      })
    }),
  { config: { model: "token-go/deepseek-chat" } },
)

// Relay model changes must reach a running TUI without a restart, like upstream models.dev refreshes.
it.instance("token-go: a stale list is shown at once, then replaced by the relay list with catalog.updated", () => {
  const server = fakeTokengo()
  const events: string[] = []
  const listener = (event: { payload: { type: string } }) => events.push(event.payload.type)
  return Effect.gen(function* () {
    GlobalBus.on("event", listener)
    yield* login(server.url, server.pat)
    yield* Effect.promise(() =>
      writeCache({
        fetchedAt: 0,
        baseURL: server.url,
        group: "tokengo",
        userId: "7",
        models: build({ names: [FAKE_TOKENGO_MODELS[0]], pricing: [], catalog, baseURL: server.url }),
      }),
    )
    const before = yield* Provider.use.list()
    expect(Object.keys(before[tokengo].models)).toEqual([FAKE_TOKENGO_MODELS[0]])

    yield* Effect.promise(async () => {
      const end = Date.now() + 5000
      while (!events.includes("catalog.updated") && Date.now() < end) await Bun.sleep(20)
    })
    expect(events).toContain("catalog.updated")
    const after = yield* Provider.use.list()
    expect(Object.keys(after[tokengo].models).sort()).toEqual([...FAKE_TOKENGO_MODELS].sort())
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        GlobalBus.off("event", listener)
        server.stop()
      }),
    ),
  )
})

// Within the 5-minute window the relay is not asked again.
it.instance("token-go: a fresh cache is not refetched", () => {
  const server = fakeTokengo()
  return Effect.gen(function* () {
    yield* login(server.url, server.pat)
    yield* seedCache(server.url)
    yield* Provider.use.list()
    yield* Effect.promise(() => Bun.sleep(200))
    expect(server.calls).not.toContain("GET /api/user/models?group=tokengo")
  }).pipe(Effect.ensuring(Effect.sync(() => server.stop())))
})
