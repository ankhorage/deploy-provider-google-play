import { defineParadoxConfig } from '@ankhorage/paradox';

export default defineParadoxConfig({
  mode: 'write',
  docs: {
    title: '@ankhorage/deploy-provider-google-play',
    description: 'Google Play deployment provider for Ankhorage application shipment.',
  },
  package: {
    root: '.',
    entrypoints: ['src/deployProviderGooglePlay.ts'],
  },
  output: { dir: './paradox' },
});
