/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../../../base/common/observable.js';
import { OS } from '../../../../../../base/common/platform.js';
import { upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { KeybindingsRegistry } from '../../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver } from '../../../../../../platform/keybinding/common/keybindingResolver.js';
import { ResolvedKeybindingItem } from '../../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { IChatWidget, IChatWidgetService } from '../../../browser/chat.js';
import { ChatQueueMessageAction, ChatSteerWithMessageAction, registerChatQueueActions } from '../../../browser/actions/chatQueueActions.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ChatConfiguration } from '../../../common/constants.js';
import { IChatModel, IChatRequestModel } from '../../../common/model/chatModel.js';
import { IChatViewModel } from '../../../common/model/chatViewModel.js';
import { ChatRequestQueueKind } from '../../../common/chatService/chatService.js';

// Register actions once so the keybindings appear in KeybindingsRegistry.
registerChatQueueActions();

suite('Queue/Steer keybinding resolution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function buildResolverForCommands(commandIds: string[]): KeybindingResolver {
		const items: ResolvedKeybindingItem[] = [];
		for (const item of KeybindingsRegistry.getDefaultKeybindingsForOS(OS)) {
			if (!item.command || !commandIds.includes(item.command) || !item.keybinding) {
				continue;
			}
			const resolved = USLayoutResolvedKeybinding.resolveKeybinding(item.keybinding, OS)[0];
			items.push(new ResolvedKeybindingItem(resolved, item.command, item.commandArgs, item.when ?? undefined, true, null, false));
		}
		return new KeybindingResolver(items, [], () => { });
	}

	function lookupForConfig(defaultAction: 'steer' | 'queue', preparing = false) {
		const config = new TestConfigurationService({ [ChatConfiguration.RequestQueueingDefaultAction]: defaultAction });
		const ctxService = new ContextKeyService(config);
		// Simulate the chat input being focused with a request in progress, like the picker does.
		const overlay = ctxService.createOverlay([
			[ChatContextKeys.inputHasText.key, true],
			[ChatContextKeys.inChatInput.key, true],
			[ChatContextKeys.requestInProgress.key, true],
			[ChatContextKeys.transcriptProgressActive.key, preparing],
		]);
		const resolver = buildResolverForCommands([ChatQueueMessageAction.ID, ChatSteerWithMessageAction.ID]);
		return {
			result: {
				queue: resolver.lookupPrimaryKeybinding(ChatQueueMessageAction.ID, overlay, true)?.resolvedKeybinding?.getDispatchChords()[0] ?? null,
				steer: resolver.lookupPrimaryKeybinding(ChatSteerWithMessageAction.ID, overlay, true)?.resolvedKeybinding?.getDispatchChords()[0] ?? null,
			},
			dispose: () => ctxService.dispose(),
		};
	}

	test('with default=steer, Enter steers and Alt+Enter queues', () => {
		const { result, dispose } = lookupForConfig('steer');
		try {
			assert.deepStrictEqual(result, { queue: 'alt+Enter', steer: 'Enter' });
		} finally {
			dispose();
		}
	});

	test('with default=queue, Enter queues and Alt+Enter steers', () => {
		const { result, dispose } = lookupForConfig('queue');
		try {
			assert.deepStrictEqual(result, { queue: 'Enter', steer: 'alt+Enter' });
		} finally {
			dispose();
		}
	});

	test('preparation disables Enter and Alt+Enter queueing for either default', () => {
		for (const defaultAction of ['steer', 'queue'] as const) {
			const { result, dispose } = lookupForConfig(defaultAction, true);
			try {
				assert.deepStrictEqual(result, { queue: null, steer: null });
			} finally {
				dispose();
			}
		}
	});
});

suite('ChatSteerWithMessageAction', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function run(isHiddenFromTranscript: boolean, preparing = false, action = new ChatSteerWithMessageAction()): ChatRequestQueueKind | undefined {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(new TestInstantiationService());
		let queue: ChatRequestQueueKind | undefined;
		instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({
			lastFocusedWidget: upcastPartial<IChatWidget>({
				isTranscriptProgressActive: preparing,
				getInput: () => 'follow up',
				acceptInput: async (_query, options) => {
					queue = options?.queue;
					return undefined;
				},
				viewModel: upcastPartial<IChatViewModel>({
					model: upcastPartial<IChatModel>({
						requestInProgress: constObservable(true),
						lastRequest: upcastPartial<IChatRequestModel>({ isHiddenFromTranscript }),
					}),
				}),
			}),
		}));

		instantiationService.invokeFunction(accessor => action.run(accessor));
		return queue;
	}

	test('queues behind a hidden active request instead of steering it', () => {
		assert.deepStrictEqual({
			hidden: run(true),
			visible: run(false),
		}, {
			hidden: ChatRequestQueueKind.Queued,
			visible: ChatRequestQueueKind.Steering,
		});
	});

	test('direct queue and steer commands cannot dispatch during preparation', () => {
		assert.deepStrictEqual({
			steer: run(false, true),
			queue: run(false, true, new ChatQueueMessageAction()),
		}, { steer: undefined, queue: undefined });
	});
});
