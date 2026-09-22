export type MirrorRole = "mirror" | "origin" | "regular";

export interface MirrorRelationship {
  role: MirrorRole;
  origin_id: string | null;
  mirror_ids: string[];
}

export interface MirrorCacheFields {
  mirror_role: "mirror" | "origin" | null;
  mirror_origin_id: string | null;
  mirror_ids: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

export function describeMirrorMetadata(value: unknown): MirrorRelationship | null {
  const mirror = asRecord(value);
  if (!mirror) return null;

  if (Object.prototype.hasOwnProperty.call(mirror, "origin_id")) {
    return {
      role: "mirror",
      origin_id: typeof mirror.origin_id === "string" ? mirror.origin_id : null,
      mirror_ids: [],
    };
  }

  if (Object.prototype.hasOwnProperty.call(mirror, "mirror_ids")) {
    return {
      role: "origin",
      origin_id: null,
      mirror_ids: Array.isArray(mirror.mirror_ids)
        ? mirror.mirror_ids.filter((id): id is string => typeof id === "string")
        : [],
    };
  }

  return null;
}

export function describeNodeMirrorRelationship(node: unknown): MirrorRelationship {
  const record = asRecord(node);
  const data = asRecord(record?.data);
  return describeMirrorMetadata(data?.mirror) ?? {
    role: "regular",
    origin_id: null,
    mirror_ids: [],
  };
}

export function describeListMirrorRelationship(response: unknown): MirrorRelationship | null {
  const record = asRecord(response);
  return describeMirrorMetadata(record?.mirror);
}

export function getMirrorCacheFields(node: unknown): MirrorCacheFields {
  const relationship = describeNodeMirrorRelationship(node);
  if (relationship.role === "regular") {
    return { mirror_role: null, mirror_origin_id: null, mirror_ids: null };
  }
  return {
    mirror_role: relationship.role,
    mirror_origin_id: relationship.origin_id,
    mirror_ids: relationship.role === "origin"
      ? JSON.stringify(relationship.mirror_ids)
      : null,
  };
}

export function getCachedMirrorRelationship(
  role: unknown,
  originId: unknown,
  mirrorIdsJson: unknown,
): MirrorRelationship | null {
  if (role === "mirror") {
    return {
      role: "mirror",
      origin_id: typeof originId === "string" ? originId : null,
      mirror_ids: [],
    };
  }
  if (role === "origin") {
    let mirrorIds: string[] = [];
    if (typeof mirrorIdsJson === "string") {
      try {
        const parsed = JSON.parse(mirrorIdsJson);
        if (Array.isArray(parsed)) {
          mirrorIds = parsed.filter((id): id is string => typeof id === "string");
        }
      } catch {
        mirrorIds = [];
      }
    }
    return { role: "origin", origin_id: null, mirror_ids: mirrorIds };
  }
  return null;
}
