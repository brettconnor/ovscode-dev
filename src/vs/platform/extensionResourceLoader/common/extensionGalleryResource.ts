/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RemoteAuthorities } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';

const WEB_EXTENSION_RESOURCE_END_POINT_SEGMENT = '/web-extension-resource/';

export function isWebExtensionResourceEndPoint(uri: URI): boolean {
	const serverRootPath = RemoteAuthorities.getServerRootPath();
	return uri.path.startsWith(serverRootPath) && uri.path.startsWith(WEB_EXTENSION_RESOURCE_END_POINT_SEGMENT, serverRootPath.length);
}
