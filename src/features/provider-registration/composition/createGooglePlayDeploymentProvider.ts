import type { DeploymentProviderRegistration } from '@ankhorage/contracts/deploy-provider';

import type { GooglePlayDeploymentProviderOptions } from '../../../types/googlePlay.js';
import {
  createGooglePlayAccessToken,
  downloadGooglePlayArtifact,
  fetchGooglePlay,
} from '../../../utils/googlePlayRuntime.js';
import { createGooglePlayAndroidPublisher } from '../../android-publication/adapters/outbound/createGooglePlayAndroidPublisher.js';
import { createGooglePlayMonetizationAdapter } from '../../monetization/adapters/outbound/createGooglePlayMonetizationAdapter.js';
import { createGooglePlayReleaseAdapter } from '../../release/adapters/outbound/createGooglePlayReleaseAdapter.js';
import { createGooglePlaySetupAdapter } from '../../setup/adapters/outbound/createGooglePlaySetupAdapter.js';
import { createGooglePlayStoreListingAdapter } from '../../store-listing/adapters/outbound/createGooglePlayStoreListingAdapter.js';

export function createGooglePlayDeploymentProvider(
  options: GooglePlayDeploymentProviderOptions = {},
): DeploymentProviderRegistration {
  const createToken = options.createToken ?? createGooglePlayAccessToken;
  const request = options.request ?? fetchGooglePlay;
  const downloadArtifact = options.downloadArtifact ?? downloadGooglePlayArtifact;
  return {
    descriptor: {
      id: 'google-play',
      packageName: '@ankhorage/deploy-provider-google-play',
      displayName: 'Google Play',
      capabilities: [
        { id: 'setup', targets: ['android'] },
        { id: 'android-publish', targets: ['android'] },
        { id: 'store-listing', targets: ['android'] },
        { id: 'monetization', targets: ['android'] },
        { id: 'release', targets: ['android'] },
      ],
    },
    setup: createGooglePlaySetupAdapter(createToken),
    androidPublisher: createGooglePlayAndroidPublisher({ createToken, request, downloadArtifact }),
    storeListing: createGooglePlayStoreListingAdapter({ createToken, request }),
    monetization: createGooglePlayMonetizationAdapter({ createToken, request }),
    release: createGooglePlayReleaseAdapter({ createToken, request }),
  };
}
