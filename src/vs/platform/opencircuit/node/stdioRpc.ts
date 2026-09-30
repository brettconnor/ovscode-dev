/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { isAbsolute, join } from 'path';
import { type Readable, type Writable } from 'stream';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_IN_FLIGHT_REQUESTS = 256;
const EVENT_CREDIT_WINDOW = 16;
const STARTUP_TIMEOUT_MS = 10_000;
const STOP_GRACE_PERIOD_MS = 5_000;
const CORE_HOST_CAPABILITIES = new Set([
	'getIdeInfo', 'getIdeSettings', 'getWorkspaceDirs', 'getUniqueId', 'isTelemetryEnabled', 'isWorkspaceRemote',
	'fileExists', 'readFile', 'readRangeInFile', 'getSearchResults', 'getFileResults', 'getOpenFiles', 'getCurrentFile',
	'getPinnedFiles', 'getProblems', 'getGitRootPath', 'getBranch', 'getRepoName', 'listDir', 'getFileStats', 'getTags',
]);

export type RpcErrorCode = 'INVALID_REQUEST' | 'HISTORY_INVALID_CREATE_REQUEST' | 'HISTORY_NOT_FOUND' | 'HISTORY_CORRUPT' | 'HISTORY_STORAGE' | 'HISTORY_CREATE_IDEMPOTENCY_CONFLICT' | 'HISTORY_SAVE_CONFLICT' | 'INTERNAL';

const SAFE_ERROR_MESSAGES: Record<RpcErrorCode, string> = {
	INVALID_REQUEST: 'Invalid request',
	HISTORY_INVALID_CREATE_REQUEST: 'Invalid session request',
	HISTORY_NOT_FOUND: 'Session not found',
	HISTORY_CORRUPT: 'Session data is unreadable',
	HISTORY_STORAGE: 'Unable to access session storage',
	HISTORY_CREATE_IDEMPOTENCY_CONFLICT: 'Create request conflicts with an existing session',
	HISTORY_SAVE_CONFLICT: 'Session changed; reload and retry',
	INTERNAL: 'Request failed',
};

interface RpcRequest {
	readonly protocolVersion: 1;
	readonly kind: 'request';
	readonly requestId: string;
	readonly method: string;
	readonly payload: unknown;
}

interface RpcCancel {
	readonly protocolVersion: 1;
	readonly kind: 'cancel';
	readonly requestId: string;
}

interface RpcCredit {
	readonly protocolVersion: 1;
	readonly kind: 'credit';
	readonly requestId: string;
	readonly credits: number;
}

interface RpcEvent {
	readonly protocolVersion: 1;
	readonly kind: 'event';
	readonly requestId: string;
	readonly sequence: number;
	readonly payload: unknown;
}

interface RpcResult {
	readonly protocolVersion: 1;
	readonly kind: 'result';
	readonly requestId: string;
	readonly payload: unknown;
}

interface RpcError {
	readonly protocolVersion: 1;
	readonly kind: 'error';
	readonly requestId: string;
	readonly code: RpcErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly correlationId?: string;
}

interface RpcHello {
	readonly protocolVersion: 1;
	readonly kind: 'hello';
	readonly requestId: string;
}

interface RpcHostResult {
	readonly protocolVersion: 1;
	readonly kind: 'hostResult';
	readonly requestId: string;
	readonly callId: string;
	readonly payload?: unknown;
	readonly code?: RpcErrorCode;
}

type RpcMessage = RpcRequest | RpcCancel | RpcCredit | RpcEvent | RpcResult | RpcError | RpcHello | RpcHostResult;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	abort?: () => void;
	lastSequence: number;
	dispatch: Promise<void>;
	onEvent?: (event: RpcEventData) => void | Promise<void>;
	terminal?: RpcResult | RpcError;
}

export interface RpcEventData {
	readonly requestId: string;
	readonly sequence: number;
	readonly payload: unknown;
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

/** Places Core session data below the per-user OVSCode data directory. The directory must be on a host-local filesystem. */
export function resolveOpenCircuitDataDirectory(userDataPath: string): string {
	if (!isAbsolute(userDataPath)) {
		throw new RpcTransportError('OpenCircuit user-data path must be absolute');
	}
	return join(userDataPath, 'opencircuit');
}

/** Encodes one JSON message using a four-byte big-endian byte length prefix. */
export function encodeRpcFrame(message: RpcMessage): Buffer {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	if (body.byteLength === 0 || body.byteLength > MAX_FRAME_BYTES) {
		throw new RpcTransportError('IPC message exceeds the size limit');
	}
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32BE(body.byteLength, 0);
	return Buffer.concat([header, body]);
}

/** Incrementally decodes bounded length-prefixed UTF-8 JSON frames. */
export class RpcFrameDecoder {
	private _buffer: Buffer = Buffer.alloc(0);
	private readonly _textDecoder = new TextDecoder('utf-8', { fatal: true });

	push(chunk: Buffer): RpcMessage[] {
		this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
		const messages: RpcMessage[] = [];
		while (this._buffer.length >= 4) {
			const bodyLength = this._buffer.readUInt32BE(0);
			if (bodyLength === 0 || bodyLength > MAX_FRAME_BYTES) {
				throw new RpcTransportError('Malformed IPC frame length');
			}
			if (this._buffer.length < 4 + bodyLength) {
				break;
			}
			let value: unknown;
			try {
				value = JSON.parse(this._textDecoder.decode(this._buffer.subarray(4, 4 + bodyLength)));
			} catch {
				throw new RpcTransportError('Malformed IPC JSON payload');
			}
			if (!isRpcMessage(value)) {
				throw new RpcTransportError('Malformed IPC message');
			}
			messages.push(value);
			this._buffer = this._buffer.subarray(4 + bodyLength);
		}
		return messages;
	}
}

function isRpcMessage(value: unknown): value is RpcMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as Record<string, unknown>;
	if (message.protocolVersion !== PROTOCOL_VERSION || !isRequestId(message.requestId)) {
		return false;
	}
	switch (message.kind) {
	case 'hello':
	case 'cancel':
		return true;
	case 'hostResult':
		return isRequestId(message.callId) && ((Object.hasOwn(message, 'payload') && message.code === undefined) || (message.payload === undefined && typeof message.code === 'string'));
		case 'request':
			return typeof message.method === 'string' && message.method.length > 0 && message.method.length <= 256 && 'payload' in message;
		case 'credit':
			return Number.isInteger(message.credits) && (message.credits as number) > 0 && (message.credits as number) <= EVENT_CREDIT_WINDOW;
		case 'event':
			return Number.isSafeInteger(message.sequence) && (message.sequence as number) > 0 && 'payload' in message;
		case 'result':
			return 'payload' in message;
		case 'error':
			return typeof message.code === 'string' && typeof message.message === 'string' && typeof message.retryable === 'boolean' && (message.correlationId === undefined || typeof message.correlationId === 'string');
		default:
			return false;
	}
}

function isRequestId(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_ID_LENGTH && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeErrorCode(value: unknown): RpcErrorCode {
	switch (value) {
		case 'INVALID_REQUEST':
		case 'HISTORY_INVALID_CREATE_REQUEST':
		case 'HISTORY_NOT_FOUND':
		case 'HISTORY_CORRUPT':
		case 'HISTORY_STORAGE':
		case 'HISTORY_CREATE_IDEMPOTENCY_CONFLICT':
		case 'HISTORY_SAVE_CONFLICT':
			return value;
		default:
			return 'INTERNAL';
	}
}

function isSafeError(value: unknown): value is { code: unknown } {
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
	/** Handles explicitly supported host operations; unsupported capabilities must fail closed. */
	readonly onHostRequest?: (method: string, payload: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
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
	return new StdioRpcClient(child, options.onHostRequest);
}

/** Client for one child process whose stdin/stdout carry framed RPC only. */
export class StdioRpcClient {
	private readonly _decoder = new RpcFrameDecoder();
	private readonly _pending = new Map<string, PendingRequest>();
	private readonly _eventListeners = new Set<(event: RpcEventData) => void>();
	private readonly _child: ChildProcess;
	private _closed = false;
	private _readyState = false;
	private _readyResolve!: () => void;
	private _readyReject!: (error: Error) => void;
	private readonly _ready = new Promise<void>((resolve, reject) => {
		this._readyResolve = resolve;
		this._readyReject = reject;
	});
	private readonly _startupTimer: ReturnType<typeof setTimeout>;

	constructor(child: ChildProcess, private readonly _onHostRequest?: OpenCircuitBackendProcessOptions['onHostRequest']) {
		this._child = child;
		if (!this._child.stdin || !this._child.stdout) {
			throw new RpcTransportError('Backend process requires piped stdin and stdout');
		}
		void this._ready.catch(() => undefined);
		this._startupTimer = setTimeout(() => this._failAll(new RpcTransportError('Backend startup handshake timed out')), STARTUP_TIMEOUT_MS);
		this._child.stdout.on('data', (chunk: Buffer) => this._onData(chunk));
		this._child.on('error', () => this._failAll(new RpcBackendExitError()));
		this._child.on('exit', () => this._failAll(new RpcBackendExitError()));
	}

	request<T>(method: string, payload: unknown, signal?: AbortSignal, onEvent?: (event: RpcEventData) => void | Promise<void>): Promise<T> {
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
		const requestId = randomUUID();
		return new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = { resolve, reject, signal, lastSequence: 0, dispatch: Promise.resolve(), onEvent };
			if (signal) {
				pending.abort = () => {
					if (this._pending.delete(requestId)) {
						void writeFrame(this._child.stdin!, { protocolVersion: PROTOCOL_VERSION, kind: 'cancel', requestId }).catch(() => undefined);
						reject(new RpcCancelledError());
					}
				};
				signal.addEventListener('abort', pending.abort, { once: true });
			}
			this._pending.set(requestId, pending);
			void this._ready.then(async () => {
				if (!this._pending.has(requestId)) {
					return;
				}
				await writeFrame(this._child.stdin!, { protocolVersion: PROTOCOL_VERSION, kind: 'request', requestId, method, payload });
				await writeFrame(this._child.stdin!, { protocolVersion: PROTOCOL_VERSION, kind: 'credit', requestId, credits: EVENT_CREDIT_WINDOW });
			}).catch(() => {
				if (this._pending.delete(requestId)) {
					this._removeAbortListener(pending);
					reject(new RpcTransportError('IPC write failed'));
				}
			});
		});
	}

	onEvent(listener: (event: RpcEventData) => void): { dispose(): void } {
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
				if (!this._readyState) {
					if (message.kind !== 'hello' || message.protocolVersion !== PROTOCOL_VERSION) {
					throw new RpcTransportError('Invalid backend startup handshake');
					}
					this._readyState = true;
					clearTimeout(this._startupTimer);
					this._readyResolve();
					continue;
				}
				if (message.kind === 'event') {
					const pending = this._pending.get(message.requestId);
					if (!pending || pending.terminal) {
						throw new RpcTransportError('Unexpected IPC event');
					}
					pending.dispatch = pending.dispatch.then(async () => {
						if (message.sequence !== pending.lastSequence + 1) {
							throw new RpcTransportError('Invalid IPC event sequence');
						}
						pending.lastSequence = message.sequence;
						const event = { requestId: message.requestId, sequence: message.sequence, payload: message.payload };
						if (isHostRequestPayload(message.payload)) {
							try {
								if (!CORE_HOST_CAPABILITIES.has(message.payload.method) || !this._onHostRequest) {
									throw new RpcTransportError('Unsupported host capability');
								}
								const payload = await this._onHostRequest(message.payload.method, message.payload.payload, pending.signal);
								await writeFrame(this._child.stdin!, { protocolVersion: PROTOCOL_VERSION, kind: 'hostResult', requestId: message.requestId, callId: message.payload.callId, payload: payload === undefined ? null : payload });
							} catch (error) {
								const code = isSafeError(error) ? safeErrorCode(error.code) : 'INTERNAL';
								await writeFrame(this._child.stdin!, { protocolVersion: PROTOCOL_VERSION, kind: 'hostResult', requestId: message.requestId, callId: message.payload.callId, code });
							}
						} else {
							await pending.onEvent?.(event);
							for (const listener of this._eventListeners) {
								listener(event);
							}
						}
						await writeFrame(this._child.stdin!, { protocolVersion: PROTOCOL_VERSION, kind: 'credit', requestId: message.requestId, credits: 1 });
					});
					void pending.dispatch.catch(error => {
						this._failAll(error instanceof RpcTransportError ? error : new RpcTransportError('IPC event delivery failed'));
						this._child.kill();
					});
				} else if (message.kind === 'result' || message.kind === 'error') {
					const pending = this._pending.get(message.requestId);
					if (pending) {
						if (pending.terminal) {
							throw new RpcTransportError('Duplicate IPC terminal response');
						}
						pending.terminal = message;
						void pending.dispatch.then(() => {
							if (this._pending.get(message.requestId) !== pending) {
								return;
							}
							this._pending.delete(message.requestId);
							this._removeAbortListener(pending);
							if (message.kind === 'error') {
								pending.reject(new RpcRemoteError(safeErrorCode(message.code)));
							} else {
								pending.resolve(message.payload);
							}
						}).catch(error => this._failAll(error instanceof Error ? error : new RpcTransportError('IPC event delivery failed')));
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

	private _removeAbortListener(pending: PendingRequest): void {
		if (pending.signal && pending.abort) {
			pending.signal.removeEventListener('abort', pending.abort);
		}
	}

	private _failAll(error: Error): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		clearTimeout(this._startupTimer);
		this._readyReject(error);
		for (const pending of this._pending.values()) {
			this._removeAbortListener(pending);
			pending.reject(error);
		}
		this._pending.clear();
	}
}

export interface RpcRequestContext {
	readonly signal: AbortSignal;
	emit(payload: unknown): Promise<void>;
	requestHost(method: string, payload: unknown): Promise<unknown>;
}

export type RpcHandler = (payload: unknown, context: RpcRequestContext) => unknown | Promise<unknown>;

interface ActiveRequest {
	readonly controller: AbortController;
	readonly waiters: Array<() => void>;
	credits: number;
	sequence: number;
	readonly hostCalls: Map<string, { resolve(payload: unknown): void; reject(error: Error): void }>;
}

/** Serves protocol-v1 requests from stdin and writes framed responses/events to stdout. */
export async function runStdioRpcServer(handlers: Readonly<Record<string, RpcHandler>>, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
	const decoder = new RpcFrameDecoder();
	const active = new Map<string, ActiveRequest>();
	const write = (message: RpcMessage) => writeFrame(output, message);
	await write({ protocolVersion: PROTOCOL_VERSION, kind: 'hello', requestId: randomUUID() });
	input.on('data', (chunk: Buffer) => {
		let messages: RpcMessage[];
		try {
			messages = decoder.push(chunk);
		} catch {
			input.destroy();
			output.end();
			return;
		}
		for (const message of messages) {
			if (message.kind === 'cancel') {
				const request = active.get(message.requestId);
				active.delete(message.requestId);
				request?.controller.abort();
				request?.waiters.splice(0).forEach(resolve => resolve());
				request?.hostCalls.forEach(call => call.reject(new RpcCancelledError()));
				request?.hostCalls.clear();
			} else if (message.kind === 'credit') {
				const request = active.get(message.requestId);
				if (request) {
					if (request.credits + message.credits > EVENT_CREDIT_WINDOW) {
						input.destroy();
						output.end();
						return;
					}
					request.credits += message.credits;
					request.waiters.splice(0).forEach(resolve => resolve());
				}
			} else if (message.kind === 'hostResult') {
				const request = active.get(message.requestId);
				const call = request?.hostCalls.get(message.callId);
				if (!request || !call) {
					input.destroy();
					output.end();
					return;
				}
				request.hostCalls.delete(message.callId);
				if (message.code) {
					call.reject(new RpcRemoteError(message.code));
				} else {
					call.resolve(message.payload);
				}
			} else if (message.kind === 'request') {
				if (active.has(message.requestId)) {
					input.destroy();
					output.end();
					return;
				}
				const request: ActiveRequest = { controller: new AbortController(), waiters: [], credits: 0, sequence: 0, hostCalls: new Map() };
				active.set(message.requestId, request);
				const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : undefined;
				void (async () => {
					try {
						if (active.size > MAX_IN_FLIGHT_REQUESTS || !handler) {
							throw Object.assign(new Error(), { code: 'INVALID_REQUEST' });
						}
						const payload = await handler(message.payload, {
							signal: request.controller.signal,
							emit: async eventPayload => {
								while (request.credits === 0 && !request.controller.signal.aborted) {
									await new Promise<void>(resolve => request.waiters.push(resolve));
								}
								if (request.controller.signal.aborted) {
									throw new RpcCancelledError();
								}
								request.credits--;
								request.sequence++;
								await write({ protocolVersion: PROTOCOL_VERSION, kind: 'event', requestId: message.requestId, sequence: request.sequence, payload: eventPayload });
							},
							requestHost: async (method, hostPayload) => {
								if (!/^[a-z][A-Za-z0-9.]{0,127}$/.test(method)) {
									throw new RpcTransportError('Invalid host capability');
								}
								const callId = randomUUID();
								let resolve!: (payload: unknown) => void;
								let reject!: (error: Error) => void;
								const response = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
								request.hostCalls.set(callId, { resolve, reject });
								try {
									while (request.credits === 0 && !request.controller.signal.aborted) {
										await new Promise<void>(wake => request.waiters.push(wake));
									}
									if (request.controller.signal.aborted) {
										throw new RpcCancelledError();
									}
									request.credits--;
									request.sequence++;
									await write({ protocolVersion: PROTOCOL_VERSION, kind: 'event', requestId: message.requestId, sequence: request.sequence, payload: { type: 'hostRequest', callId, method, payload: hostPayload } });
									return await response;
								} finally {
									request.hostCalls.delete(callId);
								}
							},
						});
						if (!request.controller.signal.aborted) {
							await write({ protocolVersion: PROTOCOL_VERSION, kind: 'result', requestId: message.requestId, payload: payload === undefined ? null : payload });
						}
					} catch (error) {
						const code = isSafeError(error) ? safeErrorCode(error.code) : 'INTERNAL';
						if (!request.controller.signal.aborted) {
							await write({ protocolVersion: PROTOCOL_VERSION, kind: 'error', requestId: message.requestId, code, message: SAFE_ERROR_MESSAGES[code], retryable: code === 'INTERNAL' || code === 'HISTORY_SAVE_CONFLICT' });
						}
					} finally {
						active.delete(message.requestId);
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

function isHostRequestPayload(value: unknown): value is { readonly type: 'hostRequest'; readonly callId: string; readonly method: string; readonly payload: unknown } {
	return !!value && typeof value === 'object' && (value as Record<string, unknown>).type === 'hostRequest' && isRequestId((value as Record<string, unknown>).callId) && typeof (value as Record<string, unknown>).method === 'string' && 'payload' in value;
}
