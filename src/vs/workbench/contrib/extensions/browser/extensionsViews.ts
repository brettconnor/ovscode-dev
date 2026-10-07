/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { isCancellationError, getErrorMessage } from '../../../../base/common/errors.js';
import { PagedModel, IPagedModel, DelayedPagedModel } from '../../../../base/common/paging.js';
import { SortOrder, ExtensionGalleryErrorCode, ExtensionGalleryError } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IExtensionManagementServer, IExtensionManagementServerService, EnablementState, IWorkbenchExtensionManagementService, IWorkbenchExtensionEnablementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { areSameExtensions, getExtensionDependencies } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { append, $ } from '../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ExtensionResultsListFocused, ExtensionState, IExtension, IExtensionsViewState, IExtensionsWorkbenchService } from '../common/extensions.js';
import { Query } from '../common/extensionQuery.js';
import { IExtensionService, toExtension } from '../../../services/extensions/common/extensions.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { WorkbenchPagedList } from '../../../../platform/list/browser/listService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ViewPane, IViewPaneOptions, ViewPaneShowActions } from '../../../browser/parts/views/viewPane.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { coalesce } from '../../../../base/common/arrays.js';
import { alert } from '../../../../base/browser/ui/aria/aria.js';
import { ActionRunner } from '../../../../base/common/actions.js';
import { ExtensionIdentifier, ExtensionIdentifierMap, ExtensionUntrustedWorkspaceSupportType, ExtensionVirtualWorkspaceSupportType, IExtensionDescription, isLanguagePackExtension } from '../../../../platform/extensions/common/extensions.js';
import { CancelablePromise, createCancelablePromise } from '../../../../base/common/async.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { SeverityIcon } from '../../../../base/browser/ui/severityIcon/severityIcon.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IExtensionManifestPropertiesService } from '../../../services/extensions/common/extensionManifestPropertiesService.js';
import { isVirtualWorkspace } from '../../../../platform/workspace/common/virtualWorkspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defaultCountBadgeStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { isOfflineError } from '../../../../base/parts/request/common/request.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, IExtensionFeatureRenderer, IExtensionFeaturesManagementService, IExtensionFeaturesRegistry } from '../../../services/extensionManagement/common/extensionFeatures.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ExtensionsList } from './extensionsViewer.js';

export const NONE_CATEGORY = 'none';

type Message = {
	readonly text: string;
	readonly severity: Severity;
};

class ExtensionsViewState extends Disposable implements IExtensionsViewState {

	private readonly _onFocus: Emitter<IExtension> = this._register(new Emitter<IExtension>());
	readonly onFocus: Event<IExtension> = this._onFocus.event;

	private readonly _onBlur: Emitter<IExtension> = this._register(new Emitter<IExtension>());
	readonly onBlur: Event<IExtension> = this._onBlur.event;

	private currentlyFocusedItems: IExtension[] = [];

	filters: {
		featureId?: string;
	} = {};

	onFocusChange(extensions: IExtension[]): void {
		this.currentlyFocusedItems.forEach(extension => this._onBlur.fire(extension));
		this.currentlyFocusedItems = extensions;
		this.currentlyFocusedItems.forEach(extension => this._onFocus.fire(extension));
	}
}

export interface ExtensionsListViewOptions {
	server?: IExtensionManagementServer;
	flexibleHeight?: boolean;
	readonly onDidChangeTitle?: Event<string>;
	hideBadge?: boolean;
}

interface IQueryResult {
	model: IPagedModel<IExtension>;
	message?: { text: string; severity: Severity };
	readonly onDidChangeModel?: Event<IPagedModel<IExtension>>;
	readonly disposables: DisposableStore;
}

const enum LocalSortBy {
	Name = 'Name',
	UpdateDate = 'UpdateDate',
}

type IQueryOptions = { sortBy?: LocalSortBy; sortOrder?: SortOrder };

export abstract class AbstractExtensionsListView<T> extends ViewPane {
	abstract show(query: string, refresh?: boolean): Promise<IPagedModel<T>>;
}

export class ExtensionsListView extends AbstractExtensionsListView<IExtension> {

	private static RECENT_UPDATE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

	private bodyTemplate: {
		messageContainer: HTMLElement;
		messageSeverityIcon: HTMLElement;
		messageBox: HTMLElement;
		extensionsList: HTMLElement;
	} | undefined;
	private badge: CountBadge | undefined;
	private list: WorkbenchPagedList<IExtension> | null = null;
	private queryRequest: { query: string; request: CancelablePromise<IPagedModel<IExtension>> } | null = null;
	private queryResult: IQueryResult | undefined;
	private extensionsViewState: ExtensionsViewState | undefined;

	private readonly contextMenuActionRunner = this._register(new ActionRunner());

	constructor(
		protected readonly options: ExtensionsListViewOptions,
		viewletViewOptions: IViewletViewOptions,
		@INotificationService protected notificationService: INotificationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IExtensionsWorkbenchService protected extensionsWorkbenchService: IExtensionsWorkbenchService,
		@ITelemetryService protected readonly telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService protected contextService: IWorkspaceContextService,
		@IExtensionManagementServerService protected readonly extensionManagementServerService: IExtensionManagementServerService,
		@IExtensionManifestPropertiesService private readonly extensionManifestPropertiesService: IExtensionManifestPropertiesService,
		@IWorkbenchExtensionManagementService protected readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IWorkspaceContextService protected readonly workspaceService: IWorkspaceContextService,
		@IProductService protected readonly productService: IProductService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IOpenerService openerService: IOpenerService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService,
		@IExtensionFeaturesManagementService private readonly extensionFeaturesManagementService: IExtensionFeaturesManagementService,
		@IUriIdentityService protected readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService
	) {
		super({
			...(viewletViewOptions as IViewPaneOptions),
			showActions: ViewPaneShowActions.Always,
			maximumBodySize: options.flexibleHeight ? (storageService.getNumber(`${viewletViewOptions.id}.size`, StorageScope.PROFILE, 0) ? undefined : 0) : undefined
		}, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		if (this.options.onDidChangeTitle) {
			this._register(this.options.onDidChangeTitle(title => this.updateTitle(title)));
		}

		this._register(this.contextMenuActionRunner.onDidRun(({ error }) => error && this.notificationService.error(error)));
		this.registerActions();
	}

	protected registerActions(): void { }

	protected override renderHeader(container: HTMLElement): void {
		container.classList.add('extension-view-header');
		super.renderHeader(container);

		if (!this.options.hideBadge) {
			this.badge = this._register(new CountBadge(append(container, $('.count-badge-wrapper')), {}, defaultCountBadgeStyles));
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const messageContainer = append(container, $('.message-container'));
		const messageSeverityIcon = append(messageContainer, $(''));
		const messageBox = append(messageContainer, $('.message'));
		const extensionsList = append(container, $('.extensions-list'));
		this.extensionsViewState = this._register(new ExtensionsViewState());
		this.list = this._register(this.instantiationService.createInstance(ExtensionsList, extensionsList, this.id, {}, this.extensionsViewState)).list;
		ExtensionResultsListFocused.bindTo(this.list.contextKeyService);
		this._register(this.list.onDidChangeFocus(e => this.extensionsViewState?.onFocusChange(coalesce(e.elements)), this));

		this.bodyTemplate = {
			extensionsList,
			messageBox,
			messageContainer,
			messageSeverityIcon
		};

		if (this.queryResult) {
			this.setModel(this.queryResult.model);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.bodyTemplate) {
			this.bodyTemplate.extensionsList.style.height = height + 'px';
		}
		this.list?.layout(height, width);
	}

	async show(query: string, refresh?: boolean): Promise<IPagedModel<IExtension>> {
		if (this.queryRequest) {
			if (!refresh && this.queryRequest.query === query) {
				return this.queryRequest.request;
			}
			this.queryRequest.request.cancel();
			this.queryRequest = null;
		}

		if (this.queryResult) {
			this.queryResult.disposables.dispose();
			this.queryResult = undefined;
			if (this.extensionsViewState) {
				this.extensionsViewState.filters = {};
			}
		}

		const parsedQuery = Query.parse(query);

		const options: IQueryOptions = {
			sortOrder: SortOrder.Default
		};

		switch (parsedQuery.sortBy) {
			case 'name': options.sortBy = LocalSortBy.Name; break;
			case 'updateDate': options.sortBy = LocalSortBy.UpdateDate; break;
		}

		const request = createCancelablePromise(async () => {
			try {
				this.queryResult = await this.query(parsedQuery, options);
				const model = this.queryResult.model;
				this.setModel(model, this.queryResult.message);
				if (this.queryResult.onDidChangeModel) {
					this.queryResult.disposables.add(this.queryResult.onDidChangeModel(model => {
						if (this.queryResult) {
							this.queryResult.model = model;
							this.updateModel(model);
						}
					}));
				}
				return model;
			} catch (e) {
				const model = new PagedModel([]);
				if (!isCancellationError(e)) {
					this.logService.error(e);
					this.setModel(model, this.getMessage(e));
				}
				return this.list ? this.list.model : model;
			}
		});

		request.finally(() => this.queryRequest = null);
		this.queryRequest = { query, request };
		return request;
	}

	count(): number {
		return this.queryResult?.model.length ?? 0;
	}

	protected showEmptyModel(): Promise<IPagedModel<IExtension>> {
		const emptyModel = new PagedModel([]);
		this.setModel(emptyModel);
		return Promise.resolve(emptyModel);
	}

	private async query(query: Query, options: IQueryOptions): Promise<IQueryResult> {
		const idRegex = /@id:(([a-z0-9A-Z][a-z0-9\-A-Z]*)\.([a-z0-9A-Z][a-z0-9\-A-Z]*))/g;
		const ids: string[] = [];
		let idMatch;
		while ((idMatch = idRegex.exec(query.value)) !== null) {
			const name = idMatch[1];
			ids.push(name);
		}
		if (ids.length) {
			const model = await this.queryByIds(ids);
			return { model, disposables: new DisposableStore() };
		}

		return this.queryLocal(query, options);
	}

	private async queryByIds(ids: string[]): Promise<IPagedModel<IExtension>> {
		const idsSet: Set<string> = ids.reduce((result, id) => { result.add(id.toLowerCase()); return result; }, new Set<string>());
		const result = (await this.extensionsWorkbenchService.queryLocal(this.options.server))
			.filter(e => idsSet.has(e.identifier.id.toLowerCase()));
		return new PagedModel(result);
	}

	private async queryLocal(query: Query, options: IQueryOptions): Promise<IQueryResult> {
		const local = await this.extensionsWorkbenchService.queryLocal(this.options.server);
		let { extensions, canIncludeInstalledExtensions, description } = await this.filterLocal(local, this.extensionService.extensions, query, options);
		const disposables = new DisposableStore();
		const onDidChangeModel = disposables.add(new Emitter<IPagedModel<IExtension>>());

		if (canIncludeInstalledExtensions) {
			let isDisposed: boolean = false;
			disposables.add(toDisposable(() => isDisposed = true));
			disposables.add(Event.debounce(Event.any(
				Event.filter(this.extensionsWorkbenchService.onChange, e => e?.state === ExtensionState.Installed),
				this.extensionService.onDidChangeExtensions
			), () => undefined)(async () => {
				const local = this.options.server ? this.extensionsWorkbenchService.installed.filter(e => e.server === this.options.server) : this.extensionsWorkbenchService.local;
				const { extensions: newExtensions } = await this.filterLocal(local, this.extensionService.extensions, query, options);
				if (!isDisposed) {
					const mergedExtensions = this.mergeAddedExtensions(extensions, newExtensions);
					if (mergedExtensions) {
						extensions = mergedExtensions;
						onDidChangeModel.fire(new PagedModel(extensions));
					}
				}
			}));
		}

		return {
			model: new PagedModel(extensions),
			message: description ? { text: description, severity: Severity.Info } : undefined,
			onDidChangeModel: onDidChangeModel.event,
			disposables
		};
	}

	private async filterLocal(local: IExtension[], runningExtensions: readonly IExtensionDescription[], query: Query, options: IQueryOptions): Promise<{ extensions: IExtension[]; canIncludeInstalledExtensions: boolean; description?: string }> {
		const value = query.value;
		let extensions: IExtension[] = [];
		let description: string | undefined;
		const includeBuiltin = /@builtin/i.test(value);
		const canIncludeInstalledExtensions = !includeBuiltin;

		if (/@installed/i.test(value)) {
			extensions = this.filterInstalledExtensions(local, runningExtensions, query, options);
		}

		else if (/@disabled/i.test(value)) {
			extensions = this.filterDisabledExtensions(local, runningExtensions, query, options, includeBuiltin);
		}

		else if (/@enabled/i.test(value)) {
			extensions = this.filterEnabledExtensions(local, runningExtensions, query, options, includeBuiltin);
		}

		else if (/@workspaceUnsupported/i.test(value)) {
			extensions = this.filterWorkspaceUnsupportedExtensions(local, query, options);
		}

		else if (/@deprecated/i.test(query.value)) {
			extensions = await this.filterDeprecatedExtensions(local, query, options);
		}

		else if (/@recentlyUpdated/i.test(query.value)) {
			extensions = this.filterRecentlyUpdatedExtensions(local, query, options);
		}

		else if (/@restartrequired/i.test(query.value)) {
			extensions = this.filterRestartRequiredExtensions(local, query, options);
		}

		else if (/@contribute:/i.test(query.value)) {
			extensions = this.filterExtensionsByFeature(local, query);
		}

		else if (includeBuiltin) {
			extensions = this.filterBuiltinExtensions(local, query, options);
		} else {
			extensions = this.filterInstalledExtensions(local, runningExtensions, query, options);
		}

		return { extensions, canIncludeInstalledExtensions, description };
	}

	private filterBuiltinExtensions(local: IExtension[], query: Query, options: IQueryOptions): IExtension[] {
		let { value, includedCategories, excludedCategories } = this.parseCategories(query.value);
		value = value.replaceAll(/@builtin/gi, '').replaceAll(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();

		const result = local
			.filter(e => e.isBuiltin && (e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1)
				&& this.filterExtensionByCategory(e, includedCategories, excludedCategories));

		return this.sortExtensions(result, options);
	}

	private filterExtensionByCategory(e: IExtension, includedCategories: string[], excludedCategories: string[]): boolean {
		if (!includedCategories.length && !excludedCategories.length) {
			return true;
		}
		if (e.categories.length) {
			if (excludedCategories.length && e.categories.some(category => excludedCategories.includes(category.toLowerCase()))) {
				return false;
			}
			return e.categories.some(category => includedCategories.includes(category.toLowerCase()));
		} else {
			return includedCategories.includes(NONE_CATEGORY);
		}
	}

	private parseCategories(value: string): { value: string; includedCategories: string[]; excludedCategories: string[] } {
		const includedCategories: string[] = [];
		const excludedCategories: string[] = [];
		value = value.replace(/\bcategory:("([^"]*)"|([^"]\S*))(\s+|\b|$)/g, (_, quotedCategory, category) => {
			const entry = (category || quotedCategory || '').toLowerCase();
			if (entry.startsWith('-')) {
				if (excludedCategories.indexOf(entry) === -1) {
					excludedCategories.push(entry);
				}
			} else {
				if (includedCategories.indexOf(entry) === -1) {
					includedCategories.push(entry);
				}
			}
			return '';
		});
		return { value, includedCategories, excludedCategories };
	}

	private filterInstalledExtensions(local: IExtension[], runningExtensions: readonly IExtensionDescription[], query: Query, options: IQueryOptions): IExtension[] {
		let { value, includedCategories, excludedCategories } = this.parseCategories(query.value);

		value = value.replace(/@installed/g, '').replace(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();

		const matchingText = (e: IExtension) => (e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1 || e.description.toLowerCase().indexOf(value) > -1)
			&& this.filterExtensionByCategory(e, includedCategories, excludedCategories);
		let result;

		if (options.sortBy !== undefined) {
			result = local.filter(e => !e.isBuiltin && matchingText(e));
			result = this.sortExtensions(result, options);
		} else {
			result = local.filter(e => (!e.isBuiltin || e.outdated || e.runtimeState !== undefined) && matchingText(e));
			const runningExtensionsById = runningExtensions.reduce((result, e) => { result.set(e.identifier.value, e); return result; }, new ExtensionIdentifierMap<IExtensionDescription>());

			const defaultSort = (e1: IExtension, e2: IExtension) => {
				const running1 = runningExtensionsById.get(e1.identifier.id);
				const isE1Running = !!running1 && this.extensionManagementServerService.getExtensionManagementServer(toExtension(running1)) === e1.server;
				const running2 = runningExtensionsById.get(e2.identifier.id);
				const isE2Running = running2 && this.extensionManagementServerService.getExtensionManagementServer(toExtension(running2)) === e2.server;
				if ((isE1Running && isE2Running)) {
					return e1.displayName.localeCompare(e2.displayName);
				}
				const isE1LanguagePackExtension = e1.local && isLanguagePackExtension(e1.local.manifest);
				const isE2LanguagePackExtension = e2.local && isLanguagePackExtension(e2.local.manifest);
				if (!isE1Running && !isE2Running) {
					if (isE1LanguagePackExtension) {
						return -1;
					}
					if (isE2LanguagePackExtension) {
						return 1;
					}
					return e1.displayName.localeCompare(e2.displayName);
				}
				if ((isE1Running && isE2LanguagePackExtension) || (isE2Running && isE1LanguagePackExtension)) {
					return e1.displayName.localeCompare(e2.displayName);
				}
				return isE1Running ? -1 : 1;
			};

			const incompatible: IExtension[] = [];
			const deprecated: IExtension[] = [];
			const outdated: IExtension[] = [];
			const actionRequired: IExtension[] = [];
			const noActionRequired: IExtension[] = [];

			for (const e of result) {
				if (e.enablementState === EnablementState.DisabledByInvalidExtension) {
					incompatible.push(e);
				}
				else if (e.deprecationInfo) {
					deprecated.push(e);
				}
				else if (e.outdated && this.extensionEnablementService.isEnabledEnablementState(e.enablementState)) {
					outdated.push(e);
				}
				else if (e.runtimeState) {
					actionRequired.push(e);
				}
				else {
					noActionRequired.push(e);
				}
			}

			result = [
				...incompatible.sort(defaultSort),
				...deprecated.sort(defaultSort),
				...outdated.sort(defaultSort),
				...actionRequired.sort(defaultSort),
				...noActionRequired.sort(defaultSort)
			];
		}
		return result;
	}

	private filterDisabledExtensions(local: IExtension[], runningExtensions: readonly IExtensionDescription[], query: Query, options: IQueryOptions, includeBuiltin: boolean): IExtension[] {
		let { value, includedCategories, excludedCategories } = this.parseCategories(query.value);

		value = value.replaceAll(/@disabled|@builtin/gi, '').replaceAll(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();

		if (includeBuiltin) {
			local = local.filter(e => e.isBuiltin);
		}
		const result = local
			.sort((e1, e2) => e1.displayName.localeCompare(e2.displayName))
			.filter(e => runningExtensions.every(r => !areSameExtensions({ id: r.identifier.value, uuid: r.uuid }, e.identifier))
				&& (e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1)
				&& this.filterExtensionByCategory(e, includedCategories, excludedCategories));

		return this.sortExtensions(result, options);
	}

	private filterEnabledExtensions(local: IExtension[], runningExtensions: readonly IExtensionDescription[], query: Query, options: IQueryOptions, includeBuiltin: boolean): IExtension[] {
		let { value, includedCategories, excludedCategories } = this.parseCategories(query.value);

		value = value ? value.replaceAll(/@enabled|@builtin/gi, '').replaceAll(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase() : '';

		local = local.filter(e => e.isBuiltin === includeBuiltin);
		const result = local
			.sort((e1, e2) => e1.displayName.localeCompare(e2.displayName))
			.filter(e => runningExtensions.some(r => areSameExtensions({ id: r.identifier.value, uuid: r.uuid }, e.identifier))
				&& (e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1)
				&& this.filterExtensionByCategory(e, includedCategories, excludedCategories));

		return this.sortExtensions(result, options);
	}

	private filterWorkspaceUnsupportedExtensions(local: IExtension[], query: Query, options: IQueryOptions): IExtension[] {
		// shows local extensions which are restricted or disabled in the current workspace because of the extension's capability

		const queryString = query.value; // @sortby is already filtered out

		const match = queryString.match(/^\s*@workspaceUnsupported(?::(untrusted|virtual)(Partial)?)?(?:\s+([^\s]*))?/i);
		if (!match) {
			return [];
		}
		const type = match[1]?.toLowerCase();
		const partial = !!match[2];
		const nameFilter = match[3]?.toLowerCase();

		if (nameFilter) {
			local = local.filter(extension => extension.name.toLowerCase().indexOf(nameFilter) > -1 || extension.displayName.toLowerCase().indexOf(nameFilter) > -1);
		}

		const hasVirtualSupportType = (extension: IExtension, supportType: ExtensionVirtualWorkspaceSupportType) => {
			return extension.local && this.extensionManifestPropertiesService.getExtensionVirtualWorkspaceSupportType(extension.local.manifest) === supportType;
		};

		const hasRestrictedSupportType = (extension: IExtension, supportType: ExtensionUntrustedWorkspaceSupportType) => {
			if (!extension.local) {
				return false;
			}

			const enablementState = this.extensionEnablementService.getEnablementState(extension.local);
			if (enablementState !== EnablementState.EnabledGlobally && enablementState !== EnablementState.EnabledWorkspace &&
				enablementState !== EnablementState.DisabledByTrustRequirement && enablementState !== EnablementState.DisabledByExtensionDependency) {
				return false;
			}

			if (this.extensionManifestPropertiesService.getExtensionUntrustedWorkspaceSupportType(extension.local.manifest) === supportType) {
				return true;
			}

			if (supportType === false) {
				const dependencies = getExtensionDependencies(local.map(ext => ext.local!), extension.local);
				return dependencies.some(ext => this.extensionManifestPropertiesService.getExtensionUntrustedWorkspaceSupportType(ext.manifest) === supportType);
			}

			return false;
		};

		const inVirtualWorkspace = isVirtualWorkspace(this.workspaceService.getWorkspace());
		const inRestrictedWorkspace = !this.workspaceTrustManagementService.isWorkspaceTrusted();

		if (type === 'virtual') {
			// show limited and disabled extensions unless disabled because of a untrusted workspace
			local = local.filter(extension => inVirtualWorkspace && hasVirtualSupportType(extension, partial ? 'limited' : false) && !(inRestrictedWorkspace && hasRestrictedSupportType(extension, false)));
		} else if (type === 'untrusted') {
			// show limited and disabled extensions unless disabled because of a virtual workspace
			local = local.filter(extension => hasRestrictedSupportType(extension, partial ? 'limited' : false) && !(inVirtualWorkspace && hasVirtualSupportType(extension, false)));
		} else {
			// show extensions that are restricted or disabled in the current workspace
			local = local.filter(extension => inVirtualWorkspace && !hasVirtualSupportType(extension, true) || inRestrictedWorkspace && !hasRestrictedSupportType(extension, true));
		}
		return this.sortExtensions(local, options);
	}

	private async filterDeprecatedExtensions(local: IExtension[], query: Query, options: IQueryOptions): Promise<IExtension[]> {
		const value = query.value.replace(/@deprecated/g, '').replace(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();
		const extensionsControlManifest = await this.extensionManagementService.getExtensionsControlManifest();
		const deprecatedExtensionIds = Object.keys(extensionsControlManifest.deprecated);
		local = local.filter(e => deprecatedExtensionIds.includes(e.identifier.id) && (!value || e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1));
		return this.sortExtensions(local, options);
	}

	private filterRecentlyUpdatedExtensions(local: IExtension[], query: Query, options: IQueryOptions): IExtension[] {
		let { value, includedCategories, excludedCategories } = this.parseCategories(query.value);
		const currentTime = Date.now();
		local = local.filter(e => !e.isBuiltin && !e.outdated && e.local?.updated && e.local?.installedTimestamp !== undefined && currentTime - e.local.installedTimestamp < ExtensionsListView.RECENT_UPDATE_DURATION);

		value = value.replace(/@recentlyUpdated/g, '').replace(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();

		const result = local.filter(e =>
			(e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1)
			&& this.filterExtensionByCategory(e, includedCategories, excludedCategories));

		options.sortBy = options.sortBy ?? LocalSortBy.UpdateDate;

		return this.sortExtensions(result, options);
	}

	private filterRestartRequiredExtensions(local: IExtension[], query: Query, options: IQueryOptions): IExtension[] {
		let { value, includedCategories, excludedCategories } = this.parseCategories(query.value);
		local = local.filter(e => e.runtimeState !== undefined);

		value = value.replace(/@restartrequired/gi, '').replace(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();

		const result = local.filter(e =>
			(e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1)
			&& this.filterExtensionByCategory(e, includedCategories, excludedCategories));

		return this.sortExtensions(result, options);
	}

	private filterExtensionsByFeature(local: IExtension[], query: Query): IExtension[] {
		const value = query.value.replace(/@contribute:/g, '').trim();
		const featureId = value.split(' ')[0];
		const feature = Registry.as<IExtensionFeaturesRegistry>(Extensions.ExtensionFeaturesRegistry).getExtensionFeature(featureId);
		if (!feature) {
			return [];
		}
		if (this.extensionsViewState) {
			this.extensionsViewState.filters.featureId = featureId;
		}
		const renderer = feature.renderer ? this.instantiationService.createInstance<IExtensionFeatureRenderer>(feature.renderer) : undefined;
		try {
			const result: [IExtension, number][] = [];
			for (const e of local) {
				if (!e.local) {
					continue;
				}
				const accessData = this.extensionFeaturesManagementService.getAccessData(new ExtensionIdentifier(e.identifier.id), featureId);
				const shouldRender = renderer?.shouldRender(e.local.manifest);
				if (accessData || shouldRender) {
					result.push([e, accessData?.accessTimes.length ?? 0]);
				}
			}
			return result.sort(([, a], [, b]) => b - a).map(([e]) => e);
		} finally {
			renderer?.dispose();
		}
	}

	private mergeAddedExtensions(extensions: IExtension[], newExtensions: IExtension[]): IExtension[] | undefined {
		const oldExtensions = [...extensions];
		const findPreviousExtensionIndex = (from: number): number => {
			let index = -1;
			const previousExtensionInNew = newExtensions[from];
			if (previousExtensionInNew) {
				index = oldExtensions.findIndex(e => areSameExtensions(e.identifier, previousExtensionInNew.identifier));
				if (index === -1) {
					return findPreviousExtensionIndex(from - 1);
				}
			}
			return index;
		};

		let hasChanged: boolean = false;
		for (let index = 0; index < newExtensions.length; index++) {
			const extension = newExtensions[index];
			if (extensions.every(r => !areSameExtensions(r.identifier, extension.identifier))) {
				hasChanged = true;
				extensions.splice(findPreviousExtensionIndex(index - 1) + 1, 0, extension);
			}
		}

		return hasChanged ? extensions : undefined;
	}

	private sortExtensions(extensions: IExtension[], options: IQueryOptions): IExtension[] {
		switch (options.sortBy) {
			case LocalSortBy.Name:
				extensions = extensions.sort((e1, e2) => e1.displayName.localeCompare(e2.displayName));
				break;
			case LocalSortBy.UpdateDate:
				extensions = extensions.sort((e1, e2) =>
					typeof e2.local?.installedTimestamp === 'number' && typeof e1.local?.installedTimestamp === 'number' ? e2.local.installedTimestamp - e1.local.installedTimestamp :
						typeof e2.local?.installedTimestamp === 'number' ? 1 :
							typeof e1.local?.installedTimestamp === 'number' ? -1 : NaN);
				break;
			default:
				extensions = extensions.sort((e1, e2) => e1.displayName.localeCompare(e2.displayName));
				break;
		}
		if (options.sortOrder === SortOrder.Descending) {
			extensions = extensions.reverse();
		}
		return extensions;
	}

	private setModel(model: IPagedModel<IExtension>, message?: Message, donotResetScrollTop?: boolean) {
		if (this.list) {
			this.list.model = new DelayedPagedModel(model);
			this.updateBody(message);
			if (!donotResetScrollTop) {
				this.list.scrollTop = 0;
			}
		}
		if (this.badge) {
			this.badge.setCount(this.count());
		}
	}

	private updateModel(model: IPagedModel<IExtension>) {
		if (this.list) {
			this.list.model = new DelayedPagedModel(model);
			this.updateBody();
		}
		if (this.badge) {
			this.badge.setCount(this.count());
		}
	}

	private updateBody(message?: Message): void {
		if (this.bodyTemplate) {

			const count = this.count();
			this.bodyTemplate.extensionsList.classList.toggle('hidden', count === 0);
			this.bodyTemplate.messageContainer.classList.toggle('hidden', !message && count > 0);

			if (this.isBodyVisible()) {
				if (message) {
					this.bodyTemplate.messageSeverityIcon.className = SeverityIcon.className(message.severity);
					this.bodyTemplate.messageBox.textContent = message.text;
				} else if (this.count() === 0) {
					this.bodyTemplate.messageSeverityIcon.className = '';
					this.bodyTemplate.messageBox.textContent = localize('no extensions found', "No extensions found.");
				}
				if (this.bodyTemplate.messageBox.textContent) {
					alert(this.bodyTemplate.messageBox.textContent);
				}
			}
		}

		this.updateSize();
	}

	private getMessage(error: any): Message {
		if (this.isOfflineError(error)) {
			return { text: localize('offline error', "Unable to search the Marketplace when offline, please check your network connection."), severity: Severity.Warning };
		} else {
			return { text: localize('error', "Error while fetching extensions. {0}", getErrorMessage(error)), severity: Severity.Error };
		}
	}

	private isOfflineError(error: Error): boolean {
		if (error instanceof ExtensionGalleryError) {
			return error.code === ExtensionGalleryErrorCode.Offline;
		}
		return isOfflineError(error);
	}

	protected updateSize() {
		if (this.options.flexibleHeight) {
			this.maximumBodySize = this.list?.model.length ? Number.POSITIVE_INFINITY : 0;
			this.storageService.store(`${this.id}.size`, this.list?.model.length || 0, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	override dispose(): void {
		super.dispose();
		if (this.queryRequest) {
			this.queryRequest.request.cancel();
			this.queryRequest = null;
		}
		if (this.queryResult) {
			this.queryResult.disposables.dispose();
			this.queryResult = undefined;
		}
		this.list = null;
	}

	static isLocalExtensionsQuery(query: string, sortBy?: string): boolean {
		return this.isInstalledExtensionsQuery(query)
			|| this.isSearchInstalledExtensionsQuery(query)
			|| this.isEnabledExtensionsQuery(query)
			|| this.isDisabledExtensionsQuery(query)
			|| this.isBuiltInExtensionsQuery(query)
			|| this.isSearchBuiltInExtensionsQuery(query)
			|| this.isBuiltInGroupExtensionsQuery(query)
			|| this.isSearchDeprecatedExtensionsQuery(query)
			|| this.isSearchWorkspaceUnsupportedExtensionsQuery(query)
			|| this.isSearchRecentlyUpdatedQuery(query)
			|| this.isRestartRequiredQuery(query)
			|| this.isSortInstalledExtensionsQuery(query, sortBy)
			|| this.isFeatureExtensionsQuery(query);
	}

	static isSearchBuiltInExtensionsQuery(query: string): boolean {
		return /@builtin\s.+|.+\s@builtin/i.test(query);
	}

	static isBuiltInExtensionsQuery(query: string): boolean {
		return /^@builtin$/i.test(query.trim());
	}

	static isBuiltInGroupExtensionsQuery(query: string): boolean {
		return /^@builtin:.+$/i.test(query.trim());
	}

	static isSearchWorkspaceUnsupportedExtensionsQuery(query: string): boolean {
		return /^\s*@workspaceUnsupported(:(untrusted|virtual)(Partial)?)?(\s|$)/i.test(query);
	}

	static isInstalledExtensionsQuery(query: string): boolean {
		return /@installed$/i.test(query) && !/@mcp/i.test(query) && !/@agentPlugins/i.test(query);
	}

	static isSearchInstalledExtensionsQuery(query: string): boolean {
		return (/@installed\s./i.test(query) && !/@mcp/i.test(query) && !/@agentPlugins/i.test(query)) || this.isFeatureExtensionsQuery(query);
	}

	static isEnabledExtensionsQuery(query: string): boolean {
		return /@enabled/i.test(query) && !/@builtin/i.test(query);
	}

	static isDisabledExtensionsQuery(query: string): boolean {
		return /@disabled/i.test(query) && !/@builtin/i.test(query);
	}

	static isSearchDeprecatedExtensionsQuery(query: string): boolean {
		return /@deprecated\s?.*/i.test(query);
	}

	static isSortInstalledExtensionsQuery(query: string, sortBy?: string): boolean {
		return (sortBy !== undefined && sortBy !== '' && query === '') || (!sortBy && /^@sort:\S*$/i.test(query));
	}

	static isSearchRecentlyUpdatedQuery(query: string): boolean {
		return /@recentlyUpdated/i.test(query);
	}

	static isRestartRequiredQuery(query: string): boolean {
		return /@restartrequired/i.test(query);
	}

	static isSortUpdateDateQuery(query: string): boolean {
		return /@sort:updateDate/i.test(query);
	}

	static isFeatureExtensionsQuery(query: string): boolean {
		return /@contribute:/i.test(query);
	}

	override focus(): void {
		super.focus();
		if (!this.list) {
			return;
		}

		if (!(this.list.getFocus().length || this.list.getSelection().length)) {
			this.list.focusNext();
		}
		this.list.domFocus();
	}
}

export class ServerInstalledExtensionsView extends ExtensionsListView {

	override async show(query: string): Promise<IPagedModel<IExtension>> {
		query = query ? query : '@installed';
		if (!ExtensionsListView.isLocalExtensionsQuery(query) || ExtensionsListView.isSortInstalledExtensionsQuery(query)) {
			query = query += ' @installed';
		}
		return super.show(query.trim());
	}

}

export class EnabledExtensionsView extends ExtensionsListView {

	override async show(query: string): Promise<IPagedModel<IExtension>> {
		query = query || '@enabled';
		return ExtensionsListView.isEnabledExtensionsQuery(query) ? super.show(query) :
			ExtensionsListView.isSortInstalledExtensionsQuery(query) ? super.show('@enabled ' + query) : this.showEmptyModel();
	}
}

export class DisabledExtensionsView extends ExtensionsListView {

	override async show(query: string): Promise<IPagedModel<IExtension>> {
		query = query || '@disabled';
		return ExtensionsListView.isDisabledExtensionsQuery(query) ? super.show(query) :
			ExtensionsListView.isSortInstalledExtensionsQuery(query) ? super.show('@disabled ' + query) : this.showEmptyModel();
	}
}

export class RecentlyUpdatedExtensionsView extends ExtensionsListView {

	override async show(query: string): Promise<IPagedModel<IExtension>> {
		query = query ? query : '@recentlyUpdated';
		return super.show(query.trim());
	}

}

export interface StaticQueryExtensionsViewOptions extends ExtensionsListViewOptions {
	readonly query: string;
}

export class StaticQueryExtensionsView extends ExtensionsListView {

	constructor(
		protected override readonly options: StaticQueryExtensionsViewOptions,
		viewletViewOptions: IViewletViewOptions,
		@INotificationService notificationService: INotificationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IExtensionService extensionService: IExtensionService,
		@IExtensionsWorkbenchService extensionsWorkbenchService: IExtensionsWorkbenchService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IExtensionManagementServerService extensionManagementServerService: IExtensionManagementServerService,
		@IExtensionManifestPropertiesService extensionManifestPropertiesService: IExtensionManifestPropertiesService,
		@IWorkbenchExtensionManagementService extensionManagementService: IWorkbenchExtensionManagementService,
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
		@IProductService productService: IProductService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IOpenerService openerService: IOpenerService,
		@IStorageService storageService: IStorageService,
		@IWorkspaceTrustManagementService workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkbenchExtensionEnablementService extensionEnablementService: IWorkbenchExtensionEnablementService,
		@IExtensionFeaturesManagementService extensionFeaturesManagementService: IExtensionFeaturesManagementService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@ILogService logService: ILogService
	) {
		super(options, viewletViewOptions, notificationService, keybindingService, contextMenuService, instantiationService, themeService, extensionService,
			extensionsWorkbenchService, telemetryService, hoverService, configurationService, contextService, extensionManagementServerService,
			extensionManifestPropertiesService, extensionManagementService, workspaceService, productService, contextKeyService, viewDescriptorService, openerService,
			storageService, workspaceTrustManagementService, extensionEnablementService, extensionFeaturesManagementService,
			uriIdentityService, logService);
	}

	override show(): Promise<IPagedModel<IExtension>> {
		return super.show(this.options.query);
	}
}

function toSpecificWorkspaceUnsupportedQuery(query: string, qualifier: string): string | undefined {
	if (!query) {
		return '@workspaceUnsupported:' + qualifier;
	}
	const match = query.match(new RegExp(`@workspaceUnsupported(:${qualifier})?(\\s|$)`, 'i'));
	if (match) {
		if (!match[1]) {
			return query.replace(/@workspaceUnsupported/gi, '@workspaceUnsupported:' + qualifier);
		}
		return query;
	}
	return undefined;
}


export class UntrustedWorkspaceUnsupportedExtensionsView extends ExtensionsListView {
	override async show(query: string): Promise<IPagedModel<IExtension>> {
		const updatedQuery = toSpecificWorkspaceUnsupportedQuery(query, 'untrusted');
		return updatedQuery ? super.show(updatedQuery) : this.showEmptyModel();
	}
}

export class UntrustedWorkspacePartiallySupportedExtensionsView extends ExtensionsListView {
	override async show(query: string): Promise<IPagedModel<IExtension>> {
		const updatedQuery = toSpecificWorkspaceUnsupportedQuery(query, 'untrustedPartial');
		return updatedQuery ? super.show(updatedQuery) : this.showEmptyModel();
	}
}

export class VirtualWorkspaceUnsupportedExtensionsView extends ExtensionsListView {
	override async show(query: string): Promise<IPagedModel<IExtension>> {
		const updatedQuery = toSpecificWorkspaceUnsupportedQuery(query, 'virtual');
		return updatedQuery ? super.show(updatedQuery) : this.showEmptyModel();
	}
}

export class VirtualWorkspacePartiallySupportedExtensionsView extends ExtensionsListView {
	override async show(query: string): Promise<IPagedModel<IExtension>> {
		const updatedQuery = toSpecificWorkspaceUnsupportedQuery(query, 'virtualPartial');
		return updatedQuery ? super.show(updatedQuery) : this.showEmptyModel();
	}
}

export class DeprecatedExtensionsView extends ExtensionsListView {
	override async show(query: string): Promise<IPagedModel<IExtension>> {
		return ExtensionsListView.isSearchDeprecatedExtensionsQuery(query) ? super.show(query) : this.showEmptyModel();
	}
}
