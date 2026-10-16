/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IProductService } from '../../product/common/productService.js';
import { TargetPlatform } from '../../extensions/common/extensions.js';
import { ILogService } from '../../log/common/log.js';
import { isWebExtensionResourceEndPoint } from './extensionGalleryResource.js';

export const IExtensionResourceLoaderService = createDecorator<IExtensionResourceLoaderService>('extensionResourceLoaderService');

/**
 * A service useful for reading resources from within extensions.
 */
export interface IExtensionResourceLoaderService {
	readonly _serviceBrand: undefined;

	/**
	 * Read a certain resource within an extension.
	 */
	readExtensionResource(uri: URI): Promise<string>;

}

export function migratePlatformSpecificExtensionGalleryResourceURL(resource: URI, targetPlatform: TargetPlatform): URI | undefined {
	if (resource.query !== `target=${targetPlatform}`) {
		return undefined;
	}
	const paths = resource.path.split('/');
	if (!paths[3]) {
		return undefined;
	}
	paths[3] = `${paths[3]}+${targetPlatform}`;
	return resource.with({ query: null, path: paths.join('/') });
}

export abstract class AbstractExtensionResourceLoaderService implements IExtensionResourceLoaderService {

	readonly _serviceBrand: undefined;

	private readonly _extensionGalleryAuthority: string | undefined;

	constructor(
		protected readonly _fileService: IFileService,
		private readonly _productService: IProductService,
		protected readonly _logService: ILogService,
	) {
		const resourceUrlTemplate = this._productService.extensionsGallery?.resourceUrlTemplate;
		this._extensionGalleryAuthority = resourceUrlTemplate ? this._getExtensionGalleryAuthority(URI.parse(resourceUrlTemplate)) : undefined;
	}

	public abstract readExtensionResource(uri: URI): Promise<string>;

	protected async isExtensionGalleryResource(uri: URI): Promise<boolean> {
		return !!this._extensionGalleryAuthority && this._extensionGalleryAuthority === this._getExtensionGalleryAuthority(uri);
	}

	protected getExtensionGalleryRequestHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'X-Client-Version': this._productService.version
		};
		return headers;
	}

	private _getExtensionGalleryAuthority(uri: URI): string | undefined {
		if (isWebExtensionResourceEndPoint(uri)) {
			return uri.authority;
		}
		const index = uri.authority.indexOf('.');
		return index !== -1 ? uri.authority.substring(index + 1) : undefined;
	}

}
