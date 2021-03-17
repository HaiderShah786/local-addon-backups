import type { Site as SiteBase } from '@getflywheel/local';

export type GenericObject = { [key: string]: any };

/**
 * Creates a light wrapper around the Site type as an easy way to extend the type exported
 * on the Local API
 */
export interface Site extends SiteBase {
	localBackupRepoID?: string;
}

type SiteMetaDataBase = Pick<SiteBase,
	'name' |
	'services' |
	'mysql'
>

export interface SiteMetaData extends SiteMetaDataBase {
	localBackupRepoID: string;
}

/**
 * Provider names as used by rclone
 * This is analogous to the options availabe for a Storage Provider while manually configuring an rclone remote
 */
export enum Providers {
	Drive = 'drive',
	Dropbox = 'dropbox',
}

/**
 * Provider names as used by Hub
 * These are equivalent to the names of the OAuth providers for a given backend
 * - "google" is the oauth provider for "drive"
 * - "dropbox" is the oauth provider for "dropbox"
 */
export enum HubOAuthProviders {
	Google = 'google',
	Dropbox = 'dropbox',
}

export interface HubProviderRecord {
	id: HubOAuthProviders;
	name: string;
}

export interface BackupSite {
	id: number;
	uuid: string;
	password: string;
}

export interface BackupRepo {
	id: number;
	siteID: string;
	providerID: string;
	hash: string;
}

export interface BackupSnapshot {
	id: number;
	duration: number;
	repoID: number;
	hash: string;
	/**
	 * @todo find out if this can be typed with Date since Hub types this as DateTime
	 */
	updatedAt?: number;
}

export interface RcloneConfig {
	type: string;
	clientID: string;
	token: string;
	appKey: string;
}
