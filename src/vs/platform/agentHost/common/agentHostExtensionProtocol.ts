/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vEnum, vObj, vOptionalProp, vString, type ValidatorType } from '../../../base/common/validation.js';
import type { AgentHostDebugLogsArtifactKind, IAgentHostManagedSettingsDiagnostics, IAgentHostNetworkDiagnosticsInfo, IAgentHostNetworkFetchResult } from './agentService.js';
import type { InitializeResult } from './state/protocol/common/commands.js';
import { AgentHostArtifactRemovalCapabilityMetaKey } from './meta/agentHostArtifactRemovalMeta.js';
import { AgentHostSessionImportCapabilityMetaKey } from './meta/agentHostSessionImportMeta.js';
import { AgentHostTimingCapabilityMetaKey, ChatUserInteractionCapability } from './meta/agentHostTimingMeta.js';
import type { IAgentHostFirstResponseDiagnostic } from './otel/agentHostTiming.js';
import type { IChatUserInteractionTiming } from '../../otel/common/chatUserInteraction.js';
import { AgentHostAutonomousAutomationsCapabilityMetaKey } from './meta/agentHostAutomationsMeta.js';

export { supportsAgentHostArtifactRemoval } from './meta/agentHostArtifactRemovalMeta.js';
export const CollectAgentHostDebugLogsExtensionMethod = 'vscode/collectAgentHostDebugLogs';
export const GetAgentHostSessionStateFileExtensionMethod = 'vscode/getAgentHostSessionStateFile';
export const CreateAgentHostDetachedWorktreeExtensionMethod = 'vscode/createAgentHostDetachedWorktree';
export const ClaimAgentHostDetachedWorktreeExtensionMethod = 'vscode/claimAgentHostDetachedWorktree';
export const DeleteAgentHostDetachedWorktreeExtensionMethod = 'vscode/deleteAgentHostDetachedWorktree';
export const ReconcileAgentHostDetachedWorktreesExtensionMethod = 'vscode/reconcileAgentHostDetachedWorktrees';
export const ReadAgentHostDebugLogsChunkExtensionMethod = 'vscode/readAgentHostDebugLogsChunk';
export const SetAgentHostDetachedWorktreeArchivedExtensionMethod = 'vscode/setAgentHostDetachedWorktreeArchived';
export const RequestAgentHostWorkspaceTrustExtensionMethod = 'vscode/requestWorkspaceTrust';
export const RemoveSessionArtifactExtensionMethod = 'vscode/removeSessionArtifact';
export const ImportSessionExtensionMethod = 'vscode/importSession';
export const ReportAgentHostFirstResponseExtensionMethod = 'vscode/reportAgentHostFirstResponse';
export const ReportChatUserInteractionExtensionMethod = 'vscode/reportChatUserInteraction';

const AgentHostChatStateFileCapabilityMetaKey = 'vscode.getAgentHostSessionStateFile.chat';
const AgentHostDetachedWorktreeCapabilityMetaKey = 'vscode.detachedWorktrees';

/** Namespaced VS Code implementation capabilities carried alongside standardized AHP initialize capabilities. */
export interface IAgentHostExtensionInitializeResultMeta extends Record<string, unknown> {
	readonly [AgentHostChatStateFileCapabilityMetaKey]?: true;
	readonly [AgentHostDetachedWorktreeCapabilityMetaKey]?: true;
	readonly [AgentHostArtifactRemovalCapabilityMetaKey]?: true;
	readonly [AgentHostSessionImportCapabilityMetaKey]?: true;
	readonly [AgentHostTimingCapabilityMetaKey]?: true;
	readonly [ChatUserInteractionCapability]?: true;
	/** Present when Automation execution does not require a client activation or migration handshake. */
	readonly [AgentHostAutonomousAutomationsCapabilityMetaKey]?: true;
}

/** Standard AHP initialize response with typed VS Code-specific capability metadata. */
export interface IAgentHostExtensionInitializeResult extends InitializeResult {
	readonly _meta?: IAgentHostExtensionInitializeResultMeta;
}

export function getAgentHostExtensionInitializeResultMeta(artifactRemoval = true, timing = false, sessionImport = false): IAgentHostExtensionInitializeResultMeta {
	return {
		[AgentHostChatStateFileCapabilityMetaKey]: true,
		[AgentHostDetachedWorktreeCapabilityMetaKey]: true,
		[AgentHostAutonomousAutomationsCapabilityMetaKey]: true,
		[AgentHostArtifactRemovalCapabilityMetaKey]: artifactRemoval ? true : undefined,
		...(sessionImport ? { [AgentHostSessionImportCapabilityMetaKey]: true as const } : {}),
		...(timing ? { [AgentHostTimingCapabilityMetaKey]: true as const } : {}),
		...(timing ? { [ChatUserInteractionCapability]: true as const } : {}),
	};
}

export function supportsAgentHostChatStateFile(result: IAgentHostExtensionInitializeResult | undefined): boolean {
	const meta = result?._meta;
	return meta?.[AgentHostChatStateFileCapabilityMetaKey] === true;
}

export function supportsAgentHostDetachedWorktrees(result: IAgentHostExtensionInitializeResult | undefined): boolean {
	const meta = result?._meta;
	return meta?.[AgentHostDetachedWorktreeCapabilityMetaKey] === true;
}

export const collectAgentHostDebugLogsParamsValidator = vObj({
	session: vOptionalProp(vString()),
	chat: vOptionalProp(vString()),
	kind: vEnum('archive', 'directory'),
});

export type CollectAgentHostDebugLogsParams = ValidatorType<typeof collectAgentHostDebugLogsParamsValidator>;

export const removeSessionArtifactParamsValidator = vObj({
	session: vString(),
	artifactId: vString(),
});

export const importSessionParamsValidator = vObj({ session: vString() });

export interface IAgentHostExtensionCommandMap {
	[ImportSessionExtensionMethod]: { params: ValidatorType<typeof importSessionParamsValidator>; result: void };
	[ReportAgentHostFirstResponseExtensionMethod]: { params: IAgentHostFirstResponseDiagnostic; result: void };
	[ReportChatUserInteractionExtensionMethod]: { params: IChatUserInteractionTiming; result: void };
	[RemoveSessionArtifactExtensionMethod]: {
		params: ValidatorType<typeof removeSessionArtifactParamsValidator>;
		result: void;
	};
	'shutdown': { params: undefined; result: void };
	'getNetworkDiagnosticsInfo': { params: undefined; result: IAgentHostNetworkDiagnosticsInfo };
	'getManagedSettingsDiagnostics': { params: undefined; result: readonly IAgentHostManagedSettingsDiagnostics[] };
	'diagnosticsFetch': { params: { url: string }; result: IAgentHostNetworkFetchResult };
	[GetAgentHostSessionStateFileExtensionMethod]: {
		params: { session: string; chat?: string };
		result: { resource?: string };
	};
	[CreateAgentHostDetachedWorktreeExtensionMethod]: {
		params: { session: string; prompt: string };
		result: { handle: string; resource: string };
	};
	[ClaimAgentHostDetachedWorktreeExtensionMethod]: {
		params: { handle: string };
		result: void;
	};
	[SetAgentHostDetachedWorktreeArchivedExtensionMethod]: {
		params: { handle: string; archived: boolean };
		result: void;
	};
	[DeleteAgentHostDetachedWorktreeExtensionMethod]: {
		params: { handle: string };
		result: void;
	};
	[ReconcileAgentHostDetachedWorktreesExtensionMethod]: {
		params: { scope: string; activeHandles: string[] };
		result: void;
	};
	[CollectAgentHostDebugLogsExtensionMethod]: {
		params: CollectAgentHostDebugLogsParams;
		result: { kind: AgentHostDebugLogsArtifactKind; resource: string; providerLogsIncluded: boolean; size: number; uncompressedSize: number; entries: readonly { path: string; size: number }[] };
	};
	[ReadAgentHostDebugLogsChunkExtensionMethod]: {
		params: { resource: string; position: number };
		/** `data` is base64; at most `AGENT_HOST_DEBUG_LOGS_CHUNK_BYTES` decoded bytes. */
		result: { data: string; eof: boolean };
	};
}

export interface IAgentHostWorkspaceTrustRequest {
	readonly workspace: string;
	readonly trustedParent?: string;
}

export interface IAgentHostExtensionServerCommandMap {
	[RequestAgentHostWorkspaceTrustExtensionMethod]: {
		params: IAgentHostWorkspaceTrustRequest;
		result: { trusted: boolean };
	};
}
