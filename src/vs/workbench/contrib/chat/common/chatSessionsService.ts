/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/** The local Chat session type. */
export namespace SessionType {
	export const Local = 'local';
}

export const localChatSessionType = SessionType.Local;

export const enum ChatSessionStatus {
	Failed = 0,
	Completed = 1,
	InProgress = 2,
	NeedsInput = 3
}

export function isSessionInProgressStatus(state: ChatSessionStatus): boolean {
	return state === ChatSessionStatus.InProgress || state === ChatSessionStatus.NeedsInput;
}

export interface IChatSessionFileChange2 {
	readonly uri: URI;
	readonly originalUri?: URI;
	readonly modifiedUri?: URI;
	readonly insertions: number;
	readonly deletions: number;
	readonly reviewed?: boolean;
}

export function isIChatSessionFileChange2(obj: unknown): obj is IChatSessionFileChange2 {
	const candidate = obj as IChatSessionFileChange2;
	return candidate && candidate.uri instanceof URI && typeof candidate.insertions === 'number' && typeof candidate.deletions === 'number';
}
