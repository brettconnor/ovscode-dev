/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn, type ChildProcess } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { StdioRpcClient, RpcFrameDecoder, encodeRpcFrame, RpcCancelledError, RpcRemoteError, RpcBackendExitError, RpcTransportError, resolveOpenCircuitDataDirectory } from '../../node/stdioRpc.js';

const serverModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../node/stdioRpc.js')).href;
const serverScript = `
const { runStdioRpcServer } = await import(process.argv[1]);
const mode = process.argv[2];
if (mode === 'malformed') {
  process.stdin.once('data', () => process.stdout.write('Content-Length: nope\\r\\n\\r\\n{}'));
} else {
  await runStdioRpcServer({
    echo: params => params,
    fail: () => { throw new Error('private transcript /secret/path / token=hidden'); },
    knownError: () => { throw Object.assign(new Error('sensitive details'), { code: 'HISTORY_NOT_FOUND' }); },
    event: async (_params, context) => { await context.emit('progress', { step: 1 }); return 'done'; },
    slow: (_params, context) => new Promise(resolve => {
      const timer = setTimeout(() => resolve('finished'), 5000);
      context.signal.addEventListener('abort', () => { clearTimeout(timer); resolve('cancelled'); }, { once: true });
    }),
    exit: () => process.exit(23)
  });
}
`;

function startBackend(mode = 'normal'): { child: ChildProcess; client: StdioRpcClient } {
	const child = spawn(process.execPath, ['--input-type=module', '-e', serverScript, serverModule, mode], { stdio: ['pipe', 'pipe', 'ignore'] });
	return { child, client: new StdioRpcClient(child) };
}

suite('StdioRpcClient', () => {
	test('uses an absolute per-user app data directory for Core sessions', () => {
		assert.strictEqual(resolveOpenCircuitDataDirectory('/home/tester/.config/ovscode'), '/home/tester/.config/ovscode/opencircuit');
		assert.throws(() => resolveOpenCircuitDataDirectory('relative/path'), RpcTransportError);
	});

	test('decodes fragmented and coalesced Content-Length frames', () => {
		const first = encodeRpcFrame({ type: 'event', name: 'a', payload: 1 });
		const second = encodeRpcFrame({ type: 'event', name: 'b', payload: 2 });
		const decoder = new RpcFrameDecoder();
		assert.deepStrictEqual(decoder.push(first.subarray(0, 7)), []);
		assert.deepStrictEqual(decoder.push(Buffer.concat([first.subarray(7), second])), [
			{ type: 'event', name: 'a', payload: 1 },
			{ type: 'event', name: 'b', payload: 2 },
		]);
	});

	test('round trips real process requests, events, and sanitized errors', async () => {
		const { client } = startBackend();
		try {
			const events: unknown[] = [];
			const subscription = client.onEvent((name, payload) => events.push({ name, payload }));
			assert.deepStrictEqual(await client.request('echo', { text: 'hello', count: 2 }), { text: 'hello', count: 2 });
			assert.strictEqual(await client.request('event', null), 'done');
			assert.deepStrictEqual(events, [{ name: 'progress', payload: { step: 1 } }]);
			await assert.rejects(client.request('fail', null), (error: unknown) => error instanceof RpcRemoteError && error.code === 'INTERNAL' && error.message === 'Request failed' && !error.stack?.includes('private transcript'));
			await assert.rejects(client.request('knownError', null), (error: unknown) => error instanceof RpcRemoteError && error.code === 'HISTORY_NOT_FOUND' && error.message === 'Session not found' && !error.stack?.includes('sensitive details'));
			subscription.dispose();
		} finally {
			client.dispose();
		}
	});

	test('cancels a request over IPC and keeps the backend usable', async () => {
		const { client } = startBackend();
		try {
			const abort = new AbortController();
			const pending = client.request('slow', null, abort.signal);
			abort.abort();
			await assert.rejects(pending, RpcCancelledError);
			assert.strictEqual(await client.request('echo', 'still alive'), 'still alive');
		} finally {
			client.dispose();
		}
	});

	test('rejects malformed frames from a real child process', async () => {
		const { client } = startBackend('malformed');
		try {
			await assert.rejects(client.request('trigger', null), /Malformed IPC frame header/);
		} finally {
			client.dispose();
		}
	});

	test('rejects pending requests when the backend exits', async () => {
		const { client } = startBackend();
		try {
			await assert.rejects(client.request('exit', null), RpcBackendExitError);
		} finally {
			client.dispose();
		}
	});
});
