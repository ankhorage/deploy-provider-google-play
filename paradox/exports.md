# Public API

## createGooglePlayDeploymentProvider

Kind: `function`
Module: `src/features/provider-registration/composition/createGooglePlayDeploymentProvider.ts`
Source: `src/features/provider-registration/composition/createGooglePlayDeploymentProvider.ts:15:1`

### Signatures

- `(options?: GooglePlayDeploymentProviderOptions) => DeploymentProviderRegistration`
  - options: `GooglePlayDeploymentProviderOptions` (optional)
  - returns: `DeploymentProviderRegistration`

## GooglePlayDeploymentProviderOptions

Kind: `type`
Module: `src/types/googlePlay.ts`
Source: `src/types/googlePlay.ts:27:1`

### Members

| Name             | Kind     | Type                           | Required | Description |
| ---------------- | -------- | ------------------------------ | -------- | ----------- |
| createToken      | property | `GooglePlayTokenFactory`       | no       |             |
| downloadArtifact | property | `GooglePlayArtifactDownloader` | no       |             |
| request          | property | `GooglePlayTransport`          | no       |             |
