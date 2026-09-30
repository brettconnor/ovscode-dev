/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { OpenCircuitCancellationToken, OpenCircuitNativeAdapter } from '../../node/openCircuitNativeAdapter.js';

const transportModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../node/stdioRpc.js')).href;
const backendSource = `
const { runStdioRpcServer } = await import(${JSON.stringify(transportModule)});
const sessions = new Map();
await runStdioRpcServer({
  'backend/ready': () => ({ contractVersion: 1, coreVersion: 'test-core' }),
  'models.list': () => [{ id: 'test-model', name: 'Test Model' }],
  'chat.create': payload => { const session = { sessionId: 'core-owned-session', title: payload.title ?? '', workspaceUri: payload.workspaceUri, createdAt: new Date(0).toISOString(), messageCount: 0, revision: 0, transcript: [] }; sessions.set(session.sessionId, session); return { sessionId: session.sessionId }; },
  'chat.list': () => Array.from(sessions.values()),
  'chat.restore': payload => sessions.get(payload.sessionId),
  'chat.save': payload => { sessions.set(payload.chat.sessionId, payload.snapshot); },
  'chat.delete': payload => { sessions.delete(payload.sessionId); },
  'chat.runTurn': async (payload, context) => {
    await context.emit({ type: 'turnStarted' });
    if (payload.input.text === 'cancel') {
      await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
      return;
    }
    for (let index = 0; index < 40; index++) await context.emit({ type: 'assistantText', text: String(index) });
    await context.emit({ type: 'turnCompleted' });
  }
});
`;

class TestCancellationToken implements OpenCircuitCancellationToken {
	private readonly _listeners = new Set<() => void>();
	isCancellationRequested = false;

	onCancellationRequested(listener: () => void): { dispose(): void } {
		this._listeners.add(listener);
		return { dispose: () => this._listeners.delete(listener) };
	}

	cancel(): void {
		this.isCancellationRequested = true;
		for (const listener of this._listeners) {
			listener();
		}
	}
}

suite('OpenCircuitNativeAdapter', () => {
	test('maps session DTOs and streams Core events through a real backend process', async () => {
		const userDataPath = mkdtempSync(join(tmpdir(), 'ovscode-opencircuit-adapter-'));
		const backendPath = join(userDataPath, 'backend.mjs');
		writeFileSync(backendPath, backendSource);
		const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
		const adapter = new OpenCircuitNativeAdapter();
		try {
			assert.deepStrictEqual(await adapter.start({ entrypoint: backendPath, userDataPath, environment }), { contractVersion: 1, coreVersion: 'test-core' });
			assert.deepStrictEqual(await adapter.listModels(), [{ id: 'test-model', name: 'Test Model' }]);
			const chat = await adapter.createChat({ title: 'Example', workspaceUri: 'file:///workspace' });
			assert.deepStrictEqual(chat, { sessionId: 'core-owned-session' });
			const listed = await adapter.listChats({ workspaceUri: 'file:///workspace' });
			assert.strictEqual(listed[0].sessionId, chat.sessionId);
			const snapshot = await adapter.restoreChat(chat);
			assert.strictEqual(snapshot.revision, 0);
			await adapter.saveChat(chat, { ...snapshot, revision: 1 });
			const events = [];
			for await (const event of adapter.runTurn(chat, { text: 'hello' }, new TestCancellationToken())) {
				await new Promise(resolve => setTimeout(resolve, 1));
				events.push(event);
			}
			assert.strictEqual(events[0].type, 'turnStarted');
			assert.strictEqual(events.at(-1)?.type, 'turnCompleted');
			assert.strictEqual(events.filter(event => event.type === 'assistantText').length, 40);
			await adapter.deleteChat(chat);
			assert.deepStrictEqual(await adapter.listChats(), []);
		} finally {
			await adapter.dispose();
			rmSync(userDataPath, { recursive: true, force: true });
		}
	});

	test('maps UI cancellation to the process protocol and ends the stream', async () => {
		const userDataPath = mkdtempSync(join(tmpdir(), 'ovscode-opencircuit-cancel-'));
		const backendPath = join(userDataPath, 'backend.mjs');
		writeFileSync(backendPath, backendSource);
		const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
		const adapter = new OpenCircuitNativeAdapter();
		const token = new TestCancellationToken();
		try {
			await adapter.start({ entrypoint: backendPath, userDataPath, environment });
			const events = adapter.runTurn({ sessionId: 'core-owned-session' }, { text: 'cancel' }, token)[Symbol.asyncIterator]();
			assert.strictEqual((await events.next()).value?.type, 'turnStarted');
			token.cancel();
			assert.deepStrictEqual(await events.next(), { value: undefined, done: true });
		} finally {
			await adapter.dispose();
			rmSync(userDataPath, { recursive: true, force: true });
		}
	});
});
