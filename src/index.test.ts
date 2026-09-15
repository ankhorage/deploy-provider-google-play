import { describe, expect, it } from 'bun:test';

import { createGooglePlayDeploymentProvider } from './index.js';

const serviceAccount = JSON.stringify({
  type: 'service_account',
  client_email: 'deploy@example.invalid',
  private_key: 'secret',
});

const resolveSecret = () => Promise.resolve(serviceAccount);
const createToken = () => Promise.resolve('token');

describe('Google Play provider registration', () => {
  it('registers every deployment capability without a Deploy dependency', () => {
    const provider = createGooglePlayDeploymentProvider({
      createToken,
      request: () => Promise.resolve({ status: 200, body: '{}' }),
      downloadArtifact: () => Promise.resolve(new Uint8Array()),
    });

    expect(provider.descriptor).toEqual({
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
    });
    expect(provider.setup).toBeDefined();
    expect(provider.androidPublisher).toBeDefined();
    expect(provider.storeListing).toBeDefined();
    expect(provider.monetization).toBeDefined();
    expect(provider.release).toBeDefined();
    expect(provider.androidBuilder).toBeUndefined();
  });
});

describe('Google Play setup', () => {
  it('reports missing authentication through the setup port', async () => {
    const provider = createGooglePlayDeploymentProvider({ createToken });
    const inspection = await provider.setup?.inspectSetup({
      projectRoot: '/app',
      target: 'android',
      credentials: [],
      resolveSecret: () => Promise.resolve(null),
    });

    expect(inspection?.authentication.status).toBe('required');
    expect(inspection?.provisioning).toHaveLength(1);
  });
});

describe('Google Play publication', () => {
  it('normalizes Android track inspection through the public publisher port', async () => {
    const provider = createGooglePlayDeploymentProvider({
      createToken,
      request: () =>
        Promise.resolve({
          status: 200,
          body: JSON.stringify({ releases: [{ versionCodes: ['7', '8'], status: 'completed' }] }),
        }),
    });
    const inspection = await provider.androidPublisher?.inspectAsync({
      packageName: 'com.example.app',
      track: 'production',
      credentials: [{ provider: 'google-play', id: 'play', kind: 'service-account' }],
      resolveSecret,
    });

    expect(inspection).toEqual({
      status: 'completed',
      value: { track: 'production', activeVersionCodes: [7, 8] },
    });
  });
});
