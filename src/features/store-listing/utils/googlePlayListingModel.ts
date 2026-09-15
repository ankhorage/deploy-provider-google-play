import type {
  StoreListingField,
  StoreListingLocale,
  StoreListingRemoteAssetSet,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

export const GOOGLE_PLAY_STORE_LISTING_FIELDS = [
  'name',
  'summary',
  'description',
  'promoVideoUrl',
] as const satisfies readonly StoreListingField[];

export const GOOGLE_PLAY_IMAGE_VARIANTS = [
  ['icon', 'icon'],
  ['feature', 'featureGraphic'],
  ['phone', 'phoneScreenshots'],
  ['seven-inch', 'sevenInchScreenshots'],
  ['ten-inch', 'tenInchScreenshots'],
  ['tv', 'tvScreenshots'],
  ['wear', 'wearScreenshots'],
] as const;

export function parseGooglePlayListings(body: string): readonly StoreListingLocale[] | null {
  const parsed = parseJson(body);
  if (!isRecord(parsed) || !Array.isArray(parsed.listings)) return null;
  const listings = Array.from(parsed.listings, (value): StoreListingLocale | null =>
    parseListing(value),
  );
  return listings.every((listing): listing is StoreListingLocale => listing !== null)
    ? listings
    : null;
}

export function parseGooglePlayImageSet(options: {
  readonly body: string;
  readonly locale: string;
  readonly variant: string;
}): StoreListingRemoteAssetSet | null {
  const parsed = parseJson(options.body);
  if (!isRecord(parsed) || !Array.isArray(parsed.images)) return null;
  const hashes = Array.from(parsed.images, (image): string | null =>
    isRecord(image) && isNonEmptyString(image.sha256) ? image.sha256 : null,
  );
  return hashes.every((hash): hash is string => hash !== null)
    ? {
        target: 'android',
        locale: options.locale,
        variant: options.variant,
        checksum: 'sha256',
        hashes,
      }
    : null;
}

export function toGooglePlayListing(locale: StoreListingLocale): Readonly<Record<string, string>> {
  return {
    language: locale.locale,
    title: locale.name,
    ...(locale.summary === undefined ? {} : { shortDescription: locale.summary }),
    ...(locale.description === undefined ? {} : { fullDescription: locale.description }),
    ...(locale.promoVideoUrl === undefined ? {} : { video: locale.promoVideoUrl }),
  };
}

export function googlePlayImageTypeFor(variant: string): string | null {
  return GOOGLE_PLAY_IMAGE_VARIANTS.find(([name]) => name === variant)?.[1] ?? null;
}

function parseListing(value: unknown): StoreListingLocale | null {
  if (!isRecord(value) || !isNonEmptyString(value.language) || !isNonEmptyString(value.title)) {
    return null;
  }
  return {
    locale: value.language,
    name: value.title,
    ...(isNonEmptyString(value.shortDescription) ? { summary: value.shortDescription } : {}),
    ...(isNonEmptyString(value.fullDescription) ? { description: value.fullDescription } : {}),
    ...(isNonEmptyString(value.video) ? { promoVideoUrl: value.video } : {}),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
