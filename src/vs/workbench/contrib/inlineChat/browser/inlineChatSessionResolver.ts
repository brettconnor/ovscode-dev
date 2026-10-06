/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IChatModelReference, IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';

export const IInlineChatSessionResolver = createDecorator<IInlineChatSessionResolver>('inlineChatSessionResolver');

/** Result of resolving the chat model used by the editor inline chat surface. */
export interface IInlineChatSessionResolution {
	readonly modelRef: IChatModelReference;
}

/** Resolves the chat model reference used by the editor inline chat surface. */
export interface IInlineChatSessionResolver {
	readonly _serviceBrand: undefined;
	resolve(token: CancellationToken, languageId: string | undefined, targetUri: URI): Promise<IInlineChatSessionResolution | undefined>;
}

/** Starts the local Chat model used by editor inline chat. */
export class InlineChatSessionResolver implements IInlineChatSessionResolver {
	declare readonly _serviceBrand: undefined;

	constructor(@IChatService private readonly _chatService: IChatService) { }

	async resolve(token: CancellationToken, _languageId: string | undefined, _targetUri: URI): Promise<IInlineChatSessionResolution | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const modelRef = this._chatService.startNewLocalSession(ChatAgentLocation.EditorInline, {
			canUseTools: false /* SEE https://github.com/microsoft/vscode/issues/279946 */,
		});
		if (token.isCancellationRequested) {
			modelRef.dispose();
			return undefined;
		}
		return { modelRef };
	}
}
