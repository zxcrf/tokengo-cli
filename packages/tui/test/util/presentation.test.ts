import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("tokengo -s ses_123")
})

test("wordmark keeps n open and does not draw shadow-only marks", () => {
  const plain = sessionEpilogue({ title: "A session", sessionID: "ses_123" }).replace(/\x1b\[[0-9;]*m/g, "")
  const bottom = plain.split("\n").find((row) => row.includes("▀▀▀ ▀▀▀▀"))
  expect(plain).toContain("▀  ▀")
  expect(bottom).toBeDefined()
  expect(bottom).not.toContain("▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀")
})
