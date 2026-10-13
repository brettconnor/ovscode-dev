/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage, isCancellationError } from '../../../base/common/errors.js';
import { Schemas } from '../../../base/common/network.js';
import { basename } from '../../../base/common/resources.js';
import { gt } from '../../../base/common/semver/semver.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IExtensionManagementService, ILocalExtension, InstallOptions } from './extensionManagement.js';
import { areSameExtensions, getExtensionId, getGalleryExtensionId } from './extensionManagementUtil.js';
import { ExtensionType, EXTENSION_CATEGORIES, IExtensionManifest } from '../../extensions/common/extensions.js';
import { ILogger } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';


const useId = localize('useId', "Make sure you use the full extension ID, including the publisher, e.g.: {0}", 'ms-dotnettools.csharp');

type InstallVSIXInfo = { vsix: URI; installOptions: InstallOptions };
export class ExtensionManagementCLI {

	constructor(
		protected readonly logger: ILogger,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IProductService private readonly productService: IProductService,
	) {
	}

	protected get location(): string | undefined {
		return undefined;
	}

	public async listExtensions(showVersions: boolean, category?: string, profileLocation?: URI): Promise<void> {
		let extensions = await this.extensionManagementService.getInstalled(ExtensionType.User, profileLocation);
		const categories = EXTENSION_CATEGORIES.map(c => c.toLowerCase());
		if (category && category !== '') {
			if (categories.indexOf(category.toLowerCase()) < 0) {
				this.logger.info('Invalid category please enter a valid category. To list valid categories run --category without a category specified');
				return;
			}
			extensions = extensions.filter(e => {
				if (e.manifest.categories) {
					const lowerCaseCategories: string[] = e.manifest.categories.map(c => c.toLowerCase());
					return lowerCaseCategories.indexOf(category.toLowerCase()) > -1;
				}
				return false;
			});
		} else if (category === '') {
			this.logger.info('Possible Categories: ');
			categories.forEach(category => {
				this.logger.info(category);
			});
			return;
		}
		if (this.location) {
			this.logger.info(localize('listFromLocation', "Extensions installed on {0}:", this.location));
		}

		extensions = extensions.sort((e1, e2) => e1.identifier.id.localeCompare(e2.identifier.id));
		let lastId: string | undefined = undefined;
		for (const extension of extensions) {
			if (lastId !== extension.identifier.id) {
				lastId = extension.identifier.id;
				this.logger.info(showVersions ? `${lastId}@${extension.manifest.version}` : lastId);
			}
		}
	}

	public async installExtensions(extensions: (string | URI)[], builtinExtensions: (string | URI)[], installOptions: InstallOptions, force: boolean): Promise<void> {
		const failed: string[] = [];
		if ([...extensions, ...builtinExtensions].some(extension => typeof extension === 'string')) {
			throw new Error(localize('marketplaceInstallRemoved', "Installing extensions by Marketplace ID is no longer supported. Install a local VSIX file instead."));
		}

		try {
			if (extensions.length) {
				this.logger.info(this.location ? localize('installingExtensionsOnLocation', "Installing extensions on {0}...", this.location) : localize('installingExtensions', "Installing extensions..."));
			}

			const installVSIXInfos: InstallVSIXInfo[] = [];
			for (const extension of extensions) {
				if (extension instanceof URI) {
					installVSIXInfos.push({ vsix: extension, installOptions });
				}
			}
			for (const extension of builtinExtensions) {
				if (extension instanceof URI) {
					installVSIXInfos.push({ vsix: extension, installOptions: { ...installOptions, isBuiltin: true } });
				}
			}

			const installed = await this.extensionManagementService.getInstalled(undefined, installOptions.profileLocation);

			if (installVSIXInfos.length) {
				await Promise.all(installVSIXInfos.map(async ({ vsix, installOptions }) => {
					try {
						await this.installVSIX(vsix, installOptions, force, installed);
					} catch (err) {
						this.logger.error(err);
						failed.push(vsix.toString());
					}
				}));
			}
		} catch (error) {
			this.logger.error(localize('error while installing extensions', "Error while installing extensions: {0}", getErrorMessage(error)));
			throw error;
		}

		if (failed.length) {
			throw new Error(localize('installation failed', "Failed Installing Extensions: {0}", failed.join(', ')));
		}
	}

	private async installVSIX(vsix: URI, installOptions: InstallOptions, force: boolean, installedExtensions: ILocalExtension[]): Promise<void> {

		const manifest = await this.extensionManagementService.getManifest(vsix);
		if (!manifest) {
			throw new Error('Invalid vsix');
		}

		const valid = await this.validateVSIX(manifest, force, installOptions.profileLocation, installedExtensions);
		if (valid) {
			try {
				await this.extensionManagementService.install(vsix, { ...installOptions, installGivenVersion: true });
				this.logger.info(localize('successVsixInstall', "Extension '{0}' was successfully installed.", basename(vsix)));
			} catch (error) {
				if (isCancellationError(error)) {
					this.logger.info(localize('cancelVsixInstall', "Cancelled installing extension '{0}'.", basename(vsix)));
				} else {
					throw error;
				}
			}
		}
	}

	protected validateExtensionKind(_manifest: IExtensionManifest): boolean {
		return true;
	}

	private async validateVSIX(manifest: IExtensionManifest, force: boolean, profileLocation: URI | undefined, installedExtensions: ILocalExtension[]): Promise<boolean> {
		const extensionIdentifier = { id: getGalleryExtensionId(manifest.publisher, manifest.name) };
		const existingExtension = installedExtensions.find(local => areSameExtensions(extensionIdentifier, local.identifier));

		if (existingExtension) {
			const builtinAutoUpdateMessage = this.validateBuiltinExtensionEnabledWithAutoUpdates(existingExtension);
			if (builtinAutoUpdateMessage) {
				this.logger.info(builtinAutoUpdateMessage);
				return false;
			}

			if (!force) {
				if (gt(existingExtension.manifest.version, manifest.version)) {
					this.logger.info(localize('forceDowngrade', "A newer version of extension '{0}' v{1} is already installed. Use '--force' option to downgrade to older version.", existingExtension.identifier.id, existingExtension.manifest.version, manifest.version));
					return false;
				}
			}
		}

		return this.validateExtensionKind(manifest);
	}

	public async uninstallExtensions(extensions: (string | URI)[], force: boolean, profileLocation?: URI): Promise<void> {
		const getId = async (extensionDescription: string | URI): Promise<string> => {
			if (extensionDescription instanceof URI) {
				const manifest = await this.extensionManagementService.getManifest(extensionDescription);
				return getExtensionId(manifest.publisher, manifest.name);
			}
			return extensionDescription;
		};

		const uninstalledExtensions: ILocalExtension[] = [];
		for (const extension of extensions) {
			const id = await getId(extension);
			const installed = await this.extensionManagementService.getInstalled(undefined, profileLocation);
			const extensionsToUninstall = installed.filter(e => areSameExtensions(e.identifier, { id }));
			if (!extensionsToUninstall.length) {
				throw new Error(`${this.notInstalled(id)}\n${useId}`);
			}
			if (extensionsToUninstall.some(e => e.type === ExtensionType.System)) {
				this.logger.info(localize('builtin', "Extension '{0}' is a Built-in extension and cannot be uninstalled", id));
				return;
			}
			if (!force && extensionsToUninstall.some(e => e.isBuiltin)) {
				this.logger.info(localize('forceUninstall', "Extension '{0}' is marked as a Built-in extension by user. Please use '--force' option to uninstall it.", id));
				return;
			}
			this.logger.info(localize('uninstalling', "Uninstalling {0}...", id));
			for (const extensionToUninstall of extensionsToUninstall) {
				await this.extensionManagementService.uninstall(extensionToUninstall, { profileLocation });
				uninstalledExtensions.push(extensionToUninstall);
			}

			if (this.location) {
				this.logger.info(localize('successUninstallFromLocation', "Extension '{0}' was successfully uninstalled from {1}!", id, this.location));
			} else {
				this.logger.info(localize('successUninstall', "Extension '{0}' was successfully uninstalled!", id));
			}

		}
	}

	public async locateExtension(extensions: string[]): Promise<void> {
		const installed = await this.extensionManagementService.getInstalled();
		extensions.forEach(e => {
			installed.forEach(i => {
				if (i.identifier.id === e) {
					if (i.location.scheme === Schemas.file) {
						this.logger.info(i.location.fsPath);
						return;
					}
				}
			});
		});
	}

	private notInstalled(id: string) {
		return this.location ? localize('notInstalleddOnLocation', "Extension '{0}' is not installed on {1}.", id, this.location) : localize('notInstalled', "Extension '{0}' is not installed.", id);
	}

	private validateBuiltinExtensionEnabledWithAutoUpdates(extension: ILocalExtension): string | undefined {
		if (extension.isBuiltin && this.productService.builtInExtensionsEnabledWithAutoUpdates.some(e => e.toLowerCase() === extension.identifier.id.toLowerCase()) && !extension.forceAutoUpdate) {
			return localize('builtinAutoUpdate', "Extension '{0}' is a built-in extension and not allowed to be updated in the current product quality '{1}'.", extension.identifier.id, this.productService.quality);
		}
		return undefined;
	}

}
