import { useDroppable } from "@dnd-kit/core";
import { ArchiveIcon, ArchiveRestoreIcon, Trash2Icon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  BOARD_ARCHIVE_DROPPABLE_ID,
  BOARD_TRASH_DROPPABLE_ID,
  BOARD_UNSETTLE_DROPPABLE_ID,
} from "./Board.logic";

/**
 * Floating droppables shown while a drag is active: archive and delete are
 * always available, and restore (un-settle) appears when the drag includes a
 * settled thread. Columns are derived state, so settling happens by dropping
 * on the Settled column itself rather than a zone here.
 */
export function BoardDropZones({ showRestoreZone }: { showRestoreZone: boolean }) {
  const restore = useDroppable({ id: BOARD_UNSETTLE_DROPPABLE_ID, disabled: !showRestoreZone });
  const archive = useDroppable({ id: BOARD_ARCHIVE_DROPPABLE_ID });
  const trash = useDroppable({ id: BOARD_TRASH_DROPPABLE_ID });

  return (
    // w-max: shrink-to-fit against left:50% would otherwise cap the width at
    // half the board and wrap the labels on narrow viewports.
    <div className="absolute bottom-6 left-1/2 z-20 flex w-max -translate-x-1/2 items-center gap-2 sm:gap-3">
      {showRestoreZone ? (
        <div
          ref={restore.setNodeRef}
          data-testid="board-restore-zone"
          aria-label="Drop to restore"
          className={cn(
            "flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur transition-colors sm:px-5",
            restore.isOver
              ? "border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300/90"
              : "border-border bg-background/90 text-muted-foreground",
          )}
        >
          <ArchiveRestoreIcon className="size-4" />
          <span className="hidden sm:inline">Drop to restore</span>
        </div>
      ) : null}
      <div
        ref={archive.setNodeRef}
        data-testid="board-archive-zone"
        aria-label="Drop to archive"
        className={cn(
          "flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur transition-colors sm:px-5",
          archive.isOver
            ? "border-amber-500 bg-amber-500/15 text-amber-600 dark:text-amber-300/90"
            : "border-border bg-background/90 text-muted-foreground",
        )}
      >
        <ArchiveIcon className="size-4" />
        <span className="hidden sm:inline">Drop to archive</span>
      </div>
      <div
        ref={trash.setNodeRef}
        data-testid="board-trash-zone"
        aria-label="Drop to delete"
        className={cn(
          "flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur transition-colors sm:px-5",
          trash.isOver
            ? "border-destructive bg-destructive/15 text-destructive"
            : "border-border bg-background/90 text-muted-foreground",
        )}
      >
        <Trash2Icon className="size-4" />
        <span className="hidden sm:inline">Drop to delete</span>
      </div>
    </div>
  );
}
