import type {
  DeploymentMonetizationAdapter,
  DeploymentProviderResult,
  MonetizationAdapterContext,
  MonetizationBasePrice,
  MonetizationLocalization,
  MonetizationObservedProduct,
  MonetizationProduct,
  MonetizationSubscriptionPeriod,
  MonetizationSyncRequest,
  MonetizationTargetState,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { GooglePlayTokenFactory, GooglePlayTransport } from '../../../../types/googlePlay.js';
import { resolveGooglePlayAccessTokenAsync, safeGooglePlayRequest } from '../../../../utils/googlePlayRuntime.js';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const PERIODS = new Set<MonetizationSubscriptionPeriod>(['P1W', 'P1M', 'P2M', 'P3M', 'P6M', 'P1Y']);

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
  const access = await resolveGooglePlayAccessTokenAsync({ ...context, createToken: options.createToken });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const [oneTime, subscriptions] = await Promise.all([
    readCollectionAsync(context.identity.packageName, 'oneTimeProducts', 'oneTimeProducts', access.token, options.request),
    readCollectionAsync(context.identity.packageName, 'subscriptions', 'subscriptions', access.token, options.request),
  ]);
  if (oneTime === null || subscriptions === null) return failed('GOOGLE_PLAY_MONETIZATION_INSPECTION_FAILED');
  const products = [
    ...oneTime.map((value) => normalizeOneTime(value)).filter(isObservedProduct),
    ...subscriptions.map((value) => normalizeSubscription(value)).filter(isObservedProduct),
  ].sort((left, right) => left.id.localeCompare(right.id));
  return { status: 'completed', value: { target: 'android', products, subscriptionFamilies: [], diagnostics: [] } };
}

async function syncAsync(
  request: MonetizationSyncRequest,
  options: Parameters<typeof createGooglePlayMonetizationAdapter>[0],
): Promise<DeploymentProviderResult<MonetizationTargetState>> {
  if (request.identity.target !== 'android') return failed('GOOGLE_PLAY_IDENTITY_INVALID');
  if (request.plan.status === 'blocked') return failed('GOOGLE_PLAY_MONETIZATION_PLAN_BLOCKED');
  if (request.plan.status === 'no-change') return inspectAsync(request, options);
  const access = await resolveGooglePlayAccessTokenAsync({ ...request, createToken: options.createToken });
  if (!access.ok) return { status: 'action-required', action: access.action };
  for (const step of request.plan.steps) {
    if (step.target !== 'android' || step.operation === 'ensure-subscription-family') continue;
    const product = request.desired.products.find((item) => item.id === step.productId);
    if (product === undefined) return failed('GOOGLE_PLAY_PRODUCT_MISSING');
    const written = await upsertProductAsync(request.identity.packageName, product, access.token, options.request);
    if (!written) return failed('GOOGLE_PLAY_MONETIZATION_SYNC_FAILED');
  }
  return inspectAsync(request, options);
}

async function upsertProductAsync(
  packageName: string,
  product: MonetizationProduct,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  const converted = await convertPriceAsync(packageName, product.basePrice, token, transport);
  if (converted === null) return false;
  const url = product.kind === 'subscription'
    ? `${appUrl(packageName)}/subscriptions/${encodeURIComponent(product.id)}?updateMask=listings,basePlans&regionsVersion.version=${encodeURIComponent(converted.regionVersion)}&allowMissing=true`
    : `${appUrl(packageName)}/onetimeproducts/${encodeURIComponent(product.id)}?updateMask=listings,purchaseOptions&regionsVersion.version=${encodeURIComponent(converted.regionVersion)}&allowMissing=true`;
  const body = product.kind === 'subscription'
    ? subscriptionPayload(product, converted.regionalConfigs)
    : oneTimePayload(product, converted.regionalConfigs);
  const response = await safeGooglePlayRequest(transport, {
    method: 'PATCH',
    url,
    token,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  return response !== null && isSuccess(response.status);
}

async function convertPriceAsync(
  packageName: string,
  price: MonetizationBasePrice,
  token: string,
  transport: GooglePlayTransport,
): Promise<{ readonly regionVersion: string; readonly regionalConfigs: readonly unknown[] } | null> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'POST',
    url: `${appUrl(packageName)}/pricing:convertRegionPrices`,
    token,
    contentType: 'application/json',
    body: JSON.stringify({ price: toMoney(price) }),
  });
  if (response === null || !isSuccess(response.status)) return null;
  const parsed = parseJson(response.body);
  if (!isRecord(parsed) || !isRecord(parsed.regionVersion) || !isNonEmptyString(parsed.regionVersion.version)) return null;
  const configs = Array.isArray(parsed.convertedRegionPrices)
    ? parsed.convertedRegionPrices
    : Array.isArray(parsed.convertedRegionPrice)
      ? parsed.convertedRegionPrice
      : [];
  return { regionVersion: parsed.regionVersion.version, regionalConfigs: configs };
}

async function readCollectionAsync(
  packageName: string,
  resource: string,
  field: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<readonly unknown[] | null> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'GET',
    url: `${appUrl(packageName)}/${resource}?pageSize=1000`,
    token,
  });
  if (response === null || !isSuccess(response.status)) return null;
  const parsed = parseJson(response.body);
  return isRecord(parsed) && Array.isArray(parsed[field]) ? parsed[field] : [];
}

function oneTimePayload(product: MonetizationProduct, regionalConfigs: readonly unknown[]): Readonly<Record<string, unknown>> {
  return {
    packageName: undefined,
    productId: product.id,
    listings: toListings(product.localizations),
    purchaseOptions: [
      {
        purchaseOptionId: 'buy',
        buyOption: {},
        regionalPricingAndAvailabilityConfigs: regionalConfigs,
      },
    ],
  };
}

function subscriptionPayload(product: MonetizationProduct, regionalConfigs: readonly unknown[]): Readonly<Record<string, unknown>> {
  return {
    productId: product.id,
    listings: toListings(product.localizations),
    basePlans: [
      {
        basePlanId: 'base',
        autoRenewingBasePlanType: { billingPeriodDuration: product.subscription?.period ?? 'P1M' },
        regionalConfigs,
      },
    ],
  };
}

function toListings(localizations: readonly MonetizationLocalization[]): readonly Readonly<Record<string, string>>[] {
  return localizations.map((localization) => ({
    languageCode: localization.locale,
    title: localization.name,
    description: localization.description,
  }));
}

function normalizeOneTime(value: unknown): MonetizationObservedProduct | null {
  if (!isRecord(value) || !isNonEmptyString(value.productId)) return null;
  return {
    id: value.productId,
    kind: 'one-time',
    localizations: parseListings(value.listings),
    ...readFirstBasePrice(value.purchaseOptions),
  };
}

function normalizeSubscription(value: unknown): MonetizationObservedProduct | null {
  if (!isRecord(value) || !isNonEmptyString(value.productId)) return null;
  const basePlan = Array.isArray(value.basePlans) ? value.basePlans.find(isRecord) : undefined;
  const period = basePlan === undefined || !isRecord(basePlan.autoRenewingBasePlanType)
    ? null
    : readPeriod(basePlan.autoRenewingBasePlanType.billingPeriodDuration);
  return {
    id: value.productId,
    kind: 'subscription',
    localizations: parseListings(value.listings),
    ...(basePlan === undefined ? {} : readBasePrice(basePlan)),
    ...(period === null ? {} : { subscription: { family: value.productId, period } }),
  };
}

function parseListings(value: unknown): readonly MonetizationLocalization[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && isNonEmptyString(item.languageCode) && isNonEmptyString(item.title) && typeof item.description === 'string'
      ? [{ locale: item.languageCode, name: item.title, description: item.description }]
      : [],
  );
}

function readFirstBasePrice(value: unknown): { readonly basePrice: MonetizationBasePrice } | Record<string, never> {
  if (!Array.isArray(value)) return {};
  const option = value.find(isRecord);
  return option === undefined ? {} : readBasePrice(option);
}

function readBasePrice(value: Record<string, unknown>): { readonly basePrice: MonetizationBasePrice } | Record<string, never> {
  const configs = Array.isArray(value.regionalPricingAndAvailabilityConfigs)
    ? value.regionalPricingAndAvailabilityConfigs
    : Array.isArray(value.regionalConfigs)
      ? value.regionalConfigs
      : [];
  const config = configs.find(isRecord);
  if (config === undefined || !isNonEmptyString(config.regionCode) || !isRecord(config.price)) return {};
  const amount = fromMoney(config.price);
  return amount === null ? {} : { basePrice: { country: config.regionCode, ...amount } };
}

function toMoney(price: MonetizationBasePrice): Readonly<Record<string, string | number>> {
  const [units = '0', fraction = ''] = price.amount.split('.');
  return { currencyCode: price.currency, units, nanos: Number((fraction.padEnd(9, '0').slice(0, 9) || '0')) };
}

function fromMoney(value: Record<string, unknown>): { readonly currency: string; readonly amount: string } | null {
  if (!isNonEmptyString(value.currencyCode) || !isNonEmptyString(value.units) || typeof value.nanos !== 'number') return null;
  const fraction = String(value.nanos).padStart(9, '0').replace(/0+$/, '');
  return { currency: value.currencyCode, amount: fraction.length === 0 ? value.units : `${value.units}.${fraction}` };
}

function readPeriod(value: unknown): MonetizationSubscriptionPeriod | null {
  return typeof value === 'string' && PERIODS.has(value as MonetizationSubscriptionPeriod)
    ? (value as MonetizationSubscriptionPeriod)
    : null;
}

function isObservedProduct(value: MonetizationObservedProduct | null): value is MonetizationObservedProduct {
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
  return { status: 'failed', failure: { code, message: 'Google Play monetization operation failed.', target: 'android', provider: 'google-play' } };
}
