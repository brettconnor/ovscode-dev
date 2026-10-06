/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { revive } from '../../../../../base/common/marshalling.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeyExprs, ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatService, ResponseModelState } from '../../common/chatService/chatService.js';
import type { ISerializableChatData } from '../../common/model/chatModel.js';
import { isChatTreeItem, isRequestVM, isResponseVM } from '../../common/model/chatViewModel.js';
import { CHAT_CATEGORY } from './chatActions.js';
import { ChatTreeItem, ChatViewPaneTarget, IChatWidgetService } from '../chat.js';

export const ForkConversationActionId = 'workbench.action.chat.forkConversation';

export interface IForkConversationOptions {
	readonly toSide?: boolean;
}

export class ForkConversationAction extends Action2 {
	constructor() {
		super({
			id: ForkConversationActionId,
			title: localize2('chat.forkConversation.label', "Fork Conversation"),
			tooltip: localize2('chat.forkConversation.tooltip', "Fork conversation from this point"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.repoForked,
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ChatContextKeys.readOnly.negate()),
			menu: [
				{
					id: MenuId.ChatMessageCheckpoint,
					group: 'navigation',
					order: 3,
					when: ContextKeyExpr.and(
						ChatContextKeys.isRequest,
						ChatContextKeys.isFirstRequest.negate(),
						ContextKeyExpr.or(
							ContextKeyExpr.or(ChatContextKeys.lockedToCodingAgent.negate(), ChatContextKeyExprs.isAgentHostSession),
							ChatContextKeys.chatSessionSupportsFork
						),
						ChatContextKeys.readOnly.negate()
					)
				}
			]
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]) {
		const chatWidgetService = accessor.get(IChatWidgetService);
		const instantiationService = accessor.get(IInstantiationService);
		const chatService = accessor.get(IChatService);
		const forkedTitlePrefix = localize('chat.forked.titlePrefix', "Forked: ");

		// When invoked via /fork slash command, args[0] is a URI (sessionResource).
		// Fork at the last request in that session.
		if (URI.isUri(args[0])) {
			const sourceSessionResource = args[0];

			const chatModel = chatService.getSession(sourceSessionResource);
			if (!chatModel) {
				return;
			}

			const serializedData = chatModel.toJSON();
			if (serializedData.requests.length === 0) {
				return;
			}

			const cleanData = revive(JSON.parse(JSON.stringify(serializedData))) as ISerializableChatData;
			cleanData.sessionId = generateUuid();
			const forkTimestamp = Date.now();
			cleanData.creationDate = forkTimestamp;
			cleanData.customTitle = chatModel.title.startsWith(forkedTitlePrefix)
				? chatModel.title
				: localize('chat.forked.title', "Forked: {0}", chatModel.title);
			for (const [index, req] of cleanData.requests.entries()) {
				req.shouldBeRemovedOnSend = undefined;
				req.isHidden = undefined;
				// Generate fresh IDs so the tree doesn't reuse stale DOM from the source session
				req.requestId = generateUuid();
				req.responseId = req.responseId ? generateUuid() : undefined;
				req.timestamp = forkTimestamp + index;
				if (req.response) {
					req.modelState = { value: ResponseModelState.Complete, completedAt: forkTimestamp + index };
				}
			}

			const modelRef = chatService.loadSessionFromData(cleanData, 'ChatForkActions#forkCleanSession', 'currentSession');

			// Defer navigation until after the slash command flow completes.
			const newSessionResource = modelRef.object.sessionResource;
			setTimeout(async () => {
				try {
					await this._openForkedSession(instantiationService, chatModel.sessionResource, newSessionResource);
				} finally {
					modelRef.dispose();
				}
			}, 0);
			return;
		}

		// When invoked from the checkpoint menu, args[0] is a ChatTreeItem.
		const arg = args[0] as (IForkConversationOptions & { element?: unknown; context?: unknown; item?: unknown }) | undefined;
		const options: IForkConversationOptions | undefined = arg?.toSide === true ? { toSide: true } : undefined;
		let item: ChatTreeItem | undefined = isChatTreeItem(arg)
			? arg
			: isChatTreeItem(arg?.element)
				? arg.element
				: isChatTreeItem(arg?.context)
					? arg.context
					: isChatTreeItem(arg?.item)
						? arg.item
						: undefined;
		const widget = item ? chatWidgetService.getWidgetBySessionResource(item.sessionResource) : chatWidgetService.lastFocusedWidget;
		if (!isResponseVM(item) && !isRequestVM(item)) {
			item = widget?.getFocus();
		}

		if (!item) {
			return;
		}

		const sessionResource = widget?.viewModel?.sessionResource ?? (isChatTreeItem(item) ? item.sessionResource : undefined);
		if (!sessionResource) {
			return;
		}

		// Get all requests and find the target request index
		const targetRequestId = isRequestVM(item) ? item.id : isResponseVM(item) ? item.requestId : undefined;
		if (!targetRequestId) {
			return;
		}

		const chatModel = chatService.getSession(sessionResource);
		if (!chatModel) {
			return;
		}

		// Export the full session data and truncate to include only requests up to and including the target
		const serializedData = chatModel.toJSON();
		const isRequestItem = isRequestVM(item);
		let targetIndex = -1;
		if (widget?.viewModel) {
			let requestIndex = -1;
			for (const entry of widget.viewModel.getItems()) {
				if (isRequestVM(entry)) {
					requestIndex += 1;
				}
				if (entry.id === item?.id) {
					targetIndex = isRequestVM(entry) ? Math.max(0, requestIndex - 1) : requestIndex;
					break;
				}
			}
		}
		if (targetIndex < 0) {
			const requestIndex = chatModel.getRequests().findIndex(r => r.id === targetRequestId);
			targetIndex = isRequestItem ? Math.max(0, requestIndex - 1) : requestIndex;
		}
		if (targetIndex < 0) {
			return;
		}

		const forkedData = revive(JSON.parse(JSON.stringify({
			...serializedData,
			requests: serializedData.requests.slice(0, targetIndex + 1),
		}))) as ISerializableChatData;
		forkedData.sessionId = generateUuid();
		const forkedTimestamp = Date.now();
		forkedData.creationDate = forkedTimestamp;
		forkedData.customTitle = chatModel.title.startsWith(forkedTitlePrefix)
			? chatModel.title
			: localize('chat.forked.title', "Forked: {0}", chatModel.title);
		for (const [index, req] of forkedData.requests.entries()) {
			req.shouldBeRemovedOnSend = undefined;
			req.isHidden = undefined;
			// Generate fresh IDs so the tree doesn't reuse stale DOM from the source session
			req.requestId = generateUuid();
			req.responseId = req.responseId ? generateUuid() : undefined;
			req.timestamp = forkedTimestamp + index;
			if (req.response) {
				req.modelState = { value: ResponseModelState.Complete, completedAt: forkedTimestamp + index };
			}
		}

		const modelRef = chatService.loadSessionFromData(forkedData, 'ChatForkActions#forkSession', 'currentSession');

		if (!modelRef) {
			return;
		}

		// Navigate to the new session in the chat view pane
		try {
			const newSessionResource = modelRef.object.sessionResource;
			await this._openForkedSession(instantiationService, chatModel.sessionResource, newSessionResource, options);
		} finally {
			modelRef.dispose();
		}
	}

	protected async _openForkedSession(instantiationService: IInstantiationService, parentSessionResource: URI, forkedSessionResource: URI, _options?: IForkConversationOptions): Promise<void> {
		await instantiationService.invokeFunction(async accessor => {
			const chatWidgetService = accessor.get(IChatWidgetService);
			await chatWidgetService.openSession(forkedSessionResource, ChatViewPaneTarget, { sessionTypeSelectionReason: 'currentSession' });
		});
	}

}
