import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_PROVIDER_IDS, allowed, ids } from "@/provider/gate"

const original = process.env["OPENCODE_ALL_PROVIDERS"]

afterEach(() => {
  if (original === undefined) delete process.env["OPENCODE_ALL_PROVIDERS"]
  else process.env["OPENCODE_ALL_PROVIDERS"] = original
})

describe("provider gate", () => {
  test("defaults only", () => {
    expect([...DEFAULT_PROVIDER_IDS]).toEqual(["token-go"])
    expect([...ids({})].sort()).toEqual([...DEFAULT_PROVIDER_IDS].sort())
  })

  test("config.provider opts in when enabled_providers is unset", () => {
    const set = ids({ provider: { anthropic: {} } })
    expect(set.has("anthropic")).toBe(true)
    expect(set.has("openai")).toBe(false)
    expect(set.has("opencode")).toBe(false)
    expect(set.has("token-go")).toBe(true)
  })

  test("opencode is opt-in via config.provider or enabled_providers", () => {
    expect(ids({}).has("opencode")).toBe(false)
    expect(ids({ provider: { opencode: {} } }).has("opencode")).toBe(true)
    expect(ids({ enabled_providers: ["opencode"] }).has("opencode")).toBe(true)
  })

  test("enabled_providers is exclusive", () => {
    const set = ids({ provider: { anthropic: {} }, enabled_providers: ["openai"] })
    expect([...set]).toEqual(["openai"])
  })

  test("disabled wins over defaults, config and enabled", () => {
    expect(ids({ provider: { anthropic: {} }, disabled_providers: ["anthropic", "opencode"] }).has("anthropic")).toBe(
      false,
    )
    expect(ids({ disabled_providers: ["opencode"] }).has("opencode")).toBe(false)
    expect(ids({ enabled_providers: ["openai"], disabled_providers: ["openai"] }).size).toBe(0)
  })

  test("denied ids are removed from every path", () => {
    expect(ids({ provider: { tokengo: {} } }).has("tokengo")).toBe(false)
    expect(ids({ enabled_providers: ["tokengo"] }).has("tokengo")).toBe(false)
  })

  test("allowed uses the allowlist when the flag is off", () => {
    process.env["OPENCODE_ALL_PROVIDERS"] = "0"
    const fn = allowed({ disabled_providers: ["token-go"] })
    expect(fn("opencode")).toBe(false)
    expect(fn("anthropic")).toBe(false)
    expect(fn("token-go")).toBe(false)
  })

  test("OPENCODE_ALL_PROVIDERS bypasses the allowlist but keeps disabled", () => {
    process.env["OPENCODE_ALL_PROVIDERS"] = "1"
    const fn = allowed({ disabled_providers: ["openai"] })
    expect(fn("anthropic")).toBe(true)
    expect(fn("openai")).toBe(false)
    expect(fn("tokengo")).toBe(false)
  })

  test("flag mode keeps upstream enabled_providers restriction", () => {
    process.env["OPENCODE_ALL_PROVIDERS"] = "1"
    const fn = allowed({ enabled_providers: ["anthropic"] })
    expect(fn("anthropic")).toBe(true)
    expect(fn("openai")).toBe(false)
  })
})
