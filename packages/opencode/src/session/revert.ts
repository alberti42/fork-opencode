import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "../bus"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "../sync"
import * as Log from "@opencode-ai/core/util/log"
import { optionalOmitUndefined } from "@opencode-ai/core/schema"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

const log = Log.create({ service: "session.revert" })

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export const PreviewItem = Schema.Struct({
  id: MessageID,
  text: Schema.String,
})
export type PreviewItem = Schema.Schema.Type<typeof PreviewItem>

export const Preview = Schema.Struct({
  userCount: Schema.Number,
  nextMessageID: optionalOmitUndefined(MessageID),
  partID: optionalOmitUndefined(PartID),
  items: Schema.Array(PreviewItem),
})
export type Preview = Schema.Schema.Type<typeof Preview>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
  readonly preview: (input: { sessionID: SessionID }) => Effect.Effect<Preview | undefined, Session.NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const sync = yield* SyncEvent.Service

    const previewText = (message: MessageV2.WithParts) => {
      const text = message.parts
        .flatMap((part) => (part.type === "text" && !part.synthetic && part.text.trim() ? [part.text.trim()] : []))
        .join("\n\n")
      if (text) return text
      const attachments = message.parts.flatMap((part) => (part.type === "file" ? [part.filename] : []))
      if (attachments.length === 0) return ""
      return attachments.map((name) => `[attachment:${name}]`).join(" ")
    }

    const messageAtOrAfter = (message: MessageV2.WithParts, boundary: MessageV2.WithParts) =>
      message.info.time.created > boundary.info.time.created ||
      (message.info.time.created === boundary.info.time.created && message.info.id >= boundary.info.id)
    const messageBefore = (message: MessageV2.WithParts, boundary: MessageV2.WithParts) =>
      message.info.time.created < boundary.info.time.created ||
      (message.info.time.created === boundary.info.time.created && message.info.id < boundary.info.id)
    const revertedUser = (message: MessageV2.WithParts, boundary: MessageV2.WithParts) =>
      message.info.role === "user" && messageAtOrAfter(message, boundary)

    const preview = Effect.fn("SessionRevert.preview")(function* (input: { sessionID: SessionID }) {
      const session = yield* sessions.get(input.sessionID)
      if (!session.revert) return undefined
      const messages = yield* sessions.messages({ sessionID: input.sessionID })
      const boundary = messages.find((message) => message.info.id === session.revert!.messageID)
      if (!boundary) return undefined
      if (session.revert.partID) {
        return {
          userCount: messages.filter((message) => revertedUser(message, boundary)).length,
          nextMessageID: undefined,
          partID: session.revert.partID,
          items: [
            {
              id: boundary.info.id,
              text: previewText(boundary),
            },
          ],
        }
      }
      const items = messages
        .filter((message) => revertedUser(message, boundary))
        .map((message) => ({
          id: message.info.id,
          text: previewText(message),
        }))
      return {
        userCount: items.length,
        nextMessageID: items[1]?.id,
        partID: undefined,
        items,
      }
    })

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      let lastUser: MessageV2.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      const boundary = all.find((msg) => msg.info.id === rev.messageID)
      const range = boundary ? all.filter((msg) => messageAtOrAfter(msg, boundary)) : []
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const boundary = msgs.find((msg) => msg.info.id === messageID)
      if (!boundary) {
        yield* sessions.clearRevert(sessionID)
        return
      }
      const remove = [] as MessageV2.WithParts[]
      let target: MessageV2.WithParts | undefined
      for (const msg of msgs) {
        if (messageBefore(msg, boundary)) continue
        if (msg.info.id !== messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
        yield* sync.run(MessageV2.Event.Removed, {
          sessionID,
          messageID: msg.info.id,
        })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sync.run(MessageV2.Event.PartRemoved, {
              sessionID,
              messageID: target.info.id,
              partID: part.id,
            })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup, preview })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
