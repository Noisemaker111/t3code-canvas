import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { getProjectOrderKey } from "../logicalProject";
import { useProjects, useThread } from "../state/entities";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";

/**
 * Board-first: "new thread" shortcuts and sidebar/project entry points go to
 * `/kanban`. Capture is the board composer (prompt sent to Hermes), not an
 * empty DraftHero "New thread" page.
 */
export function useNewThreadHandler() {
  const router = useRouter();

  return useCallback(
    (
      _projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        startFromOrigin?: boolean;
        replace?: boolean;
      },
    ): Promise<void> => {
      return router.navigate({
        to: "/kanban",
        replace: options?.replace ?? false,
      });
    },
    [router],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();
  const defaultProject =
    orderedProjects.find(
      (project) => project.repositoryIdentity !== null && project.repositoryIdentity !== undefined,
    ) ?? orderedProjects[0];

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: defaultProject
      ? scopeProjectRef(defaultProject.environmentId, defaultProject.id)
      : null,
    handleNewThread,
    routeThreadRef,
  };
}
