/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/** Session identifiers still used by the workbench while Agent Host is being removed. */
export namespace SessionType {
	export const CopilotCLI = 'copilotcli';
	export const CopilotCloud = 'copilot-cloud-agent';
	export const Local = 'local';
	export const Codex = 'openai-codex';
	export const Growth = 'copilot-growth';
	export const AgentHostCopilot = 'agent-host-copilotcli';
	export const AgentHostClaude = 'agent-host-claude';
	export const AgentHostCodex = 'agent-host-codex';
}

export const localChatSessionType = SessionType.Local;

const LOCAL_AGENT_HOST_SCHEME_PREFIX = 'agent-host-';
const REMOTE_AGENT_HOST_SESSION_TYPE_PREFIX = 'remote-';

export function isRemoteAgentHostSessionType(sessionType: string): boolean {
	return sessionType.startsWith(REMOTE_AGENT_HOST_SESSION_TYPE_PREFIX);
}

export function parseRemoteAgentHostHarness(sessionType: string): string | undefined {
	if (!isRemoteAgentHostSessionType(sessionType)) {
		return undefined;
	}
	const harness = sessionType.slice(sessionType.lastIndexOf('-') + 1);
	return harness || undefined;
}

export function isLocalAgentHostTarget(target: string): boolean {
	return target === SessionType.AgentHostCopilot || target.startsWith(LOCAL_AGENT_HOST_SCHEME_PREFIX);
}

export function isRemoteAgentHostTarget(target: string): boolean {
	return isRemoteAgentHostSessionType(target);
}

export function isAgentHostTarget(target: string): boolean {
	return isLocalAgentHostTarget(target) || isRemoteAgentHostTarget(target);
}

export function isAgentHostSessionResource(resource: URI): boolean {
	return isAgentHostTarget(resource.scheme);
}

export const enum ChatSessionStatus {
	Failed = 0,
	Completed = 1,
	InProgress = 2,
	NeedsInput = 3
}

export function isSessionInProgressStatus(state: ChatSessionStatus): boolean {
	return state === ChatSessionStatus.InProgress || state === ChatSessionStatus.NeedsInput;
}

export interface IChatSessionFileChange2 {
	readonly uri: URI;
	readonly originalUri?: URI;
	readonly modifiedUri?: URI;
	readonly insertions: number;
	readonly deletions: number;
	readonly reviewed?: boolean;
}

export function isIChatSessionFileChange2(obj: unknown): obj is IChatSessionFileChange2 {
	const candidate = obj as IChatSessionFileChange2;
	return candidate && candidate.uri instanceof URI && typeof candidate.insertions === 'number' && typeof candidate.deletions === 'number';
}
