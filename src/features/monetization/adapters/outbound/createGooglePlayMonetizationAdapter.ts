import type {
  DeploymentMonetizationAdapter,
  DeploymentProviderResult,
  MonetizationAdapterContext,
  MonetizationBasePrice,
  MonetizationObservedProduct,
  MonetizationProduct,
  MonetizationSyncRequest,
  MonetizationTargetState,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { GooglePlayTokenFactory, GooglePlayTransport } from '../../../../types/googlePlay.js';
import {
  resolveGooglePlayAccessTokenAsync,
  safeGooglePlayRequest,
} from '../../../../utils/googlePlayRuntime.js';
import {
  createGooglePlayOneTimePayload,
  createGooglePlaySubscriptionPayload,
  normalizeGooglePlayOneTime,
  normalizeGooglePlaySubscription,
  toGooglePlayMoney,
} from '../../utils/googlePlayMonetizationModel.js';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

export function createGooglePlayMonetizationAdapter(options: {
  readonly createToken: GooglePlayTokenFactory;
  readonly request: GooglePlayTransport;
}): DeploymentMonetizationAdapter {
  return {
    target: 'android',
    inspectAsync: (context) => inspectAsync(context, options),
    syncAsync: (request) => syncAsync(request, options),
  };
}

async function inspectAsync(
  context: MonetizationAdapterContext,
  options: Parameters<typeof createGooglePlayMonetizationAdapter>[0],
): Promise<DeploymentProviderResult<MonetizationTargetState>> {
  if (context.identity.target !== 'android') return failed('GOOGLE_PLAY_IDENTITY_INVALID');
  const access = await resolveGooglePlayAccessTokenAsync({
    ...context,
    createToken: options.createToken,
  });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const [oneTime, subscriptions] = await Promise.all([
    readOneTimeProductsAsync(context.identity.packageName, access.token, options.request),
    readSubscriptionsAsync(context.identity.packageName, access.token, options.request),
  ]);
  if (oneTime === null || subscriptions === null) {
    return failed('GOOGLE_PLAY_MONETIZATION_INSPECTION_FAILED');
  }
  const products = normalizeProducts(oneTime, subscriptions);
  return {
    status: 'completed',
    value: { target: 'android', products, subscriptionFamilies: [], diagnostics: [] },
  };
}

async function syncAsync(
  request: MonetizationSyncRequest,
  options: Parameters<typeof createGooglePlayMonetizationAdapter>[0],
): Promise<DeploymentProviderResult<MonetizationTargetState>> {
  if (request.identity.target !== 'android') return failed('GOOGLE_PLAY_IDENTITY_INVALID');
  if (request.plan.status === 'blocked') return failed('GOOGLE_PLAY_MONETIZATION_PLAN_BLOCKED');
  if (request.plan.status === 'no-change') return inspectAsync(request, options);
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const synced = await executePlanAsync(request, access.token, options.request);
  return synced ? inspectAsync(request, options) : failed('GOOGLE_PLAY_MONETIZATION_SYNC_FAILED');
}

async function executePlanAsync(
  request: MonetizationSyncRequest,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  for (const step of request.plan.steps) {
    if (step.target !== 'android' || step.operation === 'ensure-subscription-family') continue;
    const product = request.desired.products.find((item) => item.id === step.productId);
    if (product === undefined) return false;
    if (
      !(await upsertProductAsync(
        request.identity.target === 'android' ? request.identity.packageName : '',
        product,
        token,
        transport,
      ))
    ) {
      return false;
    }
  }
  return true;
}

async function upsertProductAsync(
  packageName: string,
  product: MonetizationProduct,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  const converted = await convertPriceAsync(packageName, product.basePrice, token, transport);
  if (converted === null) return false;
  const request =
    product.kind === 'subscription'
      ? subscriptionRequest(packageName, product, converted)
      : oneTimeRequest(packageName, product, converted);
  const response = await safeGooglePlayRequest(transport, { ...request, token });
  return response !== null && isSuccess(response.status);
}

function subscriptionRequest(
  packageName: string,
  product: MonetizationProduct,
  converted: ConvertedPrice,
) {
  return {
    method: 'PATCH' as const,
    url: `${appUrl(packageName)}/subscriptions/${encodeURIComponent(product.id)}?updateMask=listings,basePlans&regionsVersion.version=${encodeURIComponent(converted.regionVersion)}&allowMissing=true`,
    contentType: 'application/json',
    body: JSON.stringify(createGooglePlaySubscriptionPayload(product, converted.regionalConfigs)),
  };
}

function oneTimeRequest(
  packageName: string,
  product: MonetizationProduct,
  converted: ConvertedPrice,
) {
  return {
    method: 'PATCH' as const,
    url: `${appUrl(packageName)}/onetimeproducts/${encodeURIComponent(product.id)}?updateMask=listings,purchaseOptions&regionsVersion.version=${encodeURIComponent(converted.regionVersion)}&allowMissing=true`,
    contentType: 'application/json',
    body: JSON.stringify(createGooglePlayOneTimePayload(product, converted.regionalConfigs)),
  };
}

interface ConvertedPrice {
  readonly regionVersion: string;
  readonly regionalConfigs: readonly unknown[];
}

async function convertPriceAsync(
  packageName: string,
  price: MonetizationBasePrice,
  token: string,
  transport: GooglePlayTransport,
): Promise<ConvertedPrice | null> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'POST',
    url: `${appUrl(packageName)}/pricing:convertRegionPrices`,
    token,
    contentType: 'application/json',
    body: JSON.stringify({ price: toGooglePlayMoney(price) }),
  });
  if (response === null || !isSuccess(response.status)) return null;
  return parseConvertedPrice(response.body);
}

function parseConvertedPrice(body: string): ConvertedPrice | null {
  const parsed = parseJson(body);
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.regionVersion) ||
    !isNonEmptyString(parsed.regionVersion.version)
  ) {
    return null;
  }
  const regionalConfigs = Array.isArray(parsed.convertedRegionPrices)
    ? Array.from(parsed.convertedRegionPrices, (value): unknown => value)
    : [];
  return { regionVersion: parsed.regionVersion.version, regionalConfigs };
}

function readOneTimeProductsAsync(
  packageName: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<readonly unknown[] | null> {
  return readCollectionAsync(
    `${appUrl(packageName)}/oneTimeProducts?pageSize=1000`,
    token,
    transport,
    'one-time',
  );
}

function readSubscriptionsAsync(
  packageName: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<readonly unknown[] | null> {
  return readCollectionAsync(
    `${appUrl(packageName)}/subscriptions?pageSize=1000`,
    token,
    transport,
    'subscription',
  );
}

async function readCollectionAsync(
  url: string,
  token: string,
  transport: GooglePlayTransport,
  kind: 'one-time' | 'subscription',
): Promise<readonly unknown[] | null> {
  const response = await safeGooglePlayRequest(transport, { method: 'GET', url, token });
  if (response === null || !isSuccess(response.status)) return null;
  const parsed = parseJson(response.body);
  if (!isRecord(parsed)) return null;
  const values = kind === 'one-time' ? parsed.oneTimeProducts : parsed.subscriptions;
  return Array.isArray(values) ? Array.from(values, (value): unknown => value) : [];
}

function normalizeProducts(
  oneTime: readonly unknown[],
  subscriptions: readonly unknown[],
): readonly MonetizationObservedProduct[] {
  return [
    ...oneTime.map(normalizeGooglePlayOneTime).filter(isObservedProduct),
    ...subscriptions.map(normalizeGooglePlaySubscription).filter(isObservedProduct),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function isObservedProduct(
  value: MonetizationObservedProduct | null,
): value is MonetizationObservedProduct {
  return value !== null;
}

function appUrl(packageName: string): string {
  return `${API}/${encodeURIComponent(packageName)}`;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function failed(code: string): DeploymentProviderResult<MonetizationTargetState> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'Google Play monetization operation failed.',
      target: 'android',
      provider: 'google-play',
    },
  };
}
