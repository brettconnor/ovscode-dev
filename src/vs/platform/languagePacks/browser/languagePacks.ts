/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { ILanguagePackItem, LanguagePackBaseService } from '../common/languagePacks.js';

export class WebLanguagePacksService extends LanguagePackBaseService {
	getBuiltInExtensionTranslationsUri(_id: string, _language: string): Promise<URI | undefined> {
		return Promise.resolve(undefined);
	}

	// Web doesn't have a concept of language packs, so we just return an empty array
	getInstalledLanguages(): Promise<ILanguagePackItem[]> {
		return Promise.resolve([]);
	}
}
