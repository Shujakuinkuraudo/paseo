import type {
  AgentStreamEventPayload,
  ProviderSubagentDescriptorPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";
import { applyStreamEvent } from "@/types/stream";
import type { StreamItem } from "@/types/stream";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

type ProviderSubagentTimelineItem = Extract<
  Extract<SessionOutboundMessage, { type: "agent.provider_subagents.update" }>["payload"],
  { kind: "timeline" }
>["item"];

interface ProviderSubagentTimelineRow {
  provider: ProviderSubagentDescriptorPayload["provider"];
  item: ProviderSubagentTimelineItem;
  timestamp: string;
}

export interface ProviderSubagentTimelineState {
  tail: StreamItem[];
  head: StreamItem[];
  epoch: string | null;
  lastSeq: number;
  hasOlder: boolean;
  rows: Map<number, ProviderSubagentTimelineRow>;
}

interface ProviderSubagentState {
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
  hiddenFromTrack: Set<string>;
  hideFinishedForParent(serverId: string, parentAgentId: string): void;
  replaceList(
    serverId: string,
    parentAgentId: string,
    subagents: ProviderSubagentDescriptorPayload[],
    protectedDescriptorKeys?: ReadonlySet<string>,
  ): void;
  applyUpdate(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.update" }
    >["payload"],
  ): void;
  replaceTimeline(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.timeline.get.response" }
    >["payload"],
  ): void;
}

export function providerSubagentKey(
  serverId: string,
  parentAgentId: string,
  subagentId: string,
): string {
  return `${serverId}\0${parentAgentId}\0${subagentId}`;
}

export function providerSubagentLifecycleStatus(
  status: ProviderSubagentDescriptorPayload["status"],
): AgentLifecycleStatus {
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "idle";
}

type ProviderSubagentListClient = Pick<DaemonClient, "listProviderSubagents">;
type ProviderSubagentRefreshClient = ProviderSubagentListClient &
  Pick<DaemonClient, "subscribeConnectionStatus">;

interface ProviderSubagentRefreshState {
  liveUpdateVersion: number;
  liveDescriptorUpdateVersions: Map<string, number>;
  latestListGeneration: number;
  pendingRequestCount: number;
}

interface PendingProviderSubagentListRequest {
  promise: Promise<void>;
  allowsUnguardedApply: boolean;
  applyGuards: Set<() => boolean>;
}

interface RefreshProviderSubagentsOptions {
  shouldApply?: () => boolean;
}

const pendingListRequests = new WeakMap<
  ProviderSubagentListClient,
  Map<string, PendingProviderSubagentListRequest>
>();
const providerSubagentRefreshStates = new Map<string, ProviderSubagentRefreshState>();

function providerSubagentParentKey(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}`;
}

function noteLiveProviderSubagentUpdate(
  serverId: string,
  parentAgentId: string,
  subagentId: string,
): void {
  const refreshState = providerSubagentRefreshStates.get(
    providerSubagentParentKey(serverId, parentAgentId),
  );
  if (refreshState) {
    refreshState.liveUpdateVersion += 1;
    refreshState.liveDescriptorUpdateVersions.set(
      providerSubagentKey(serverId, parentAgentId, subagentId),
      refreshState.liveUpdateVersion,
    );
  }
}

function addPendingListConsumer(
  pending: PendingProviderSubagentListRequest,
  options: RefreshProviderSubagentsOptions,
): void {
  if (options.shouldApply) {
    pending.applyGuards.add(options.shouldApply);
  } else {
    pending.allowsUnguardedApply = true;
  }
}

function hasPendingListConsumer(pending: PendingProviderSubagentListRequest): boolean {
  return (
    pending.allowsUnguardedApply || [...pending.applyGuards].some((shouldApply) => shouldApply())
  );
}

export function refreshProviderSubagents(
  client: ProviderSubagentListClient,
  serverId: string,
  parentAgentId: string,
  options: RefreshProviderSubagentsOptions = {},
): Promise<void> {
  const requestKey = providerSubagentParentKey(serverId, parentAgentId);
  let clientRequests = pendingListRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingListRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(requestKey);
  if (pending) {
    addPendingListConsumer(pending, options);
    return pending.promise;
  }

  const refreshState = providerSubagentRefreshStates.get(requestKey) ?? {
    liveUpdateVersion: 0,
    liveDescriptorUpdateVersions: new Map<string, number>(),
    latestListGeneration: 0,
    pendingRequestCount: 0,
  };
  providerSubagentRefreshStates.set(requestKey, refreshState);
  const liveUpdateVersion = refreshState.liveUpdateVersion;
  const listGeneration = refreshState.latestListGeneration + 1;
  refreshState.latestListGeneration = listGeneration;
  refreshState.pendingRequestCount += 1;
  const pendingRequest: PendingProviderSubagentListRequest = {
    promise: Promise.resolve(),
    allowsUnguardedApply: options.shouldApply === undefined,
    applyGuards: new Set(options.shouldApply ? [options.shouldApply] : []),
  };

  const request = client
    .listProviderSubagents(parentAgentId)
    .then((payload) => {
      const currentRefreshState = providerSubagentRefreshStates.get(requestKey);
      if (
        !currentRefreshState ||
        currentRefreshState.latestListGeneration !== listGeneration ||
        !hasPendingListConsumer(pendingRequest)
      ) {
        return undefined;
      }
      const protectedDescriptorKeys = new Set(
        [...currentRefreshState.liveDescriptorUpdateVersions]
          .filter(([, updateVersion]) => updateVersion > liveUpdateVersion)
          .map(([key]) => key),
      );
      useProviderSubagentStore
        .getState()
        .replaceList(serverId, parentAgentId, payload.subagents, protectedDescriptorKeys);
      return undefined;
    })
    .finally(() => {
      if (clientRequests?.get(requestKey) === pendingRequest) {
        clientRequests.delete(requestKey);
      }
      refreshState.pendingRequestCount -= 1;
      if (
        refreshState.pendingRequestCount === 0 &&
        providerSubagentRefreshStates.get(requestKey) === refreshState
      ) {
        providerSubagentRefreshStates.delete(requestKey);
      }
    });
  pendingRequest.promise = request;
  clientRequests.set(requestKey, pendingRequest);
  return request;
}

export function subscribeProviderSubagentRefresh(
  client: ProviderSubagentRefreshClient,
  serverId: string,
  parentAgentId: string,
): () => void {
  let active = true;
  let refreshQueued = false;
  let refreshInFlight = false;
  let observedConnectionState = false;

  const scheduleRefresh = () => {
    if (!active) {
      return;
    }
    refreshQueued = true;
    if (refreshInFlight) {
      return;
    }
    refreshInFlight = true;
    void (async () => {
      while (refreshQueued) {
        if (!active) {
          break;
        }
        refreshQueued = false;
        await refreshProviderSubagents(client, serverId, parentAgentId, {
          shouldApply: () => active,
        }).catch(() => undefined);
      }
      refreshInFlight = false;
    })();
  };

  scheduleRefresh();
  const unsubscribe = client.subscribeConnectionStatus((connection) => {
    const isInitialState = !observedConnectionState;
    observedConnectionState = true;
    if (!isInitialState && connection.status === "connected") {
      scheduleRefresh();
    }
  });
  return () => {
    active = false;
    unsubscribe();
  };
}

function parentPrefix(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}\0`;
}

const EMPTY_TIMELINE: ProviderSubagentTimelineState = {
  tail: [],
  head: [],
  epoch: null,
  lastSeq: 0,
  hasOlder: false,
  rows: new Map(),
};

function providerSubagentTerminalEvent(
  subagent: ProviderSubagentDescriptorPayload,
): AgentStreamEventPayload | null {
  if (subagent.status === "running") {
    return null;
  }
  if (subagent.status === "failed") {
    return { type: "turn_failed", provider: subagent.provider, error: "Subagent failed" };
  }
  if (subagent.status === "canceled") {
    return { type: "turn_canceled", provider: subagent.provider, reason: "canceled" };
  }
  return { type: "turn_completed", provider: subagent.provider };
}

function buildTimelineState(
  rows: ProviderSubagentTimelineState["rows"],
  epoch: string | null,
  descriptor?: ProviderSubagentDescriptorPayload,
  hasOlder = false,
): ProviderSubagentTimelineState {
  let timeline = { tail: [] as StreamItem[], head: [] as StreamItem[] };
  for (const [, row] of [...rows].sort(([left], [right]) => left - right)) {
    timeline = applyStreamEvent({
      ...timeline,
      event: { type: "timeline", provider: row.provider, item: row.item },
      timestamp: new Date(row.timestamp),
    });
  }
  const terminalEvent = descriptor ? providerSubagentTerminalEvent(descriptor) : null;
  if (terminalEvent && descriptor) {
    timeline = applyStreamEvent({
      ...timeline,
      event: terminalEvent,
      timestamp: new Date(descriptor.updatedAt),
    });
  }
  return {
    ...timeline,
    epoch,
    lastSeq: rows.size ? Math.max(...rows.keys()) : 0,
    hasOlder,
    rows,
  };
}

function buildTimelineResponseRows(
  existing: ProviderSubagentTimelineState | undefined,
  payload: Extract<
    SessionOutboundMessage,
    { type: "agent.provider_subagents.timeline.get.response" }
  >["payload"],
  provider: ProviderSubagentDescriptorPayload["provider"],
): ProviderSubagentTimelineState["rows"] {
  const rows = new Map<number, ProviderSubagentTimelineRow>();
  for (const row of payload.rows) {
    rows.set(row.seq, { provider, item: row.item, timestamp: row.timestamp });
  }
  if (payload.reset || existing?.epoch !== payload.epoch) {
    return rows;
  }
  if (payload.direction !== "tail") {
    return new Map([...existing.rows, ...rows]);
  }

  let nextSeq = payload.rows.length
    ? Math.max(...payload.rows.map((row) => row.seq)) + 1
    : payload.window.maxSeq + 1;
  for (const [seq, row] of [...existing.rows].sort(([left], [right]) => left - right)) {
    if (seq < nextSeq) continue;
    if (seq !== nextSeq) break;
    rows.set(seq, row);
    nextSeq += 1;
  }
  return rows;
}

export const useProviderSubagentStore = create<ProviderSubagentState>((set) => ({
  descriptors: new Map(),
  timelines: new Map(),
  hiddenFromTrack: new Set(),
  hideFinishedForParent(serverId, parentAgentId) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const [key, subagent] of state.descriptors) {
        if (key.startsWith(prefix) && subagent.status !== "running") {
          hiddenFromTrack.add(key);
        }
      }
      return { hiddenFromTrack };
    });
  },
  replaceList(serverId, parentAgentId, subagents, protectedDescriptorKeys = new Set<string>()) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const descriptors = new Map(
        [...state.descriptors].filter(
          ([key]) => !key.startsWith(prefix) || protectedDescriptorKeys.has(key),
        ),
      );
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        if (protectedDescriptorKeys.has(key)) {
          continue;
        }
        descriptors.set(key, subagent);
        if (subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
      }
      const retainedKeys = new Set(descriptors.keys());
      const timelines = new Map(
        [...state.timelines].filter(([key]) => !key.startsWith(prefix) || retainedKeys.has(key)),
      );
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        if (protectedDescriptorKeys.has(key)) {
          continue;
        }
        const current = timelines.get(key);
        const previous = state.descriptors.get(key);
        if (current && previous?.status !== subagent.status) {
          timelines.set(
            key,
            buildTimelineState(current.rows, current.epoch, subagent, current.hasOlder),
          );
        }
      }
      return { descriptors, timelines, hiddenFromTrack };
    });
  },
  applyUpdate(serverId, payload) {
    set((state) => {
      if (payload.kind === "upsert") {
        noteLiveProviderSubagentUpdate(
          serverId,
          payload.subagent.parentAgentId,
          payload.subagent.id,
        );
        const key = providerSubagentKey(
          serverId,
          payload.subagent.parentAgentId,
          payload.subagent.id,
        );
        const descriptors = new Map(state.descriptors);
        const hiddenFromTrack = new Set(state.hiddenFromTrack);
        const previous = descriptors.get(key);
        descriptors.set(key, payload.subagent);
        if (payload.subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
        let timelines = state.timelines;
        const current = state.timelines.get(key);
        if (current && previous?.status !== payload.subagent.status) {
          timelines = new Map(state.timelines);
          timelines.set(
            key,
            buildTimelineState(current.rows, current.epoch, payload.subagent, current.hasOlder),
          );
        }
        return { descriptors, timelines, hiddenFromTrack };
      }
      if (payload.kind === "remove") {
        noteLiveProviderSubagentUpdate(serverId, payload.parentAgentId, payload.subagentId);
        const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
        const descriptors = new Map(state.descriptors);
        descriptors.delete(key);
        const timelines = new Map(state.timelines);
        timelines.delete(key);
        return { descriptors, timelines };
      }
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const existing = state.timelines.get(key);
      if (existing?.epoch && existing.epoch !== payload.epoch) {
        return state;
      }
      const current = existing ?? EMPTY_TIMELINE;
      if (payload.seq <= current.lastSeq) {
        return state;
      }
      const rows = new Map(current.rows);
      rows.set(payload.seq, {
        provider: payload.provider,
        item: payload.item,
        timestamp: payload.timestamp,
      });
      const descriptor = state.descriptors.get(key);
      const next =
        descriptor && descriptor.status !== "running"
          ? buildTimelineState(rows, payload.epoch, descriptor, current.hasOlder)
          : applyStreamEvent({
              tail: current.tail,
              head: current.head,
              event: { type: "timeline", provider: payload.provider, item: payload.item },
              timestamp: new Date(payload.timestamp),
            });
      const timelines = new Map(state.timelines);
      timelines.set(key, {
        ...next,
        epoch: payload.epoch,
        lastSeq: payload.seq,
        hasOlder: current.hasOlder,
        rows,
      });
      return { timelines };
    });
  },
  replaceTimeline(serverId, payload) {
    const provider = payload.provider;
    if (!provider) {
      return;
    }
    set((state) => {
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const existing = state.timelines.get(key);
      const rows = buildTimelineResponseRows(existing, payload, provider);
      const descriptor = state.descriptors.get(key);
      const timelines = new Map(state.timelines);
      timelines.set(key, buildTimelineState(rows, payload.epoch, descriptor, payload.hasOlder));
      return { timelines };
    });
  },
}));
