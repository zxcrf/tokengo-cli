import { describe, expect, test } from "bun:test"
import { checkPluginCompatibility } from "@/plugin/shared"
import { Installation } from "@/installation"

const plugin = (range: string) => ({ dir: "/tmp/p", pkg: "p", json: { engines: { opencode: range } } })

describe("tokengo release versions", () => {
  // Releases are versioned <upstream>-tokengo.N; semver treats that as a prerelease, which plain
  // ranges reject by default and would block every plugin that declares engines.opencode.
  test("prerelease tokengo versions satisfy plugin engine ranges", async () => {
    await checkPluginCompatibility("p", "1.18.33-tokengo.1", plugin(">=1.0.0"))
    await expect(checkPluginCompatibility("p", "1.18.33-tokengo.1", plugin(">=2.0.0"))).rejects.toThrow(
      "Plugin requires opencode >=2.0.0",
    )
  })

  // Same upstream base => patch => auto-upgrade; a new upstream minor only notifies.
  test("release type compares the upstream base", () => {
    expect(Installation.getReleaseType("1.18.33-tokengo.1", "1.18.33-tokengo.2")).toBe("patch")
    expect(Installation.getReleaseType("1.18.33-tokengo.2", "1.19.0-tokengo.1")).toBe("minor")
  })
})
