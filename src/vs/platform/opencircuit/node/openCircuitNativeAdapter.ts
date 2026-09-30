/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { RpcBackendExitError, RpcCancelledError, RpcRemoteError, RpcTransportError, startOpenCircuitBackend, type OpenCircuitBackendProcessOptions, type RpcErrorCode, type RpcEventData } from './stdioRpc.js';

export interface OpenCircuitChatRef {
	readonly sessionId: string;
}

export interface OpenCircuitCreateChatOptions {
	readonly title?: string;
	readonly workspaceUri: string;
	readonly modelId?: string;
}

export interface OpenCircuitListChatsOptions {
	readonly workspaceUri?: string;
	readonly limit?: number;
	readonly offset?: number;
}

export interface OpenCircuitChatMetadata {
	readonly sessionId: string;
	readonly title: string;
	readonly createdAt: string;
	readonly workspaceUri: string;
	readonly messageCount: number;
}

export interface OpenCircuitTranscriptMessage {
	readonly role: 'user' | 'assistant' | 'tool';
	readonly content: string;
	readonly toolName?: string;
}

export interface OpenCircuitChatSnapshot extends OpenCircuitChatMetadata {
	readonly revision: number;
	readonly transcript: readonly OpenCircuitTranscriptMessage[];
}

export interface OpenCircuitModelInfo {
	readonly id: string;
	readonly name: string;
}

export interface OpenCircuitCancellationToken {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface OpenCircuitUserTurn {
	readonly text: string;
	readonly workspaceUri?: string;
	readonly modelId?: string;
}

export type OpenCircuitBackendEvent =
	| { readonly type: 'turnStarted' }
	| { readonly type: 'assistantText'; readonly text: string }
	| { readonly type: 'turnCompleted' }
	| { readonly type: 'error'; readonly code: RpcErrorCode; readonly message: string };

export interface OpenCircuitBackendReady {
	readonly contractVersion: 1;
	readonly coreVersion?: string;
}

interface IStdioRpcClient {
	request<T>(method: string, payload: unknown, signal?: AbortSignal, onEvent?: (event: RpcEventData) => void | Promise<void>): Promise<T>;
	stop(): Promise<void>;
}

/** Stable OVSCode-facing facade. Core protocol types and transcript formats stay behind the backend. */
export class OpenCircuitNativeAdapter {
	readonly contractVersion = 1 as const;
	private _client: IStdioRpcClient | undefined;

	constructor(client?: IStdioRpcClient) {
		this._client = client;
	}

	async start(options: OpenCircuitBackendProcessOptions): Promise<OpenCircuitBackendReady> {
		if (this._client) {
			throw new RpcTransportError('OpenCircuit backend has already started');
		}
		const client = startOpenCircuitBackend(options);
		this._client = client;
		try {
			const ready = await client.request<OpenCircuitBackendReady>('backend/ready', { contractVersion: this.contractVersion });
			if (ready.contractVersion !== this.contractVersion) {
				throw new RpcTransportError('OpenCircuit backend contract version mismatch');
			}
			return ready;
		} catch (error) {
			this._client = undefined;
			await client.stop();
			throw error;
		}
	}

	listModels(): Promise<readonly OpenCircuitModelInfo[]> {
		return this._clientOrThrow().request('models.list', {});
	}

	async createChat(options: OpenCircuitCreateChatOptions): Promise<OpenCircuitChatRef> {
		const created = await this._clientOrThrow().request<{ sessionId: string }>('chat.create', {
			title: options.title,
			workspaceUri: options.workspaceUri,
			modelId: options.modelId,
			idempotencyKey: randomUUID(),
		});
		return { sessionId: created.sessionId };
	}

	listChats(options: OpenCircuitListChatsOptions = {}): Promise<readonly OpenCircuitChatMetadata[]> {
		return this._clientOrThrow().request('chat.list', options);
	}

	restoreChat(chat: OpenCircuitChatRef): Promise<OpenCircuitChatSnapshot> {
		return this._clientOrThrow().request('chat.restore', chat);
	}

	saveChat(chat: OpenCircuitChatRef, snapshot: OpenCircuitChatSnapshot): Promise<void> {
		return this._clientOrThrow().request('chat.save', { chat, snapshot });
	}

	deleteChat(chat: OpenCircuitChatRef): Promise<void> {
		return this._clientOrThrow().request('chat.delete', chat);
	}

	runTurn(chat: OpenCircuitChatRef, input: OpenCircuitUserTurn, token: OpenCircuitCancellationToken): AsyncIterable<OpenCircuitBackendEvent> {
		return this._runTurn(chat, input, token);
	}

	async dispose(): Promise<void> {
		const client = this._client;
		this._client = undefined;
		await client?.stop();
	}

	private async *_runTurn(chat: OpenCircuitChatRef, input: OpenCircuitUserTurn, token: OpenCircuitCancellationToken): AsyncIterable<OpenCircuitBackendEvent> {
		const queue = new AsyncEventQueue<OpenCircuitBackendEvent>();
		const abort = new AbortController();
		const cancellation = token.onCancellationRequested(() => abort.abort());
		let settled = false;
		const request = this._clientOrThrow().request<void>('chat.runTurn', { chat, input }, abort.signal, event => queue.push(parseBackendEvent(event)));
		void request.then(() => queue.end(), error => {
			if (error instanceof RpcCancelledError) {
				queue.end();
			} else if (error instanceof RpcRemoteError) {
				queue.push({ type: 'error', code: error.code, message: error.message }).then(() => queue.end());
			} else {
				queue.fail(error instanceof Error ? error : new RpcBackendExitError());
			}
		}).finally(() => settled = true);
		try {
			for await (const event of queue) {
				yield event;
			}
			await request.catch(error => {
				if (!(error instanceof RpcCancelledError) && !(error instanceof RpcRemoteError)) {
					throw error;
				}
			});
		} finally {
			cancellation.dispose();
			if (!settled) {
				abort.abort();
			}
			queue.end();
		}
	}

	private _clientOrThrow(): IStdioRpcClient {
		if (!this._client) {
			throw new RpcBackendExitError();
		}
		return this._client;
	}
}

function parseBackendEvent(event: RpcEventData): OpenCircuitBackendEvent {
	const value = event.payload;
	if (!value || typeof value !== 'object' || !('type' in value)) {
		throw new RpcTransportError('Malformed OpenCircuit event');
	}
	const payload = value as Record<string, unknown>;
	switch (payload.type) {
		case 'turnStarted':
			return { type: 'turnStarted' };
		case 'assistantText':
			if (typeof payload.text === 'string') {
				return { type: 'assistantText', text: payload.text };
			}
			break;
		case 'turnCompleted':
			return { type: 'turnCompleted' };
		case 'error':
			if (payload.code === 'INVALID_REQUEST' || payload.code === 'HISTORY_INVALID_CREATE_REQUEST' || payload.code === 'HISTORY_NOT_FOUND' || payload.code === 'HISTORY_CORRUPT' || payload.code === 'HISTORY_STORAGE' || payload.code === 'HISTORY_CREATE_IDEMPOTENCY_CONFLICT' || payload.code === 'HISTORY_SAVE_CONFLICT' || payload.code === 'INTERNAL') {
				return { type: 'error', code: payload.code, message: safeErrorMessage(payload.code) };
			}
			break;
	}
	throw new RpcTransportError('Unsupported OpenCircuit event');
}

function safeErrorMessage(code: RpcErrorCode): string {
	switch (code) {
		case 'INVALID_REQUEST': return 'Invalid request';
		case 'HISTORY_INVALID_CREATE_REQUEST': return 'Invalid session request';
		case 'HISTORY_NOT_FOUND': return 'Session not found';
		case 'HISTORY_CORRUPT': return 'Session data is unreadable';
		case 'HISTORY_STORAGE': return 'Unable to access session storage';
		case 'HISTORY_CREATE_IDEMPOTENCY_CONFLICT': return 'Create request conflicts with an existing session';
		case 'HISTORY_SAVE_CONFLICT': return 'Session changed; reload and retry';
		case 'INTERNAL': return 'Request failed';
	}
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
	private readonly _items: Array<{ readonly value: T; readonly consumed: () => void }> = [];
	private readonly _readers: Array<(result: IteratorResult<T>) => void> = [];
	private _closed = false;
	private _failure: Error | undefined;

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this;
	}

	push(value: T): Promise<void> {
		if (this._closed) {
			return Promise.resolve();
		}
		const reader = this._readers.shift();
		if (reader) {
			reader({ value, done: false });
			return Promise.resolve();
		}
		return new Promise(resolve => this._items.push({ value, consumed: resolve }));
	}

	next(): Promise<IteratorResult<T>> {
		const item = this._items.shift();
		if (item) {
			item.consumed();
			return Promise.resolve({ value: item.value, done: false });
		}
		if (this._failure) {
			return Promise.reject(this._failure);
		}
		if (this._closed) {
			return Promise.resolve({ value: undefined, done: true });
		}
		return new Promise(resolve => this._readers.push(resolve));
	}

	return(): Promise<IteratorResult<T>> {
		this.end();
		return Promise.resolve({ value: undefined, done: true });
	}

	end(): void {
		this._closed = true;
		for (const item of this._items.splice(0)) {
			item.consumed();
		}
		for (const reader of this._readers.splice(0)) {
			reader({ value: undefined, done: true });
		}
	}

	fail(error: Error): void {
		this._failure = error;
		this._closed = true;
		for (const reader of this._readers.splice(0)) {
			reader({ value: undefined, done: true });
		}
	}
}
