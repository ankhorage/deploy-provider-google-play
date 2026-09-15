import type {
  MonetizationBasePrice,
  MonetizationLocalization,
  MonetizationObservedProduct,
  MonetizationProduct,
  MonetizationSubscriptionPeriod,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

export function normalizeGooglePlayOneTime(value: unknown): MonetizationObservedProduct | null {
  if (!isRecord(value) || !isNonEmptyString(value.productId)) return null;
  return {
    id: value.productId,
    kind: 'one-time',
    localizations: parseListings(value.listings),
    ...readFirstBasePrice(value.purchaseOptions),
  };
}

export function normalizeGooglePlaySubscription(value: unknown): MonetizationObservedProduct | null {
  if (!isRecord(value) || !isNonEmptyString(value.productId)) return null;
  const basePlan = firstRecord(value.basePlans);
  const period = basePlan === null || !isRecord(basePlan.autoRenewingBasePlanType)
    ? null
    : readPeriod(basePlan.autoRenewingBasePlanType.billingPeriodDuration);
  return {
    id: value.productId,
    kind: 'subscription',
    localizations: parseListings(value.listings),
    ...(basePlan === null ? {} : readBasePrice(basePlan)),
    ...(period === null ? {} : { subscription: { family: value.productId, period } }),
  };
}

export function createGooglePlayOneTimePayload(
  product: MonetizationProduct,
  regionalConfigs: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return {
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

export function createGooglePlaySubscriptionPayload(
  product: MonetizationProduct,
  regionalConfigs: readonly unknown[],
): Readonly<Record<string, unknown>> {
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

export function toGooglePlayMoney(
  price: MonetizationBasePrice,
): Readonly<Record<string, string | number>> {
  const [units = '0', fraction = ''] = price.amount.split('.');
  return {
    currencyCode: price.currency,
    units,
    nanos: Number(fraction.padEnd(9, '0').slice(0, 9) || '0'),
  };
}

function parseListings(value: unknown): readonly MonetizationLocalization[] {
  if (!Array.isArray(value)) return [];
  return Array.from(value, (item): MonetizationLocalization | null => {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.languageCode) ||
      !isNonEmptyString(item.title) ||
      typeof item.description !== 'string'
    ) {
      return null;
    }
    return { locale: item.languageCode, name: item.title, description: item.description };
  }).filter((item): item is MonetizationLocalization => item !== null);
}

function readFirstBasePrice(
  value: unknown,
): { readonly basePrice: MonetizationBasePrice } | Record<string, never> {
  const option = firstRecord(value);
  return option === null ? {} : readBasePrice(option);
}

function readBasePrice(
  value: Record<string, unknown>,
): { readonly basePrice: MonetizationBasePrice } | Record<string, never> {
  const configs = Array.isArray(value.regionalPricingAndAvailabilityConfigs)
    ? value.regionalPricingAndAvailabilityConfigs
    : Array.isArray(value.regionalConfigs)
      ? value.regionalConfigs
      : [];
  const config = firstRecord(configs);
  if (config === null || !isNonEmptyString(config.regionCode) || !isRecord(config.price)) return {};
  const amount = fromMoney(config.price);
  return amount === null ? {} : { basePrice: { country: config.regionCode, ...amount } };
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const records = Array.from(value, (item): Record<string, unknown> | null =>
    isRecord(item) ? item : null,
  );
  return records.find((item): item is Record<string, unknown> => item !== null) ?? null;
}

function toListings(
  localizations: readonly MonetizationLocalization[],
): readonly Readonly<Record<string, string>>[] {
  return localizations.map((localization) => ({
    languageCode: localization.locale,
    title: localization.name,
    description: localization.description,
  }));
}

function fromMoney(
  value: Record<string, unknown>,
): { readonly currency: string; readonly amount: string } | null {
  if (
    !isNonEmptyString(value.currencyCode) ||
    !isNonEmptyString(value.units) ||
    typeof value.nanos !== 'number'
  ) {
    return null;
  }
  const fraction = String(value.nanos).padStart(9, '0').replace(/0+$/, '');
  return {
    currency: value.currencyCode,
    amount: fraction.length === 0 ? value.units : `${value.units}.${fraction}`,
  };
}

function readPeriod(value: unknown): MonetizationSubscriptionPeriod | null {
  switch (value) {
    case 'P1W':
    case 'P1M':
    case 'P2M':
    case 'P3M':
    case 'P6M':
    case 'P1Y':
      return value;
    default:
      return null;
  }
}
