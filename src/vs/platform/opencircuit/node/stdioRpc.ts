/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import { type Readable, type Writable } from 'stream';
import { isAbsolute, join } from 'path';

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 1024;
const MAX_ID_LENGTH = 128;
const MAX_IN_FLIGHT_REQUESTS = 256;
const STOP_GRACE_PERIOD_MS = 5000;

export type RpcErrorCode = 'INVALID_REQUEST' | 'HISTORY_NOT_FOUND' | 'HISTORY_CONFLICT' | 'INTERNAL';

const SAFE_ERROR_MESSAGES: Record<RpcErrorCode, string> = {
	INVALID_REQUEST: 'Invalid request',
	HISTORY_NOT_FOUND: 'Session not found',
	HISTORY_CONFLICT: 'Session changed; reload and retry',
	INTERNAL: 'Request failed',
};

interface RpcRequest {
	readonly type: 'request';
	readonly id: string;
	readonly method: string;
	readonly params: unknown;
}

interface RpcCancel {
	readonly type: 'cancel';
	readonly id: string;
}

interface RpcResponse {
	readonly type: 'response';
	readonly id: string;
	readonly result?: unknown;
	readonly error?: { readonly code: RpcErrorCode; readonly message: string };
}

interface RpcEvent {
	readonly type: 'event';
	readonly name: string;
	readonly payload: unknown;
}

type RpcMessage = RpcRequest | RpcCancel | RpcResponse | RpcEvent;

/** Places Core session data below the per-user OVSCode data directory. The directory must be on a host-local filesystem. */
export function resolveOpenCircuitDataDirectory(userDataPath: string): string {
	if (!isAbsolute(userDataPath)) {
		throw new RpcTransportError('OpenCircuit user-data path must be absolute');
	}
	return join(userDataPath, 'opencircuit');
}

export class RpcTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RpcTransportError';
	}
}

export class RpcCancelledError extends Error {
	constructor() {
		super('Request cancelled');
		this.name = 'RpcCancelledError';
	}
}

export class RpcBackendExitError extends Error {
	constructor() {
		super('Backend process exited');
		this.name = 'RpcBackendExitError';
	}
}

export class RpcRemoteError extends Error {
	readonly code: RpcErrorCode;

	constructor(code: RpcErrorCode) {
		super(SAFE_ERROR_MESSAGES[code]);
		this.code = code;
		this.name = 'RpcRemoteError';
	}
}

/** Encodes a JSON message as a Content-Length framed UTF-8 payload. */
export function encodeRpcFrame(message: RpcMessage): Buffer {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	if (body.byteLength > MAX_FRAME_BYTES) {
		throw new RpcTransportError('IPC message exceeds the size limit');
	}
	return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'), body]);
}

/** Incrementally decodes Content-Length frames from arbitrary stream chunks. */
export class RpcFrameDecoder {
	private _buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): RpcMessage[] {
		this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
		const messages: RpcMessage[] = [];
		while (true) {
			const headerEnd = this._buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				if (this._buffer.length > MAX_HEADER_BYTES) {
					throw new RpcTransportError('Malformed IPC frame header');
				}
				break;
			}
			if (headerEnd > MAX_HEADER_BYTES) {
				throw new RpcTransportError('Malformed IPC frame header');
			}
			const header = this._buffer.subarray(0, headerEnd);
			if (header.some(byte => byte > 0x7f)) {
				throw new RpcTransportError('Malformed IPC frame header');
			}
			const headerText = header.toString('ascii');
			const match = /^Content-Length: (0|[1-9][0-9]*)$/.exec(headerText);
			if (!match) {
				throw new RpcTransportError('Malformed IPC frame header');
			}
			const bodyLength = Number(match[1]);
			if (!Number.isSafeInteger(bodyLength) || bodyLength > MAX_FRAME_BYTES) {
				throw new RpcTransportError('IPC message exceeds the size limit');
			}
			const frameEnd = headerEnd + 4 + bodyLength;
			if (this._buffer.length < frameEnd) {
				break;
			}
			let value: unknown;
			try {
				value = JSON.parse(this._buffer.toString('utf8', headerEnd + 4, frameEnd));
			} catch {
				throw new RpcTransportError('Malformed IPC JSON payload');
			}
			if (!isRpcMessage(value)) {
				throw new RpcTransportError('Malformed IPC message');
			}
			messages.push(value);
			this._buffer = this._buffer.subarray(frameEnd);
		}
		return messages;
	}
}

function isRpcMessage(value: unknown): value is RpcMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as Record<string, unknown>;
	switch (message.type) {
		case 'request':
			return isId(message.id) && typeof message.method === 'string' && message.method.length > 0 && message.method.length <= 256 && 'params' in message;
		case 'cancel':
			return isId(message.id);
		case 'response':
			return isId(message.id) && ((('result' in message) !== ('error' in message)) || (message.result === undefined && message.error === undefined));
		case 'event':
			return typeof message.name === 'string' && message.name.length > 0 && message.name.length <= 128 && 'payload' in message;
		default:
			return false;
	}
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function safeErrorCode(value: unknown): RpcErrorCode {
	if (value === 'INVALID_REQUEST' || value === 'HISTORY_NOT_FOUND' || value === 'HISTORY_CONFLICT') {
		return value;
	}
	return 'INTERNAL';
}

function isSafeError(value: unknown): value is { code: RpcErrorCode } {
	return !!value && typeof value === 'object' && 'code' in value;
}

function writeFrame(stream: Writable, message: RpcMessage): Promise<void> {
	const frame = encodeRpcFrame(message);
	return new Promise((resolve, reject) => {
		stream.write(frame, error => error ? reject(new RpcTransportError('IPC write failed')) : resolve());
	});
}

export interface OpenCircuitBackendProcessOptions {
	/** Absolute path to the packaged Core backend entrypoint. */
	readonly entrypoint: string;
	/** OVSCode's per-user data directory, required to be host-local. */
	readonly userDataPath: string;
	/** Caller-filtered environment variables; secrets should not be inherited implicitly. */
	readonly environment: NodeJS.ProcessEnv;
	readonly args?: readonly string[];
}

/** Starts Core with the Node runtime bundled in OVSCode's Electron executable. */
export function startOpenCircuitBackend(options: OpenCircuitBackendProcessOptions): StdioRpcClient {
	if (!isAbsolute(options.entrypoint)) {
		throw new RpcTransportError('Backend entrypoint must be absolute');
	}
	const child = spawn(process.execPath, [options.entrypoint, ...(options.args ?? [])], {
		stdio: ['pipe', 'pipe', 'ignore'],
		env: {
			...options.environment,
			ELECTRON_RUN_AS_NODE: '1',
			OCIRCUIT_GLOBAL_DIR: resolveOpenCircuitDataDirectory(options.userDataPath),
		},
	});
	return new StdioRpcClient(child);
}

/** Client for one child process whose stdin/stdout carry framed RPC only. */
export class StdioRpcClient {
	private readonly _decoder = new RpcFrameDecoder();
	private readonly _pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; signal?: AbortSignal; abort?: () => void }>();
	private readonly _eventListeners = new Set<(name: string, payload: unknown) => void>();
	private readonly _child: ChildProcess;
	private _nextId = 0;
	private _closed = false;

	constructor(child: ChildProcess) {
		this._child = child;
		if (!this._child.stdin || !this._child.stdout) {
			throw new RpcTransportError('Backend process requires piped stdin and stdout');
		}
		this._child.stdout.on('data', (chunk: Buffer) => this._onData(chunk));
		this._child.on('error', () => this._failAll(new RpcBackendExitError()));
		this._child.on('exit', () => this._failAll(new RpcBackendExitError()));
	}

	request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
		if (this._closed) {
			return Promise.reject(new RpcBackendExitError());
		}
		if (!method || method.length > 256) {
			return Promise.reject(new RpcTransportError('Invalid IPC method'));
		}
		if (this._pending.size >= MAX_IN_FLIGHT_REQUESTS) {
			return Promise.reject(new RpcTransportError('IPC request limit reached'));
		}
		if (signal?.aborted) {
			return Promise.reject(new RpcCancelledError());
		}
		const id = String(++this._nextId);
		return new Promise<T>((resolve, reject) => {
			const pending: { resolve(value: unknown): void; reject(error: Error): void; signal?: AbortSignal; abort?: () => void } = { resolve, reject, signal };
			if (signal) {
				pending.abort = () => {
					if (this._pending.delete(id)) {
						void writeFrame(this._child.stdin!, { type: 'cancel', id }).catch(() => undefined);
						reject(new RpcCancelledError());
					}
				};
				signal.addEventListener('abort', pending.abort, { once: true });
			}
			this._pending.set(id, pending);
			void writeFrame(this._child.stdin!, { type: 'request', id, method, params }).catch(() => {
				if (this._pending.delete(id)) {
					this._removeAbortListener(pending);
					reject(new RpcTransportError('IPC write failed'));
				}
			});
		});
	}

	onEvent(listener: (name: string, payload: unknown) => void): { dispose(): void } {
		this._eventListeners.add(listener);
		return { dispose: () => this._eventListeners.delete(listener) };
	}

	dispose(): void {
		void this.stop();
	}

	stop(): Promise<void> {
		this._failAll(new RpcBackendExitError());
		if (this._child.exitCode !== null || this._child.signalCode !== null) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			const finish = () => {
				clearTimeout(forceKill);
				resolve();
			};
			this._child.once('close', finish);
			const forceKill = setTimeout(() => this._child.kill('SIGKILL'), STOP_GRACE_PERIOD_MS);
			if (this._child.exitCode !== null || this._child.signalCode !== null) {
				finish();
			} else {
				this._child.kill();
			}
		});
	}

	private _onData(chunk: Buffer): void {
		try {
			for (const message of this._decoder.push(chunk)) {
				if (message.type === 'response') {
					const pending = this._pending.get(message.id);
					if (pending) {
						this._pending.delete(message.id);
						this._removeAbortListener(pending);
						if (message.error) {
						pending.reject(new RpcRemoteError(safeErrorCode(message.error.code)));
						} else {
						pending.resolve(message.result);
						}
					}
				} else if (message.type === 'event') {
					for (const listener of this._eventListeners) {
						listener(message.name, message.payload);
					}
				} else {
					throw new RpcTransportError('Unexpected IPC message from backend');
				}
			}
		} catch (error) {
			this._failAll(error instanceof RpcTransportError ? error : new RpcTransportError('Malformed IPC frame'));
			this._child.kill();
		}
	}

	private _removeAbortListener(pending: { signal?: AbortSignal; abort?: () => void }): void {
		if (pending.signal && pending.abort) {
			pending.signal.removeEventListener('abort', pending.abort);
		}
	}

	private _failAll(error: Error): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		for (const pending of this._pending.values()) {
			this._removeAbortListener(pending);
			pending.reject(error);
		}
		this._pending.clear();
	}
}

export interface RpcRequestContext {
	readonly signal: AbortSignal;
	emit(name: string, payload: unknown): Promise<void>;
}

export type RpcHandler = (params: unknown, context: RpcRequestContext) => unknown | Promise<unknown>;

/** Serves requests from process stdin and writes framed responses/events to stdout. */
export async function runStdioRpcServer(handlers: Readonly<Record<string, RpcHandler>>, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
	const decoder = new RpcFrameDecoder();
	const controllers = new Map<string, AbortController>();
	const write = (message: RpcMessage) => writeFrame(output, message);
	input.on('data', (chunk: Buffer) => {
		let messages: RpcMessage[];
		try {
			messages = decoder.push(chunk);
		} catch {
			input.destroy();
			return;
		}
		for (const message of messages) {
			if (message.type === 'cancel') {
				const controller = controllers.get(message.id);
				controllers.delete(message.id);
				controller?.abort();
			} else if (message.type === 'request') {
				const controller = new AbortController();
				controllers.set(message.id, controller);
				const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : undefined;
				void (async () => {
					try {
						if (controllers.size > MAX_IN_FLIGHT_REQUESTS || !handler) {
							throw Object.assign(new Error(), { code: 'INVALID_REQUEST' });
						}
						const result = await handler(message.params, { signal: controller.signal, emit: (name, payload) => write({ type: 'event', name, payload }) });
						if (!controller.signal.aborted) {
							await write({ type: 'response', id: message.id, result });
						}
					} catch (error) {
						const code = isSafeError(error) ? safeErrorCode(error.code) : 'INTERNAL';
						if (!controller.signal.aborted) {
							await write({ type: 'response', id: message.id, error: { code, message: SAFE_ERROR_MESSAGES[code] } });
						}
					} finally {
						controllers.delete(message.id);
					}
				})().catch(() => input.destroy());
			}
		}
	});
	await new Promise<void>(resolve => {
		input.once('end', resolve);
		input.once('close', resolve);
		input.once('error', resolve);
	});
}
