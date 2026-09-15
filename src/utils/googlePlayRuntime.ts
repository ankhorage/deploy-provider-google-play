import { GoogleAuth } from 'google-auth-library';

import type {
  DeploymentAuthenticationRequiredAction,
  DeploymentCredentialReference,
  DeploymentSecretResolver,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type {
  GooglePlayArtifactDownloader,
  GooglePlayRequest,
  GooglePlayServiceAccountCredentials,
  GooglePlayTokenFactory,
  GooglePlayTransport,
} from '../types/googlePlay.js';

const GOOGLE_PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export const createGooglePlayAccessToken: GooglePlayTokenFactory = async (credentials) => {
  const auth = new GoogleAuth({
    credentials: {
      client_email: credentials.clientEmail,
      private_key: credentials.privateKey,
    },
    scopes: [GOOGLE_PLAY_SCOPE],
  });
  const token = await auth.getAccessToken();
  return isNonEmptyString(token) ? token : null;
};

export const fetchGooglePlay: GooglePlayTransport = async (request) => {
  const headers: Record<string, string> = { Authorization: `Bearer ${request.token}` };
  if (request.contentType !== undefined) headers['Content-Type'] = request.contentType;
  const body = typeof request.body === 'string' ? request.body : Buffer.from(request.body ?? []);
  const response = await fetch(request.url, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body }),
  });
  return { status: response.status, body: await response.text() };
};

export const downloadGooglePlayArtifact: GooglePlayArtifactDownloader = async (url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
};

export type GooglePlayAccessTokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly action: DeploymentAuthenticationRequiredAction };

export async function resolveGooglePlayAccessTokenAsync(options: {
  readonly credentials: readonly DeploymentCredentialReference[];
  readonly resolveSecret: DeploymentSecretResolver;
  readonly createToken: GooglePlayTokenFactory;
}): Promise<GooglePlayAccessTokenResult> {
  const reference = options.credentials.find(
    (credential) => credential.provider === 'google-play' && credential.kind === 'service-account',
  );
  if (reference === undefined) return { ok: false, action: authenticationAction() };
  const secret = await safelyResolveSecret(options.resolveSecret, reference);
  const parsed = parseServiceAccount(secret);
  if (parsed === null) return { ok: false, action: authenticationAction() };
  const token = await safelyCreateToken(options.createToken, parsed);
  return token === null ? { ok: false, action: authenticationAction() } : { ok: true, token };
}

export async function safeGooglePlayRequest(
  request: GooglePlayTransport,
  value: GooglePlayRequest,
): Promise<Awaited<ReturnType<GooglePlayTransport>> | null> {
  try {
    return await request(value);
  } catch {
    return null;
  }
}

function parseServiceAccount(value: string | null): GooglePlayServiceAccountCredentials | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.type !== 'service_account') return null;
    if (!isNonEmptyString(parsed.client_email) || !isNonEmptyString(parsed.private_key)) return null;
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
  } catch {
    return null;
  }
}

async function safelyResolveSecret(
  resolveSecret: DeploymentSecretResolver,
  reference: DeploymentCredentialReference,
): Promise<string | null> {
  try {
    return await resolveSecret(reference);
  } catch {
    return null;
  }
}

async function safelyCreateToken(
  createToken: GooglePlayTokenFactory,
  credentials: GooglePlayServiceAccountCredentials,
): Promise<string | null> {
  try {
    return await createToken(credentials);
  } catch {
    return null;
  }
}

function authenticationAction(): DeploymentAuthenticationRequiredAction {
  return {
    type: 'authentication',
    provider: 'google-play',
    target: 'android',
    code: 'GOOGLE_PLAY_AUTHENTICATION_REQUIRED',
    message: 'Google Play service-account authentication is required for Android deployment.',
  };
}
