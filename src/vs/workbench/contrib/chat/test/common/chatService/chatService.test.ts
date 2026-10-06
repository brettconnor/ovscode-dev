/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { constObservable, ISettableObservable, observableValue, transaction } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mockObject } from '../../../../../../base/test/common/mock.js';
import { assertSnapshot } from '../../../../../../base/test/common/snapshot.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../../base/test/common/timeTravelScheduler.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService, NullTelemetryServiceShape } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { ClassifiedEvent, IGDPRProperty, OmitMetadata, StrictPropertyCheck } from '../../../../../../platform/telemetry/common/gdprTypings.js';
import { IUserDataProfilesService, toUserDataProfile } from '../../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../../platform/workspace/test/common/testWorkspace.js';
import { IWorkbenchAssignmentService } from '../../../../../services/assignment/common/assignmentService.js';
import { NullWorkbenchAssignmentService } from '../../../../../services/assignment/test/common/nullAssignmentService.js';
import { IChatEntitlementService } from '../../../../../services/chat/common/chatEntitlementService.js';
import { IExtensionService, nullExtensionDescription } from '../../../../../services/extensions/common/extensions.js';
import { ILifecycleService } from '../../../../../services/lifecycle/common/lifecycle.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { IWorkspaceEditingService } from '../../../../../services/workspaces/common/workspaceEditing.js';
import { InMemoryTestFileService, mock, TestChatEntitlementService, TestContextService, TestExtensionService, TestStorageService } from '../../../../../test/common/workbenchTestServices.js';
import { IMcpService } from '../../../../mcp/common/mcpTypes.js';
import { TestMcpService } from '../../../../mcp/test/common/testMcpService.js';
import { ChatPasteAttachmentMetadata, IChatRequestVariableEntry, toPasteVariableEntry } from '../../../common/attachments/chatVariableEntries.js';
import { IChatVariablesService } from '../../../common/attachments/chatVariables.js';
import { getCustomizationMigrationHintDismissedStorageKey } from '../../../common/aiCustomizationWorkspaceService.js';
import { IChatDebugService } from '../../../common/chatDebugService.js';
import { ChatDebugServiceImpl } from '../../../common/chatDebugServiceImpl.js';
import { ChatRequestQueueKind, ChatSendResult, IChatFollowup, IChatModelReference, IChatProgress, IChatService, IChatUserActionEvent, ResponseModelState } from '../../../common/chatService/chatService.js';
import { backfillTransferredModel, backfillRestoredPickerState, ChatService } from '../../../common/chatService/chatServiceImpl.js';
import { ChatServiceTelemetry } from '../../../common/chatService/chatServiceTelemetry.js';
import { ChatRequestOriginKind } from '../../../common/chatRequestOrigin.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind, CustomizationMigrationHintMode } from '../../../common/constants.js';
import { ChatEditingSessionState, IChatEditingService, IChatEditingSession, IModifiedFileEntry, ModifiedFileEntryState } from '../../../common/editing/chatEditingService.js';
import { ILanguageModelChatMetadata, ILanguageModelsService } from '../../../common/languageModels.js';
import { ChatModel, IChatModel, ISerializableChatData, ISerializableChatModelInputState } from '../../../common/model/chatModel.js';
import { ChatSessionOperationLog } from '../../../common/model/chatSessionOperationLog.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';
import { ChatViewModel, isPendingDividerVM, isRequestVM, isResponseVM } from '../../../common/model/chatViewModel.js';
import { ChatAgentService, IChatAgent, IChatAgentData, IChatAgentImplementation, IChatAgentService } from '../../../common/participants/chatAgents.js';
import { ChatSlashCommandService, IChatSlashCommandService } from '../../../common/participants/chatSlashCommands.js';
import { IConfiguredHooksInfo, IPromptsService } from '../../../common/promptSyntax/service/promptsService.js';
import { CustomizationMigrationType, ICustomizationMigrationService } from '../../../common/promptSyntax/service/customizationMigrationService.js';
import { ICustomizationMigrationTelemetryService } from '../../../common/promptSyntax/service/customizationMigrationTelemetryService.js';
import { ILanguageModelToolsService } from '../../../common/tools/languageModelToolsService.js';
import { MockChatVariablesService } from '../mockChatVariables.js';
import { MockPromptsService } from '../promptSyntax/service/mockPromptsService.js';
import { MockLanguageModelToolsService } from '../tools/mockLanguageModelToolsService.js';
import { MockChatService } from './mockChatService.js';
import { SessionType } from '../../../common/chatSessionsService.js';
import { AGENT_DEBUG_LOG_FILE_LOGGING_ENABLED_SETTING, COPILOT_SKILL_URI_SCHEME, TROUBLESHOOT_SKILL_PATH } from '../../../common/promptSyntax/promptTypes.js';
import { ChatRequestSlashPromptPart } from '../../../common/requestParser/chatParserTypes.js';
import { NullLanguageModelsService } from '../languageModels.js';

const chatAgentWithUsedContextId = 'ChatProviderWithUsedContext';
const chatAgentWithUsedContext: IChatAgent = {
	id: chatAgentWithUsedContextId,
	name: chatAgentWithUsedContextId,
	extensionId: nullExtensionDescription.identifier,
	extensionVersion: undefined,
	publisherDisplayName: '',
	extensionPublisherId: '',
	extensionDisplayName: '',
	locations: [ChatAgentLocation.Chat],
	modes: [ChatModeKind.Ask],
	metadata: {},
	slashCommands: [],
	disambiguation: [],
	async invoke(request, progress, history, token) {
		progress([{
			documents: [
				{
					uri: URI.file('/test/path/to/file'),
					version: 3,
					ranges: [
						new Range(1, 1, 2, 2)
					]
				}
			],
			kind: 'usedContext'
		}]);

		return { metadata: { metadataKey: 'value' } };
	},
	async provideFollowups(sessionId, token) {
		return [{ kind: 'reply', message: 'Something else', agentId: '', tooltip: 'a tooltip' } satisfies IChatFollowup];
	},
};

const chatAgentWithMarkdownId = 'ChatProviderWithMarkdown';
const chatAgentWithMarkdown: IChatAgent = {
	id: chatAgentWithMarkdownId,
	name: chatAgentWithMarkdownId,
	extensionId: nullExtensionDescription.identifier,
	extensionVersion: undefined,
	publisherDisplayName: '',
	extensionPublisherId: '',
	extensionDisplayName: '',
	locations: [ChatAgentLocation.Chat],
	modes: [ChatModeKind.Ask],
	metadata: {},
	slashCommands: [],
	disambiguation: [],
	async invoke(request, progress, history, token) {
		progress([{ kind: 'markdownContent', content: new MarkdownString('test') }]);
		return { metadata: { metadataKey: 'value' } };
	},
	async provideFollowups(sessionId, token) {
		return [];
	},
};

function getAgentData(id: string): IChatAgentData {
	return {
		name: id,
		id: id,
		extensionId: nullExtensionDescription.identifier,
		extensionVersion: undefined,
		extensionPublisherId: '',
		publisherDisplayName: '',
		extensionDisplayName: '',
		locations: [ChatAgentLocation.Chat],
		modes: [ChatModeKind.Ask],
		metadata: {},
		slashCommands: [],
		disambiguation: [],
	};
}

suite('ChatService', () => {
	const testDisposables = new DisposableStore();

	let instantiationService: TestInstantiationService;
	let testFileService: InMemoryTestFileService;
	let editingSessionEntries: ISettableObservable<readonly IModifiedFileEntry[]>;

	let chatAgentService: IChatAgentService;
	const testServices: ChatService[] = [];

	/**
	 * Ensure we wait for model disposals from all created ChatServices
	 */
	function createChatService(): ChatService {
		const service = testDisposables.add(instantiationService.createInstance(ChatService));
		testServices.push(service);
		return service;
	}

	function startSessionModel(service: IChatService, location: ChatAgentLocation = ChatAgentLocation.Chat): IChatModelReference {
		const ref = testDisposables.add(service.startNewLocalSession(location));
		return ref;
	}

	async function getOrRestoreModel(service: IChatService, resource: URI): Promise<IChatModel | undefined> {
		const ref = await service.acquireOrLoadSession(resource, ChatAgentLocation.Chat, CancellationToken.None);
		if (!ref) {
			return undefined;
		}
		return testDisposables.add(ref).object;
	}

	setup(async () => {
		instantiationService = testDisposables.add(new TestInstantiationService(new ServiceCollection(
			[IChatVariablesService, new MockChatVariablesService()],
			[IWorkbenchAssignmentService, new NullWorkbenchAssignmentService()],
			[IMcpService, new TestMcpService()],
			[IPromptsService, new MockPromptsService()],
			[ICustomizationMigrationService, mockObject<ICustomizationMigrationService>()({ _serviceBrand: undefined })],
			[ICustomizationMigrationTelemetryService, mockObject<ICustomizationMigrationTelemetryService>()({ _serviceBrand: undefined })],
			[ILanguageModelToolsService, testDisposables.add(new MockLanguageModelToolsService())]
		)));
		instantiationService.stub(IStorageService, testDisposables.add(new TestStorageService()));
		instantiationService.stub(IChatEntitlementService, new TestChatEntitlementService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IUserDataProfilesService, { defaultProfile: toUserDataProfile('default', 'Default', URI.file('/test/userdata'), URI.file('/test/cache')) });
		instantiationService.stub(ITelemetryService, NullTelemetryService);
		instantiationService.stub(IExtensionService, new TestExtensionService());
		const contextKeyService = testDisposables.add(new MockContextKeyService());
		instantiationService.stub(IContextKeyService, contextKeyService);
		instantiationService.stub(IViewsService, new TestExtensionService());
		instantiationService.stub(IWorkspaceContextService, new TestContextService());
		instantiationService.stub(IChatSlashCommandService, testDisposables.add(instantiationService.createInstance(ChatSlashCommandService)));
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IChatService, new MockChatService());
		instantiationService.stub(ILanguageModelsService, new NullLanguageModelsService());
		instantiationService.stub(IEnvironmentService, { workspaceStorageHome: URI.file('/test/path/to/workspaceStorage') });
		instantiationService.stub(ILifecycleService, { onWillShutdown: Event.None });
		instantiationService.stub(IWorkspaceEditingService, { onDidEnterWorkspace: Event.None });
		instantiationService.stub(IChatDebugService, testDisposables.add(new ChatDebugServiceImpl(new TestConfigurationService(), contextKeyService)));
		editingSessionEntries = observableValue('editingSessionEntries', []);
		instantiationService.stub(IChatEditingService, new class extends mock<IChatEditingService>() {
			override startOrContinueGlobalEditingSession(): IChatEditingSession {
				return {
					state: constObservable(ChatEditingSessionState.Idle),
					requestDisablement: observableValue('requestDisablement', []),
					entries: editingSessionEntries,
					dispose: () => { }
				} as unknown as IChatEditingSession;
			}
		});

		// Configure test file service with tracking and in-memory storage
		testFileService = testDisposables.add(new InMemoryTestFileService());
		instantiationService.stub(IFileService, testFileService);

		chatAgentService = testDisposables.add(instantiationService.createInstance(ChatAgentService));
		instantiationService.stub(IChatAgentService, chatAgentService);

		const agent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				return {};
			},
		};
		testDisposables.add(chatAgentService.registerAgent('testAgent', { ...getAgentData('testAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgent(chatAgentWithUsedContextId, getAgentData(chatAgentWithUsedContextId)));
		testDisposables.add(chatAgentService.registerAgent(chatAgentWithMarkdownId, getAgentData(chatAgentWithMarkdownId)));
		testDisposables.add(chatAgentService.registerAgentImplementation('testAgent', agent));
		chatAgentService.updateAgent('testAgent', {});
	});

	teardown(async () => {
		testDisposables.clear();
		await Promise.all(testServices.map(s => s.waitForModelDisposals()));
		testServices.length = 0;
	});
	ensureNoDisposablesAreLeakedInTestSuite();

	test('propagates Agents Voice Mode input to the participant request', async () => {
		const captured = new DeferredPromise<boolean | undefined>();
		testDisposables.add(chatAgentService.registerAgent('voiceAgent', getAgentData('voiceAgent')));
		testDisposables.add(chatAgentService.registerAgentImplementation('voiceAgent', {
			async invoke(request) {
				captured.complete(request.isVoiceModeInput);
				return {};
			},
		}));
		const service = createChatService();
		const model = startSessionModel(service).object;

		await service.sendRequest(model.sessionResource, 'voice request', {
			agentId: 'voiceAgent',
			isVoiceModeInput: true,
		});

		assert.strictEqual(await captured.p, true);
	});

	test('acceptance counts submissions once, not rejections, system messages, retries or queue drains', async () => {
		const service = createChatService();
		const model = startSessionModel(service).object;
		const accepted: boolean[] = [];
		testDisposables.add(service.onDidAcceptRequest(event => accepted.push(event.isNewSession)));
		await service.sendRequest(model.sessionResource, '');
		const first = await service.sendRequest(model.sessionResource, 'first');
		ChatSendResult.assertSent(first);
		await first.data.responseCompletePromise;
		await service.resendRequest(model.getRequests()[0]);
		const system = await service.sendRequest(model.sessionResource, 'system', { isSystemInitiated: true });
		ChatSendResult.assertSent(system);
		await system.data.responseCompletePromise;
		await service.sendRequest(model.sessionResource, 'queued', { queue: ChatRequestQueueKind.Queued, pauseQueue: true });
		await service.sendRequest(model.sessionResource, 'steering', { queue: ChatRequestQueueKind.Steering, pauseQueue: true });
		service.processPendingRequests(model.sessionResource);
		await timeout(10);
		assert.deepStrictEqual(accepted, [true, false, false]);
	});

	test('only the first accepted message starts a session even when queued or removed', async () => {
		const service = createChatService();
		const model = startSessionModel(service).object;
		const accepted: boolean[] = [];
		testDisposables.add(service.onDidAcceptRequest(event => accepted.push(event.isNewSession)));
		await service.sendRequest(model.sessionResource, 'queued first', { queue: ChatRequestQueueKind.Queued, pauseQueue: true });
		const pending = model.getPendingRequests()[0];
		service.removePendingRequest(model.sessionResource, pending.request.id);
		await service.sendRequest(model.sessionResource, 'replacement', { queue: ChatRequestQueueKind.Queued, pauseQueue: true });
		assert.deepStrictEqual(accepted, [true, false]);
	});

	for (const excludedKind of ['system', 'hidden'] as const) {
		for (const historyState of ['completed', 'queued', 'restored'] as const) {
			test(`first eligible user submission starts a session after a ${historyState} ${excludedKind} request`, async () => {
				let service = createChatService();
				let model = startSessionModel(service).object;
				const accepted: boolean[] = [];
				testDisposables.add(service.onDidAcceptRequest(event => accepted.push(event.isNewSession)));
				const result = await service.sendRequest(model.sessionResource, 'excluded request', {
					isSystemInitiated: excludedKind === 'system',
					hideFromTranscript: excludedKind === 'hidden',
					queue: historyState === 'queued' ? ChatRequestQueueKind.Queued : undefined,
					pauseQueue: true,
				});
				if (historyState === 'queued') {
					assert.ok(ChatSendResult.isQueued(result));
				} else {
					ChatSendResult.assertSent(result);
					await result.data.responseCompletePromise;
				}
				if (historyState === 'restored') {
					const data: ISerializableChatData = JSON.parse(JSON.stringify(model));
					service = createChatService();
					model = testDisposables.add(service.loadSessionFromData(data)).object;
					assert.strictEqual(model.getRequests().length, 1);
					testDisposables.add(service.onDidAcceptRequest(event => accepted.push(event.isNewSession)));
				}
				for (const message of ['first user request', 'follow-up']) {
					const queued = await service.sendRequest(model.sessionResource, message, { queue: ChatRequestQueueKind.Queued, pauseQueue: true });
					assert.ok(ChatSendResult.isQueued(queued));
				}
				assert.deepStrictEqual(accepted, [true, false]);
			});
		}
	}

	test('restored visible user history is not counted as a new session', async () => {
		const original = createChatService();
		const originalModel = startSessionModel(original).object;
		const first = await original.sendRequest(originalModel.sessionResource, 'first user request');
		ChatSendResult.assertSent(first);
		await first.data.responseCompletePromise;

		const restored = createChatService();
		const data: ISerializableChatData = JSON.parse(JSON.stringify(originalModel));
		const model = testDisposables.add(restored.loadSessionFromData(data)).object;
		assert.strictEqual(model.getRequests().length, 1);
		const accepted: boolean[] = [];
		testDisposables.add(restored.onDidAcceptRequest(event => accepted.push(event.isNewSession)));
		const followUp = await restored.sendRequest(model.sessionResource, 'follow-up');
		ChatSendResult.assertSent(followUp);
		await followUp.data.responseCompletePromise;
		assert.deepStrictEqual(accepted, [false]);
	});

	test('retains submitted model configuration for sent, queued and steering requests', async () => {
		const service = createChatService();
		const model = testDisposables.add(startSessionModel(service)).object;
		const modelId = 'agent-host-copilot:claude-opus-4.8';
		const modelConfiguration = { reasoningEffort: 'xhigh', contextSize: 200_000 };
		for (const queue of [undefined, ChatRequestQueueKind.Queued, ChatRequestQueueKind.Steering]) {
			const result = await service.sendRequest(model.sessionResource, 'hello', {
				queue,
				pauseQueue: true,
				userSelectedModelId: modelId,
				userSelectedModelConfiguration: modelConfiguration,
			});
			if (queue === undefined) {
				ChatSendResult.assertSent(result);
				await result.data.responseCompletePromise;
			} else {
				assert.ok(ChatSendResult.isQueued(result));
			}
		}
		const viewModel = testDisposables.add(instantiationService.createInstance(ChatViewModel, model, undefined));
		const expected = { modelId, modelConfiguration };
		assert.deepStrictEqual({
			requests: viewModel.getItems().filter(isRequestVM).map(request => ({ modelId: request.modelId, modelConfiguration: request.modelConfiguration })),
			pending: model.getPendingRequests().map(request => ({
				modelId: request.sendOptions.userSelectedModelId,
				modelConfiguration: request.sendOptions.userSelectedModelConfiguration,
			})),
		}, {
			requests: [expected, expected, expected],
			pending: [expected, expected],
		});
	});

	test('slash commands can share ids across non-overlapping session types', async () => {
		const slashCommandService = testDisposables.add(instantiationService.createInstance(ChatSlashCommandService));
		const executions: string[] = [];
		const progress = { report: (_progress: IChatProgress) => { } };

		testDisposables.add(slashCommandService.registerSlashCommand({
			command: 'switch',
			detail: 'Local switch',
			locations: [ChatAgentLocation.Chat],
			sessionTypes: ['local'],
		}, async () => {
			executions.push('local');
		}));

		testDisposables.add(slashCommandService.registerSlashCommand({
			command: 'switch',
			detail: 'Remote switch',
			locations: [ChatAgentLocation.Chat],
			sessionTypes: ['remote'],
		}, async () => {
			executions.push('remote');
		}));

		assert.strictEqual(slashCommandService.hasCommand('switch', 'local'), true);
		assert.strictEqual(slashCommandService.hasCommand('switch', 'remote'), true);
		assert.strictEqual(slashCommandService.hasCommand('switch', 'other'), false);

		await slashCommandService.executeCommand('switch', '', progress, [], ChatAgentLocation.Chat, LocalChatSessionUri.forSession('local-session'), CancellationToken.None);
		await slashCommandService.executeCommand('switch', '', progress, [], ChatAgentLocation.Chat, URI.from({ scheme: 'remote', path: '/session' }), CancellationToken.None);

		assert.deepStrictEqual(executions, ['local', 'remote']);
	});

	test('slash commands reject overlapping session types for the same id', () => {
		const slashCommandService = testDisposables.add(instantiationService.createInstance(ChatSlashCommandService));
		const command = async () => undefined;

		testDisposables.add(slashCommandService.registerSlashCommand({
			command: 'switch',
			detail: 'Local switch',
			locations: [ChatAgentLocation.Chat],
			sessionTypes: ['local', 'remote'],
		}, command));

		assert.throws(() => slashCommandService.registerSlashCommand({
			command: 'switch',
			detail: 'Remote switch',
			locations: [ChatAgentLocation.Chat],
			sessionTypes: ['remote', 'other'],
		}, command));
	});

	test('slash commands without session types apply to all session types', async () => {
		const slashCommandService = testDisposables.add(instantiationService.createInstance(ChatSlashCommandService));
		const executions: string[] = [];
		const progress = { report: (_progress: IChatProgress) => { } };

		testDisposables.add(slashCommandService.registerSlashCommand({
			command: 'switch',
			detail: 'All sessions switch',
			locations: [ChatAgentLocation.Chat],
		}, async () => {
			executions.push('all');
		}));

		assert.strictEqual(slashCommandService.hasCommand('switch', 'local'), true);
		assert.strictEqual(slashCommandService.hasCommand('switch', 'remote'), true);

		await slashCommandService.executeCommand('switch', '', progress, [], ChatAgentLocation.Chat, LocalChatSessionUri.forSession('local-session'), CancellationToken.None);
		await slashCommandService.executeCommand('switch', '', progress, [], ChatAgentLocation.Chat, URI.from({ scheme: 'remote', path: '/session' }), CancellationToken.None);

		assert.deepStrictEqual(executions, ['all', 'all']);
		assert.throws(() => slashCommandService.registerSlashCommand({
			command: 'switch',
			detail: 'Remote switch',
			locations: [ChatAgentLocation.Chat],
			sessionTypes: ['remote'],
		}, async () => undefined));
	});

	test('retrieveSession', async () => {
		const testService = createChatService();
		// Don't add refs to testDisposables so we can control disposal
		const session1Ref = testService.startNewLocalSession(ChatAgentLocation.Chat);
		const session1 = session1Ref.object as ChatModel;
		session1.addRequest({ parts: [], text: 'request 1' }, { variables: [] }, 0);

		const session2Ref = testService.startNewLocalSession(ChatAgentLocation.Chat);
		const session2 = session2Ref.object as ChatModel;
		session2.addRequest({ parts: [], text: 'request 2' }, { variables: [] }, 0);

		// Dispose refs to trigger persistence to file service
		session1Ref.dispose();
		session2Ref.dispose();

		// Wait for async persistence to complete
		await testService.waitForModelDisposals();

		// Verify that sessions were written to the file service
		assert.strictEqual(testFileService.writeOperations.length, 2, 'Should have written 2 sessions to file service');

		const session1WriteOp = testFileService.writeOperations.find((op: { resource: URI; content: string }) =>
			op.content.includes('request 1'));
		const session2WriteOp = testFileService.writeOperations.find((op: { resource: URI; content: string }) =>
			op.content.includes('request 2'));

		assert.ok(session1WriteOp, 'Session 1 should have been written to file service');
		assert.ok(session2WriteOp, 'Session 2 should have been written to file service');

		// Create a new service instance to simulate app restart
		const testService2 = createChatService();

		// Retrieve sessions and verify they're loaded from file service
		const retrieved1 = await getOrRestoreModel(testService2, session1.sessionResource);
		const retrieved2 = await getOrRestoreModel(testService2, session2.sessionResource);

		assert.ok(retrieved1, 'Should retrieve session 1');
		assert.ok(retrieved2, 'Should retrieve session 2');
		assert.deepStrictEqual(retrieved1.getRequests()[0]?.message.text, 'request 1');
		assert.deepStrictEqual(retrieved2.getRequests()[0]?.message.text, 'request 2');
	});

	test('reports modified edit keep-alive holders', () => {
		const testService = createChatService();
		instantiationService.stub(IChatService, testService);
		const rootRef = testService.startNewLocalSession(ChatAgentLocation.Chat, { debugOwner: 'ChatServiceTest#root' });

		const modifiedEntry = new class extends mock<IModifiedFileEntry>() {
			override state = constObservable(ModifiedFileEntryState.Modified);
		}();

		editingSessionEntries.set([modifiedEntry], undefined);

		assert.deepStrictEqual(testService.getChatModelReferenceDebugInfo().models.map(model => ({
			createdBy: model.createdBy,
			holders: model.holders,
			hasPendingEdits: model.hasPendingEdits,
			referenceCount: model.referenceCount,
		})), [{
			createdBy: 'ChatServiceTest#root',
			holders: [
				{ holder: 'ChatModel#modifiedEditsKeepAlive', count: 1 },
				{ holder: 'ChatServiceTest#root', count: 1 }
			],
			hasPendingEdits: true,
			referenceCount: 2,
		}]);

		editingSessionEntries.set([], undefined);
		assert.deepStrictEqual(testService.getChatModelReferenceDebugInfo().models.map(model => ({
			holders: model.holders,
			hasPendingEdits: model.hasPendingEdits,
			referenceCount: model.referenceCount,
		})), [{
			holders: [{ holder: 'ChatServiceTest#root', count: 1 }],
			hasPendingEdits: false,
			referenceCount: 1,
		}]);

		rootRef.dispose();
	});

	test('addCompleteRequest', async () => {
		const testService = createChatService();

		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;
		assert.strictEqual(model.getRequests().length, 0);

		await testService.addCompleteRequest(model.sessionResource, 'test request', undefined, 0, { message: 'test response' });
		assert.strictEqual(model.getRequests().length, 1);
		assert.ok(model.getRequests()[0].response);
		assert.strictEqual(model.getRequests()[0].response?.response.toString(), 'test response');
	});

	test('sendRequest allows empty message with explicit file attachment', async () => {
		const testService = createChatService();

		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;
		const fileEntry: IChatRequestVariableEntry = { kind: 'file', id: 'file', name: 'README.md', value: URI.file('/test/README.md') };
		const response = await testService.sendRequest(model.sessionResource, '', { attachedContext: [fileEntry] });
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		assert.strictEqual(model.getRequests().length, 1);
		assert.strictEqual(model.getRequests()[0].message.text, '');
		assert.deepStrictEqual(model.getRequests()[0].variableData.variables, [fileEntry]);
	});

	test('sendRequest allows empty message with a handed-off explicit file snapshot', async () => {
		const testService = createChatService();
		const model = testDisposables.add(startSessionModel(testService)).object;
		const attachment = toPasteVariableEntry('Unsaved file', 'Current draft contents', {
			_meta: { [ChatPasteAttachmentMetadata.FileSnapshot]: true },
		});
		const response = await testService.sendRequest(model.sessionResource, '', { attachedContext: [attachment] });
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;
		assert.deepStrictEqual(model.getRequests().map(request => ({
			text: request.message.text, attachments: request.variableData.variables,
		})), [{ text: '', attachments: [attachment] }]);
	});

	test('sendRequest rejects empty message without explicit file attachment', async () => {
		const testService = createChatService();

		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;
		const workspaceEntry: IChatRequestVariableEntry = { kind: 'workspace', id: 'workspace', name: 'workspace', value: 'workspace' };

		assert.deepStrictEqual(await testService.sendRequest(model.sessionResource, ''), { kind: 'rejected', reason: 'Empty message' });
		assert.deepStrictEqual(await testService.sendRequest(model.sessionResource, '', { attachedContext: [workspaceEntry] }), { kind: 'rejected', reason: 'Empty message' });
		assert.strictEqual(model.getRequests().length, 0);
	});

	test('sendRequest fails', async () => {
		const testService = createChatService();

		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;
		const response = await testService.sendRequest(model.sessionResource, `@${chatAgentWithUsedContextId} test request`);
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		await assertSnapshot(toSnapshotExportData(model));
	});

	test('passes request metadata to the participant without adding it to the prompt', async () => {
		const requests: { message: string; metadata: Record<string, unknown> | undefined }[] = [];
		testDisposables.add(chatAgentService.registerAgent('metadataAgent', getAgentData('metadataAgent')));
		testDisposables.add(chatAgentService.registerAgentImplementation('metadataAgent', {
			async invoke(request) {
				requests.push({ message: request.message, metadata: request.metadata });
				return {};
			},
		}));
		const service = createChatService();
		const model = startSessionModel(service).object;
		const metadata = { 'test.request': { enabled: true } };
		const response = await service.sendRequest(model.sessionResource, 'hello', { agentId: 'metadataAgent', metadata });
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;
		assert.deepStrictEqual(requests, [{ message: 'hello', metadata }]);
	});

	test('history', async () => {
		const historyLengthAgent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				return {
					metadata: { historyLength: history.length }
				};
			},
		};

		testDisposables.add(chatAgentService.registerAgent('defaultAgent', { ...getAgentData('defaultAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgent('agent2', getAgentData('agent2')));
		testDisposables.add(chatAgentService.registerAgentImplementation('defaultAgent', historyLengthAgent));
		testDisposables.add(chatAgentService.registerAgentImplementation('agent2', historyLengthAgent));

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		// Send a request to default agent
		const response = await testService.sendRequest(model.sessionResource, `test request`, { agentId: 'defaultAgent' });
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;
		assert.strictEqual(model.getRequests().length, 1);
		assert.strictEqual(model.getRequests()[0].response?.result?.metadata?.historyLength, 0);

		// Send a request to agent2- it can't see the default agent's message
		const response2 = await testService.sendRequest(model.sessionResource, `test request`, { agentId: 'agent2' });
		ChatSendResult.assertSent(response2);
		await response2.data.responseCompletePromise;
		assert.strictEqual(model.getRequests().length, 2);
		assert.strictEqual(model.getRequests()[1].response?.result?.metadata?.historyLength, 0);

		// Send a request to defaultAgent - the default agent can see agent2's message
		const response3 = await testService.sendRequest(model.sessionResource, `test request`, { agentId: 'defaultAgent' });
		ChatSendResult.assertSent(response3);
		await response3.data.responseCompletePromise;
		assert.strictEqual(model.getRequests().length, 3);
		assert.strictEqual(model.getRequests()[2].response?.result?.metadata?.historyLength, 2);
	});

	test('can serialize', async () => {
		testDisposables.add(chatAgentService.registerAgentImplementation(chatAgentWithUsedContextId, chatAgentWithUsedContext));
		chatAgentService.updateAgent(chatAgentWithUsedContextId, {});
		const testService = createChatService();

		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;
		assert.strictEqual(model.getRequests().length, 0);

		await assertSnapshot(toSnapshotExportData(model));

		const response = await testService.sendRequest(model.sessionResource, `@${chatAgentWithUsedContextId} test request`);
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;
		assert.strictEqual(model.getRequests().length, 1);

		const response2 = await testService.sendRequest(model.sessionResource, `test request 2`);
		ChatSendResult.assertSent(response2);
		await response2.data.responseCompletePromise;
		assert.strictEqual(model.getRequests().length, 2);

		await assertSnapshot(toSnapshotExportData(model));
	});

	test('can deserialize', async () => {
		let serializedChatData: ISerializableChatData;
		testDisposables.add(chatAgentService.registerAgentImplementation(chatAgentWithUsedContextId, chatAgentWithUsedContext));

		// create the first service, send request, get response, and serialize the state
		{  // serapate block to not leak variables in outer scope
			const testService = createChatService();

			const chatModel1Ref = testDisposables.add(startSessionModel(testService));
			const chatModel1 = chatModel1Ref.object;
			assert.strictEqual(chatModel1.getRequests().length, 0);

			const response = await testService.sendRequest(chatModel1.sessionResource, `@${chatAgentWithUsedContextId} test request`);
			ChatSendResult.assertSent(response);

			await response.data.responseCompletePromise;

			serializedChatData = JSON.parse(JSON.stringify(chatModel1));
		}

		// try deserializing the state into a new service

		const testService2 = createChatService();

		const chatModel2Ref = testService2.loadSessionFromData(serializedChatData);
		assert(chatModel2Ref);
		testDisposables.add(chatModel2Ref);
		const chatModel2 = chatModel2Ref.object;

		await assertSnapshot(toSnapshotExportData(chatModel2));
	});

	test('loadSessionFromData applies creation metadata to the model and telemetry', async () => {
		const providerInvokedEvents: Record<string, unknown>[] = [];
		instantiationService.stub(ITelemetryService, {
			...NullTelemetryService,
			publicLog2(eventName: string, data: Record<string, unknown> | undefined): void {
				if (eventName === 'interactiveSessionProviderInvoked' && data) {
					providerInvokedEvents.push(data);
				}
			}
		});
		const testService = createChatService();
		const sourceRef = startSessionModel(testService);
		const forkedData = sourceRef.object.toJSON();
		forkedData.sessionId = 'forked-session';

		const forkedRef = testDisposables.add(testService.loadSessionFromData(forkedData, 'ChatServiceTest#forkedSession', 'currentSession'));
		const response = await testService.sendRequest(forkedRef.object.sessionResource, 'hello');
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		assert.deepStrictEqual({
			modelSelectionReason: forkedRef.object.sessionTypeSelectionReason,
			telemetrySelectionReasons: providerInvokedEvents.map(event => event.sessionTypeSelectionReason),
		}, {
			modelSelectionReason: 'currentSession',
			telemetrySelectionReasons: ['currentSession'],
		});
	});

	test('can deserialize with response', async () => {
		let serializedChatData: ISerializableChatData;
		testDisposables.add(chatAgentService.registerAgentImplementation(chatAgentWithMarkdownId, chatAgentWithMarkdown));

		{
			const testService = createChatService();

			const chatModel1Ref = testDisposables.add(startSessionModel(testService));
			const chatModel1 = chatModel1Ref.object;
			assert.strictEqual(chatModel1.getRequests().length, 0);

			const response = await testService.sendRequest(chatModel1.sessionResource, `@${chatAgentWithUsedContextId} test request`);
			ChatSendResult.assertSent(response);

			await response.data.responseCompletePromise;

			serializedChatData = JSON.parse(JSON.stringify(chatModel1));
		}

		// try deserializing the state into a new service

		const testService2 = createChatService();

		const chatModel2Ref = testService2.loadSessionFromData(serializedChatData);
		assert(chatModel2Ref);
		testDisposables.add(chatModel2Ref);
		const chatModel2 = chatModel2Ref.object;

		await assertSnapshot(toSnapshotExportData(chatModel2));
	});

	test('can serialize and deserialize implicit request flag', async () => {
		let serializedChatData: ISerializableChatData;

		{
			const testService = createChatService();
			const chatModel1Ref = testDisposables.add(startSessionModel(testService));
			const chatModel1 = chatModel1Ref.object;

			const response = await testService.sendRequest(chatModel1.sessionResource, 'test implicit request', { isSystemInitiated: true });
			ChatSendResult.assertSent(response);
			await response.data.responseCompletePromise;

			assert.strictEqual(chatModel1.getRequests().length, 1);
			assert.strictEqual(chatModel1.getRequests()[0].isSystemInitiated, true);

			serializedChatData = JSON.parse(JSON.stringify(chatModel1));
			assert.strictEqual(serializedChatData.requests.length, 1);
			assert.strictEqual(serializedChatData.requests[0].isSystemInitiated, true);
		}

		const testService2 = createChatService();
		const chatModel2Ref = testService2.loadSessionFromData(serializedChatData);
		assert(chatModel2Ref);
		testDisposables.add(chatModel2Ref);
		const chatModel2 = chatModel2Ref.object;

		assert.strictEqual(chatModel2.getRequests().length, 1);
		assert.strictEqual(chatModel2.getRequests()[0].isSystemInitiated, true);
	});

	test('can serialize and deserialize a request hidden from the transcript', async () => {
		let serializedChatData: ISerializableChatData;
		{
			const testService = createChatService();
			const chatModelRef = testDisposables.add(startSessionModel(testService));
			const response = await testService.sendRequest(chatModelRef.object.sessionResource, 'hidden request', { hideFromTranscript: true });
			ChatSendResult.assertSent(response);
			await response.data.responseCompletePromise;

			const request = chatModelRef.object.getRequests()[0];
			const viewModel = testDisposables.add(instantiationService.createInstance(ChatViewModel, chatModelRef.object, undefined));
			assert.deepStrictEqual({
				request: request.isHiddenFromTranscript,
				response: request.response?.isHiddenFromTranscript,
				visibleItems: viewModel.getItems().length,
			}, {
				request: true,
				response: true,
				visibleItems: 0,
			});
			serializedChatData = JSON.parse(JSON.stringify(chatModelRef.object));
		}

		const testService = createChatService();
		const restored = testDisposables.add(testService.loadSessionFromData(serializedChatData)!);
		const request = restored.object.getRequests()[0];
		const viewModel = testDisposables.add(instantiationService.createInstance(ChatViewModel, restored.object, undefined));
		assert.deepStrictEqual({
			request: request.isHiddenFromTranscript,
			response: request.response?.isHiddenFromTranscript,
			visibleItems: viewModel.getItems().length,
		}, {
			request: true,
			response: true,
			visibleItems: 0,
		});
	});

	test('can serialize and deserialize a request origin', () => {
		const sourceSessionResource = URI.parse('agent-host-codex:/source-thread');
		const testService = createChatService();
		const chatModelRef = testDisposables.add(startSessionModel(testService));
		const chatModel = chatModelRef.object as ChatModel;
		chatModel.addRequest(
			{ parts: [], text: 'delegated request' },
			{ variables: [] },
			0,
			undefined, // modeInfo
			undefined, // chatAgent
			undefined, // slashCommand
			undefined, // confirmation
			undefined, // locationData
			undefined, // attachments
			undefined, // isCompleteAddedRequest
			undefined, // modelId
			undefined, // userSelectedTools
			undefined, // id
			undefined, // isSystemInitiated
			undefined, // systemInitiatedLabel
			undefined, // terminalExecutionId
			undefined, // isTerminalCommand
			undefined, // timestamp
			undefined, // hideFromTranscript
			{
				kind: ChatRequestOriginKind.Delegation,
				sourceSessionResource,
			},
		);
		const serialized: ISerializableChatData = JSON.parse(JSON.stringify(chatModel));

		const restored = testDisposables.add(createChatService().loadSessionFromData(serialized)!);

		assert.deepStrictEqual(restored.object.getRequests()[0].origin, {
			kind: ChatRequestOriginKind.Delegation,
			sourceSessionResource,
		});
	});

	test('hidden queued requests remain absent from the transcript', async () => {
		const requestStarted = new DeferredPromise<void>();
		const completeRequest = new DeferredPromise<void>();
		const slowAgent: IChatAgentImplementation = {
			async invoke() {
				requestStarted.complete();
				await completeRequest.p;
				return {};
			},
		};
		testDisposables.add(chatAgentService.registerAgent('slowHiddenQueueAgent', { ...getAgentData('slowHiddenQueueAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('slowHiddenQueueAgent', slowAgent));
		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		const active = await testService.sendRequest(model.sessionResource, 'active request', { agentId: 'slowHiddenQueueAgent' });
		ChatSendResult.assertSent(active);
		await requestStarted.p;
		const queued = await testService.sendRequest(model.sessionResource, 'hidden queued request', {
			agentId: 'slowHiddenQueueAgent',
			queue: ChatRequestQueueKind.Queued,
			hideFromTranscript: true,
		});
		assert.ok(ChatSendResult.isQueued(queued));
		const pendingRequest = model.getPendingRequests()[0].request;
		const viewModel = testDisposables.add(instantiationService.createInstance(ChatViewModel, model, undefined));
		const visibleItems = viewModel.getItems();

		assert.deepStrictEqual({
			hidden: pendingRequest.isHiddenFromTranscript,
			hasPendingRequest: visibleItems.some(item => item.id === pendingRequest.id),
			hasPendingDivider: visibleItems.some(isPendingDividerVM),
		}, {
			hidden: true,
			hasPendingRequest: false,
			hasPendingDivider: false,
		});

		completeRequest.complete();
		await active.data.responseCompletePromise;
	});

	test('acquireExistingSession keeps model alive for steering request after refs released', async () => {
		const testService = createChatService();
		const modelRef = startSessionModel(testService);
		const sessionResource = modelRef.object.sessionResource;

		// Acquire a keep-alive reference (what the fix does)
		const keepAliveRef = testDisposables.add(testService.acquireExistingSession(sessionResource, 'test#keepAlive')!);
		assert.ok(keepAliveRef, 'acquireExistingSession should return a reference');

		// Release the original reference to simulate user navigating away
		modelRef.dispose();
		await testService.waitForModelDisposals();

		// Model should still be accessible because keepAliveRef holds it
		const response = await testService.sendRequest(sessionResource, 'terminal completed', {
			queue: ChatRequestQueueKind.Steering,
			isSystemInitiated: true,
		});
		assert.strictEqual(response.kind, 'queued');

		// Clean up
		keepAliveRef.dispose();
	});

	test('onDidDisposeSession', async () => {
		const testService = createChatService();
		const modelRef = testService.startNewLocalSession(ChatAgentLocation.Chat);
		const model = modelRef.object;

		let reason: string | undefined;
		testDisposables.add(testService.onDidDisposeSession(e => {
			for (const resource of e.sessionResources) {
				if (resource.toString() === model.sessionResource.toString()) {
					reason = e.reason;
				}
			}
		}));

		modelRef.dispose();
		await testService.waitForModelDisposals();
		assert.strictEqual(reason, 'disposed');
	});

	test('disposing a session cancels pending followups', async () => {
		let followupsToken: CancellationToken | undefined;
		const followupsCancelled = new DeferredPromise<IChatFollowup[]>();
		const followupsAgent: IChatAgentImplementation = {
			async invoke() {
				return {};
			},
			provideFollowups(request, result, history, token) {
				followupsToken = token;
				testDisposables.add(token.onCancellationRequested(() => followupsCancelled.complete([])));
				return followupsCancelled.p;
			},
		};

		testDisposables.add(chatAgentService.registerAgent('followupsAgent', { ...getAgentData('followupsAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('followupsAgent', followupsAgent));

		const testService = createChatService();
		const modelRef = testService.startNewLocalSession(ChatAgentLocation.Chat);
		const response = await testService.sendRequest(modelRef.object.sessionResource, 'test request', { agentId: 'followupsAgent' });
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		assert.ok(followupsToken);
		assert.strictEqual(followupsToken.isCancellationRequested, false);

		modelRef.dispose();
		await testService.waitForModelDisposals();

		assert.strictEqual(followupsToken.isCancellationRequested, true);
	});

	test('steering message queued triggers setYieldRequested', async () => {
		const requestStarted = new DeferredPromise<void>();
		const completeRequest = new DeferredPromise<void>();
		let setYieldRequestedCalled = false;

		const slowAgent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				requestStarted.complete();
				await completeRequest.p;
				return {};
			},
			setYieldRequested(requestId: string, value: boolean) {
				setYieldRequestedCalled = true;
			},
		};

		testDisposables.add(chatAgentService.registerAgent('slowAgent', { ...getAgentData('slowAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('slowAgent', slowAgent));

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		// Start a request that will wait
		const response = await testService.sendRequest(model.sessionResource, 'first request', { agentId: 'slowAgent' });
		ChatSendResult.assertSent(response);

		// Wait for the agent to start processing
		await requestStarted.p;

		// Queue a steering message while the first request is still in progress
		const steeringResponse = await testService.sendRequest(model.sessionResource, 'steering message', {
			agentId: 'slowAgent',
			queue: ChatRequestQueueKind.Steering
		});
		assert.strictEqual(steeringResponse.kind, 'queued');

		// setYieldRequested should have been called on the agent
		assert.strictEqual(setYieldRequestedCalled, true, 'setYieldRequested should be called when a steering message is queued');

		// Complete the first request
		completeRequest.complete();
		await response.data.responseCompletePromise;
	});

	test('multiple steering messages are combined into a single request', async () => {
		const requestStarted = new DeferredPromise<void>();
		const completeRequest = new DeferredPromise<void>();
		const invokedRequests: string[] = [];

		const slowAgent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				invokedRequests.push(request.message);
				if (invokedRequests.length === 1) {
					requestStarted.complete();
					await completeRequest.p;
				}
				return {};
			},
		};

		testDisposables.add(chatAgentService.registerAgent('slowAgent', { ...getAgentData('slowAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('slowAgent', slowAgent));

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		// Start a request that will wait
		const response = await testService.sendRequest(model.sessionResource, 'first request', { agentId: 'slowAgent' });
		ChatSendResult.assertSent(response);

		// Wait for the agent to start processing
		await requestStarted.p;

		// Queue 3 steering messages while the first request is in progress
		const steering1 = await testService.sendRequest(model.sessionResource, 'steering1', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Steering });
		const steering2 = await testService.sendRequest(model.sessionResource, 'steering2', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Steering });
		const steering3 = await testService.sendRequest(model.sessionResource, 'steering3', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Steering });
		assert.ok(ChatSendResult.isQueued(steering1));
		assert.ok(ChatSendResult.isQueued(steering2));
		assert.ok(ChatSendResult.isQueued(steering3));

		// Complete the first request - should trigger processing of combined steering requests
		completeRequest.complete();
		await response.data.responseCompletePromise;

		// Wait for all deferred promises to resolve
		await steering1.deferred;
		await steering2.deferred;
		await steering3.deferred;

		// Should have only invoked 2 requests: the initial and the combined steering
		assert.strictEqual(invokedRequests.length, 2, 'Should have only 2 invocations (initial + combined steering)');
		// The combined message includes all steering texts joined with \n\n
		assert.ok(invokedRequests[1].includes('steering1'), 'Combined message should include steering1');
		assert.ok(invokedRequests[1].includes('steering2'), 'Combined message should include steering2');
		assert.ok(invokedRequests[1].includes('steering3'), 'Combined message should include steering3');
		assert.ok(invokedRequests[1].includes('\n\n'), 'Combined message should use \\n\\n as separator');
	});

	test('disabled Claude hooks hint is shown once per workspace (fix for #295079)', async () => {
		// Set up a prompts service that reports disabled Claude hooks
		const mockPromptsService = new class extends MockPromptsService {
			override getHooks(_token: CancellationToken): Promise<IConfiguredHooksInfo> {
				return Promise.resolve({ hooks: {}, hasDisabledClaudeHooks: true });
			}
		}();
		instantiationService.stub(IPromptsService, mockPromptsService);

		const storageService = instantiationService.get(IStorageService);
		const disabledHintsKey = 'chat.disabledClaudeHooks.notification';

		// Before any request, the storage key should not be set
		assert.strictEqual(storageService.getBoolean(disabledHintsKey, StorageScope.WORKSPACE), undefined);

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		// Disabled hooks are reported for every request, but the hint should only be shown once per workspace.
		const response = await testService.sendRequest(model.sessionResource, 'test request');
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		// The hint should have been shown, and the key set to true
		assert.strictEqual(storageService.getBoolean(disabledHintsKey, StorageScope.WORKSPACE), true, 'Flag should be set after showing the hint');

		// Verify the response contains the disabledClaudeHooks part
		const requests = model.getRequests();
		assert.strictEqual(requests.length, 1);
		const responseParts = requests[0].response?.response.value ?? [];
		const hasHookHint = responseParts.some(part => part.kind === 'disabledClaudeHooks');
		assert.ok(hasHookHint, 'Response should contain the disabledClaudeHooks hint');

		// Sending another request should NOT show the hint again (shown only once per workspace)
		const response2 = await testService.sendRequest(model.sessionResource, 'second request');
		ChatSendResult.assertSent(response2);
		await response2.data.responseCompletePromise;

		const requests2 = model.getRequests();
		assert.strictEqual(requests2.length, 2);
		const responseParts2 = requests2[1].response?.response.value ?? [];
		const hasHookHint2 = responseParts2.some(part => part.kind === 'disabledClaudeHooks');
		assert.ok(!hasHookHint2, 'Response should NOT contain the disabledClaudeHooks hint on second request');
	});

	test('disabled Claude hooks hint is not consumed when no disabled hooks (fix for #295079)', async () => {
		// Set up a prompts service that simulates the setup agent first pass (no disabled hooks)
		// followed by the real resent request (with disabled hooks).
		const mockPromptsService = new class extends MockPromptsService {
			private _callCount = 0;
			override getHooks(_token: CancellationToken): Promise<IConfiguredHooksInfo> {
				this._callCount++;
				// First call (setup agent): no disabled hooks
				// Second call (real request after resend): disabled hooks present
				return Promise.resolve({ hooks: {}, hasDisabledClaudeHooks: this._callCount > 1 });
			}
		}();
		instantiationService.stub(IPromptsService, mockPromptsService);

		const storageService = instantiationService.get(IStorageService);
		const disabledHintsKey = 'chat.disabledClaudeHooks.notification';

		// First request: no disabled hooks (simulates setup agent pass)
		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		const response = await testService.sendRequest(model.sessionResource, 'first request');
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		// Flag should NOT be set because no hint was shown
		assert.strictEqual(storageService.getBoolean(disabledHintsKey, StorageScope.WORKSPACE), undefined, 'Flag should not be set when no disabled hooks');

		const firstRequest = model.getRequests()[0];
		assert.ok(firstRequest, 'Expected the initial request to exist before resend');
		const structuralChanges: string[] = [];
		testDisposables.add(model.onDidChange(event => {
			if (event.kind === 'removeRequest' || event.kind === 'addRequest') {
				structuralChanges.push(event.kind);
			}
		}));

		// Resend the original request: now disabled hooks are present (simulates resend after setup)
		await testService.resendRequest(firstRequest, undefined, true);

		// Now the flag should be set and the hint shown
		assert.strictEqual(storageService.getBoolean(disabledHintsKey, StorageScope.WORKSPACE), true, 'Flag should be set after showing the hint');

		const requests = model.getRequests();
		assert.strictEqual(requests.length, 1, 'Resend should replace the original request');
		assert.strictEqual(requests[0].id, firstRequest.id, 'Preserved resend should keep the original request id');
		assert.strictEqual(requests[0], firstRequest, 'Preserved resend should reuse the original request model');
		assert.deepStrictEqual(structuralChanges, [], 'Preserved resend should not remove and recreate the transcript row');
		const responseParts2 = requests[0].response?.response.value ?? [];
		const hasHookHint2 = responseParts2.some(part => part.kind === 'disabledClaudeHooks');
		assert.ok(hasHookHint2, 'Response should contain the disabledClaudeHooks hint on second request');
	});

	test('resendRequest honors an agent selected outside the parsed request', async () => {
		const retryAgentId = 'retryAgent';
		const invokedRequestIds: string[] = [];
		testDisposables.add(chatAgentService.registerAgent(retryAgentId, getAgentData(retryAgentId)));
		testDisposables.add(chatAgentService.registerAgentImplementation(retryAgentId, {
			async invoke(request) {
				invokedRequestIds.push(request.requestId);
				return {};
			},
		}));
		testDisposables.add(chatAgentService.registerChatParticipantDetectionProvider(1, {
			provideParticipantDetection: async () => ({ participant: 'testAgent' }),
		}));

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;
		const response = await testService.sendRequest(model.sessionResource, 'retry me', { agentIdSilent: retryAgentId });
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;
		const firstRequest = model.getRequests()[0];

		await testService.resendRequest(firstRequest, { agentId: retryAgentId }, true);

		assert.deepStrictEqual({
			invokedRequestIds,
			requestIds: model.getRequests().map(request => request.id),
		}, {
			invokedRequestIds: [firstRequest.id, firstRequest.id],
			requestIds: [firstRequest.id],
		});
	});

	test('cancelCurrentRequestForSession waits for response completion', async () => {
		const requestStarted = new DeferredPromise<void>();
		const completeRequest = new DeferredPromise<void>();

		const slowAgent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				requestStarted.complete();
				const listener = token.onCancellationRequested(() => {
					listener.dispose();
					// Simulate some cleanup delay before completing
					setTimeout(() => completeRequest.complete(), 10);
				});
				await completeRequest.p;
				return {};
			},
		};

		testDisposables.add(chatAgentService.registerAgent('slowAgent', { ...getAgentData('slowAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('slowAgent', slowAgent));

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		const response = await testService.sendRequest(model.sessionResource, 'test request', { agentId: 'slowAgent' });
		ChatSendResult.assertSent(response);

		await requestStarted.p;

		// Cancel and await - should wait for the response to complete
		await testService.cancelCurrentRequestForSession(model.sessionResource, 'test');

		// After cancel resolves, the response model should have a result
		const lastRequest = model.getRequests()[0];
		assert.ok(lastRequest.response, 'Response should exist after cancellation completes');
		assert.strictEqual(lastRequest.response.state, ResponseModelState.Cancelled, 'Response should be in Cancelled state');
	});

	test('cancelCurrentRequestForSession returns after timeout if response does not complete', async () => {
		const requestStarted = new DeferredPromise<void>();
		const completeRequest = new DeferredPromise<void>();

		const hangingAgent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				requestStarted.complete();
				// Wait for external signal, ignoring cancellation to simulate a hung agent
				await completeRequest.p;
				return {};
			},
		};

		testDisposables.add(chatAgentService.registerAgent('hangingAgent', { ...getAgentData('hangingAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('hangingAgent', hangingAgent));

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		const response = await testService.sendRequest(model.sessionResource, 'test request', { agentId: 'hangingAgent' });
		ChatSendResult.assertSent(response);

		await requestStarted.p;

		// Cancel should return after timeout even though the agent has not completed.
		// Use faked timers so raceTimeout's 1s setTimeout fires instantly.
		await runWithFakedTimers({ useFakeTimers: true }, async () => {
			await testService.cancelCurrentRequestForSession(model.sessionResource, 'test');
		});

		// Let the agent finish so the test cleans up properly
		completeRequest.complete();
		await response.data.responseCompletePromise;
	});

	test('pending requests can be removed from one session and re-sent on another', async () => {
		const requestStarted = new DeferredPromise<void>();
		const completeRequest = new DeferredPromise<void>();
		const invokedMessages: string[] = [];

		const slowAgent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				invokedMessages.push(request.message);
				if (invokedMessages.length === 1) {
					requestStarted.complete();
					await completeRequest.p;
				}
				return {};
			},
		};

		testDisposables.add(chatAgentService.registerAgent('slowAgent', { ...getAgentData('slowAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('slowAgent', slowAgent));

		const testService = createChatService();
		const sourceRef = testDisposables.add(startSessionModel(testService));
		const source = sourceRef.object;

		// Start a blocking request on source
		const response = await testService.sendRequest(source.sessionResource, 'first request', { agentId: 'slowAgent' });
		ChatSendResult.assertSent(response);
		await requestStarted.p;

		// Queue a request while the first is in progress
		const queued = await testService.sendRequest(source.sessionResource, 'queued request', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Queued });
		assert.ok(ChatSendResult.isQueued(queued));

		// Remove the queued request from source
		const pendingId = source.getPendingRequests()[0].request.id;
		testService.removePendingRequest(source.sessionResource, pendingId);
		assert.strictEqual(source.getPendingRequests().length, 0);

		// Re-send it on a new target session through the normal queue path
		const targetRef = testDisposables.add(startSessionModel(testService));
		const target = targetRef.object;
		const resent = await testService.sendRequest(target.sessionResource, 'queued request', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Queued, pauseQueue: true });
		assert.ok(ChatSendResult.isQueued(resent));
		assert.strictEqual(target.getPendingRequests().length, 1);

		// Complete the first request so the source loop finishes
		completeRequest.complete();
		await response.data.responseCompletePromise;

		// Process the target queue — the re-sent request should be invoked
		testService.processPendingRequests(target.sessionResource);
		const result = await resent.deferred;
		assert.ok(ChatSendResult.isSent(result));
		await result.data.responseCompletePromise;

		// The agent should have been invoked twice: first request + re-sent queued request
		assert.strictEqual(invokedMessages.length, 2);
		assert.ok(invokedMessages[1].includes('queued request'));
	});

	test('syncPendingRequestsFromRemote adds, reorders and removes pending requests preserving ids', async () => {
		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		testService.syncPendingRequestsFromRemote(model.sessionResource, [
			{ id: 'remote-1', kind: ChatRequestQueueKind.Queued, message: 'first remote message' },
			{ id: 'remote-2', kind: ChatRequestQueueKind.Queued, message: 'second remote message' },
		]);
		assert.deepStrictEqual(
			model.getPendingRequests().map(p => ({ id: p.request.id, kind: p.kind, text: p.request.message.text })),
			[
				{ id: 'remote-1', kind: ChatRequestQueueKind.Queued, text: 'first remote message' },
				{ id: 'remote-2', kind: ChatRequestQueueKind.Queued, text: 'second remote message' },
			],
		);

		const firstRequest = model.getPendingRequests()[0].request;

		// Reorder, drop one, add a steering message and update text of the survivor.
		testService.syncPendingRequestsFromRemote(model.sessionResource, [
			{ id: 'remote-steer', kind: ChatRequestQueueKind.Steering, message: 'steer now' },
			{ id: 'remote-1', kind: ChatRequestQueueKind.Queued, message: 'first remote message' },
		]);
		assert.deepStrictEqual(
			model.getPendingRequests().map(p => ({ id: p.request.id, kind: p.kind, text: p.request.message.text })),
			[
				{ id: 'remote-steer', kind: ChatRequestQueueKind.Steering, text: 'steer now' },
				{ id: 'remote-1', kind: ChatRequestQueueKind.Queued, text: 'first remote message' },
			],
		);
		assert.strictEqual(model.getPendingRequests()[1].request, firstRequest, 'unchanged messages should not be rebuilt');

		testService.syncPendingRequestsFromRemote(model.sessionResource, []);
		assert.strictEqual(model.getPendingRequests().length, 0);
	});

	test('syncPendingRequestsFromRemote atomically emits the final state and no-ops when it already matches', async () => {
		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		testService.syncPendingRequestsFromRemote(model.sessionResource, [
			{ id: 'remote-1', kind: ChatRequestQueueKind.Queued, message: 'old remote message' },
			{ id: 'remote-2', kind: ChatRequestQueueKind.Queued, message: 'removed remote message' },
		]);

		const snapshots: { id: string; kind: ChatRequestQueueKind; text: string }[][] = [];
		testDisposables.add(model.onDidChangePendingRequests(() => {
			snapshots.push(model.getPendingRequests().map(p => ({ id: p.request.id, kind: p.kind, text: p.request.message.text })));
		}));

		const remote = [
			{ id: 'remote-steer', kind: ChatRequestQueueKind.Steering, message: 'steer now' },
			{ id: 'remote-1', kind: ChatRequestQueueKind.Queued, message: 'updated remote message' },
		];
		testService.syncPendingRequestsFromRemote(model.sessionResource, remote);
		testService.syncPendingRequestsFromRemote(model.sessionResource, remote);

		assert.deepStrictEqual(snapshots, [[
			{ id: 'remote-steer', kind: ChatRequestQueueKind.Steering, text: 'steer now' },
			{ id: 'remote-1', kind: ChatRequestQueueKind.Queued, text: 'updated remote message' },
		]]);
	});

	test('syncPendingRequestsFromRemote preserves request ids and updates delegated message metadata', () => {
		const testService = createChatService();
		const model = testDisposables.add(startSessionModel(testService)).object;
		const request = {
			id: 'remote-delegated', kind: ChatRequestQueueKind.Queued, message: 'Delegated message',
			modelId: 'agent-host-copilot:claude-opus-4.8', modelConfiguration: { reasoningEffort: 'high' },
		};
		const firstMetadata = { 'test.provenance': { source: 'first' } };
		const secondMetadata = { 'test.provenance': { source: 'second' } };
		testService.syncPendingRequestsFromRemote(model.sessionResource, [{ ...request, metadata: firstMetadata }]);
		const first = model.getPendingRequests()[0];
		testService.syncPendingRequestsFromRemote(model.sessionResource, [{ ...request, metadata: secondMetadata }]);
		const second = model.getPendingRequests()[0];
		testService.syncPendingRequestsFromRemote(model.sessionResource, [{ ...request, metadata: { ...secondMetadata } }]);
		const unchanged = model.getPendingRequests()[0];
		testService.syncPendingRequestsFromRemote(model.sessionResource, [request]);
		assert.deepStrictEqual({
			first: first.sendOptions.metadata,
			second: second.sendOptions.metadata,
			unchanged: unchanged === second,
			requestIds: [first.request.id, second.request.id],
			cleared: model.getPendingRequests()[0].sendOptions.metadata,
			modelId: second.sendOptions.userSelectedModelId,
			modelConfiguration: second.sendOptions.userSelectedModelConfiguration,
		}, {
			first: firstMetadata, second: secondMetadata, unchanged: true, requestIds: [request.id, request.id], cleared: undefined,
			modelId: request.modelId, modelConfiguration: request.modelConfiguration,
		});
	});

	test('remote pending requests reconcile model-only edits and preserve selections on legacy text updates', async () => {
		const service = createChatService();
		const model = testDisposables.add(startSessionModel(service)).object;
		const modelId = 'agent-host-copilot:claude-opus-4.8';
		const modelConfiguration = { reasoningEffort: 'xhigh' };
		const remote = [
			{ id: 'steer', kind: ChatRequestQueueKind.Steering, message: 'steer', modelId, modelConfiguration },
			{ id: 'queue', kind: ChatRequestQueueKind.Queued, message: 'queue', modelId, modelConfiguration },
		];
		let changes = 0;
		testDisposables.add(model.onDidChangePendingRequests(() => changes++));
		service.syncPendingRequestsFromRemote(model.sessionResource, remote);
		const original = model.getPendingRequests()[0];
		service.syncPendingRequestsFromRemote(model.sessionResource, remote.map(request => ({ ...request, modelConfiguration: { ...modelConfiguration } })));
		const unchanged = model.getPendingRequests()[0] === original;
		service.syncPendingRequestsFromRemote(model.sessionResource, [
			{ ...remote[0], modelConfiguration: { reasoningEffort: 'max' } },
			{ ...remote[1], modelId: 'agent-host-copilot:auto', modelConfiguration: undefined },
		]);
		service.syncPendingRequestsFromRemote(model.sessionResource, [
			{ id: 'steer', kind: ChatRequestQueueKind.Steering, message: 'edited steer' },
			{ id: 'queue', kind: ChatRequestQueueKind.Queued, message: 'edited queue' },
		]);

		assert.deepStrictEqual({
			unchanged,
			changes,
			requests: model.getPendingRequests().map(pending => ({
				message: pending.request.message.text,
				modelId: pending.request.modelId,
				modelConfiguration: pending.request.modelConfiguration,
				sentModelId: pending.sendOptions.userSelectedModelId,
				sentModelConfiguration: pending.sendOptions.userSelectedModelConfiguration,
			})),
		}, {
			unchanged: true,
			changes: 3,
			requests: [
				{ message: 'edited steer', modelId, modelConfiguration: { reasoningEffort: 'max' }, sentModelId: modelId, sentModelConfiguration: { reasoningEffort: 'max' } },
				{ message: 'edited queue', modelId: 'agent-host-copilot:auto', modelConfiguration: undefined, sentModelId: 'agent-host-copilot:auto', sentModelConfiguration: undefined },
			],
		});
	});

	test('sendPendingRequestImmediately cancels current and sends the queued message on local sessions', async () => {
		const firstStarted = new DeferredPromise<void>();
		const secondInvoked = new DeferredPromise<void>();
		const invokedMessages: string[] = [];

		const slowAgent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				invokedMessages.push(request.message);
				if (invokedMessages.length === 1) {
					firstStarted.complete();
					await new Promise<void>(resolve => {
						const listener = token.onCancellationRequested(() => { listener.dispose(); resolve(); });
					});
				} else {
					secondInvoked.complete();
				}
				return {};
			},
		};

		testDisposables.add(chatAgentService.registerAgent('slowAgent', { ...getAgentData('slowAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('slowAgent', slowAgent));

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		const response = await testService.sendRequest(model.sessionResource, 'first request', { agentId: 'slowAgent' });
		ChatSendResult.assertSent(response);
		await firstStarted.p;

		const queued = await testService.sendRequest(model.sessionResource, 'queued message', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Queued });
		assert.ok(ChatSendResult.isQueued(queued));

		const pendingId = model.getPendingRequests()[0].request.id;
		await testService.sendPendingRequestImmediately(model.sessionResource, pendingId);
		await secondInvoked.p;

		assert.strictEqual(invokedMessages.length, 2);
		assert.ok(invokedMessages[1].includes('queued message'));
		assert.strictEqual(model.getPendingRequests().length, 0);
	});

	test('race condition: processNextPendingRequest dequeues before commit handler runs', async () => {
		// This reproduces the race where:
		// 1. Request 1 completes → .finally() calls processNextPendingRequest immediately
		// 2. processNextPendingRequest dequeues queued-request-1 and starts it on the OLD session
		// 3. Commit event arrives later → only sees remaining queued requests (one was already dequeued)
		// The fix: detect the in-flight request on the old session, cancel it, and re-send on the new session.

		const invocationOrder: string[] = [];
		const firstRequestStarted = new DeferredPromise<void>();
		const firstRequestGate = new DeferredPromise<void>();

		const slowAgent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				invocationOrder.push(request.message);

				if (invocationOrder.length === 1) {
					// First request — block until we say go
					firstRequestStarted.complete();
					await firstRequestGate.p;
				}
				// All subsequent requests complete immediately
				return {};
			},
		};

		testDisposables.add(chatAgentService.registerAgent('slowAgent', { ...getAgentData('slowAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('slowAgent', slowAgent));

		const testService = createChatService();
		const sourceRef = testDisposables.add(startSessionModel(testService));
		const source = sourceRef.object;

		// Step 1: Send request 1 (blocks on firstRequestGate)
		const response1 = await testService.sendRequest(source.sessionResource, 'request-1', { agentId: 'slowAgent' });
		ChatSendResult.assertSent(response1);
		await firstRequestStarted.p;

		// Step 2: Queue 3 more requests while request 1 is in progress
		const q1 = await testService.sendRequest(source.sessionResource, 'queued-1', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Queued });
		const q2 = await testService.sendRequest(source.sessionResource, 'queued-2', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Queued });
		const q3 = await testService.sendRequest(source.sessionResource, 'queued-3', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Queued });
		assert.ok(ChatSendResult.isQueued(q1));
		assert.ok(ChatSendResult.isQueued(q2));
		assert.ok(ChatSendResult.isQueued(q3));
		assert.strictEqual(source.getPendingRequests().length, 3);
		assert.strictEqual(source.getRequests().length, 1, 'Only request-1 should be a real request');

		// Step 3: Complete request 1 → .finally() runs processNextPendingRequest
		// This dequeues "queued-1" and starts it on the source (old) session
		firstRequestGate.complete();
		await response1.data.responseCompletePromise;

		// processNextPendingRequest dequeued one from the queue synchronously
		assert.strictEqual(source.getPendingRequests().length, 2, 'Should have 2 remaining after auto-dequeue');

		// Yield to let the dequeued request's async chain progress (extension activation, addRequest, etc.)
		await new Promise(resolve => setTimeout(resolve, 0));

		// Step 4: Simulate what _resendPendingRequests does (the commit handler)
		// This is the recovery: cancel the in-flight, remove remaining, re-send all on target
		const targetRef = testDisposables.add(startSessionModel(testService));
		const target = targetRef.object;

		// Cancel whatever is in-flight on the old session
		await testService.cancelCurrentRequestForSession(source.sessionResource);

		// Remove remaining pending requests from old session
		const remaining = [...source.getPendingRequests()];
		for (const p of remaining) {
			testService.removePendingRequest(source.sessionResource, p.request.id);
		}
		assert.strictEqual(source.getPendingRequests().length, 0);

		// Re-send ALL 3 on the target through the normal queue path
		const resent1 = await testService.sendRequest(target.sessionResource, 'queued-1', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Queued, pauseQueue: true });
		const resent2 = await testService.sendRequest(target.sessionResource, 'queued-2', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Queued, pauseQueue: true });
		const resent3 = await testService.sendRequest(target.sessionResource, 'queued-3', { agentId: 'slowAgent', queue: ChatRequestQueueKind.Queued, pauseQueue: true });
		assert.ok(ChatSendResult.isQueued(resent1));
		assert.ok(ChatSendResult.isQueued(resent2));
		assert.ok(ChatSendResult.isQueued(resent3));
		assert.strictEqual(target.getPendingRequests().length, 3, 'Target should have all 3 queued requests');

		// Step 5: Process the target queue and verify all 3 get sent
		testService.processPendingRequests(target.sessionResource);
		const result1 = await resent1.deferred;
		assert.ok(ChatSendResult.isSent(result1));
		await result1.data.responseCompletePromise;

		const result2 = await resent2.deferred;
		assert.ok(ChatSendResult.isSent(result2));
		await result2.data.responseCompletePromise;

		const result3 = await resent3.deferred;
		assert.ok(ChatSendResult.isSent(result3));
		await result3.data.responseCompletePromise;

		// Verify the agent received all 3 queued messages on the target session
		const queuedInvocations = invocationOrder.filter(m => m.includes('queued-'));
		assert.ok(queuedInvocations.length >= 3, `Expected at least 3 queued invocations, got ${queuedInvocations.length}`);
		const lastThree = queuedInvocations.slice(-3);
		assert.ok(lastThree[0].includes('queued-1'));
		assert.ok(lastThree[1].includes('queued-2'));
		assert.ok(lastThree[2].includes('queued-3'));
	});

	test('customization migration hint is not computed for local sessions', async () => {
		const migrationService = mockObject<ICustomizationMigrationService>()({ _serviceBrand: undefined });
		instantiationService.stub(ICustomizationMigrationService, migrationService);
		const testService = createChatService();
		const model = startSessionModel(testService).object;
		const response = await testService.sendRequest(model.sessionResource, 'test');
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		assert.deepStrictEqual({
			computeCalls: migrationService.computeMigrationHint.callCount,
			hints: (model.getRequests()[0].response?.response.value ?? [])
				.filter(part => part.kind === 'systemNotification').length,
		}, { computeCalls: 0, hints: 0 });
	});

	test('troubleshoot skill via attachedContext is blocked when fileLogging.enabled is off', async () => {
		const configService = instantiationService.get(IConfigurationService) as TestConfigurationService;
		await configService.setUserConfiguration(AGENT_DEBUG_LOG_FILE_LOGGING_ENABLED_SETTING, false);

		const troubleshootAgent: IChatAgentImplementation = {
			async invoke(_request, _progress, _history, _token) {
				return {};
			},
		};
		testDisposables.add(chatAgentService.registerAgent('troubleshootAgent', { ...getAgentData('troubleshootAgent'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('troubleshootAgent', troubleshootAgent));

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		const skillUri = URI.from({ scheme: COPILOT_SKILL_URI_SCHEME, path: TROUBLESHOOT_SKILL_PATH });
		const response = await testService.sendRequest(model.sessionResource, 'investigate this issue', {
			attachedContext: [{
				id: 'troubleshoot-skill',
				name: 'troubleshoot',
				kind: 'generic',
				value: skillUri,
			}],
		});
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		const requests = model.getRequests();
		assert.strictEqual(requests.length, 1);
		const responseContent = requests[0].response?.response.toString();
		assert.ok(responseContent?.includes(AGENT_DEBUG_LOG_FILE_LOGGING_ENABLED_SETTING), 'Response should mention the fileLogging setting');
	});

	test('troubleshoot skill via attachedContext proceeds when fileLogging.enabled is on', async () => {
		const configService = instantiationService.get(IConfigurationService) as TestConfigurationService;
		await configService.setUserConfiguration(AGENT_DEBUG_LOG_FILE_LOGGING_ENABLED_SETTING, true);

		const troubleshootAgent: IChatAgentImplementation = {
			async invoke(_request, progress, _history, _token) {
				progress([{ kind: 'markdownContent', content: new MarkdownString('Troubleshooting complete') }]);
				return {};
			},
		};
		testDisposables.add(chatAgentService.registerAgent('troubleshootAgent2', { ...getAgentData('troubleshootAgent2'), isDefault: true }));
		testDisposables.add(chatAgentService.registerAgentImplementation('troubleshootAgent2', troubleshootAgent));

		const testService = createChatService();
		const modelRef = testDisposables.add(startSessionModel(testService));
		const model = modelRef.object;

		const skillUri = URI.from({ scheme: COPILOT_SKILL_URI_SCHEME, path: TROUBLESHOOT_SKILL_PATH });
		const response = await testService.sendRequest(model.sessionResource, 'investigate this issue', {
			attachedContext: [{
				id: 'troubleshoot-skill',
				name: 'troubleshoot',
				kind: 'generic',
				value: skillUri,
			}],
		});
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		const requests = model.getRequests();
		assert.strictEqual(requests.length, 1);
		const responseContent = requests[0].response?.response.toString();
		assert.ok(!responseContent?.includes(AGENT_DEBUG_LOG_FILE_LOGGING_ENABLED_SETTING), 'Response should not contain the settings gate message');
	});

	test('switching between sessions disposes previous models and releases all references', async () => {
		const testService = createChatService();

		// Create 3 sessions with some content
		const sessions: { resource: URI; ref: IChatModelReference }[] = [];
		for (let i = 0; i < 3; i++) {
			const ref = testService.startNewLocalSession(ChatAgentLocation.Chat);
			const model = ref.object as ChatModel;
			model.addRequest({ parts: [], text: `request in session ${i}` }, { variables: [] }, 0);
			sessions.push({ resource: model.sessionResource, ref });
		}

		// Save all sessions so they can be restored later
		for (const s of sessions) {
			s.ref.dispose();
		}
		await testService.waitForModelDisposals();

		// Verify all models are disposed
		for (const s of sessions) {
			assert.strictEqual(testService.getSession(s.resource), undefined, `Session ${s.resource} should be disposed after ref release`);
		}

		// Now simulate "clicking through sessions" — load each one, switch to next
		// This mimics chatViewPane.loadSession() pattern: acquire new, release old
		let currentRef: IChatModelReference | undefined;
		for (const s of sessions) {
			const newRef = await testService.acquireOrLoadSession(s.resource, ChatAgentLocation.Chat, CancellationToken.None, 'test#switch');
			assert.ok(newRef, `Should be able to restore session ${s.resource}`);

			// Release old ref (like ChatViewPane.showModel does)
			currentRef?.dispose();
			currentRef = newRef;
		}

		// At this point, only the last session should have a live model
		await testService.waitForModelDisposals();
		const debugInfo = testService.getChatModelReferenceDebugInfo();
		assert.deepStrictEqual({
			totalModels: debugInfo.totalModels,
			totalReferences: debugInfo.totalReferences,
			models: debugInfo.models.map(m => ({
				resource: m.sessionResource.toString(),
				refCount: m.referenceCount,
				holders: m.holders,
				pendingDisposal: m.pendingDisposal,
				createdBy: m.createdBy,
			})),
		}, {
			totalModels: 1,
			totalReferences: 1,
			models: [{
				resource: sessions[2].resource.toString(),
				refCount: 1,
				holders: [{ holder: 'test#switch', count: 1 }],
				pendingDisposal: false,
				createdBy: 'test#switch',
			}],
		});
		assert.strictEqual(debugInfo.models[0].sessionResource.toString(), sessions[2].resource.toString(),
			'The live model should be the last session we switched to');

		// Verify the first two sessions' models are gone
		await testService.waitForModelDisposals();
		assert.strictEqual(testService.getSession(sessions[0].resource), undefined, 'Session 0 model should be disposed');
		assert.strictEqual(testService.getSession(sessions[1].resource), undefined, 'Session 1 model should be disposed');
		assert.ok(testService.getSession(sessions[2].resource), 'Session 2 model should still be alive');

		currentRef!.dispose();
		await testService.waitForModelDisposals();
	});

	test('previousModelRef pattern in ChatViewPane does not cause double-reference retention', async () => {
		const testService = createChatService();

		// Create 3 sessions
		const sessions: { resource: URI }[] = [];
		for (let i = 0; i < 3; i++) {
			const ref = testService.startNewLocalSession(ChatAgentLocation.Chat);
			const model = ref.object as ChatModel;
			model.addRequest({ parts: [], text: `request ${i}` }, { variables: [] }, 0);
			sessions.push({ resource: model.sessionResource });
			ref.dispose();
		}
		await testService.waitForModelDisposals();

		// Simulate the ChatViewPane._previousModelRef pattern:
		// showModel() does:
		//   this._previousModelRef.value = this.modelRef.value;  // <-- stores ref
		//   this.modelRef.value = undefined;                      // <-- disposes same ref!
		// This should NOT cause the model to stay alive because the
		// MutableDisposable setter disposes the old value after assigning the new one.

		// Load session 0
		const ref0 = await testService.acquireOrLoadSession(sessions[0].resource, ChatAgentLocation.Chat, CancellationToken.None, 'test');
		assert.ok(ref0);

		// "Switch" to session 1 using the buggy pattern
		const previousRef = ref0; // save reference (like _previousModelRef.value = modelRef.value)
		// Now dispose the ref (like modelRef.value = undefined which disposes via setter)
		ref0.dispose();

		// The previousRef IS ref0 — same object. It's now disposed.
		// So previousRef is holding a dead reference.

		// Load session 1
		const ref1 = await testService.acquireOrLoadSession(sessions[1].resource, ChatAgentLocation.Chat, CancellationToken.None, 'test');
		assert.ok(ref1);

		await testService.waitForModelDisposals();

		// Session 0 should be disposed because its ref was disposed and
		// previousRef is the same object (also disposed)
		assert.strictEqual(testService.getSession(sessions[0].resource), undefined,
			'Session 0 should be disposed -- the "previous ref" pattern did not keep it alive');

		// Only session 1 should be alive
		const debugInfo = testService.getChatModelReferenceDebugInfo();
		assert.strictEqual(debugInfo.totalModels, 1, 'Only session 1 should be alive');

		ref1.dispose();
		// Clean up previousRef — it's already disposed, calling again should be a no-op
		previousRef.dispose();
		await testService.waitForModelDisposals();
	});

	test('serializer _previous field does not retain data after model disposal', async () => {
		const testService = createChatService();

		// Create a session with content
		const ref = testService.startNewLocalSession(ChatAgentLocation.Chat);
		const model = ref.object as ChatModel;
		const sessionResource = model.sessionResource;
		model.addRequest({ parts: [], text: 'some request with data' }, { variables: [] }, 0);

		// Force serialization to populate dataSerializer._previous
		// (happens in willDisposeModel)
		ref.dispose();
		await testService.waitForModelDisposals();

		// Model should be gone
		assert.strictEqual(testService.getSession(sessionResource), undefined);

		// Restore and dispose again to verify clean disposal cycle
		const ref2 = await testService.acquireOrLoadSession(sessionResource, ChatAgentLocation.Chat, CancellationToken.None, 'test');
		assert.ok(ref2);
		const model2 = ref2.object as ChatModel;
		assert.ok(model2.dataSerializer, 'Restored model should have a dataSerializer');

		ref2.dispose();
		await testService.waitForModelDisposals();
		assert.strictEqual(testService.getSession(sessionResource), undefined, 'Model should be disposed after second cycle');
	});

	test('model becomes unreachable after all references released', async () => {
		const testService = createChatService();

		// Create a session with non-trivial content to track
		const ref = testService.startNewLocalSession(ChatAgentLocation.Chat);
		let model: ChatModel | undefined = ref.object as ChatModel;
		const sessionResource = model.sessionResource;
		model.addRequest({ parts: [], text: 'a request' }, { variables: [] }, 0);

		// Use WeakRef to detect GC
		const weakModel = new WeakRef(model);

		// Dispose the reference and clear the local strong reference
		ref.dispose();
		model = undefined;
		await testService.waitForModelDisposals();

		// Model should not be in the store
		assert.strictEqual(testService.getSession(sessionResource), undefined, 'Model should be gone from store');

		// The reference debug snapshot should show no models
		const debugInfo = testService.getChatModelReferenceDebugInfo();
		assert.strictEqual(debugInfo.totalModels, 0, 'No models should be tracked');

		// Force GC and check weak ref
		if (typeof globalThis.gc === 'function') {
			globalThis.gc();
			// After GC, the weak reference should be cleared
			assert.strictEqual(weakModel.deref(), undefined, 'Model should be GC\'d after all references released');
		}
	});

	test('rapid session switching accumulates at most 2 live models', async () => {
		const testService = createChatService();

		// Create 5 sessions with content
		const sessionResources: URI[] = [];
		for (let i = 0; i < 5; i++) {
			const ref = testService.startNewLocalSession(ChatAgentLocation.Chat);
			const model = ref.object as ChatModel;
			model.addRequest({ parts: [], text: `session ${i} request` }, { variables: [] }, 0);
			sessionResources.push(model.sessionResource);
			ref.dispose();
		}
		await testService.waitForModelDisposals();

		// Now rapidly switch through all sessions without waiting for disposal
		let currentRef: IChatModelReference | undefined;
		for (const resource of sessionResources) {
			const newRef = await testService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, CancellationToken.None, 'test#rapid');
			assert.ok(newRef);
			currentRef?.dispose();
			currentRef = newRef;
		}

		// After waiting for disposals, should be exactly 1
		await testService.waitForModelDisposals();
		const finalDebugInfo = testService.getChatModelReferenceDebugInfo();
		assert.strictEqual(finalDebugInfo.totalModels, 1, 'Should have exactly 1 model after waiting for disposals');

		currentRef!.dispose();
		await testService.waitForModelDisposals();
	});

	test('onWillSaveState persists session index synchronously so it survives reload', async () => {
		const testService = createChatService();
		const storageService = instantiationService.get(IStorageService) as TestStorageService;

		// Create a session with a request so it qualifies for persistence
		const ref = testService.startNewLocalSession(ChatAgentLocation.Chat);
		const model = ref.object as ChatModel;
		model.addRequest({ parts: [], text: 'hello world' }, { variables: [] }, 0);

		// Simulate what the storage service does before shutdown:
		// fire onWillSaveState synchronously, then flush.
		storageService.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		// Create a second ChatService from the same storage (simulating
		// window reload). The session must be discoverable in history
		// IMMEDIATELY — no async work from the first service needs to
		// have completed.
		const testService2 = createChatService();
		const historyItems = await testService2.getHistorySessionItems();
		assert.ok(
			historyItems.some(item => item.sessionResource.toString() === model.sessionResource.toString()),
			`Session ${model.sessionResource} should appear in history after onWillSaveState. Got: ${historyItems.map(i => i.sessionResource.toString()).join(', ')}`
		);

		// Clean up
		ref.dispose();
	});

	test('moving an autosaved empty session with a handoff reference preserves its transcript after restart', async () => {
		const fileService = testDisposables.add(new FileService(new NullLogService()));
		testDisposables.add(fileService.registerProvider(Schemas.file, testDisposables.add(new InMemoryFileSystemProvider())));
		instantiationService.stub(IFileService, fileService);
		const testService = createChatService();
		instantiationService.stub(IChatService, testService);
		const sidebarRef = startSessionModel(testService);
		const resource = sidebarRef.object.sessionResource;
		const storageService = instantiationService.get(IStorageService) as TestStorageService;
		storageService.testEmitWillSaveState(WillSaveStateReason.NONE);
		await testService.getHistorySessionItems();

		const handoffRef = testService.acquireExistingSession(resource, 'test#move');
		assert.ok(handoffRef);
		testDisposables.add(handoffRef);
		sidebarRef.dispose();
		await testService.waitForModelDisposals();
		const editorRef = await testService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, CancellationToken.None);
		assert.ok(editorRef);
		testDisposables.add(editorRef);
		handoffRef.dispose();

		const response = await testService.sendRequest(resource, 'message in detached window');
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;
		editorRef.dispose();
		await testService.waitForModelDisposals();

		const restartedService = createChatService();
		instantiationService.stub(IChatService, restartedService);
		const history = await restartedService.getHistorySessionItems();
		const restoredModel = await getOrRestoreModel(restartedService, resource);
		const localSessionId = LocalChatSessionUri.parseLocalSessionId(resource);
		const log = await fileService.readFile(URI.joinPath(testService.getChatStorageFolder(), `${localSessionId}.jsonl`));
		const firstLogEntry = JSON.parse(log.value.toString().split('\n')[0]) as { kind: number };
		assert.deepStrictEqual({
			firstLogEntryKind: firstLogEntry.kind,
			history: history.map(item => item.sessionResource),
			requests: restoredModel?.getRequests().map(request => request.message.text),
		}, {
			firstLogEntryKind: 0,
			history: [resource],
			requests: ['message in detached window'],
		});
	});

	test('removeHistoryEntry marks model as deleted and excludes from getLiveSessionItems', async () => {
		testDisposables.add(chatAgentService.registerAgentImplementation(chatAgentWithMarkdownId, chatAgentWithMarkdown));

		const testService = createChatService();

		// Create a session and send a message so it has requests
		const ref = testDisposables.add(startSessionModel(testService));
		const model = ref.object;
		const response = await testService.sendRequest(model.sessionResource, `@${chatAgentWithMarkdownId} test request`);
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;
		assert.strictEqual(model.getRequests().length, 1);

		// Verify the session appears in live session items
		const liveItemsBefore = await testService.getLiveSessionItems();
		assert.ok(
			liveItemsBefore.some(item => item.sessionResource.toString() === model.sessionResource.toString()),
			'Session should appear in getLiveSessionItems before deletion'
		);

		// Delete the session
		await testService.removeHistoryEntry(model.sessionResource);

		// Verify the session no longer appears in live session items
		const liveItemsAfter = await testService.getLiveSessionItems();
		assert.ok(
			!liveItemsAfter.some(item => item.sessionResource.toString() === model.sessionResource.toString()),
			'Session should NOT appear in getLiveSessionItems after deletion'
		);

		// Verify onDidDisposeSession was fired
		// (model is still alive because ref holds it, but it's marked deleted)
		assert.strictEqual((model as ChatModel).isDeleted, true);
	});

	test('removeHistoryEntry prevents re-saving on model disposal', async () => {
		testDisposables.add(chatAgentService.registerAgentImplementation(chatAgentWithMarkdownId, chatAgentWithMarkdown));

		const testService = createChatService();

		// Create a session with a request
		const ref = testDisposables.add(startSessionModel(testService));
		const model = ref.object;
		const response = await testService.sendRequest(model.sessionResource, `@${chatAgentWithMarkdownId} test request`);
		ChatSendResult.assertSent(response);
		await response.data.responseCompletePromise;

		// Delete the history entry
		await testService.removeHistoryEntry(model.sessionResource);

		// Release the model reference — this triggers willDisposeModel
		ref.dispose();
		await testService.waitForModelDisposals();

		// Verify the session does NOT reappear in history after disposal
		const testService2 = createChatService();
		const historyItems = await testService2.getHistorySessionItems();
		assert.ok(
			!historyItems.some(item => item.sessionResource.toString() === model.sessionResource.toString()),
			'Deleted session should NOT reappear in history after model disposal'
		);
	});
});

suite('backfillRestoredPickerState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const AGENT = 'agent';
	const model = (identifier: string): ISerializableChatModelInputState['selectedModel'] => ({
		identifier,
		metadata: {
			id: identifier, name: identifier, vendor: 'copilot', version: '1.0', family: 'test',
			extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024,
			isDefaultForLocation: {}
		}
	});
	const state = (modeId: string, selectedModel: ISerializableChatModelInputState['selectedModel']): ISerializableChatModelInputState => ({
		attachments: [], mode: { id: modeId, kind: ChatModeKind.Agent }, selectedModel, inputText: '', selections: [], contrib: {}
	});

	test('does not backfill selectedModel from stored state when the chosen state has none', () => {
		const result = backfillRestoredPickerState(state(AGENT, undefined), state(AGENT, model('agent-host-claude:opus')), AGENT);
		assert.strictEqual(result?.selectedModel, undefined);
	});

	test('keeps the chosen model when present (never overrides it with the stored one)', () => {
		const result = backfillRestoredPickerState(state(AGENT, model('agent-host-claude:opus')), state(AGENT, model('agent-host-claude:haiku')), AGENT);
		assert.strictEqual(result?.selectedModel?.identifier, 'agent-host-claude:opus');
	});

	test('promotes a stored custom agent over the default Agent only, never over an explicit mode', () => {
		assert.strictEqual(backfillRestoredPickerState(state(AGENT, undefined), state('custom-uri', undefined), AGENT)?.mode.id, 'custom-uri', 'default Agent → stored custom agent');
		assert.strictEqual(backfillRestoredPickerState(state('other-uri', undefined), state('custom-uri', undefined), AGENT)?.mode.id, 'other-uri', 'explicit mode is not overridden');
		assert.strictEqual(backfillRestoredPickerState(state(AGENT, undefined), state(AGENT, undefined), AGENT)?.mode.id, AGENT, 'stored default Agent leaves chosen Agent');
	});

	test('returns the chosen state unchanged when there is no stored state', () => {
		const chosen = state(AGENT, undefined);
		assert.strictEqual(backfillRestoredPickerState(chosen, undefined, AGENT), chosen);
	});
});

suite('backfillTransferredModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const AGENT = 'agent';
	const model = (identifier: string): ISerializableChatModelInputState['selectedModel'] => ({
		identifier,
		metadata: {
			id: identifier, name: identifier, vendor: 'copilot', version: '1.0', family: 'test',
			extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024,
			isDefaultForLocation: {}
		}
	});
	const state = (selectedModel: ISerializableChatModelInputState['selectedModel']): ISerializableChatModelInputState => ({
		attachments: [], mode: { id: AGENT, kind: ChatModeKind.Agent }, selectedModel, inputText: '', selections: [], contrib: {}
	});

	test('backfills the history model when the transferred state dropped its model', () => {
		const history = model('agent-host-copilotcli:gpt-5.6-sol');
		const result = backfillTransferredModel(state(undefined), history);
		assert.strictEqual(result?.selectedModel?.identifier, 'agent-host-copilotcli:gpt-5.6-sol');
	});

	test('never overrides a model already present on the transferred state', () => {
		const result = backfillTransferredModel(state(model('agent-host-copilotcli:gpt-5.6-terra')), model('agent-host-copilotcli:gpt-5.6-sol'));
		assert.strictEqual(result?.selectedModel?.identifier, 'agent-host-copilotcli:gpt-5.6-terra');
	});

	test('leaves the state unchanged when there is no history model', () => {
		const chosen = state(undefined);
		assert.strictEqual(backfillTransferredModel(chosen, undefined), chosen);
		assert.strictEqual(chosen.selectedModel, undefined);
	});

	test('returns undefined state as-is', () => {
		assert.strictEqual(backfillTransferredModel(undefined, model('agent-host-copilotcli:gpt-5.6-sol')), undefined);
	});
});


function toSnapshotExportData(model: IChatModel) {
	const exp = model.toExport();
	return {
		...exp,
		requests: exp.requests.map(r => {
			// Destructure properties after `vote` so we can insert `voteDownReason` in the correct position for snapshot compat
			const { slashCommand, usedContext, contentReferences, codeCitations, timeSpentWaiting, isSystemInitiated: _isSystemInitiated, systemInitiatedLabel: _systemInitiatedLabel, responseTimestamp: _responseTimestamp, elapsedMs: _elapsedMs, completionTokens: _completionTokens, promptTokens: _promptTokens, outputBuffer: _outputBuffer, promptTokenDetails: _promptTokenDetails, copilotCredits: _copilotCredits, ...rest } = r;
			return {
				...rest,
				modelState: {
					...r.modelState,
					completedAt: undefined
				},
				timestamp: undefined,
				requestId: undefined, // id contains a random part
				responseId: undefined, // id contains a random part
				voteDownReason: undefined, // removed from model, kept for snapshot compat
				slashCommand,
				usedContext,
				contentReferences,
				codeCitations,
				timeSpentWaiting,
			};
		})
	};
}
