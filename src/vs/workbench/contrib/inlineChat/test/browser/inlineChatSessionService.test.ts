/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { observableValue, waitForState } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IActiveCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelContentProvider, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IWorkbenchAssignmentService } from '../../../../services/assignment/common/assignmentService.js';
import { NullWorkbenchAssignmentService } from '../../../../services/assignment/test/common/nullAssignmentService.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ChatEditingService } from '../../../chat/browser/chatEditing/chatEditingServiceImpl.js';
import { ChatEditingSession } from '../../../chat/browser/chatEditing/chatEditingSession.js';
import { ChatSessionsService } from '../../../chat/browser/chatSessions/chatSessions.contribution.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { ChatService } from '../../../chat/common/chatService/chatServiceImpl.js';
import { ChatAgentLocation, ChatModeKind } from '../../../chat/common/constants.js';
import { IChatEditingService } from '../../../chat/common/editing/chatEditingService.js';
import { ChatModel } from '../../../chat/common/model/chatModel.js';
import { IChatAgentData, IChatAgentImplementation, IChatAgentService, ChatAgentService } from '../../../chat/common/participants/chatAgents.js';
import { IChatSessionsService } from '../../../chat/common/chatSessionsService.js';
import { IChatDebugService } from '../../../chat/common/chatDebugService.js';
import { ChatDebugServiceImpl } from '../../../chat/common/chatDebugServiceImpl.js';
import { IChatSlashCommandService } from '../../../chat/common/participants/chatSlashCommands.js';
import { ChatTransferService, IChatTransferService } from '../../../chat/common/model/chatTransferService.js';
import { IChatVariablesService } from '../../../chat/common/attachments/chatVariables.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { ICustomizationMigrationService } from '../../../chat/common/promptSyntax/service/customizationMigrationService.js';
import { ICustomizationMigrationTelemetryService } from '../../../chat/common/promptSyntax/service/customizationMigrationTelemetryService.js';
import { IPromptsService } from '../../../chat/common/promptSyntax/service/promptsService.js';
import { MockChatVariablesService } from '../../../chat/test/common/mockChatVariables.js';
import { NullLanguageModelsService } from '../../../chat/test/common/languageModels.js';
import { MockPromptsService } from '../../../chat/test/common/promptSyntax/service/mockPromptsService.js';
import { IMcpService } from '../../../mcp/common/mcpTypes.js';
import { TestMcpService } from '../../../mcp/test/common/testMcpService.js';
import { IMultiDiffSourceResolver, IMultiDiffSourceResolverService } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { INotebookService } from '../../../notebook/common/notebookService.js';
import { NotebookTextModel } from '../../../notebook/common/model/notebookTextModel.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IInlineChatSession } from '../../browser/inlineChatSessionService.js';
import { InlineChatSessionServiceImpl } from '../../browser/inlineChatSessionServiceImpl.js';
import { IInlineChatSessionResolver, IInlineChatSessionResolution } from '../../browser/inlineChatSessionResolver.js';
import { TestWorkerService } from './testWorkerService.js';

class TestInlineChatSessionResolver extends mock<IInlineChatSessionResolver>() {
	chatService!: IChatService;
	resolveCalls = 0;

	override async resolve(_token: CancellationToken, _languageId: string | undefined, _targetUri: URI): Promise<IInlineChatSessionResolution> {
		this.resolveCalls++;
		return {
			modelRef: this.chatService.startNewLocalSession(ChatAgentLocation.EditorInline, { canUseTools: false }),
		};
	}
}

class TestTextModelService extends mock<ITextModelService>() {
	private readonly _models = new Map<string, ITextModel>();
	private readonly _providers = new Map<string, ITextModelContentProvider>();

	override registerTextModelContentProvider(scheme: string, provider: ITextModelContentProvider) {
		this._providers.set(scheme, provider);
		return toDisposable(() => this._providers.delete(scheme));
	}

	add(model: ITextModel): void {
		this._models.set(model.uri.toString(), model);
	}

	override async createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
		let model = this._models.get(resource.toString());
		if (!model) {
			model = await this._providers.get(resource.scheme)?.provideTextContent(resource) ?? undefined;
			if (model) {
				this.add(model);
			}
		}
		assert.ok(model, `Expected a text model for ${resource}`);
		return {
			object: { textEditorModel: model } as IResolvedTextEditorModel,
			dispose: () => { },
		};
	}
}

function getAgentData(): IChatAgentData {
	return {
		name: 'inlineChatTestAgent',
		id: 'inlineChatTestAgent',
		extensionId: nullExtensionDescription.identifier,
		extensionVersion: undefined,
		extensionPublisherId: '',
		publisherDisplayName: '',
		extensionDisplayName: '',
		locations: [ChatAgentLocation.EditorInline],
		modes: [ChatModeKind.Ask],
		metadata: {},
		slashCommands: [],
		disambiguation: [],
	};
}

suite('InlineChatSessionService', () => {
	const store = new DisposableStore();
	let service: InlineChatSessionServiceImpl;
	let chatService: IChatService;
	let modelService: IModelService;
	let resolver: TestInlineChatSessionResolver;
	let textModelService: TestTextModelService;

	setup(() => {
		const collection = new ServiceCollection();
		collection.set(IWorkbenchAssignmentService, new NullWorkbenchAssignmentService());
		collection.set(IChatAgentService, new SyncDescriptor(ChatAgentService));
		collection.set(IChatVariablesService, new MockChatVariablesService());
		collection.set(IChatSlashCommandService, new class extends mock<IChatSlashCommandService>() { });
		collection.set(IChatTransferService, new SyncDescriptor(ChatTransferService));
		collection.set(IChatSessionsService, new SyncDescriptor(ChatSessionsService));
		collection.set(IChatEditingService, new SyncDescriptor(ChatEditingService));
		collection.set(IEditorWorkerService, new SyncDescriptor(TestWorkerService));
		collection.set(IChatService, new SyncDescriptor(ChatService));
		collection.set(IMcpService, new TestMcpService());
		collection.set(ICustomizationMigrationService, new class extends mock<ICustomizationMigrationService>() { });
		collection.set(ICustomizationMigrationTelemetryService, new class extends mock<ICustomizationMigrationTelemetryService>() { });
		collection.set(IPromptsService, new MockPromptsService());
		collection.set(ILanguageModelsService, new SyncDescriptor(NullLanguageModelsService));
		collection.set(IChatDebugService, store.add(new ChatDebugServiceImpl(new TestConfigurationService(), store.add(new MockContextKeyService()))));
		collection.set(IMultiDiffSourceResolverService, new class extends mock<IMultiDiffSourceResolverService>() {
			override registerResolver(_resolver: IMultiDiffSourceResolver) {
				return Disposable.None;
			}
		});
		collection.set(IWorkspaceEditingService, new class extends mock<IWorkspaceEditingService>() {
			override readonly onDidEnterWorkspace = Event.None;
		});
		collection.set(INotebookService, new class extends mock<INotebookService>() {
			override getNotebookTextModel(_uri: URI): NotebookTextModel | undefined {
				return undefined;
			}

			override hasSupportedNotebooks(_resource: URI): boolean {
				return false;
			}
		});

		resolver = new TestInlineChatSessionResolver();
		textModelService = new TestTextModelService();
		collection.set(IInlineChatSessionResolver, resolver);
		collection.set(ITextModelService, textModelService);

		const instantiationService = store.add(store.add(workbenchInstantiationService(undefined, store)).createChild(collection));
		store.add(instantiationService.get(IEditorWorkerService) as TestWorkerService);
		store.add(instantiationService.get(IChatSessionsService) as ChatSessionsService);
		chatService = instantiationService.get(IChatService);
		store.add(chatService as ChatService);
		chatService.setSaveModelsEnabled(false);
		modelService = instantiationService.get(IModelService);
		resolver.chatService = chatService;

		const chatAgentService = instantiationService.get(IChatAgentService);
		const agent: IChatAgentImplementation = {
			async invoke() {
				return {};
			},
		};
		store.add(chatAgentService.registerAgent('inlineChatTestAgent', { ...getAgentData(), isDefault: true }));
		store.add(chatAgentService.registerAgentImplementation('inlineChatTestAgent', agent));

		service = store.add(instantiationService.createInstance(InlineChatSessionServiceImpl));
	});

	teardown(() => {
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the legacy editing session without Agent Host locking', async () => {
		const session = await service.createSession(createEditor(createModel(URI.from({ scheme: Schemas.file, path: '/test/legacy.ts' }))), false, CancellationToken.None);

		assert.deepStrictEqual({
			usesChatModelEditingSession: session.editingSession === session.chatModel.editingSession,
		}, {
			usesChatModelEditingSession: true,
		});

		await disposeSession(session);
	});

	test('uses the legacy path without resolving Agent Host for untitled documents', async () => {

		const session = await service.createSession(createEditor(createModel(URI.from({ scheme: Schemas.untitled, path: '/test/untitled.ts' }))), false, CancellationToken.None);

		assert.deepStrictEqual({
			resolveCalls: resolver.resolveCalls,
			usesChatModelEditingSession: session.editingSession === session.chatModel.editingSession,
		}, {
			resolveCalls: 0,
			usesChatModelEditingSession: true,
		});

		await disposeSession(session);
	});

	test('uses the legacy path without resolving Agent Host for notebooks', async () => {

		const session = await service.createSession(createEditor(createModel(URI.from({ scheme: Schemas.file, path: '/test/notebook.ts' }))), true, CancellationToken.None);

		assert.deepStrictEqual({
			resolveCalls: resolver.resolveCalls,
			usesChatModelEditingSession: session.editingSession === session.chatModel.editingSession,
		}, {
			resolveCalls: 0,
			usesChatModelEditingSession: true,
		});

		await disposeSession(session);
	});

	function createModel(uri: URI): ITextModel {
		const model = store.add(modelService.createModel('const value = 1;', null, uri, false));
		textModelService.add(model);
		return model;
	}

	function createEditor(model: ITextModel): IActiveCodeEditor {
		return new class extends mock<IActiveCodeEditor>() {
			override getModel(): ITextModel {
				return model;
			}

			override getSelection(): Selection {
				return new Selection(1, 1, 1, 1);
			}
		}();
	}

	async function disposeSession(session: IInlineChatSession): Promise<void> {
		await session.editingSession.reject();
		if (session.editingSession instanceof ChatEditingSession) {
			await session.editingSession.stop();
		}
		session.dispose();
	}
});
