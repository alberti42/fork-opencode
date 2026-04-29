import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { linkParam, parseLinkHeader } from "../../src/util/link-header"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(SessionNs.defaultLayer)
const model = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test"),
}
const password = process.env.OPENCODE_SERVER_PASSWORD
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
const auth = password ? "Basic " + Buffer.from(`${username}:${password}`).toString("base64") : undefined

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

const sessionScoped = Effect.acquireRelease(
  SessionNs.Service.use((svc) => svc.create({})),
  (session) => SessionNs.Service.use((svc) => svc.remove(session.id)).pipe(Effect.ignore),
)

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionIDType,
  count: number,
  time = (i: number) => Date.now() + i,
) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID,
          role: "user",
          time: { created: time(i) },
          agent: "test",
          model,
          tools: {},
        } satisfies MessageV2.User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: `m${i}`,
        } satisfies MessageV2.TextPart)
        return id
      }),
  )
})

function request(path: string) {
  return Effect.gen(function* () {
    const tmp = yield* TestInstance
    return yield* Effect.promise(() =>
      Promise.resolve(
        Server.Default().app.request(path, {
          headers: {
            "x-opencode-directory": tmp.directory,
            ...(auth ? { Authorization: auth } : {}),
          },
        }),
      ),
    )
  })
}

function requestPost(path: string, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const tmp = yield* TestInstance
    return yield* Effect.promise(() =>
      Promise.resolve(
        Server.Default().app.request(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-directory": tmp.directory,
            ...(auth ? { Authorization: auth } : {}),
          },
          body: JSON.stringify(body),
        }),
      ),
    )
  })
}

function json<T>(response: Response) {
  return Effect.promise(() => response.json() as Promise<T>)
}

describe("session messages endpoint", () => {
  it.instance(
    "returns Link header with rel=prev for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        expect((yield* json<MessageV2.WithParts[]>(a)).map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.headers.get("x-next-cursor")).toBeNull()
        const links = parseLinkHeader(a.headers.get("link") ?? "")
        expect(links.prev).toBeDefined()
        const before = linkParam(links.prev, "before")
        expect(before).toBeTruthy()

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(before!)}`)
        expect(b.status).toBe(200)
        expect((yield* json<MessageV2.WithParts[]>(b)).map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps full-history responses when limit is omitted",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 3)

        const res = yield* request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        expect((yield* json<MessageV2.WithParts[]>(res)).map((item) => item.info.id)).toEqual(ids)

        const explicitFalse = yield* request(`/session/${session.id}/message?oldest=false`)
        expect(explicitFalse.status).toBe(200)
        expect((yield* json<MessageV2.WithParts[]>(explicitFalse)).map((item) => item.info.id)).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects invalid cursors and missing sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const bad = yield* request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = yield* request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not truncate large legacy limit requests",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 520)

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        expect(yield* json<MessageV2.WithParts[]>(res)).toHaveLength(510)
      }),
    ),
    { git: true },
  )

  it.instance(
    "accepts directory query used by workspace routing",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        yield* fill(session.id, 1)

        const res = yield* request(
          `/session/${session.id}/message?limit=80&directory=${encodeURIComponent(tmp.directory)}`,
        )
        expect(res.status).toBe(200)
        const body = yield* json<unknown[]>(res)
        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(1)
      }),
    ),
    { git: true },
  )
})

describe("session.messages API", () => {
  it.instance(
    "returns 400 when both before and after specified",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 3)
        const first = yield* request(`/session/${session.id}/message?limit=1`)
        const cur = linkParam(parseLinkHeader(first.headers.get("Link") ?? "").prev, "before")

        const response = yield* request(`/session/${session.id}/message?before=${cur}&after=${cur}&limit=2`)

        expect(response.status).toBe(400)
      }),
    ),
    { git: true },
  )

  it.instance(
    "includes Link header with rel=prev when more pages exist (latest page)",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 5)

        const response = yield* request(`/session/${session.id}/message?limit=2`)

        expect(response.status).toBe(200)
        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.prev).toBeDefined()
        expect(linkParam(links.prev, "before")).toBeTruthy()
        expect(links.next).toBeUndefined()
      }),
    ),
    { git: true },
  )

  it.instance(
    "strips query auth credentials from pagination Link headers",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 3)

        const response = yield* request(`/session/${session.id}/message?limit=1&auth_token=secret-token`)

        expect(response.status).toBe(200)
        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.prev).toBeDefined()
        expect(linkParam(links.prev, "auth_token")).toBeUndefined()
        expect(links.prev).not.toContain("secret-token")
      }),
    ),
    { git: true },
  )

  it.instance(
    "before cursor returns older page and exposes rel=next",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const latest = yield* request(`/session/${session.id}/message?limit=2`)
        const before = linkParam(parseLinkHeader(latest.headers.get("Link") ?? "").prev, "before")

        const response = yield* request(`/session/${session.id}/message?before=${before}&limit=2`)
        expect(response.status).toBe(200)
        expect((yield* json<Array<{ info: { id: string } }>>(response)).map((item) => item.info.id)).toEqual([
          ids[1],
          ids[2],
        ])

        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.prev).toBeDefined()
        expect(links.next).toBeDefined()
        expect(linkParam(links.prev, "before")).toBeTruthy()
        expect(linkParam(links.next, "after")).toBeTruthy()
      }),
    ),
    { git: true },
  )

  it.instance(
    "oldest=true returns messages in ascending order with rel=next Link",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const response = yield* request(`/session/${session.id}/message?oldest=true&limit=2`)

        expect(response.status).toBe(200)
        expect((yield* json<Array<{ info: { id: string } }>>(response)).map((item) => item.info.id)).toEqual([
          ids[0],
          ids[1],
        ])
        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.next).toBeDefined()
        expect(linkParam(links.next, "after")).toBeTruthy()
      }),
    ),
    { git: true },
  )

  it.instance(
    "after cursor returns newer page and exposes rel=prev",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const oldest = yield* request(`/session/${session.id}/message?oldest=true&limit=2`)
        const after = linkParam(parseLinkHeader(oldest.headers.get("Link") ?? "").next, "after")

        const response = yield* request(`/session/${session.id}/message?after=${after}&limit=2`)
        expect(response.status).toBe(200)
        expect((yield* json<Array<{ info: { id: string } }>>(response)).map((item) => item.info.id)).toEqual([
          ids[2],
          ids[3],
        ])

        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.prev).toBeDefined()
        expect(links.next).toBeDefined()
        expect(linkParam(links.prev, "before")).toBeTruthy()
        expect(linkParam(links.next, "after")).toBeTruthy()
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns 400 for invalid cursor",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const response = yield* request(`/session/${session.id}/message?before=invalid&limit=2`)
        expect(response.status).toBe(400)
      }),
    ),
    { git: true },
  )

  it.instance(
    "single message responses include server-generated cursor",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const [messageID] = yield* fill(session.id, 1)

        const response = yield* request(`/session/${session.id}/message/${messageID}`)
        expect(response.status).toBe(200)
        expect((yield* json<MessageV2.WithParts>(response)).cursor).toBeTruthy()
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns 400 when oldest used with before or after",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 3)
        const first = yield* request(`/session/${session.id}/message?limit=1`)
        const cur = linkParam(parseLinkHeader(first.headers.get("Link") ?? "").prev, "before")

        expect((yield* request(`/session/${session.id}/message?oldest=true&before=${cur}&limit=2`)).status).toBe(400)
        expect((yield* request(`/session/${session.id}/message?oldest=true&after=${cur}&limit=2`)).status).toBe(400)
      }),
    ),
    { git: true },
  )

  it.instance(
    "limit=0 returns empty results",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 3)

        const response = yield* request(`/session/${session.id}/message?limit=0`)
        expect(response.status).toBe(200)
        expect(yield* json<unknown[]>(response)).toEqual([])
        expect(response.headers.get("Link")).toBeNull()
      }),
    ),
    { git: true },
  )

  it.instance(
    "limit=0 still validates session existence",
    withoutWatcher(
      Effect.gen(function* () {
        const response = yield* request(`/session/${SessionID.descending()}/message?limit=0`)
        expect(response.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "revert preview returns all reverted user messages and next restore boundary",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        expect((yield* requestPost(`/session/${session.id}/revert`, { messageID: ids[1] })).status).toBe(200)

        const preview = yield* request(`/session/${session.id}/revert`)
        expect(preview.status).toBe(200)
        const body = yield* json<{ userCount: number; nextMessageID?: string; items: { id: string; text: string }[] }>(
          preview,
        )

        expect(body.userCount).toBe(4)
        expect(body.nextMessageID).toBe(ids[2])
        expect(body.items).toEqual([
          { id: ids[1], text: "m1" },
          { id: ids[2], text: "m2" },
          { id: ids[3], text: "m3" },
          { id: ids[4], text: "m4" },
        ])
      }),
    ),
    { git: true },
  )

  it.instance(
    "revert preview disables stepwise redo for part-level reverts",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const svc = yield* SessionNs.Service
        const [userID] = yield* fill(session.id, 1)
        const assistantID = MessageID.ascending()
        yield* svc.updateMessage({
          id: assistantID,
          sessionID: session.id,
          role: "assistant",
          time: { created: Date.now() + 10 },
          parentID: userID,
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          mode: "",
          agent: "default",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies MessageV2.Assistant)
        const firstPartID = PartID.ascending()
        const secondPartID = PartID.ascending()
        yield* svc.updatePart({
          id: firstPartID,
          sessionID: session.id,
          messageID: assistantID,
          type: "text",
          text: "first",
        } satisfies MessageV2.TextPart)
        yield* svc.updatePart({
          id: secondPartID,
          sessionID: session.id,
          messageID: assistantID,
          type: "text",
          text: "second",
        } satisfies MessageV2.TextPart)

        expect(
          (yield* requestPost(`/session/${session.id}/revert`, { messageID: assistantID, partID: secondPartID }))
            .status,
        ).toBe(200)

        const preview = yield* request(`/session/${session.id}/revert`)
        expect(preview.status).toBe(200)
        const body = yield* json<{
          userCount: number
          nextMessageID?: string
          partID?: string
          items: { id: string; text: string }[]
        }>(preview)

        expect(body.userCount).toBe(0)
        expect(body.partID).toBe(secondPartID)
        expect(body.nextMessageID).toBeUndefined()
        expect(body.items).toEqual([{ id: assistantID, text: "first\n\nsecond" }])
      }),
    ),
    { git: true },
  )
})
