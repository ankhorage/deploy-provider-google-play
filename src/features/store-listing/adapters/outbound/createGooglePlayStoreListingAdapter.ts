import type {
  DeploymentProviderResult,
  DeploymentStoreListingAdapter,
  StoreListingAdapterContext,
  StoreListingLocale,
  StoreListingRemoteAssetSet,
  StoreListingSyncRequest,
  StoreListingTargetState,
} from '@ankhorage/contracts/deploy-provider';

import type { GooglePlayTokenFactory, GooglePlayTransport } from '../../../../types/googlePlay.js';
import { resolveGooglePlayAccessTokenAsync } from '../../../../utils/googlePlayRuntime.js';
import {
  GOOGLE_PLAY_IMAGE_VARIANTS,
  GOOGLE_PLAY_STORE_LISTING_FIELDS,
  googlePlayImageTypeFor,
} from '../../utils/googlePlayListingModel.js';
import {
  commitGooglePlayEditAsync,
  createGooglePlayEditAsync,
  discardGooglePlayEditAsync,
  readGooglePlayAssetSetAsync,
  readGooglePlayListingsAsync,
  replaceGooglePlayAssetsAsync,
  writeGooglePlayLocaleAsync,
} from './googlePlayListingTransport.js';

export function createGooglePlayStoreListingAdapter(options: {
  readonly createToken: GooglePlayTokenFactory;
  readonly request: GooglePlayTransport;
}): DeploymentStoreListingAdapter {
  return {
    target: 'android',
    inspectAsync: (context) => inspectAsync(context, options),
    syncAsync: (request) => syncAsync(request, options),
  };
}

async function inspectAsync(
  context: StoreListingAdapterContext,
  options: Parameters<typeof createGooglePlayStoreListingAdapter>[0],
): Promise<DeploymentProviderResult<StoreListingTargetState>> {
  if (context.identity.target !== 'android') return failed('GOOGLE_PLAY_IDENTITY_INVALID');
  const access = await resolveGooglePlayAccessTokenAsync({
    ...context,
    createToken: options.createToken,
  });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const editId = await createGooglePlayEditAsync(
    context.identity.packageName,
    access.token,
    options.request,
  );
  if (editId === null) return failed('GOOGLE_PLAY_EDIT_CREATE_FAILED');
  const state = await readStateAsync(
    context.identity.packageName,
    editId,
    access.token,
    options.request,
  );
  await discardGooglePlayEditAsync(
    context.identity.packageName,
    editId,
    access.token,
    options.request,
  );
  return state === null
    ? failed('GOOGLE_PLAY_LISTING_INSPECTION_FAILED')
    : { status: 'completed', value: state };
}

async function syncAsync(
  request: StoreListingSyncRequest,
  options: Parameters<typeof createGooglePlayStoreListingAdapter>[0],
): Promise<DeploymentProviderResult<StoreListingTargetState>> {
  if (request.identity.target !== 'android') return failed('GOOGLE_PLAY_IDENTITY_INVALID');
  if (request.plan.status === 'blocked') return failed('GOOGLE_PLAY_LISTING_PLAN_BLOCKED');
  if (request.plan.status === 'no-change') return inspectAsync(request, options);
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const editId = await createGooglePlayEditAsync(
    request.identity.packageName,
    access.token,
    options.request,
  );
  if (editId === null) return failed('GOOGLE_PLAY_EDIT_CREATE_FAILED');
  const synced = await executePlanAsync(request, editId, access.token, options.request);
  if (!synced) return failed('GOOGLE_PLAY_LISTING_SYNC_FAILED');
  const committed = await commitGooglePlayEditAsync(
    request.identity.packageName,
    editId,
    access.token,
    options.request,
  );
  return committed ? inspectAsync(request, options) : failed('GOOGLE_PLAY_EDIT_COMMIT_FAILED');
}

async function executePlanAsync(
  request: StoreListingSyncRequest,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  for (const step of request.plan.steps) {
    if (step.target !== 'android') continue;
    const success =
      step.operation === 'replace-assets'
        ? await replaceAssetsAsync(request, step.locale, step.variant, editId, token, transport)
        : await writeLocaleAsync(request, step.locale, editId, token, transport);
    if (!success) return false;
  }
  return true;
}

async function writeLocaleAsync(
  request: StoreListingSyncRequest,
  locale: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  if (request.identity.target !== 'android') return false;
  const desired = request.desired.locales.find((item) => item.locale === locale);
  return desired === undefined
    ? false
    : writeGooglePlayLocaleAsync({
        packageName: request.identity.packageName,
        editId,
        locale: desired,
        token,
        transport,
      });
}

async function replaceAssetsAsync(
  request: StoreListingSyncRequest,
  locale: string,
  variant: string | undefined,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  if (variant === undefined || request.identity.target !== 'android') return false;
  const imageType = googlePlayImageTypeFor(variant);
  const set = request.desired.assetSets.find(
    (item) => item.target === 'android' && item.locale === locale && item.variant === variant,
  );
  return imageType === null || set === undefined
    ? false
    : replaceGooglePlayAssetsAsync({
        packageName: request.identity.packageName,
        editId,
        set,
        imageType,
        token,
        transport,
        request,
      });
}

async function readStateAsync(
  packageName: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<StoreListingTargetState | null> {
  const locales = await readGooglePlayListingsAsync(packageName, editId, token, transport);
  if (locales === null) return null;
  const assetSets = await readAssetSetsAsync(packageName, editId, token, transport, locales);
  return assetSets === null
    ? null
    : {
        target: 'android',
        locales,
        assetSets,
        supportedFields: GOOGLE_PLAY_STORE_LISTING_FIELDS,
        diagnostics: [],
      };
}

async function readAssetSetsAsync(
  packageName: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
  locales: readonly StoreListingLocale[],
): Promise<readonly StoreListingRemoteAssetSet[] | null> {
  const sets = await Promise.all(
    locales.flatMap((locale) =>
      GOOGLE_PLAY_IMAGE_VARIANTS.map(([variant, imageType]) =>
        readGooglePlayAssetSetAsync({
          packageName,
          editId,
          locale: locale.locale,
          variant,
          imageType,
          token,
          transport,
        }),
      ),
    ),
  );
  return sets.every((set): set is StoreListingRemoteAssetSet => set !== null) ? sets : null;
}

function failed(code: string): DeploymentProviderResult<StoreListingTargetState> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'Google Play store listing operation failed.',
      target: 'android',
      provider: 'google-play',
    },
  };
}
