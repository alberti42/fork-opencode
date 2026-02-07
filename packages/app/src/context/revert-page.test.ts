import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { hasVisibleUserBeforeRevert, loadRevertAwareLatestPage } from "./revert-page"

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
      fetchMessage: async () => ({ info: message("m6", "user"), parts: [boundaryPart] }),
      fetchPage: async () => ({
        session: [message("m4", "assistant"), message("m5", "user")],
        part: [
          { id: "m4", part: [] },
          { id: "m5", part: [olderPart] },
        ],
        cursor: "older",
        complete: false,
      }),
    })

    expect(result.session.map((item) => item.id)).toEqual(["m4", "m5", "m6", "m7", "m8"])
    expect(result.part.find((item) => item.id === "m5")?.part).toEqual([olderPart])
    expect(result.part.find((item) => item.id === "m6")?.part).toEqual([boundaryPart])
    expect(result.cursor).toBe("older")
    expect(result.complete).toBe(false)
  })
})
