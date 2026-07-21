import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const DIRENV_MAX_OUTPUT_BYTES = 64 * 1024;
const DIRENV_TIMEOUT = "30 seconds";
const STDERR_DETAIL_MAX_LENGTH = 2_048;
const decodeUnknownJson = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);

export class DirenvEnvironmentError extends Schema.TaggedErrorClass<DirenvEnvironmentError>()(
  "DirenvEnvironmentError",
  {
    stage: Schema.Literals(["inspection", "execution", "invalid-output"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve direnv environment during ${this.stage}: ${this.detail}`;
  }
}

export class DirenvEnvironment extends Context.Service<
  DirenvEnvironment,
  {
    readonly allow: (input: {
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<void, DirenvEnvironmentError>;
    readonly resolve: (input: {
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<NodeJS.ProcessEnv, DirenvEnvironmentError>;
  }
>()("t3/provider/DirenvEnvironment") {}

export const identityDirenvEnvironmentResolver: DirenvEnvironment["Service"]["resolve"] = (input) =>
  Effect.succeed(input.environment);

export const noopDirenvEnvironmentAllow: DirenvEnvironment["Service"]["allow"] = () => Effect.void;

function conciseStderr(stderr: string, environment: NodeJS.ProcessEnv): string | undefined {
  let redacted = stderr;
  const environmentValues = Array.from(
    new Set(
      Object.values(environment).filter(
        (value): value is string => typeof value === "string" && value.length >= 4,
      ),
    ),
  ).sort((left, right) => right.length - left.length);
  for (const value of environmentValues) {
    redacted = redacted.split(value).join("[redacted]");
  }

  const normalized = redacted.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length <= STDERR_DETAIL_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, STDERR_DETAIL_MAX_LENGTH)}…`;
}

function isDirenvEnvironmentPatch(value: unknown): value is Record<string, string | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string" || entry === null);
}

export const make = Effect.fn("DirenvEnvironment.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  /** Approves only the `.envrc` at the root of a worktree T3 just created. */
  const allow: DirenvEnvironment["Service"]["allow"] = Effect.fn("DirenvEnvironment.allow")(
    function* (input) {
      const cwd = path.resolve(input.cwd);
      const envrcPath = path.join(cwd, ".envrc");
      const exists = yield* fileSystem.exists(envrcPath).pipe(
        Effect.mapError(
          (cause) =>
            new DirenvEnvironmentError({
              stage: "inspection",
              detail: `Could not inspect '${envrcPath}'.`,
              cause,
            }),
        ),
      );
      if (!exists) return;

      const direnvPath = yield* resolveCommandPath("direnv", { env: input.environment }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchTag("CommandResolutionError", () => Effect.void),
      );
      if (direnvPath === undefined) return;

      const output = yield* processRunner
        .run({
          command: direnvPath,
          args: ["allow", envrcPath],
          cwd,
          env: input.environment,
          extendEnv: false,
          maxOutputBytes: DIRENV_MAX_OUTPUT_BYTES,
          timeout: DIRENV_TIMEOUT,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DirenvEnvironmentError({
                stage: "execution",
                detail: "Could not execute direnv allow.",
                cause,
              }),
          ),
        );

      if (output.code !== 0) {
        const stderr = conciseStderr(output.stderr, input.environment);
        return yield* new DirenvEnvironmentError({
          stage: "execution",
          detail: stderr
            ? `direnv allow exited unsuccessfully: ${stderr}`
            : "direnv allow exited unsuccessfully.",
        });
      }
    },
  );

  const findNearestEnvrc = Effect.fn("DirenvEnvironment.findNearestEnvrc")(function* (
    cwd: string,
  ): Effect.fn.Return<string | undefined, DirenvEnvironmentError> {
    let directory = path.resolve(cwd);
    while (true) {
      const candidate = path.join(directory, ".envrc");
      const exists = yield* fileSystem.exists(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new DirenvEnvironmentError({
              stage: "inspection",
              detail: `Could not inspect '${candidate}'.`,
              cause,
            }),
        ),
      );
      if (exists) return candidate;

      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  });

  const resolve: DirenvEnvironment["Service"]["resolve"] = Effect.fn("DirenvEnvironment.resolve")(
    function* (input) {
      const envrcPath = yield* findNearestEnvrc(input.cwd);
      if (envrcPath === undefined) return input.environment;

      const direnvPath = yield* resolveCommandPath("direnv", { env: input.environment }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchTag("CommandResolutionError", () => Effect.void),
      );
      if (direnvPath === undefined) return input.environment;

      const output = yield* processRunner
        .run({
          command: direnvPath,
          args: ["export", "json"],
          cwd: input.cwd,
          env: input.environment,
          extendEnv: false,
          maxOutputBytes: DIRENV_MAX_OUTPUT_BYTES,
          timeout: DIRENV_TIMEOUT,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DirenvEnvironmentError({
                stage: "execution",
                detail: "Could not execute direnv.",
                cause,
              }),
          ),
        );

      if (output.code !== 0) {
        const stderr = conciseStderr(output.stderr, input.environment);
        return yield* new DirenvEnvironmentError({
          stage: "execution",
          detail: stderr
            ? `direnv exited unsuccessfully: ${stderr}`
            : "direnv exited unsuccessfully.",
        });
      }

      const decodedExit = decodeUnknownJson(output.stdout);
      if (Exit.isFailure(decodedExit)) {
        return yield* new DirenvEnvironmentError({
          stage: "invalid-output",
          detail: "direnv returned invalid JSON.",
        });
      }
      const decoded = decodedExit.value;
      if (!isDirenvEnvironmentPatch(decoded)) {
        return yield* new DirenvEnvironmentError({
          stage: "invalid-output",
          detail: "direnv returned an invalid environment patch.",
        });
      }

      const entries = Object.entries(decoded);
      if (entries.length === 0) return input.environment;

      const resolvedEnvironment = { ...input.environment };
      for (const [name, value] of entries) {
        if (value === null) {
          delete resolvedEnvironment[name];
        } else {
          resolvedEnvironment[name] = value;
        }
      }
      return resolvedEnvironment;
    },
  );

  return DirenvEnvironment.of({ allow, resolve });
});

export const layer = Layer.effect(DirenvEnvironment, make());
