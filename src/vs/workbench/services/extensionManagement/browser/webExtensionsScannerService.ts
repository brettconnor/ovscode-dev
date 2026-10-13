/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IBuiltinExtensionsScannerService, ExtensionType, IExtensionIdentifier, IExtension, IExtensionManifest, TargetPlatform, IRelaxedExtensionManifest, parseEnabledApiProposalNames } from '../../../../platform/extensions/common/extensions.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IScannedExtension, IWebExtensionsScannerService, ScanOptions } from '../common/extensionManagement.js';
import { isWeb, Language } from '../../../../base/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { Queue } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IGalleryMetadata, Metadata } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions, getGalleryExtensionId } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITranslations, localizeManifest } from '../../../../platform/extensionManagement/common/extensionNls.js';
import { localize, localize2 } from '../../../../nls.js';
import * as semver from '../../../../base/common/semver/semver.js';
import { isUndefined } from '../../../../base/common/types.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { IExtensionManifestPropertiesService } from '../../extensions/common/extensionManifestPropertiesService.js';
import { IExtensionResourceLoaderService, migratePlatformSpecificExtensionGalleryResourceURL } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IsWebContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService, LifecyclePhase } from '../../lifecycle/common/lifecycle.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { validateExtensionManifest } from '../../../../platform/extensions/common/extensionValidator.js';
import Severity from '../../../../base/common/severity.js';
import { IStringDictionary } from '../../../../base/common/collections.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';

function isUriComponents(obj: unknown): obj is UriComponents {
	if (!obj) {
		return false;
	}
	const thing = obj as UriComponents | undefined;
	return typeof thing?.path === 'string' &&
		typeof thing?.scheme === 'string';
}

interface IStoredWebExtension {
	readonly identifier: IExtensionIdentifier;
	readonly version: string;
	readonly location: UriComponents;
	readonly manifest?: IExtensionManifest;
	readonly readmeUri?: UriComponents;
	readonly changelogUri?: UriComponents;
	// deprecated in favor of packageNLSUris & fallbackPackageNLSUri
	readonly packageNLSUri?: UriComponents;
	readonly packageNLSUris?: IStringDictionary<UriComponents>;
	readonly fallbackPackageNLSUri?: UriComponents;
	readonly defaultManifestTranslations?: ITranslations | null;
	readonly metadata?: Metadata;
}

interface IWebExtension {
	identifier: IExtensionIdentifier;
	version: string;
	location: URI;
	manifest?: IExtensionManifest;
	readmeUri?: URI;
	changelogUri?: URI;
	// deprecated in favor of packageNLSUris & fallbackPackageNLSUri
	packageNLSUri?: URI;
	packageNLSUris?: Map<string, URI>;
	fallbackPackageNLSUri?: URI;
	defaultManifestTranslations?: ITranslations | null;
	metadata?: Metadata;
}

export class WebExtensionsScannerService extends Disposable implements IWebExtensionsScannerService {

	declare readonly _serviceBrand: undefined;

	private readonly systemExtensionsCacheResource: URI | undefined = undefined;
	private readonly resourcesAccessQueueMap = new ResourceMap<Queue<IWebExtension[]>>();

	constructor(
		@IBrowserWorkbenchEnvironmentService private readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@IBuiltinExtensionsScannerService private readonly builtinExtensionsScannerService: IBuiltinExtensionsScannerService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IExtensionManifestPropertiesService private readonly extensionManifestPropertiesService: IExtensionManifestPropertiesService,
		@IExtensionResourceLoaderService private readonly extensionResourceLoaderService: IExtensionResourceLoaderService,
		@IProductService private readonly productService: IProductService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		if (isWeb) {
			this.systemExtensionsCacheResource = joinPath(environmentService.userRoamingDataHome, 'systemExtensionsCache.json');

			// Eventually update caches
			lifecycleService.when(LifecyclePhase.Eventually).then(() => this.updateCaches());
		}
	}

	private _customBuiltinExtensionLocationsPromise: Promise<URI[]> | undefined;
	private readCustomBuiltinExtensionLocationsFromEnv(): Promise<URI[]> {
		if (!this._customBuiltinExtensionLocationsPromise) {
			this._customBuiltinExtensionLocationsPromise = Promise.resolve(this.environmentService.options && Array.isArray(this.environmentService.options.additionalBuiltinExtensions)
				? this.environmentService.options.additionalBuiltinExtensions.filter(isUriComponents).map(location => URI.revive(location))
				: []);
		}
		return this._customBuiltinExtensionLocationsPromise;
	}

	/**
	 * All system extensions bundled with the product
	 */
	private async readSystemExtensions(): Promise<IExtension[]> {
		const systemExtensions = await this.builtinExtensionsScannerService.scanBuiltinExtensions();
		const cachedSystemExtensions = await Promise.all((await this.readSystemExtensionsCache()).map(e => this.toScannedExtension(e, true, ExtensionType.System)));

		const result = new Map<string, IExtension>();
		for (const extension of [...systemExtensions, ...cachedSystemExtensions]) {
			const existing = result.get(extension.identifier.id.toLowerCase());
			if (existing) {
				// Incase there are duplicates always take the latest version
				if (semver.gt(existing.manifest.version, extension.manifest.version)) {
					continue;
				}
			}
			result.set(extension.identifier.id.toLowerCase(), extension);
		}
		return [...result.values()];
	}

	/**
	 * All extensions defined via `additionalBuiltinExtensions` API
	 */
	private async readCustomBuiltinExtensions(scanOptions?: ScanOptions): Promise<IScannedExtension[]> {
		return this.getCustomBuiltinExtensionsFromLocations(scanOptions);
	}

	private async getCustomBuiltinExtensionsFromLocations(scanOptions?: ScanOptions): Promise<IScannedExtension[]> {
		const extensionLocations = await this.readCustomBuiltinExtensionLocationsFromEnv();
		if (!extensionLocations.length) {
			return [];
		}
		const result: IScannedExtension[] = [];
		await Promise.allSettled(extensionLocations.map(async extensionLocation => {
			try {
				const webExtension = await this.toWebExtension(extensionLocation);
				const extension = await this.toScannedExtension(webExtension, true);
				if (extension.isValid || !scanOptions?.skipInvalidExtensions) {
					result.push(extension);
				} else {
					this.logService.info(`Skipping invalid additional builtin extension ${webExtension.identifier.id}`);
				}
			} catch (error) {
				this.logService.info(`Error while fetching the additional builtin extension ${extensionLocation.toString()}.`, getErrorMessage(error));
			}
		}));
		return result;
	}

	private async updateCaches(): Promise<void> {
		await this.updateSystemExtensionsCache();
	}

	private async updateSystemExtensionsCache(): Promise<void> {
		const systemExtensions = await this.builtinExtensionsScannerService.scanBuiltinExtensions();
		const cachedSystemExtensions = (await this.readSystemExtensionsCache())
			.filter(cached => {
				const systemExtension = systemExtensions.find(e => areSameExtensions(e.identifier, cached.identifier));
				return systemExtension && semver.gt(cached.version, systemExtension.manifest.version);
			});
		await this.writeSystemExtensionsCache(() => cachedSystemExtensions);
	}

	async scanSystemExtensions(): Promise<IExtension[]> {
		return this.readSystemExtensions();
	}

	async scanUserExtensions(profileLocation: URI, scanOptions?: ScanOptions): Promise<IScannedExtension[]> {
		const extensions = new Map<string, IScannedExtension>();

		// Custom builtin extensions defined through `additionalBuiltinExtensions` API
		const customBuiltinExtensions = await this.readCustomBuiltinExtensions(scanOptions);
		for (const extension of customBuiltinExtensions) {
			extensions.set(extension.identifier.id.toLowerCase(), extension);
		}

		// User Installed extensions
		const installedExtensions = await this.scanInstalledExtensions(profileLocation, scanOptions);
		for (const extension of installedExtensions) {
			extensions.set(extension.identifier.id.toLowerCase(), extension);
		}

		return [...extensions.values()];
	}

	async scanExtensionsUnderDevelopment(): Promise<IExtension[]> {
		const devExtensions = this.environmentService.options?.developmentOptions?.extensions;
		const result: IExtension[] = [];
		if (Array.isArray(devExtensions)) {
			await Promise.allSettled(devExtensions.map(async devExtension => {
				try {
					const location = URI.revive(devExtension);
					if (URI.isUri(location)) {
						const webExtension = await this.toWebExtension(location);
						result.push(await this.toScannedExtension(webExtension, false));
					} else {
						this.logService.info(`Skipping the extension under development ${devExtension} as it is not URI type.`);
					}
				} catch (error) {
					this.logService.info(`Error while fetching the extension under development ${devExtension.toString()}.`, getErrorMessage(error));
				}
			}));
		}
		return result;
	}

	async scanExistingExtension(extensionLocation: URI, extensionType: ExtensionType, profileLocation: URI): Promise<IScannedExtension | null> {
		if (extensionType === ExtensionType.System) {
			const systemExtensions = await this.scanSystemExtensions();
			return systemExtensions.find(e => e.location.toString() === extensionLocation.toString()) || null;
		}
		const userExtensions = await this.scanUserExtensions(profileLocation);
		return userExtensions.find(e => e.location.toString() === extensionLocation.toString()) || null;
	}

	async scanExtensionManifest(extensionLocation: URI): Promise<IExtensionManifest | null> {
		try {
			return await this.getExtensionManifest(extensionLocation);
		} catch (error) {
			this.logService.warn(`Error while fetching manifest from ${extensionLocation.toString()}`, getErrorMessage(error));
			return null;
		}
	}

	async addExtension(location: URI, metadata: Metadata, profileLocation: URI): Promise<IScannedExtension> {
		const webExtension = await this.toWebExtension(location, undefined, undefined, undefined, undefined, undefined, undefined, metadata);
		const extension = await this.toScannedExtension(webExtension, false);
		await this.addToInstalledExtensions([webExtension], profileLocation);
		return extension;
	}

	async removeExtension(extension: IScannedExtension, profileLocation: URI): Promise<void> {
		await this.writeInstalledExtensions(profileLocation, installedExtensions => installedExtensions.filter(installedExtension => !areSameExtensions(installedExtension.identifier, extension.identifier)));
	}

	async updateMetadata(extension: IScannedExtension, metadata: Partial<Metadata>, profileLocation: URI): Promise<IScannedExtension> {
		let updatedExtension: IWebExtension | undefined = undefined;
		await this.writeInstalledExtensions(profileLocation, installedExtensions => {
			const result: IWebExtension[] = [];
			for (const installedExtension of installedExtensions) {
				if (areSameExtensions(extension.identifier, installedExtension.identifier)) {
					installedExtension.metadata = { ...installedExtension.metadata, ...metadata };
					updatedExtension = installedExtension;
					result.push(installedExtension);
				} else {
					result.push(installedExtension);
				}
			}
			return result;
		});
		if (!updatedExtension) {
			throw new Error('Extension not found');
		}
		return this.toScannedExtension(updatedExtension, extension.isBuiltin);
	}

	async copyExtensions(fromProfileLocation: URI, toProfileLocation: URI, filter: (extension: IScannedExtension) => boolean): Promise<void> {
		const extensionsToCopy: IWebExtension[] = [];
		const fromWebExtensions = await this.readInstalledExtensions(fromProfileLocation);
		await Promise.all(fromWebExtensions.map(async webExtension => {
			const scannedExtension = await this.toScannedExtension(webExtension, false);
			if (filter(scannedExtension)) {
				extensionsToCopy.push(webExtension);
			}
		}));
		if (extensionsToCopy.length) {
			await this.addToInstalledExtensions(extensionsToCopy, toProfileLocation);
		}
	}

	private async addToInstalledExtensions(webExtensions: IWebExtension[], profileLocation: URI): Promise<void> {
		await this.writeInstalledExtensions(profileLocation, installedExtensions => {
			// Remove the existing extension to avoid duplicates
			installedExtensions = installedExtensions.filter(installedExtension => webExtensions.some(extension => !areSameExtensions(installedExtension.identifier, extension.identifier)));
			installedExtensions.push(...webExtensions);
			return installedExtensions;
		});
	}

	private async scanInstalledExtensions(profileLocation: URI, scanOptions?: ScanOptions): Promise<IScannedExtension[]> {
		let installedExtensions = await this.readInstalledExtensions(profileLocation);

		// If current profile is not a default profile, then add the application extensions to the list
		if (!this.uriIdentityService.extUri.isEqual(profileLocation, this.userDataProfilesService.defaultProfile.extensionsResource)) {
			// Remove application extensions from the non default profile
			installedExtensions = installedExtensions.filter(i => !i.metadata?.isApplicationScoped);
			// Add application extensions from the default profile to the list
			const defaultProfileExtensions = await this.readInstalledExtensions(this.userDataProfilesService.defaultProfile.extensionsResource);
			installedExtensions.push(...defaultProfileExtensions.filter(i => i.metadata?.isApplicationScoped));
		}

		installedExtensions.sort((a, b) => a.identifier.id < b.identifier.id ? -1 : a.identifier.id > b.identifier.id ? 1 : semver.rcompare(a.version, b.version));
		const result = new Map<string, IScannedExtension>();
		for (const webExtension of installedExtensions) {
			const existing = result.get(webExtension.identifier.id.toLowerCase());
			if (existing && semver.gt(existing.manifest.version, webExtension.version)) {
				continue;
			}
			const extension = await this.toScannedExtension(webExtension, false);
			if (extension.isValid || !scanOptions?.skipInvalidExtensions) {
				result.set(extension.identifier.id.toLowerCase(), extension);
			} else {
				this.logService.info(`Skipping invalid installed extension ${webExtension.identifier.id}`);
			}
		}
		return [...result.values()];
	}

	private async toWebExtension(extensionLocation: URI, identifier?: IExtensionIdentifier, manifest?: IExtensionManifest, packageNLSUris?: Map<string, URI>, fallbackPackageNLSUri?: URI | ITranslations | null, readmeUri?: URI, changelogUri?: URI, metadata?: Metadata): Promise<IWebExtension> {
		if (!manifest) {
			try {
				manifest = await this.getExtensionManifest(extensionLocation);
			} catch (error) {
				throw new Error(`Error while fetching manifest from the location '${extensionLocation.toString()}'. ${getErrorMessage(error)}`);
			}
		}

		if (!this.extensionManifestPropertiesService.canExecuteOnWeb(manifest)) {
			throw new Error(localize('not a web extension', "Cannot add '{0}' because this extension is not a web extension.", manifest.displayName || manifest.name));
		}

		if (fallbackPackageNLSUri === undefined) {
			try {
				fallbackPackageNLSUri = joinPath(extensionLocation, 'package.nls.json');
				await this.extensionResourceLoaderService.readExtensionResource(fallbackPackageNLSUri);
			} catch (error) {
				fallbackPackageNLSUri = undefined;
			}
		}
		const defaultManifestTranslations: ITranslations | null | undefined = fallbackPackageNLSUri ? URI.isUri(fallbackPackageNLSUri) ? await this.getTranslations(fallbackPackageNLSUri) : fallbackPackageNLSUri : null;

		return {
			identifier: { id: getGalleryExtensionId(manifest.publisher, manifest.name), uuid: identifier?.uuid },
			version: manifest.version,
			location: extensionLocation,
			manifest,
			readmeUri,
			changelogUri,
			packageNLSUris,
			fallbackPackageNLSUri: URI.isUri(fallbackPackageNLSUri) ? fallbackPackageNLSUri : undefined,
			defaultManifestTranslations,
			metadata,
		};
	}

	private async toScannedExtension(webExtension: IWebExtension, isBuiltin: boolean, type: ExtensionType = ExtensionType.User): Promise<IScannedExtension> {
		const validations: [Severity, string][] = [];
		let manifest: IRelaxedExtensionManifest | undefined = webExtension.manifest;

		if (!manifest) {
			try {
				manifest = await this.getExtensionManifest(webExtension.location);
			} catch (error) {
				validations.push([Severity.Error, `Error while fetching manifest from the location '${webExtension.location}'. ${getErrorMessage(error)}`]);
			}
		}

		if (!manifest) {
			const [publisher, name] = webExtension.identifier.id.split('.');
			manifest = {
				name,
				publisher,
				version: webExtension.version,
				engines: { vscode: '*' },
			};
		}

		const packageNLSUri = webExtension.packageNLSUris?.get(Language.value().toLowerCase());
		const fallbackPackageNLS = webExtension.defaultManifestTranslations ?? webExtension.fallbackPackageNLSUri;

		if (packageNLSUri) {
			manifest = await this.translateManifest(manifest, packageNLSUri, fallbackPackageNLS);
		} else if (fallbackPackageNLS) {
			manifest = await this.translateManifest(manifest, fallbackPackageNLS);
		}

		const uuid = (<IGalleryMetadata | undefined>webExtension.metadata)?.id;

		validations.push(...validateExtensionManifest(this.productService.version, this.productService.date, webExtension.location, manifest, false));
		let isValid = true;
		for (const [severity, message] of validations) {
			if (severity === Severity.Error) {
				isValid = false;
				this.logService.error(message);
			}
		}

		if (manifest.enabledApiProposals) {
			manifest.enabledApiProposals = parseEnabledApiProposalNames([...manifest.enabledApiProposals]);
		}

		return {
			identifier: { id: webExtension.identifier.id, uuid: webExtension.identifier.uuid || uuid },
			location: webExtension.location,
			manifest,
			type,
			isBuiltin,
			readmeUrl: webExtension.readmeUri,
			changelogUrl: webExtension.changelogUri,
			metadata: webExtension.metadata,
			targetPlatform: TargetPlatform.WEB,
			validations,
			isValid,
			preRelease: !!webExtension.metadata?.preRelease,
		};
	}

	private async translateManifest(manifest: IExtensionManifest, nlsURL: ITranslations | URI, fallbackNLS?: ITranslations | URI): Promise<IRelaxedExtensionManifest> {
		try {
			const translations = URI.isUri(nlsURL) ? await this.getTranslations(nlsURL) : nlsURL;
			const fallbackTranslations = URI.isUri(fallbackNLS) ? await this.getTranslations(fallbackNLS) : fallbackNLS;
			if (translations) {
				manifest = localizeManifest(this.logService, manifest, translations, fallbackTranslations);
			}
		} catch (error) { /* ignore */ }
		return manifest;
	}

	private async getExtensionManifest(location: URI): Promise<IExtensionManifest> {
		const url = joinPath(location, 'package.json');
		const content = await this.extensionResourceLoaderService.readExtensionResource(url);
		return JSON.parse(content);
	}

	private async getTranslations(nlsUrl: URI): Promise<ITranslations | undefined> {
		try {
			const content = await this.extensionResourceLoaderService.readExtensionResource(nlsUrl);
			return JSON.parse(content);
		} catch (error) {
			this.logService.error(`Error while fetching translations of an extension`, nlsUrl.toString(), getErrorMessage(error));
		}
		return undefined;
	}

	private async readInstalledExtensions(profileLocation: URI): Promise<IWebExtension[]> {
		return this.withWebExtensions(profileLocation);
	}

	private writeInstalledExtensions(profileLocation: URI, updateFn: (extensions: IWebExtension[]) => IWebExtension[]): Promise<IWebExtension[]> {
		return this.withWebExtensions(profileLocation, updateFn);
	}

	private readSystemExtensionsCache(): Promise<IWebExtension[]> {
		return this.withWebExtensions(this.systemExtensionsCacheResource);
	}

	private writeSystemExtensionsCache(updateFn: (extensions: IWebExtension[]) => IWebExtension[]): Promise<IWebExtension[]> {
		return this.withWebExtensions(this.systemExtensionsCacheResource, updateFn);
	}

	private async withWebExtensions(file: URI | undefined, updateFn?: (extensions: IWebExtension[]) => IWebExtension[]): Promise<IWebExtension[]> {
		if (!file) {
			return [];
		}
		return this.getResourceAccessQueue(file).queue(async () => {
			let webExtensions: IWebExtension[] = [];

			// Read
			try {
				const content = await this.fileService.readFile(file);
				const storedWebExtensions: IStoredWebExtension[] = JSON.parse(content.value.toString());
				for (const e of storedWebExtensions) {
					if (!e.location || !e.identifier || !e.version) {
						this.logService.info('Ignoring invalid extension while scanning', storedWebExtensions);
						continue;
					}
					let packageNLSUris: Map<string, URI> | undefined;
					if (e.packageNLSUris) {
						packageNLSUris = new Map<string, URI>();
						Object.entries(e.packageNLSUris).forEach(([key, value]) => packageNLSUris!.set(key, URI.revive(value)));
					}

					webExtensions.push({
						identifier: e.identifier,
						version: e.version,
						location: URI.revive(e.location),
						manifest: e.manifest,
						readmeUri: URI.revive(e.readmeUri),
						changelogUri: URI.revive(e.changelogUri),
						packageNLSUris,
						fallbackPackageNLSUri: URI.revive(e.fallbackPackageNLSUri),
						defaultManifestTranslations: e.defaultManifestTranslations,
						packageNLSUri: URI.revive(e.packageNLSUri),
						metadata: e.metadata,
					});
				}

				try {
					webExtensions = await this.migrateWebExtensions(webExtensions, file);
				} catch (error) {
					this.logService.error(`Error while migrating scanned extensions in ${file.toString()}`, getErrorMessage(error));
				}

			} catch (error) {
				/* Ignore */
				if ((<FileOperationError>error).fileOperationResult !== FileOperationResult.FILE_NOT_FOUND) {
					this.logService.error(error);
				}
			}

			// Update
			if (updateFn) {
				await this.storeWebExtensions(webExtensions = updateFn(webExtensions), file);
			}

			return webExtensions;
		});
	}

	private async migrateWebExtensions(webExtensions: IWebExtension[], file: URI): Promise<IWebExtension[]> {
		let update = false;
		webExtensions = await Promise.all(webExtensions.map(async webExtension => {
			if (!webExtension.manifest) {
				try {
					webExtension.manifest = await this.getExtensionManifest(webExtension.location);
					update = true;
				} catch (error) {
					this.logService.error(`Error while updating manifest of an extension in ${file.toString()}`, webExtension.identifier.id, getErrorMessage(error));
				}
			}
			if (isUndefined(webExtension.defaultManifestTranslations)) {
				if (webExtension.fallbackPackageNLSUri) {
					try {
						const content = await this.extensionResourceLoaderService.readExtensionResource(webExtension.fallbackPackageNLSUri);
						webExtension.defaultManifestTranslations = JSON.parse(content);
						update = true;
					} catch (error) {
						this.logService.error(`Error while fetching default manifest translations of an extension`, webExtension.identifier.id, getErrorMessage(error));
					}
				} else {
					update = true;
					webExtension.defaultManifestTranslations = null;
				}
			}
			const migratedLocation = migratePlatformSpecificExtensionGalleryResourceURL(webExtension.location, TargetPlatform.WEB);
			if (migratedLocation) {
				update = true;
				webExtension.location = migratedLocation;
			}
			if (isUndefined(webExtension.metadata?.hasPreReleaseVersion) && webExtension.metadata?.preRelease) {
				update = true;
				webExtension.metadata.hasPreReleaseVersion = true;
			}
			return webExtension;
		}));
		if (update) {
			await this.storeWebExtensions(webExtensions, file);
		}
		return webExtensions;
	}

	private async storeWebExtensions(webExtensions: IWebExtension[], file: URI): Promise<void> {
		function toStringDictionary(dictionary: Map<string, URI> | undefined): IStringDictionary<UriComponents> | undefined {
			if (!dictionary) {
				return undefined;
			}
			const result: IStringDictionary<UriComponents> = Object.create(null);
			dictionary.forEach((value, key) => result[key] = value.toJSON());
			return result;
		}
		const storedWebExtensions: IStoredWebExtension[] = webExtensions.map(e => ({
			identifier: e.identifier,
			version: e.version,
			manifest: e.manifest,
			location: e.location.toJSON(),
			readmeUri: e.readmeUri?.toJSON(),
			changelogUri: e.changelogUri?.toJSON(),
			packageNLSUris: toStringDictionary(e.packageNLSUris),
			defaultManifestTranslations: e.defaultManifestTranslations,
			fallbackPackageNLSUri: e.fallbackPackageNLSUri?.toJSON(),
			metadata: e.metadata
		}));
		await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(storedWebExtensions)));
	}

	private getResourceAccessQueue(file: URI): Queue<IWebExtension[]> {
		let resourceQueue = this.resourcesAccessQueueMap.get(file);
		if (!resourceQueue) {
			this.resourcesAccessQueueMap.set(file, resourceQueue = new Queue<IWebExtension[]>());
		}
		return resourceQueue;
	}

}

if (isWeb) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.extensions.action.openInstalledWebExtensionsResource',
				title: localize2('openInstalledWebExtensionsResource', 'Open Installed Web Extensions Resource'),
				category: Categories.Developer,
				f1: true,
				precondition: IsWebContext
			});
		}
		run(serviceAccessor: ServicesAccessor): void {
			const editorService = serviceAccessor.get(IEditorService);
			const userDataProfileService = serviceAccessor.get(IUserDataProfileService);
			editorService.openEditor({ resource: userDataProfileService.currentProfile.extensionsResource });
		}
	});
}

registerSingleton(IWebExtensionsScannerService, WebExtensionsScannerService, InstantiationType.Delayed);
