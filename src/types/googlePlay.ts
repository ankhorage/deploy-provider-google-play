export interface GooglePlayServiceAccountCredentials {
  readonly clientEmail: string;
  readonly privateKey: string;
}

export type GooglePlayTokenFactory = (
  credentials: GooglePlayServiceAccountCredentials,
) => Promise<string | null>;

export interface GooglePlayRequest {
  readonly method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
  readonly url: string;
  readonly token: string;
  readonly contentType?: string;
  readonly body?: string | Uint8Array;
}

interface GooglePlayResponse {
  readonly status: number;
  readonly body: string;
}

export type GooglePlayTransport = (request: GooglePlayRequest) => Promise<GooglePlayResponse>;

export type GooglePlayArtifactDownloader = (url: string) => Promise<Uint8Array | null>;

export interface GooglePlayDeploymentProviderOptions {
  readonly createToken?: GooglePlayTokenFactory;
  readonly request?: GooglePlayTransport;
  readonly downloadArtifact?: GooglePlayArtifactDownloader;
}
