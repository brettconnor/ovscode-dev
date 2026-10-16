/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ExtensionState } from '../../common/extensions.js';
import { Extension } from '../../browser/extensionsWorkbenchService.js';
import { ILocalExtension } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionType, IExtensionManifest, TargetPlatform } from '../../../../../platform/extensions/common/extensions.js';
import { URI } from '../../../../../base/common/uri.js';
import { getGalleryExtensionId } from '../../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IResourceExtension } from '../../../../services/extensionManagement/common/extensionManagement.js';

suite('Extension Test', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;

	setup(() => {
		instantiationService = disposables.add(new TestInstantiationService());
	});

	test('preserves installed extension identity and manifest metadata', () => {
		const local = aLocalExtension();
		const extension = instantiationService.createInstance(Extension, () => ExtensionState.Installed, () => undefined, undefined, local, undefined);

		assert.strictEqual(extension.identifier.id, local.identifier.id);
		assert.strictEqual(extension.identifier.uuid, local.identifier.uuid);
		assert.strictEqual(extension.name, local.manifest.name);
		assert.strictEqual(extension.version, local.manifest.version);
	});

	test('preserves workspace resource extension identity and manifest metadata', () => {
		const resourceExtension = {
			type: 'resource',
			identifier: { id: 'pub.ext', uuid: 'stored-resource-id' },
			location: URI.file('/extensions/pub.ext'),
			manifest: { publisher: 'pub', name: 'ext', version: '1.0.0', displayName: 'Extension' } as IExtensionManifest,
		} as IResourceExtension;
		const extension = instantiationService.createInstance(Extension, () => ExtensionState.Installed, () => undefined, undefined, undefined, { resourceExtension, isWorkspaceScoped: true });

		assert.strictEqual(extension.identifier.id, resourceExtension.identifier.id);
		assert.strictEqual(extension.identifier.uuid, resourceExtension.identifier.uuid);
		assert.strictEqual(extension.name, resourceExtension.manifest.name);
		assert.strictEqual(extension.isWorkspaceScoped, true);
	});

	function aLocalExtension(): ILocalExtension {
		const manifest: IExtensionManifest = { name: 'ext', publisher: 'pub', version: '1.0.0', displayName: 'Extension', engines: { vscode: '*' } };
		return {
			type: ExtensionType.User,
			location: URI.file('/extensions/pub.ext'),
			identifier: { id: getGalleryExtensionId(manifest.publisher, manifest.name), uuid: 'stored-gallery-id' },
			targetPlatform: TargetPlatform.UNDEFINED,
			manifest,
		} as ILocalExtension;
	}
});
