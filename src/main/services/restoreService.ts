import path from 'path';
import { Machine, interpret, assign } from 'xstate';
import { getServiceContainer } from '@getflywheel/local/main';
import { Site as LocalSiteModel } from '@getflywheel/local';
import tmp from 'tmp';
import type { DirResult } from 'tmp';
import fs from 'fs-extra';
import { getSiteDataFromDisk, camelCaseToSentence } from '../utils';
import { getBackupSite } from '../hubQueries';
import { restoreBackup as restoreResticBackup } from '../cli';
import type { Site, Providers, GenericObject } from '../../types';
import serviceState from './state';
import { backupSQLDumpFile, IPCEVENTS } from '../../constants';
import { getFilteredSiteFiles } from '../../helpers/ignoreFilesPattern';
import { formatHomePath } from '../../helpers/formatHomePath';

const serviceContainer = getServiceContainer().cradle;
const { localLogger, runSiteSQLCmd, importSQLFile, sendIPCEvent, siteProcessManager } = serviceContainer;

const logger = localLogger.child({
	thread: 'main',
	class: 'BackupAddonRestoreService',
});

interface BackupMachineContext {
	site: Site;
	initialSiteStatus: string;
	provider: Providers;
	snapshotID: string;
	encryptionPassword?: string;
	backupSiteID?: number;
	localBackupRepoID?: string;
	tmpDirData?: DirResult;
	error?: string;
}

interface BackupMachineSchema {
	states: {
		creatingTmpDir: GenericObject;
		gettingBackupCredentials: GenericObject;
		restoringBackup: GenericObject;
		movingSiteFromTmpDir: GenericObject;
		restoringDatabase: GenericObject;
		finished: GenericObject;
		failed: GenericObject;
	}
}

const getCredentials = async (context: BackupMachineContext) => {
	const { site } = context;
	const { localBackupRepoID } = getSiteDataFromDisk(site.id);
	const { uuid, password, id } = await getBackupSite(localBackupRepoID);

	return {
		encryptionPassword: password,
		localBackupRepoID: uuid,
		backupSiteID: id,
	};
};

const createTmpDir = async () => ({
	tmpDirData: tmp.dirSync(),
});

const importDatabase = async (context: BackupMachineContext) => {
	const { tmpDirData } = context;
	const site = new LocalSiteModel(context.site);

	/**
	 * @todo it might be worthwhile doing a recursive scan for this file
	 */
	const sqlFile = path.join(
		tmpDirData.name, 'app', 'sql', backupSQLDumpFile,
	);

	if (!fs.existsSync(sqlFile)) {
		logger.warn('No SQL file found in this backup: continuing without database restore');
		return;
	}

	const existingSqlMode = await runSiteSQLCmd({ site, query: 'SELECT @@SQL_MODE;' });

	await runSiteSQLCmd({
		site,
		query: 'SET GLOBAL SQL_MODE=\'NO_AUTO_VALUE_ON_ZERO\';',
	});

	await runSiteSQLCmd({
		site,
		query: `SET names 'utf8'; DROP DATABASE ${site.mysql!.database}; CREATE DATABASE IF NOT EXISTS ${site.mysql!.database};`,
	});

	await importSQLFile(site, sqlFile);

	await runSiteSQLCmd({
		site,
		query: `SET GLOBAL SQL_MODE='${existingSqlMode}';`,
	});
};

const moveSiteFromTmpDir = async (context: BackupMachineContext) => {
	const { site, tmpDirData } = context;

	const sitePath = formatHomePath(site.path);

	const itemsToDelete = getFilteredSiteFiles(site);

	logger.info(`removing the following directories/files to prepare for the site backup: ${itemsToDelete.map((file) => `"${file}"`).join(', ')}`);

	const promises = itemsToDelete.map((dirOrFile: string) => fs.remove(dirOrFile));

	await Promise.all(promises);

	fs.copySync(
		tmpDirData.name,
		sitePath,
		/**
		 * @todo ensure that we don't go willy nilly deleting files that are actually symlinks pointing outside of a site directory
		 */
	);

	logger.info(`Site contents moved from \'${tmpDirData.name}\' to \'${sitePath}\'`);
};

const restoreBackup = async (context: BackupMachineContext) => {
	const { site, provider, encryptionPassword, snapshotID, tmpDirData } = context;

	await restoreResticBackup({
		site,
		provider,
		encryptionPassword,
		snapshotID,
		restoreDir: tmpDirData.name,
	});
};

const removeTmpDir = async (context: BackupMachineContext) => {
	const { tmpDirData } = context;

	// removeCallback will error if the tmp directory is not empty
	fs.emptyDirSync(tmpDirData.name);
	tmpDirData.removeCallback();
};

const onErrorFactory = () => ({
	target: 'failed',
	actions: [
		'setErrorOnContext',
		'logError',
		'setErroredStatus',
	],
});

const setErroredStatus = (context: BackupMachineContext) => {
	const { initialSiteStatus, site } = context;
	sendIPCEvent('updateSiteStatus', site.id, initialSiteStatus);

	sendIPCEvent('showSiteBanner', {
		siteID: site.id,
		id: 'site-errored-backup',
		variant: 'error',
		icon: 'warning',
		title: 'Backup errored!',
		message: `There was an error while restoring your backup.`,
	});

	siteProcessManager.restart(site);
};

// eslint-disable-next-line new-cap
const restoreMachine = Machine<BackupMachineContext, BackupMachineSchema>(
	/**
	 * - Flip tmp logic
	 * - Does restic have a delete flag like rsync?
	 * - Is there a better way that does require doubling disk footprint?
	 * - keep ignored files present when restoring
	 * - can we create a new temp database to import the backup dump? And then if successful then rename it and delete the original
	 */
	{
		id: 'restoreBackup',
		initial: 'gettingBackupCredentials',
		context: {
			site: null,
			provider: null,
			snapshotID: null,
			encryptionPassword: null,
			backupSiteID: null,
			localBackupRepoID: null,
			tmpDirData: null,
			error: null,
		},
		states: {
			gettingBackupCredentials: {
				invoke: {
					src: (context, event) => getCredentials(context),
					onDone: {
						target: 'creatingTmpDir',
						actions: assign((context, { data: { encryptionPassword, backupSiteID, localBackupRepoID } }) => ({
							encryptionPassword,
							backupSiteID,
							localBackupRepoID,
						})),
					},
					onError: onErrorFactory(),
				},
			},
			/**
			 * @todo refactor this into an action or something else since createTmpDir technically does not need to be async
			 */
			creatingTmpDir: {
				invoke: {
					src: (context, event) => createTmpDir(),
					onDone: {
						target: 'restoringBackup',
						actions: assign({
							tmpDirData: (_, event) => event.data.tmpDirData,
						}),
					},
					onError: onErrorFactory(),
				},
			},
			restoringBackup: {
				invoke: {
					src: (context, event) => restoreBackup(context),
					onDone: {
						target: 'movingSiteFromTmpDir',
					},
					onError: onErrorFactory(),
				},
			},
			movingSiteFromTmpDir: {
				invoke: {
					src: (context, event) => moveSiteFromTmpDir(context),
					onDone: {
						target: 'restoringDatabase',
					},
					onError: onErrorFactory(),
				},
			},
			restoringDatabase: {
				invoke: {
					src: (context) => importDatabase(context),
					onDone: {
						target: 'finished',
					},
					onError: onErrorFactory(),
				},
			},
			finished: {
				type: 'final',
				entry: 'removeTmpDir',
			},
			failed: {
				type: 'final',
			},
		},
	},
	{
		actions: {
			removeTmpDir,
			setErrorOnContext: assign((context, event) => ({
				error: event.data,
			})),
			logError: (context, event) => {
				logger.error(event.data);
			},
			setErroredStatus,
		},
	},
);

/**
 * Creates a new state machine instance/service to manage restoring up a site
 *
 * @param opts
 * @returns
 */
export const restoreFromBackup = async (opts: { site: Site; provider: Providers; snapshotID: string; }) => {
	if (serviceState.inProgressStateMachine) {
		logger.warn('Restore process aborted: only one backup or restore process is allowed at one time and a backup or restore is already in progress.');
		return;
	}

	const { site, provider, snapshotID } = opts;

	return new Promise((resolve) => {
		const initialSiteStatus = siteProcessManager.getSiteStatus(site);

		const machine = restoreMachine.withContext({ site, provider, snapshotID, initialSiteStatus });
		const restoreService = interpret(machine)
			.onTransition((state) => {
				sendIPCEvent(IPCEVENTS.BACKUP_STARTED);
				logger.info(camelCaseToSentence(state.value as string));
			})
			.onDone(() => restoreService.stop())
			.onStop(() => {
				serviceState.inProgressStateMachine = null;
				// eslint-disable-next-line no-underscore-dangle
				const { error } = restoreService._state;

				sendIPCEvent(IPCEVENTS.BACKUP_COMPLETED);

				if (error) {
					resolve({ error });
				}

				resolve(null);
			});

		serviceState.inProgressStateMachine = restoreService;
		restoreService.start();
	});
};
