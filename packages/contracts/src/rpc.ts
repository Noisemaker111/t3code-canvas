import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import { AssetAccessError, AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import {
  KanbanAppendCardHistoryInput,
  KanbanAppendCardHistoryResult,
  KanbanCardResult,
  KanbanCreateCardInput,
  KanbanDeleteCardInput,
  KanbanDeleteCardResult,
  KanbanError,
  KanbanListCardHistoryInput,
  KanbanListCardHistoryResult,
  KanbanForgeError,
  KanbanListInput,
  KanbanListOpenIssuesInput,
  KanbanListOpenIssuesResult,
  KanbanListOpenPrsInput,
  KanbanListOpenPrsResult,
  KanbanListResult,
  KanbanMergePrInput,
  KanbanMergePrResult,
  KanbanOpenPrInput,
  KanbanOpenPrResult,
  KanbanUpdateCardInput,
} from "./kanban.ts";
import {
  KanbanBoardControlInput,
  KanbanBoardControlResult,
  KanbanLaunchActiveInput,
  KanbanLaunchActiveResult,
} from "./kanbanBoardControl.ts";
import {
  CanvasAckInjectionsInput,
  CanvasAckInjectionsResult,
  CanvasAckMessagesInput,
  CanvasAckMessagesResult,
  CanvasError,
  CanvasGetInput,
  CanvasGetResult,
  CanvasListInjectionsInput,
  CanvasListInjectionsResult,
  CanvasListMessagesInput,
  CanvasListMessagesResult,
  CanvasPostMessageInput,
  CanvasPostMessageResult,
  CanvasSaveInput,
  CanvasSaveResult,
} from "./canvas.ts";
import { PromptAssistInput, PromptAssistResult } from "./promptAssist.ts";
import { TextGenerationError } from "./git.ts";
import {
  ServerCheckForUpdateInput,
  ServerGetUpdateStateInput,
  ServerInstallLogEvent,
  ServerInstallUpdateInput,
  ServerSubscribeInstallLogInput,
  ServerUpdateError,
  ServerUpdateState,
} from "./serverUpdate.ts";
import {
  VpsGetSnapshotInput,
  VpsHostError,
  VpsServiceActionInput,
  VpsServiceActionResult,
  VpsSignalProcessInput,
  VpsSignalProcessResult,
  VpsSnapshot,
  VpsHealth,
  VpsRunHealthInput,
  VpsSetForgeTokenInput,
} from "./vpsHost.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  BtwChatError,
  BtwClearInput,
  BtwClearResult,
  BtwListMessagesInput,
  BtwListMessagesResult,
  BtwSendMessageInput,
  BtwStreamChunk,
} from "./btw.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  AgentBrowserAttachInput,
  AgentBrowserAttachStreamEvent,
  AgentBrowserCloseInput,
  AgentBrowserError,
  AgentBrowserHistoryInput,
  AgentBrowserInputInput,
  AgentBrowserNavigateInput,
  AgentBrowserOpenInput,
  AgentBrowserResizeInput,
  AgentBrowserSessionsStreamEvent,
  AgentBrowserSessionSummary,
} from "./agentBrowser.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlAccountIdentity,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
  SourceControlRepositoryListInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",

  // Kanban board methods
  kanbanList: "kanban.list",
  kanbanCreateCard: "kanban.createCard",
  kanbanUpdateCard: "kanban.updateCard",
  kanbanDeleteCard: "kanban.deleteCard",
  kanbanBoardControl: "kanban.boardControl",
  kanbanLaunchActive: "kanban.launchActive",
  kanbanOpenPr: "kanban.openPr",
  kanbanMergePr: "kanban.mergePr",
  kanbanListOpenPrs: "kanban.listOpenPrs",
  kanbanListOpenIssues: "kanban.listOpenIssues",
  kanbanListCardHistory: "kanban.listCardHistory",
  kanbanAppendCardHistory: "kanban.appendCardHistory",

  // Board canvas (tldraw shell the board floats on)
  canvasGet: "canvas.get",
  canvasSave: "canvas.save",
  canvasListInjections: "canvas.listInjections",
  canvasAckInjections: "canvas.ackInjections",
  canvasPostMessage: "canvas.postMessage",
  canvasListMessages: "canvas.listMessages",
  canvasAckMessages: "canvas.ackMessages",

  // Prompt assist (model-driven text transforms)
  promptAssist: "promptAssist.run",

  // Server (VPS) update management
  serverGetUpdateState: "server.getUpdateState",
  serverCheckForUpdate: "server.checkForUpdate",
  serverInstallUpdate: "server.installUpdate",
  serverSubscribeInstallLog: "server.subscribeInstallLog",

  // VPS host observability and control
  vpsGetSnapshot: "vps.getSnapshot",
  vpsServiceAction: "vps.serviceAction",
  vpsSignalProcess: "vps.signalProcess",
  vpsRunHealth: "vps.runHealth",
  vpsSetForgeToken: "vps.setForgeToken",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Agent browser methods (server-hosted headless Chromium)
  browserOpen: "browser.open",
  browserAttach: "browser.attach",
  browserInput: "browser.input",
  browserNavigate: "browser.navigate",
  browserHistory: "browser.history",
  browserResize: "browser.resize",
  browserClose: "browser.close",
  browserProfiles: "browser.profiles",
  subscribeBrowserSessions: "subscribeBrowserSessions",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetSourceControlAccountIdentity: "server.getSourceControlAccountIdentity",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverSignalProcess: "server.signalProcess",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlListRepositories: "sourceControl.listRepositories",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // btw side-chat methods
  btwListMessages: "btw.listMessages",
  btwSendMessage: "btw.sendMessage",
  btwClear: "btw.clear",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentAuthorizationError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetSourceControlAccountIdentityRpc = Rpc.make(
  WS_METHODS.serverGetSourceControlAccountIdentity,
  {
    payload: Schema.Struct({}),
    success: Schema.NullOr(SourceControlAccountIdentity),
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

export const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

export const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlListRepositoriesRpc = Rpc.make(
  WS_METHODS.sourceControlListRepositories,
  {
    payload: SourceControlRepositoryListInput,
    success: Schema.Array(SourceControlRepositoryInfo),
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

export const WsBtwListMessagesRpc = Rpc.make(WS_METHODS.btwListMessages, {
  payload: BtwListMessagesInput,
  success: BtwListMessagesResult,
  error: Schema.Union([BtwChatError, EnvironmentAuthorizationError]),
});

export const WsBtwClearRpc = Rpc.make(WS_METHODS.btwClear, {
  payload: BtwClearInput,
  success: BtwClearResult,
  error: Schema.Union([BtwChatError, EnvironmentAuthorizationError]),
});

export const WsBtwSendMessageRpc = Rpc.make(WS_METHODS.btwSendMessage, {
  payload: BtwSendMessageInput,
  success: BtwStreamChunk,
  error: Schema.Union([BtwChatError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsKanbanListRpc = Rpc.make(WS_METHODS.kanbanList, {
  payload: KanbanListInput,
  success: KanbanListResult,
  error: Schema.Union([KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanCreateCardRpc = Rpc.make(WS_METHODS.kanbanCreateCard, {
  payload: KanbanCreateCardInput,
  success: KanbanCardResult,
  error: Schema.Union([KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanUpdateCardRpc = Rpc.make(WS_METHODS.kanbanUpdateCard, {
  payload: KanbanUpdateCardInput,
  success: KanbanCardResult,
  error: Schema.Union([KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanDeleteCardRpc = Rpc.make(WS_METHODS.kanbanDeleteCard, {
  payload: KanbanDeleteCardInput,
  success: KanbanDeleteCardResult,
  error: Schema.Union([KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanBoardControlRpc = Rpc.make(WS_METHODS.kanbanBoardControl, {
  payload: KanbanBoardControlInput,
  success: KanbanBoardControlResult,
  error: Schema.Union([TextGenerationError, KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanLaunchActiveRpc = Rpc.make(WS_METHODS.kanbanLaunchActive, {
  payload: KanbanLaunchActiveInput,
  success: KanbanLaunchActiveResult,
  error: Schema.Union([TextGenerationError, KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanOpenPrRpc = Rpc.make(WS_METHODS.kanbanOpenPr, {
  payload: KanbanOpenPrInput,
  success: KanbanOpenPrResult,
  error: Schema.Union([TextGenerationError, KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanMergePrRpc = Rpc.make(WS_METHODS.kanbanMergePr, {
  payload: KanbanMergePrInput,
  success: KanbanMergePrResult,
  error: Schema.Union([TextGenerationError, KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanListOpenPrsRpc = Rpc.make(WS_METHODS.kanbanListOpenPrs, {
  payload: KanbanListOpenPrsInput,
  success: KanbanListOpenPrsResult,
  error: Schema.Union([KanbanForgeError, KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanListOpenIssuesRpc = Rpc.make(WS_METHODS.kanbanListOpenIssues, {
  payload: KanbanListOpenIssuesInput,
  success: KanbanListOpenIssuesResult,
  error: Schema.Union([KanbanForgeError, KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanListCardHistoryRpc = Rpc.make(WS_METHODS.kanbanListCardHistory, {
  payload: KanbanListCardHistoryInput,
  success: KanbanListCardHistoryResult,
  error: Schema.Union([KanbanError, EnvironmentAuthorizationError]),
});

export const WsKanbanAppendCardHistoryRpc = Rpc.make(WS_METHODS.kanbanAppendCardHistory, {
  payload: KanbanAppendCardHistoryInput,
  success: KanbanAppendCardHistoryResult,
  error: Schema.Union([KanbanError, EnvironmentAuthorizationError]),
});

export const WsCanvasGetRpc = Rpc.make(WS_METHODS.canvasGet, {
  payload: CanvasGetInput,
  success: CanvasGetResult,
  error: Schema.Union([CanvasError, EnvironmentAuthorizationError]),
});

export const WsCanvasSaveRpc = Rpc.make(WS_METHODS.canvasSave, {
  payload: CanvasSaveInput,
  success: CanvasSaveResult,
  error: Schema.Union([CanvasError, EnvironmentAuthorizationError]),
});

export const WsCanvasListInjectionsRpc = Rpc.make(WS_METHODS.canvasListInjections, {
  payload: CanvasListInjectionsInput,
  success: CanvasListInjectionsResult,
  error: Schema.Union([CanvasError, EnvironmentAuthorizationError]),
});

export const WsCanvasAckInjectionsRpc = Rpc.make(WS_METHODS.canvasAckInjections, {
  payload: CanvasAckInjectionsInput,
  success: CanvasAckInjectionsResult,
  error: Schema.Union([CanvasError, EnvironmentAuthorizationError]),
});

export const WsCanvasPostMessageRpc = Rpc.make(WS_METHODS.canvasPostMessage, {
  payload: CanvasPostMessageInput,
  success: CanvasPostMessageResult,
  error: Schema.Union([CanvasError, EnvironmentAuthorizationError]),
});

export const WsCanvasListMessagesRpc = Rpc.make(WS_METHODS.canvasListMessages, {
  payload: CanvasListMessagesInput,
  success: CanvasListMessagesResult,
  error: Schema.Union([CanvasError, EnvironmentAuthorizationError]),
});

export const WsCanvasAckMessagesRpc = Rpc.make(WS_METHODS.canvasAckMessages, {
  payload: CanvasAckMessagesInput,
  success: CanvasAckMessagesResult,
  error: Schema.Union([CanvasError, EnvironmentAuthorizationError]),
});

export const WsPromptAssistRpc = Rpc.make(WS_METHODS.promptAssist, {
  payload: PromptAssistInput,
  success: PromptAssistResult,
  error: Schema.Union([TextGenerationError, EnvironmentAuthorizationError]),
});

export const WsServerGetUpdateStateRpc = Rpc.make(WS_METHODS.serverGetUpdateState, {
  payload: ServerGetUpdateStateInput,
  success: ServerUpdateState,
  error: Schema.Union([ServerUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerCheckForUpdateRpc = Rpc.make(WS_METHODS.serverCheckForUpdate, {
  payload: ServerCheckForUpdateInput,
  success: ServerUpdateState,
  error: Schema.Union([ServerUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerInstallUpdateRpc = Rpc.make(WS_METHODS.serverInstallUpdate, {
  payload: ServerInstallUpdateInput,
  success: ServerUpdateState,
  error: Schema.Union([ServerUpdateError, EnvironmentAuthorizationError]),
});

/**
 * Live tail of the deploy script's run log. Streamed rather than polled because
 * a build takes minutes and the useful signal is the output itself. Resumable
 * via `fromLine`: the install restarts this very server, so the client's only
 * way back is to reconnect and replay.
 */
export const WsServerSubscribeInstallLogRpc = Rpc.make(WS_METHODS.serverSubscribeInstallLog, {
  payload: ServerSubscribeInstallLogInput,
  success: ServerInstallLogEvent,
  error: Schema.Union([ServerUpdateError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVpsGetSnapshotRpc = Rpc.make(WS_METHODS.vpsGetSnapshot, {
  payload: VpsGetSnapshotInput,
  success: VpsSnapshot,
  error: Schema.Union([VpsHostError, EnvironmentAuthorizationError]),
});

export const WsVpsServiceActionRpc = Rpc.make(WS_METHODS.vpsServiceAction, {
  payload: VpsServiceActionInput,
  success: VpsServiceActionResult,
  error: Schema.Union([VpsHostError, EnvironmentAuthorizationError]),
});

export const WsVpsSignalProcessRpc = Rpc.make(WS_METHODS.vpsSignalProcess, {
  payload: VpsSignalProcessInput,
  success: VpsSignalProcessResult,
  error: Schema.Union([VpsHostError, EnvironmentAuthorizationError]),
});

export const WsVpsRunHealthRpc = Rpc.make(WS_METHODS.vpsRunHealth, {
  payload: VpsRunHealthInput,
  success: VpsHealth,
  error: Schema.Union([VpsHostError, EnvironmentAuthorizationError]),
});

/** Answers with the re-probed health, so the forge checks update in place. */
export const WsVpsSetForgeTokenRpc = Rpc.make(WS_METHODS.vpsSetForgeToken, {
  payload: VpsSetForgeTokenInput,
  success: VpsHealth,
  error: Schema.Union([VpsHostError, EnvironmentAuthorizationError]),
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

export const WsBrowserOpenRpc = Rpc.make(WS_METHODS.browserOpen, {
  payload: AgentBrowserOpenInput,
  success: AgentBrowserSessionSummary,
  error: Schema.Union([AgentBrowserError, EnvironmentAuthorizationError]),
});

export const WsBrowserAttachRpc = Rpc.make(WS_METHODS.browserAttach, {
  payload: AgentBrowserAttachInput,
  success: AgentBrowserAttachStreamEvent,
  error: Schema.Union([AgentBrowserError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsBrowserInputRpc = Rpc.make(WS_METHODS.browserInput, {
  payload: AgentBrowserInputInput,
  error: Schema.Union([AgentBrowserError, EnvironmentAuthorizationError]),
});

export const WsBrowserNavigateRpc = Rpc.make(WS_METHODS.browserNavigate, {
  payload: AgentBrowserNavigateInput,
  success: AgentBrowserSessionSummary,
  error: Schema.Union([AgentBrowserError, EnvironmentAuthorizationError]),
});

export const WsBrowserHistoryRpc = Rpc.make(WS_METHODS.browserHistory, {
  payload: AgentBrowserHistoryInput,
  error: Schema.Union([AgentBrowserError, EnvironmentAuthorizationError]),
});

export const WsBrowserResizeRpc = Rpc.make(WS_METHODS.browserResize, {
  payload: AgentBrowserResizeInput,
  success: AgentBrowserSessionSummary,
  error: Schema.Union([AgentBrowserError, EnvironmentAuthorizationError]),
});

export const WsBrowserCloseRpc = Rpc.make(WS_METHODS.browserClose, {
  payload: AgentBrowserCloseInput,
  error: Schema.Union([AgentBrowserError, EnvironmentAuthorizationError]),
});

/** The cookie jars the box has, so a new tab can be pointed at one. */
export const WsBrowserProfilesRpc = Rpc.make(WS_METHODS.browserProfiles, {
  payload: Schema.Struct({}),
  success: Schema.Array(Schema.String),
  error: Schema.Union([AgentBrowserError, EnvironmentAuthorizationError]),
});

export const WsSubscribeBrowserSessionsRpc = Rpc.make(WS_METHODS.subscribeBrowserSessions, {
  payload: Schema.Struct({}),
  success: AgentBrowserSessionsStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({}),
    success: DiscoveredLocalServerList,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: Schema.Union([OrchestrationReplayEventsError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetSourceControlAccountIdentityRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerSignalProcessRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlListRepositoriesRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsKanbanListRpc,
  WsKanbanCreateCardRpc,
  WsKanbanUpdateCardRpc,
  WsKanbanDeleteCardRpc,
  WsKanbanBoardControlRpc,
  WsKanbanLaunchActiveRpc,
  WsKanbanOpenPrRpc,
  WsKanbanMergePrRpc,
  WsKanbanListOpenPrsRpc,
  WsKanbanListOpenIssuesRpc,
  WsKanbanListCardHistoryRpc,
  WsKanbanAppendCardHistoryRpc,
  WsCanvasGetRpc,
  WsCanvasSaveRpc,
  WsCanvasListInjectionsRpc,
  WsCanvasAckInjectionsRpc,
  WsCanvasPostMessageRpc,
  WsCanvasListMessagesRpc,
  WsCanvasAckMessagesRpc,
  WsPromptAssistRpc,
  WsServerGetUpdateStateRpc,
  WsServerCheckForUpdateRpc,
  WsServerInstallUpdateRpc,
  WsServerSubscribeInstallLogRpc,
  WsVpsGetSnapshotRpc,
  WsVpsServiceActionRpc,
  WsVpsSignalProcessRpc,
  WsVpsRunHealthRpc,
  WsVpsSetForgeTokenRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsBrowserOpenRpc,
  WsBrowserAttachRpc,
  WsBrowserInputRpc,
  WsBrowserNavigateRpc,
  WsBrowserHistoryRpc,
  WsBrowserResizeRpc,
  WsBrowserCloseRpc,
  WsBrowserProfilesRpc,
  WsSubscribeBrowserSessionsRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsBtwListMessagesRpc,
  WsBtwClearRpc,
  WsBtwSendMessageRpc,
);
