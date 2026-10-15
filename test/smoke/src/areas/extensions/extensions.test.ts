/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as http from 'http';
import { Application, Logger } from '../../../../automation';
import { installAllHandlers } from '../../utils';

export function setup(logger: Logger) {
	describe('Extensions', () => {

		// Shared before/after handling
		installAllHandlers(logger, opts => {
			opts.verbose = true; // enable verbose logging for tracing
			opts.snapshots = true; // enable network tab in devtools for tracing since we install an extension
			return opts;
		});

		it('fetches a Gallery resource without sending the machine ID header', async () => {
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
					clientCommit: 'test-commit',
					machineId: undefined
				});
			} finally {
				await new Promise<void>(resolve => server.close(() => resolve()));
			}
		});

		it.skip('install and enable vscode-smoketest-check extension', async function () {
			const app = this.app as Application;

			await app.workbench.extensions.installExtension('ms-vscode.vscode-smoketest-check', true);

			// Close extension editor because keybindings dispatch is not working when web views are opened and focused
			// https://github.com/microsoft/vscode/issues/110276
			await app.workbench.extensions.closeExtension('vscode-smoketest-check');

			await app.workbench.quickaccess.runCommand('Smoke Test Check', { match: 'exactLabel' });
		});
	});
}
