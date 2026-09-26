/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { WorkspaceArgumentKind } from '../../../common/workspaceSelection.js';

export interface IAgentsWindowFolderIntent {
	readonly folderUri: URI | undefined;
}

/** Classifies the original argument without exposing its path or remote authority. */
export function getAgentsWindowWorkspaceArgumentKind(workspaceUri: URI | undefined): WorkspaceArgumentKind {
	if (!workspaceUri) {
		return 'none';
	}
	if (workspaceUri.scheme === Schemas.file) {
		return 'local';
	}
	if (workspaceUri.scheme === Schemas.vscodeRemote) {
		return 'remote';
	}
	return 'other';
}

export function resolveAgentsWindowFolderIntent(workspaceUri: URI | undefined): IAgentsWindowFolderIntent {
	if (workspaceUri?.scheme === Schemas.file) {
		return { folderUri: workspaceUri };
	}
	return { folderUri: undefined };
}
