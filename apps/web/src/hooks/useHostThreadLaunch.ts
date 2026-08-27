/**
 * Host threads — a real chat at the machine root, no worktree. The composer's
 * `!` prefix and the error log's Fix it button both open one, so the project
 * bootstrap, the thread, its first turn and the canvas navigation live here
 * once.
 *
 * @module useHostThreadLaunch
 */
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInstanceId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import {
  deriveHostThreadTitle,
  HOST_PROJECT_TITLE,
  HOST_ROOT_PATH,
} from "../components/kanban/hostPrompt";
import { useComposerModelPreset } from "../components/kanban/ComposerModelPreset";
import { stationKey } from "../components/canvas/panels/panelStations";
import { findProjectByPath } from "../lib/projectPaths";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { guardDefaultModelSelection } from "../providerModels";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { newMessageId, newProjectId, newThreadId } from "../lib/utils";
import { usePrimarySettings } from "./useSettings";

/** A host thread is a real chat, so it needs a model: composer preset, else the default. */
export function useHostModelSelection(): ModelSelection {
  const settings = usePrimarySettings();
  const providerStatuses = useAtomValue(primaryServerProvidersAtom);
  const { selection: presetSelection } = useComposerModelPreset();

  const providerInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );

  return useMemo(() => {
    if (presetSelection) {
      return createModelSelection(presetSelection.instanceId, presetSelection.model);
    }
    const fallback = providerInstanceEntries[0];
    const guarded = guardDefaultModelSelection(settings.defaultModelSelection, providerStatuses);
    const instanceId = guarded?.instanceId ?? fallback?.instanceId ?? "codex";
    const model = guarded?.model ?? fallback?.models[0]?.slug ?? "";
    return createModelSelection(ProviderInstanceId.make(String(instanceId)), model);
  }, [presetSelection, providerInstanceEntries, providerStatuses, settings.defaultModelSelection]);
}

export interface HostThreadLaunchInput {
  readonly text: string;
  /** Overrides the title derived from the first line. */
  readonly title?: string;
  /** Open the thread's canvas panel. On by default. */
  readonly navigateToThread?: boolean;
}

export interface HostThreadLaunch {
  readonly environmentId: ReturnType<typeof usePrimaryEnvironmentId>;
  readonly launch: (input: HostThreadLaunchInput) => Promise<ThreadId>;
}

export function useHostThreadLaunch(): HostThreadLaunch {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const navigate = useNavigate();
  const modelSelection = useHostModelSelection();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const launch = useCallback(
    async ({ text, title, navigateToThread = true }: HostThreadLaunchInput): Promise<ThreadId> => {
      if (environmentId === null) {
        throw new Error("Connect an environment before starting a host thread.");
      }

      const existingHostProject = findProjectByPath(
        projects.filter((project) => project.environmentId === environmentId),
        HOST_ROOT_PATH,
      );
      let hostProjectId = existingHostProject?.id;
      if (!hostProjectId) {
        const projectId = newProjectId();
        const projectResult = await createProject({
          environmentId,
          input: {
            projectId,
            title: HOST_PROJECT_TITLE,
            workspaceRoot: HOST_ROOT_PATH,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: modelSelection,
          },
        });
        if (projectResult._tag === "Failure") throw squashAtomCommandFailure(projectResult);
        hostProjectId = projectId;
      }

      const threadId = newThreadId() as ThreadId;
      const createdAt = new Date().toISOString();
      const createResult = await createThread({
        environmentId,
        input: {
          threadId,
          projectId: hostProjectId,
          title: title ?? deriveHostThreadTitle(text),
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        },
      });
      if (createResult._tag === "Failure") throw squashAtomCommandFailure(createResult);

      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments: [],
          },
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        },
      });
      if (startResult._tag === "Failure") throw squashAtomCommandFailure(startResult);

      // The thread opens where the board is — its own canvas panel — rather
      // than replacing it with a route.
      if (navigateToThread) {
        await navigate({
          to: "/kanban",
          search: { station: stationKey({ kind: "thread", entityId: threadId }) },
        });
      }

      return threadId;
    },
    [
      createProject,
      createThread,
      environmentId,
      modelSelection,
      navigate,
      projects,
      startThreadTurn,
    ],
  );

  return { environmentId, launch };
}
