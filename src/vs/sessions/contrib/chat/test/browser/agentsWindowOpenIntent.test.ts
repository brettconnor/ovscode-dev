/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getAgentsWindowWorkspaceArgumentKind } from '../../browser/agentsWindowOpenIntent.js';

suite('Agents Window open intent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies the original workspace argument without exposing resource identifiers', () => {
		assert.deepStrictEqual([
			undefined,
			URI.file('/private/project'),
			URI.parse('vscode-remote://dev-container+invalid/private/project'),
			URI.parse('vscode-remote://ssh-remote+private-host/private/project'),
			URI.parse('vscode-vfs://github/private/repository'),
		].map(getAgentsWindowWorkspaceArgumentKind), ['none', 'local', 'other', 'remote', 'other']);
	});


});
