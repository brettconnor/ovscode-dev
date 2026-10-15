/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import { Application, Logger } from '../../../../automation';
import { installAllHandlers } from '../../utils';

export function setup(logger: Logger) {
	describe('Gallery resource loading', () => {
		it('fetches a resource without sending the machine ID or commit header', async () => {
			const { ExtensionResourceLoaderService } = require('../../../../../out/vs/platform/extensionResourceLoader/common/extensionResourceLoaderService.js') as {
				ExtensionResourceLoaderService: new (...services: unknown[]) => { readExtensionResource(uri: unknown): Promise<string> };
			};
			const { URI } = require('../../../../../out/vs/base/common/uri.js') as { URI: { parse(value: string): unknown } };
			const { VSBuffer, bufferToStream } = require('../../../../../out/vs/base/common/buffer.js') as {
				VSBuffer: { wrap(value: Uint8Array): unknown };
				bufferToStream(value: unknown): unknown;
			};

			let receivedMethod: string | undefined;
			let receivedUrl: string | undefined;
			let receivedHeaders: http.IncomingHttpHeaders | undefined;
			const server = http.createServer((request, response) => {
				receivedMethod = request.method;
				receivedUrl = request.url;
				receivedHeaders = request.headers;
				response.writeHead(200, { 'Content-Type': 'text/plain' });
				response.end('mock Gallery resource');
			});
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', resolve);
			});

			try {
				const address = server.address();
				if (!address || typeof address === 'string') {
					throw new Error('Could not determine the mock Gallery resource server port.');
				}
				const url = `http://127.0.0.1:${address.port}/publisher/extension/resource.json`;
				const requestService = {
					request: (options: { url?: string; type?: string; headers?: Record<string, string> }) => new Promise((resolve, reject) => {
						const request = http.request(options.url!, { method: options.type || 'GET', headers: options.headers }, response => {
							const chunks: Buffer[] = [];
							response.on('data', chunk => chunks.push(Buffer.from(chunk)));
							response.on('end', () => resolve({
								res: { statusCode: response.statusCode, headers: response.headers },
								stream: bufferToStream(VSBuffer.wrap(Buffer.concat(chunks)))
							}));
						});
						request.once('error', reject);
						request.end();
					})
				};
				const loader = new ExtensionResourceLoaderService(
					{},
					{
						applicationName: 'ovscode-test',
						version: '1.2.3',
						commit: 'test-commit',
						extensionsGallery: { resourceUrlTemplate: url }
					},
					requestService,
					{ info: () => undefined }
				);

				assert.strictEqual(await loader.readExtensionResource(URI.parse(url)), 'mock Gallery resource');
				assert.strictEqual(receivedMethod, 'GET');
				assert.strictEqual(receivedUrl, '/publisher/extension/resource.json');
				assert.deepStrictEqual({
					clientName: receivedHeaders?.['x-client-name'],
					clientVersion: receivedHeaders?.['x-client-version'],
					clientCommit: receivedHeaders?.['x-client-commit'],
					machineId: receivedHeaders?.['x-machine-id']
				}, {
					clientName: 'ovscode-test',
					clientVersion: '1.2.3',
					clientCommit: undefined,
					machineId: undefined
				});
			} finally {
				await new Promise<void>(resolve => server.close(() => resolve()));
			}
		});
	});

	describe('Gallery browser resource proxy', () => {
		installAllHandlers(logger);

		it('fetches a Gallery resource through the web proxy in Chromium with Name and Version only', async function () {
			const app = this.app as Application;
			const runtimeGlobal = globalThis as typeof globalThis & { _VSCODE_FILE_ROOT?: string };
			const previousFileRoot = runtimeGlobal._VSCODE_FILE_ROOT;
			runtimeGlobal._VSCODE_FILE_ROOT = path.resolve(__dirname, '../../../../../out');
			let WebClientServer: new (...services: unknown[]) => {
				handle(request: http.IncomingMessage, response: http.ServerResponse, parsedUrl: URL, pathname: string): Promise<void>;
			};
			try {
				({ WebClientServer } = require('../../../../../out/vs/server/node/webClientServer.js') as {
				WebClientServer: new (...services: unknown[]) => {
					handle(request: http.IncomingMessage, response: http.ServerResponse, parsedUrl: URL, pathname: string): Promise<void>;
				};
				});
			} finally {
				runtimeGlobal._VSCODE_FILE_ROOT = previousFileRoot;
			}
			const { VSBuffer, bufferToStream } = require('../../../../../out/vs/base/common/buffer.js') as {
				VSBuffer: { wrap(value: Uint8Array): unknown };
				bufferToStream(value: unknown): unknown;
			};

			let upstreamUrl: string | undefined;
			let upstreamHeaders: Record<string, string> | undefined;
			const server = new WebClientServer(
				{ type: 0, validate: () => true },
				'',
				'',
				{ isBuilt: true, args: {} },
				{ error: () => undefined, trace: () => undefined, getLevel: () => 0 },
				{
					request: async (options: { url: string; headers: Record<string, string> }) => {
						upstreamUrl = options.url;
						upstreamHeaders = options.headers;
						return {
							res: { statusCode: 200, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } },
							stream: bufferToStream(VSBuffer.wrap(Buffer.from('mock Gallery resource')))
						};
					}
				},
				{ extensionsGallery: { resourceUrlTemplate: 'https://gallery.example/publisher/extension/resource.json' } },
				{ isEnabled: false }
			);

			const proxyServer = http.createServer((request, response) => {
				const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
				if (requestUrl.pathname === '/') {
					response.writeHead(200, { 'Content-Type': 'text/html' });
					response.end('<!doctype html><title>Gallery proxy fixture</title>');
					return;
				}
				void server.handle(request, response, requestUrl, requestUrl.pathname).catch(error => {
					response.writeHead(500, { 'Content-Type': 'text/plain' });
					response.end(String(error));
				});
			});
			await new Promise<void>((resolve, reject) => {
				proxyServer.once('error', reject);
				proxyServer.listen(0, '127.0.0.1', resolve);
			});

			try {
				const address = proxyServer.address();
				if (!address || typeof address === 'string') {
					throw new Error('Could not determine the Gallery proxy fixture port.');
				}
				const page = app.code.driver.currentPage;
				await page.goto(`http://127.0.0.1:${address.port}/`);
				const result = await page.evaluate(async () => {
					const response = await fetch('/web-extension-resource/gallery.example/publisher/extension/resource.json', {
						mode: 'cors',
						headers: {
							'X-Client-Name': 'ovscode-test-web',
							'X-Client-Version': '1.2.3'
						}
					});
					return { status: response.status, body: await response.text() };
				});
				assert.deepStrictEqual({
					result,
					upstreamUrl,
					clientName: upstreamHeaders?.['X-Client-Name'],
					clientVersion: upstreamHeaders?.['X-Client-Version'],
					clientCommit: upstreamHeaders?.['X-Client-Commit']
				}, {
					result: { status: 200, body: 'mock Gallery resource' },
					upstreamUrl: 'https://gallery.example/publisher/extension/resource.json',
					clientName: 'ovscode-test-web',
					clientVersion: '1.2.3',
					clientCommit: undefined
				});
			} finally {
				await new Promise<void>(resolve => proxyServer.close(() => resolve()));
			}
		});
	});
}
