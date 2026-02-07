import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/shared/util/encode"

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

type MessageWithParts = {
  info: Message
  parts: Part[]
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const sortParts = (parts: Part[]) => parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))

export function hasVisibleUserBeforeRevert(messages: Message[], revertMessageID?: string) {
  if (!revertMessageID) return true
  return messages.some((message) => message.role === "user" && message.id < revertMessageID)
}

function cursor(message: Pick<Message, "id" | "time">) {
  return base64Encode(JSON.stringify({ id: message.id, time: message.time.created }))
}

function mergeMessages(current: Message[], older: Message[], boundary: Message) {
  const merged = new Map(current.filter((message) => !!message?.id).map((message) => [message.id, message] as const))
  for (const message of older) {
    if (!message?.id) continue
    merged.set(message.id, message)
  }
  merged.set(boundary.id, boundary)
  return [...merged.values()].sort((a, b) => cmp(a.id, b.id))
}

function mergeParts(current: MessagePage["part"], older: MessagePage["part"], boundary: MessageWithParts) {
  const merged = new Map(current.filter((item) => !!item?.id).map((item) => [item.id, sortParts(item.part)] as const))
  for (const item of older) {
    if (!item?.id) continue
    merged.set(item.id, sortParts(item.part))
  }
  merged.set(boundary.info.id, sortParts(boundary.parts))
  return [...merged.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part }))
}

export async function loadRevertAwareLatestPage(input: {
  current: MessagePage
  revertMessageID?: string
  fetchMessage: (messageID: string) => Promise<MessageWithParts | undefined>
  fetchPage: (before: string) => Promise<MessagePage>
}) {
  if (hasVisibleUserBeforeRevert(input.current.session, input.revertMessageID)) return input.current
  if (!input.revertMessageID) return input.current

  const boundary = await input.fetchMessage(input.revertMessageID)
  if (!boundary) return input.current

  const older = await input.fetchPage(cursor(boundary.info))
  return {
    session: mergeMessages(input.current.session, older.session, boundary.info),
    part: mergeParts(input.current.part, older.part, boundary),
    cursor: older.cursor,
    complete: older.complete,
  }
}
