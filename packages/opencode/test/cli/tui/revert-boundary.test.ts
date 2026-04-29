import { describe, expect, test } from "bun:test"
import { boundaryFromMessageResponse } from "../../../src/cli/cmd/tui/util/revert-boundary"

describe("TUI revert boundary response", () => {
  test("only treats 404 responses as missing boundaries", () => {
    const found = { info: { id: "msg_found" } }
    expect(boundaryFromMessageResponse({ data: found, response: { status: 200 } })).toBe(found)
    expect(boundaryFromMessageResponse({ error: { message: "missing" }, response: { status: 404 } })).toBeUndefined()
    expect(() => boundaryFromMessageResponse({ error: new Error("server failed"), response: { status: 500 } })).toThrow(
      "server failed",
    )
    expect(() => boundaryFromMessageResponse({ error: new Error("network failed") })).toThrow("network failed")
    expect(() => boundaryFromMessageResponse({ response: { status: 200 } })).toThrow("missing revert boundary message")
  })
})
