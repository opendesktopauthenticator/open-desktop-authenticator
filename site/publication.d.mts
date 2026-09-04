export interface PublishedVersion {
	publishedOn?: string;
}

export interface PublicationRecords {
	github: Record<string, PublishedVersion>;
	store: Record<string, Record<string, never>>;
}

export interface ChannelPublication {
	current: boolean;
	latestVersion: string | undefined;
	latest: PublishedVersion | undefined;
}

export interface PublicationState {
	sourceVersion: string;
	github: ChannelPublication;
	store: ChannelPublication;
}

export interface FeatureAvailability {
	introducedVersion: string;
	inSource: boolean;
	github: boolean;
	store: boolean;
	anyPublic: boolean;
	bothPublic: boolean;
}

export interface PublicationSite {
	name: string;
	version: string;
	publication: PublicationState;
	features: { browser: FeatureAvailability; transfer: FeatureAvailability };
}

export const RELEASE_PUBLICATIONS: PublicationRecords;
export const FEATURE_INTRODUCED: { browser: string; transfer: string };
export function compareVersions(left: string, right: string): number;
export function publicationState(
	sourceVersion: string,
	releases?: PublicationRecords
): PublicationState;
export function featureAvailability(
	publication: PublicationState,
	introducedVersion: string
): FeatureAvailability;
export function publicationSummary(site: PublicationSite): string;
export function browserAvailabilitySummary(site: PublicationSite): string;
export function browserFeatureCopy(site: PublicationSite): {
	description: string;
	fact: string;
	security: string;
};
