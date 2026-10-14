/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const enum ExtensionGalleryResourceType {
	ExtensionResourceUri = 'ExtensionResourceUriTemplate',
}

export type ExtensionGalleryManifestResource = {
	readonly id: string;
	readonly type: string;
};

export interface IExtensionGalleryManifest {
	readonly version: string;
	readonly resources: readonly ExtensionGalleryManifestResource[];
	readonly capabilities?: {
		readonly extensions?: {
			readonly includePublicExtensions?: boolean;
			readonly includePrivateExtensions?: boolean;
		};
	};
}

export const enum ExtensionGalleryManifestStatus {
	Available = 'available',
	Unavailable = 'unavailable'
}

export const IExtensionGalleryManifestService = createDecorator<IExtensionGalleryManifestService>('IExtensionGalleryManifestService');

export interface IExtensionGalleryManifestService {
	readonly _serviceBrand: undefined;

	readonly extensionGalleryManifestStatus: ExtensionGalleryManifestStatus;
	readonly onDidChangeExtensionGalleryManifestStatus: Event<ExtensionGalleryManifestStatus>;
	readonly onDidChangeExtensionGalleryManifest: Event<IExtensionGalleryManifest | null>;
	getExtensionGalleryManifest(): Promise<IExtensionGalleryManifest | null>;
}

export function getExtensionGalleryManifestResourceUri(manifest: IExtensionGalleryManifest, type: string): string | undefined {
	const [name, version] = type.split('/');
	for (const resource of manifest.resources) {
		const [r, v] = resource.type.split('/');
		if (r !== name) {
			continue;
		}
		if (!version || v === version) {
			return resource.id;
		}
		break;
	}
	return undefined;
}
