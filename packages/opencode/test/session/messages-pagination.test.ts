import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Session as SessionNs } from "../../src/session"
import type { MessageID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  messages(input: { sessionID: SessionID; limit?: number }) {
    return run(SessionNs.Service.use((svc) => svc.messages(input)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  removeMessage(input: { sessionID: SessionID; messageID: MessageID }) {
    return run(SessionNs.Service.use((svc) => svc.removeMessage(input)))
  },
}

const TEST_TIMEOUT_MS = 30_000

async function withTmp(fn: (dir: string) => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: () => fn(tmp.path),
    })
  } finally {
    await Instance.disposeAll()
  }
}

describe("session messages", () => {
  test(
    "MessageV2.page supports backward and forward opaque cursor pagination",
    async () => {
      await withTmp(async () => {
        const session = await svc.create({})
        const sessionID = session.id
        const ids: any[] = []

        for (let i = 0; i < 6; i++) {
          const msg = await svc.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID,
            agent: "default",
            model: { providerID: "openai", modelID: "gpt-4" },
            time: { created: Date.now() + i },
          } as any)
          ids.push(msg.id)
        }

        const latest = await MessageV2.page({ sessionID: sessionID as any, limit: 2 })
        expect(latest.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(latest.before).toBeTruthy()
        expect(latest.after).toBeUndefined()

        const older = await MessageV2.page({ sessionID: sessionID as any, limit: 2, before: latest.before })
        expect(older.items.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
        expect(older.before).toBeTruthy()
        expect(older.after).toBeTruthy()

        const oldest = await MessageV2.page({ sessionID: sessionID as any, limit: 2, oldest: true })
        expect(oldest.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(oldest.before).toBeUndefined()
        expect(oldest.after).toBeTruthy()

        const newer = await MessageV2.page({ sessionID: sessionID as any, limit: 2, after: oldest.after })
        expect(newer.items.map((item) => item.info.id)).toEqual(ids.slice(2, 4))
        expect(newer.before).toBeTruthy()
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "MessageV2.page breaks same-timestamp ties by message id",
    async () => {
      await withTmp(async () => {
        const session = await svc.create({})
        const sessionID = session.id
        const ids: any[] = []
        const time = Date.now()

        for (let i = 0; i < 3; i++) {
          const msg = await svc.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID,
            agent: "default",
            model: { providerID: "openai", modelID: "gpt-4" },
            time: { created: time },
          } as any)
          ids.push(msg.id)
        }

        const page = await MessageV2.page({ sessionID: sessionID as any, limit: 3, oldest: true })
        expect(page.items.map((item) => item.info.id)).toEqual(ids)
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "MessageV2.page preserves fractional timestamp ordering across cursors",
    async () => {
      await withTmp(async () => {
        const session = await svc.create({})
        const sessionID = session.id
        const ids: any[] = []
        const times = [1000.1, 1000.2, 1000.3, 1000.4]

        for (const time of times) {
          const msg = await svc.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID,
            agent: "default",
            model: { providerID: "openai", modelID: "gpt-4" },
            time: { created: time },
          } as any)
          ids.push(msg.id)
        }

        const latest = await MessageV2.page({ sessionID: sessionID as any, limit: 2 })
        expect(latest.items.map((item) => item.info.id)).toEqual(ids.slice(-2))

        const older = await MessageV2.page({ sessionID: sessionID as any, limit: 2, before: latest.before })
        expect(older.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "keeps newest-first limit behavior",
    async () => {
      await withTmp(async () => {
        const session = await svc.create({})
        const sessionID = session.id
        const ids: any[] = []

        for (let i = 0; i < 6; i++) {
          const msg = await svc.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID,
            agent: "default",
            model: { providerID: "openai", modelID: "gpt-4" },
            time: { created: Date.now() + i },
          } as any)
          ids.push(msg.id)
        }

        const page = await svc.messages({ sessionID, limit: 3 })
        expect(page.map((item) => item.info.id)).toEqual(ids.slice(-3))
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "reflects deletions between reads",
    async () => {
      await withTmp(async () => {
        const session = await svc.create({})
        const sessionID = session.id
        const ids: any[] = []

        for (let i = 0; i < 5; i++) {
          const msg = await svc.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID,
            agent: "default",
            model: { providerID: "openai", modelID: "gpt-4" },
            time: { created: Date.now() + i },
          } as any)
          ids.push(msg.id)
        }

        await svc.removeMessage({ sessionID, messageID: ids[2] as any })

        const items = await svc.messages({ sessionID })
        expect(items.map((item) => item.info.id)).toEqual([ids[0], ids[1], ids[3], ids[4]])
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "message ids remain lexicographically sorted",
    async () => {
      await withTmp(async () => {
        const session = await svc.create({})
        const ids: any[] = []

        for (let i = 0; i < 5; i++) {
          const msg = await svc.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            agent: "default",
            model: { providerID: "openai", modelID: "gpt-4" },
            time: { created: Date.now() + i },
          } as any)
          ids.push(msg.id)
        }

        for (let i = 1; i < ids.length; i++) {
          expect(ids[i] > ids[i - 1]).toBe(true)
        }
      })
    },
    TEST_TIMEOUT_MS,
  )
})
