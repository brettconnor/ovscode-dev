/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CustomizationHarnessServiceBase, createVSCodeHarnessDescriptor, IHarnessDescriptor } from '../../common/customizationHarnessService.js';
import { PromptsType, Target } from '../../common/promptSyntax/promptTypes.js';
import { ICustomAgent, IPromptsService, PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { SessionType } from '../../common/chatSessionsService.js';
import { MockPromptsService } from './promptSyntax/service/mockPromptsService.js';

suite('CustomizationHarnessService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(...harnesses: IHarnessDescriptor[]): CustomizationHarnessServiceBase {
		if (harnesses.length === 0) {
			harnesses = [createVSCodeHarnessDescriptor()];
		}
		const promptsService: IPromptsService = new MockPromptsService();
		const service = new CustomizationHarnessServiceBase(harnesses, harnesses[0].id, promptsService);
		store.add(service);
		return service;
	}

	const testSessionType1 = 'test-session-type1';
	//const testSessionType2 = 'test-session-type2';
	const testSessionResource1 = URI.parse('test-session-type1://session1');
	const testSessionResource2 = URI.parse('test-session-type2://session2');

	suite('getSlashCommands', () => {
		function createSlashCommandService(uri: URI, promptsService: IPromptsService): CustomizationHarnessServiceBase {
			const testSessionType = 'test-session-type';
			const emitter = new Emitter<void>();
			store.add(emitter);
			const service = new CustomizationHarnessServiceBase([{
				id: testSessionType,
				label: 'Test Extension',
				icon: ThemeIcon.fromId('extensions'),
				itemProvider: {
					onDidChange: emitter.event,
					provideChatSessionCustomizations: async () => [
						{ uri, type: PromptsType.skill, source: 'local', name: 'init', enabled: true, extensionId: undefined, pluginUri: undefined, userInvocable: undefined },
					],
				},
			}], testSessionType, promptsService);
			store.add(service);
			return service;
		}

		test('uses the active harness provider for prompt and skill items', async () => {


			const testSessionType = 'test-session-type';
			const testSessionResource = URI.parse('test-session-type://session');

			const emitter = new Emitter<void>();
			store.add(emitter);
			const service = createService({
				id: testSessionType,
				label: 'Test Extension',
				icon: ThemeIcon.fromId('extensions'),
				itemProvider: {
					onDidChange: emitter.event,
					provideChatSessionCustomizations: async (_sessionResource: URI, _token: CancellationToken) => [
						{ uri: URI.parse('file:///workspace/.test/prompts/fix.prompt.md'), type: PromptsType.prompt, source: 'local', name: 'fix', description: 'Fix something', extensionId: undefined, pluginUri: undefined, userInvocable: undefined },
						{ uri: URI.parse('file:///workspace/.test/skills/lint/SKILL.md'), type: PromptsType.skill, source: 'local', name: 'lint', description: 'Lint skill', extensionId: undefined, pluginUri: undefined, userInvocable: undefined },
						{ uri: URI.parse('file:///workspace/.test/instructions/rule.instructions.md'), type: PromptsType.instructions, source: 'local', name: 'rule', description: 'Ignore me', extensionId: undefined, pluginUri: undefined, userInvocable: undefined },
						{ uri: URI.parse('file:///workspace/.test/skills/disabled/SKILL.md'), type: PromptsType.skill, source: 'local', name: 'disabled', enabled: false, extensionId: undefined, pluginUri: undefined, userInvocable: undefined },
					],
				},
			});

			const commands = await service.getSlashCommands(testSessionResource, CancellationToken.None);
			assert.deepStrictEqual(commands.map(command => ({ name: command.name, type: command.type })), [
				{ name: 'fix', type: PromptsType.prompt },
				{ name: 'lint', type: PromptsType.skill },
			]);
		});

		test('uses plugin label for plugin-scoped commands when provider plugin URI is a pinned SHA path', async () => {
			const testSessionType = 'test-session-type';
			const testSessionResource = URI.parse('test-session-type://session');
			const pluginUri = URI.parse('file:///cache/agentPlugins/github/datadog/sha_b003fcad48c3a935ffe04b6218f5cf58fe2b6760');

			const emitter = new Emitter<void>();
			store.add(emitter);
			const service = createService({
				id: testSessionType,
				label: 'Test Extension',
				icon: ThemeIcon.fromId('extensions'),
				itemProvider: {
					onDidChange: emitter.event,
					provideChatSessionCustomizations: async (_sessionResource: URI, _token: CancellationToken) => [
						{ uri: URI.joinPath(pluginUri, 'skills', 'ddsetup', 'SKILL.md'), type: PromptsType.skill, source: 'plugin', name: 'ddsetup', description: 'Set up Datadog', extensionId: undefined, pluginUri, pluginLabel: 'datadog', userInvocable: undefined },
					],
				},
			});

			const commands = await service.getSlashCommands(testSessionResource, CancellationToken.None);
			assert.deepStrictEqual(commands.map(command => ({ name: command.name, description: command.description, type: command.type })), [
				{ name: 'datadog:ddsetup', description: 'Set up Datadog', type: PromptsType.skill },
			]);
		});

		test('falls back to promptsService when the active harness has no provider', async () => {

			const testSessionType = 'test-session-type';
			const testSessionResource = URI.parse('test-session-type://session');
			const otherSessionResource = URI.parse('other-session-type://session');
			const promptsService = new class extends MockPromptsService {
				override async getPromptSlashCommands() {
					return [
						{ uri: URI.parse('file:///workspace/.github/prompts/explain.prompt.md'), name: 'explain', type: PromptsType.prompt, storage: PromptsStorage.local, userInvocable: false, sessionTypes: [testSessionType] },
						{ uri: URI.parse('file:///workspace/.github/skills/review/SKILL.md'), name: 'review', type: PromptsType.skill, storage: PromptsStorage.user, userInvocable: true },
					];
				}
				override isValidSlashCommandName() { return true; }
			};
			const service = new CustomizationHarnessServiceBase([createVSCodeHarnessDescriptor()], SessionType.Local, promptsService);
			store.add(service);
			{
				const commands = await service.getSlashCommands(testSessionResource, CancellationToken.None);
				assert.deepStrictEqual(commands.map(command => ({ name: command.name, type: command.type, userInvocable: command.userInvocable, sessionTypes: command.sessionTypes })), [
					{ name: 'explain', type: PromptsType.prompt, userInvocable: false, sessionTypes: [testSessionType] },
					{ name: 'review', type: PromptsType.skill, userInvocable: true, sessionTypes: undefined },
				]);
			}
			{
				const commands = await service.getSlashCommands(otherSessionResource, CancellationToken.None);
				assert.deepStrictEqual(commands.map(command => ({ name: command.name, type: command.type, userInvocable: command.userInvocable, sessionTypes: command.sessionTypes })), [
					{ name: 'review', type: PromptsType.skill, userInvocable: true, sessionTypes: undefined },
				]);
			}
		});

		test('propagates cancellation while resolving file-backed command content', async () => {
			const promptsService = new class extends MockPromptsService {
				override async parseNew(): Promise<never> {
					throw new CancellationError();
				}
			};
			const service = createSlashCommandService(URI.file('/workspace/.test/skills/init/SKILL.md'), promptsService);

			await assert.rejects(
				service.resolvePromptSlashCommand('init', URI.parse('test-session-type://session'), CancellationToken.None),
				error => error instanceof CancellationError
			);
		});
	});

	suite('getCustomAgents', () => {
		const createAgent = (name: string, path: string, sessionTypes: readonly string[] | undefined, enabled: boolean): ICustomAgent => {
			const uri = URI.parse(path);
			return {
				id: uri.toString(),
				uri,
				name,
				target: Target.GitHubCopilot,
				visibility: { userInvocable: true, agentInvocable: true },
				agentInstructions: { content: '', toolReferences: [] },
				source: { storage: PromptsStorage.local },
				sessionTypes,
				enabled,
			};
		};

		test('falls back to promptsService and filters by session type', async () => {
			const promptsService = new MockPromptsService();
			promptsService.setCustomModes([
				createAgent('matching', 'file:///workspace/.github/agents/matching.agent.md', [testSessionType1], true),
				createAgent('global', 'file:///workspace/.github/agents/global.agent.md', undefined, true),
				createAgent('other', 'file:///workspace/.github/agents/other.agent.md', ['other-session'], true),
			]);
			const service = new CustomizationHarnessServiceBase([createVSCodeHarnessDescriptor()], SessionType.Local, promptsService);
			store.add(service);

			const agents = await service.getCustomAgents(testSessionResource1, CancellationToken.None);
			assert.deepStrictEqual(agents.map(agent => agent.name), ['matching', 'global']);
		});

		test('uses provider item URIs to scope resolved custom agents', async () => {

			const promptsService = new MockPromptsService();
			promptsService.setCustomModes([
				createAgent('selected', 'file:///workspace/.test/agents/selected.agent.md', undefined, true),
				createAgent('not-selected', 'file:///workspace/.test/agents/not-selected.agent.md', undefined, false),
			]);

			const emitter = new Emitter<void>();
			store.add(emitter);
			const service = new CustomizationHarnessServiceBase([{
				id: testSessionType1,
				label: 'Test Extension',
				icon: ThemeIcon.fromId('extensions'),
				itemProvider: {
					onDidChange: emitter.event,
					provideChatSessionCustomizations: async (_sessionResource: URI, _token: CancellationToken) => [
						{ uri: URI.parse('file:///workspace/.test/agents/enabled.agent.md'), type: PromptsType.agent, source: 'local', name: 'enabled', enabled: true, extensionId: undefined, pluginUri: undefined, userInvocable: undefined },
						{ uri: URI.parse('file:///workspace/.test/agents/disabled.agent.md'), type: PromptsType.agent, source: 'local', name: 'disabled', enabled: false, extensionId: undefined, pluginUri: undefined, userInvocable: undefined },
					],
				},
			}], testSessionType1, promptsService);
			store.add(service);
			{
				const agents = (await service.getCustomAgents(testSessionResource1, CancellationToken.None));
				assert.deepStrictEqual(agents.map(agent => [agent.name, agent.enabled]), [['enabled', true], ['disabled', false]]);
			}
			{
				const agents = (await service.getCustomAgents(testSessionResource2, CancellationToken.None));
				assert.deepStrictEqual(agents.map(agent => [agent.name, agent.enabled]), [['selected', true], ['not-selected', false]]);
			}
		});
	});

});
