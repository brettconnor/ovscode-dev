/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { RpcBackendExitError, RpcCancelledError, RpcEventData, RpcFrameDecoder, RpcRemoteError, RpcTransportError, StdioRpcClient, encodeRpcFrame, resolveOpenCircuitDataDirectory, startOpenCircuitBackend } from '../../node/stdioRpc.js';

const serverModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../node/stdioRpc.js')).href;
const serverScript = `
const { randomUUID } = await import('node:crypto');
const { runStdioRpcServer, encodeRpcFrame } = await import(process.argv[1]);
const mode = process.argv[2];
if (mode === 'malformed') {
  process.stdout.write(encodeRpcFrame({ protocolVersion: 1, kind: 'hello', requestId: randomUUID() }));
  process.stdin.once('data', () => process.stdout.write(Buffer.alloc(4)));
} else {
  await runStdioRpcServer({
    echo: payload => payload,
    fail: () => { throw new Error('private transcript /secret/path / token=hidden'); },
    knownError: () => { throw Object.assign(new Error('sensitive details'), { code: 'HISTORY_NOT_FOUND' }); },
    conflict: () => { throw Object.assign(new Error('session contents leaked'), { code: 'HISTORY_SAVE_CONFLICT' }); },
    event: async (_payload, context) => { await context.emit({ type: 'progress', step: 1 }); return 'done'; },
    stream: async (_payload, context) => { for (let index = 1; index <= 40; index++) { await context.emit({ index }); } return 40; },
    runtime: () => ({ dataRoot: process.env.OCIRCUIT_GLOBAL_DIR, runAsNode: process.env.ELECTRON_RUN_AS_NODE }),
    slow: (_payload, context) => new Promise(resolve => {
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

	test('starts Core with Electron Node and a host-local per-user data root', async () => {
		const userDataPath = mkdtempSync(join(tmpdir(), 'ovscode-opencircuit-'));
		const backendPath = join(userDataPath, 'backend.mjs');
		writeFileSync(backendPath, `import { runStdioRpcServer } from ${JSON.stringify(serverModule)}; await runStdioRpcServer({ runtime: () => ({ dataRoot: process.env.OCIRCUIT_GLOBAL_DIR, runAsNode: process.env.ELECTRON_RUN_AS_NODE }) });`);
		const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
		const client = startOpenCircuitBackend({ entrypoint: backendPath, userDataPath, environment });
		try {
			assert.deepStrictEqual(await client.request('runtime', null), { dataRoot: resolveOpenCircuitDataDirectory(userDataPath), runAsNode: '1' });
		} finally {
			await client.stop();
			rmSync(userDataPath, { recursive: true, force: true });
		}
	});

	test('decodes fragmented and coalesced protocol-v1 frames', () => {
		const first = encodeRpcFrame({ protocolVersion: 1, kind: 'event', requestId: randomUUID(), sequence: 1, payload: { name: 'a' } });
		const second = encodeRpcFrame({ protocolVersion: 1, kind: 'event', requestId: randomUUID(), sequence: 1, payload: { name: 'b' } });
		const decoder = new RpcFrameDecoder();
		assert.deepStrictEqual(decoder.push(first.subarray(0, 7)), []);
		assert.deepStrictEqual(decoder.push(Buffer.concat([first.subarray(7), second])), [
			{ protocolVersion: 1, kind: 'event', requestId: (JSON.parse(first.subarray(4).toString('utf8')) as { requestId: string }).requestId, sequence: 1, payload: { name: 'a' } },
			{ protocolVersion: 1, kind: 'event', requestId: (JSON.parse(second.subarray(4).toString('utf8')) as { requestId: string }).requestId, sequence: 1, payload: { name: 'b' } },
		]);
	});

	test('round trips real process requests, sequenced events, and sanitized errors', async () => {
		const { client } = startBackend();
		try {
			const events: unknown[] = [];
			const subscription = client.onEvent(event => events.push(event));
			assert.deepStrictEqual(await client.request('echo', { text: 'hello', count: 2 }), { text: 'hello', count: 2 });
			assert.strictEqual(await client.request('event', null), 'done');
			assert.strictEqual(events.length, 1);
			assert.deepStrictEqual((events[0] as { sequence: number; payload: unknown }).payload, { type: 'progress', step: 1 });
			assert.strictEqual((events[0] as { sequence: number }).sequence, 1);
			const streamedEvents: RpcEventData[] = [];
			assert.strictEqual(await client.request('stream', null, undefined, async event => {
				await new Promise(resolve => setTimeout(resolve, 1));
				streamedEvents.push(event);
			}), 40);
			assert.deepStrictEqual(streamedEvents.map(event => event.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
			await assert.rejects(client.request('fail', null), (error: unknown) => error instanceof RpcRemoteError && error.code === 'INTERNAL' && error.message === 'Request failed' && !error.stack?.includes('private transcript'));
			await assert.rejects(client.request('knownError', null), (error: unknown) => error instanceof RpcRemoteError && error.code === 'HISTORY_NOT_FOUND' && error.message === 'Session not found' && !error.stack?.includes('sensitive details'));
			await assert.rejects(client.request('conflict', null), (error: unknown) => error instanceof RpcRemoteError && error.code === 'HISTORY_SAVE_CONFLICT' && error.message === 'Session changed; reload and retry' && !error.stack?.includes('session contents leaked'));
			subscription.dispose();
		} finally {
			client.dispose();
		}
	});

	test('cancels over IPC and leaves the backend usable', async () => {
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

	test('bounds outstanding requests and releases capacity after cancellations', async () => {
		const { client } = startBackend();
		try {
			const controllers = Array.from({ length: 256 }, () => new AbortController());
			const pending = controllers.map(controller => client.request('slow', null, controller.signal));
			await assert.rejects(client.request('slow', null), /IPC request limit reached/);
			controllers.forEach(controller => controller.abort());
			await Promise.all(pending.map(request => assert.rejects(request, RpcCancelledError)));
			assert.strictEqual(await client.request('echo', 'capacity released'), 'capacity released');
		} finally {
			client.dispose();
		}
	});

	test('rejects malformed frames from a real child process', async () => {
		const { client } = startBackend('malformed');
		try {
			await assert.rejects(client.request('trigger', null), /Malformed IPC frame length/);
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
