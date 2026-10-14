/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { IStringDictionary } from '../../../base/common/collections.js';
import { isBoolean, isNumber, isString } from '../../../base/common/types.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { isEngineValid } from '../../extensions/common/extensionValidator.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, IRequestService } from '../../request/common/request.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { ExtensionRequestsTimeoutConfigKey, EXTENSION_IDENTIFIER_REGEX, IExtensionGalleryService, IExtensionsControlManifest, IDeprecationInfo, MaliciousExtensionInfo } from './extensionManagement.js';

interface IRawExtensionsControlManifest {
	malicious: string[];
	learnMoreLinks?: IStringDictionary<string>;
	migrateToPreRelease?: IStringDictionary<{
		id: string;
		displayName: string;
		migrateStorage?: boolean;
		engine?: string;
	}>;
	deprecated?: IStringDictionary<boolean | {
		disallowInstall?: boolean;
		extension?: {
			id: string;
			displayName: string;
		};
		settings?: string[];
		additionalInfo?: string;
	}>;
}

export abstract class AbstractExtensionGalleryService implements IExtensionGalleryService {

	declare readonly _serviceBrand: undefined;

	private readonly extensionsControlUrl: string | undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IProductService private readonly productService: IProductService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		this.extensionsControlUrl = productService.extensionsGallery?.controlUrl;
	}

	async getExtensionsControlManifest(): Promise<IExtensionsControlManifest> {
		if (!this.extensionsControlUrl) {
			return { malicious: [], deprecated: {} };
		}

		const context = await this.requestService.request({
			type: 'GET',
			url: this.extensionsControlUrl,
			timeout: this.getRequestTimeout(),
			callSite: 'extensionGalleryService.getExtensionsControlManifest'
		}, CancellationToken.None);

		if (context.res.statusCode !== 200) {
			throw new Error('Could not get extensions report.');
		}

		const result = await asJson<IRawExtensionsControlManifest>(context);
		const malicious: MaliciousExtensionInfo[] = [];
		const deprecated: IStringDictionary<IDeprecationInfo> = {};
		if (result) {
			for (const id of result.malicious) {
				if (!isString(id)) {
					continue;
				}
				const publisherOrExtension = EXTENSION_IDENTIFIER_REGEX.test(id) ? { id } : id;
				malicious.push({ extensionOrPublisher: publisherOrExtension, learnMoreLink: result.learnMoreLinks?.[id] });
			}
			if (result.migrateToPreRelease) {
				for (const [unsupportedPreReleaseExtensionId, preReleaseExtensionInfo] of Object.entries(result.migrateToPreRelease)) {
					if (!preReleaseExtensionInfo.engine || isEngineValid(preReleaseExtensionInfo.engine, this.productService.version, this.productService.date)) {
						deprecated[unsupportedPreReleaseExtensionId.toLowerCase()] = {
							disallowInstall: true,
							extension: {
								id: preReleaseExtensionInfo.id,
								displayName: preReleaseExtensionInfo.displayName,
								autoMigrate: { storage: !!preReleaseExtensionInfo.migrateStorage },
								preRelease: true
							}
						};
					}
				}
			}
			if (result.deprecated) {
				for (const [deprecatedExtensionId, deprecationInfo] of Object.entries(result.deprecated)) {
					if (deprecationInfo) {
						deprecated[deprecatedExtensionId.toLowerCase()] = isBoolean(deprecationInfo) ? {} : deprecationInfo;
					}
				}
			}
		}

		return { malicious, deprecated };
	}

	private getRequestTimeout(): number {
		const configuredTimeout = this.configurationService.getValue<number>(ExtensionRequestsTimeoutConfigKey);
		return isNumber(configuredTimeout) && configuredTimeout >= 0 ? configuredTimeout : 60_000;
	}
}

export class ExtensionGalleryService extends AbstractExtensionGalleryService {
	constructor(
		@IRequestService requestService: IRequestService,
		@IProductService productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(requestService, productService, configurationService);
	}
}

registerSingleton(IExtensionGalleryService, ExtensionGalleryService, InstantiationType.Delayed);
