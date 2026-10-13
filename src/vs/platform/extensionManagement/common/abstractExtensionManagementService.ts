/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Barrier, CancelablePromise, createCancelablePromise } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError, getErrorMessage, isCancellationError } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../base/common/map.js';
import { isWeb } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import * as nls from '../../../nls.js';
import {
	ExtensionManagementError, IExtensionGalleryService, IExtensionIdentifier, IExtensionManagementParticipant, ILocalExtension, InstallOperation,
	IExtensionsControlManifest, StatisticType, ExtensionManagementErrorCode,
	InstallOptions, UninstallOptions, Metadata, InstallExtensionEvent, DidUninstallExtensionEvent, InstallExtensionResult, UninstallExtensionEvent, IExtensionManagementService, ExtensionGalleryError,
	IProductVersion,
	DidUpdateExtensionMetadata,
	UninstallExtensionInfo,
	IAllowedExtensionsService
} from './extensionManagement.js';
import { areSameExtensions, getGalleryExtensionId, getLocalExtensionTelemetryData } from './extensionManagementUtil.js';
import { ExtensionType, IExtensionManifest, isApplicationScopedExtension, TargetPlatform } from '../../extensions/common/extensions.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../uriIdentity/common/uriIdentity.js';
import { IUserDataProfilesService } from '../../userDataProfile/common/userDataProfile.js';

export type InstallableExtension = { readonly manifest: IExtensionManifest; readonly extension: URI; readonly options: InstallOptions };

export type InstallExtensionTaskOptions = InstallOptions & { readonly profileLocation: URI; readonly productVersion: IProductVersion };
export interface IInstallExtensionTask {
	readonly manifest: IExtensionManifest;
	readonly identifier: IExtensionIdentifier;
	readonly source: URI;
	readonly operation: InstallOperation;
	readonly options: InstallExtensionTaskOptions;
	run(): Promise<ILocalExtension>;
	waitUntilTaskIsFinished(): Promise<ILocalExtension>;
	cancel(): void;
}

export type UninstallExtensionTaskOptions = UninstallOptions & { readonly profileLocation: URI };
export interface IUninstallExtensionTask {
	readonly options: UninstallExtensionTaskOptions;
	readonly extension: ILocalExtension;
	run(): Promise<void>;
	waitUntilTaskIsFinished(): Promise<void>;
	cancel(): void;
}

export abstract class CommontExtensionManagementService extends Disposable implements IExtensionManagementService {

	_serviceBrand: undefined;

	readonly preferPreReleases: boolean;

	constructor(
		@IProductService protected readonly productService: IProductService,
		@IAllowedExtensionsService protected readonly allowedExtensionsService: IAllowedExtensionsService,
	) {
		super();
		this.preferPreReleases = this.productService.quality !== 'stable';
	}

	abstract readonly onInstallExtension: Event<InstallExtensionEvent>;
	abstract readonly onDidInstallExtensions: Event<readonly InstallExtensionResult[]>;
	abstract readonly onUninstallExtension: Event<UninstallExtensionEvent>;
	abstract readonly onDidUninstallExtension: Event<DidUninstallExtensionEvent>;
	abstract readonly onDidUpdateExtensionMetadata: Event<DidUpdateExtensionMetadata>;
	abstract uninstall(extension: ILocalExtension, options?: UninstallOptions): Promise<void>;
	abstract uninstallExtensions(extensions: UninstallExtensionInfo[]): Promise<void>;
	abstract toggleApplicationScope(extension: ILocalExtension, fromProfileLocation: URI): Promise<ILocalExtension>;
	abstract getExtensionsControlManifest(): Promise<IExtensionsControlManifest>;
	abstract resetPinnedStateForAllUserExtensions(pinned: boolean): Promise<void>;
	abstract registerParticipant(pariticipant: IExtensionManagementParticipant): void;
	abstract getTargetPlatform(): Promise<TargetPlatform>;
	abstract zip(extension: ILocalExtension): Promise<URI>;
	abstract getManifest(vsix: URI): Promise<IExtensionManifest>;
	abstract install(vsix: URI, options?: InstallOptions): Promise<ILocalExtension>;
	abstract installFromLocation(location: URI, profileLocation: URI): Promise<ILocalExtension>;
	abstract installExtensionsFromProfile(extensions: IExtensionIdentifier[], fromProfileLocation: URI, toProfileLocation: URI): Promise<ILocalExtension[]>;
	abstract getInstalled(type?: ExtensionType, profileLocation?: URI, productVersion?: IProductVersion): Promise<ILocalExtension[]>;
	abstract copyExtensions(fromProfileLocation: URI, toProfileLocation: URI): Promise<void>;
	abstract cleanUp(): Promise<void>;
	abstract updateMetadata(local: ILocalExtension, metadata: Partial<Metadata>, profileLocation: URI): Promise<ILocalExtension>;
}

export abstract class AbstractExtensionManagementService extends CommontExtensionManagementService implements IExtensionManagementService {

	declare readonly _serviceBrand: undefined;

	private extensionsControlManifest: Promise<IExtensionsControlManifest> | undefined;
	private lastReportTimestamp = 0;
	private readonly installingExtensions = new Map<string, IInstallExtensionTask>();
	private readonly uninstallingExtensions = new Map<string, IUninstallExtensionTask>();

	private readonly _onInstallExtension = this._register(new Emitter<InstallExtensionEvent>());
	get onInstallExtension() { return this._onInstallExtension.event; }

	protected readonly _onDidInstallExtensions = this._register(new Emitter<InstallExtensionResult[]>());
	get onDidInstallExtensions() { return this._onDidInstallExtensions.event; }

	protected readonly _onUninstallExtension = this._register(new Emitter<UninstallExtensionEvent>());
	get onUninstallExtension() { return this._onUninstallExtension.event; }

	protected _onDidUninstallExtension = this._register(new Emitter<DidUninstallExtensionEvent>());
	get onDidUninstallExtension() { return this._onDidUninstallExtension.event; }

	protected readonly _onDidUpdateExtensionMetadata = this._register(new Emitter<DidUpdateExtensionMetadata>());
	get onDidUpdateExtensionMetadata() { return this._onDidUpdateExtensionMetadata.event; }

	private readonly participants: IExtensionManagementParticipant[] = [];

	constructor(
		@IExtensionGalleryService protected readonly galleryService: IExtensionGalleryService,
		@ITelemetryService protected readonly telemetryService: ITelemetryService,
		@IUriIdentityService protected readonly uriIdentityService: IUriIdentityService,
		@ILogService protected readonly logService: ILogService,
		@IProductService productService: IProductService,
		@IAllowedExtensionsService allowedExtensionsService: IAllowedExtensionsService,
		@IUserDataProfilesService protected readonly userDataProfilesService: IUserDataProfilesService,
	) {
		super(productService, allowedExtensionsService);
		this._register(toDisposable(() => {
			this.installingExtensions.forEach(task => task.cancel());
			this.uninstallingExtensions.forEach(promise => promise.cancel());
			this.installingExtensions.clear();
			this.uninstallingExtensions.clear();
		}));
	}

	async uninstall(extension: ILocalExtension, options?: UninstallOptions): Promise<void> {
		this.logService.trace('ExtensionManagementService#uninstall', extension.identifier.id);
		return this.uninstallExtensions([{ extension, options }]);
	}

	async toggleApplicationScope(extension: ILocalExtension, fromProfileLocation: URI): Promise<ILocalExtension> {
		if (isApplicationScopedExtension(extension.manifest) || extension.isBuiltin) {
			return extension;
		}

		if (extension.isApplicationScoped) {
			let local = await this.updateMetadata(extension, { isApplicationScoped: false }, this.userDataProfilesService.defaultProfile.extensionsResource);
			if (!this.uriIdentityService.extUri.isEqual(fromProfileLocation, this.userDataProfilesService.defaultProfile.extensionsResource)) {
				local = await this.copyExtension(extension, this.userDataProfilesService.defaultProfile.extensionsResource, fromProfileLocation);
			}

			for (const profile of this.userDataProfilesService.profiles) {
				const existing = (await this.getInstalled(ExtensionType.User, profile.extensionsResource))
					.find(e => areSameExtensions(e.identifier, extension.identifier));
				if (existing) {
					this._onDidUpdateExtensionMetadata.fire({ local: existing, profileLocation: profile.extensionsResource });
				} else {
					this._onDidUninstallExtension.fire({ identifier: extension.identifier, profileLocation: profile.extensionsResource });
				}
			}
			return local;
		}

		else {
			const local = this.uriIdentityService.extUri.isEqual(fromProfileLocation, this.userDataProfilesService.defaultProfile.extensionsResource)
				? await this.updateMetadata(extension, { isApplicationScoped: true }, this.userDataProfilesService.defaultProfile.extensionsResource)
				: await this.copyExtension(extension, fromProfileLocation, this.userDataProfilesService.defaultProfile.extensionsResource, { isApplicationScoped: true });

			this._onDidInstallExtensions.fire([{ identifier: local.identifier, operation: InstallOperation.Install, local, profileLocation: this.userDataProfilesService.defaultProfile.extensionsResource, applicationScoped: true }]);
			return local;
		}

	}

	getExtensionsControlManifest(): Promise<IExtensionsControlManifest> {
		const now = new Date().getTime();

		if (!this.extensionsControlManifest || now - this.lastReportTimestamp > 1000 * 60 * 5) { // 5 minute cache freshness
			this.extensionsControlManifest = this.updateControlCache();
			this.lastReportTimestamp = now;
		}

		return this.extensionsControlManifest;
	}

	registerParticipant(participant: IExtensionManagementParticipant): void {
		this.participants.push(participant);
	}

	async resetPinnedStateForAllUserExtensions(pinned: boolean): Promise<void> {
		try {
			await this.joinAllSettled(this.userDataProfilesService.profiles.map(
				async profile => {
					const extensions = await this.getInstalled(ExtensionType.User, profile.extensionsResource);
					await this.joinAllSettled(extensions.map(
						async extension => {
							if (extension.pinned !== pinned) {
								await this.updateMetadata(extension, { pinned }, profile.extensionsResource);
							}
						}));
				}));
		} catch (error) {
			this.logService.error('Error while resetting pinned state for all user extensions', getErrorMessage(error));
			throw error;
		}
	}

	protected async installExtensions(extensions: InstallableExtension[]): Promise<InstallExtensionResult[]> {
		const results = new Map<string, InstallExtensionResult & { profileLocation: URI }>();
		const tasks = new Map<string, IInstallExtensionTask>();
		const pending = new Map<string, Promise<void>>();
		const resultKey = (identifier: IExtensionIdentifier, profileLocation: URI) => `${identifier.id.toLowerCase()}-${profileLocation.toString()}`;

		const systemExtensions = await this.getInstalled(ExtensionType.System);
		for (const { manifest, extension, options } of extensions) {
			const identifier = { id: getGalleryExtensionId(manifest.publisher, manifest.name) };
			const profileLocation = options.isApplicationScoped || options.isBuiltin || isApplicationScopedExtension(manifest)
				? this.userDataProfilesService.defaultProfile.extensionsResource
				: options.profileLocation ?? this.getCurrentExtensionsManifestLocation();
			const isBuiltin = options.isBuiltin || systemExtensions.some(extension => areSameExtensions(extension.identifier, identifier));
			const taskOptions: InstallExtensionTaskOptions = {
				...options,
				isBuiltin,
				isApplicationScoped: options.isApplicationScoped || isBuiltin || isApplicationScopedExtension(manifest),
				profileLocation: isBuiltin || options.isApplicationScoped || isApplicationScopedExtension(manifest)
					? this.userDataProfilesService.defaultProfile.extensionsResource
					: profileLocation,
				productVersion: options.productVersion ?? { version: this.productService.version, date: this.productService.date }
			};
			const key = resultKey(identifier, taskOptions.profileLocation);
			if (tasks.has(key) || pending.has(key)) {
				continue;
			}

			const activeTask = this.installingExtensions.get(key);
			if (activeTask) {
				pending.set(key, activeTask.waitUntilTaskIsFinished().then(local => {
					results.set(key, { local, identifier: activeTask.identifier, operation: activeTask.operation, source: activeTask.source, context: taskOptions.context, profileLocation: taskOptions.profileLocation, applicationScoped: local.isApplicationScoped });
				}, error => {
					results.set(key, { error: toExtensionManagementError(error), identifier: activeTask.identifier, operation: activeTask.operation, source: activeTask.source, context: taskOptions.context, profileLocation: taskOptions.profileLocation });
				}));
				continue;
			}

			const task = this.createInstallExtensionTask(manifest, extension, taskOptions);
			tasks.set(key, task);
			this.installingExtensions.set(key, task);
			this._onInstallExtension.fire({ identifier: task.identifier, source: extension, profileLocation: taskOptions.profileLocation });
			this.logService.info('Installing extension:', task.identifier.id, taskOptions);
		}

		await Promise.all([
			...Array.from(tasks, async ([key, task]) => {
				try {
					const local = await task.run();
					await this.joinAllSettled(this.participants.map(participant => participant.postInstall(local, task.source, task.options, CancellationToken.None)), ExtensionManagementErrorCode.PostInstall);
					results.set(key, { local, identifier: task.identifier, operation: task.operation, source: task.source, context: task.options.context, profileLocation: task.options.profileLocation, applicationScoped: local.isApplicationScoped });
				} catch (error) {
					const managementError = toExtensionManagementError(error);
					results.set(key, { error: managementError, identifier: task.identifier, operation: task.operation, source: task.source, context: task.options.context, profileLocation: task.options.profileLocation, applicationScoped: task.options.isApplicationScoped });
					this.logService.error('Error while installing the extension', task.identifier.id, getErrorMessage(managementError), task.options.profileLocation.toString());
				} finally {
					if (this.installingExtensions.get(key) === task) {
						this.installingExtensions.delete(key);
					}
				}
			}),
			...pending.values()
		]);

		const installResults = [...results.values()];
		for (const result of installResults) {
			if (result.local) {
				this.logService.info('Extension installed successfully:', result.identifier.id, result.profileLocation.toString());
			}
		}
		this._onDidInstallExtensions.fire(installResults);
		return installResults;
	}

	private async joinAllSettled<T>(promises: Promise<T>[], errorCode?: ExtensionManagementErrorCode): Promise<T[]> {
		const results: T[] = [];
		const errors: ExtensionManagementError[] = [];
		const promiseResults = await Promise.allSettled(promises);
		for (const r of promiseResults) {
			if (r.status === 'fulfilled') {
				results.push(r.value);
			} else {
				errors.push(toExtensionManagementError(r.reason, errorCode));
			}
		}

		if (!errors.length) {
			return results;
		}

		// Throw if there are errors
		if (errors.length === 1) {
			throw errors[0];
		}

		let error = new ExtensionManagementError('', ExtensionManagementErrorCode.Unknown);
		for (const current of errors) {
			error = new ExtensionManagementError(
				error.message ? `${error.message}, ${current.message}` : current.message,
				current.code !== ExtensionManagementErrorCode.Unknown && current.code !== ExtensionManagementErrorCode.Internal ? current.code : error.code
			);
		}
		throw error;
	}

	private getUninstallExtensionTaskKey(identifier: IExtensionIdentifier, profileLocation: URI, version?: string): string {
		return `${identifier.id.toLowerCase()}${version ? `-${version}` : ''}@${profileLocation.toString()}`;
	}

	async uninstallExtensions(extensions: UninstallExtensionInfo[]): Promise<void> {

		const getUninstallExtensionTaskKey = (extension: ILocalExtension, uninstallOptions: UninstallExtensionTaskOptions) => this.getUninstallExtensionTaskKey(extension.identifier, uninstallOptions.profileLocation, uninstallOptions.versionOnly ? extension.manifest.version : undefined);

		const createUninstallExtensionTask = (extension: ILocalExtension, uninstallOptions: UninstallExtensionTaskOptions): void => {
			let installTaskToWaitFor: IInstallExtensionTask | undefined;
			for (const task of this.installingExtensions.values()) {
				if (areSameExtensions(task.identifier, extension.identifier) && this.uriIdentityService.extUri.isEqual(task.options.profileLocation, uninstallOptions.profileLocation)) {
					installTaskToWaitFor = task;
					break;
				}
			}
			const task = this.createUninstallExtensionTask(extension, uninstallOptions);
			this.uninstallingExtensions.set(getUninstallExtensionTaskKey(task.extension, uninstallOptions), task);
			this.logService.info('Uninstalling extension from the profile:', `${extension.identifier.id}@${extension.manifest.version}`, uninstallOptions.profileLocation.toString());
			this._onUninstallExtension.fire({ identifier: extension.identifier, profileLocation: uninstallOptions.profileLocation, applicationScoped: extension.isApplicationScoped });
			allTasks.push({ task, installTaskToWaitFor });
		};

		const postUninstallExtension = (extension: ILocalExtension, uninstallOptions: UninstallExtensionTaskOptions, error?: ExtensionManagementError): void => {
			if (error) {
				this.logService.error('Failed to uninstall extension from the profile:', `${extension.identifier.id}@${extension.manifest.version}`, uninstallOptions.profileLocation.toString(), error.message);
			} else {
				this.logService.info('Successfully uninstalled extension from the profile', `${extension.identifier.id}@${extension.manifest.version}`, uninstallOptions.profileLocation.toString());
			}
			reportUninstallTelemetry(this.telemetryService, extension, error);
			this._onDidUninstallExtension.fire({ identifier: extension.identifier, error: error?.code, profileLocation: uninstallOptions.profileLocation, applicationScoped: extension.isApplicationScoped });
		};

		const allTasks: { task: IUninstallExtensionTask; installTaskToWaitFor?: IInstallExtensionTask }[] = [];
		const processedTasks: IUninstallExtensionTask[] = [];
		const alreadyRequestedUninstalls: Promise<void>[] = [];
		const extensionsToRemove: ILocalExtension[] = [];

		const installedExtensionsMap = new ResourceMap<ILocalExtension[]>();
		const getInstalledExtensions = async (profileLocation: URI) => {
			let installed = installedExtensionsMap.get(profileLocation);
			if (!installed) {
				installedExtensionsMap.set(profileLocation, installed = await this.getInstalled(ExtensionType.User, profileLocation));
			}
			return installed;
		};

		for (const { extension, options } of extensions) {
			const uninstallOptions: UninstallExtensionTaskOptions = {
				...options,
				profileLocation: extension.isApplicationScoped ? this.userDataProfilesService.defaultProfile.extensionsResource : options?.profileLocation ?? this.getCurrentExtensionsManifestLocation()
			};
			const uninstallExtensionTask = this.uninstallingExtensions.get(getUninstallExtensionTaskKey(extension, uninstallOptions));
			if (uninstallExtensionTask) {
				this.logService.info('Extensions is already requested to uninstall', extension.identifier.id);
				alreadyRequestedUninstalls.push(uninstallExtensionTask.waitUntilTaskIsFinished());
			} else {
				createUninstallExtensionTask(extension, uninstallOptions);
			}

			if (uninstallOptions.remove || extension.isApplicationScoped) {
				if (uninstallOptions.remove) {
					extensionsToRemove.push(extension);
				}
				for (const profile of this.userDataProfilesService.profiles) {
					if (this.uriIdentityService.extUri.isEqual(profile.extensionsResource, uninstallOptions.profileLocation)) {
						continue;
					}
					const installed = await getInstalledExtensions(profile.extensionsResource);
					const profileExtension = installed.find(e => areSameExtensions(e.identifier, extension.identifier));
					if (profileExtension) {
						const uninstallOptionsWithProfile = { ...uninstallOptions, profileLocation: profile.extensionsResource };
						const uninstallExtensionTask = this.uninstallingExtensions.get(getUninstallExtensionTaskKey(profileExtension, uninstallOptionsWithProfile));
						if (uninstallExtensionTask) {
							this.logService.info('Extensions is already requested to uninstall', profileExtension.identifier.id);
							alreadyRequestedUninstalls.push(uninstallExtensionTask.waitUntilTaskIsFinished());
						} else {
							createUninstallExtensionTask(profileExtension, uninstallOptionsWithProfile);
						}
					}
				}
			}
		}

		try {
			for (const { task } of allTasks.slice(0)) {
				const installed = await getInstalledExtensions(task.options.profileLocation);

				if (task.options.donotIncludePack) {
					this.logService.info('Uninstalling the extension without including packed extension', `${task.extension.identifier.id}@${task.extension.manifest.version}`);
				} else {
					const packedExtensions = this.getAllPackExtensionsToUninstall(task.extension, installed);
					for (const packedExtension of packedExtensions) {
						if (this.uninstallingExtensions.has(getUninstallExtensionTaskKey(packedExtension, task.options))) {
							this.logService.info('Extensions is already requested to uninstall', packedExtension.identifier.id);
						} else {
							createUninstallExtensionTask(packedExtension, task.options);
						}
					}
				}
				if (task.options.donotCheckDependents) {
					this.logService.info('Uninstalling the extension without checking dependents', `${task.extension.identifier.id}@${task.extension.manifest.version}`);
				} else {
					this.checkForDependents(allTasks.map(({ task }) => task.extension), installed, task.extension);
				}
			}

			// Uninstall extensions in parallel and wait until all extensions are uninstalled / failed
			await this.joinAllSettled(allTasks.map(async ({ task, installTaskToWaitFor }) => {
				try {
					// Wait for opposite task if it exists
					if (installTaskToWaitFor) {
						this.logService.info('Waiting for existing install task to complete before uninstalling', task.extension.identifier.id);
						try {
							await installTaskToWaitFor.waitUntilTaskIsFinished();
							this.logService.info('Finished waiting for install task, proceeding with uninstall', task.extension.identifier.id);
						} catch (error) {
							this.logService.info('Install task failed, proceeding with uninstall anyway', task.extension.identifier.id, getErrorMessage(error));
						}
					}

					await task.run();
					await this.joinAllSettled(this.participants.map(participant => participant.postUninstall(task.extension, task.options, CancellationToken.None)));
					// only report if extension has a mapped gallery extension and not in web. UUID identifies the gallery extension.
					if (task.extension.identifier.uuid && !isWeb) {
						try {
							await this.galleryService.reportStatistic(task.extension.manifest.publisher, task.extension.manifest.name, task.extension.manifest.version, StatisticType.Uninstall);
						} catch (error) { /* ignore */ }
					}
				} catch (e) {
					const error = toExtensionManagementError(e);
					postUninstallExtension(task.extension, task.options, error);
					throw error;
				} finally {
					processedTasks.push(task);
				}
			}));

			if (alreadyRequestedUninstalls.length) {
				await this.joinAllSettled(alreadyRequestedUninstalls);
			}

			for (const { task } of allTasks) {
				postUninstallExtension(task.extension, task.options);
			}

			if (extensionsToRemove.length) {
				await this.joinAllSettled(extensionsToRemove.map(extension => this.deleteExtension(extension)));
			}
		} catch (e) {
			const error = toExtensionManagementError(e);
			for (const { task } of allTasks) {
				// cancel the tasks
				try { task.cancel(); } catch (error) { /* ignore */ }
				if (!processedTasks.includes(task)) {
					postUninstallExtension(task.extension, task.options, error);
				}
			}
			throw error;
		} finally {
			// Remove tasks from cache
			for (const { task } of allTasks) {
				if (!this.uninstallingExtensions.delete(getUninstallExtensionTaskKey(task.extension, task.options))) {
					this.logService.warn('Uninstallation task is not found in the cache', task.extension.identifier.id);
				}
			}
		}
	}

	private checkForDependents(extensionsToUninstall: ILocalExtension[], installed: ILocalExtension[], extensionToUninstall: ILocalExtension): void {
		for (const extension of extensionsToUninstall) {
			const dependents = this.getDependents(extension, installed);
			if (dependents.length) {
				const remainingDependents = dependents.filter(dependent => !extensionsToUninstall.some(e => areSameExtensions(e.identifier, dependent.identifier)));
				if (remainingDependents.length) {
					throw new Error(this.getDependentsErrorMessage(extension, remainingDependents, extensionToUninstall));
				}
			}
		}
	}

	private getDependentsErrorMessage(dependingExtension: ILocalExtension, dependents: ILocalExtension[], extensionToUninstall: ILocalExtension): string {
		if (extensionToUninstall === dependingExtension) {
			if (dependents.length === 1) {
				return nls.localize('singleDependentError', "Cannot uninstall '{0}' extension. '{1}' extension depends on this.",
					extensionToUninstall.manifest.displayName || extensionToUninstall.manifest.name, dependents[0].manifest.displayName || dependents[0].manifest.name);
			}
			if (dependents.length === 2) {
				return nls.localize('twoDependentsError', "Cannot uninstall '{0}' extension. '{1}' and '{2}' extensions depend on this.",
					extensionToUninstall.manifest.displayName || extensionToUninstall.manifest.name, dependents[0].manifest.displayName || dependents[0].manifest.name, dependents[1].manifest.displayName || dependents[1].manifest.name);
			}
			return nls.localize('multipleDependentsError', "Cannot uninstall '{0}' extension. '{1}', '{2}' and other extension depend on this.",
				extensionToUninstall.manifest.displayName || extensionToUninstall.manifest.name, dependents[0].manifest.displayName || dependents[0].manifest.name, dependents[1].manifest.displayName || dependents[1].manifest.name);
		}
		if (dependents.length === 1) {
			return nls.localize('singleIndirectDependentError', "Cannot uninstall '{0}' extension . It includes uninstalling '{1}' extension and '{2}' extension depends on this.",
				extensionToUninstall.manifest.displayName || extensionToUninstall.manifest.name, dependingExtension.manifest.displayName
			|| dependingExtension.manifest.name, dependents[0].manifest.displayName || dependents[0].manifest.name);
		}
		if (dependents.length === 2) {
			return nls.localize('twoIndirectDependentsError', "Cannot uninstall '{0}' extension. It includes uninstalling '{1}' extension and '{2}' and '{3}' extensions depend on this.",
				extensionToUninstall.manifest.displayName || extensionToUninstall.manifest.name, dependingExtension.manifest.displayName
			|| dependingExtension.manifest.name, dependents[0].manifest.displayName || dependents[0].manifest.name, dependents[1].manifest.displayName || dependents[1].manifest.name);
		}
		return nls.localize('multipleIndirectDependentsError', "Cannot uninstall '{0}' extension. It includes uninstalling '{1}' extension and '{2}', '{3}' and other extensions depend on this.",
			extensionToUninstall.manifest.displayName || extensionToUninstall.manifest.name, dependingExtension.manifest.displayName
		|| dependingExtension.manifest.name, dependents[0].manifest.displayName || dependents[0].manifest.name, dependents[1].manifest.displayName || dependents[1].manifest.name);

	}

	private getAllPackExtensionsToUninstall(extension: ILocalExtension, installed: ILocalExtension[], checked: ILocalExtension[] = []): ILocalExtension[] {
		if (checked.indexOf(extension) !== -1) {
			return [];
		}
		checked.push(extension);
		const extensionsPack = extension.manifest.extensionPack ? extension.manifest.extensionPack : [];
		if (extensionsPack.length) {
			const packedExtensions = installed.filter(i => !i.isBuiltin && extensionsPack.some(id => areSameExtensions({ id }, i.identifier)));
			const packOfPackedExtensions: ILocalExtension[] = [];
			for (const packedExtension of packedExtensions) {
				packOfPackedExtensions.push(...this.getAllPackExtensionsToUninstall(packedExtension, installed, checked));
			}
			return [...packedExtensions, ...packOfPackedExtensions];
		}
		return [];
	}

	private getDependents(extension: ILocalExtension, installed: ILocalExtension[]): ILocalExtension[] {
		return installed.filter(e => e.manifest.extensionDependencies && e.manifest.extensionDependencies.some(id => areSameExtensions({ id }, extension.identifier)));
	}

	private async updateControlCache(): Promise<IExtensionsControlManifest> {
		try {
			this.logService.trace('ExtensionManagementService.updateControlCache');
			return await this.galleryService.getExtensionsControlManifest();
		} catch (err) {
			this.logService.trace('ExtensionManagementService.refreshControlCache - failed to get extension control manifest', getErrorMessage(err));
			return { malicious: [], deprecated: {}, search: [] };
		}
	}

	protected abstract getCurrentExtensionsManifestLocation(): URI;
	protected abstract createInstallExtensionTask(manifest: IExtensionManifest, extension: URI, options: InstallExtensionTaskOptions): IInstallExtensionTask;
	protected abstract createUninstallExtensionTask(extension: ILocalExtension, options: UninstallExtensionTaskOptions): IUninstallExtensionTask;
	protected abstract copyExtension(extension: ILocalExtension, fromProfileLocation: URI, toProfileLocation: URI, metadata?: Partial<Metadata>): Promise<ILocalExtension>;
	protected abstract moveExtension(extension: ILocalExtension, fromProfileLocation: URI, toProfileLocation: URI, metadata?: Partial<Metadata>): Promise<ILocalExtension>;
	protected abstract removeExtension(extension: ILocalExtension, fromProfileLocation: URI): Promise<void>;
	protected abstract deleteExtension(extension: ILocalExtension): Promise<void>;
}

export function toExtensionManagementError(error: Error, code?: ExtensionManagementErrorCode): ExtensionManagementError {
	if (error instanceof ExtensionManagementError) {
		return error;
	}
	let extensionManagementError: ExtensionManagementError;
	if (error instanceof ExtensionGalleryError) {
			extensionManagementError = new ExtensionManagementError(error.message, ExtensionManagementErrorCode.Gallery);
	} else {
		extensionManagementError = new ExtensionManagementError(error.message, isCancellationError(error) ? ExtensionManagementErrorCode.Cancelled : (code ?? ExtensionManagementErrorCode.Internal));
	}
	extensionManagementError.stack = error.stack;
	return extensionManagementError;
}

function reportUninstallTelemetry(telemetryService: ITelemetryService, extension: ILocalExtension, error?: ExtensionManagementError): void {
	/* __GDPR__
		"extensionGallery:uninstall" : {
			"owner": "sandy081",
			"success": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
			"errorcode": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" },
			"${include}": [ "${GalleryExtensionTelemetryData}" ]
		}
	*/
	telemetryService.publicLog('extensionGallery:uninstall', {
		...getLocalExtensionTelemetryData(extension),
		success: !error,
		errorcode: error?.code
	});
}

export abstract class AbstractExtensionTask<T> {

	private readonly barrier = new Barrier();
	private cancellablePromise: CancelablePromise<T> | undefined;

	async waitUntilTaskIsFinished(): Promise<T> {
		await this.barrier.wait();
		return this.cancellablePromise!;
	}

	run(): Promise<T> {
		if (!this.cancellablePromise) {
			this.cancellablePromise = createCancelablePromise(token => this.doRun(token));
		}
		this.barrier.open();
		return this.cancellablePromise;
	}

	cancel(): void {
		if (!this.cancellablePromise) {
			this.cancellablePromise = createCancelablePromise(token => {
				return new Promise((c, e) => {
					const disposable = token.onCancellationRequested(() => {
						disposable.dispose();
						e(new CancellationError());
					});
				});
			});
			this.barrier.open();
		}
		this.cancellablePromise.cancel();
	}

	protected abstract doRun(token: CancellationToken): Promise<T>;
}
