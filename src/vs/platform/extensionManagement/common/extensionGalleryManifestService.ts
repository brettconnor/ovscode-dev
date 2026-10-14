/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IProductService } from '../../product/common/productService.js';
import { ExtensionGalleryResourceType, IExtensionGalleryManifest, IExtensionGalleryManifestService, ExtensionGalleryManifestStatus } from './extensionGalleryManifest.js';

type ExtensionGalleryConfig = {
	readonly serviceUrl: string;
	readonly resourceUrlTemplate?: string;
};

export class ExtensionGalleryManifestService extends Disposable implements IExtensionGalleryManifestService {

	readonly _serviceBrand: undefined;
	readonly onDidChangeExtensionGalleryManifest = Event.None;
	readonly onDidChangeExtensionGalleryManifestStatus = Event.None;

	get extensionGalleryManifestStatus(): ExtensionGalleryManifestStatus {
		return !!this.productService.extensionsGallery?.serviceUrl ? ExtensionGalleryManifestStatus.Available : ExtensionGalleryManifestStatus.Unavailable;
	}

	constructor(
		@IProductService protected readonly productService: IProductService,
	) {
		super();
	}

	async getExtensionGalleryManifest(): Promise<IExtensionGalleryManifest | null> {
		const extensionsGallery = this.productService.extensionsGallery as ExtensionGalleryConfig | undefined;
		if (!extensionsGallery?.serviceUrl) {
			return null;
		}

		const resources = extensionsGallery.resourceUrlTemplate ? [{
			id: extensionsGallery.resourceUrlTemplate,
			type: ExtensionGalleryResourceType.ExtensionResourceUri
		}] : [];

		return { version: '', resources };
	}
}
