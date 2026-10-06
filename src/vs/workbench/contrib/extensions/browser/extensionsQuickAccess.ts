/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPickerQuickAccessItem, PickerQuickAccessProvider } from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { localize } from '../../../../nls.js';
import { IExtensionsWorkbenchService } from '../common/extensions.js';

export class ManageExtensionsQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {

	static PREFIX = 'ext ';

	constructor(@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService) {
		super(ManageExtensionsQuickAccessProvider.PREFIX);
	}

	protected _getPicks(): Array<IPickerQuickAccessItem | IQuickPickSeparator> {
		return [{
			label: localize('manage', "Press Enter to manage your extensions."),
			accept: () => this.extensionsWorkbenchService.openSearch('')
		}];
	}
}
