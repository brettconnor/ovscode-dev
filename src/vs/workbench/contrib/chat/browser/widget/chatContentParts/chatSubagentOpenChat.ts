/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatSubagentOpenChat.css';
import { $, addDisposableListener, EventType, WindowIntervalTimer } from '../../../../../../base/browser/dom.js';
import { BaseActionViewItem, IActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { createPixelSpinner } from '../../../../../../base/browser/ui/pixelSpinner/pixelSpinner.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { formatElapsedTime } from '../../../common/chatProgressFormatting.js';
import { formatCopilotCreditsLabel } from '../../../common/chatService/chatService.js';
import { ChatConfiguration } from '../../../common/constants.js';
import { AUTO_RAW_MODEL_ID, ILanguageModelsService } from '../../../common/languageModels.js';
import { getChatMarkdownRenderOptions } from '../chatContentMarkdownRenderer.js';
import { renderFileWidgets } from './chatInlineAnchorWidget.js';
import { IChatMarkdownAnchorService } from './chatMarkdownAnchorService.js';
import { getCompactCodicon } from '../../chatIcons.js';

export interface ISubagentPillContext {
	readonly chatResource?: string;
	readonly isChatAvailable?: boolean;
	readonly parentSessionResource?: string;
	readonly title?: string;
	readonly agentType?: string;
	readonly confirmationCount?: number;
	readonly confirmationActive?: boolean;
	readonly startedAt?: number;
	readonly duration?: number;
	readonly modelId?: string;
	readonly modelName?: string;
	/** Copilot credits (AIC) this subagent has consumed so far. */
	readonly credits?: number;
	readonly parentModelId?: string;
	readonly parentModelName?: string;
	readonly parentResolvedModelId?: string;
	readonly isActive?: boolean;
	readonly activeToolCallId?: string;
	readonly activeToolLabel?: string;
	readonly activeToolIcon?: ThemeIcon;
}

export type SubagentPillContext = Omit<ISubagentPillContext, 'chatResource' | 'isChatAvailable'>;

export type SubagentChatStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

function asSubagentPillContext(context: unknown): ISubagentPillContext | undefined {
	return context && typeof context === 'object' ? context as ISubagentPillContext : undefined;
}

/** Compares known model identities, falling back to labels for legacy invocations. A concrete model always shows under an Auto parent. */
export function shouldShowSubagentModel(subagentModelName: string | undefined, parentModelId: string | undefined, parentModelName: string | undefined, parentModelMetadataId: string | undefined, subagentModelId?: string): boolean {
	const normalize = (value: string | undefined) => value?.trim().toLowerCase();
	const subagent = normalize(subagentModelName);
	if (!subagent || subagent === AUTO_RAW_MODEL_ID) {
		return false;
	}
	const parentIdSuffix = parentModelId?.slice(parentModelId.lastIndexOf(':') + 1);
	const parents = [parentModelId, parentIdSuffix, parentModelName, parentModelMetadataId].map(normalize);
	// The picker can move to Auto after the request starts, so decide Auto from the
	// request's own model id and consult the live selection only when it is absent.
	const autoCandidates = parentModelId ? [parentModelId, parentIdSuffix].map(normalize) : parents;
	if (autoCandidates.includes(AUTO_RAW_MODEL_ID)) {
		return true;
	}
	if (subagentModelId && parentModelId) {
		return subagentModelId !== parentModelId;
	}
	return !parents.includes(subagent);
}

export function formatCompactSubagentDuration(startedAt: number, duration: number | undefined, now: number = Date.now()): string {
	const end = duration === undefined ? now : startedAt + Math.max(0, duration);
	return formatElapsedTime(Math.max(0, end - startedAt));
}

export function shouldAnimateSubagentToolTransition(displayedToolCallId: string | undefined, displayedIsTool: boolean, targetToolCallId: string | undefined, targetIsTool: boolean): boolean {
	if (!displayedIsTool && !targetIsTool) {
		return false;
	}
	return displayedIsTool !== targetIsTool || displayedToolCallId !== targetToolCallId;
}

export class SubagentProgressPillActionViewItem extends BaseActionViewItem {
	private readonly _showElapsedOnly: boolean;
	private _resolvedTitle: string | undefined;
	private _reportedAgentType: string | undefined;
	private _reportedModelName: string | undefined;
	private _reportedCredits: number | undefined;
	private _renderedStatus: SubagentChatStatus | undefined;
	private _confirmationCount = 0;
	private readonly _spinner = this._register(new MutableDisposable<DisposableStore>());
	private readonly _durationTimer = this._register(new WindowIntervalTimer());
	private readonly _toolTransition = this._register(new MutableDisposable<DisposableStore>());
	private readonly _activeToolRendered = this._register(new MutableDisposable());
	private readonly _activeToolFileWidgets = this._register(new DisposableStore());
	private readonly _pillHover = this._register(new MutableDisposable());
	private _labelElement: HTMLElement | undefined;
	private _agentTypeElement: HTMLElement | undefined;
	private _pillContentElement: HTMLElement | undefined;
	private _modelElement: HTMLElement | undefined;
	private _creditsElement: HTMLElement | undefined;
	private _durationElement: HTMLElement | undefined;
	private _activeToolElement: HTMLElement | undefined;
	private _activeToolIconElement: HTMLElement | undefined;
	private _activeToolLabelElement: HTMLElement | undefined;
	private _confirmationCountElement: HTMLElement | undefined;
	private _iconElement: HTMLElement | undefined;
	private _statusIconElement: HTMLElement | undefined;
	private _displayedToolLabel: string | undefined;
	private _displayedToolIcon: ThemeIcon | undefined;
	private _displayedToolCallId: string | undefined;
	private _displayedToolAccessibleLabel: string | undefined;
	private _targetToolLabel: string | undefined;
	private _targetToolIcon: ThemeIcon | undefined;
	private _targetToolCallId: string | undefined;
	private _targetActivityIsTool: boolean = false;
	private _displayedActivityIsTool: boolean = false;
	private _toolTransitionPhase: 'idle' | 'out' | 'in' = 'idle';

	constructor(
		context: unknown,
		action: IAction,
		options: IActionViewItemOptions & { readonly showElapsedOnly?: boolean },
		_openInEditor: boolean = false,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatMarkdownAnchorService private readonly chatMarkdownAnchorService: IChatMarkdownAnchorService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@ILanguageModelsService protected readonly languageModelsService: ILanguageModelsService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(context, action, options);
		this._showElapsedOnly = options.showElapsedOnly ?? false;
		this._register(this.accessibilityService.onDidChangeReducedMotion(() => {
			if (this.accessibilityService.isMotionReduced()) {
				this._finishToolTransition();
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.SubagentsShowCreditUsage)) {
				this._updateCredits();
				this.updateTooltip();
			}
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-subagent-pill-widget');
		container.setAttribute('role', 'button');

		this._iconElement = $('span.chat-subagent-pill-icon');
		this._statusIconElement = $(`span.chat-subagent-pill-open-icon${ThemeIcon.asCSSSelector(Codicon.commentDiscussion)}`);
		this._iconElement.appendChild(this._statusIconElement);
		this._agentTypeElement = $('span.chat-subagent-pill-agent-type.hidden');
		this._labelElement = $('span.chat-subagent-pill-label');
		this._modelElement = $('span.chat-subagent-pill-model.hidden');
		this._confirmationCountElement = $('span.chat-subagent-pill-confirmation-count');
		const pillContent = $('span.chat-subagent-pill-content');
		this._pillContentElement = pillContent;
		const pillHeader = $('span.chat-subagent-pill-header');
		this._durationElement = $('span.chat-subagent-pill-duration.hidden');
		this._creditsElement = $('span.chat-subagent-pill-credits.hidden');
		this._activeToolElement = $('span.chat-subagent-pill-active-tool.hidden');
		this._activeToolElement.inert = true;
		const connector = $('span.chat-subagent-pill-active-tool-connector');
		connector.setAttribute('aria-hidden', 'true');
		this._activeToolIconElement = $('span.chat-subagent-pill-active-tool-icon');
		this._activeToolIconElement.setAttribute('aria-hidden', 'true');
		this._activeToolLabelElement = $('.chat-subagent-pill-active-tool-label');
		this._activeToolElement.append(connector, this._activeToolIconElement, this._activeToolLabelElement);
		pillContent.append(this._iconElement, this._agentTypeElement, this._labelElement, this._modelElement, this._confirmationCountElement);
		pillHeader.append(pillContent, this._durationElement, this._creditsElement);
		container.append(pillHeader, this._activeToolElement);
		this._pillHover.value = this.hoverService.setupDelayedHover(pillContent, () => ({ content: this.getTooltip() ?? '' }));
		this._update();
	}

	override setActionContext(newContext: unknown): void {
		super.setActionContext(newContext);
		this._update();
	}

	protected get pillContext(): SubagentPillContext | undefined {
		return asSubagentPillContext(this._context);
	}

	protected get modelName(): string | undefined {
		return this.pillContext?.modelName;
	}

	protected get showModel(): boolean {
		const context = this.pillContext;
		const parentModel = context?.parentModelId ? this.languageModelsService.lookupLanguageModel(context.parentModelId) : undefined;
		return shouldShowSubagentModel(this.modelName, context?.parentModelId, context?.parentModelName ?? parentModel?.name, context?.parentResolvedModelId ?? parentModel?.id, context?.modelId);
	}

	protected get isActive(): boolean {
		return this.pillContext?.isActive === true;
	}

	protected get activityLabel(): string {
		return localize('chat.subagent.working', "Working on it...");
	}

	protected get activityAriaLabel(): string | undefined {
		return this._displayedToolAccessibleLabel;
	}

	protected _update(): void {
		if (!this.element) {
			return;
		}
		const context = this.pillContext;
		this._setResolvedTitle(context?.title || this._resolvedTitle);
		this._setAgentType(context?.agentType);
		this._reportedModelName = this.modelName;
		this._setModelName(this.showModel ? this._reportedModelName : undefined);
		this._setCredits(context?.credits);
		this._updateConfirmationCount(context);
		this._updateStatus();
		this._updateDuration(context);
		const showActivity = this.isActive && (context?.confirmationCount ?? 0) === 0;
		const activeToolLabel = showActivity ? context?.activeToolLabel : undefined;
		this._setActiveTool(
			showActivity ? activeToolLabel ?? this.activityLabel : undefined,
			showActivity ? context?.activeToolIcon ?? (activeToolLabel ? undefined : Codicon.comment) : undefined,
			showActivity ? context?.activeToolCallId : undefined,
			!!activeToolLabel,
		);
		this.updateTooltip();
		this.updateEnabled();
		this.updateAriaLabel();
	}

	private _setModelName(modelName: string | undefined): void {
		if (this._modelElement) {
			this._modelElement.textContent = modelName ?? '';
			this._modelElement.classList.toggle('hidden', !modelName);
		}
	}

	private _setCredits(credits: number | undefined): void {
		// Zero-cost subagents report 0 rather than nothing, so normalize both to hidden.
		this._reportedCredits = typeof credits === 'number' && credits > 0 ? credits : undefined;
		this._updateCredits();
	}

	private _updateCredits(): void {
		const credits = this._reportedCredits;
		const show = credits !== undefined && this._showCreditUsage;
		if (this._creditsElement) {
			this._creditsElement.textContent = show ? formatCopilotCreditsLabel(credits) : '';
			this._creditsElement.classList.toggle('hidden', !show);
		}
	}

	private get _showCreditUsage(): boolean {
		return this.configurationService.getValue<boolean>(ChatConfiguration.SubagentsShowCreditUsage) === true;
	}

	private _setAgentType(agentType: string | undefined): void {
		this._reportedAgentType = agentType;
		if (this._agentTypeElement) {
			this._agentTypeElement.textContent = agentType ?? '';
			this._agentTypeElement.classList.toggle('hidden', !agentType);
		}
	}

	protected get status(): SubagentChatStatus | undefined {
		const context = this.pillContext;
		return (context?.confirmationCount ?? 0) > 0
			? 'waiting'
			: this.isActive
				? 'running'
				: context?.isActive === false
					? 'completed'
					: undefined;
	}

	protected get statusIcon(): ThemeIcon {
		return Codicon.commentDiscussion;
	}

	private _updateStatus(): void {
		const status = this.status;
		if (this._statusIconElement) {
			this._statusIconElement.className = `chat-subagent-pill-open-icon ${ThemeIcon.asClassName(this.statusIcon)}`;
		}
		if (status === this._renderedStatus) {
			return;
		}
		this._renderedStatus = status;
		const waiting = status === 'waiting';
		const running = status === 'running';
		this.element?.classList.toggle('chat-subagent-running', running);
		this.element?.classList.toggle('chat-subagent-waiting', waiting);
		this._spinner.clear();
		if ((running || waiting) && this._iconElement) {
			const store = new DisposableStore();
			const spinner = store.add(createPixelSpinner(this._iconElement, { variant: waiting ? 'ring' : 'grid' }));
			store.add(toDisposable(() => spinner.element.remove()));
			this._spinner.value = store;
		}
	}

	private _updateConfirmationCount(context: SubagentPillContext | undefined): void {
		const count = context?.confirmationCount ?? 0;
		const confirmationActive = !!context?.confirmationActive;
		this._confirmationCount = count;
		this.element?.classList.toggle('chat-subagent-needs-confirmation', count > 0);
		this.element?.classList.toggle('chat-subagent-has-multiple-confirmations', count > 1);
		this.element?.classList.toggle('chat-subagent-confirmation-active', count > 0 && confirmationActive);
		this.element?.classList.toggle('chat-subagent-confirmation-pending', count > 0 && !confirmationActive);
		if (this._confirmationCountElement) {
			this._confirmationCountElement.textContent = String(count);
		}
	}

	protected get duration(): number | undefined {
		return this.pillContext?.duration;
	}

	protected get showDuration(): boolean {
		return true;
	}

	protected get durationLabel(): string | undefined {
		return this._durationElement?.textContent ?? undefined;
	}

	private _updateDuration(context: SubagentPillContext | undefined): void {
		this._durationTimer.cancel();
		const startedAt = context?.startedAt;
		const durationValue = this.duration;
		if (!this._durationElement || startedAt === undefined || !this.showDuration) {
			this._durationElement?.classList.add('hidden');
			if (this._durationElement) {
				this._durationElement.textContent = '';
			}
			return;
		}
		const update = () => {
			const duration = formatCompactSubagentDuration(startedAt, durationValue);
			this._durationElement!.textContent = this._showElapsedOnly
				? duration
				: durationValue === undefined
					? localize('chat.subagent.workingDuration', "Working for {0}", duration)
					: localize('chat.subagent.workedDuration', "Worked for {0}", duration);
			this.updateAriaLabel();
		};
		update();
		this._durationElement.classList.remove('hidden');
		if (durationValue === undefined) {
			this._durationTimer.cancelAndSet(update, 1000);
		}
	}

	private _setActiveTool(label: string | undefined, icon: ThemeIcon | undefined, toolCallId: string | undefined, isTool: boolean): void {
		this._targetToolLabel = label;
		this._targetToolIcon = icon;
		this._targetToolCallId = toolCallId;
		this._targetActivityIsTool = isTool;
		if (!this._activeToolElement || !this._activeToolLabelElement || !this._activeToolIconElement) {
			return;
		}
		this._activeToolElement.classList.toggle('hidden', !label);
		if (!label) {
			this._toolTransition.clear();
			this._toolTransitionPhase = 'idle';
			this._clearToolTransitionClasses();
			this._activeToolRendered.clear();
			this._activeToolFileWidgets.clear();
			this._activeToolLabelElement.textContent = '';
			this._displayedToolLabel = undefined;
			this._displayedToolIcon = undefined;
			this._displayedToolCallId = undefined;
			this._displayedToolAccessibleLabel = undefined;
			this._displayedActivityIsTool = false;
			this._renderActiveToolIcon(undefined);
			return;
		}
		if (!this._displayedToolLabel || this.accessibilityService.isMotionReduced()) {
			this._finishToolTransition();
			return;
		}
		if (this._toolTransitionPhase === 'idle' && !shouldAnimateSubagentToolTransition(this._displayedToolCallId, this._displayedActivityIsTool, toolCallId, isTool)) {
			this._setDisplayedTool(label, icon, toolCallId, isTool);
			return;
		}
		this._runToolTransition();
	}

	private _runToolTransition(): void {
		if (!this._activeToolLabelElement || this._toolTransitionPhase !== 'idle') {
			return;
		}
		if (!shouldAnimateSubagentToolTransition(this._displayedToolCallId, this._displayedActivityIsTool, this._targetToolCallId, this._targetActivityIsTool)) {
			this._setDisplayedTool(this._targetToolLabel ?? '', this._targetToolIcon, this._targetToolCallId, this._targetActivityIsTool);
			return;
		}
		this._toolTransitionPhase = 'out';
		if (!this._restartToolTransition('chat-subagent-tool-fade-out')) {
			this._completeToolTransition();
		}
	}

	private _completeToolTransition(): void {
		this._toolTransition.clear();
		if (this._toolTransitionPhase === 'out') {
			this._toolTransitionPhase = 'in';
			this._setDisplayedTool(this._targetToolLabel ?? '', this._targetToolIcon, this._targetToolCallId, this._targetActivityIsTool);
			if (!this._restartToolTransition('chat-subagent-tool-fade-in')) {
				this._completeToolTransition();
			}
			return;
		}
		if (this._toolTransitionPhase === 'in') {
			this._clearToolTransitionClasses();
			this._toolTransitionPhase = 'idle';
			this._runToolTransition();
		}
	}

	private _finishToolTransition(): void {
		this._toolTransition.clear();
		this._toolTransitionPhase = 'idle';
		this._clearToolTransitionClasses();
		if (this._targetToolLabel) {
			this._setDisplayedTool(this._targetToolLabel, this._targetToolIcon, this._targetToolCallId, this._targetActivityIsTool);
		}
	}

	private _setDisplayedTool(label: string, icon: ThemeIcon | undefined, toolCallId: string | undefined, isTool: boolean): void {
		if (!this._activeToolLabelElement) {
			return;
		}
		const sameIcon = icon === this._displayedToolIcon
			|| (icon !== undefined && this._displayedToolIcon !== undefined && ThemeIcon.isEqual(icon, this._displayedToolIcon));
		if (this._activeToolLabelElement.hasChildNodes() && label === this._displayedToolLabel && sameIcon
			&& toolCallId === this._displayedToolCallId && isTool === this._displayedActivityIsTool) {
			return;
		}
		this._activeToolRendered.clear();
		this._activeToolFileWidgets.clear();
		this._activeToolLabelElement.textContent = '';
		const rendered = this.markdownRendererService.render(new MarkdownString(label), getChatMarkdownRenderOptions(), this._activeToolLabelElement);
		renderFileWidgets(rendered.element, this.instantiationService, this.chatMarkdownAnchorService, this._activeToolFileWidgets);
		this._activeToolRendered.value = rendered;
		this._displayedToolLabel = label;
		this._displayedToolIcon = icon;
		this._displayedToolCallId = toolCallId;
		this._displayedToolAccessibleLabel = rendered.element.textContent?.replace(/\s+/g, ' ').trim() || label;
		this._displayedActivityIsTool = isTool;
		this._renderActiveToolIcon(icon);
		this.updateTooltip();
		this.updateAriaLabel();
	}

	private _renderActiveToolIcon(icon: ThemeIcon | undefined): void {
		if (!this._activeToolIconElement) {
			return;
		}
		this._activeToolIconElement.className = 'chat-subagent-pill-active-tool-icon';
		if (icon) {
			this._activeToolIconElement.classList.add(...ThemeIcon.asClassNameArray(getCompactCodicon(icon)));
		}
	}

	private _clearToolTransitionClasses(): void {
		this._activeToolLabelElement?.classList.remove('chat-subagent-tool-fade-in', 'chat-subagent-tool-fade-out');
	}

	private _restartToolTransition(className: string): boolean {
		if (!this._activeToolLabelElement) {
			return false;
		}
		this._toolTransition.clear();
		this._clearToolTransitionClasses();
		const transition = new DisposableStore();
		const complete = (event: AnimationEvent) => {
			if (event.target === this._activeToolLabelElement) {
				this._completeToolTransition();
			}
		};
		transition.add(addDisposableListener(this._activeToolLabelElement, EventType.ANIMATION_END, complete));
		transition.add(addDisposableListener(this._activeToolLabelElement, 'animationcancel', complete));
		this._toolTransition.value = transition;
		void this._activeToolLabelElement.offsetWidth;
		this._activeToolLabelElement.classList.add(className);
		if (this._activeToolLabelElement.getAnimations().length === 0) {
			this._toolTransition.clear();
			this._clearToolTransitionClasses();
			return false;
		}
		return true;
	}

	private _setResolvedTitle(title: string | undefined): void {
		this._resolvedTitle = title;
		if (this._labelElement) {
			this._labelElement.textContent = title || this._action.label;
		}
	}

	protected override getTooltip(): string | undefined {
		const details: string[] = [this._resolvedTitle || this._action.label];
		if (this._confirmationCount > 0) {
			details.push(this._confirmationCount === 1
				? localize('chat.subagent.confirmationTooltip', "1 confirmation needed")
				: localize('chat.subagent.confirmationsTooltip', "{0} confirmations needed", this._confirmationCount));
		}
		if (this._reportedAgentType) {
			details.push(localize('chat.subagent.agentTypeTooltip', "Subagent type: {0}", this._reportedAgentType));
		}
		if (this._reportedModelName) {
			details.push(localize('chat.subagent.modelTooltip', "Model: {0}", this._reportedModelName));
		}
		if (this._reportedCredits !== undefined && this._showCreditUsage) {
			details.push(formatCopilotCreditsLabel(this._reportedCredits));
		}
		if (this._displayedToolAccessibleLabel && this._displayedActivityIsTool) {
			details.push(localize('chat.subagent.activeToolTooltip', "Active tool: {0}", this._displayedToolAccessibleLabel));
		}
		return details.join('\n');
	}

	protected override updateTooltip(): void {
		this.updateAriaLabel();
	}

	protected override updateEnabled(): void {
		if (!this.element) {
			return;
		}
		this.element.classList.remove('disabled');
		this.element.classList.toggle('hidden', !this.pillContext);
		this.element.setAttribute('role', 'group');
		this.element.removeAttribute('aria-disabled');
		this.element.removeAttribute('tabindex');
		this.element.draggable = false;
	}

	protected override updateAriaLabel(): void {
		if (!this.element) {
			return;
		}
		const label = this._resolvedTitle || this._action.label;
		const status = this._renderedStatus === 'running'
			? localize('chat.subagent.status.working', "Subagent is working")
			: this._renderedStatus === 'waiting'
				? localize('chat.subagent.status.waiting', "Subagent is waiting for input")
				: this._renderedStatus === 'completed'
					? localize('chat.subagent.status.completed', "Subagent completed")
					: undefined;
		const agentType = this._reportedAgentType ? localize('chat.subagent.agentAria', "Subagent type {0}", this._reportedAgentType) : undefined;
		const model = this._reportedModelName ? localize('chat.subagent.modelAria', "Model {0}", this._reportedModelName) : undefined;
		const activeTool = this._displayedToolAccessibleLabel && this._displayedActivityIsTool
			? localize('chat.subagent.activeToolAria', "Active tool {0}", this._displayedToolAccessibleLabel)
			: undefined;
		const duration = this._durationElement?.textContent;
		const credits = this._creditsElement?.textContent;
		this.element.setAttribute('aria-label', [label, agentType, status, model, activeTool, duration, credits].filter(Boolean).join('. '));
	}
}
