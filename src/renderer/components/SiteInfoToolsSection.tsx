import React, { useEffect, useState } from 'react';
import { EmptyArea, Text, Divider, Button, TextButton } from '@getflywheel/local-components';
import { ipcAsync } from '@getflywheel/local/renderer';
import type { Site } from '@getflywheel/local';
import { URLS } from '../../constants';
import useActiveSiteID from './useActiveSiteID';
import { BackupSnapshot, HubOAuthProviders, HubProviderRecord, Providers } from '../../types';
import { useStoreSelector, selectors, store, actions } from '../store/store';
import { createBackupModal } from './BackupInfoModal';

/* @ts-ignore */
import GoogleDriveIcon from '../assets/google-drive.svg';
/* @ts-ignore */
import DropboxIcon from '../assets/dropbox.svg';
/* @ts-ignore */
import styles from './SiteInfoToolsSection.scss';

interface Props {
	site: Site;
}

/**
 * Map a Hub provided storage provider id to the appropriate icon
 *
 * @param provider
 */
const getProviderIcon = (provider: HubOAuthProviders) => {
	if (provider === 'google') {
		return GoogleDriveIcon;
	}

	if (provider === 'dropbox') {
		return DropboxIcon;
	}

	return null;
};

/**
 * Helper to add dividers between each of a list of JSX elements. Does not add ad divider
 * before the first or after the last element
 *
 * @param items
 */
const addDivider = (items) => items.reduce((acc, item, i) => {
	acc.push(item);

	if (i !== items.length - 1) {
		acc.push(<Divider className={styles.SiteInfoToolsSection_ProviderDivider}/>);
	}

	return acc;
}, []);

/**
 * Hub/Rsync use slightly different naming conventions for each provider. This maps from the Hub
 * provided values to those expected by Rsync
 *
 * @param hubProvider
 */
const hubProviderToProvider = (hubProvider: HubOAuthProviders) => {
	if (hubProvider === HubOAuthProviders.Google) {
		return Providers.Drive;
	}

	if (hubProvider === HubOAuthProviders.Dropbox) {
		return Providers.Dropbox;
	}

	return null;
};

/**
 * Light convenience wrapper around ipcAsync to launch a web browser in the default browser as configured by Local
 *
 * @param url
 */
const launchBrowser = (url: string) => ipcAsync(
	'browserService:launch',
	url,
);

/**
 * Light convenience wrapper around ipcAsync to backup a site
 *
 * @param site
 * @param provider
 */
const backupSite = (site: Site, provider: Providers) => ipcAsync(
	'backups:backup-site',
	site.id,
	provider,
);

const SnapshotList = (props: { snapshots: BackupSnapshot[], site: Site, provider: Providers }) => (
	<ul>
		{props.snapshots.map(({ updatedAt, hash }) => (
			<li>
				{updatedAt}
				<Button
					onClick={() => ipcAsync(
						'backups:restore-backup', {
							snapshotID: hash,
							provider: props.provider,
							siteID: props.site.id,
						},
					)}
				>
					Revert to this backup
				</Button>
			</li>
		))}
	</ul>
);

const SiteInfoToolsSection = (props: Props) => {
	const { site } = props;

	useActiveSiteID(site.id);

	const enabledProviders = useStoreSelector(selectors.enabledProviders);

	const [loadingProviders, setLoadingProviders] = useState(false);

	const [snapshots, setSnapshots] = useState({});

	useEffect(() => {
	    (async () => {
			setLoadingProviders(true);
			const providers: HubProviderRecord[] = await ipcAsync('backups:enabled-providers');
			store.dispatch(actions.setEnabledProviders(providers));
			setLoadingProviders(false);

			const promises = [];
			const hubProviderNames: HubOAuthProviders[] = [];
			providers
				.map(({ id }) => id)
				.forEach((providerID) => {
					promises.push(ipcAsync('backups:provider-snapshots', site.id, providerID));
					hubProviderNames.push(providerID);
				});

			const resolvedSnapshots: BackupSnapshot[][] = await Promise.all(promises);

			setSnapshots(
				resolvedSnapshots.reduce((nextSnapshotState, snapshotList, i) => {
					const provider = hubProviderNames[i];
					nextSnapshotState[provider] = snapshotList;
					return nextSnapshotState;
				}, {}),
			);
	    })();
	}, []);

	/**
	 * @todo sometimes the query to hub fails (like if the auth token has expired)
	 * we should handle that more gracefully
	 */
	if (loadingProviders) {
		return (
			<span>loading...</span>
		);
	}

	return (
		<div className={styles.SiteInfoToolsSection}>
			<div className={styles.SiteInfoToolsSection_Header}>
				{/* <GoogleDriveIcon /> */}
				<Text>
					Latest backup: N/A
				</Text>
				<TextButton onClick={() => launchBrowser(`${URLS.LOCAL_HUB}/addons/backups`)}>
					Manage Connections
				</TextButton>
			</div>
			<Divider />
			{addDivider(enabledProviders.map(({ id, name }) => {
				const Icon = getProviderIcon(id);
				const provider = hubProviderToProvider(id);

				return (
					<>
						<div className={styles.SiteInfoToolsSection_ProviderHeader}>
							<Icon />
							<Text privateOptions={{ fontSize: 'm', fontWeight: 'bold' }}>{name}</Text>
							<Button
								onClick={() => createBackupModal(backupSite, site, provider, snapshots[id])}
							>
								Backup Site
							</Button>
						</div>
						{
							snapshots[id]?.length
								? (
									<SnapshotList
										snapshots={snapshots[id]}
										site={site}
										provider={provider}
									/>
								)
								: (
									<EmptyArea className={styles.SiteInfoToolsSection_EmptyArea}>
										<Text>No backups created yet</Text>
									</EmptyArea>
								)
						}
					</>
				);
			}))}
		</div>
	);
};

export default SiteInfoToolsSection;