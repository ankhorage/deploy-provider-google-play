import type {
  ReleaseObservedAndroidState,
  ReleaseStepExecutionRequest,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

export function findGooglePlayRelease(
  value: unknown,
  version: string,
): Record<string, unknown> | null {
  const releases = readUnknownArrayFromRecord(value, 'releases');
  if (releases === null) return null;
  return releases.find(
    (release): release is Record<string, unknown> =>
      isRecord(release) && release.name === version,
  ) ?? null;
}

export function observeGooglePlayRelease(
  version: string,
  release: Record<string, unknown>,
): ReleaseObservedAndroidState {
  const userFraction =
    typeof release.userFraction === 'number' ? String(release.userFraction) : undefined;
  return {
    target: 'android',
    version,
    artifactRevision: null,
    versionCodes: readStringArray(release.versionCodes),
    releaseNotes: readReleaseNotes(release.releaseNotes),
    rolloutStatus: readRolloutStatus(release.status),
    ...(userFraction === undefined ? {} : { userFraction }),
  };
}

export function missingGooglePlayRelease(): ReleaseObservedAndroidState {
  return {
    target: 'android',
    version: null,
    artifactRevision: null,
    versionCodes: [],
    releaseNotes: [],
    rolloutStatus: 'missing',
  };
}

export function updateGooglePlayReleaseBody(
  value: Record<string, unknown>,
  request: ReleaseStepExecutionRequest,
): Record<string, unknown> | null {
  const releases = readUnknownArray(value.releases);
  if (releases === null) return null;
  const rollout = request.desired.rollout.android;
  const updated = releases.map((release): unknown => {
    if (!isRecord(release) || release.name !== request.desired.version) return release;
    if (request.step.operation === 'sync-notes') {
      return { ...release, releaseNotes: toReleaseNotes(request.desired.notes) };
    }
    if (request.step.operation === 'rollout' && rollout?.mode === 'staged') {
      return {
        ...release,
        status: 'inProgress',
        ...(rollout.initialFraction === undefined
          ? {}
          : { userFraction: Number(rollout.initialFraction) }),
      };
    }
    return { ...release, status: 'completed' };
  });
  return containsVersion(updated, request.desired.version) ? { ...value, releases: updated } : null;
}

export function updateGooglePlayControlBody(
  value: Record<string, unknown>,
  version: string,
  action: 'halt' | 'resume',
): Record<string, unknown> | null {
  const releases = readUnknownArray(value.releases);
  if (releases === null) return null;
  const updated = releases.map((release): unknown =>
    isRecord(release) && release.name === version
      ? { ...release, status: action === 'halt' ? 'halted' : 'inProgress' }
      : release,
  );
  return containsVersion(updated, version) ? { ...value, releases: updated } : null;
}

export function parseGooglePlayJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readUnknownArrayFromRecord(value: unknown, field: string): readonly unknown[] | null {
  if (!isRecord(value)) return null;
  switch (field) {
    case 'releases':
      return readUnknownArray(value.releases);
    default:
      return null;
  }
}

function readUnknownArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? Array.from(value, (item): unknown => item) : null;
}

function readStringArray(value: unknown): readonly string[] {
  const values = readUnknownArray(value);
  return values === null
    ? []
    : values.flatMap((item) => (typeof item === 'string' ? [item] : []));
}

function readReleaseNotes(value: unknown): ReleaseObservedAndroidState['releaseNotes'] {
  const values = readUnknownArray(value);
  if (values === null) return [];
  return values.flatMap((item) =>
    isRecord(item) && isNonEmptyString(item.language) && typeof item.text === 'string'
      ? [{ locale: item.language, text: item.text }]
      : [],
  );
}

function readRolloutStatus(value: unknown): ReleaseObservedAndroidState['rolloutStatus'] {
  switch (value) {
    case 'draft':
    case 'inProgress':
    case 'halted':
    case 'completed':
      return value;
    default:
      return 'missing';
  }
}

function toReleaseNotes(
  notes: ReleaseStepExecutionRequest['desired']['notes'],
): readonly Readonly<Record<string, string>>[] {
  return notes.map((note) => ({ language: note.locale, text: note.text }));
}

function containsVersion(values: readonly unknown[], version: string): boolean {
  return values.some((value) => isRecord(value) && value.name === version);
}
