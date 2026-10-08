/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../../base/common/codicons.js';
import type { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { getSubagentIsActive } from '../../../common/chatService/chatService.js';
import { getLanguageModelDisplayNameWithSubscriptionSource } from '../../../common/languageModelSourcePresentation.js';
import { getLanguageModelDisplayNameWithProvider } from '../../../common/languageModels.js';
import { getChatSessionType } from '../../../common/model/chatUri.js';
import { SubagentProgressPillActionViewItem, SubagentPillContext, type SubagentChatStatus } from './chatSubagentOpenChat.js';

export interface ISubagentPhaseContext extends SubagentPillContext {
	readonly presentation: 'phase';
	readonly phaseStatus?: 'running' | 'succeeded' | 'failed' | 'cancelled';
	readonly chatResource?: string;
	readonly isChatAvailable?: boolean;
	readonly activityLabel?: string;
}

function isSubagentPhaseContext(context: unknown): context is ISubagentPhaseContext {
	if (!context || typeof context !== 'object') {
		return false;
	}
	const candidate: { presentation?: unknown } = context;
	return candidate.presentation === 'phase';
}

/** A content-free phase summary using the subagent progress pill presentation. */
export class FusionPhasePillActionViewItem extends SubagentProgressPillActionViewItem {
	private _modelNameCache: { modelId: string; parentSessionResource: string; name: string | undefined } | undefined;

	protected override get pillContext(): ISubagentPhaseContext | undefined {
		return isSubagentPhaseContext(this._context) ? this._context : undefined;
	}

	override render(container: HTMLElement): void {
		super.render(container);
		const refreshModel = () => {
			this._modelNameCache = undefined;
			this._update();
		};
		this._register(this.languageModelsService.onDidChangeLanguageModels(refreshModel));
		this._register(this.languageModelsService.onDidChangeLanguageModelVendors(refreshModel));
	}

	protected override get modelName(): string | undefined {
		const context = this.pillContext;
		const rawModelId = context?.modelId;
		const parentSessionResource = context?.parentSessionResource;
		if (rawModelId && parentSessionResource) {
			if (this._modelNameCache?.modelId !== rawModelId || this._modelNameCache.parentSessionResource !== parentSessionResource) {
				const sessionType = getChatSessionType(URI.parse(parentSessionResource));
				let name: string | undefined;
				for (const identifier of this.languageModelsService.getLanguageModelIds()) {
					const metadata = this.languageModelsService.lookupLanguageModel(identifier);
					if (metadata?.targetChatSessionType === sessionType && (metadata.id === rawModelId || identifier === rawModelId)) {
						const model = { identifier, metadata };
						name = getLanguageModelDisplayNameWithSubscriptionSource(model, getLanguageModelDisplayNameWithProvider(model, this.languageModelsService));
						break;
					}
				}
				this._modelNameCache = { modelId: rawModelId, parentSessionResource, name };
			}
			return this._modelNameCache.name ?? context?.modelName ?? rawModelId;
		}
		return context?.modelName ?? rawModelId;
	}

	protected override get showModel(): boolean {
		return true;
	}

	protected override get isActive(): boolean {
		return !!this.pillContext && getSubagentIsActive(this.pillContext) === true;
	}

	protected override get activityLabel(): string {
		return this.pillContext?.activityLabel ?? super.activityLabel;
	}

	protected override get status(): SubagentChatStatus | undefined {
		const status = this.pillContext?.phaseStatus;
		return status === 'succeeded' ? 'completed' : status;
	}

	protected override get statusIcon(): ThemeIcon {
		return this.status === 'failed' ? Codicon.error : this.status === 'cancelled' ? Codicon.circleSlash : Codicon.check;
	}

	protected override get duration(): number | undefined {
		const duration = super.duration;
		return duration !== undefined && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
	}

	protected override get showDuration(): boolean {
		return this.isActive || this.duration !== undefined;
	}

	private get statusLabel(): string | undefined {
		switch (this.status) {
			case 'running': return localize('chat.phase.running', "Phase is running");
			case 'completed': return localize('chat.phase.completed', "Phase completed");
			case 'failed': return localize('chat.phase.failed', "Phase failed");
			case 'cancelled': return localize('chat.phase.cancelled', "Phase cancelled");
			default: return undefined;
		}
	}

	protected override getTooltip(): string {
		const modelName = this.modelName;
		return [
			localize('chat.phase.title', "HydraFusion phase: {0}", this.pillContext?.title ?? this.action.label),
			this.statusLabel,
			modelName ? localize('chat.phase.modelTooltip', "Model: {0}", modelName) : undefined,
		].filter(Boolean).join('\n');
	}

	protected override updateAriaLabel(): void {
		this.element?.setAttribute('aria-label', [this.getTooltip().replace(/\n/g, '. '), this.activityAriaLabel, this.durationLabel].filter(Boolean).join('. '));
	}
}
