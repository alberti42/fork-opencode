import type { Message, Part } from "@opencode-ai/sdk/v2/client"

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
  clearedRevert?: boolean
}

type MessageWithParts = {
  info: Message
  parts: Part[]
  cursor?: string
}

export function boundaryFromMessageResponse(input: {
  data?: MessageWithParts
  error?: unknown
  response?: { status: number }
}): MessageWithParts | undefined {
  if (input.response?.status === 404) return undefined
  if (input.error) {
    throw input.error
  }
  if (!input.data?.info?.id) throw new Error("missing revert boundary message")
  return input.data
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export const compareMessages = (a: Message, b: Message) => a.time.created - b.time.created || cmp(a.id, b.id)
export const messageBefore = (message: Message, boundary: Message) => compareMessages(message, boundary) < 0

const sortParts = (parts: Part[]) => parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))

export function hasVisibleUserBeforeRevert(messages: Message[], revertMessageID?: string, boundary?: Message) {
  if (!revertMessageID) return true
  const revert = boundary ?? messages.find((message) => message.id === revertMessageID)
  if (!revert) return messages.some((message) => message.role === "user" && message.id < revertMessageID)
  return messages.some((message) => message.role === "user" && messageBefore(message, revert))
}

function mergeMessages(current: Message[], older: Message[], boundary: Message) {
  const merged = new Map(current.filter((message) => !!message?.id).map((message) => [message.id, message] as const))
  for (const message of older) {
    if (!message?.id) continue
    merged.set(message.id, message)
  }
  merged.set(boundary.id, boundary)
  return [...merged.values()].sort(compareMessages)
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
  if (!input.revertMessageID) return input.current

  const boundary = await input.fetchMessage(input.revertMessageID)
  if (!boundary) return { ...input.current, clearedRevert: true }
  if (hasVisibleUserBeforeRevert(input.current.session, input.revertMessageID, boundary.info)) return input.current
  if (!boundary.cursor) return input.current

  let older = await input.fetchPage(boundary.cursor)
  let session = mergeMessages(input.current.session, older.session, boundary.info)
  let part = mergeParts(input.current.part, older.part, boundary)
  while (!hasVisibleUserBeforeRevert(session, input.revertMessageID) && older.cursor) {
    older = await input.fetchPage(older.cursor)
    session = mergeMessages(session, older.session, boundary.info)
    part = mergeParts(part, older.part, boundary)
  }
  return {
    session,
    part,
    cursor: older.cursor,
    complete: older.complete,
  }
}
