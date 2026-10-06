/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { localChatSessionType } from './chatSessionsService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isVirtualWorkspace } from '../../../../platform/workspace/common/virtualWorkspace.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { URI } from '../../../../base/common/uri.js';
import { getNewChatSessionResource } from './model/chatUri.js';


export { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';

export const enum BYOKUtilityModelDefault {
	None = 'none',
	MainAgent = 'mainAgent',
	Copilot = 'copilot',
}

export const enum CustomizationMigrationHintMode {
	Never = 'never',
	Once = 'once',
	Always = 'always',
}

export enum ChatConfiguration {
	PluginsEnabled = 'chat.plugins.enabled',
	PluginLocations = 'chat.pluginLocations',
	PluginMarketplaces = 'chat.plugins.marketplaces',
	ExtraMarketplaces = 'chat.plugins.extraMarketplaces',
	StrictMarketplaces = 'chat.plugins.strictMarketplaces',
	EnabledPlugins = 'chat.plugins.enabledPlugins',
	AgentEnabled = 'chat.agent.enabled',
	PlanAgentDefaultModel = 'chat.planAgent.defaultModel',
	ExploreAgentDefaultModel = 'chat.exploreAgent.defaultModel',
	UtilityModel = 'chat.utilityModel',
	UtilitySmallModel = 'chat.utilitySmallModel',
	BYOKUtilityModelDefault = 'chat.byokUtilityModelDefault',
	RequestQueueingDefaultAction = 'chat.requestQueuing.defaultAction',
	SaveBeforeSend = 'chat.saveBeforeSend',
	AgentStatusEnabled = 'chat.agentsControl.enabled',
	EditorAssociations = 'chat.editorAssociations',
	UnifiedAgentsBar = 'chat.unifiedAgentsBar.enabled',
	AgentSessionProjectionEnabled = 'chat.agentSessionProjection.enabled',
	MigrateLegacyCopilotCliSessions = 'chat.agentSessions.migrateLegacyCopilotCli',
	SessionCatalogEnabled = 'chat.agentHost.sessionCatalog.enabled',
	ShowExternalAgentSessions = 'chat.agentSessions.showExternal',
	UnifiedWorkspacePicker = 'sessions.chat.unifiedWorkspacePicker.enabled',
	AutoMarkAsDoneMergedSessionsAfterDays = 'chat.agentSessions.autoMarkAsDoneMergedSessionsAfterDays',
	AutoDeleteMarkedAsDoneMergedSessionsAfterDays = 'chat.agentSessions.autoDeleteMarkedAsDoneMergedSessionsAfterDays',
	ExtensionToolsEnabled = 'chat.extensionTools.enabled',
	RepoInfoEnabled = 'chat.repoInfo.enabled',
	EditRequests = 'chat.editRequests',
	PasteAsAttachmentThreshold = 'chat.pasteAsAttachmentThreshold',
	InlineReferencesStyle = 'chat.inlineReferences.style',
	AutoReply = 'chat.autoReply',
	GlobalAutoApprove = 'chat.tools.global.autoApprove',
	AutoApproveEdits = 'chat.tools.edits.autoApprove',
	AutoApprovedUrls = 'chat.tools.urls.autoApprove',
	EligibleForAutoApproval = 'chat.tools.eligibleForAutoApproval',
	EnableMath = 'chat.math.enabled',
	CheckpointsEnabled = 'chat.checkpoints.enabled',
	ThinkingStyle = 'chat.agent.thinkingStyle',
	ThinkingGenerateTitles = 'chat.agent.thinking.generateTitles',
	TerminalToolsInThinking = 'chat.agent.thinking.terminalTools',
	TerminalAgentHostEnabled = 'chat.terminal.agentHost.enabled',
	InlineChatAgentHostEnabled = 'chat.inlineChat.agentHost.enabled',
	CollapseCompletedResponses = 'chat.agent.collapseCompletedResponses',
	SimpleTerminalCollapsible = 'chat.tools.terminal.simpleCollapsible',
	CompressOutputEnabled = 'chat.tools.compressOutput.enabled',
	ThinkingPhrases = 'chat.agent.thinking.phrases',
	AutoExpandToolFailures = 'chat.tools.autoExpandFailures',
	TodosShowWidget = 'chat.tools.todos.showWidget',
	NotifyWindowOnConfirmation = 'chat.notifyWindowOnConfirmation',
	NotifyWindowOnResponseReceived = 'chat.notifyWindowOnResponseReceived',
	ChatViewSessionsEnabled = 'chat.viewSessions.enabled',
	SessionSyncEnabled = 'chat.sessionSync.enabled',
	SessionSyncExcludeRepositories = 'chat.sessionSync.excludeRepositories',
	ChatViewSessionsGrouping = 'chat.viewSessions.grouping',
	ChatViewSessionsOrientation = 'chat.viewSessions.orientation',
	ChatViewProgressBadgeEnabled = 'chat.viewProgressBadge.enabled',
	ChatContextUsageEnabled = 'chat.contextUsage.enabled',
	Verbose = 'chat.verbose',
	ProgressBorder = 'chat.progressBorder.enabled',
	PersistentProgress = 'chat.experimental.persistentProgress',
	PersistentProgressVerbosity = 'chat.experimental.persistentProgressVerbosity',
	SessionStateIndicatorEnabled = 'chat.experimental.sessionStateIndicator.enabled',
	SubagentToolCustomAgents = 'chat.customAgentInSubagent.enabled',
	SubagentsAllowInvocationsFromSubagents = 'chat.subagents.allowInvocationsFromSubagents',
	SubagentsDefaultToAuto = 'chat.subagents.defaultToAuto',
	SubagentsUseRichRendering = 'chat.subagents.useRichRendering',
	SubagentsShowCreditUsage = 'chat.subagents.showCreditUsage',
	ShowCodeBlockProgressAnimation = 'chat.agent.codeBlockProgress',
	RestoreLastPanelSession = 'chat.restoreLastPanelSession',
	ExitAfterDelegation = 'chat.exitAfterDelegation',
	ExplainChangesEnabled = 'chat.editing.explainChanges.enabled',
	RevealNextChangeOnResolve = 'chat.editing.revealNextChangeOnResolve',
	OpenChangedFileInDiffEditor = 'chat.editing.openChangedFileInDiffEditor',
	GrowthNotificationEnabled = 'chat.growthNotification.enabled',
	ChatClosedPromoNotification = 'chat.closedPromoNotification',
	TitleBarSignInEnabled = 'chat.titleBar.signIn.enabled',

	ChatCustomizationsStructuredPreviewEnabled = 'chat.customizations.structuredPreview.enabled',
	ChatCustomizationsListLayout = 'chat.experimental.customizations.listLayout',
	ChatCustomizationsToggleStyle = 'chat.experimental.customizations.toggleStyle',
	ChatCustomizationsPromptMigrationEnabled = 'chat.customizations.promptMigration.enabled',
	ChatCustomizationsUserDataMigrationEnabled = 'chat.customizations.userDataMigration.enabled',
	ChatCustomizationsLocationsMigrationEnabled = 'chat.customizations.locationsMigration.enabled',
	ChatCustomizationsMcpServerMigrationEnabled = 'chat.customizations.mcpServerMigration.enabled',
	ChatCustomizationsMigrationHint = 'chat.customizations.migrationHint',
	AutopilotAdvancedEnabled = 'chat.autopilot.advanced.enabled',
	DefaultPermissionLevel = 'chat.permissions.default',
	PermissionsSandboxToggleEnabled = 'chat.experimental.permissionsSandboxToggle.enabled',
	ExperimentalModePermissionsPicker = 'chat.experimentalModePermissionsPicker',
	DefaultConfiguration = 'chat.defaultConfiguration',
	DefaultModel = 'chat.defaultModel',
	ImageCarouselEnabled = 'imageCarousel.chat.enabled',
	ArtifactsEnabled = 'chat.artifacts.enabled',
	ArtifactsRulesByMimeType = 'chat.artifacts.rules.byMimeType',
	ArtifactsRulesByFilePath = 'chat.artifacts.rules.byFilePath',
	ArtifactsRulesByMemoryFilePath = 'chat.artifacts.rules.byMemoryFilePath',
	ToolConfirmationCarousel = 'chat.tools.confirmationCarousel.enabled',
	ToolRiskAssessmentEnabled = 'chat.tools.riskAssessment.enabled',
	ToolRiskAssessmentModel = 'chat.tools.riskAssessment.model',
	DefaultNewSessionMode = 'chat.newSession.defaultMode',
	AgentHostDebugLogsDefaultExportLocation = 'chat.agentHost.debugLogs.defaultExportLocation',
	EditorPreferCopilotHarness = 'chat.editor.preferCopilotHarness',
	DefaultToCopilotHarness = 'chat.defaultToCopilotHarness',
	EditorLocalAgentEnabled = 'chat.editor.localAgent.enabled',
	BtwTipEnabled = 'chat.btwTip.enabled',

	IncrementalRendering = 'chat.experimental.incrementalRendering.enabled',
	IncrementalRenderingStyle = 'chat.experimental.incrementalRendering.animationStyle',
	IncrementalRenderingBuffering = 'chat.experimental.incrementalRendering.buffering',
	ExperimentalStickyScrollEnabled = 'chat.experimental.stickyScroll.enabled',
	RichLinks = 'chat.experimental.richLinks.enabled',

	CollectInstructionsInExtension = 'chat.experimental.collectInstructionsInExtension',
	ImplicitContextActiveEditor = 'chat.implicitContext.includeActiveEditor',
}

export const enum ChatClosedPromoNotification {
	None = 'none',
	CopilotIconPopup = 'copilotIconPopup',
}

export const AGENT_SESSION_CLEANUP_SETTINGS_TAG = 'agentSessionCleanup';

/**
 * The "kind" of agents for custom agents.
 */
export enum ChatModeKind {
	Ask = 'ask',
	Edit = 'edit',
	Agent = 'agent'
}

/**
 * The permission level controlling tool auto-approval behavior.
 */
export enum ChatPermissionLevel {
	/** Use existing auto-approve settings */
	Default = 'default',
	/** Delegate approval decisions to a model */
	Assisted = 'assisted',
	/** Auto-approve all tool calls, auto-retry on error */
	AutoApprove = 'autoApprove',
	/** Everything AutoApprove does plus an internal stop hook that continues until the task is done */
	Autopilot = 'autopilot'
}

const chatPermissionLevels = new Set<string>(Object.values(ChatPermissionLevel));

export function isChatPermissionLevel(level: unknown | undefined): level is ChatPermissionLevel {
	return chatPermissionLevels.has(level as string);
}

/**
 * Shape of the {@link ChatConfiguration.DefaultConfiguration}
 * object setting. Controls the starting `mode` and `approvals` for new agent-host
 * sessions (such as Copilot CLI). All properties are optional — a missing property
 * falls back to the per-axis default.
 */
export type AgentSessionMode = 'interactive' | 'plan' | 'autopilot';

/** Approval values exposed by the `chat.defaultConfiguration` setting. */
export enum ChatDefaultPermissionLevel {
	Manual = 'manual',
	Assisted = 'assisted',
	AllowAll = 'allowAll',
}

export interface IChatDefaultConfiguration {
	/** Starting agent mode: `interactive` / `plan` / `autopilot`. */
	readonly mode?: AgentSessionMode;
	/** Starting approval level: `manual` / `assisted` / `allowAll`. */
	readonly approvals?: ChatDefaultPermissionLevel;
}

/** Maps a default-configuration value to the internal Agent Host permission level. */
export function getChatPermissionLevelFromDefaultConfiguration(value: unknown): ChatPermissionLevel | undefined {
	switch (value) {
		case ChatDefaultPermissionLevel.Manual:
		case ChatPermissionLevel.Default:
			return ChatPermissionLevel.Default;
		case ChatDefaultPermissionLevel.Assisted:
			return ChatPermissionLevel.Assisted;
		case ChatDefaultPermissionLevel.AllowAll:
		case ChatPermissionLevel.AutoApprove:
			return ChatPermissionLevel.AutoApprove;
		default:
			return undefined;
	}
}

/**
 * Returns true if the permission level enables auto-approval of all tool calls.
 * Both {@link ChatPermissionLevel.AutoApprove} and {@link ChatPermissionLevel.Autopilot} enable auto-approval.
 */
export function isAutoApproveLevel(level: ChatPermissionLevel | undefined): boolean {
	return level === ChatPermissionLevel.AutoApprove || level === ChatPermissionLevel.Autopilot;
}

/**
 * True for {@link ChatPermissionLevel.Autopilot} only. Unlike {@link isAutoApproveLevel}, this
 * excludes {@link ChatPermissionLevel.AutoApprove}, so it can gate Autopilot-only behavior such as
 * risk-based skipping of tool calls.
 */
export function isAutopilotLevel(level: ChatPermissionLevel | undefined): boolean {
	return level === ChatPermissionLevel.Autopilot;
}

// Thinking display modes for pinned content
export enum ThinkingDisplayMode {
	Collapsed = 'collapsed',
	CollapsedPreview = 'collapsedPreview',
	FixedScrolling = 'fixedScrolling',
}

export enum ChatProgressAnimation {
	Off = 'off',
	Weave = 'weave',
	Draw = 'draw',
	Orbit = 'orbit',
	Accordion = 'accordion',
	Dial = 'dial',
}

export enum ChatProgressVerbosity {
	Verbose = 'verbose',
	Compact = 'compact',
}

export enum CollapsedToolsDisplayMode {
	Off = 'off',
	WithThinking = 'withThinking',
	Always = 'always',
}

export enum ChatNotificationMode {
	Off = 'off',
	WindowNotFocused = 'windowNotFocused',
	Always = 'always',
}

export type RawChatParticipantLocation = 'panel' | 'terminal' | 'notebook' | 'editing-session';

export enum ChatAgentLocation {
	/**
	 * This is chat, whether it's in the sidebar, a chat editor, or quick chat.
	 * Leaving the values alone as they are in stored data so we don't have to normalize them.
	 */
	Chat = 'panel',
	Terminal = 'terminal',
	Notebook = 'notebook',
	/**
	 * EditorInline means inline chat in a text editor.
	 */
	EditorInline = 'editor',
}

export namespace ChatAgentLocation {
	export function fromRaw(value: RawChatParticipantLocation | string): ChatAgentLocation {
		switch (value) {
			case 'panel': return ChatAgentLocation.Chat;
			case 'terminal': return ChatAgentLocation.Terminal;
			case 'notebook': return ChatAgentLocation.Notebook;
			case 'editor': return ChatAgentLocation.EditorInline;
		}
		return ChatAgentLocation.Chat;
	}
}

/**
 * List of file schemes that are always unsupported for use in chat
 */
const chatAlwaysUnsupportedFileSchemes = new Set([
	Schemas.vscodeChatEditor,
	// Chat's own read-only resources, such as a pasted-text artifact: their
	// contents already reach the model through the attachment they belong to.
	Schemas.vscodeChatResponseResource,
	Schemas.walkThrough,
	Schemas.vscodeLocalChatSession,
	Schemas.vscodeSettings,
	Schemas.webviewPanel,
	Schemas.vscodeUserData,
	Schemas.extension,
	'ccreq',
	'openai-codex', // Codex session custom editor scheme
]);

/** Schemes whose models are chat input editors. */
export const chatInputSchemes: readonly string[] = [Schemas.vscodeChatInput, Schemas.sessionsChatInput];

export function isChatInputModel(uri: URI): boolean {
	return chatInputSchemes.includes(uri.scheme);
}

export function isSupportedChatFileScheme(_accessor: ServicesAccessor, scheme: string): boolean {
	// Exclude schemes we always know are bad
	if (chatAlwaysUnsupportedFileSchemes.has(scheme)) {
		return false;
	}

	// Everything else is supported
	return true;
}

/** New chats use the built-in local conversation until native OpenCircuit is integrated. */
export function getComputedDefaultSessionType(
	_configurationService: IConfigurationService,
	_chatSessionsService: unknown,
	_workspace: IWorkspace,
	_agentHostEnabled: boolean,
	_managedSandboxEnforced = false
): string {
	return localChatSessionType;
}

export function getComputedDefaultSessionResource(
	configurationService: IConfigurationService,
	chatSessionsService: unknown,
	workspace: IWorkspace,
	agentHostEnabled: boolean
): URI {
	return getNewChatSessionResource(getComputedDefaultSessionType(configurationService, chatSessionsService, workspace, agentHostEnabled));
}

export function isNewChatSessionTypeUsable(
	sessionType: string,
	configurationService: IConfigurationService,
	_chatSessionsService: unknown,
	workspace: IWorkspace,
	_agentHostEnabled = false,
	_managedSandboxEnforced = false,
): boolean {
	return sessionType === localChatSessionType && isEditorLocalAgentEnabled(configurationService, workspace);
}

/** Why a new chat session type was selected. */
export type SessionTypeSelectionReason = 'explicitOverride' | 'virtualWorkspace' | 'rememberedSelection' | 'currentSession' | 'computedDefault';

export function getLocalFallbackSessionTypeSelectionReason(_sessionType: string, _didAcquireSession: boolean, inheritedReason?: SessionTypeSelectionReason): SessionTypeSelectionReason | undefined {
	return inheritedReason;
}

export interface IDefaultNewChatSessionTypeOptions {
	readonly explicitOverride?: string;
	readonly currentSessionType?: string;
}

export interface IResolvedNewChatSessionType {
	readonly sessionType: string;
	readonly selectionReason: SessionTypeSelectionReason;
}

export function getDefaultNewChatSessionType(
	configurationService: IConfigurationService,
	chatSessionsService: unknown,
	storageService: IStorageService,
	workspace: IWorkspace,
	agentHostEnabled: boolean,
	options?: IDefaultNewChatSessionTypeOptions,
	_managedSandboxEnforced = false
): string {
	return getDefaultNewChatSessionTypeAndReasonFromServices(configurationService, chatSessionsService, storageService, workspace, agentHostEnabled, options).sessionType;
}

export function getDefaultNewChatSessionTypeAndReasonFromServices(
	configurationService: IConfigurationService,
	_chatSessionsService: unknown,
	_storageService: IStorageService,
	workspace: IWorkspace,
	_agentHostEnabled: boolean,
	options?: IDefaultNewChatSessionTypeOptions,
	_managedSandboxEnforced = false
): IResolvedNewChatSessionType {
	if (options?.explicitOverride === localChatSessionType) {
		return { sessionType: localChatSessionType, selectionReason: 'explicitOverride' };
	}
	return {
		sessionType: localChatSessionType,
		selectionReason: isVirtualWorkspace(workspace) ? 'virtualWorkspace' : 'computedDefault',
	};
}

export function getDefaultNewChatSessionTypeAndReason(
	accessor: ServicesAccessor,
	options?: IDefaultNewChatSessionTypeOptions
): IResolvedNewChatSessionType {
	const configurationService = accessor.get(IConfigurationService);
	const storageService = accessor.get(IStorageService);
	const workspace = accessor.get(IWorkspaceContextService).getWorkspace();
	return getDefaultNewChatSessionTypeAndReasonFromServices(configurationService, undefined, storageService, workspace, false, options);
}

export function getDefaultNewChatSessionResource(
	configurationService: IConfigurationService,
	chatSessionsService: unknown,
	storageService: IStorageService,
	workspace: IWorkspace,
	agentHostEnabled: boolean,
	options?: IDefaultNewChatSessionTypeOptions,
	_managedSandboxEnforced = false
): URI {
	return getNewChatSessionResource(getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, workspace, agentHostEnabled, options));
}

export function recordUserSelectedSessionType(
	_storageService: IStorageService,
	_configurationService: IConfigurationService,
	_chatSessionsService: unknown,
	_workspace: IWorkspace,
	_sessionType: string,
	_agentHostEnabled: boolean
): void {
	// Session-type providers are removed. Existing stored preferences are left intact for compatibility.
}

export function isEditorLocalAgentEnabled(configurationService: IConfigurationService, workspace: IWorkspace, _managedSandboxEnforced = false): boolean {
	return isVirtualWorkspace(workspace) || (configurationService.getValue<boolean>(ChatConfiguration.EditorLocalAgentEnabled) ?? true);
}

export function isVisibleEditorChatSessionType(
	sessionType: string,
	configurationService: IConfigurationService,
	_chatSessionsService: unknown,
	workspace: IWorkspace,
	_managedSandboxEnforced = false,
	_agentHostEnabled = false
): boolean {
	return sessionType === localChatSessionType && isEditorLocalAgentEnabled(configurationService, workspace);
}

export const MANAGE_CHAT_COMMAND_ID = 'workbench.action.chat.manage';
export const CHAT_OPEN_AGENT_HOST_CHAT_COMMAND_ID = 'workbench.action.chat.openAgentHostChat';
export const CHAT_SUBAGENT_RESOURCE_QUERY_PARAM = 'subagentChatResource';

export const ChatEditorTitleMaxLength = 30;

export const CHAT_TERMINAL_OUTPUT_MAX_PREVIEW_LINES = 1000;
export const CONTEXT_MODELS_EDITOR = new RawContextKey<boolean>('inModelsEditor', false);
export const CONTEXT_MODELS_SEARCH_FOCUS = new RawContextKey<boolean>('inModelsSearch', false);
