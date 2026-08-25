/**
 * Version negotiation.
 *
 * Two independent numbers, deliberately not merged:
 *   - `EVENT_SCHEMA_VERSION` stamps every `IFlowEvent.schemaVersion`. It governs
 *     the new local-first journal/projection channel.
 *   - `LEGACY_SYNC_VERSION` is the pre-existing A2A/mirror protocol version the
 *     DSH plugin already speaks ('20'). It is frozen here so the two channels
 *     coexist without one bumping the other.
 */

export const EVENT_SCHEMA_VERSION = 2

/** Schema v1 remains readable so an upgraded edge does not discard its journal. */
export const LEGACY_EVENT_SCHEMA_VERSION = 1

export const LEGACY_SYNC_VERSION = '20'

export interface VersionSupport {
  eventSchemaVersions: number[]
  legacySyncVersion: string
}

export const LOCAL_VERSION_SUPPORT: VersionSupport = {
  eventSchemaVersions: [LEGACY_EVENT_SCHEMA_VERSION, EVENT_SCHEMA_VERSION],
  legacySyncVersion: LEGACY_SYNC_VERSION,
}

/** Highest schema version both sides can read, or undefined when incompatible. */
export function negotiateEventSchema(local: VersionSupport, remote: VersionSupport): number | undefined {
  const shared = local.eventSchemaVersions.filter((v) => remote.eventSchemaVersions.includes(v))
  return shared.length > 0 ? Math.max(...shared) : undefined
}
