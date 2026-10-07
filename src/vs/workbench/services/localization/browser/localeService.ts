/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Language, LANGUAGE_DEFAULT } from '../../../../base/common/platform.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILanguagePackItem } from '../../../../platform/languagePacks/common/languagePacks.js';
import { IActiveLanguagePackService, ILocaleService } from '../common/locale.js';
import { IHostService } from '../../host/browser/host.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

const localeStorage = new class LocaleStorage {

	private static readonly LOCAL_STORAGE_LOCALE_KEY = 'vscode.nls.locale';
	private static readonly LOCAL_STORAGE_EXTENSION_ID_KEY = 'vscode.nls.languagePackExtensionId';

	setLocale(locale: string): void {
		localStorage.setItem(LocaleStorage.LOCAL_STORAGE_LOCALE_KEY, locale);
		this.doSetLocaleToCookie(locale);
	}

	private doSetLocaleToCookie(locale: string): void {
		document.cookie = `${LocaleStorage.LOCAL_STORAGE_LOCALE_KEY}=${locale};path=/;max-age=3153600000`;
	}

	clearLocale(): void {
		localStorage.removeItem(LocaleStorage.LOCAL_STORAGE_LOCALE_KEY);
		this.doClearLocaleToCookie();
	}

	private doClearLocaleToCookie(): void {
		document.cookie = `${LocaleStorage.LOCAL_STORAGE_LOCALE_KEY}=;path=/;max-age=0`;
	}

	setExtensionId(extensionId: string): void {
		localStorage.setItem(LocaleStorage.LOCAL_STORAGE_EXTENSION_ID_KEY, extensionId);
	}

	getExtensionId(): string | null {
		return localStorage.getItem(LocaleStorage.LOCAL_STORAGE_EXTENSION_ID_KEY);
	}

	clearExtensionId(): void {
		localStorage.removeItem(LocaleStorage.LOCAL_STORAGE_EXTENSION_ID_KEY);
	}
};

export class WebLocaleService implements ILocaleService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IDialogService private readonly dialogService: IDialogService,
		@IHostService private readonly hostService: IHostService,
		@IProductService private readonly productService: IProductService
	) { }

	async setLocale(languagePackItem: ILanguagePackItem, _skipDialog = false): Promise<void> {
		const locale = languagePackItem.id;
		if (locale === Language.value() || (!locale && Language.value() === navigator.language.toLowerCase())) {
			return;
		}
		if (locale) {
			localeStorage.setLocale(locale);
			if (languagePackItem.extensionId) {
				localeStorage.setExtensionId(languagePackItem.extensionId);
			}
		} else {
			localeStorage.clearLocale();
			localeStorage.clearExtensionId();
		}

		const restartDialog = await this.dialogService.confirm({
			type: 'info',
			message: localize('relaunchDisplayLanguageMessage', "To change the display language, {0} needs to reload", this.productService.nameLong),
			detail: localize('relaunchDisplayLanguageDetail', "Press the reload button to refresh the page and set the display language to {0}.", languagePackItem.label),
			primaryButton: localize({ key: 'reload', comment: ['&& denotes a mnemonic character'] }, "&&Reload"),
		});

		if (restartDialog.confirmed) {
			this.hostService.restart();
		}
	}

	async clearLocalePreference(): Promise<void> {
		localeStorage.clearLocale();
		localeStorage.clearExtensionId();

		if (Language.value() === navigator.language.toLowerCase()) {
			return;
		}

		const restartDialog = await this.dialogService.confirm({
			type: 'info',
			message: localize('clearDisplayLanguageMessage', "To change the display language, {0} needs to reload", this.productService.nameLong),
			detail: localize('clearDisplayLanguageDetail', "Press the reload button to refresh the page and use your browser's language."),
			primaryButton: localize({ key: 'reload', comment: ['&& denotes a mnemonic character'] }, "&&Reload"),
		});

		if (restartDialog.confirmed) {
			this.hostService.restart();
		}
	}
}

class WebActiveLanguagePackService implements IActiveLanguagePackService {
	_serviceBrand: undefined;

	async getExtensionIdProvidingCurrentLocale(): Promise<string | undefined> {
		const language = Language.value();
		if (language === LANGUAGE_DEFAULT) {
			return undefined;
		}
		const extensionId = localeStorage.getExtensionId();
		if (extensionId) {
			return extensionId;
		}

		return undefined;
	}
}

registerSingleton(ILocaleService, WebLocaleService, InstantiationType.Delayed);
registerSingleton(IActiveLanguagePackService, WebActiveLanguagePackService, InstantiationType.Delayed);
