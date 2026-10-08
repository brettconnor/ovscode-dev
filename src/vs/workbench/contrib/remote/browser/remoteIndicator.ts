/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { IRemoteAgentService, remoteConnectionLatencyMeasurer } from '../../../services/remote/common/remoteAgentService.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { MenuId, IMenuService, MenuItemAction, MenuRegistry, registerAction2, Action2, SubmenuItemAction, IMenu } from '../../../../platform/actions/common/actions.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { StatusbarAlignment, IStatusbarService, IStatusbarEntryAccessor, IStatusbarEntry } from '../../../services/statusbar/browser/statusbar.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Schemas } from '../../../../base/common/network.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { QuickPickItem, IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { isWeb } from '../../../../base/common/platform.js';
import { truncate } from '../../../../base/common/strings.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { getRemoteName } from '../../../../platform/remote/common/remoteHosts.js';
import { getVirtualWorkspaceLocation } from '../../../../platform/workspace/common/virtualWorkspace.js';
import { getCodiconAriaLabel } from '../../../../base/common/iconLabels.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ReloadWindowAction } from '../../../browser/actions/windowActions.js';
import { LIST_WORKSPACE_UNSUPPORTED_EXTENSIONS_COMMAND_ID } from '../../extensions/common/extensions.js';
import { IMarkdownString, MarkdownString } from '../../../../base/common/htmlContent.js';
import { RemoteNameContext, VirtualWorkspaceContext } from '../../../common/contextkeys.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../../base/common/actions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DomEmitter } from '../../../../base/browser/event.js';
import { mainWindow } from '../../../../base/browser/window.js';

type ActionGroup = [string, Array<MenuItemAction | SubmenuItemAction>];

export class RemoteStatusIndicator extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.remoteStatusIndicator';

	private static readonly REMOTE_ACTIONS_COMMAND_ID = 'workbench.action.remote.showMenu';
	private static readonly CLOSE_REMOTE_COMMAND_ID = 'workbench.action.remote.close';
	private static readonly SHOW_CLOSE_REMOTE_COMMAND_ID = !isWeb; // web does not have a "Close Remote" command

	private static readonly DEFAULT_REMOTE_STATUS_LABEL = '$(remote)';

	private static readonly REMOTE_STATUS_LABEL_MAX_LENGTH = 40;

	private static readonly REMOTE_CONNECTION_LATENCY_SCHEDULER_DELAY = 60 * 1000;
	private static readonly REMOTE_CONNECTION_LATENCY_SCHEDULER_FIRST_RUN_DELAY = 10 * 1000;

	private remoteStatusEntry: IStatusbarEntryAccessor | undefined;

	private readonly remoteIndicatorMenu: IMenu; 				// filters its entries based on the current remote name of the window
	private readonly unrestrictedRemoteIndicatorMenu: IMenu; 	// does not filter its entries based on the current remote name of the window

	private remoteMenuActionsGroups: ActionGroup[] | undefined;

	private virtualWorkspaceLocation: { scheme: string; authority: string } | undefined = undefined;

	private connectionState: 'initializing' | 'connected' | 'reconnecting' | 'disconnected' | undefined = undefined;
	private connectionToken: string | undefined = undefined;
	private readonly connectionStateContextKey: IContextKey<'' | 'initializing' | 'disconnected' | 'connected'>;

	private networkState: 'online' | 'offline' | 'high-latency' | undefined = undefined;
	private measureNetworkConnectionLatencyScheduler: RunOnceScheduler | undefined = undefined;

	private loggedInvalidGroupNames: { [group: string]: boolean } = Object.create(null);

	private get remoteAuthority(): string | undefined {
		return this.environmentService.remoteAuthority;
	}

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IBrowserWorkbenchEnvironmentService private readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@ILabelService private readonly labelService: ILabelService,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IMenuService private menuService: IMenuService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IRemoteAuthorityResolverService private readonly remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IHostService private readonly hostService: IHostService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();

		this.unrestrictedRemoteIndicatorMenu = this._register(this.menuService.createMenu(MenuId.StatusBarWindowIndicatorMenu, this.contextKeyService)); // to be removed once migration completed
		this.remoteIndicatorMenu = this._register(this.menuService.createMenu(MenuId.StatusBarRemoteIndicatorMenu, this.contextKeyService));

		this.connectionStateContextKey = new RawContextKey<'' | 'initializing' | 'disconnected' | 'connected'>('remoteConnectionState', '').bindTo(this.contextKeyService);

		// Set initial connection state
		if (this.remoteAuthority) {
			this.connectionState = 'initializing';
			this.connectionStateContextKey.set(this.connectionState);
		} else {
			this.updateVirtualWorkspaceLocation();
		}

		this.registerActions();
		this.registerListeners();

		this.updateWhenInstalledExtensionsRegistered();
		this.updateRemoteStatusIndicator();
	}

	private registerActions(): void {
		const category = nls.localize2('remote.category', "Remote");

		// Show Remote Menu
		const that = this;
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: RemoteStatusIndicator.REMOTE_ACTIONS_COMMAND_ID,
					category,
					title: nls.localize2('remote.showMenu', "Show Remote Menu"),
					f1: true,
					keybinding: {
						weight: KeybindingWeight.WorkbenchContrib,
						primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyO,
					}
				});
			}
			run = () => that.showRemoteMenu();
		}));

		// Close Remote Connection
		if (RemoteStatusIndicator.SHOW_CLOSE_REMOTE_COMMAND_ID) {
			this._register(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: RemoteStatusIndicator.CLOSE_REMOTE_COMMAND_ID,
						category,
						title: nls.localize2('remote.close', "Close Remote Connection"),
						f1: true,
						precondition: ContextKeyExpr.or(RemoteNameContext, VirtualWorkspaceContext)
					});
				}
				run = () => that.hostService.openWindow({ forceReuseWindow: true, remoteAuthority: null });
			}));
			if (this.remoteAuthority) {
				MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
					group: '6_close',
					command: {
						id: RemoteStatusIndicator.CLOSE_REMOTE_COMMAND_ID,
						title: nls.localize({ key: 'miCloseRemote', comment: ['&& denotes a mnemonic'] }, "Close Re&&mote Connection")
					},
					order: 3.5
				});
			}
		}

	}

	private registerListeners(): void {

		// Menu changes
		const updateRemoteActions = () => {
			this.remoteMenuActionsGroups = undefined;
			this.updateRemoteStatusIndicator();
		};

		this._register(this.unrestrictedRemoteIndicatorMenu.onDidChange(updateRemoteActions));
		this._register(this.remoteIndicatorMenu.onDidChange(updateRemoteActions));

		// Update indicator when formatter changes as it may have an impact on the remote label
		this._register(this.labelService.onDidChangeFormatters(() => this.updateRemoteStatusIndicator()));

		// Update based on remote indicator changes if any
		const remoteIndicator = this.environmentService.options?.windowIndicator;
		if (remoteIndicator && remoteIndicator.onDidChange) {
			this._register(remoteIndicator.onDidChange(() => this.updateRemoteStatusIndicator()));
		}

		// Listen to changes of the connection
		if (this.remoteAuthority) {
			const connection = this.remoteAgentService.getConnection();
			if (connection) {
				this._register(connection.onDidStateChange((e) => {
					switch (e.type) {
						case PersistentConnectionEventType.ConnectionLost:
						case PersistentConnectionEventType.ReconnectionRunning:
						case PersistentConnectionEventType.ReconnectionWait:
							this.setConnectionState('reconnecting');
							break;
						case PersistentConnectionEventType.ReconnectionPermanentFailure:
							this.setConnectionState('disconnected');
							break;
						case PersistentConnectionEventType.ConnectionGain:
							this.setConnectionState('connected');
							break;
					}
				}));
			}
		} else {
			this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => {
				this.updateVirtualWorkspaceLocation();
				this.updateRemoteStatusIndicator();
			}));
		}

		// Online / Offline changes (web only)
		if (isWeb) {
			this._register(Event.any(
				this._register(new DomEmitter(mainWindow, 'online')).event,
				this._register(new DomEmitter(mainWindow, 'offline')).event
			)(() => this.setNetworkState(navigator.onLine ? 'online' : 'offline')));
		}

	}

	private updateVirtualWorkspaceLocation() {
		this.virtualWorkspaceLocation = getVirtualWorkspaceLocation(this.workspaceContextService.getWorkspace());
	}

	private async updateWhenInstalledExtensionsRegistered(): Promise<void> {
		await this.extensionService.whenInstalledExtensionsRegistered();

		const remoteAuthority = this.remoteAuthority;
		if (remoteAuthority) {

			// Try to resolve the authority to figure out connection state
			(async () => {
				try {
					const { authority } = await this.remoteAuthorityResolverService.resolveAuthority(remoteAuthority);
					this.connectionToken = authority.connectionToken;

					this.setConnectionState('connected');
				} catch (error) {
					this.setConnectionState('disconnected');
				}
			})();
		}

		this.updateRemoteStatusIndicator();
	}

	private setConnectionState(newState: 'disconnected' | 'connected' | 'reconnecting'): void {
		if (this.connectionState !== newState) {
			this.connectionState = newState;

			// simplify context key which doesn't support `connecting`
			if (this.connectionState === 'reconnecting') {
				this.connectionStateContextKey.set('disconnected');
			} else {
				this.connectionStateContextKey.set(this.connectionState);
			}

			// indicate status
			this.updateRemoteStatusIndicator();

			// start measuring connection latency once connected
			if (newState === 'connected') {
				this.scheduleMeasureNetworkConnectionLatency();
			}
		}
	}

	private scheduleMeasureNetworkConnectionLatency(): void {
		if (
			!this.remoteAuthority ||						// only when having a remote connection
			this.measureNetworkConnectionLatencyScheduler	// already scheduled
		) {
			return;
		}

		this.measureNetworkConnectionLatencyScheduler = this._register(new RunOnceScheduler(() => this.measureNetworkConnectionLatency(), RemoteStatusIndicator.REMOTE_CONNECTION_LATENCY_SCHEDULER_DELAY));
		this.measureNetworkConnectionLatencyScheduler.schedule(RemoteStatusIndicator.REMOTE_CONNECTION_LATENCY_SCHEDULER_FIRST_RUN_DELAY);
	}

	private async measureNetworkConnectionLatency(): Promise<void> {

		// Measure latency if we are online
		// but only when the window has focus to prevent constantly
		// waking up the connection to the remote

		if (this.hostService.hasFocus && this.networkState !== 'offline') {
			const measurement = await remoteConnectionLatencyMeasurer.measure(this.remoteAgentService);
			if (measurement) {
				if (measurement.high) {
					this.setNetworkState('high-latency');
				} else if (this.networkState === 'high-latency') {
					this.setNetworkState('online');
				}
			}
		}

		this.measureNetworkConnectionLatencyScheduler?.schedule();
	}

	private setNetworkState(newState: 'online' | 'offline' | 'high-latency'): void {
		if (this.networkState !== newState) {
			const oldState = this.networkState;
			this.networkState = newState;

			if (newState === 'high-latency') {
				this.logService.warn(`Remote network connection appears to have high latency (${remoteConnectionLatencyMeasurer.latency?.current?.toFixed(2)}ms last, ${remoteConnectionLatencyMeasurer.latency?.average?.toFixed(2)}ms average)`);
			}

			if (this.connectionToken) {
				if (newState === 'online' && oldState === 'high-latency') {
					this.logNetworkConnectionHealthTelemetry(this.connectionToken, 'good');
				} else if (newState === 'high-latency' && oldState === 'online') {
					this.logNetworkConnectionHealthTelemetry(this.connectionToken, 'poor');
				}
			}

			// update status
			this.updateRemoteStatusIndicator();
		}
	}

	private logNetworkConnectionHealthTelemetry(connectionToken: string, connectionHealth: 'good' | 'poor'): void {
		type RemoteConnectionHealthClassification = {
			owner: 'alexdima';
			comment: 'The remote connection health has changed (round trip time)';
			remoteName: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The name of the resolver.' };
			reconnectionToken: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The identifier of the connection.' };
			connectionHealth: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The health of the connection: good or poor.' };
		};
		type RemoteConnectionHealthEvent = {
			remoteName: string | undefined;
			reconnectionToken: string;
			connectionHealth: 'good' | 'poor';
		};
		this.telemetryService.publicLog2<RemoteConnectionHealthEvent, RemoteConnectionHealthClassification>('remoteConnectionHealth', {
			remoteName: getRemoteName(this.remoteAuthority),
			reconnectionToken: connectionToken,
			connectionHealth
		});
	}

	private validatedGroup(group: string) {
		if (!group.match(/^(remote|virtualfs)_(\d\d)_(([a-z][a-z0-9+.-]*)_(.*))$/)) {
			if (!this.loggedInvalidGroupNames[group]) {
				this.loggedInvalidGroupNames[group] = true;
				this.logService.warn(`Invalid group name used in "statusBar/remoteIndicator" menu contribution: ${group}. Entries ignored. Expected format: 'remote_$ORDER_$REMOTENAME_$GROUPING or 'virtualfs_$ORDER_$FILESCHEME_$GROUPING.`);
			}
			return false;
		}
		return true;
	}

	private getRemoteMenuActions(doNotUseCache?: boolean): ActionGroup[] {
		if (!this.remoteMenuActionsGroups || doNotUseCache) {
			this.remoteMenuActionsGroups = this.remoteIndicatorMenu.getActions().filter(a => this.validatedGroup(a[0])).concat(this.unrestrictedRemoteIndicatorMenu.getActions());
		}
		return this.remoteMenuActionsGroups;
	}

	private updateRemoteStatusIndicator(): void {

		// Remote Indicator: show if provided via options, e.g. by the web embedder API
		const remoteIndicator = this.environmentService.options?.windowIndicator;
		if (remoteIndicator) {
			let remoteIndicatorLabel = remoteIndicator.label.trim();
			if (!remoteIndicatorLabel.startsWith('$(')) {
				remoteIndicatorLabel = `$(remote) ${remoteIndicatorLabel}`; // ensure the indicator has a codicon
			}

			this.renderRemoteStatusIndicator(truncate(remoteIndicatorLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH), remoteIndicator.tooltip, remoteIndicator.command);
			return;
		}

		// Show for remote windows on the desktop
		if (this.remoteAuthority) {
			const hostLabel = this.labelService.getHostLabel(Schemas.vscodeRemote, this.remoteAuthority) || this.remoteAuthority;
			switch (this.connectionState) {
				case 'initializing':
					this.renderRemoteStatusIndicator(nls.localize('host.open', "Opening Remote..."), nls.localize('host.open', "Opening Remote..."), undefined, true /* progress */);
					break;
				case 'reconnecting':
					this.renderRemoteStatusIndicator(`${nls.localize('host.reconnecting', "Reconnecting to {0}...", truncate(hostLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH))}`, undefined, undefined, true /* progress */);
					break;
				case 'disconnected':
					this.renderRemoteStatusIndicator(`$(alert) ${nls.localize('disconnectedFrom', "Disconnected from {0}", truncate(hostLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH))}`);
					break;
				default: {
					const tooltip = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
					const hostNameTooltip = this.labelService.getHostTooltip(Schemas.vscodeRemote, this.remoteAuthority);
					if (hostNameTooltip) {
						tooltip.appendMarkdown(hostNameTooltip);
					} else {
						tooltip.appendText(nls.localize({ key: 'host.tooltip', comment: ['{0} is a remote host name, e.g. Dev Container'] }, "Editing on {0}", hostLabel));
					}
					this.renderRemoteStatusIndicator(`$(remote) ${truncate(hostLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH)}`, tooltip);
				}
			}
			return;
		}
		// Show when in a virtual workspace
		if (this.virtualWorkspaceLocation) {

			// Workspace with label: indicate editing source
			const workspaceLabel = this.labelService.getHostLabel(this.virtualWorkspaceLocation.scheme, this.virtualWorkspaceLocation.authority);
			if (workspaceLabel) {
				const tooltip = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
				const hostNameTooltip = this.labelService.getHostTooltip(this.virtualWorkspaceLocation.scheme, this.virtualWorkspaceLocation.authority);
				if (hostNameTooltip) {
					tooltip.appendMarkdown(hostNameTooltip);
				} else {
					tooltip.appendText(nls.localize({ key: 'workspace.tooltip', comment: ['{0} is a remote workspace name, e.g. GitHub'] }, "Editing on {0}", workspaceLabel));
				}
				if (!isWeb || this.remoteAuthority) {
					tooltip.appendMarkdown('\n\n');
					tooltip.appendMarkdown(nls.localize(
						{ key: 'workspace.tooltip2', comment: ['[features are not available]({1}) is a link. Only translate `features are not available`. Do not change brackets and parentheses or {0}'] },
						"Some [features are not available]({0}) for resources located on a virtual file system.",
						`command:${LIST_WORKSPACE_UNSUPPORTED_EXTENSIONS_COMMAND_ID}`
					));
				}
				this.renderRemoteStatusIndicator(`$(remote) ${truncate(workspaceLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH)}`, tooltip);
				return;
			}
		}

		this.renderRemoteStatusIndicator(RemoteStatusIndicator.DEFAULT_REMOTE_STATUS_LABEL, nls.localize('noHost.tooltip', "Open a Remote Window"));
		return;
	}

	private renderRemoteStatusIndicator(initialText: string, initialTooltip?: string | MarkdownString, command?: string, showProgress?: boolean): void {
		const { text, tooltip, ariaLabel } = this.withNetworkStatus(initialText, initialTooltip, showProgress);

		const properties: IStatusbarEntry = {
			name: nls.localize('remoteHost', "Remote Host"),
			kind: this.networkState === 'offline' ? 'offline' : text !== RemoteStatusIndicator.DEFAULT_REMOTE_STATUS_LABEL ? 'remote' : undefined, // only emphasize when applicable
			ariaLabel,
			text,
			showProgress,
			tooltip,
			command: command ?? RemoteStatusIndicator.REMOTE_ACTIONS_COMMAND_ID
		};

		if (this.remoteStatusEntry) {
			this.remoteStatusEntry.update(properties);
		} else {
			this.remoteStatusEntry = this.statusbarService.addEntry(properties, 'status.host', StatusbarAlignment.LEFT, Number.POSITIVE_INFINITY /* first entry */);
		}
	}

	private withNetworkStatus(initialText: string, initialTooltip?: string | MarkdownString, showProgress?: boolean): { text: string; tooltip: string | IMarkdownString | undefined; ariaLabel: string } {
		let text = initialText;
		let tooltip = initialTooltip;
		let ariaLabel = getCodiconAriaLabel(text);

		function textWithAlert(): string {

			// `initialText` can have a codicon in the beginning that already
			// indicates some kind of status, or we may have been asked to
			// show progress, where a spinning codicon appears. we only want
			// to replace with an alert icon for when a normal remote indicator
			// is shown.

			if (!showProgress && initialText.startsWith(RemoteStatusIndicator.DEFAULT_REMOTE_STATUS_LABEL)) {
				return initialText.replace(RemoteStatusIndicator.DEFAULT_REMOTE_STATUS_LABEL, '$(alert)');
			}

			return initialText;
		}

		switch (this.networkState) {
			case 'offline': {
				const offlineMessage = nls.localize('networkStatusOfflineTooltip', "Network appears to be offline, certain features might be unavailable.");

				text = textWithAlert();
				tooltip = this.appendTooltipLine(tooltip, offlineMessage);
				ariaLabel = `${ariaLabel}, ${offlineMessage}`;
				break;
			}
			case 'high-latency':
				text = textWithAlert();
				tooltip = this.appendTooltipLine(tooltip, nls.localize('networkStatusHighLatencyTooltip', "Network appears to have high latency ({0}ms last, {1}ms average), certain features may be slow to respond.", remoteConnectionLatencyMeasurer.latency?.current?.toFixed(2), remoteConnectionLatencyMeasurer.latency?.average?.toFixed(2)));
				break;
		}

		return { text, tooltip, ariaLabel };
	}

	private appendTooltipLine(tooltip: string | MarkdownString | undefined, line: string): MarkdownString {
		let markdownTooltip: MarkdownString;
		if (typeof tooltip === 'string') {
			markdownTooltip = new MarkdownString(tooltip, { isTrusted: true, supportThemeIcons: true });
		} else {
			markdownTooltip = tooltip ?? new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		}

		if (markdownTooltip.value.length > 0) {
			markdownTooltip.appendMarkdown('\n\n');
		}

		markdownTooltip.appendMarkdown(line);

		return markdownTooltip;
	}

	private showRemoteMenu() {
		const getCategoryLabel = (action: MenuItemAction) => {
			if (action.item.category) {
				return typeof action.item.category === 'string' ? action.item.category : action.item.category.value;
			}
			return undefined;
		};

		const matchCurrentRemote = () => {
			if (this.remoteAuthority) {
				return new RegExp(`^remote_\\d\\d_${getRemoteName(this.remoteAuthority)}_`);
			} else if (this.virtualWorkspaceLocation) {
				return new RegExp(`^virtualfs_\\d\\d_${this.virtualWorkspaceLocation.scheme}_`);
			}
			return undefined;
		};

		const computeItems = () => {
			let actionGroups = this.getRemoteMenuActions(true);

			const items: QuickPickItem[] = [];

			const currentRemoteMatcher = matchCurrentRemote();
			if (currentRemoteMatcher) {
				// commands for the current remote go first
				actionGroups = actionGroups.sort((g1, g2) => {
					const isCurrentRemote1 = currentRemoteMatcher.test(g1[0]);
					const isCurrentRemote2 = currentRemoteMatcher.test(g2[0]);
					if (isCurrentRemote1 !== isCurrentRemote2) {
						return isCurrentRemote1 ? -1 : 1;
					}
					// legacy indicator commands go last
					if (g1[0] !== '' && g2[0] === '') {
						return -1;
					} else if (g1[0] === '' && g2[0] !== '') {
						return 1;
					}
					return g1[0].localeCompare(g2[0]);
				});
			}

			let lastCategoryName: string | undefined = undefined;

			for (const actionGroup of actionGroups) {
				let hasGroupCategory = false;
				for (const action of actionGroup[1]) {
					if (action instanceof MenuItemAction) {
						if (!hasGroupCategory) {
							const category = getCategoryLabel(action);
							if (category !== lastCategoryName) {
								items.push({ type: 'separator', label: category });
								lastCategoryName = category;
							}
							hasGroupCategory = true;
						}
						const label = typeof action.item.title === 'string' ? action.item.title : action.item.title.value;
						items.push({
							type: 'item',
							id: action.item.id,
							label
						});
					}
				}
			}

			items.push({
				type: 'separator'
			});

			const entriesBeforeConfig = items.length;

			if (RemoteStatusIndicator.SHOW_CLOSE_REMOTE_COMMAND_ID) {
				if (this.remoteAuthority) {
					items.push({
						type: 'item',
						id: RemoteStatusIndicator.CLOSE_REMOTE_COMMAND_ID,
						label: nls.localize('closeRemoteConnection.title', 'Close Remote Connection')
					});

					if (this.connectionState === 'disconnected') {
						items.push({
							type: 'item',
							id: ReloadWindowAction.ID,
							label: nls.localize('reloadWindow', 'Reload Window')
						});
					}
				} else if (this.virtualWorkspaceLocation) {
					items.push({
						type: 'item',
						id: RemoteStatusIndicator.CLOSE_REMOTE_COMMAND_ID,
						label: nls.localize('closeVirtualWorkspace.title', 'Close Remote Workspace')
					});
				}
			}

			if (items.length === entriesBeforeConfig) {
				items.pop(); // remove the separator again
			}

			return items;
		};

		const disposables = new DisposableStore();
		const quickPick = disposables.add(this.quickInputService.createQuickPick({ useSeparators: true }));
		quickPick.placeholder = nls.localize('remoteActions', "Select an option to open a Remote Window");
		quickPick.items = computeItems();
		quickPick.sortByLabel = false;
		quickPick.canSelectMany = false;
		disposables.add(Event.once(quickPick.onDidAccept)((async _ => {
			const selectedItems = quickPick.selectedItems;
			if (selectedItems.length === 1) {
				const commandId = selectedItems[0].id!;
				this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', {
					id: commandId,
					from: 'remote indicator'
				});
				this.commandService.executeCommand(commandId);
				quickPick.hide();
			}
		})));

		// refresh the items when actions change
		disposables.add(this.unrestrictedRemoteIndicatorMenu.onDidChange(() => quickPick.items = computeItems()));
		disposables.add(this.remoteIndicatorMenu.onDidChange(() => quickPick.items = computeItems()));

		disposables.add(quickPick.onDidHide(() => disposables.dispose()));

		quickPick.show();
	}
}
