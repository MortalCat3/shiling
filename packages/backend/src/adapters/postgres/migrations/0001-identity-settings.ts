import { DEFAULT_MEMBER_PERMISSIONS, PERMISSION_KEYS } from '@shiling/contracts';

const permissionValues = PERMISSION_KEYS.map((key) => `'${key}'`).join(',');
export const identitySettingsSql = `
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE FUNCTION shiling.touch_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.revision := OLD.revision + 1; NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;
CREATE FUNCTION shiling.touch_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;
CREATE FUNCTION shiling.reject_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable record' USING ERRCODE='23514'; END $$;

CREATE TABLE shiling.roles (
 id uuid PRIMARY KEY, key text NOT NULL UNIQUE CHECK(length(key) BETWEEN 1 AND 80),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80), kind text NOT NULL CHECK(kind IN ('system','custom')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((key='sysadmin' AND kind='system' AND archived_at IS NULL) OR (key<>'sysadmin' AND kind='custom'))
);
CREATE TRIGGER roles_revision BEFORE UPDATE ON shiling.roles FOR EACH ROW EXECUTE FUNCTION shiling.touch_revision();
CREATE TABLE shiling.role_permissions (
 role_id uuid NOT NULL REFERENCES shiling.roles(id) ON DELETE RESTRICT,
 permission_key text NOT NULL CHECK(permission_key IN (${permissionValues})), PRIMARY KEY(role_id,permission_key)
);
CREATE INDEX role_permissions_key_idx ON shiling.role_permissions(permission_key,role_id);
INSERT INTO shiling.roles(id,key,name,kind) VALUES
 ('00000000-0000-4000-8000-000000000001','sysadmin','系统管理员','system'),
 ('00000000-0000-4000-8000-000000000002','member','成员','custom');
INSERT INTO shiling.role_permissions(role_id,permission_key) VALUES
 ${PERMISSION_KEYS.map((key) => `('00000000-0000-4000-8000-000000000001','${key}')`).join(',')},
 ${DEFAULT_MEMBER_PERMISSIONS.map((key) => `('00000000-0000-4000-8000-000000000002','${key}')`).join(',')};

CREATE TABLE shiling.users (
 id uuid PRIMARY KEY, display_name text NOT NULL CHECK(length(btrim(display_name)) BETWEEN 1 AND 80),
 status text NOT NULL CHECK(status IN ('invited','active','suspended')),
 role_id uuid NOT NULL REFERENCES shiling.roles(id) ON DELETE RESTRICT,
 auth_epoch bigint NOT NULL DEFAULT 1 CHECK(auth_epoch>0), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid REFERENCES shiling.users(id) ON DELETE RESTRICT, activated_at timestamptz, suspended_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='suspended')=(suspended_at IS NOT NULL))
);
CREATE INDEX users_role_status_idx ON shiling.users(role_id,status);
CREATE INDEX users_status_created_idx ON shiling.users(status,created_at,id);
CREATE TRIGGER users_revision BEFORE UPDATE ON shiling.users FOR EACH ROW EXECUTE FUNCTION shiling.touch_revision();
CREATE TABLE shiling.identities (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 provider_key text NOT NULL CHECK(provider_key='password'), subject text NOT NULL CHECK(subject ~ '^[a-z0-9._-]{3,64}$'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider_key,subject), UNIQUE(user_id,id), UNIQUE(user_id,provider_key)
);
CREATE TRIGGER identities_updated BEFORE UPDATE ON shiling.identities FOR EACH ROW EXECUTE FUNCTION shiling.touch_updated_at();
CREATE TABLE shiling.password_credentials (
 identity_id uuid PRIMARY KEY REFERENCES shiling.identities(id) ON DELETE RESTRICT,
 password_hash text NOT NULL CHECK(length(password_hash)>20), changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shiling.sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT, identity_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'), auth_epoch bigint NOT NULL CHECK(auth_epoch>0),
 reauthenticated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, revoke_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(user_id,identity_id) REFERENCES shiling.identities(user_id,id) ON DELETE RESTRICT,
 CHECK(expires_at>created_at)
);
CREATE INDEX sessions_user_expiry_idx ON shiling.sessions(user_id,expires_at);
CREATE INDEX sessions_live_expiry_idx ON shiling.sessions(expires_at) WHERE revoked_at IS NULL;
CREATE TABLE shiling.invitations (
 id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES shiling.users(id) ON DELETE RESTRICT,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','revoked')),
 accepted_at timestamptz, revoked_at timestamptz, created_by uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id),
 CHECK((state='accepted')=(accepted_at IS NOT NULL)), CHECK((state='revoked')=(revoked_at IS NOT NULL))
);
CREATE TRIGGER invitations_revision BEFORE UPDATE ON shiling.invitations FOR EACH ROW EXECUTE FUNCTION shiling.touch_revision();
CREATE TABLE shiling.auth_tokens (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 invitation_id uuid, purpose text NOT NULL CHECK(purpose IN ('invitation','recovery')),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'), issued_by uuid REFERENCES shiling.users(id) ON DELETE RESTRICT,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((purpose='invitation')=(invitation_id IS NOT NULL)), CHECK(NOT(consumed_at IS NOT NULL AND revoked_at IS NOT NULL)),
 FOREIGN KEY(invitation_id,user_id) REFERENCES shiling.invitations(id,user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX auth_tokens_current_idx ON shiling.auth_tokens(user_id,purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX auth_tokens_expiry_idx ON shiling.auth_tokens(expires_at);
CREATE INDEX auth_tokens_invitation_idx ON shiling.auth_tokens(invitation_id);

CREATE TABLE shiling.branding_assets (
 id uuid PRIMARY KEY, uploader_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 purpose text NOT NULL CHECK(purpose IN ('logo','favicon')), state text NOT NULL CHECK(state IN ('receiving','verifying','verified','failed')),
 storage_object_id uuid, media_type text, width integer CHECK(width>0), height integer CHECK(height>0),
 bytes bigint CHECK(bytes>=0), sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'), failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(state<>'verified' OR (storage_object_id IS NOT NULL AND media_type IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE TRIGGER branding_assets_updated BEFORE UPDATE ON shiling.branding_assets FOR EACH ROW EXECUTE FUNCTION shiling.touch_updated_at();
CREATE TABLE shiling.product_settings (
 id smallint PRIMARY KEY CHECK(id=1), schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version>0),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), initialized_at timestamptz,
 public_access_epoch bigint NOT NULL DEFAULT 1 CHECK(public_access_epoch>0), preview_access_epoch bigint NOT NULL DEFAULT 1 CHECK(preview_access_epoch>0),
 runtime_epoch uuid NOT NULL DEFAULT gen_random_uuid(),
 logo_branding_asset_id uuid REFERENCES shiling.branding_assets(id) ON DELETE RESTRICT,
 favicon_branding_asset_id uuid REFERENCES shiling.branding_assets(id) ON DELETE RESTRICT,
 values jsonb NOT NULL DEFAULT '{"name":"拾灵","publicEnabled":false,"executePreview":false}'::jsonb CHECK(jsonb_typeof(values)='object'),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES shiling.users(id) ON DELETE RESTRICT
);
INSERT INTO shiling.product_settings(id) VALUES(1);
CREATE TRIGGER product_settings_revision BEFORE UPDATE ON shiling.product_settings FOR EACH ROW EXECUTE FUNCTION shiling.touch_revision();
CREATE TABLE shiling.audit_events (
 id uuid PRIMARY KEY, actor_kind text NOT NULL CHECK(actor_kind IN ('user','system','anonymous')),
 actor_id uuid REFERENCES shiling.users(id) ON DELETE RESTRICT, action text NOT NULL, resource_type text NOT NULL,
 resource_id uuid, outcome text NOT NULL CHECK(outcome IN ('success','denied','failed')),
 request_id text NOT NULL, correlation_id text, changes jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(changes)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx ON shiling.audit_events(created_at,id);
CREATE INDEX audit_events_resource_idx ON shiling.audit_events(resource_type,resource_id,created_at);
CREATE INDEX audit_events_actor_idx ON shiling.audit_events(actor_id,created_at);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON shiling.audit_events FOR EACH ROW EXECUTE FUNCTION shiling.reject_mutation();
CREATE TABLE shiling.idempotency_records (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES shiling.users(id) ON DELETE RESTRICT,
 operation text NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), state text NOT NULL CHECK(state IN ('started','completed')),
 resource_refs jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(resource_refs)='object'), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(actor_id,operation,idempotency_key)
);
CREATE INDEX idempotency_expiry_idx ON shiling.idempotency_records(expires_at);
CREATE TRIGGER idempotency_updated BEFORE UPDATE ON shiling.idempotency_records FOR EACH ROW EXECUTE FUNCTION shiling.touch_updated_at();
`;
