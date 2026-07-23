import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getWorktreeRemovalAction, ThreadArchiveBlockedError } from "./useThreadActions";

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("getWorktreeRemovalAction", () => {
  it("asks before removing an orphaned worktree when confirmation is enabled", () => {
    expect(
      getWorktreeRemovalAction({
        canRemoveWorktree: true,
        confirmWorktreeRemoval: true,
      }),
    ).toBe("confirm");
  });

  it("removes an orphaned worktree directly when confirmation is disabled", () => {
    expect(
      getWorktreeRemovalAction({
        canRemoveWorktree: true,
        confirmWorktreeRemoval: false,
      }),
    ).toBe("remove");
  });

  it("does not remove a worktree that is still in use", () => {
    expect(
      getWorktreeRemovalAction({
        canRemoveWorktree: false,
        confirmWorktreeRemoval: false,
      }),
    ).toBe("skip");
  });
});
