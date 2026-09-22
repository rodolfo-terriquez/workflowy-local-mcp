import test from "node:test";
import assert from "node:assert/strict";
import {
  describeListMirrorRelationship,
  describeMirrorMetadata,
  describeNodeMirrorRelationship,
  getCachedMirrorRelationship,
  getMirrorCacheFields,
} from "../shared/mirror-metadata.js";

test("origin_id presence identifies a mirror even when the origin is inaccessible", () => {
  const relationship = describeNodeMirrorRelationship({
    data: { mirror: { origin_id: null } },
  });
  assert.deepEqual(relationship, {
    role: "mirror",
    origin_id: null,
    mirror_ids: [],
  });
});

test("mirror_ids presence identifies an origin even when the list is empty", () => {
  assert.deepEqual(describeMirrorMetadata({ mirror_ids: [] }), {
    role: "origin",
    origin_id: null,
    mirror_ids: [],
  });
});

test("list-level mirror metadata preserves an inaccessible origin", () => {
  assert.deepEqual(
    describeListMirrorRelationship({ nodes: [], mirror: { origin_id: null } }),
    { role: "mirror", origin_id: null, mirror_ids: [] },
  );
});

test("cache serialization round-trips mirror and origin relationships", () => {
  const mirrorFields = getMirrorCacheFields({ data: { mirror: { origin_id: null } } });
  assert.deepEqual(
    getCachedMirrorRelationship(
      mirrorFields.mirror_role,
      mirrorFields.mirror_origin_id,
      mirrorFields.mirror_ids,
    ),
    { role: "mirror", origin_id: null, mirror_ids: [] },
  );

  const originFields = getMirrorCacheFields({
    data: { mirror: { mirror_ids: ["mirror-1", "mirror-2"] } },
  });
  assert.deepEqual(
    getCachedMirrorRelationship(
      originFields.mirror_role,
      originFields.mirror_origin_id,
      originFields.mirror_ids,
    ),
    {
      role: "origin",
      origin_id: null,
      mirror_ids: ["mirror-1", "mirror-2"],
    },
  );
});
