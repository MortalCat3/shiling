export const libraryPublicationSql = `
CREATE TABLE shiling.tags (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 40), description text NOT NULL DEFAULT '' CHECK(length(description)<=5000),
 normalized_name text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','disabled')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tags_revision BEFORE UPDATE ON shiling.tags FOR EACH ROW EXECUTE FUNCTION shiling.touch_revision();
CREATE TABLE shiling.asset_tags (
 asset_id uuid NOT NULL REFERENCES shiling.assets(id) ON DELETE RESTRICT, tag_id uuid NOT NULL REFERENCES shiling.tags(id) ON DELETE RESTRICT,
 assigned_by uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(asset_id,tag_id)
);
CREATE INDEX asset_tags_reverse_idx ON shiling.asset_tags(tag_id,asset_id);
CREATE TABLE shiling.collections (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200), description text NOT NULL DEFAULT '' CHECK(length(description)<=5000),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), archived_at timestamptz, archived_by uuid REFERENCES shiling.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK((archived_at IS NULL)=(archived_by IS NULL))
);
CREATE INDEX collections_owner_idx ON shiling.collections(owner_id,archived_at,updated_at,id);
CREATE TRIGGER collections_revision BEFORE UPDATE ON shiling.collections FOR EACH ROW EXECUTE FUNCTION shiling.touch_revision();
CREATE TABLE shiling.collection_items (
 collection_id uuid NOT NULL REFERENCES shiling.collections(id) ON DELETE RESTRICT,
 asset_id uuid NOT NULL REFERENCES shiling.assets(id) ON DELETE RESTRICT,
 added_by uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(collection_id,asset_id)
);
CREATE INDEX collection_items_reverse_idx ON shiling.collection_items(asset_id,collection_id);
CREATE TABLE shiling.favorites (
 user_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT, asset_id uuid NOT NULL REFERENCES shiling.assets(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,asset_id)
);
CREATE INDEX favorites_order_idx ON shiling.favorites(user_id,created_at,asset_id);
CREATE INDEX favorites_asset_idx ON shiling.favorites(asset_id);
CREATE TABLE shiling.publications (
 id uuid PRIMARY KEY, asset_id uuid NOT NULL UNIQUE REFERENCES shiling.assets(id) ON DELETE RESTRICT,
 state text NOT NULL CHECK(state IN ('active','withdrawn')), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 current_revision_id uuid NOT NULL, updated_by uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,asset_id)
);
CREATE INDEX publications_state_idx ON shiling.publications(state,updated_at,id);
CREATE TRIGGER publications_revision BEFORE UPDATE ON shiling.publications FOR EACH ROW EXECUTE FUNCTION shiling.touch_revision();
CREATE TABLE shiling.publication_revisions (
 id uuid PRIMARY KEY, publication_id uuid NOT NULL, asset_id uuid NOT NULL,
 revision_no bigint NOT NULL CHECK(revision_no>0), action text NOT NULL CHECK(action IN ('publish','update','withdraw')),
 version_id uuid NOT NULL, title text, description text, tag_labels text[], tag_keys text[], download_filename text,
 snapshot_schema_version integer NOT NULL DEFAULT 1 CHECK(snapshot_schema_version>0), source_asset_revision bigint NOT NULL CHECK(source_asset_revision>0),
 actor_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT, reason_code text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(publication_id,asset_id) REFERENCES shiling.publications(id,asset_id) ON DELETE RESTRICT,
 FOREIGN KEY(asset_id,version_id) REFERENCES shiling.asset_versions(asset_id,id) ON DELETE RESTRICT,
 UNIQUE(publication_id,revision_no), UNIQUE(publication_id,id), UNIQUE(id,version_id),
 CHECK((action='withdraw' AND title IS NULL AND description IS NULL AND tag_labels IS NULL AND tag_keys IS NULL AND download_filename IS NULL)
 OR (action<>'withdraw' AND title IS NOT NULL AND length(btrim(title)) BETWEEN 1 AND 200 AND description IS NOT NULL AND length(description)<=5000 AND tag_labels IS NOT NULL AND tag_keys IS NOT NULL AND cardinality(tag_labels)=cardinality(tag_keys) AND download_filename IS NOT NULL))
);
ALTER TABLE shiling.publications ADD FOREIGN KEY(id,current_revision_id) REFERENCES shiling.publication_revisions(publication_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX publication_revisions_tags_idx ON shiling.publication_revisions USING gin(tag_keys);
CREATE INDEX publication_revisions_search_idx ON shiling.publication_revisions USING gin((lower(title || ' ' || description)) public.gin_trgm_ops);
CREATE TRIGGER publication_revisions_immutable BEFORE UPDATE OR DELETE ON shiling.publication_revisions FOR EACH ROW EXECUTE FUNCTION shiling.reject_mutation();
CREATE TABLE shiling.publication_revision_artifacts (
 publication_revision_id uuid NOT NULL, version_id uuid NOT NULL, role text NOT NULL, artifact_id uuid NOT NULL,
 PRIMARY KEY(publication_revision_id,role),
 FOREIGN KEY(publication_revision_id,version_id) REFERENCES shiling.publication_revisions(id,version_id) ON DELETE RESTRICT,
 FOREIGN KEY(version_id,artifact_id) REFERENCES shiling.artifacts(version_id,id) ON DELETE RESTRICT
);
CREATE INDEX publication_revision_artifacts_ref_idx ON shiling.publication_revision_artifacts(artifact_id);
CREATE TRIGGER publication_revision_artifacts_immutable BEFORE UPDATE OR DELETE ON shiling.publication_revision_artifacts FOR EACH ROW EXECUTE FUNCTION shiling.reject_mutation();
`;
