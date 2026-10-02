/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { chatUserInteractionAttributes, IChatUserInteractionTiming, ReportChatUserInteractionCommand } from '../../../../../platform/otel/common/chatUserInteraction.js';
import { ChatUserInteractionOTelService } from '../../browser/chatUserInteractionOTel.js';

suite('ChatUserInteractionOTel', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const timing: IChatUserInteractionTiming = {
		schemaVersion: 1, rendererId: 'renderer', interactionOrdinal: 1,
		result: 'hidden', requestPhase: 'unknown', timeToTermination: 0,
		windowVisible: false, windowFocused: false,
	};

	test('allowlists content-free fields and rejects invalid success or termination data', () => {
		const attributes = chatUserInteractionAttributes({ ...timing, prompt: 'private', chatSessionId: 'file:///private' });
		assert.strictEqual(attributes['vscode.chat.user_interaction.timeToTermination'], 0);
		assert.strictEqual(Object.keys(attributes).length, Object.keys(timing).length);
		for (const override of [
			{ timeToTermination: NaN }, { timeToTermination: -1 }, { timeToTermination: Infinity },
			{ interactionOrdinal: 0 }, { interactionOrdinal: 1.5 }, { schemaVersion: 2 },
			{ result: 'success' }, { result: 'bogus' }, { requestId: 'file:///private' },
			{ timeToFirstProgress: 0 }, { firstProgressKind: 'text' },
		]) {
			assert.throws(() => chatUserInteractionAttributes({ ...timing, ...override }));
		}
	});

	test('routes generic chat observations to the extension command and flushes asynchronous deliveries', async () => {
		const calls: string[] = [];
		let release: () => void = () => { };
		const wait = new Promise<void>(resolve => { release = resolve; });
		const service = new ChatUserInteractionOTelService(
			upcastPartial<ICommandService>({
				executeCommand: async command => { await wait; calls.push(command); return undefined; },
			}),
			new NullLogService(),
		);
		disposables.add(CommandsRegistry.registerCommand(ReportChatUserInteractionCommand, () => { }));
		service.report({ ...timing, ...service.begin() }, undefined, 'local');
		const flushed = service.flush();
		assert.deepStrictEqual(calls, []);
		release();
		assert.deepStrictEqual(await flushed, { schemaVersion: 1, started: 1, completed: 1, failed: 0 });
		assert.deepStrictEqual(calls, [ReportChatUserInteractionCommand]);
	});

	test('fails observations without a session type', async () => {
		const calls: string[] = [];
		const warnings: string[] = [];
		disposables.add(CommandsRegistry.registerCommand(ReportChatUserInteractionCommand, () => { }));
		const service = new ChatUserInteractionOTelService(
			upcastPartial<ICommandService>({ executeCommand: async command => { calls.push(command); } }),
			new class extends NullLogService {
				override warn(message: string) { warnings.push(message); }
			}(),
		);
		for (const result of ['notDispatched', 'error', 'cancelled', 'hidden', 'disposed'] as const) {
			service.report({ ...timing, ...service.begin(), result }, undefined, undefined);
		}
		assert.deepStrictEqual({ result: await service.flush(), calls, warnings }, {
			result: { schemaVersion: 1, started: 5, completed: 5, failed: 5 },
			calls: [],
			warnings: Array(5).fill('[ChatTTFP] OTel export failed'),
		});
	});

	test('logs extension export failures and surfaces them through flush', async () => {
		const warnings: unknown[] = [];
		const service = new ChatUserInteractionOTelService(
			upcastPartial<ICommandService>({ executeCommand: async () => { throw new Error('transport disconnected'); } }),
			new class extends NullLogService {
				override warn(message: string, ...args: unknown[]) { warnings.push(message, ...args); }
			}(),
		);
		disposables.add(CommandsRegistry.registerCommand(ReportChatUserInteractionCommand, () => { }));
		service.report({ ...timing, ...service.begin() }, undefined, 'local');
		assert.strictEqual((await service.flush()).failed, 1);
		assert.strictEqual(warnings[0], '[ChatTTFP] OTel export failed');
	});
});
