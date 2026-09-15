import type {
  DeploymentProviderSetupAdapter,
  DeploymentProviderSetupInspection,
} from '@ankhorage/contracts/deploy-provider';

import type { GooglePlayTokenFactory } from '../../../../types/googlePlay.js';
import { resolveGooglePlayAccessTokenAsync } from '../../../../utils/googlePlayRuntime.js';

export function createGooglePlaySetupAdapter(
  createToken: GooglePlayTokenFactory,
): DeploymentProviderSetupAdapter {
  return {
    provider: 'google-play',
    inspectSetup: async (context) => {
      const access = await resolveGooglePlayAccessTokenAsync({ ...context, createToken });
      return access.ok ? ready() : required(access.action);
    },
  };
}

function ready(): DeploymentProviderSetupInspection {
  return {
    provider: 'google-play',
    authentication: { status: 'authenticated' },
    capabilities: [
      { capability: 'publish', status: 'available' },
      { capability: 'verify', status: 'available' },
    ],
    provisioning: [],
  };
}

function required(
  action: Extract<
    Awaited<ReturnType<typeof resolveGooglePlayAccessTokenAsync>>,
    { readonly ok: false }
  >['action'],
): DeploymentProviderSetupInspection {
  return {
    provider: 'google-play',
    authentication: { status: 'required', action },
    capabilities: [
      { capability: 'publish', status: 'unavailable', reason: 'Authentication required.' },
      { capability: 'verify', status: 'unavailable', reason: 'Authentication required.' },
    ],
    provisioning: [{ type: 'authentication', action }],
  };
}
