/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RemoteAuthorities } from '../../../base/common/network.js';
import { format2 } from '../../../base/common/strings.js';
import { URI } from '../../../base/common/uri.js';
import { TargetPlatform } from '../../extensions/common/extensions.js';
import { ExtensionGalleryResourceType, getExtensionGalleryManifestResourceUri, IExtensionGalleryManifest } from '../../extensionManagement/common/extensionGalleryManifest.js';

const WEB_EXTENSION_RESOURCE_END_POINT_SEGMENT = '/web-extension-resource/';

export function isWebExtensionResourceEndPoint(uri: URI): boolean {
	const serverRootPath = RemoteAuthorities.getServerRootPath();
	return uri.path.startsWith(serverRootPath) && uri.path.startsWith(WEB_EXTENSION_RESOURCE_END_POINT_SEGMENT, serverRootPath.length);
}

/** Resolve an extension's resource base URL independently from local extension-resource reading. */
export function getExtensionGalleryResourceURL(manifest: IExtensionGalleryManifest | null, { publisher, name, version, targetPlatform }: { publisher: string; name: string; version: string; targetPlatform?: TargetPlatform }): URI | undefined {
	const resourceUrlTemplate = manifest && getExtensionGalleryManifestResourceUri(manifest, ExtensionGalleryResourceType.ExtensionResourceUri);
	if (!resourceUrlTemplate) {
		return undefined;
	}

	const uri = URI.parse(format2(resourceUrlTemplate, {
		publisher,
		name,
		version: targetPlatform !== undefined
			&& targetPlatform !== TargetPlatform.UNDEFINED
			&& targetPlatform !== TargetPlatform.UNKNOWN
			&& targetPlatform !== TargetPlatform.UNIVERSAL
			? `${version}+${targetPlatform}`
			: version,
		path: 'extension'
	}));

	return isWebExtensionResourceEndPoint(uri)
		? uri.with({ scheme: RemoteAuthorities.getPreferredWebSchema() })
		: uri;
}
