export const assetsIngestionSql = `
CREATE TABLE shiling.upload_batches (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 client_batch_key text, intake_policy_revision bigint NOT NULL CHECK(intake_policy_revision>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_batches_owner_idx ON shiling.upload_batches(owner_id,created_at,id);
CREATE TABLE shiling.upload_items (
 id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES shiling.upload_batches(id) ON DELETE RESTRICT,
 ordinal integer NOT NULL CHECK(ordinal>=0), client_item_id text NOT NULL CHECK(length(client_item_id) BETWEEN 1 AND 128),
 creation_request_hash text NOT NULL CHECK(creation_request_hash ~ '^[a-f0-9]{64}$'),
 requested_type text CHECK(requested_type IN ('image','video','web_motion')),
 original_filename text NOT NULL CHECK(length(original_filename) BETWEEN 1 AND 255), declared_bytes bigint NOT NULL CHECK(declared_bytes>0),
 declared_media_type text NOT NULL, declared_sha256 text CHECK(declared_sha256 ~ '^[a-f0-9]{64}$'),
 initial_metadata jsonb NOT NULL CHECK(jsonb_typeof(initial_metadata)='object'), requested_collection_ids uuid[] NOT NULL DEFAULT '{}',
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), organization_warnings jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(organization_warnings)='array'),
 transport_state text NOT NULL DEFAULT 'pending' CHECK(transport_state IN ('pending','uploading','verifying','verified','failed','canceled','expired')),
 attempt_generation bigint NOT NULL DEFAULT 1 CHECK(attempt_generation>0), current_attempt_id uuid,
 expires_at timestamptz NOT NULL, failure_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,ordinal), UNIQUE(batch_id,client_item_id)
);
CREATE INDEX upload_items_batch_idx ON shiling.upload_items(batch_id,ordinal);
CREATE INDEX upload_items_expiry_idx ON shiling.upload_items(transport_state,expires_at);
CREATE TRIGGER upload_items_revision BEFORE UPDATE ON shiling.upload_items FOR EACH ROW EXECUTE FUNCTION shiling.touch_revision();
CREATE TABLE shiling.upload_attempts (
 id uuid PRIMARY KEY, item_id uuid NOT NULL REFERENCES shiling.upload_items(id) ON DELETE RESTRICT,
 attempt_no integer NOT NULL CHECK(attempt_no>0), generation bigint NOT NULL CHECK(generation>0),
 state text NOT NULL CHECK(state IN ('issued','receiving','verifying','verified','failed','aborted','expired')),
 transfer_mode text NOT NULL CHECK(transfer_mode IN ('server_stream','direct_put','multipart')),
 intake_policy jsonb NOT NULL CHECK(jsonb_typeof(intake_policy)='object'), provider_upload_id text,
 expires_at timestamptz NOT NULL, received_bytes bigint CHECK(received_bytes>=0), verified_at timestamptz, failure_code text,
 completion_manifest jsonb, completion_request_hash text CHECK(completion_request_hash ~ '^[a-f0-9]{64}$'),
 verification_queue_job_id uuid, verification_fence bigint NOT NULL DEFAULT 0 CHECK(verification_fence>=0), verification_deadline_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(item_id,attempt_no), UNIQUE(item_id,id),
 CHECK((completion_manifest IS NULL)=(completion_request_hash IS NULL)), CHECK(state<>'verified' OR verified_at IS NOT NULL)
);
ALTER TABLE shiling.upload_items ADD FOREIGN KEY(id,current_attempt_id) REFERENCES shiling.upload_attempts(item_id,id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX upload_attempts_live_idx ON shiling.upload_attempts(item_id) WHERE state IN ('issued','receiving','verifying');
CREATE INDEX upload_attempts_expiry_idx ON shiling.upload_attempts(state,expires_at);
CREATE TRIGGER upload_attempts_updated BEFORE UPDATE ON shiling.upload_attempts FOR EACH ROW EXECUTE FUNCTION shiling.touch_updated_at();
CREATE TABLE shiling.assets (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 type_key text NOT NULL CHECK(type_key IN ('image','video','web_motion')),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200), description text NOT NULL DEFAULT '' CHECK(length(description)<=5000),
 lifecycle text NOT NULL DEFAULT 'pending' CHECK(lifecycle IN ('pending','active','archived')), current_version_id uuid,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), archived_at timestamptz, archived_by uuid REFERENCES shiling.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((lifecycle='pending')=(current_version_id IS NULL)),
 CHECK((lifecycle='archived')=(archived_at IS NOT NULL AND archived_by IS NOT NULL)),
 CHECK(lifecycle='archived' OR (archived_at IS NULL AND archived_by IS NULL))
);
CREATE INDEX assets_lifecycle_created_idx ON shiling.assets(lifecycle,created_at,id);
CREATE INDEX assets_owner_idx ON shiling.assets(owner_id,lifecycle,created_at,id);
CREATE INDEX assets_type_idx ON shiling.assets(type_key,lifecycle,created_at,id);
CREATE INDEX assets_search_idx ON shiling.assets USING gin((lower(title || ' ' || description)) public.gin_trgm_ops);
CREATE TRIGGER assets_revision BEFORE UPDATE ON shiling.assets FOR EACH ROW EXECUTE FUNCTION shiling.touch_revision();
CREATE TABLE shiling.asset_versions (
 id uuid PRIMARY KEY, asset_id uuid NOT NULL REFERENCES shiling.assets(id) ON DELETE RESTRICT,
 version_no integer NOT NULL DEFAULT 1 CHECK(version_no=1), upload_item_id uuid NOT NULL UNIQUE REFERENCES shiling.upload_items(id) ON DELETE RESTRICT,
 processing_state text NOT NULL CHECK(processing_state IN ('processing','ready','failed','canceled')),
 execution_generation bigint NOT NULL DEFAULT 1 CHECK(execution_generation>0),
 processor_plan jsonb NOT NULL CHECK(jsonb_typeof(processor_plan)='object'), source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 media_metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(media_metadata)='object'), ready_at timestamptz, failure_code text,
 created_by uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(asset_id,version_no), UNIQUE(asset_id,id), CHECK(processing_state<>'ready' OR ready_at IS NOT NULL)
);
ALTER TABLE shiling.assets ADD FOREIGN KEY(id,current_version_id) REFERENCES shiling.asset_versions(asset_id,id) ON DELETE RESTRICT;
CREATE INDEX asset_versions_state_idx ON shiling.asset_versions(processing_state,updated_at,id);
CREATE TRIGGER asset_versions_updated BEFORE UPDATE ON shiling.asset_versions FOR EACH ROW EXECUTE FUNCTION shiling.touch_updated_at();
CREATE TABLE shiling.processing_jobs (
 id uuid PRIMARY KEY, version_id uuid NOT NULL REFERENCES shiling.asset_versions(id) ON DELETE RESTRICT,
 execution_generation bigint NOT NULL CHECK(execution_generation>0), step_key text NOT NULL, processor_key text NOT NULL, processor_version text NOT NULL,
 required boolean NOT NULL, state text NOT NULL CHECK(state IN ('pending','queued','running','succeeded','failed','canceled')),
 queue_job_id uuid, current_attempt_id uuid, attempt_fence bigint NOT NULL DEFAULT 1 CHECK(attempt_fence>0),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0), next_attempt_at timestamptz, failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(version_id,execution_generation,step_key), UNIQUE(id,version_id)
);
CREATE INDEX processing_jobs_state_idx ON shiling.processing_jobs(state,updated_at,id);
CREATE INDEX processing_jobs_queue_idx ON shiling.processing_jobs(queue_job_id);
CREATE TRIGGER processing_jobs_updated BEFORE UPDATE ON shiling.processing_jobs FOR EACH ROW EXECUTE FUNCTION shiling.touch_updated_at();
CREATE TABLE shiling.job_dependencies (
 job_id uuid NOT NULL REFERENCES shiling.processing_jobs(id) ON DELETE RESTRICT,
 depends_on_job_id uuid NOT NULL REFERENCES shiling.processing_jobs(id) ON DELETE RESTRICT,
 PRIMARY KEY(job_id,depends_on_job_id), CHECK(job_id<>depends_on_job_id)
);
CREATE INDEX job_dependencies_reverse_idx ON shiling.job_dependencies(depends_on_job_id,job_id);
CREATE TABLE shiling.processing_attempts (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES shiling.processing_jobs(id) ON DELETE RESTRICT,
 attempt_no integer NOT NULL CHECK(attempt_no>0), fence bigint NOT NULL CHECK(fence>0),
 state text NOT NULL CHECK(state IN ('running','succeeded','failed','abandoned','canceled')),
 worker_instance text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), deadline_at timestamptz NOT NULL,
 finished_at timestamptz, error_code text, output_manifest jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(job_id,attempt_no), UNIQUE(job_id,id), CHECK((state='running')=(finished_at IS NULL)), CHECK(deadline_at>started_at)
);
ALTER TABLE shiling.processing_jobs ADD FOREIGN KEY(id,current_attempt_id) REFERENCES shiling.processing_attempts(job_id,id) ON DELETE RESTRICT;
CREATE INDEX processing_attempts_deadline_idx ON shiling.processing_attempts(state,deadline_at);
CREATE TABLE shiling.storage_objects (
 id uuid PRIMARY KEY, upload_attempt_id uuid UNIQUE REFERENCES shiling.upload_attempts(id) ON DELETE RESTRICT,
 processing_attempt_id uuid REFERENCES shiling.processing_attempts(id) ON DELETE RESTRICT,
 branding_asset_id uuid UNIQUE REFERENCES shiling.branding_assets(id) ON DELETE RESTRICT,
 backend_key text NOT NULL, namespace text NOT NULL, object_key text NOT NULL,
 provider_version_id text, provider_etag text, state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','stored','gc_pending','deleted')),
 integrity_state text NOT NULL DEFAULT 'pending' CHECK(integrity_state IN ('pending','verified','missing','corrupt')),
 bytes bigint CHECK(bytes>=0), sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'), verified_at timestamptz,
 retain_until timestamptz, gc_token uuid, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(backend_key,namespace,object_key), UNIQUE(branding_asset_id,id),
 CHECK(num_nonnulls(upload_attempt_id,processing_attempt_id,branding_asset_id)=1),
 CHECK(integrity_state<>'verified' OR (bytes IS NOT NULL AND sha256 IS NOT NULL AND verified_at IS NOT NULL)),
 CHECK(state<>'gc_pending' OR gc_token IS NOT NULL), CHECK((state='deleted')=(deleted_at IS NOT NULL))
);
ALTER TABLE shiling.branding_assets ADD FOREIGN KEY(id,storage_object_id) REFERENCES shiling.storage_objects(branding_asset_id,id) ON DELETE RESTRICT;
CREATE INDEX storage_objects_processing_idx ON shiling.storage_objects(processing_attempt_id);
CREATE INDEX storage_objects_gc_idx ON shiling.storage_objects(state,retain_until);
CREATE INDEX storage_objects_integrity_idx ON shiling.storage_objects(integrity_state) WHERE integrity_state IN ('missing','corrupt');
CREATE TRIGGER storage_objects_updated BEFORE UPDATE ON shiling.storage_objects FOR EACH ROW EXECUTE FUNCTION shiling.touch_updated_at();
CREATE TABLE shiling.artifacts (
 id uuid PRIMARY KEY, version_id uuid NOT NULL REFERENCES shiling.asset_versions(id) ON DELETE RESTRICT,
 role text NOT NULL CHECK(role IN ('original','thumbnail','preview_image','poster','playback_video','motion_manifest','loop_video')),
 variant_key text NOT NULL DEFAULT 'default' CHECK(length(variant_key)>0),
 storage_object_id uuid NOT NULL REFERENCES shiling.storage_objects(id) ON DELETE RESTRICT,
 produced_by_attempt_id uuid REFERENCES shiling.processing_attempts(id) ON DELETE RESTRICT,
 media_type text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(version_id,role,variant_key), UNIQUE(version_id,id)
);
CREATE INDEX artifacts_storage_idx ON shiling.artifacts(storage_object_id);
CREATE INDEX artifacts_attempt_idx ON shiling.artifacts(produced_by_attempt_id);
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON shiling.artifacts FOR EACH ROW EXECUTE FUNCTION shiling.reject_mutation();
CREATE TABLE shiling.package_entries (
 manifest_artifact_id uuid NOT NULL REFERENCES shiling.artifacts(id) ON DELETE RESTRICT,
 path text NOT NULL CHECK(length(path)>0 AND path !~ '(^/|(^|/)\\.\\.(/|$))'),
 storage_object_id uuid NOT NULL REFERENCES shiling.storage_objects(id) ON DELETE RESTRICT,
 media_type text NOT NULL, bytes bigint NOT NULL CHECK(bytes>=0), sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 is_entrypoint boolean NOT NULL DEFAULT false, PRIMARY KEY(manifest_artifact_id,path)
);
CREATE UNIQUE INDEX package_entries_entry_idx ON shiling.package_entries(manifest_artifact_id) WHERE is_entrypoint;
CREATE INDEX package_entries_storage_idx ON shiling.package_entries(storage_object_id);
`;
