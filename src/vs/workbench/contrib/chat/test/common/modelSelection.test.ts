/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../common/languageModels.js';
import { getVisibleLanguageModelsForTarget, ModelSelectionReason, resolveConfiguredModel, resolveInitialModelSelection, resolveModelIdentifier, resolveModelIdentifierFromCatalog, resolveModelIdentifierFromLanguageModels } from '../../common/modelSelection.js';

function model(identifier: string, metadataId = identifier, family = identifier, version = '1.0'): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier,
		metadata: {
			extension: new ExtensionIdentifier('test.extension'),
			id: metadataId,
			name: identifier,
			vendor: 'test',
			version,
			family,
			maxInputTokens: 1,
			maxOutputTokens: 1,
			isDefaultForLocation: {},
		},
	};
}

const first = model('target:first', 'first', 'first');
const second = model('target:second', 'second', 'second');

suite('ModelSelection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('filters model targets and respects model visibility', () => {
		const target = 'remote-host-copilot';
		const models = [
			{ id: 'visible', target },
			{ id: 'hidden', target },
			{ id: 'other-target', target: 'remote-other-copilot' },
		].map(({ id, target }) => {
			const entry = model(`${target}:${id}`, id);
			return { ...entry, metadata: { ...entry.metadata, targetChatSessionType: target } };
		});
		const hidden = new Set([`${target}:hidden`]);
		const languageModelsService = { isModelHidden: (identifier: string) => hidden.has(identifier) };
		const visible = getVisibleLanguageModelsForTarget(models, target, languageModelsService).map(model => model.metadata.id);
		hidden.clear();
		const unhidden = getVisibleLanguageModelsForTarget(models, target, languageModelsService).map(model => model.metadata.id);

		assert.deepStrictEqual({ visible, unhidden }, {
			visible: ['visible'],
			unhidden: ['visible', 'hidden'],
		});
	});

	test('resolves identifier availability states', () => {
		assert.deepStrictEqual([
			resolveModelIdentifier([first], undefined, false),
			resolveModelIdentifier([first], first.identifier, false),
			resolveModelIdentifier([], first.identifier, false),
			resolveModelIdentifier([], first.identifier, true),
		], [
			{ kind: 'notRequested' },
			{ kind: 'available', model: first },
			{ kind: 'pending', identifier: first.identifier },
			{ kind: 'unavailable', identifier: first.identifier },
		]);
	});

	test('uses shared vendor readiness for empty and live catalogs', () => {
		const resolvedVendors = new Set(['copilot', 'ollama']);
		const liveVendors = new Set<string>();
		const vendorResolution = {
			hasLiveModels: (vendor: string) => liveVendors.has(vendor),
			hasResolved: (vendor: string) => resolvedVendors.has(vendor),
		};
		const emptyCopilot = resolveModelIdentifierFromCatalog([], 'copilot/remembered', vendorResolution);
		const emptyByok = resolveModelIdentifierFromCatalog([], 'ollama/remembered', vendorResolution);
		liveVendors.add('copilot');
		const liveCopilot = resolveModelIdentifierFromCatalog([], 'copilot/remembered', vendorResolution);

		assert.deepStrictEqual({ emptyCopilot, emptyByok, liveCopilot }, {
			emptyCopilot: { kind: 'pending', identifier: 'copilot/remembered' },
			emptyByok: { kind: 'unavailable', identifier: 'ollama/remembered' },
			liveCopilot: { kind: 'unavailable', identifier: 'copilot/remembered' },
		});
	});

	test('shares configured, desired, pending, then fallback precedence', () => {
		assert.deepStrictEqual([
			resolveInitialModelSelection({ configuredModel: second, desiredModelResolution: { kind: 'available', model: first }, desiredReason: ModelSelectionReason.Remembered, fallbackModel: first, fallbackReason: ModelSelectionReason.FirstAvailable }),
			resolveInitialModelSelection({ configuredModel: undefined, desiredModelResolution: { kind: 'available', model: second }, desiredReason: ModelSelectionReason.Remembered, fallbackModel: first, fallbackReason: ModelSelectionReason.FirstAvailable }),
			resolveInitialModelSelection({ configuredModel: undefined, desiredModelResolution: { kind: 'pending', identifier: second.identifier }, desiredReason: ModelSelectionReason.Remembered, fallbackModel: first, fallbackReason: ModelSelectionReason.FirstAvailable }),
			resolveInitialModelSelection({ configuredModel: undefined, desiredModelResolution: { kind: 'unavailable', identifier: second.identifier }, desiredReason: ModelSelectionReason.Remembered, fallbackModel: first, fallbackReason: ModelSelectionReason.FirstAvailable }),
		], [
			{ kind: 'apply', model: second, reason: ModelSelectionReason.ConfiguredDefault },
			{ kind: 'apply', model: second, reason: ModelSelectionReason.Remembered },
			{ kind: 'pending', selection: { reference: second.identifier } },
			{ kind: 'apply', model: first, reason: ModelSelectionReason.FirstAvailable },
		]);
	});

	test('resolves configured model ids, families, and auto', () => {
		const auto = model('target:auto', 'auto');
		const opus45 = model('target:opus-4.5', 'claude-opus-4.5', 'opus', '4.5');
		const opus46 = model('target:opus-4.6', 'claude-opus-4.6', 'opus', '4.6');
		const opus410 = model('target:opus-4.10', 'claude-opus-4.10', 'opus', '4.10');
		const opusAlias = model('target:opus', 'opus', 'opus');

		assert.deepStrictEqual([
			resolveConfiguredModel(undefined, [auto]),
			resolveConfiguredModel('auto', [opus45, auto])?.identifier,
			resolveConfiguredModel('CLAUDE-OPUS-4.6', [opus45, opus46])?.identifier,
			resolveConfiguredModel('opus', [opus45, opus46, opus410])?.identifier,
			resolveConfiguredModel('opus', [opus410, opusAlias])?.identifier,
			resolveConfiguredModel('missing', [opus45]),
		], [
			undefined,
			auto.identifier,
			opus46.identifier,
			opus410.identifier,
			opusAlias.identifier,
			undefined,
		]);
	});
});
