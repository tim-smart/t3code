import {
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { selectProjectGroupingSettings } from "../../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { Project, SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { ProjectFavicon, ProjectFaviconFallback } from "../ProjectFavicon";
import {
  archiveSelectedThreadEntries,
  buildSidebarV2ThreadContextMenuItems,
  resolveThreadStatusPill,
} from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  BOARD_COLUMN_IDS,
  boardGitKey,
  boardWorktreeKey,
  buildBoardColumns,
  buildBoardProjectFilterPredicate,
  deriveBoardColumn,
  parseBoardWorktreeGroupDragId,
  resolveBoardDropIntent,
  resolveBoardThreadPr,
  type BoardColumnItem,
  type BoardDropIntent,
} from "./Board.logic";
import { BoardCard, BoardCardDragOverlay } from "./BoardCard";
import { BoardColumn } from "./BoardColumn";
import { createBoardDragClickGuard } from "./BoardDragClickGuard";
import { BoardDropZones } from "./BoardDropZones";
import { scrollBoardFromWheel, shouldScrollColumnFromWheel } from "./BoardScroll";
import { BoardWorktreeGroup, BoardWorktreeGroupDragOverlay } from "./BoardWorktreeGroup";
import { useBoardVcsStatuses, type BoardVcsTarget } from "./useBoardVcsStatuses";

const BOARD_PROJECT_FILTER_STORAGE_KEY = "t3code:board:project-filter:v1";
const BOARD_PROJECT_FILTER_ALL = "all";
const BoardProjectFilterSchema = Schema.NullOr(Schema.String);

interface BoardThreadGitContext {
  readonly project: Project | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly gitStatusPending: boolean;
}

function countBoardColumnThreads<T>(items: readonly BoardColumnItem<T>[]): number {
  return items.reduce(
    (count, item) => count + (item.kind === "thread" ? 1 : item.threads.length),
    0,
  );
}

export function BoardView() {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {bootstrapped ? (
          <BoardContent />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-5 text-muted-foreground/60" />
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

function BoardContent() {
  const projects = useProjects();
  const threadShells = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const serverConfigs = useServerConfigs();
  const {
    archiveThread,
    confirmAndDeleteThread,
    confirmAndDeleteThreads,
    settleThread,
    unsettleThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const navigate = useNavigate();
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const [threadRenameTarget, setThreadRenameTarget] = useState<SidebarThreadSummary | null>(null);
  const [threadRenameTitle, setThreadRenameTitle] = useState("");

  useEffect(() => {
    const scrollContainer = boardScrollRef.current;
    if (scrollContainer === null) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        return;
      }

      const columnScrollViewport =
        event.target instanceof Element
          ? event.target.closest(
              '[data-testid^="board-column-"] [data-slot="scroll-area-viewport"]',
            )
          : null;
      if (
        columnScrollViewport instanceof HTMLElement &&
        shouldScrollColumnFromWheel(columnScrollViewport, event)
      ) {
        return;
      }

      if (scrollBoardFromWheel(scrollContainer, event)) {
        event.preventDefault();
      }
    };

    // React's delegated wheel events can be passive. This listener must be
    // non-passive so gestures released by nested columns can move the board.
    scrollContainer.addEventListener("wheel", handleWheel, { passive: false });
    return () => scrollContainer.removeEventListener("wheel", handleWheel);
  }, []);

  const [storedProjectFilter, setStoredProjectFilter] = useLocalStorage(
    BOARD_PROJECT_FILTER_STORAGE_KEY,
    null,
    BoardProjectFilterSchema,
  );

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const desktopLocalEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isDesktopLocalConnectionTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const projectSnapshots = useMemo<SidebarProjectSnapshot[]>(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
        isDesktopLocalEnvironment: (environmentId) => desktopLocalEnvironmentIds.has(environmentId),
      }),
    [
      desktopLocalEnvironmentIds,
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
    ],
  );

  const projectByKey = useMemo(
    () =>
      new Map(
        projects.map(
          (project) =>
            [
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
              project,
            ] as const,
        ),
      ),
    [projects],
  );

  const threads = useMemo(
    () => threadShells.filter((thread) => thread.archivedAt === null),
    [threadShells],
  );
  const filterPredicate = useMemo(
    () =>
      buildBoardProjectFilterPredicate({
        selectedProjectKey: storedProjectFilter,
        snapshots: projectSnapshots,
      }),
    [projectSnapshots, storedProjectFilter],
  );
  const filteredThreads = useMemo(
    () => threads.filter(filterPredicate),
    [filterPredicate, threads],
  );

  const resolveThreadGitCwd = useCallback(
    (thread: SidebarThreadSummary): string | null => {
      if (thread.branch == null) {
        return null;
      }
      const project = projectByKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      return thread.worktreePath ?? project?.workspaceRoot ?? null;
    },
    [projectByKey],
  );

  const vcsTargets = useMemo<BoardVcsTarget[]>(
    () =>
      filteredThreads.flatMap((thread) => {
        const cwd = resolveThreadGitCwd(thread);
        return cwd === null ? [] : [{ environmentId: thread.environmentId, cwd }];
      }),
    [filteredThreads, resolveThreadGitCwd],
  );
  const gitStatuses = useBoardVcsStatuses(vcsTargets);

  const getThreadGitContext = useCallback(
    (thread: SidebarThreadSummary): BoardThreadGitContext => {
      const project =
        projectByKey.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? null;
      const cwd = resolveThreadGitCwd(thread);
      const gitStatus =
        cwd === null ? null : (gitStatuses.get(boardGitKey(thread.environmentId, cwd)) ?? null);
      return {
        project,
        gitStatus,
        gitStatusPending: cwd !== null && gitStatus === null,
      };
    },
    [gitStatuses, projectByKey, resolveThreadGitCwd],
  );

  // now is quantized to the minute so effectiveSettled memoization doesn't
  // churn on every render; auto-settle thresholds are day-granular anyway.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  useEffect(() => {
    const id = window.setInterval(
      () => setNowMinute(new Date().toISOString().slice(0, 16)),
      60_000,
    );
    return () => window.clearInterval(id);
  }, []);

  // Mirrors the sidebar's partition so board and sidebar always agree on what
  // is settled. Threads on servers without the settlement capability never
  // classify as settled: the user could neither un-settle nor pin them.
  const settledThreadKeys = useMemo(() => {
    const now = `${nowMinute}:00.000Z`;
    const keys = new Set<string>();
    for (const thread of filteredThreads) {
      const supportsSettlement =
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true;
      if (!supportsSettlement) {
        continue;
      }
      const changeRequestState =
        resolveBoardThreadPr({
          threadBranch: thread.branch,
          hasDedicatedWorktree: thread.worktreePath != null,
          gitStatus: getThreadGitContext(thread).gitStatus,
        })?.state ?? null;
      if (effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState })) {
        keys.add(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
      }
    }
    return keys;
  }, [autoSettleAfterDays, filteredThreads, getThreadGitContext, nowMinute, serverConfigs]);

  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const threadStatusLabelByKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          const threadStatusLabel = resolveThreadStatusPill({
            thread: {
              ...thread,
              lastVisitedAt: threadLastVisitedAtById[threadKey],
            },
          })?.label;
          return [threadKey, threadStatusLabel ?? null] as const;
        }),
      ),
    [threadLastVisitedAtById, threads],
  );
  const workingWorktreeKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const thread of threads) {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const statusLabel = threadStatusLabelByKey.get(threadKey);
      if (statusLabel !== "Working" && statusLabel !== "Connecting") {
        continue;
      }
      const cwd = resolveThreadGitCwd(thread);
      if (cwd !== null) {
        keys.add(boardGitKey(thread.environmentId, cwd));
      }
    }
    return keys;
  }, [resolveThreadGitCwd, threadStatusLabelByKey, threads]);
  const columns = useMemo(
    () =>
      buildBoardColumns(
        filteredThreads,
        (thread) => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          const lastVisitedAt = threadLastVisitedAtById[threadKey];
          const cwd = resolveThreadGitCwd(thread);

          return deriveBoardColumn({
            threadStatusLabel: threadStatusLabelByKey.get(threadKey) ?? null,
            interactionMode: thread.interactionMode,
            isSettled: settledThreadKeys.has(threadKey),
            latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
            readySessionUpdatedAt:
              thread.latestTurn === null && thread.session?.status === "ready"
                ? thread.session.updatedAt
                : null,
            lastVisitedAt: lastVisitedAt ?? null,
            threadBranch: thread.branch,
            hasDedicatedWorktree: thread.worktreePath != null,
            hasWorkingThreadForWorktree:
              cwd !== null && workingWorktreeKeys.has(boardGitKey(thread.environmentId, cwd)),
            gitStatus: getThreadGitContext(thread).gitStatus,
          });
        },
        (thread) =>
          thread.session?.status === "running" &&
          thread.latestTurn?.turnId === thread.session.activeTurnId
            ? (thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt)
            : null,
        boardWorktreeKey,
      ),
    [
      filteredThreads,
      getThreadGitContext,
      resolveThreadGitCwd,
      settledThreadKeys,
      threadLastVisitedAtById,
      threadStatusLabelByKey,
      workingWorktreeKeys,
    ],
  );

  const dragClickGuard = useMemo(() => createBoardDragClickGuard(), []);
  useEffect(() => () => dragClickGuard.dispose(), [dragClickGuard]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropIntent, setDropIntent] = useState<BoardDropIntent | null>(null);
  const activeThread = useMemo(
    () =>
      activeDragId === null || parseBoardWorktreeGroupDragId(activeDragId) !== null
        ? null
        : (filteredThreads.find(
            (thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeDragId,
          ) ?? null),
    [activeDragId, filteredThreads],
  );
  const activeWorktreeGroup = useMemo(() => {
    const worktreeKey = parseBoardWorktreeGroupDragId(activeDragId);
    if (worktreeKey === null) {
      return null;
    }
    for (const columnId of BOARD_COLUMN_IDS) {
      for (const item of columns[columnId]) {
        if (item.kind === "worktreeGroup" && item.worktreeKey === worktreeKey) {
          return item;
        }
      }
    }
    return null;
  }, [activeDragId, columns]);
  const activeDragIncludesSettledThread = useMemo(() => {
    if (activeDragId === null) {
      return false;
    }
    if (activeWorktreeGroup !== null) {
      return activeWorktreeGroup.threads.some((thread) =>
        settledThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      );
    }
    return settledThreadKeys.has(activeDragId);
  }, [activeDragId, activeWorktreeGroup, settledThreadKeys]);

  // Touch drags require a long-press so swipe gestures keep scrolling the
  // board; a distance-only constraint would claim every swipe as a drag.
  const dndSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      dragClickGuard.startDrag();
      setActiveDragId(String(event.active.id));
    },
    [dragClickGuard],
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setDropIntent(resolveBoardDropIntent(event.over?.id));
  }, []);

  const handleDragCancel = useCallback(() => {
    dragClickGuard.finishDrag();
    setActiveDragId(null);
    setDropIntent(null);
  }, [dragClickGuard]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      dragClickGuard.finishDrag();
      setActiveDragId(null);
      setDropIntent(null);
      const dragData = event.active.data.current as
        | {
            threadRef?: ScopedThreadRef;
            worktreeGroupThreadRefs?: readonly ScopedThreadRef[];
          }
        | undefined;
      const threadRefs =
        dragData?.worktreeGroupThreadRefs ?? (dragData?.threadRef ? [dragData.threadRef] : []);
      if (threadRefs.length === 0) {
        return;
      }
      const intent = resolveBoardDropIntent(event.over?.id);
      if (intent === null) {
        return;
      }

      if (intent === "settle") {
        // Dropping onto the column a settled card already lives in is a no-op.
        const refsToSettle = threadRefs.filter(
          (threadRef) => !settledThreadKeys.has(scopedThreadKey(threadRef)),
        );
        if (refsToSettle.length === 0) {
          return;
        }
        // Success is silent: the card moves when the shell update streams in.
        void Promise.all(refsToSettle.map((threadRef) => settleThread(threadRef))).then(
          (results) => {
            const failure = results.find(
              (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
            );
            if (failure !== undefined && failure._tag === "Failure") {
              const error = squashAtomCommandFailure(failure);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title:
                    refsToSettle.length === 1
                      ? "Failed to settle thread"
                      : "Failed to settle threads",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
          },
        );
        return;
      }

      if (intent === "unsettle") {
        // The restore zone only shows for settled drags; skip any group
        // members that are already active.
        const refsToRestore = threadRefs.filter((threadRef) =>
          settledThreadKeys.has(scopedThreadKey(threadRef)),
        );
        if (refsToRestore.length === 0) {
          return;
        }
        // Success is silent: the card moves when the shell update streams in.
        void Promise.all(refsToRestore.map((threadRef) => unsettleThread(threadRef))).then(
          (results) => {
            const failure = results.find(
              (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
            );
            if (failure !== undefined && failure._tag === "Failure") {
              const error = squashAtomCommandFailure(failure);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title:
                    refsToRestore.length === 1
                      ? "Failed to restore thread"
                      : "Failed to restore threads",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
          },
        );
        return;
      }

      if (intent === "trash") {
        void confirmAndDeleteThreads(threadRefs).then((result) => {
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  threadRefs.length === 1 ? "Failed to delete thread" : "Failed to delete threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        });
        return;
      }

      void archiveSelectedThreadEntries({
        entries: threadRefs.map((threadRef) => ({
          threadKey: scopedThreadKey(threadRef),
          threadRef,
        })),
        archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
      }).then((outcome) => {
        for (const failure of outcome.followupFailures) {
          if (isAtomCommandInterrupted(failure)) {
            continue;
          }
          const error = squashAtomCommandFailure(failure);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Thread archived, but navigation failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        if (outcome.mutationFailure && !isAtomCommandInterrupted(outcome.mutationFailure)) {
          const error = squashAtomCommandFailure(outcome.mutationFailure);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title:
                threadRefs.length === 1 ? "Failed to archive thread" : "Failed to archive threads",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      });
    },
    [
      archiveThread,
      confirmAndDeleteThreads,
      dragClickGuard,
      settledThreadKeys,
      settleThread,
      unsettleThread,
    ],
  );

  const handleOpenThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate],
  );

  const closeThreadRenameDialog = useCallback(() => {
    setThreadRenameTarget(null);
    setThreadRenameTitle("");
  }, []);

  const submitThreadRename = useCallback(async () => {
    if (threadRenameTarget === null) {
      return;
    }

    const trimmed = threadRenameTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Thread title cannot be empty",
      });
      return;
    }
    if (trimmed === threadRenameTarget.title) {
      closeThreadRenameDialog();
      return;
    }

    const result = await updateThreadMetadata({
      environmentId: threadRenameTarget.environmentId,
      input: {
        threadId: threadRenameTarget.id,
        title: trimmed,
      },
    });
    if (result._tag === "Success") {
      closeThreadRenameDialog();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [closeThreadRenameDialog, threadRenameTarget, threadRenameTitle, updateThreadMetadata]);

  const handleThreadContextMenu = useCallback(
    async (thread: SidebarThreadSummary, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const threadKey = scopedThreadKey(threadRef);
      const supportsSettlement =
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true;
      const isSettled = settledThreadKeys.has(threadKey);
      const clicked = await api.contextMenu.show(
        buildSidebarV2ThreadContextMenuItems({ supportsSettlement, isSettled }),
        position,
      );

      if (clicked === "settle" || clicked === "unsettle") {
        const result =
          clicked === "settle" ? await settleThread(threadRef) : await unsettleThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title:
                clicked === "settle" ? "Failed to settle thread" : "Failed to un-settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "rename") {
        setThreadRenameTarget(thread);
        setThreadRenameTitle(thread.title);
        return;
      }
      if (clicked === "mark-unread") {
        markThreadUnread(threadKey, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked !== "delete") {
        return;
      }

      const result = await confirmAndDeleteThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [
      confirmAndDeleteThread,
      markThreadUnread,
      serverConfigs,
      settledThreadKeys,
      settleThread,
      unsettleThread,
    ],
  );

  const showThreadContextMenu = useCallback(
    (thread: SidebarThreadSummary, position: { x: number; y: number }) => {
      void settlePromise(() => handleThreadContextMenu(thread, position)).then((result) => {
        if (result._tag === "Success") {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thread action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
    },
    [handleThreadContextMenu],
  );

  const projectFilterItems = useMemo(
    () => [
      { value: BOARD_PROJECT_FILTER_ALL, label: "All projects" },
      ...projectSnapshots.map((snapshot) => ({
        value: snapshot.projectKey,
        label: snapshot.displayName,
      })),
    ],
    [projectSnapshots],
  );
  const selectedFilterValue =
    storedProjectFilter !== null &&
    projectSnapshots.some((snapshot) => snapshot.projectKey === storedProjectFilter)
      ? storedProjectFilter
      : BOARD_PROJECT_FILTER_ALL;
  const selectedFilterSnapshot =
    selectedFilterValue === BOARD_PROJECT_FILTER_ALL
      ? null
      : (projectSnapshots.find((snapshot) => snapshot.projectKey === selectedFilterValue) ?? null);

  return (
    <>
      {/* .workspace-topbar pins the header to --workspace-topbar-height so the
          floating sidebar toggle (absolutely positioned in that same band)
          stays vertically aligned with the title at every breakpoint. */}
      <header
        className={cn(
          "workspace-topbar gap-2 border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
          isElectron && "drag-region",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <span className="truncate text-sm font-medium text-foreground">Board</span>
        <div className="ms-auto flex min-w-0 items-center gap-2 wco:pr-[var(--workspace-native-controls-inset)]">
          <Select
            modal={false}
            value={selectedFilterValue}
            onValueChange={(value) => {
              setStoredProjectFilter(value === BOARD_PROJECT_FILTER_ALL ? null : (value as string));
            }}
            items={projectFilterItems}
          >
            <SelectTrigger
              size="sm"
              className="w-40 min-w-0 sm:w-52"
              aria-label="Filter by project"
              data-testid="board-project-filter"
            >
              <SelectValue>
                <span className="flex min-w-0 items-center gap-1.5">
                  {selectedFilterSnapshot ? (
                    <ProjectFavicon
                      environmentId={selectedFilterSnapshot.environmentId}
                      cwd={selectedFilterSnapshot.workspaceRoot}
                    />
                  ) : (
                    <ProjectFaviconFallback />
                  )}
                  <span className="truncate">
                    {selectedFilterSnapshot?.displayName ?? "All projects"}
                  </span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={BOARD_PROJECT_FILTER_ALL}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <ProjectFaviconFallback />
                  <span className="truncate">All projects</span>
                </span>
              </SelectItem>
              {projectSnapshots.map((snapshot) => (
                <SelectItem key={snapshot.projectKey} value={snapshot.projectKey}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ProjectFavicon
                      environmentId={snapshot.environmentId}
                      cwd={snapshot.workspaceRoot}
                    />
                    <span className="truncate">{snapshot.displayName}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </header>
      <DndContext
        sensors={dndSensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <div className="relative min-h-0 flex-1">
          <div
            ref={boardScrollRef}
            data-testid="board-scroll-area"
            className="h-full overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            <div
              data-testid="board-column-row"
              className="flex h-full w-full min-w-max justify-center gap-3 p-3 sm:p-4"
            >
              {BOARD_COLUMN_IDS.map((columnId) => (
                <BoardColumn
                  key={columnId}
                  columnId={columnId}
                  count={countBoardColumnThreads(columns[columnId])}
                >
                  {columns[columnId].map((item) => {
                    const renderCard = (thread: SidebarThreadSummary) => {
                      const gitContext = getThreadGitContext(thread);
                      const threadKey = scopedThreadKey(
                        scopeThreadRef(thread.environmentId, thread.id),
                      );
                      return (
                        <BoardCard
                          key={threadKey}
                          thread={thread}
                          project={gitContext.project}
                          gitStatus={gitContext.gitStatus}
                          gitStatusPending={gitContext.gitStatusPending}
                          isSettled={settledThreadKeys.has(threadKey)}
                          onOpenThread={handleOpenThread}
                          onShowContextMenu={showThreadContextMenu}
                          dragClickGuard={dragClickGuard}
                        />
                      );
                    };
                    if (item.kind === "thread") {
                      return renderCard(item.thread);
                    }
                    const [mostRecentThread, ...olderThreads] = item.threads;
                    return (
                      <BoardWorktreeGroup
                        key={item.worktreeKey}
                        worktreeKey={item.worktreeKey}
                        threadRefs={item.threads.map((thread) =>
                          scopeThreadRef(thread.environmentId, thread.id),
                        )}
                        worktreePath={mostRecentThread?.worktreePath ?? ""}
                        branch={mostRecentThread?.branch ?? null}
                        threadCount={item.threads.length}
                        mostRecentCard={mostRecentThread ? renderCard(mostRecentThread) : null}
                        dragClickGuard={dragClickGuard}
                      >
                        {olderThreads.map(renderCard)}
                      </BoardWorktreeGroup>
                    );
                  })}
                </BoardColumn>
              ))}
            </div>
          </div>
          {activeDragId !== null ? (
            <BoardDropZones showRestoreZone={activeDragIncludesSettledThread} />
          ) : null}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeWorktreeGroup !== null ? (
            <BoardWorktreeGroupDragOverlay
              worktreePath={activeWorktreeGroup.threads[0]?.worktreePath ?? ""}
              branch={activeWorktreeGroup.threads[0]?.branch ?? null}
              threadCount={activeWorktreeGroup.threads.length}
              dropIntent={dropIntent}
            />
          ) : activeThread !== null ? (
            <BoardCardDragOverlay
              thread={activeThread}
              project={getThreadGitContext(activeThread).project}
              gitStatus={getThreadGitContext(activeThread).gitStatus}
              gitStatusPending={getThreadGitContext(activeThread).gitStatusPending}
              isSettled={settledThreadKeys.has(
                scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id)),
              )}
              dropIntent={dropIntent}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      <Dialog
        open={threadRenameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeThreadRenameDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename thread</DialogTitle>
            <DialogDescription>Update the title shown for this thread.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Thread title</span>
              <Input
                autoFocus
                aria-label="Thread title"
                value={threadRenameTitle}
                onChange={(event) => setThreadRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitThreadRename();
                  }
                }}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeThreadRenameDialog}>
              Cancel
            </Button>
            <Button onClick={() => void submitThreadRename()}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
