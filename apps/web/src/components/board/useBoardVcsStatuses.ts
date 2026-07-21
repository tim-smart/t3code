import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { vcsEnvironment } from "../../state/vcs";
import { boardGitKey } from "./Board.logic";

export interface BoardVcsTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

const EMPTY_STATUSES_ATOM = Atom.make(
  (): ReadonlyMap<string, VcsStatusResult | null> => new Map(),
).pipe(Atom.withLabel("web:board-vcs-statuses:empty"));

/**
 * Aggregated VCS status subscription for the board: one derived atom over the
 * per-cwd status subscription family, read with a single useAtomValue. The
 * family dedupes identical (environmentId, cwd) keys into one WS subscription
 * and keeps entries warm for 5 minutes after last use, so filter toggles
 * don't churn subscriptions. Entries are `null` until the first snapshot
 * streams in.
 */
export function useBoardVcsStatuses(
  targets: ReadonlyArray<BoardVcsTarget>,
): ReadonlyMap<string, VcsStatusResult | null> {
  const dedupedTargets = useMemo(() => {
    const byKey = new Map<string, BoardVcsTarget>();
    for (const target of targets) {
      byKey.set(boardGitKey(target.environmentId, target.cwd), target);
    }
    return [...byKey.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  }, [targets]);

  const statusesAtom = useMemo(() => {
    if (dedupedTargets.length === 0) {
      return EMPTY_STATUSES_ATOM;
    }
    return Atom.make(
      (get): ReadonlyMap<string, VcsStatusResult | null> =>
        new Map(
          dedupedTargets.map(([key, target]) => [
            key,
            Option.getOrNull(
              AsyncResult.value(
                get(
                  vcsEnvironment.status({
                    environmentId: target.environmentId,
                    input: { cwd: target.cwd },
                  }),
                ),
              ),
            ),
          ]),
        ),
    ).pipe(Atom.withLabel(`web:board-vcs-statuses:${dedupedTargets.length}`));
  }, [dedupedTargets]);

  return useAtomValue(statusesAtom);
}
