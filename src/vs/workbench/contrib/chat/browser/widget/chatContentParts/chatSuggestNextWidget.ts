/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../../common/constants.js';
import { IChatMode } from '../../../common/chatModes.js';
import { IHandOff } from '../../../common/promptSyntax/promptFileParser.js';

export interface INextPromptSelection {
	readonly handoff: IHandOff;
	readonly agentId?: string;
	readonly withAutopilot?: boolean;
}

export class ChatSuggestNextWidget extends Disposable {
	public readonly domNode: HTMLElement;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	private readonly _onDidSelectPrompt = this._register(new Emitter<INextPromptSelection>());
	public readonly onDidSelectPrompt: Event<INextPromptSelection> = this._onDidSelectPrompt.event;

	private promptsContainer!: HTMLElement;
	private titleElement!: HTMLElement;
	private _currentMode: IChatMode | undefined;
	private buttonDisposables = new Map<HTMLElement, DisposableStore>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.domNode = this.createSuggestNextWidget();
	}

	public get height(): number {
		return this.domNode.style.display === 'none' ? 0 : this.domNode.offsetHeight;
	}

	public getCurrentMode(): IChatMode | undefined {
		return this._currentMode;
	}

	private createSuggestNextWidget(): HTMLElement {
		// Reuse welcome view classes for consistent styling
		const container = dom.$('.chat-suggest-next-widget.chat-welcome-view-suggested-prompts');
		container.style.display = 'none';

		// Title element using welcome view class
		this.titleElement = dom.append(container, dom.$('.chat-welcome-view-suggested-prompts-title'));

		// Container for prompt buttons
		this.promptsContainer = container;

		return container;
	}

	public render(mode: IChatMode): void {
		const handoffs = mode.handOffs?.get();

		if (!handoffs || handoffs.length === 0) {
			this.hide();
			return;
		}

		this._currentMode = mode;

		// Update title with mode name: "Proceed from {Mode}"
		const modeName = mode.name.get() || mode.label.get() || localize('chat.currentMode', 'current mode');
		this.titleElement.textContent = localize('chat.proceedFrom', 'Proceed from {0}', modeName);

		// Clear existing prompt buttons (keep title which is first child)
		const childrenToRemove: HTMLElement[] = [];
		for (let i = 1; i < this.promptsContainer.children.length; i++) {
			childrenToRemove.push(this.promptsContainer.children[i] as HTMLElement);
		}
		for (const child of childrenToRemove) {
			const disposables = this.buttonDisposables.get(child);
			if (disposables) {
				disposables.dispose();
				this.buttonDisposables.delete(child);
			}
			this.promptsContainer.removeChild(child);
		}

		const isAutopilotPolicyRestricted = this.configurationService.inspect<boolean>(ChatConfiguration.GlobalAutoApprove).policyValue === false;
		const firstAutoSendHandoff = !isAutopilotPolicyRestricted ? handoffs.find(h => h.send) : undefined;

		for (const handoff of handoffs) {
			const promptButton = this.createPromptButton(handoff);
			this.promptsContainer.appendChild(promptButton);

			if (handoff === firstAutoSendHandoff) {
				const autopilotButton = this.createAutopilotButton(handoff);
				this.promptsContainer.appendChild(autopilotButton);
			}
		}

		this.domNode.style.display = 'flex';
		this._onDidChangeHeight.fire();
	}

	private createPromptButton(handoff: IHandOff): HTMLElement {
		const disposables = new DisposableStore();

		// Capture the label to look up the current handoff at click time
		// This ensures we get the latest handoff data (e.g., updated model from settings)
		const handoffLabel = handoff.label;
		const getCurrentHandoff = (): IHandOff | undefined => {
			const currentHandoffs = this._currentMode?.handOffs?.get();
			return currentHandoffs?.find(h => h.label === handoffLabel) ?? handoff;
		};

		const button = dom.$('.chat-welcome-view-suggested-prompt');
		button.setAttribute('tabindex', '0');
		button.setAttribute('role', 'button');
		button.setAttribute('aria-label', localize('chat.suggestNext.item', '{0}', handoff.label));

		const titleElement = dom.append(button, dom.$('.chat-welcome-view-suggested-prompt-title'));
		titleElement.textContent = handoff.label;

		disposables.add(dom.addDisposableListener(button, 'click', () => {
			const currentHandoff = getCurrentHandoff();
			if (currentHandoff) {
				this._onDidSelectPrompt.fire({ handoff: currentHandoff });
			}
		}));

		disposables.add(dom.addDisposableListener(button, 'keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				const currentHandoff = getCurrentHandoff();
				if (currentHandoff) {
					this._onDidSelectPrompt.fire({ handoff: currentHandoff });
				}
			}
		}));

		// Store disposables for this button so they can be disposed when the button is removed
		this.buttonDisposables.set(button, disposables);

		return button;
	}

	private createAutopilotButton(handoff: IHandOff): HTMLElement {
		const disposables = new DisposableStore();

		const handoffLabel = handoff.label;
		const getCurrentHandoff = (): IHandOff | undefined => {
			const currentHandoffs = this._currentMode?.handOffs?.get();
			return currentHandoffs?.find(h => h.label === handoffLabel) ?? handoff;
		};

		const label = localize('chat.suggestNext.startWithAutopilot', "Start with Autopilot");
		const button = dom.$('.chat-welcome-view-suggested-prompt');
		button.setAttribute('tabindex', '0');
		button.setAttribute('role', 'button');
		button.setAttribute('aria-label', label);

		const titleElement = dom.append(button, dom.$('.chat-welcome-view-suggested-prompt-title'));
		titleElement.textContent = label;

		disposables.add(dom.addDisposableListener(button, 'click', () => {
			const currentHandoff = getCurrentHandoff();
			if (currentHandoff) {
				this._onDidSelectPrompt.fire({ handoff: currentHandoff, withAutopilot: true });
			}
		}));

		disposables.add(dom.addDisposableListener(button, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				const currentHandoff = getCurrentHandoff();
				if (currentHandoff) {
					this._onDidSelectPrompt.fire({ handoff: currentHandoff, withAutopilot: true });
				}
			}
		}));

		this.buttonDisposables.set(button, disposables);

		return button;
	}

	public hide(): void {
		if (this.domNode.style.display !== 'none') {
			this._currentMode = undefined;
			this.domNode.style.display = 'none';
			this._onDidChangeHeight.fire();
		}
	}

	public override dispose(): void {
		// Dispose all button disposables
		for (const disposables of this.buttonDisposables.values()) {
			disposables.dispose();
		}
		this.buttonDisposables.clear();
		super.dispose();
	}
}
