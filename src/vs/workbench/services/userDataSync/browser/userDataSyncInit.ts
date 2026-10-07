/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { GlobalStateInitializer, UserDataSyncStoreTypeSynchronizer } from '../../../../platform/userDataSync/common/globalStateSync.js';
import { KeybindingsInitializer } from '../../../../platform/userDataSync/common/keybindingsSync.js';
import { SettingsInitializer } from '../../../../platform/userDataSync/common/settingsSync.js';
import { SnippetsInitializer } from '../../../../platform/userDataSync/common/snippetsSync.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { UserDataSyncStoreClient } from '../../../../platform/userDataSync/common/userDataSyncStoreService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IUserData, IUserDataSyncResourceInitializer, IUserDataSyncStoreManagementService, SyncResource } from '../../../../platform/userDataSync/common/userDataSync.js';
import { AuthenticationSessionInfo, getCurrentAuthenticationSessionInfo } from '../../authentication/browser/authenticationService.js';
import { getSyncAreaLabel } from '../common/userDataSync.js';
import { isWeb } from '../../../../base/common/platform.js';
import { Barrier, Promises } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { TasksInitializer } from '../../../../platform/userDataSync/common/tasksSync.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IUserDataInitializer } from '../../userData/browser/userDataInit.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';

export class UserDataSyncInitializer implements IUserDataInitializer {

	_serviceBrand: undefined;

	private readonly initialized: SyncResource[] = [];
	private readonly initializationFinished = new Barrier();
	private globalStateUserData: IUserData | null = null;

	constructor(
		@IBrowserWorkbenchEnvironmentService private readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IUserDataSyncStoreManagementService private readonly userDataSyncStoreManagementService: IUserDataSyncStoreManagementService,
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		this.createUserDataSyncStoreClient().then(userDataSyncStoreClient => {
			if (!userDataSyncStoreClient) {
				this.initializationFinished.open();
			}
		});
	}

	private _userDataSyncStoreClientPromise: Promise<UserDataSyncStoreClient | undefined> | undefined;
	private createUserDataSyncStoreClient(): Promise<UserDataSyncStoreClient | undefined> {
		if (!this._userDataSyncStoreClientPromise) {
			this._userDataSyncStoreClientPromise = (async (): Promise<UserDataSyncStoreClient | undefined> => {
				try {
					if (!isWeb) {
						this.logService.trace(`Skipping initializing user data in desktop`);
						return;
					}

					if (!this.storageService.isNew(StorageScope.APPLICATION)) {
						this.logService.trace(`Skipping initializing user data as application was opened before`);
						return;
					}

					if (!this.storageService.isNew(StorageScope.WORKSPACE)) {
						this.logService.trace(`Skipping initializing user data as workspace was opened before`);
						return;
					}

					if (this.environmentService.options?.settingsSyncOptions?.authenticationProvider && !this.environmentService.options.settingsSyncOptions.enabled) {
						this.logService.trace(`Skipping initializing user data as settings sync is disabled`);
						return;
					}

					let authenticationSession;
					try {
						authenticationSession = await getCurrentAuthenticationSessionInfo(this.secretStorageService, this.productService);
					} catch (error) {
						this.logService.error(error);
					}
					if (!authenticationSession) {
						this.logService.trace(`Skipping initializing user data as authentication session is not set`);
						return;
					}

					await this.initializeUserDataSyncStore(authenticationSession);

					const userDataSyncStore = this.userDataSyncStoreManagementService.userDataSyncStore;
					if (!userDataSyncStore) {
						this.logService.trace(`Skipping initializing user data as sync service is not provided`);
						return;
					}

					const userDataSyncStoreClient = new UserDataSyncStoreClient(userDataSyncStore.url, this.productService, this.requestService, this.logService, this.environmentService, this.fileService, this.storageService);
					userDataSyncStoreClient.setAuthToken(authenticationSession.accessToken, authenticationSession.providerId);

					const manifest = await userDataSyncStoreClient.manifest(null);
					if (manifest === null) {
						userDataSyncStoreClient.dispose();
						this.logService.trace(`Skipping initializing user data as there is no data`);
						return;
					}

					this.logService.info(`Using settings sync service ${userDataSyncStore.url.toString()} for initialization`);
					return userDataSyncStoreClient;

				} catch (error) {
					this.logService.error(error);
					return;
				}
			})();
		}

		return this._userDataSyncStoreClientPromise;
	}

	private async initializeUserDataSyncStore(authenticationSession: AuthenticationSessionInfo): Promise<void> {
		const userDataSyncStore = this.userDataSyncStoreManagementService.userDataSyncStore;
		if (!userDataSyncStore?.canSwitch) {
			return;
		}

		const disposables = new DisposableStore();
		try {
			const userDataSyncStoreClient = disposables.add(new UserDataSyncStoreClient(userDataSyncStore.url, this.productService, this.requestService, this.logService, this.environmentService, this.fileService, this.storageService));
			userDataSyncStoreClient.setAuthToken(authenticationSession.accessToken, authenticationSession.providerId);

			// Cache global state data for global state initialization
			this.globalStateUserData = await userDataSyncStoreClient.readResource(SyncResource.GlobalState, null);

			if (this.globalStateUserData) {
				const userDataSyncStoreType = new UserDataSyncStoreTypeSynchronizer(userDataSyncStoreClient, this.storageService, this.environmentService, this.fileService, this.logService).getSyncStoreType(this.globalStateUserData);
				if (userDataSyncStoreType) {
					await this.userDataSyncStoreManagementService.switch(userDataSyncStoreType);

					// Unset cached global state data if urls are changed
					if (!isEqual(userDataSyncStore.url, this.userDataSyncStoreManagementService.userDataSyncStore?.url)) {
						this.logService.info('Switched settings sync store');
						this.globalStateUserData = null;
					}
				}
			}
		} finally {
			disposables.dispose();
		}
	}

	async whenInitializationFinished(): Promise<void> {
		await this.initializationFinished.wait();
	}

	async requiresInitialization(): Promise<boolean> {
		this.logService.trace(`UserDataInitializationService#requiresInitialization`);
		const userDataSyncStoreClient = await this.createUserDataSyncStoreClient();
		return !!userDataSyncStoreClient;
	}

	async initializeRequiredResources(): Promise<void> {
		this.logService.trace(`UserDataInitializationService#initializeRequiredResources`);
		return this.initialize([SyncResource.Settings, SyncResource.GlobalState]);
	}

	async initializeInstalledExtensions(_instantiationService: IInstantiationService): Promise<void> { }

	async initializeOtherResources(_instantiationService: IInstantiationService): Promise<void> {
		try {
			this.logService.trace(`UserDataInitializationService#initializeOtherResources`);
			await this.initialize([SyncResource.Keybindings, SyncResource.Snippets, SyncResource.Tasks]);
		} finally {
			this.initializationFinished.open();
		}
	}

	private async initialize(syncResources: SyncResource[]): Promise<void> {
		const userDataSyncStoreClient = await this.createUserDataSyncStoreClient();
		if (!userDataSyncStoreClient) {
			return;
		}

		await Promises.settled(syncResources.map(async syncResource => {
			try {
				if (this.initialized.includes(syncResource)) {
					this.logService.info(`${getSyncAreaLabel(syncResource)} initialized already.`);
					return;
				}
				this.initialized.push(syncResource);
				this.logService.trace(`Initializing ${getSyncAreaLabel(syncResource)}`);
				const initializer = this.createSyncResourceInitializer(syncResource);
				const userData = await userDataSyncStoreClient.readResource(syncResource, syncResource === SyncResource.GlobalState ? this.globalStateUserData : null);
				await initializer.initialize(userData);
				this.logService.info(`Initialized ${getSyncAreaLabel(syncResource)}`);
			} catch (error) {
				this.logService.info(`Error while initializing ${getSyncAreaLabel(syncResource)}`);
				this.logService.error(error);
			}
		}));
	}

	private createSyncResourceInitializer(syncResource: SyncResource): IUserDataSyncResourceInitializer {
		switch (syncResource) {
			case SyncResource.Settings: return new SettingsInitializer(this.fileService, this.userDataProfilesService, this.environmentService, this.logService, this.storageService, this.uriIdentityService);
			case SyncResource.Keybindings: return new KeybindingsInitializer(this.fileService, this.userDataProfilesService, this.environmentService, this.logService, this.storageService, this.uriIdentityService);
			case SyncResource.Tasks: return new TasksInitializer(this.fileService, this.userDataProfilesService, this.environmentService, this.logService, this.storageService, this.uriIdentityService);
			case SyncResource.Snippets: return new SnippetsInitializer(this.fileService, this.userDataProfilesService, this.environmentService, this.logService, this.storageService, this.uriIdentityService);
			case SyncResource.GlobalState: return new GlobalStateInitializer(this.storageService, this.fileService, this.userDataProfilesService, this.environmentService, this.logService, this.uriIdentityService);
		}
		throw new Error(`Cannot create initializer for ${syncResource}`);
	}

}
