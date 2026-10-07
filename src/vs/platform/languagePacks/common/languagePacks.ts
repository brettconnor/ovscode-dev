/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { language } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { IQuickPickItem } from '../../quickinput/common/quickInput.js';
import { localize } from '../../../nls.js';
import { IGalleryExtension } from '../../extensionManagement/common/extensionManagement.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export function getLocale(extension: IGalleryExtension): string | undefined {
	return extension.tags.find(t => t.startsWith('lp-'))?.split('lp-')[1];
}

export const ILanguagePackService = createDecorator<ILanguagePackService>('languagePackService');

export interface ILanguagePackItem extends IQuickPickItem {
	readonly extensionId?: string;
}

export interface ILanguagePackService {
	readonly _serviceBrand: undefined;
	getInstalledLanguages(): Promise<Array<ILanguagePackItem>>;
	getBuiltInExtensionTranslationsUri(id: string, language: string): Promise<URI | undefined>;
}

export abstract class LanguagePackBaseService extends Disposable implements ILanguagePackService {
	declare readonly _serviceBrand: undefined;

	constructor() { super(); }

	abstract getBuiltInExtensionTranslationsUri(id: string, language: string): Promise<URI | undefined>;

	abstract getInstalledLanguages(): Promise<Array<ILanguagePackItem>>;

	protected createQuickPickItem(locale: string, languageName?: string): IQuickPickItem {
		const label = languageName ?? locale;
		let description: string | undefined;
		if (label !== locale) {
			description = `(${locale})`;
		}

		if (locale.toLowerCase() === language.toLowerCase()) {
			description ??= '';
			description += localize('currentDisplayLanguage', " (Current)");
		}

		return {
			id: locale,
			label,
			description
		};
	}
}
