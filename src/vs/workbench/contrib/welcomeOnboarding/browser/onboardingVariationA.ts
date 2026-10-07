/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { $, append, addDisposableListener, EventType, clearNode, getActiveWindow } from '../../../../base/browser/dom.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { assertDefined } from '../../../../base/common/types.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { localize } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action } from '../../../../base/common/actions.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { GitHubPaths, IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import product from '../../../../platform/product/common/product.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { InstallChatEvent, InstallChatClassification, ChatSetupStrategy } from '../../chat/browser/chatSetup/chatSetup.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import {
	OnboardingStepId,
	ONBOARDING_STEPS,
	ONBOARDING_AI_PREFERENCE_OPTIONS,
	AiCollaborationMode,
	IOnboardingThemeOption,
	getOnboardingStepTitle,
	getOnboardingStepSubtitle,
	GHE_FULL_URI_REGEX,
	GheParseResultKind,
	parseGheInstanceInput,
} from '../common/onboardingTypes.js';
import { IOnboardingService } from '../common/onboardingService.js';

type OnboardingStepViewClassification = {
	owner: 'cwebster-99';
	comment: 'Tracks which onboarding step is viewed.';
	step: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The step identifier.' };
	stepNumber: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The 1-based step index.' };
};

type OnboardingStepViewEvent = {
	step: string;
	stepNumber: number;
};

type OnboardingActionClassification = {
	owner: 'cwebster-99';
	comment: 'Tracks actions taken on the onboarding wizard.';
	action: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The action performed.' };
	step: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The step the action was performed on.' };
	argument: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Optional context such as theme id, extension id, or provider.' };
};

type OnboardingActionEvent = {
	action: string;
	step: string;
	argument: string | undefined;
};

type EnterpriseSignInUiState = 'options' | 'instance' | 'progress';

assertDefined(product.defaultChatAgent, 'Onboarding requires a default chat agent product configuration.');
const defaultChat = product.defaultChatAgent;

/**
 * Variation A — Classic Wizard Modal
 *
 * A centered modal overlay with progress dots, clean step transitions,
 * and polished navigation. Sits on top of the agent sessions welcome
 * tab. When dismissed, the welcome tab is revealed underneath.
 *
 * Steps:
 * 1. Sign In — sessions-style sign-in hero with GitHub Copilot, Google, and Apple options
 * 2. Personalize — Theme selection grid + keymap pills
 */
export class OnboardingVariationA extends Disposable implements IOnboardingService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidComplete = this._register(new Emitter<void>());
	readonly onDidComplete: Event<void> = this._onDidComplete.event;

	private readonly _onDidDismiss = this._register(new Emitter<void>());
	readonly onDidDismiss: Event<void> = this._onDidDismiss.event;

	private overlay: HTMLElement | undefined;
	private card: HTMLElement | undefined;
	private bodyEl: HTMLElement | undefined;
	private progressContainer: HTMLElement | undefined;
	private stepLabelEl: HTMLElement | undefined;
	private titleEl: HTMLElement | undefined;
	private subtitleEl: HTMLElement | undefined;
	private contentEl: HTMLElement | undefined;
	private backButton: HTMLButtonElement | undefined;
	private nextButton: HTMLButtonElement | undefined;
	private closeButton: HTMLButtonElement | undefined;
	private footerLeft: HTMLElement | undefined;
	private _footerSignInBtn: HTMLButtonElement | undefined;

	private currentStepIndex = 0;
	private readonly steps = ONBOARDING_STEPS;
	private readonly disposables = this._register(new DisposableStore());
	private readonly stepDisposables = this._register(new DisposableStore());
	private previouslyFocusedElement: HTMLElement | undefined;
	private _isShowing = false;

	private readonly footerFocusableElements: HTMLElement[] = [];
	private readonly stepFocusableElements: HTMLElement[] = [];
	private selectedThemeId = 'dark-2026';
	private _userSignedIn = false;
	private selectedAiMode: AiCollaborationMode = AiCollaborationMode.Balanced;
	private enterpriseSignInUiState: EnterpriseSignInUiState = 'options';
	private enterpriseInstanceValue = '';
	private enterpriseSignInWatch: StopWatch | undefined;

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ICommandService private readonly commandService: ICommandService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
	) {
		super();

		// Detect currently active theme
		const currentTheme = this.themeService.getColorTheme();
		const allThemes = product.onboardingThemes ?? [];
		const matchingTheme = allThemes.find(t => t.themeId === currentTheme.settingsId);
		if (matchingTheme) {
			this.selectedThemeId = matchingTheme.id;
		}

		// Start detecting installed editors early so results are ready by the Personalize step
	}

	get isShowing(): boolean {
		return this._isShowing;
	}

	show(): void {
		if (this.overlay) {
			return;
		}

		this._isShowing = true;
		this.previouslyFocusedElement = getActiveWindow().document.activeElement as HTMLElement | undefined;

		const container = this.layoutService.activeContainer;

		// Overlay
		this.overlay = append(container, $('.onboarding-a-overlay'));
		this.overlay.setAttribute('role', 'dialog');
		this.overlay.setAttribute('aria-modal', 'true');
		this.overlay.setAttribute('aria-label', localize('onboarding.a.aria', "Welcome to Visual Studio Code"));

		// Card
		this.card = append(this.overlay, $('.onboarding-a-card'));

		// Close button (upper-right corner of card)
		this.closeButton = append(this.card, $<HTMLButtonElement>('button.onboarding-a-close-btn'));
		this.closeButton.type = 'button';
		this.closeButton.setAttribute('aria-label', localize('onboarding.close', "Close"));
		this.closeButton.appendChild(renderIcon(Codicon.close));

		// Header with progress
		const header = append(this.card, $('.onboarding-a-header'));
		this.progressContainer = append(header, $('.onboarding-a-progress'));
		this.stepLabelEl = append(this.progressContainer, $('span.onboarding-a-step-label'));
		this._renderProgress();

		// Body
		this.bodyEl = append(this.card, $('.onboarding-a-body'));
		this.titleEl = append(this.bodyEl, $('h2.onboarding-a-step-title'));
		this.subtitleEl = append(this.bodyEl, $('p.onboarding-a-step-subtitle'));
		this.contentEl = append(this.bodyEl, $('.onboarding-a-step-content'));
		this._renderStep();
		this._logStepView();

		// Footer
		const footer = append(this.card, $('.onboarding-a-footer'));

		this.footerLeft = append(footer, $('.onboarding-a-footer-left'));

		const footerRight = append(footer, $('.onboarding-a-footer-right'));

		this.backButton = append(footerRight, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-secondary'));
		this.backButton.textContent = localize('onboarding.back', "Back");
		this.backButton.type = 'button';
		this.footerFocusableElements.push(this.backButton);

		this.nextButton = append(footerRight, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-primary'));
		this.nextButton.type = 'button';
		this.footerFocusableElements.push(this.nextButton);
		this._updateButtonStates();

		// Event handlers
		this.disposables.add(addDisposableListener(this.closeButton, EventType.CLICK, () => {
			this._logAction('skip');
			this._dismiss('skip');
		}));
		this.disposables.add(addDisposableListener(this.backButton, EventType.CLICK, () => {
			if (this.currentStepIndex === 0 && this.enterpriseSignInUiState === 'instance') {
				this._logAction('cancelEnterpriseInstancePrompt');
				this.enterpriseSignInWatch = undefined;
				this._setEnterpriseSignInUiState('options');
				return;
			}

			this._logAction('back');
			this._prevStep();
		}));
		this.disposables.add(addDisposableListener(this.nextButton, EventType.CLICK, () => {
			if (this._isLastStep()) {
				this._logAction('complete');
				this._dismiss('complete');
			} else if (this.currentStepIndex === 0) {
				this._logAction('continueWithoutSignIn');
				this._nextStep();
			} else {
				this._logAction('next');
				this._nextStep();
			}
		}));

		this.disposables.add(addDisposableListener(this.overlay, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			if (e.target === this.overlay) {
				this._dismiss('skip');
			}
		}));

		this.disposables.add(addDisposableListener(this.overlay, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);

			// Prevent all keyboard shortcuts from reaching the keybinding service
			e.stopPropagation();

			if (event.keyCode === KeyCode.Escape) {
				e.preventDefault();
				this._dismiss('skip');
				return;
			}

			if (event.keyCode === KeyCode.Tab) {
				this._trapTab(e, event.shiftKey);
			}
		}));

		// Entrance animation
		this.overlay.classList.add('entering');
		getActiveWindow().requestAnimationFrame(() => {
			this.overlay?.classList.remove('entering');
			this.overlay?.classList.add('visible');
		});

		this._focusCurrentStepElement();
	}

	private _dismiss(reason: 'complete' | 'skip'): void {
		if (!this.overlay) {
			return;
		}

		this._logAction('dismiss', undefined, reason);

		this.overlay.classList.remove('visible');
		this.overlay.classList.add('exiting');

		let handled = false;
		const onTransitionEnd = () => {
			if (handled) {
				return;
			}
			handled = true;
			this._removeFromDOM();
			if (reason === 'complete') {
				this._onDidComplete.fire();
			}
			this._onDidDismiss.fire();
		};

		this.overlay.addEventListener('transitionend', onTransitionEnd, { once: true });
		setTimeout(onTransitionEnd, 400);
	}

	private _nextStep(): void {
		if (this.currentStepIndex < this.steps.length - 1) {
			const leavingStep = this.steps[this.currentStepIndex];
			if (leavingStep === OnboardingStepId.SignIn) {
				this.enterpriseSignInUiState = 'options';
				this.enterpriseInstanceValue = '';
				this.enterpriseSignInWatch = undefined;
			}
			this.currentStepIndex++;
			this._renderStep();
			this._renderProgress();
			this._updateButtonStates();
			this._focusCurrentStepElement();
			this._logStepView();
		}
	}

	private _prevStep(): void {
		if (this.currentStepIndex > 0) {
			this.currentStepIndex--;
			this._renderStep();
			this._renderProgress();
			this._updateButtonStates();
			this._focusCurrentStepElement();
			this._logStepView();
		}
	}

	private _isLastStep(): boolean {
		return this.currentStepIndex === this.steps.length - 1;
	}

	private _renderProgress(): void {
		if (!this.progressContainer || !this.stepLabelEl) {
			return;
		}

		clearNode(this.progressContainer);

		for (let i = 0; i < this.steps.length; i++) {
			const dot = append(this.progressContainer, $('span.onboarding-a-progress-dot'));
			if (i === this.currentStepIndex) {
				dot.classList.add('active');
			} else if (i < this.currentStepIndex) {
				dot.classList.add('completed');
			}
		}

		this.progressContainer.appendChild(this.stepLabelEl);
		this.stepLabelEl.textContent = localize(
			'onboarding.stepOf',
			"{0} of {1}",
			this.currentStepIndex + 1,
			this.steps.length
		);
	}

	private _renderStep(): void {
		if (!this.titleEl || !this.subtitleEl || !this.contentEl) {
			return;
		}

		this.stepDisposables.clear();
		this.stepFocusableElements.length = 0;

		const stepId = this.steps[this.currentStepIndex];
		const useSignInHero = stepId === OnboardingStepId.SignIn;
		this.titleEl.style.display = useSignInHero ? 'none' : '';
		this.subtitleEl.style.display = useSignInHero ? 'none' : '';
		this.titleEl.textContent = getOnboardingStepTitle(stepId);
		if (stepId === OnboardingStepId.Personalize) {
			this._renderPersonalizeSubtitle(this.subtitleEl);
		} else {
			this.subtitleEl.textContent = getOnboardingStepSubtitle(stepId);
		}

		clearNode(this.contentEl);

		switch (stepId) {
			case OnboardingStepId.SignIn:
				this._renderSignInStep(this.contentEl);
				break;
			case OnboardingStepId.Personalize:
				this._renderPersonalizeStep(this.contentEl);
				break;
			case OnboardingStepId.AiPreference:
				this._renderAiPreferenceStep(this.contentEl);
				break;
		}

		this.bodyEl?.setAttribute('aria-label', localize(
			'onboarding.step.aria',
			"Step {0} of {1}: {2}",
			this.currentStepIndex + 1,
			this.steps.length,
			getOnboardingStepTitle(stepId)
		));
	}

	private _updateButtonStates(): void {
		if (this.backButton) {
			const showEnterpriseBack = this.currentStepIndex === 0 && this.enterpriseSignInUiState === 'instance';
			this.backButton.style.display = (this.currentStepIndex === 0 && !showEnterpriseBack) ? 'none' : '';
		}
		if (this.nextButton) {
			if (this.currentStepIndex === 0) {
				if (this._userSignedIn) {
					this.nextButton.className = 'onboarding-a-btn onboarding-a-btn-primary';
					this.nextButton.textContent = localize('onboarding.continue', "Continue");
				} else {
					// Sign-in step: secondary "Continue without Signing In"
					this.nextButton.className = 'onboarding-a-btn onboarding-a-btn-secondary';
					this.nextButton.textContent = localize('onboarding.continueWithoutSignIn', "Continue without Signing In");
				}
			} else if (this._isLastStep()) {
				this.nextButton.className = 'onboarding-a-btn onboarding-a-btn-primary';
				this.nextButton.textContent = localize('onboarding.getStarted', "Get Started");
			} else {
				this.nextButton.className = 'onboarding-a-btn onboarding-a-btn-primary';
				this.nextButton.textContent = localize('onboarding.next', "Continue");
			}
		}
		if (this.footerLeft) {
			if (this._isLastStep()) {
				// Show sign-in nudge in footer
				if (!this._footerSignInBtn && !this._userSignedIn) {
					this._footerSignInBtn = append(this.footerLeft, $<HTMLButtonElement>('button.onboarding-a-signin-nudge-btn'));
					this._footerSignInBtn.type = 'button';
					this._footerSignInBtn.textContent = localize('onboarding.sessions.signInNudge', "Sign in to use GitHub Copilot");
					this.stepDisposables.add(addDisposableListener(this._footerSignInBtn, EventType.CLICK, async () => {
						this._logAction('signInNudge');
						await this._handleSignIn();
						if (this._userSignedIn && this._footerSignInBtn) {
							this._footerSignInBtn.style.display = 'none';
						}
					}));
				}
			} else {
				if (this._footerSignInBtn) {
					this._footerSignInBtn.remove();
					this._footerSignInBtn = undefined;
				}
			}
		}
	}

	// =====================================================================
	// Step: Sign In
	// =====================================================================

	private _renderSignInStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-a-signin'));
		const brand = append(wrapper, $('.onboarding-a-signin-brand'));
		const brandIcon = append(brand, $('span.onboarding-a-signin-brand-icon'));
		brandIcon.setAttribute('role', 'img');
		brandIcon.setAttribute('aria-label', product.nameLong);

		const content = append(wrapper, $('.onboarding-a-signin-content'));
		const contentMain = append(content, $('.onboarding-a-signin-content-main'));
		const title = append(contentMain, $('h2.onboarding-a-signin-title'));
		title.textContent = localize('onboarding.signIn.heroTitle', "Welcome to VS Code");

		const subtitle = append(contentMain, $('p.onboarding-a-signin-subtitle'));
		subtitle.textContent = localize('onboarding.signIn.heroSubtitle', "Sign in to use GitHub Copilot.");

		const actions = append(contentMain, $('.onboarding-a-signin-actions'));

		if (this._userSignedIn) {
			const signedIn = append(actions, $('.onboarding-a-signin-confirmation'));
			const icon = append(signedIn, $('span'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
			icon.setAttribute('aria-hidden', 'true');
			const text = append(signedIn, $('span'));
			text.textContent = localize('onboarding.signIn.signedIn', "You're signed in. You can continue to the next step.");
		} else {
			switch (this.enterpriseSignInUiState) {
				case 'instance':
					this._renderEnterpriseInstanceForm(actions);
					break;
				case 'progress':
					this._renderEnterpriseSignInProgress(actions);
					break;
				default:
					this._renderDefaultSignInActions(actions);
					break;
			}
		}

		const footer = append(wrapper, $('.onboarding-a-signin-footer'));

		const disclaimerCol = append(footer, $('.onboarding-a-signin-disclaimer-col'));

		// GitHub Copilot disclaimer
		const copilotDisclaimer = append(disclaimerCol, $('.onboarding-a-signin-disclaimer'));
		copilotDisclaimer.append(localize('onboarding.signIn.disclaimer.prefix', "By signing in, you agree to {0}'s ", defaultChat.provider.default.name));
		this._createInlineLink(copilotDisclaimer, localize('onboarding.signIn.disclaimer.terms', "Terms"), defaultChat.termsStatementUrl);
		copilotDisclaimer.append(localize('onboarding.signIn.disclaimer.middle', " and "));
		this._createInlineLink(copilotDisclaimer, localize('onboarding.signIn.disclaimer.privacy', "Privacy Statement"), defaultChat.privacyStatementUrl);
		copilotDisclaimer.append(localize('onboarding.signIn.disclaimer.copilotPrefix', ". {0} Copilot may show ", defaultChat.provider.default.name));
		this._createInlineLink(copilotDisclaimer, localize('onboarding.signIn.disclaimer.publicCode', "public code"), defaultChat.publicCodeMatchesUrl);
		copilotDisclaimer.append(localize('onboarding.signIn.disclaimer.improveSuffix', " suggestions and use your data to improve the product."));
		copilotDisclaimer.append(' ');
		copilotDisclaimer.append(localize('onboarding.signIn.disclaimer.settingsPrefix', "You can change these "));
		this._createInlineLink(copilotDisclaimer, localize('onboarding.signIn.disclaimer.settings', "settings"), this.defaultAccountService.resolveGitHubUrl(GitHubPaths.copilotSettings));
		copilotDisclaimer.append(localize('onboarding.signIn.disclaimer.suffix', " anytime."));
	}

	private _renderDefaultSignInActions(actions: HTMLElement): void {
		const githubBtn = this._registerStepFocusable(this._createSignInButton(actions, 'github', localize('onboarding.signIn.github', "Continue with GitHub"), {
			emphasized: true,
			label: localize('onboarding.signIn.github.aria', "Continue with GitHub")
		}));
		this.stepDisposables.add(addDisposableListener(githubBtn, EventType.CLICK, () => {
			this._logAction('signIn', undefined, 'github');
			this._handleSignIn();
		}));

		const googleBtn = this._registerStepFocusable(this._createSignInButton(actions, 'google', localize('onboarding.signIn.google', "Continue with Google"), {
			iconOnly: true,
			label: localize('onboarding.signIn.google', "Continue with Google")
		}));
		this.stepDisposables.add(addDisposableListener(googleBtn, EventType.CLICK, () => {
			this._logAction('signIn', undefined, 'google');
			this._handleSignIn('google');
		}));

		const appleBtn = this._registerStepFocusable(this._createSignInButton(actions, 'apple', localize('onboarding.signIn.apple', "Continue with Apple"), {
			iconOnly: true,
			label: localize('onboarding.signIn.apple', "Continue with Apple")
		}));
		this.stepDisposables.add(addDisposableListener(appleBtn, EventType.CLICK, () => {
			this._logAction('signIn', undefined, 'apple');
			this._handleSignIn('apple');
		}));

		const gheBtn = this._registerStepFocusable(this._createSignInButton(actions, 'github-enterprise', localize('onboarding.signIn.ghe', "GHE"), {
			textOnly: true,
			label: localize('onboarding.signIn.ghe.aria', "Continue with GitHub Enterprise")
		}));
		this.stepDisposables.add(addDisposableListener(gheBtn, EventType.CLICK, () => {
			this._logAction('signIn', undefined, 'github-enterprise');
			void this._handleEnterpriseSignIn();
		}));
	}

	private static readonly GHE_INPUT_ACTION_PADDING = 28;

	private _renderEnterpriseInstanceForm(actions: HTMLElement): void {
		const enterprisePromptLabel = this._getEnterpriseInstancePromptLabel();

		const container = append(actions, $('.onboarding-a-signin-ghe-input'));

		const submitAction = this.stepDisposables.add(new Action(
			'onboarding.signIn.enterprise.submit',
			localize('onboarding.signIn.enterprise.continue', "Continue"),
			ThemeIcon.asClassName(Codicon.arrowRight),
			false,
		));

		const inputBox = this.stepDisposables.add(new InputBox(container, undefined, {
			placeholder: localize('onboarding.signIn.enterprise.placeholder', 'i.e. "octocat" or "https://octocat.ghe.com"...'),
			ariaLabel: enterprisePromptLabel,
			actions: [submitAction],
			inputBoxStyles: defaultInputBoxStyles,
		}));
		inputBox.value = this.enterpriseInstanceValue;
		inputBox.paddingRight = OnboardingVariationA.GHE_INPUT_ACTION_PADDING;
		const input = this._registerStepFocusable(inputBox.inputElement);

		const submit = async () => {
			const result = parseGheInstanceInput(inputBox.value);
			if (result.kind === GheParseResultKind.Empty || result.kind === GheParseResultKind.Invalid) {
				validate();
				return;
			}
			await this._submitEnterpriseInstance(result.resolvedUri);
		};
		submitAction.run = submit;

		const message = append(container, $('.onboarding-a-signin-ghe-message'));

		const validate = (): boolean => {
			this.enterpriseInstanceValue = inputBox.value;
			inputBox.element.classList.remove('error');
			message.classList.remove('error', 'info');

			const result = parseGheInstanceInput(inputBox.value);
			switch (result.kind) {
				case GheParseResultKind.Empty:
					message.textContent = enterprisePromptLabel;
					submitAction.enabled = false;
					return false;
				case GheParseResultKind.SingleWord:
					message.classList.add('info');
					message.textContent = localize('onboarding.signIn.enterprise.resolve', "Will resolve to {0}", result.resolvedUri);
					submitAction.enabled = true;
					return true;
				case GheParseResultKind.FullUri:
					submitAction.enabled = true;
					message.textContent = '';
					return true;
				case GheParseResultKind.Invalid:
					inputBox.element.classList.add('error');
					message.classList.add('error');
					message.textContent = localize('onboarding.signIn.enterprise.invalid', 'You must enter a valid {0} instance (i.e. "octocat" or "https://octocat.ghe.com")', defaultChat.provider.enterprise.name);
					submitAction.enabled = false;
					return false;
			}
		};

		this.stepDisposables.add(inputBox.onDidChange(() => {
			validate();
		}));

		this.stepDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Enter) {
				e.preventDefault();
				void submitAction.run();
				return;
			}

			if (event.keyCode === KeyCode.Escape) {
				e.preventDefault();
				e.stopPropagation();
				this._logAction('cancelEnterpriseInstancePrompt');
				this.enterpriseSignInWatch = undefined;
				this._setEnterpriseSignInUiState('options');
			}
		}));

		validate();
	}

	private _renderEnterpriseSignInProgress(actions: HTMLElement): void {
		const container = append(actions, $('.onboarding-a-signin-ghe-progress'));
		container.setAttribute('aria-live', 'polite');
		const spinner = append(container, $('span'));
		spinner.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
		spinner.setAttribute('aria-hidden', 'true');
		const message = append(container, $('.onboarding-a-signin-ghe-progress-message'));
		message.textContent = localize('onboarding.signIn.enterprise.progress', "Waiting for {0} sign-in to complete...", defaultChat.provider.enterprise.name);
	}

	private _getEnterpriseInstancePromptLabel(): string {
		return localize('onboarding.signIn.enterprise.prompt', "What is your {0} instance?", defaultChat.provider.enterprise.name);
	}

	private _setEnterpriseSignInUiState(state: EnterpriseSignInUiState): void {
		this.enterpriseSignInUiState = state;
		if (this.steps[this.currentStepIndex] === OnboardingStepId.SignIn && this.contentEl) {
			this._renderStep();
			this._updateButtonStates();
			this._focusCurrentStepElement();
		}
	}

	private _createSignInButton(parent: HTMLElement, providerClass: 'github' | 'github-enterprise' | 'google' | 'apple', label: string, options?: { emphasized?: boolean; iconOnly?: boolean; textOnly?: boolean; label?: string }): HTMLButtonElement {
		const isCompact = options?.iconOnly || options?.textOnly;
		const btn = append(parent, $<HTMLButtonElement>(isCompact ? 'button.onboarding-a-signin-icon-btn' : 'button.onboarding-a-signin-btn'));
		btn.type = 'button';
		btn.title = options?.label ?? label;
		btn.setAttribute('aria-label', options?.label ?? label);
		if (options?.emphasized) {
			btn.classList.add('primary');
		}

		if (!options?.textOnly) {
			const mark = append(btn, $('span.onboarding-a-provider-mark'));
			mark.classList.add(providerClass);
			mark.setAttribute('aria-hidden', 'true');
			if (providerClass === 'github' || providerClass === 'github-enterprise') {
				mark.appendChild(renderIcon(Codicon.github));
			}
		}

		if (!options?.iconOnly) {
			const labelEl = append(btn, $('span.onboarding-a-signin-btn-label'));
			labelEl.textContent = label;
		}

		return btn;
	}

	private async _handleSignIn(socialProvider?: string): Promise<void> {
		const provider = socialProvider ?? 'github';
		const watch = StopWatch.create();
		try {
			const account = await this.defaultAccountService.signIn({
				extraAuthorizeParameters: { get_started_with: 'copilot-vscode' },
				provider: socialProvider,
			});
			if (account) {
				this._userSignedIn = true;
				this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'installed', installDuration: watch.elapsed(), signUpErrorCode: undefined, provider });
				// Run chat setup in the background (sign-up, extension install, entitlement resolution)
				this.commandService.executeCommand('workbench.action.chat.triggerSetup', undefined, {
					disableChatViewReveal: true,
					setupStrategy: ChatSetupStrategy.DefaultSetup,
				});
				this._nextStep();
			}
		} catch (error) {
			if (isCancellationError(error)) {
				this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'cancelled', installDuration: watch.elapsed(), signUpErrorCode: undefined, provider });
				return;
			}

			this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedNotSignedIn', installDuration: watch.elapsed(), signUpErrorCode: undefined, provider });
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize('onboarding.signIn.error', "Sign-in failed. You can try again later from the Accounts menu."),
			});
		}
	}

	private async _handleEnterpriseSignIn(): Promise<void> {
		const existingUri = this.configurationService.getValue<string>(defaultChat.providerUriSetting);
		if (typeof existingUri !== 'string' || !GHE_FULL_URI_REGEX.test(existingUri)) {
			this.enterpriseInstanceValue = existingUri ?? '';
			this.enterpriseSignInWatch = StopWatch.create();
			this._setEnterpriseSignInUiState('instance');
			return;
		}

		this.enterpriseInstanceValue = existingUri;
		await this._runEnterpriseSignInSetup();
	}

	private async _submitEnterpriseInstance(resolvedUri: string): Promise<void> {
		try {
			await this.configurationService.updateValue(defaultChat.providerUriSetting, resolvedUri, ConfigurationTarget.USER);
			this.enterpriseInstanceValue = resolvedUri;
			await this._runEnterpriseSignInSetup();
		} catch {
			this.enterpriseSignInWatch = undefined;
			this._setEnterpriseSignInUiState('instance');
			this._notifyEnterpriseSignInError();
		}
	}

	private async _runEnterpriseSignInSetup(): Promise<void> {
		const watch = this.enterpriseSignInWatch ?? StopWatch.create();
		const provider = defaultChat.provider.enterprise.id;
		this._setEnterpriseSignInUiState('progress');

		try {
			const success = await this.commandService.executeCommand<boolean>('workbench.action.chat.triggerSetup', undefined, {
				disableChatViewReveal: true,
				setupStrategy: ChatSetupStrategy.SetupWithEnterpriseProvider,
			});

			if (success) {
				this._userSignedIn = true;
				this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'installed', installDuration: watch.elapsed(), signUpErrorCode: undefined, provider });
				this._nextStep();
			} else {
				this._setEnterpriseSignInUiState('options');
			}
		} catch (error) {
			if (isCancellationError(error)) {
				this._setEnterpriseSignInUiState('options');
				this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'cancelled', installDuration: watch.elapsed(), signUpErrorCode: undefined, provider });
				return;
			}

			this._setEnterpriseSignInUiState('instance');
			this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedNotSignedIn', installDuration: watch.elapsed(), signUpErrorCode: undefined, provider });
			this._notifyEnterpriseSignInError();
		} finally {
			this.enterpriseSignInWatch = undefined;
		}
	}

	private _notifyEnterpriseSignInError(): void {
		this.notificationService.notify({
			severity: Severity.Error,
			message: localize('onboarding.signIn.enterprise.error', "GitHub Enterprise sign-in failed. Check your instance URL and try again."),
		});
	}

	// =====================================================================
	// Step: Personalize (Theme + Keymap)
	// =====================================================================

	private _renderPersonalizeStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-a-personalize'));

		// Theme section
		const themeLabel = append(wrapper, $('div.onboarding-a-section-label'));
		themeLabel.textContent = localize('onboarding.personalize.theme', "Color Theme");

		const themeHint = append(wrapper, $('div.onboarding-a-theme-hint'));
		themeHint.textContent = localize('onboarding.personalize.themeHint', "You can browse and install more themes later from the Extensions view.");

		const themeGrid = append(wrapper, $('.onboarding-a-theme-grid'));
		themeGrid.setAttribute('role', 'radiogroup');
		themeGrid.setAttribute('aria-label', localize('onboarding.personalize.themeLabel', "Choose a color theme"));

		const allThemes = product.onboardingThemes ?? [];
		const themes: readonly IOnboardingThemeOption[] = allThemes;
		themeGrid.classList.add('theme-grid-expanded');

		const themeCards: HTMLElement[] = [];
		for (const theme of themes) {
			this._createThemeCard(themeGrid, theme, themeCards);
		}
		// Make all theme cards individually tabbable
		for (const card of themeCards) {
			card.setAttribute('tabindex', '0');
		}

	}

	private _renderPersonalizeSubtitle(container: HTMLElement): void {
		clearNode(container);
		const modifier = isMacintosh ? 'Cmd' : 'Ctrl';
		container.append(
			localize('onboarding.personalize.tip.prefix', "Tip: Press "),
			this._createKbd(localize({ key: 'onboarding.personalize.tip.modifier', comment: ['This is a keyboard modifier key, Ctrl on Windows/Linux or Cmd on Mac'] }, "{0}", modifier)),
			'+',
			this._createKbd(localize('onboarding.personalize.tip.shift', "Shift")),
			'+',
			this._createKbd(localize('onboarding.personalize.tip.p', "P")),
			localize('onboarding.personalize.tip.suffix', " to access all VS Code commands."),
		);
	}

	private _createThemeCard(parent: HTMLElement, theme: IOnboardingThemeOption, allCards: HTMLElement[]): void {
		const card = this._registerStepFocusable(append(parent, $('div.onboarding-a-theme-card')));
		allCards.push(card);
		card.setAttribute('role', 'radio');
		card.setAttribute('aria-checked', theme.id === this.selectedThemeId ? 'true' : 'false');
		card.setAttribute('aria-label', theme.label);

		if (theme.id === this.selectedThemeId) {
			card.classList.add('selected');
		}

		// SVG preview image
		const preview = append(card, $('div.onboarding-a-theme-preview'));
		const img = append(preview, $<HTMLImageElement>('img.onboarding-a-theme-preview-img'));
		img.alt = '';
		img.src = FileAccess.asBrowserUri(`vs/workbench/contrib/welcomeOnboarding/browser/media/theme-preview-${theme.id}.svg`).toString(true);

		// Label
		const label = append(card, $('div.onboarding-a-theme-label'));
		label.textContent = theme.label;

		this.stepDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
			this._logAction('selectTheme', undefined, theme.id);
			this._selectTheme(theme);
			for (const c of allCards) {
				c.classList.remove('selected');
				c.setAttribute('aria-checked', 'false');
			}
			card.classList.add('selected');
			card.setAttribute('aria-checked', 'true');
			this.accessibilityService.alert(localize('onboarding.theme.selected.alert', "{0} theme selected", theme.label));
		}));

		this.stepDisposables.add(addDisposableListener(card, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				card.click();
			}
		}));
	}

	// =====================================================================
	// Theme / Keymap helpers
	// =====================================================================

	private async _selectTheme(theme: IOnboardingThemeOption): Promise<void> {
		this.selectedThemeId = theme.id;
		const allThemes = await this.themeService.getColorThemes();
		const match = allThemes.find(t => t.settingsId === theme.themeId);
		if (match) {
			this.themeService.setColorTheme(match.id, ConfigurationTarget.USER);
		}
	}

	// =====================================================================
	// Step: AI Preference
	// =====================================================================

	private _renderAiPreferenceStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-a-ai-pref'));

		const cards = append(wrapper, $('.onboarding-a-ai-pref-cards'));
		cards.setAttribute('role', 'radiogroup');
		cards.setAttribute('aria-label', localize('onboarding.aiPref.label', "Choose your AI collaboration style"));

		const allCards: HTMLButtonElement[] = [];
		for (const option of ONBOARDING_AI_PREFERENCE_OPTIONS) {
			const card = this._registerStepFocusable(append(cards, $<HTMLButtonElement>('button.onboarding-a-ai-pref-card')));
			card.type = 'button';
			card.dataset.id = option.id;
			card.setAttribute('role', 'radio');
			card.setAttribute('aria-checked', option.id === this.selectedAiMode ? 'true' : 'false');
			allCards.push(card);

			if (option.id === this.selectedAiMode) {
				card.classList.add('selected');
			}

			const iconEl = append(card, $('span.onboarding-a-ai-pref-card-icon'));
			iconEl.setAttribute('aria-hidden', 'true');
			const icon = Codicon[option.icon as keyof typeof Codicon] ?? Codicon.sparkle;
			iconEl.appendChild(renderIcon(icon));

			const titleEl = append(card, $('div.onboarding-a-ai-pref-card-title'));
			titleEl.textContent = option.label;

			const descEl = append(card, $('div.onboarding-a-ai-pref-card-desc'));
			descEl.textContent = option.description;

			this.stepDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
				this._logAction('selectAiMode', undefined, option.id);
				this.selectedAiMode = option.id;
				for (const c of allCards) {
					c.classList.toggle('selected', c.dataset.id === option.id);
					c.setAttribute('aria-checked', c.dataset.id === option.id ? 'true' : 'false');
				}
				this._applyAiPreference(option.id);
				this.accessibilityService.alert(localize('onboarding.aiPref.selected.alert', "{0} selected", option.label));
			}));
		}
		const selectedAiIndex = ONBOARDING_AI_PREFERENCE_OPTIONS.findIndex(o => o.id === this.selectedAiMode);
		this._setupRadioGroupNavigation(allCards, Math.max(0, selectedAiIndex));

		const hint = append(wrapper, $('div.onboarding-a-ai-pref-hint'));
		hint.textContent = localize('onboarding.aiPref.hint', "You can change this anytime in Settings.");
	}

	private _applyAiPreference(mode: AiCollaborationMode): void {
		switch (mode) {
			case AiCollaborationMode.CodeFirst:
				this.configurationService.updateValue('chat.agent.autoFix', false, ConfigurationTarget.USER);
				break;
			case AiCollaborationMode.Balanced:
				this.configurationService.updateValue('chat.agent.autoFix', true, ConfigurationTarget.USER);
				break;
			case AiCollaborationMode.AgentForward:
				this.configurationService.updateValue('chat.agent.autoFix', true, ConfigurationTarget.USER);
				break;
		}
	}

	private _createKbd(label: string): HTMLElement {
		const kbd = $('kbd.onboarding-a-kbd');
		kbd.textContent = label;
		return kbd;
	}

	private _createInlineLink(parent: HTMLElement, label: string, href: string): HTMLAnchorElement {
		const link = this._registerStepFocusable(append(parent, $<HTMLAnchorElement>('a.onboarding-a-inline-link')));
		link.textContent = label;
		link.href = href;
		link.target = '_blank';
		link.rel = 'noopener';
		return link;
	}

	// =====================================================================
	// Radio-group keyboard navigation (roving tabindex)
	// =====================================================================

	/**
	 * Sets up WAI-ARIA radio-group keyboard navigation on a set of elements:
	 * - Arrow keys move focus between items (with wrap-around)
	 * - Only the focused item has tabindex=0; the rest have tabindex=-1
	 * - Space/Enter on a focused item fires its click handler
	 */
	private _setupRadioGroupNavigation(items: HTMLElement[], selectedIndex: number): void {
		// Initialise roving tabindex: only the selected item is tab-reachable
		for (let i = 0; i < items.length; i++) {
			items[i].setAttribute('tabindex', i === selectedIndex ? '0' : '-1');
		}

		for (let i = 0; i < items.length; i++) {
			this.stepDisposables.add(addDisposableListener(items[i], EventType.KEY_DOWN, (e: KeyboardEvent) => {
				const event = new StandardKeyboardEvent(e);
				let newIndex: number | undefined;

				if (event.keyCode === KeyCode.RightArrow || event.keyCode === KeyCode.DownArrow) {
					newIndex = (i + 1) % items.length;
				} else if (event.keyCode === KeyCode.LeftArrow || event.keyCode === KeyCode.UpArrow) {
					newIndex = (i - 1 + items.length) % items.length;
				} else if (event.keyCode === KeyCode.Home) {
					newIndex = 0;
				} else if (event.keyCode === KeyCode.End) {
					newIndex = items.length - 1;
				}

				if (newIndex !== undefined) {
					e.preventDefault();
					e.stopPropagation();
					items[i].setAttribute('tabindex', '-1');
					items[newIndex].setAttribute('tabindex', '0');
					items[newIndex].focus();
					items[newIndex].click();
				}
			}));
		}
	}

	// =====================================================================
	// Focus trap
	// =====================================================================

	private _trapTab(e: KeyboardEvent, shiftKey: boolean): void {
		if (!this.overlay) {
			return;
		}

		const allFocusable = this._getFocusableElements();

		if (allFocusable.length === 0) {
			e.preventDefault();
			return;
		}

		const first = allFocusable[0];
		const last = allFocusable[allFocusable.length - 1];

		if (shiftKey && getActiveWindow().document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!shiftKey && getActiveWindow().document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	private _getFocusableElements(): HTMLElement[] {
		return [...(this.closeButton ? [this.closeButton] : []), ...this.stepFocusableElements, ...this.footerFocusableElements].filter(element => this._isTabbable(element));
	}

	private _focusCurrentStepElement(): void {
		const stepFocusable = this.stepFocusableElements.find(element => this._isTabbable(element));
		(stepFocusable ?? this.nextButton ?? this.closeButton)?.focus();
	}

	private _registerStepFocusable<T extends HTMLElement>(element: T): T {
		this.stepFocusableElements.push(element);
		return element;
	}

	private _isTabbable(element: HTMLElement): boolean {
		if (!element.isConnected || element.getAttribute('aria-hidden') === 'true' || element.tabIndex === -1 || element.hasAttribute('disabled')) {
			return false;
		}

		const computedStyle = getActiveWindow().getComputedStyle(element);
		return computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden';
	}

	// =====================================================================
	// Telemetry
	// =====================================================================

	private _logStepView(): void {
		const stepId = this.steps[this.currentStepIndex];
		this.telemetryService.publicLog2<OnboardingStepViewEvent, OnboardingStepViewClassification>('welcomeOnboarding.stepView', {
			step: stepId,
			stepNumber: this.currentStepIndex + 1,
		});
	}

	private _logAction(action: string, stepOverride?: OnboardingStepId, argument?: string): void {
		this.telemetryService.publicLog2<OnboardingActionEvent, OnboardingActionClassification>('welcomeOnboarding.actionExecuted', {
			action,
			step: stepOverride ?? this.steps[this.currentStepIndex],
			argument: argument ?? undefined,
		});
	}

	// =====================================================================
	// Cleanup
	// =====================================================================

	private _removeFromDOM(): void {
		if (this.overlay) {
			this.overlay.remove();
			this.overlay = undefined;
		}

		this.card = undefined;
		this.bodyEl = undefined;
		this.progressContainer = undefined;
		this.stepLabelEl = undefined;
		this.titleEl = undefined;
		this.subtitleEl = undefined;
		this.contentEl = undefined;
		this.backButton = undefined;
		this.nextButton = undefined;
		this.closeButton = undefined;
		this.footerLeft = undefined;
		this._footerSignInBtn = undefined;
		this.footerFocusableElements.length = 0;
		this.stepFocusableElements.length = 0;
		this.enterpriseSignInUiState = 'options';
		this.enterpriseInstanceValue = '';
		this.enterpriseSignInWatch = undefined;
		this._isShowing = false;
		this.disposables.clear();
		this.stepDisposables.clear();

		if (this.previouslyFocusedElement) {
			this.previouslyFocusedElement.focus();
			this.previouslyFocusedElement = undefined;
		}

		this.currentStepIndex = 0;
	}

	override dispose(): void {
		this._removeFromDOM();
		super.dispose();
	}
}
