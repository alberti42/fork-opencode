import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { boundaryFromMessageResponse, hasVisibleUserBeforeRevert, loadRevertAwareLatestPage } from "./revert-page"

const message = (id: string, role: Message["role"]): Message =>
  role === "assistant"
    ? ({
        id,
        sessionID: "ses_1",
        role: "assistant",
        agent: "default",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Number(id.slice(2)) },
      } as unknown as Message)
    : ({
        id,
        sessionID: "ses_1",
        role: "user",
        agent: "default",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Number(id.slice(2)) },
      } as unknown as Message)

const textPart = (id: string, messageID: string): Extract<Part, { type: "text" }> => ({
  id,
  sessionID: "ses_1",
  messageID,
  type: "text",
  text: id,
})

describe("revert page helpers", () => {
  test("only treats 404 boundary fetch responses as missing boundaries", () => {
    const found = { info: message("m6", "user"), parts: [textPart("p6", "m6")], cursor: "boundary" }
    expect(boundaryFromMessageResponse({ data: found, error: undefined, response: { status: 200 } })).toBe(found)
    expect(
      boundaryFromMessageResponse({ data: undefined, error: { message: "missing" }, response: { status: 404 } }),
    ).toBeUndefined()
    expect(() =>
      boundaryFromMessageResponse({ data: undefined, error: new Error("server failed"), response: { status: 500 } }),
    ).toThrow("server failed")
    expect(() => boundaryFromMessageResponse({ data: undefined, error: new Error("network failed") })).toThrow(
      "network failed",
    )
    expect(() => boundaryFromMessageResponse({ data: undefined, error: undefined, response: { status: 200 } })).toThrow(
      "missing revert boundary message",
    )
  })

  test("detects when the loaded page has no visible user before revert", () => {
    expect(hasVisibleUserBeforeRevert([message("m6", "user"), message("m7", "assistant")], "m6")).toBe(false)
    expect(hasVisibleUserBeforeRevert([message("m5", "user"), message("m6", "user")], "m6")).toBe(true)
  })

  test("loads and merges an older boundary window when latest page is fully reverted", async () => {
    const olderPart = textPart("p5", "m5")
    const boundaryPart = textPart("p6", "m6")

    const result = await loadRevertAwareLatestPage({
      current: {
        session: [message("m6", "user"), message("m7", "assistant"), message("m8", "user")],
        part: [
          { id: "m6", part: [boundaryPart] },
          { id: "m7", part: [] },
          { id: "m8", part: [] },
        ],
        cursor: undefined,
        complete: true,
      },
      revertMessageID: "m6",
      fetchMessage: async () => ({ info: message("m6", "user"), parts: [boundaryPart], cursor: "boundary" }),
      fetchPage: async (before) => {
        expect(before).toBe("boundary")
        return {
          session: [message("m4", "assistant"), message("m5", "user")],
          part: [
            { id: "m4", part: [] },
            { id: "m5", part: [olderPart] },
          ],
          cursor: "older",
          complete: false,
        }
      },
    })

    expect(result.session.map((item) => item.id)).toEqual(["m4", "m5", "m6", "m7", "m8"])
    expect(result.part.find((item) => item.id === "m5")?.part).toEqual([olderPart])
    expect(result.part.find((item) => item.id === "m6")?.part).toEqual([boundaryPart])
    expect(result.cursor).toBe("older")
    expect(result.complete).toBe(false)
  })

  test("keeps loading older pages until a visible user exists before revert", async () => {
    const boundaryPart = textPart("p6", "m6")
    const olderPart = textPart("p3", "m3")
    let call = 0

    const result = await loadRevertAwareLatestPage({
      current: {
        session: [message("m6", "user"), message("m7", "assistant"), message("m8", "user")],
        part: [
          { id: "m6", part: [boundaryPart] },
          { id: "m7", part: [] },
          { id: "m8", part: [] },
        ],
        cursor: undefined,
        complete: true,
      },
      revertMessageID: "m6",
      fetchMessage: async () => ({ info: message("m6", "user"), parts: [boundaryPart], cursor: "boundary" }),
      fetchPage: async () => {
        call += 1
        if (call === 1) {
          return {
            session: [message("m4", "assistant"), message("m5", "assistant")],
            part: [
              { id: "m4", part: [] },
              { id: "m5", part: [] },
            ],
            cursor: "older-2",
            complete: false,
          }
        }
        return {
          session: [message("m3", "user")],
          part: [{ id: "m3", part: [olderPart] }],
          cursor: undefined,
          complete: true,
        }
      },
    })

    expect(call).toBe(2)
    expect(result.session.map((item) => item.id)).toEqual(["m3", "m4", "m5", "m6", "m7", "m8"])
    expect(result.part.find((item) => item.id === "m3")?.part).toEqual([olderPart])
    expect(result.cursor).toBeUndefined()
    expect(result.complete).toBe(true)
  })

  test("marks stale revert boundaries for clearing when the boundary message is missing", async () => {
    const result = await loadRevertAwareLatestPage({
      current: {
        session: [message("m7", "assistant"), message("m8", "user")],
        part: [
          { id: "m7", part: [] },
          { id: "m8", part: [] },
        ],
        cursor: undefined,
        complete: true,
      },
      revertMessageID: "m6",
      fetchMessage: async () => undefined,
      fetchPage: async () => ({
        session: [],
        part: [],
        cursor: undefined,
        complete: true,
      }),
    })

    expect(result.clearedRevert).toBe(true)
    expect(result.session.map((item) => item.id)).toEqual(["m7", "m8"])
  })
})
