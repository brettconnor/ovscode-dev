/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ConfigurationMigration, Extensions as WorkbenchConfigurationExtensions, IConfigurationMigrationRegistry } from '../../../../common/configuration.js';
import { ChatConfiguration } from '../../common/constants.js';
import { chatProgressConfigurationProperties } from '../../browser/chatProgressConfiguration.js';

const migrations = Registry.as<IConfigurationMigrationRegistry & { readonly migrations: readonly ConfigurationMigration[] }>(WorkbenchConfigurationExtensions.ConfigurationMigration).migrations;
const legacyProgressVerbosityMigration = migrations.find(migration => migration.key === ChatConfiguration.PersistentProgressVerbosity);
const persistentProgressSetting = chatProgressConfigurationProperties[ChatConfiguration.PersistentProgress];

suite('Chat configuration', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('defaults persistent progress to Draw as an experimental setting', () => {
		assert.deepStrictEqual({
			type: persistentProgressSetting.type,
			default: persistentProgressSetting.default,
			tags: persistentProgressSetting.tags,
			experiment: persistentProgressSetting.experiment,
		}, {
			type: 'string',
			default: 'draw',
			tags: ['experimental'],
			experiment: { mode: 'auto' },
		});
	});

	test('defines persistent progress animations and a separate verbosity setting', () => {
		const setting = chatProgressConfigurationProperties[ChatConfiguration.PersistentProgress];
		assert.deepStrictEqual({
			settings: Object.keys(chatProgressConfigurationProperties),
			type: setting.type,
			default: setting.default,
			values: setting.enum,
			labels: setting.enumItemLabels,
			descriptions: setting.enumDescriptions.length,
		}, {
			settings: ['chat.experimental.persistentProgress', 'chat.experimental.persistentProgressVerbosity'],
			type: 'string',
			default: 'draw',
			values: ['off', 'weave', 'draw', 'orbit', 'accordion', 'dial'],
			labels: ['Off', 'Weave', 'Draw', 'Orbit and Lock', 'Accordion', 'Dial Rotation'],
			descriptions: 6,
		});
	});

	test('defaults persistent progress verbosity to Compact tool previews', () => {
		const setting = chatProgressConfigurationProperties[ChatConfiguration.PersistentProgressVerbosity];
		assert.deepStrictEqual({
			type: setting.type,
			default: setting.default,
			values: setting.enum,
			labels: setting.enumItemLabels,
			descriptions: setting.enumDescriptions.length,
			tags: setting.tags,
		}, {
			type: 'string',
			default: 'compact',
			values: ['verbose', 'compact'],
			labels: ['Verbose', 'Compact'],
			descriptions: 2,
			tags: ['experimental'],
		});
	});

	test('migrates stored notVerbose progress verbosity to compact', async () => {
		assert.deepStrictEqual(await legacyProgressVerbosityMigration?.migrateFn('notVerbose', () => undefined), { value: 'compact' });
	});

	test('does not migrate explicit progress verbosity or absent settings', async () => {
		assert.deepStrictEqual(await Promise.all(
			['verbose', 'compact', undefined, 'unsupported'].map(value => legacyProgressVerbosityMigration?.migrateFn(value, () => undefined)),
		), [[], [], [], []]);
	});


});
