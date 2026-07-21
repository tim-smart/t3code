import { useDraggable } from "@dnd-kit/core";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon, FolderGit2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { boardWorktreeGroupDragId, type BoardDropIntent } from "./Board.logic";
import type { BoardDragClickGuard } from "./BoardDragClickGuard";

function resolveWorktreeGroupLabel(worktreePath: string, branch: string | null): string {
  return branch?.trim() || formatWorktreePathForDisplay(worktreePath);
}

/**
 * Column entry stacking a worktree's threads behind one collapsed header.
 * The most recent card stays visible even while collapsed; the header button
 * reveals the older member cards in place. Dragging the header drags the
 * whole group: a drop zone action applies to every member thread.
 */
export function BoardWorktreeGroup({
  worktreeKey,
  threadRefs,
  worktreePath,
  branch,
  threadCount,
  mostRecentCard,
  dragClickGuard,
  children,
}: {
  worktreeKey: string;
  threadRefs: readonly ScopedThreadRef[];
  worktreePath: string;
  branch: string | null;
  threadCount: number;
  mostRecentCard: ReactNode;
  dragClickGuard: BoardDragClickGuard;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: boardWorktreeGroupDragId(worktreeKey),
    data: { worktreeGroupThreadRefs: threadRefs },
  });
  const displayLabel = resolveWorktreeGroupLabel(worktreePath, branch);

  return (
    <section
      data-testid="board-worktree-group"
      aria-label={`Worktree ${displayLabel}`}
      className={cn(
        "flex flex-col rounded-lg border border-border/55 bg-muted/40",
        isDragging && "opacity-40",
      )}
    >
      <button
        ref={setNodeRef}
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          if (dragClickGuard.consumeSuppressedClick()) {
            return;
          }
          setExpanded((current) => !current);
        }}
        className="flex cursor-pointer touch-manipulation items-center gap-1.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        {...attributes}
        {...listeners}
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
        <FolderGit2Icon className="size-3 shrink-0 text-muted-foreground/40" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/70">
          {displayLabel}
        </span>
        <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
          {threadCount}
        </span>
      </button>
      <div className="flex flex-col gap-2 px-2 pb-2">
        {mostRecentCard}
        {expanded ? children : null}
      </div>
    </section>
  );
}

/** Non-interactive header clone rendered inside the DragOverlay while dragging a group. */
export function BoardWorktreeGroupDragOverlay({
  worktreePath,
  branch,
  threadCount,
  dropIntent = null,
}: {
  worktreePath: string;
  branch: string | null;
  threadCount: number;
  dropIntent?: BoardDropIntent | null;
}) {
  const displayLabel = resolveWorktreeGroupLabel(worktreePath, branch);

  return (
    <div
      aria-hidden="true"
      data-drop-intent={dropIntent ?? undefined}
      className={cn(
        "pointer-events-none flex w-64 items-center gap-1.5 rounded-lg border border-border/55 bg-muted px-2.5 py-2 shadow-lg transition-[opacity,scale,border-color] duration-150",
        dropIntent === "archive" && "scale-90 border-amber-500 opacity-60",
        dropIntent === "trash" && "scale-90 border-destructive opacity-60",
        dropIntent === "settle" && "scale-90 border-primary opacity-60",
        dropIntent === "unsettle" && "scale-90 border-emerald-500 opacity-60",
      )}
    >
      <FolderGit2Icon className="size-3 shrink-0 text-muted-foreground/40" />
      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/70">
        {displayLabel}
      </span>
      <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-background/70 px-1 text-[10px] tabular-nums text-muted-foreground">
        {threadCount}
      </span>
    </div>
  );
}
