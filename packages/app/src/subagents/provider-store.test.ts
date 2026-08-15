import { afterEach, describe, expect, test, vi } from "vitest";
import {
  providerSubagentKey,
  refreshProviderSubagents,
  subscribeProviderSubagentRefresh,
  useProviderSubagentStore,
} from "./provider-store";

const SERVER_ID = "server-1";
const PARENT_ID = "parent-1";
const SUBAGENT_ID = "child-1";

afterEach(() => {
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
  });
});

describe("provider subagent client store", () => {
  test("refreshes a visible parent after the client reconnects", async () => {
    const runningSubagent = {
      id: SUBAGENT_ID,
      parentAgentId: PARENT_ID,
      provider: "pi" as const,
      title: "Running worker",
      description: null,
      status: "running" as const,
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
      toolCallId: null,
      cwd: null,
      subtitle: null,
    };
    let resolveFirstResponse: () => void = () => {
      throw new Error("First response resolver was not initialized");
    };
    const firstResponse = new Promise<{ subagents: unknown[] }>((resolve) => {
      resolveFirstResponse = () => resolve({ subagents: [] });
    });
    const listProviderSubagents = vi.fn(() => {
      if (listProviderSubagents.mock.calls.length === 1) {
        return firstResponse;
      }
      return Promise.resolve({ subagents: [runningSubagent] });
    });
    let connectionListener: (state: { status: string }) => void = (_state) => {
      throw new Error("Connection listener was not initialized");
    };
    const client = {
      listProviderSubagents,
      subscribeConnectionStatus(listener: (state: { status: string }) => void) {
        connectionListener = listener;
        listener({ status: "connected" });
        return () => {
          connectionListener = () => {
            throw new Error("Connection listener was unsubscribed");
          };
        };
      },
    } as unknown as Parameters<typeof subscribeProviderSubagentRefresh>[0];

    const unsubscribe = subscribeProviderSubagentRefresh(client, SERVER_ID, PARENT_ID);
    await vi.waitFor(() => expect(listProviderSubagents).toHaveBeenCalledTimes(1));

    connectionListener({ status: "disconnected" });
    connectionListener({ status: "connected" });
    resolveFirstResponse();
    await vi.waitFor(() => expect(listProviderSubagents).toHaveBeenCalledTimes(2));

    expect(
      useProviderSubagentStore
        .getState()
        .descriptors.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID))?.status,
    ).toBe("running");
    unsubscribe();
  });

  test("does not apply a list response after its subscription is cleaned up", async () => {
    let resolveListResponse!: (value: { subagents: unknown[] }) => void;
    const listResponse = new Promise<{ subagents: unknown[] }>((resolve) => {
      resolveListResponse = resolve;
    });
    const unsubscribeConnectionStatus = vi.fn();
    const client = {
      listProviderSubagents: vi.fn(() => listResponse),
      subscribeConnectionStatus(listener: (state: { status: string }) => void) {
        listener({ status: "connected" });
        return unsubscribeConnectionStatus;
      },
    } as unknown as Parameters<typeof subscribeProviderSubagentRefresh>[0];
    const unsubscribe = subscribeProviderSubagentRefresh(client, SERVER_ID, PARENT_ID);
    await vi.waitFor(() => expect(client.listProviderSubagents).toHaveBeenCalledTimes(1));

    unsubscribe();
    resolveListResponse({
      subagents: [
        {
          id: SUBAGENT_ID,
          parentAgentId: PARENT_ID,
          provider: "pi",
          title: "Running worker",
          description: null,
          status: "running",
          createdAt: "2026-07-12T10:00:00.000Z",
          updatedAt: "2026-07-12T10:00:01.000Z",
          toolCallId: null,
          cwd: null,
          subtitle: null,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unsubscribeConnectionStatus).toHaveBeenCalledTimes(1);
    expect(
      useProviderSubagentStore
        .getState()
        .descriptors.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID)),
    ).toBeUndefined();
  });

  test("merges a newer live update with sibling rows from an older list response", async () => {
    let resolveListResponse!: (value: { subagents: unknown[] }) => void;
    const listResponse = new Promise<{ subagents: unknown[] }>((resolve) => {
      resolveListResponse = resolve;
    });
    const client = {
      listProviderSubagents: vi.fn(() => listResponse),
    } as unknown as Parameters<typeof refreshProviderSubagents>[0];
    const refresh = refreshProviderSubagents(client, SERVER_ID, PARENT_ID);

    useProviderSubagentStore.getState().applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "pi",
        title: "Running worker",
        description: null,
        status: "running",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:01.000Z",
        toolCallId: null,
        cwd: null,
        subtitle: null,
      },
    });
    resolveListResponse({
      subagents: [
        {
          id: "stable-worker",
          parentAgentId: PARENT_ID,
          provider: "pi",
          title: "Stable worker",
          description: null,
          status: "running",
          createdAt: "2026-07-12T09:00:00.000Z",
          updatedAt: "2026-07-12T09:00:00.000Z",
          toolCallId: null,
          cwd: null,
          subtitle: null,
        },
      ],
    });
    await refresh;

    expect(
      useProviderSubagentStore
        .getState()
        .descriptors.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID))?.status,
    ).toBe("running");
    expect(
      useProviderSubagentStore
        .getState()
        .descriptors.get(providerSubagentKey(SERVER_ID, PARENT_ID, "stable-worker"))?.status,
    ).toBe("running");
  });

  test("does not resurrect a descriptor removed during a list request", async () => {
    const removedSubagent = {
      id: SUBAGENT_ID,
      parentAgentId: PARENT_ID,
      provider: "pi" as const,
      title: "Removed worker",
      description: null,
      status: "running" as const,
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
      toolCallId: null,
      cwd: null,
      subtitle: null,
    };
    useProviderSubagentStore.getState().applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: removedSubagent,
    });
    let resolveListResponse!: (value: { subagents: unknown[] }) => void;
    const listResponse = new Promise<{ subagents: unknown[] }>((resolve) => {
      resolveListResponse = resolve;
    });
    const client = {
      listProviderSubagents: vi.fn(() => listResponse),
    } as unknown as Parameters<typeof refreshProviderSubagents>[0];
    const refresh = refreshProviderSubagents(client, SERVER_ID, PARENT_ID);

    useProviderSubagentStore.getState().applyUpdate(SERVER_ID, {
      kind: "remove",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
    });
    resolveListResponse({ subagents: [removedSubagent] });
    await refresh;

    expect(
      useProviderSubagentStore
        .getState()
        .descriptors.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID)),
    ).toBeUndefined();
  });

  test("keeps a valid list response after a stale timeline update", async () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "pi",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:00.000Z",
      item: { type: "assistant_message", text: "Live output" },
    });
    let resolveListResponse!: (value: { subagents: unknown[] }) => void;
    const listResponse = new Promise<{ subagents: unknown[] }>((resolve) => {
      resolveListResponse = resolve;
    });
    const client = {
      listProviderSubagents: vi.fn(() => listResponse),
    } as unknown as Parameters<typeof refreshProviderSubagents>[0];
    const refresh = refreshProviderSubagents(client, SERVER_ID, PARENT_ID);

    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "pi",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:00.000Z",
      item: { type: "assistant_message", text: "Duplicate output" },
    });
    resolveListResponse({
      subagents: [
        {
          id: SUBAGENT_ID,
          parentAgentId: PARENT_ID,
          provider: "pi",
          title: "Running worker",
          description: null,
          status: "running",
          createdAt: "2026-07-12T10:00:00.000Z",
          updatedAt: "2026-07-12T10:00:01.000Z",
          toolCallId: null,
          cwd: null,
          subtitle: null,
        },
      ],
    });
    await refresh;

    expect(
      useProviderSubagentStore
        .getState()
        .descriptors.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID))?.status,
    ).toBe("running");
  });

  test("does not let a previous client overwrite a newer client refresh", async () => {
    let resolvePreviousResponse!: (value: { subagents: unknown[] }) => void;
    const previousResponse = new Promise<{ subagents: unknown[] }>((resolve) => {
      resolvePreviousResponse = resolve;
    });
    const previousClient = {
      listProviderSubagents: vi.fn(() => previousResponse),
    } as unknown as Parameters<typeof refreshProviderSubagents>[0];
    const currentClient = {
      listProviderSubagents: vi.fn(() =>
        Promise.resolve({
          subagents: [
            {
              id: SUBAGENT_ID,
              parentAgentId: PARENT_ID,
              provider: "pi" as const,
              title: "Running worker",
              description: null,
              status: "running" as const,
              createdAt: "2026-07-12T10:00:00.000Z",
              updatedAt: "2026-07-12T10:00:01.000Z",
              toolCallId: null,
              cwd: null,
              subtitle: null,
            },
          ],
        }),
      ),
    } as unknown as Parameters<typeof refreshProviderSubagents>[0];

    const previousRefresh = refreshProviderSubagents(previousClient, SERVER_ID, PARENT_ID);
    await refreshProviderSubagents(currentClient, SERVER_ID, PARENT_ID);
    resolvePreviousResponse({ subagents: [] });
    await previousRefresh;

    expect(
      useProviderSubagentStore
        .getState()
        .descriptors.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID))?.status,
    ).toBe("running");
  });

  test("builds a shared stream model from ordered provider updates", () => {
    const subagents = useProviderSubagentStore.getState();
    subagents.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Explore",
        description: "Inspect the repository",
        status: "running",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:00.000Z",
        toolCallId: "call-1",
      },
    });
    subagents.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 2,
      timestamp: "2026-07-12T10:00:02.000Z",
      item: { type: "assistant_message", text: "New live output." },
    });
    subagents.replaceTimeline(SERVER_ID, {
      requestId: "history-1",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
      hasOlder: false,
      hasNewer: true,
      rows: [
        {
          seq: 1,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text: "Older history." },
        },
      ],
      error: null,
    });
    const liveTimeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    subagents.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Explore",
        description: "Inspect the repository",
        status: "running",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:01.500Z",
        toolCallId: "call-1",
      },
    });
    expect(
      useProviderSubagentStore
        .getState()
        .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID)),
    ).toBe(liveTimeline);
    subagents.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Explore",
        description: "Inspect the repository",
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    });

    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    const state = useProviderSubagentStore.getState();
    expect(state.descriptors.get(key)?.status).toBe("completed");
    expect(state.timelines.get(key)?.head).toEqual([]);
    expect(state.timelines.get(key)?.tail).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        text: "Older history.New live output.",
      }),
    ]);
  });

  test("removes timelines for children no longer returned by the provider", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:01.000Z",
      item: { type: "assistant_message", text: "Removed child output." },
    });

    store.replaceList(SERVER_ID, PARENT_ID, []);

    expect(
      useProviderSubagentStore
        .getState()
        .timelines.has(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID)),
    ).toBe(false);
  });

  test("hides finished children locally without removing their timelines", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Finished child",
        description: null,
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    });
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:01.000Z",
      item: { type: "assistant_message", text: "Finished output." },
    });

    store.hideFinishedForParent(SERVER_ID, PARENT_ID);

    const state = useProviderSubagentStore.getState();
    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(state.descriptors.get(key)?.title).toBe("Finished child");
    expect(state.hiddenFromTrack.has(key)).toBe(true);
    expect(state.timelines.get(key)?.tail).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Finished output." }),
    ]);
  });

  test("reveals a hidden child when the provider reports it running again", () => {
    const store = useProviderSubagentStore.getState();
    const completed = {
      id: SUBAGENT_ID,
      parentAgentId: PARENT_ID,
      provider: "codex" as const,
      title: "Finished child",
      description: null,
      status: "completed" as const,
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:02.000Z",
      toolCallId: "call-1",
    };
    store.applyUpdate(SERVER_ID, { kind: "upsert", subagent: completed });
    store.hideFinishedForParent(SERVER_ID, PARENT_ID);
    store.replaceList(SERVER_ID, PARENT_ID, [completed]);

    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(useProviderSubagentStore.getState().hiddenFromTrack.has(key)).toBe(true);

    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: { ...completed, status: "running", updatedAt: "2026-07-12T10:01:00.000Z" },
    });

    expect(useProviderSubagentStore.getState().hiddenFromTrack.has(key)).toBe(false);
  });

  test("keeps hidden state when a child temporarily disappears from the provider list", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Finished child",
        description: null,
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    });
    store.hideFinishedForParent(SERVER_ID, PARENT_ID);

    store.replaceList(SERVER_ID, PARENT_ID, []);

    const state = useProviderSubagentStore.getState();
    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(state.descriptors.has(key)).toBe(false);
    expect(state.hiddenFromTrack.has(key)).toBe(true);
  });

  test("keeps a finished child hidden across remove and history replay", () => {
    const store = useProviderSubagentStore.getState();
    const completed = {
      id: SUBAGENT_ID,
      parentAgentId: PARENT_ID,
      provider: "codex" as const,
      title: "Finished child",
      description: null,
      status: "completed" as const,
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:02.000Z",
      toolCallId: "call-1",
    };
    store.applyUpdate(SERVER_ID, { kind: "upsert", subagent: completed });
    store.hideFinishedForParent(SERVER_ID, PARENT_ID);
    store.applyUpdate(SERVER_ID, {
      kind: "remove",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
    });
    store.applyUpdate(SERVER_ID, { kind: "upsert", subagent: completed });

    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(useProviderSubagentStore.getState().hiddenFromTrack.has(key)).toBe(true);
  });
  test("applies terminal list status to a timeline received before its descriptor", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:01.000Z",
      item: { type: "assistant_message", text: "Restored output." },
    });
    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(useProviderSubagentStore.getState().timelines.get(key)?.head).not.toEqual([]);

    store.replaceList(SERVER_ID, PARENT_ID, [
      {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Restored child",
        description: null,
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    ]);

    const timeline = useProviderSubagentStore.getState().timelines.get(key);
    expect(timeline?.head).toEqual([]);
    expect(timeline?.tail).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Restored output." }),
    ]);
  });

  test("keeps late timeline rows terminal after the descriptor completes", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Restored child",
        description: null,
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    });
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:01.000Z",
      item: { type: "assistant_message", text: "Late restored output." },
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline?.head).toEqual([]);
    expect(timeline?.tail).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Late restored output." }),
    ]);
  });

  test("merges bounded older pages and tracks whether more history remains", () => {
    const store = useProviderSubagentStore.getState();
    store.replaceTimeline(SERVER_ID, {
      requestId: "tail-page",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 2, maxSeq: 2, nextSeq: 3 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 2,
          timestamp: "2026-07-12T10:00:02.000Z",
          item: { type: "assistant_message", text: "Recent output." },
        },
      ],
      error: null,
    });
    store.replaceTimeline(SERVER_ID, {
      requestId: "older-page",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "before",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: false,
      hasNewer: true,
      rows: [
        {
          seq: 1,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text: "Older output." },
        },
      ],
      error: null,
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline?.hasOlder).toBe(false);
    expect([...timeline!.rows.keys()]).toEqual([2, 1]);
    expect(timeline?.head).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Older output.Recent output." }),
    ]);
  });

  test("ignores delayed live updates from a stale timeline epoch", () => {
    const store = useProviderSubagentStore.getState();
    store.replaceTimeline(SERVER_ID, {
      requestId: "current-page",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-current",
      reset: true,
      staleCursor: false,
      gap: false,
      window: { minSeq: 2, maxSeq: 2, nextSeq: 3 },
      hasOlder: false,
      hasNewer: false,
      rows: [
        {
          seq: 2,
          timestamp: "2026-07-12T10:00:02.000Z",
          item: { type: "assistant_message", text: "Current output." },
        },
      ],
      error: null,
    });

    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-stale",
      seq: 3,
      timestamp: "2026-07-12T10:00:03.000Z",
      item: { type: "assistant_message", text: "Stale output." },
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline?.epoch).toBe("epoch-current");
    expect([...timeline!.rows.keys()]).toEqual([2]);
    expect(timeline?.head).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Current output." }),
    ]);
  });

  test("replaces cached rows with an authoritative tail page after a reconnect gap", () => {
    const store = useProviderSubagentStore.getState();
    store.replaceTimeline(SERVER_ID, {
      requestId: "old-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 500, nextSeq: 501 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 100,
          timestamp: "2026-07-12T10:00:00.000Z",
          item: { type: "assistant_message", text: "Old cached output." },
        },
      ],
      error: null,
    });
    store.replaceTimeline(SERVER_ID, {
      requestId: "reconnect-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 500, nextSeq: 501 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 401,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text: "Current tail output." },
        },
      ],
      error: null,
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect([...timeline!.rows.keys()]).toEqual([401]);
    expect(timeline?.head).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Current tail output." }),
    ]);
  });
});
