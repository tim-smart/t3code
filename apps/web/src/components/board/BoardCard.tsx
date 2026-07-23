import { useDraggable } from "@dnd-kit/core";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import { memo, useMemo, type MouseEvent, type PointerEvent } from "react";

import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { cn } from "../../lib/utils";
import { getProviderInstanceEntry } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { Project, SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarV2Status,
  resolveSidebarV2TopStatus,
} from "../Sidebar.logic";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  ThreadPlanModeIndicator,
  ThreadSettledIndicator,
  ThreadStatusV2Indicator,
  ThreadWorktreeIndicator,
} from "../ThreadStatusIndicators";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  resolveAppliedBoardGitStatus,
  resolveBoardThreadPr,
  type BoardDropIntent,
} from "./Board.logic";
import type { BoardDragClickGuard } from "./BoardDragClickGuard";

export interface BoardCardProps {
  thread: SidebarThreadSummary;
  project: Project | null;
  gitStatus: VcsStatusResult | null;
  gitStatusPending: boolean;
  isSettled: boolean;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onShowContextMenu: (thread: SidebarThreadSummary, position: { x: number; y: number }) => void;
  dragClickGuard: BoardDragClickGuard;
}

const BOARD_CARD_CLASS =
  "flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 shadow-sm select-none";

type BoardCardBodyProps = Pick<
  BoardCardProps,
  "thread" | "project" | "gitStatus" | "gitStatusPending" | "isSettled"
> &
  (
    | {
        interactive: true;
        draggableAttributes: ReturnType<typeof useDraggable>["attributes"];
        onOpenThread: (event: MouseEvent<HTMLButtonElement>) => void;
      }
    | {
        interactive: false;
      }
  );

function BoardCardBody({
  thread,
  project,
  gitStatus,
  gitStatusPending,
  isSettled,
  ...rendering
}: BoardCardBodyProps) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const openPrLink = useOpenPrLink();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const driverKind = getProviderInstanceEntry(serverProviders, modelInstanceId)?.driverKind ?? null;

  const appliedGitStatus = resolveAppliedBoardGitStatus({
    threadBranch: thread.branch,
    hasDedicatedWorktree: thread.worktreePath != null,
    gitStatus,
  });
  const pr = resolveBoardThreadPr({
    threadBranch: thread.branch,
    hasDedicatedWorktree: thread.worktreePath != null,
    gitStatus,
  });
  const prStatus = prStatusIndicator(pr, appliedGitStatus?.sourceControlProvider);
  const topStatus = resolveSidebarV2TopStatus({
    status: resolveSidebarV2Status(thread),
    isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
  });
  const relativeTimeLabel = formatRelativeTimeLabel(
    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
  const dirtyFileCount = appliedGitStatus?.hasWorkingTreeChanges
    ? appliedGitStatus.workingTree.files.length
    : 0;
  const aheadCount = appliedGitStatus?.aheadCount ?? 0;

  return (
    <>
      <div className="flex items-center gap-1.5">
        {project ? (
          <ProjectFavicon environmentId={thread.environmentId} cwd={project.workspaceRoot} />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground/70">
          {project?.title ?? ""}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground/40">
          {relativeTimeLabel}
        </span>
      </div>
      {rendering.interactive ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Open thread: ${thread.title}`}
                data-testid={`board-card-open-${thread.id}`}
                className="line-clamp-2 w-full cursor-pointer text-left text-sm font-medium text-foreground focus-visible:outline-none"
                onClick={rendering.onOpenThread}
                {...rendering.draggableAttributes}
              />
            }
          >
            {thread.title}
          </TooltipTrigger>
          <TooltipPopup side="top">{thread.title}</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="line-clamp-2 text-sm font-medium text-foreground">{thread.title}</span>
      )}
      {thread.branch ? (
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/60">
            {thread.branch}
          </span>
          <ThreadWorktreeIndicator thread={thread} />
        </div>
      ) : null}
      <div className="flex min-h-4 items-center gap-2">
        {isSettled ? (
          <ThreadSettledIndicator thread={thread} isSettled={isSettled} className="text-xs" />
        ) : topStatus ? (
          <ThreadStatusV2Indicator status={topStatus} className="text-xs" />
        ) : null}
        {prStatus && pr ? (
          rendering.interactive ? (
            <button
              type="button"
              aria-label={prStatus.tooltip}
              title={prStatus.tooltip}
              className={cn(
                "inline-flex cursor-pointer items-center gap-0.5 text-xs tabular-nums hover:underline",
                prStatus.colorClass,
              )}
              onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
                event.stopPropagation();
              }}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                openPrLink(event, prStatus.url);
              }}
            >
              <ChangeRequestStatusIcon className="size-3" />#{pr.number}
            </button>
          ) : (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-xs tabular-nums",
                prStatus.colorClass,
              )}
            >
              <ChangeRequestStatusIcon className="size-3" />#{pr.number}
            </span>
          )
        ) : null}
        {dirtyFileCount > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground/60">
            {dirtyFileCount} {dirtyFileCount === 1 ? "file" : "files"}
          </span>
        ) : null}
        {aheadCount > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground/60">↑{aheadCount}</span>
        ) : null}
        {gitStatusPending ? (
          <Spinner className="size-3 text-muted-foreground/40" aria-label="Loading git status" />
        ) : null}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
          <ThreadPlanModeIndicator thread={thread} />
          {driverKind ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="inline-flex shrink-0 items-center opacity-60" />}
              >
                <ProviderInstanceIcon
                  driverKind={driverKind}
                  displayName={thread.session?.providerName ?? modelInstanceId}
                  iconClassName="size-3"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{thread.modelSelection.model}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      </div>
    </>
  );
}

export const BoardCard = memo(function BoardCard({
  thread,
  project,
  gitStatus,
  gitStatusPending,
  isSettled,
  onOpenThread,
  onShowContextMenu,
  dragClickGuard,
}: BoardCardProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: scopedThreadKey(threadRef),
    data: { threadRef },
  });

  const openThread = () => {
    if (dragClickGuard.consumeSuppressedClick()) {
      return;
    }
    onOpenThread(threadRef);
  };

  const showContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onShowContextMenu(thread, { x: event.clientX, y: event.clientY });
  };

  return (
    <div
      ref={setNodeRef}
      data-testid={`board-card-${thread.id}`}
      className={cn(
        BOARD_CARD_CLASS,
        "cursor-pointer touch-manipulation hover:bg-accent/50 focus-within:ring-1 focus-within:ring-ring focus-within:outline-none",
        isDragging && "opacity-40",
      )}
      onClick={openThread}
      onContextMenu={showContextMenu}
      {...listeners}
    >
      <BoardCardBody
        thread={thread}
        project={project}
        gitStatus={gitStatus}
        gitStatusPending={gitStatusPending}
        isSettled={isSettled}
        interactive
        draggableAttributes={attributes}
        onOpenThread={(event) => {
          event.stopPropagation();
          openThread();
        }}
      />
    </div>
  );
});

/** Non-interactive clone rendered inside the DragOverlay while dragging. */
export function BoardCardDragOverlay({
  thread,
  project,
  gitStatus,
  gitStatusPending,
  isSettled,
  dropIntent = null,
}: Pick<BoardCardProps, "thread" | "project" | "gitStatus" | "gitStatusPending" | "isSettled"> & {
  dropIntent?: BoardDropIntent | null;
}) {
  return (
    <div
      aria-hidden="true"
      data-drop-intent={dropIntent ?? undefined}
      className={cn(
        BOARD_CARD_CLASS,
        "pointer-events-none w-68 shadow-lg transition-[opacity,scale,border-color] duration-150",
        dropIntent === "archive" && "scale-90 border-amber-500 opacity-60",
        dropIntent === "trash" && "scale-90 border-destructive opacity-60",
        dropIntent === "settle" && "scale-90 border-primary opacity-60",
        dropIntent === "unsettle" && "scale-90 border-emerald-500 opacity-60",
      )}
    >
      <BoardCardBody
        thread={thread}
        project={project}
        gitStatus={gitStatus}
        gitStatusPending={gitStatusPending}
        isSettled={isSettled}
        interactive={false}
      />
    </div>
  );
}
