/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IDictationOnboardingService } from '../../speechToText/dictationOnboarding.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from './chatInputNoticeHost.js';

/**
 * Docks the dictation introduction above one chat input.
 *
 * Kept out of `chatInputNoticeHost` so the arbitration primitive stays unaware of
 * the features competing for the space it hands out.
 */
export function registerChatInputOnboardingHosts(
	host: ChatInputNoticeHost,
	containers: { readonly dictation: HTMLElement },
	focusRoot: HTMLElement,
	focusInput: () => void,
	dictationOnboardingService: IDictationOnboardingService,
): IDisposable {
	const claimNotice = (options: Parameters<ChatInputNoticeHost['occupy']>[1]) => host.occupy(ChatInputNoticeLane.Onboarding, options);

	const store = new DisposableStore();
	store.add(dictationOnboardingService.registerHost({
		container: containers.dictation,
		focusRoot,
		focus: focusInput,
		claimNotice,
	}));
	return store;
}
