import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/core/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import * as Log from "@opencode-ai/core/util/log"
import { emptyConsoleState, type ConsoleState } from "@/config/console-state"
import path from "path"
import { useKV } from "./kv"
import { aggregateFailures } from "./aggregate-failures"
import { linkParam, parseLinkHeader } from "@/util/link-header"
import { boundaryFromMessageResponse } from "../util/revert-boundary"
import {
  evictFromEnd,
  evictFromStart,
  hasUserBeforeBoundary,
  messageBefore,
  messageInsert,
  paginationError,
  windowNewest,
  windowOldest,
} from "@tui/util/pagination"

/** Maximum messages kept in memory per session */
const MAX_LOADED_MESSAGES = 500

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      message_page: {
        [sessionID: string]: {
          hasOlder: boolean
          hasNewer: boolean
          loading: boolean
          loadingDirection?: "older" | "newer"
          oldest?: string
          newest?: string
          olderCursor?: string
          newerCursor?: string
          error?: string
        }
      }
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      message_cursor: {
        [messageID: string]: string | undefined
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      message_page: {},
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      message_cursor: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const kv = useKV()

    const getRevertMarker = (sessionID: string) => {
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (!match.found) return undefined
      return store.session[match.index].revert?.messageID
    }

    const pageInfo = (link: string) => {
      const links = parseLinkHeader(link)
      return {
        hasOlder: links.prev !== undefined,
        hasNewer: links.next !== undefined,
        olderCursor: linkParam(links.prev, "before"),
        newerCursor: linkParam(links.next, "after"),
      }
    }

    const edgeCursor = (cursors: Record<string, string | undefined>, id: string | undefined) =>
      id ? cursors[id] : undefined

    const clearRevert = (sessionID: string) => {
      setStore(
        "session",
        produce((draft) => {
          const match = Binary.search(draft, sessionID, (s) => s.id)
          if (!match.found) return
          draft[match.index] = { ...draft[match.index], revert: undefined }
        }),
      )
    }

    const messageIndex = (messages: Message[] | undefined, id: string) =>
      messages?.findIndex((item) => item.id === id) ?? -1

    type LoadedMessage = {
      info: Message
      parts: Part[]
      cursor?: string
    }

    type LoadedPage = ReturnType<typeof pageInfo> & {
      items: LoadedMessage[]
      oldest?: string
      newest?: string
      clearedRevert?: boolean
    }

    const insertLoadedMessage = (items: LoadedMessage[], message: LoadedMessage) => {
      const result = messageInsert(
        items.map((item) => item.info),
        message.info,
      )
      if (!result.found) items.splice(result.index, 0, message)
    }

    const loadLatestPage = async (sessionID: string, revertMessageID?: string): Promise<LoadedPage> => {
      const latest = await sdk.client.session.messages({ sessionID, limit: 100 }, { throwOnError: true })
      const latestItems = [...(latest.data ?? [])]
      const latestPage = pageInfo(latest.response.headers.get("link") ?? "")
      const latestOldest = latestItems.at(0)?.info.id
      const latestNewest = latestItems.at(-1)?.info.id
      if (!revertMessageID) {
        return {
          items: latestItems,
          oldest: latestOldest,
          newest: latestNewest,
          ...latestPage,
        }
      }

      try {
        const revert = await sdk.client.session.message(
          { sessionID, messageID: revertMessageID },
          { throwOnError: false },
        )
        const boundary = boundaryFromMessageResponse(revert)
        if (!boundary) {
          clearRevert(sessionID)
          return {
            items: latestItems,
            oldest: latestOldest,
            newest: latestNewest,
            clearedRevert: true,
            ...latestPage,
          }
        }

        if (
          hasUserBeforeBoundary(
            latestItems.map((item) => item.info),
            boundary.info,
          )
        ) {
          insertLoadedMessage(latestItems, boundary)
          return {
            items: latestItems,
            oldest: latestItems.at(0)?.info.id,
            newest: latestNewest ?? latestItems.at(-1)?.info.id,
            ...latestPage,
            hasNewer: false,
            newerCursor: undefined,
          }
        }

        let olderCursor = boundary.cursor
        if (!olderCursor)
          return {
            items: latestItems,
            oldest: latestOldest,
            newest: latestNewest,
            ...latestPage,
          }
        let olderPage = latestPage
        let oldestLoaded = boundary.info.id
        do {
          const older = await sdk.client.session.messages(
            {
              sessionID,
              before: olderCursor,
              limit: 100,
            },
            { throwOnError: true },
          )
          const olderItems = older.data ?? []
          olderPage = pageInfo(older.response.headers.get("link") ?? "")
          oldestLoaded = olderItems.at(0)?.info.id ?? oldestLoaded
          for (const message of olderItems) {
            insertLoadedMessage(latestItems, message)
          }
          olderCursor = olderPage.olderCursor ?? ""
        } while (
          olderCursor &&
          !hasUserBeforeBoundary(
            latestItems.map((item) => item.info),
            boundary.info,
          )
        )
        insertLoadedMessage(latestItems, boundary)
        return {
          items: latestItems,
          hasOlder: olderPage.hasOlder,
          hasNewer: false,
          olderCursor: olderPage.olderCursor,
          newerCursor: undefined,
          oldest: oldestLoaded,
          newest: latestNewest ?? latestItems.at(-1)?.info.id,
        }
      } catch (e) {
        Log.Default.info("Revert marker fetch failed during latest-page load", {
          messageID: revertMessageID,
          error: e,
        })
        throw e
      }
    }

    const fullSyncedSessions = new Set<string>()
    const loadingGuard = new Set<string>()
    const pendingLatest = new Set<string>()
    let syncEpoch = 0

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    event.subscribe((event, { workspace }) => {
      switch (event.type) {
        case "server.instance.disposed":
          const synced = [...fullSyncedSessions]
          syncEpoch += 1
          fullSyncedSessions.clear()
          loadingGuard.clear()
          setStore(
            produce((draft) => {
              for (const sessionID of synced) {
                for (const msg of draft.message[sessionID] ?? []) {
                  delete draft.part[msg.id]
                  delete draft.message_cursor[msg.id]
                }
                delete draft.message[sessionID]
                delete draft.message_page[sessionID]
                delete draft.todo[sessionID]
                delete draft.session_diff[sessionID]
              }
            }),
          )
          void bootstrap().then(() => Promise.allSettled(synced.map((sessionID) => result.session.sync(sessionID))))
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const info = event.properties.info
          const match = Binary.search(store.session, info.id, (s) => s.id)
          const previous = match.found ? store.session[match.index] : undefined
          const revertChanged =
            previous?.revert?.messageID !== info.revert?.messageID || previous?.revert?.partID !== info.revert?.partID
          if (match.found) {
            setStore("session", match.index, reconcile(info))
            if (revertChanged && store.message[info.id]) {
              void result.session.jumpToLatest(info.id, { force: true })
            }
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(match.index, 0, info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const sessionID = event.properties.info.sessionID
          const page = store.message_page[sessionID]
          const messages = store.message[sessionID]
          const pinned = getRevertMarker(sessionID)
          if (!messages) {
            setStore("message", sessionID, [event.properties.info])
            break
          }
          const current = messageIndex(messages, event.properties.info.id)
          if (current !== -1) {
            setStore("message", sessionID, current, reconcile(event.properties.info))
            break
          }
          const loadingNewer = page?.loading && page.loadingDirection === "newer"
          const loadingOlder = page?.loading && page.loadingDirection === "older"
          if (page?.hasNewer && !loadingNewer) {
            break
          }
          const oldest = page?.oldest ? messages.find((item) => item.id === page.oldest) : undefined
          if (oldest && messageBefore(event.properties.info, oldest) && !loadingOlder) {
            break
          }
          const result = messageInsert(messages, event.properties.info)
          const preview = [...messages]
          preview.splice(result.index, 0, event.properties.info)
          setStore(
            "message",
            sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          if (page) {
            const nextOldest = windowOldest(preview, pinned) ?? page.oldest
            const nextNewest = windowNewest(preview, pinned) ?? page.newest
            setStore("message_page", event.properties.info.sessionID, {
              ...page,
              newest: nextNewest,
              oldest: nextOldest,
            })
          }
          if (preview.length > MAX_LOADED_MESSAGES) {
            const evictCount = preview.length - MAX_LOADED_MESSAGES
            const trimmed = [...preview]
            const evicted = evictFromStart(trimmed, evictCount, pinned)
            const nextOldest = windowOldest(trimmed, pinned) ?? page?.oldest
            const nextNewest = windowNewest(trimmed, pinned) ?? page?.newest
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  evictFromStart(draft, evictCount, pinned)
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  for (const msg of evicted) {
                    delete draft[msg.id]
                  }
                }),
              )
              setStore(
                "message_cursor",
                produce((draft) => {
                  for (const msg of evicted) {
                    delete draft[msg.id]
                  }
                }),
              )
              if (page) {
                setStore("message_page", event.properties.info.sessionID, {
                  ...page,
                  hasOlder: true,
                  oldest: nextOldest,
                  newest: nextNewest,
                  olderCursor: edgeCursor(store.message_cursor, nextOldest) ?? page.olderCursor,
                })
              }
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const page = store.message_page[event.properties.sessionID]
          const pinned = getRevertMarker(event.properties.sessionID)
          const index = messageIndex(messages, event.properties.messageID)
          if (index !== -1) {
            const preview = [...messages]
            preview.splice(index, 1)
            const nextOldest = windowOldest(preview, pinned) ?? preview.at(0)?.id
            const nextNewest = windowNewest(preview, pinned) ?? preview.at(-1)?.id
            const onlyPinned = preview.length === 1 && preview[0]?.id === pinned
            setStore(
              produce((draft) => {
                draft.message[event.properties.sessionID]?.splice(index, 1)
                delete draft.part[event.properties.messageID]
                delete draft.message_cursor[event.properties.messageID]
                if (page) {
                  draft.message_page[event.properties.sessionID] = {
                    ...page,
                    oldest: nextOldest,
                    newest: nextNewest,
                    olderCursor: page.hasOlder
                      ? preview.length > 0 && !onlyPinned
                        ? edgeCursor(draft.message_cursor, nextOldest)
                        : page.olderCursor
                      : undefined,
                    newerCursor: page.hasNewer
                      ? preview.length > 0 && !onlyPinned
                        ? edgeCursor(draft.message_cursor, nextNewest)
                        : page.newerCursor
                      : undefined,
                  }
                }
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const sessionID = event.properties.part.sessionID
          const page = store.message_page[sessionID]
          const messages = store.message[sessionID]
          const messageExists = messages?.some((m) => m.id === event.properties.part.messageID)
          const loadingNewer = page?.loading && page.loadingDirection === "newer"
          if (!messageExists && !loadingNewer) {
            break
          }
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      const blockingRequests: { name: string; promise: Promise<unknown> }[] = [
        { name: "config.providers", promise: providersPromise },
        { name: "provider.list", promise: providerListPromise },
        { name: "app.agents", promise: agentsPromise },
        { name: "config.get", promise: configPromise },
        { name: "project.sync", promise: projectPromise },
        ...(args.continue ? [{ name: "session.list", promise: sessionListPromise }] : []),
      ]

      await Promise.allSettled(blockingRequests.map((r) => r.promise))
        .then((settled) => {
          // Surface every failed endpoint in one labeled message instead of
          // letting the first rejection drown its siblings as unhandled
          // rejections.
          const failure = aggregateFailures(blockingRequests.map((r, i) => ({ name: r.name, result: settled[i] })))
          if (failure) throw failure
        })
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const consoleState = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: paginationError(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            await exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (process.env.OPENCODE_FAST_BOOT) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const epoch = syncEpoch
          const [session, todo, diff] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
          ])
          if (epoch !== syncEpoch) return
          let sessionInfo = session.data!
          const page = await loadLatestPage(sessionID, sessionInfo.revert?.messageID)
          if (epoch !== syncEpoch) return
          if (page.clearedRevert) sessionInfo = { ...sessionInfo, revert: undefined }
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = sessionInfo
              if (!match.found) draft.session.splice(match.index, 0, sessionInfo)
              draft.todo[sessionID] = todo.data ?? []
              const infos: (typeof draft.message)[string] = []
              for (const message of page.items) {
                infos.push(message.info)
                draft.part[message.info.id] = message.parts
                draft.message_cursor[message.info.id] = message.cursor
              }
              draft.message[sessionID] = infos
              draft.session_diff[sessionID] = diff.data ?? []
              draft.message_page[sessionID] = {
                hasOlder: page.hasOlder,
                hasNewer: page.hasNewer,
                loading: false,
                oldest: page.oldest,
                newest: page.newest,
                olderCursor: page.olderCursor,
                newerCursor: page.newerCursor,
                error: undefined,
              }
            }),
          )
          if (epoch !== syncEpoch) return
          fullSyncedSessions.add(sessionID)
        },
        async allMessages(sessionID: string) {
          const latest = await sdk.client.session.messages({ sessionID, limit: 100 }, { throwOnError: true })
          const items = [...(latest.data ?? [])]
          let cursor = pageInfo(latest.response.headers.get("link") ?? "").olderCursor
          while (cursor) {
            const older = await sdk.client.session.messages(
              { sessionID, before: cursor, limit: 100 },
              { throwOnError: true },
            )
            items.unshift(...(older.data ?? []))
            cursor = pageInfo(older.response.headers.get("link") ?? "").olderCursor
          }
          return items
        },
        async loadOlder(sessionID: string) {
          const page = store.message_page[sessionID]
          if (page?.loading || !page?.hasOlder) return
          const cursor = page?.olderCursor
          if (!cursor) return
          if (loadingGuard.has(sessionID)) return
          loadingGuard.add(sessionID)
          const epoch = syncEpoch
          const pinned = getRevertMarker(sessionID)
          try {
            setStore("message_page", sessionID, { ...page, loading: true, loadingDirection: "older", error: undefined })

            const res = await sdk.client.session.messages(
              { sessionID, before: cursor, limit: 100 },
              { throwOnError: true },
            )
            if (epoch !== syncEpoch) return
            const info = pageInfo(res.response.headers.get("link") ?? "")
            setStore(
              produce((draft) => {
                const existing = draft.message[sessionID] ?? []
                const pageOldest = res.data?.at(0)?.info.id
                for (const msg of res.data ?? []) {
                  draft.message_cursor[msg.info.id] = msg.cursor
                  const match = messageInsert(existing, msg.info)
                  if (!match.found) {
                    existing.splice(match.index, 0, msg.info)
                    draft.part[msg.info.id] = msg.parts
                  }
                }
                const nextOldest = pageOldest ?? draft.message_page[sessionID]?.oldest
                if (existing.length > MAX_LOADED_MESSAGES) {
                  const evictCount = existing.length - MAX_LOADED_MESSAGES
                  const evicted = evictFromEnd(existing, evictCount, pinned)
                  for (const msg of evicted) {
                    delete draft.part[msg.id]
                    delete draft.message_cursor[msg.id]
                  }
                  const nextNewest = windowNewest(existing, pinned) ?? draft.message_page[sessionID]?.newest
                  draft.message_page[sessionID] = {
                    hasOlder: info.hasOlder,
                    hasNewer: true,
                    loading: false,
                    oldest: nextOldest,
                    newest: nextNewest,
                    olderCursor: info.olderCursor,
                    newerCursor:
                      edgeCursor(draft.message_cursor, nextNewest) ?? draft.message_page[sessionID]?.newerCursor,
                    error: undefined,
                  }
                } else {
                  const nextNewest = windowNewest(existing, pinned) ?? draft.message_page[sessionID]?.newest
                  draft.message_page[sessionID] = {
                    hasOlder: info.hasOlder,
                    hasNewer: draft.message_page[sessionID]?.hasNewer ?? false,
                    loading: false,
                    oldest: nextOldest,
                    newest: nextNewest,
                    olderCursor: info.olderCursor,
                    newerCursor: draft.message_page[sessionID]?.newerCursor,
                    error: undefined,
                  }
                }
              }),
            )
          } catch (e) {
            if (epoch !== syncEpoch) return
            const page = store.message_page[sessionID]
            setStore("message_page", sessionID, {
              hasOlder: page?.hasOlder ?? false,
              hasNewer: page?.hasNewer ?? false,
              loading: false,
              oldest: page?.oldest,
              newest: page?.newest,
              olderCursor: page?.olderCursor,
              newerCursor: page?.newerCursor,
              error: paginationError(e),
            })
          } finally {
            loadingGuard.delete(sessionID)
            if (pendingLatest.delete(sessionID)) void result.session.jumpToLatest(sessionID, { force: true })
          }
        },
        async loadNewer(sessionID: string) {
          const page = store.message_page[sessionID]
          if (page?.loading || !page?.hasNewer) return
          const cursor = page?.newerCursor
          if (!cursor) return result.session.jumpToLatest(sessionID, { force: true })
          if (loadingGuard.has(sessionID)) return
          loadingGuard.add(sessionID)
          const epoch = syncEpoch
          const pinned = getRevertMarker(sessionID)
          try {
            setStore("message_page", sessionID, { ...page, loading: true, loadingDirection: "newer", error: undefined })
            const res = await sdk.client.session.messages(
              { sessionID, after: cursor, limit: 100 },
              { throwOnError: true },
            )
            if (epoch !== syncEpoch) return
            const info = pageInfo(res.response.headers.get("link") ?? "")
            setStore(
              produce((draft) => {
                const existing = draft.message[sessionID] ?? []
                const pageNewest = res.data?.at(-1)?.info.id
                for (const msg of res.data ?? []) {
                  draft.message_cursor[msg.info.id] = msg.cursor
                  const match = messageInsert(existing, msg.info)
                  if (!match.found) {
                    existing.splice(match.index, 0, msg.info)
                    draft.part[msg.info.id] = msg.parts
                  }
                }
                const nextNewest = pageNewest ?? draft.message_page[sessionID]?.newest
                if (existing.length > MAX_LOADED_MESSAGES) {
                  const evictCount = existing.length - MAX_LOADED_MESSAGES
                  const evicted = evictFromStart(existing, evictCount, pinned)
                  for (const msg of evicted) {
                    delete draft.part[msg.id]
                    delete draft.message_cursor[msg.id]
                  }
                  const nextOldest = windowOldest(existing, pinned) ?? draft.message_page[sessionID]?.oldest
                  draft.message_page[sessionID] = {
                    hasOlder: true,
                    hasNewer: info.hasNewer,
                    loading: false,
                    oldest: nextOldest,
                    newest: nextNewest,
                    olderCursor:
                      edgeCursor(draft.message_cursor, nextOldest) ?? draft.message_page[sessionID]?.olderCursor,
                    newerCursor: info.newerCursor,
                    error: undefined,
                  }
                } else {
                  const nextOldest = windowOldest(existing, pinned) ?? draft.message_page[sessionID]?.oldest
                  draft.message_page[sessionID] = {
                    hasOlder: draft.message_page[sessionID]?.hasOlder ?? false,
                    hasNewer: info.hasNewer,
                    loading: false,
                    oldest: nextOldest,
                    newest: nextNewest,
                    olderCursor: draft.message_page[sessionID]?.olderCursor,
                    newerCursor: info.newerCursor,
                    error: undefined,
                  }
                }
              }),
            )
          } catch (e) {
            if (epoch !== syncEpoch) return
            const page = store.message_page[sessionID]
            setStore("message_page", sessionID, {
              hasOlder: page?.hasOlder ?? false,
              hasNewer: page?.hasNewer ?? false,
              loading: false,
              oldest: page?.oldest,
              newest: page?.newest,
              olderCursor: page?.olderCursor,
              newerCursor: page?.newerCursor,
              error: paginationError(e),
            })
          } finally {
            loadingGuard.delete(sessionID)
            if (pendingLatest.delete(sessionID)) void result.session.jumpToLatest(sessionID, { force: true })
          }
        },
        async jumpToLatest(sessionID: string, opts?: { force?: boolean }) {
          const page = store.message_page[sessionID]
          if (page?.loading) {
            if (opts?.force) pendingLatest.add(sessionID)
            return
          }
          if (!opts?.force && !page?.hasNewer) return
          if (loadingGuard.has(sessionID)) {
            if (opts?.force) pendingLatest.add(sessionID)
            return
          }
          loadingGuard.add(sessionID)
          const epoch = syncEpoch

          try {
            const session = store.session.find((s) => s.id === sessionID)
            setStore("message_page", sessionID, {
              hasOlder: page?.hasOlder ?? false,
              hasNewer: page?.hasNewer ?? false,
              loading: true,
              loadingDirection: "newer",
              oldest: page?.oldest,
              newest: page?.newest,
              olderCursor: page?.olderCursor,
              newerCursor: page?.newerCursor,
              error: undefined,
            })

            const latest = await loadLatestPage(sessionID, session?.revert?.messageID)
            if (epoch !== syncEpoch) return

            setStore(
              produce((draft) => {
                const oldMessages = draft.message[sessionID] ?? []
                const newIds = new Set(latest.items.map((m) => m.info.id))
                for (const msg of oldMessages) {
                  if (!newIds.has(msg.id)) {
                    delete draft.part[msg.id]
                    delete draft.message_cursor[msg.id]
                  }
                }

                draft.message[sessionID] = latest.items.map((m) => m.info)
                for (const msg of latest.items) {
                  draft.part[msg.info.id] = msg.parts
                  draft.message_cursor[msg.info.id] = msg.cursor
                }
                draft.message_page[sessionID] = {
                  hasOlder: latest.hasOlder,
                  hasNewer: latest.hasNewer,
                  loading: false,
                  oldest: latest.oldest,
                  newest: latest.newest,
                  olderCursor: latest.olderCursor,
                  newerCursor: latest.newerCursor,
                  error: undefined,
                }
              }),
            )
          } catch (e) {
            if (epoch !== syncEpoch) return
            setStore(
              produce((draft) => {
                const p = draft.message_page[sessionID]
                if (p) {
                  p.loading = false
                  p.error = paginationError(e)
                }
              }),
            )
          } finally {
            loadingGuard.delete(sessionID)
            if (pendingLatest.delete(sessionID)) void result.session.jumpToLatest(sessionID, { force: true })
          }
        },
        async jumpToOldest(sessionID: string) {
          const page = store.message_page[sessionID]
          if (page?.loading || !page?.hasOlder) return
          if (loadingGuard.has(sessionID)) return
          loadingGuard.add(sessionID)
          const epoch = syncEpoch

          try {
            setStore("message_page", sessionID, {
              ...page,
              loading: true,
              loadingDirection: "older",
              error: undefined,
            })

            const res = await sdk.client.session.messages(
              { sessionID, oldest: "true", limit: 100 },
              { throwOnError: true },
            )
            if (epoch !== syncEpoch) return

            const session = store.session.find((s) => s.id === sessionID)
            const revertMessageID = session?.revert?.messageID

            let messages = res.data ?? []
            const pageOldest = messages.at(0)?.info.id
            const pageNewest = messages.at(-1)?.info.id
            const info = pageInfo(res.response.headers.get("link") ?? "")

            if (revertMessageID && !messages.some((m) => m.info.id === revertMessageID)) {
              try {
                const revertResult = await sdk.client.session.message(
                  { sessionID, messageID: revertMessageID },
                  { throwOnError: false },
                )
                if (epoch !== syncEpoch) return
                const boundary = boundaryFromMessageResponse(revertResult)
                if (!boundary) {
                  clearRevert(sessionID)
                } else {
                  const index = messageInsert(
                    messages.map((m) => m.info),
                    boundary.info,
                  )
                  if (!index.found) messages.splice(index.index, 0, boundary)
                }
              } catch (e) {
                if (epoch !== syncEpoch) return
                Log.Default.info("Revert marker fetch failed during jumpToOldest", {
                  messageID: revertMessageID,
                  error: e,
                })
                throw e
              }
            }

            const nextOldest = pageOldest ?? messages.at(0)?.info.id
            const nextNewest = pageNewest ?? messages.at(-1)?.info.id

            setStore(
              produce((draft) => {
                const oldMessages = draft.message[sessionID] ?? []
                const newIds = new Set(messages.map((m) => m.info.id))
                for (const msg of oldMessages) {
                  if (!newIds.has(msg.id)) {
                    delete draft.part[msg.id]
                    delete draft.message_cursor[msg.id]
                  }
                }

                draft.message[sessionID] = messages.map((m) => m.info)
                for (const msg of messages) {
                  draft.part[msg.info.id] = msg.parts
                  draft.message_cursor[msg.info.id] = msg.cursor
                }
                draft.message_page[sessionID] = {
                  hasOlder: info.hasOlder,
                  hasNewer: info.hasNewer,
                  loading: false,
                  oldest: nextOldest,
                  newest: nextNewest,
                  olderCursor: info.olderCursor,
                  newerCursor: info.newerCursor,
                  error: undefined,
                }
              }),
            )
          } catch (e) {
            if (epoch !== syncEpoch) return
            setStore(
              produce((draft) => {
                const p = draft.message_page[sessionID]
                if (p) {
                  p.loading = false
                  p.error = paginationError(e)
                }
              }),
            )
          } finally {
            loadingGuard.delete(sessionID)
          }
        },
      },
      bootstrap,
    }
    return result
  },
})
