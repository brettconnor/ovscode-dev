/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatModelReference, IChatService } from '../../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';

export const ITerminalChatSessionResolver = createDecorator<ITerminalChatSessionResolver>('terminalChatSessionResolver');

/** Result of resolving the chat model used by the terminal chat surface. */
export interface ITerminalChatSessionResolution {
	readonly modelRef: IChatModelReference;
	/**
	 * The chat session contribution the widget must lock to so requests carry
	 * `agentIdSilent` and reach the Agent Host agent instead of the default
	 * terminal participant. `undefined` for a local fallback session, which
	 * must stay on the legacy extension-host agent.
	 */
	readonly lockToAgent: undefined;
}

/** Resolves the chat model reference used by the terminal chat surface. */
export interface ITerminalChatSessionResolver {
	readonly _serviceBrand: undefined;
	resolve(token: CancellationToken, shellType: string | undefined, os: OperatingSystem): Promise<ITerminalChatSessionResolution | undefined>;
}

/** Builds the Agent Host metadata for a terminal chat session. */
export function getTerminalChatSessionMeta(shellType: string | undefined, os: OperatingSystem): Record<string, unknown> {
	return withChatSurfaceMeta(undefined, {
		surface: 'terminal',
		shellType,
		osName: getOperatingSystemName(os),
	})!;
}

function getOperatingSystemName(os: OperatingSystem): string {
	switch (os) {
		case OperatingSystem.Windows:
			return 'Windows';
		case OperatingSystem.Macintosh:
			return 'macOS';
		case OperatingSystem.Linux:
			return 'Linux';
	}
}

/** Applies terminal-specific Agent Host and local-session fallback policy. */
export class TerminalChatSessionResolver implements ITerminalChatSessionResolver {
	declare readonly _serviceBrand: undefined;

	constructor(@IChatService private readonly _chatService: IChatService) { }

	async resolve(token: CancellationToken, _shellType: string | undefined, _os: OperatingSystem): Promise<ITerminalChatSessionResolution | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const modelRef = this._chatService.startNewLocalSession(ChatAgentLocation.Terminal);
		if (token.isCancellationRequested) {
			modelRef.dispose();
			return undefined;
		}
		return { modelRef, lockToAgent: undefined };
	}
}
