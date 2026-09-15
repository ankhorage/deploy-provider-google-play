import type {
  DeploymentProviderResult,
  DeploymentReleaseAdapter,
  ReleaseControlExecutionResult,
  ReleaseControlRequest,
  ReleaseInspectionRequest,
  ReleaseMutationResult,
  ReleaseObservedAndroidState,
  ReleaseStepExecutionRequest,
} from '@ankhorage/contracts/deploy-provider';

import type { GooglePlayTokenFactory, GooglePlayTransport } from '../../../../types/googlePlay.js';
import { resolveGooglePlayAccessTokenAsync } from '../../../../utils/googlePlayRuntime.js';
import {
  findGooglePlayRelease,
  missingGooglePlayRelease,
  observeGooglePlayRelease,
  updateGooglePlayControlBody,
  updateGooglePlayReleaseBody,
} from '../../utils/googlePlayReleaseModel.js';
import {
  commitGooglePlayReleaseEditAsync,
  createGooglePlayReleaseEditAsync,
  readGooglePlayReleaseEditTrackAsync,
  readGooglePlayReleaseSummaryAsync,
  writeGooglePlayReleaseEditTrackAsync,
} from './googlePlayReleaseTransport.js';

export function createGooglePlayReleaseAdapter(options: {
  readonly createToken: GooglePlayTokenFactory;
  readonly request: GooglePlayTransport;
}): DeploymentReleaseAdapter {
  return {
    target: 'android',
    inspectAsync: (request) => inspectAsync(request, options),
    executeStepAsync: (request) => executeStepAsync(request, options),
    controlAsync: (request) => controlAsync(request, options),
  };
}

async function inspectAsync(
  request: ReleaseInspectionRequest,
  options: Parameters<typeof createGooglePlayReleaseAdapter>[0],
): Promise<DeploymentProviderResult<ReleaseObservedAndroidState>> {
  if (request.identity.target !== 'android') {
    return failedInspection('GOOGLE_PLAY_IDENTITY_INVALID');
  }
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const summary = await readGooglePlayReleaseSummaryAsync({
    packageName: request.identity.packageName,
    token: access.token,
    transport: options.request,
  });
  if (summary === null) return failedInspection('GOOGLE_PLAY_RELEASE_INSPECTION_FAILED');
  const release = findGooglePlayRelease(summary, request.version);
  return {
    status: 'completed',
    value: release === null
      ? missingGooglePlayRelease()
      : observeGooglePlayRelease(request.version, release),
  };
}

async function executeStepAsync(
  request: ReleaseStepExecutionRequest,
  options: Parameters<typeof createGooglePlayReleaseAdapter>[0],
): Promise<ReleaseMutationResult> {
  if (request.identity.target !== 'android' || request.step.target !== 'android') {
    return blocked('GOOGLE_PLAY_RELEASE_TARGET_INVALID');
  }
  if (request.step.operation === 'verify' || request.step.operation === 'record') {
    return { status: 'completed' };
  }
  if (!isMutableOperation(request.step.operation)) {
    return blocked('GOOGLE_PLAY_RELEASE_STEP_UNSUPPORTED');
  }
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) return blocked(access.action.code);
  return mutateReleaseAsync(request, access.token, options.request);
}

async function controlAsync(
  request: ReleaseControlRequest,
  options: Parameters<typeof createGooglePlayReleaseAdapter>[0],
): Promise<ReleaseControlExecutionResult> {
  if (request.identity.target !== 'android' || request.control.target !== 'android') {
    return {
      status: 'blocked',
      mutationAttempted: false,
      code: 'GOOGLE_PLAY_RELEASE_CONTROL_INVALID',
    };
  }
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) {
    return { status: 'blocked', mutationAttempted: false, code: access.action.code };
  }
  const completed = await mutateControlAsync(request, access.token, options.request);
  return completed
    ? { status: 'completed', mutationAttempted: true }
    : {
        status: 'failed',
        mutationAttempted: true,
        code: 'GOOGLE_PLAY_RELEASE_CONTROL_FAILED',
      };
}

async function mutateReleaseAsync(
  request: ReleaseStepExecutionRequest,
  token: string,
  transport: GooglePlayTransport,
): Promise<ReleaseMutationResult> {
  if (request.identity.target !== 'android') return blocked('GOOGLE_PLAY_IDENTITY_INVALID');
  const context = await openReleaseEditAsync(request.identity.packageName, token, transport);
  if (context === null) return failedMutation('GOOGLE_PLAY_RELEASE_INSPECTION_FAILED');
  const updated = updateGooglePlayReleaseBody(context.track, request);
  if (updated === null) return blocked('GOOGLE_PLAY_RELEASE_NOT_FOUND');
  return commitReleaseMutationAsync(
    request.identity.packageName,
    context.editId,
    updated,
    token,
    transport,
  );
}

async function mutateControlAsync(
  request: ReleaseControlRequest,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  if (request.identity.target !== 'android' || request.control.target !== 'android') return false;
  const context = await openReleaseEditAsync(request.identity.packageName, token, transport);
  if (context === null) return false;
  const updated = updateGooglePlayControlBody(
    context.track,
    request.desired.version,
    request.control.action,
  );
  if (updated === null) return false;
  const written = await writeGooglePlayReleaseEditTrackAsync({
    packageName: request.identity.packageName,
    editId: context.editId,
    token,
    body: updated,
    transport,
  });
  return written && commitGooglePlayReleaseEditAsync({
    packageName: request.identity.packageName,
    editId: context.editId,
    token,
    transport,
  });
}

interface ReleaseEditContext {
  readonly editId: string;
  readonly track: Record<string, unknown>;
}

async function openReleaseEditAsync(
  packageName: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<ReleaseEditContext | null> {
  const editId = await createGooglePlayReleaseEditAsync({ packageName, token, transport });
  if (editId === null) return null;
  const track = await readGooglePlayReleaseEditTrackAsync({
    packageName,
    editId,
    token,
    transport,
  });
  return track === null ? null : { editId, track };
}

async function commitReleaseMutationAsync(
  packageName: string,
  editId: string,
  body: Readonly<Record<string, unknown>>,
  token: string,
  transport: GooglePlayTransport,
): Promise<ReleaseMutationResult> {
  const written = await writeGooglePlayReleaseEditTrackAsync({
    packageName,
    editId,
    token,
    body,
    transport,
  });
  if (!written) return failedMutation('GOOGLE_PLAY_RELEASE_UPDATE_FAILED');
  const committed = await commitGooglePlayReleaseEditAsync({
    packageName,
    editId,
    token,
    transport,
  });
  return committed ? { status: 'completed' } : failedMutation('GOOGLE_PLAY_EDIT_COMMIT_FAILED');
}

function isMutableOperation(operation: ReleaseStepExecutionRequest['step']['operation']): boolean {
  return operation === 'sync-notes' || operation === 'release' || operation === 'rollout';
}

function blocked(code: string): ReleaseMutationResult {
  return { status: 'blocked', code };
}

function failedMutation(code: string): ReleaseMutationResult {
  return { status: 'failed', code };
}

function failedInspection(code: string): DeploymentProviderResult<ReleaseObservedAndroidState> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'Google Play release state could not be inspected.',
      target: 'android',
      provider: 'google-play',
    },
  };
}
