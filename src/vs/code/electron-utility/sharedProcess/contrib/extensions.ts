/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ExtensionStorageService } from '../../../../platform/extensionManagement/common/extensionStorage.js';
import { INativeServerExtensionManagementService } from '../../../../platform/extensionManagement/node/extensionManagementService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';

export class ExtensionsContributions extends Disposable {
	constructor(
		@INativeServerExtensionManagementService private readonly extensionManagementService: INativeServerExtensionManagementService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		extensionManagementService.cleanUp().catch(error => logService.error('Error while cleaning up extensions', error));
		ExtensionStorageService.removeOutdatedExtensionVersions(extensionManagementService, storageService);
	}
}
