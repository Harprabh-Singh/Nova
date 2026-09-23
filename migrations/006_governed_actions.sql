-- NOVA Phase 8: governed enterprise actions.
--
-- Phase 7 (proactive/streaming agent orchestration) is DEFERRED. Nothing in
-- this migration depends on it, and nothing here anticipates it.
--
-- Two concerns are added, and nothing else:
--
-- 1. role_action_permissions
--    Which ROLE, in which TENANT, may request which ACTION. Action
--    authorization is intentionally NOT folded into `permissions`: that table
--    answers "which classification of document may this role READ, in which
--    department?" and is a reading clearance. Being cleared to read the IT
--    support policy is not permission to raise a ticket against it, so the
--    write capability gets its own explicit grant. The stored value is the
--    ActionDefinition.requiredPermission string (e.g. 'actions.it.create_request'),
--    so the registry in code and the grants in Neon cannot drift silently:
--    an unknown permission simply matches no action.
--
-- 2. action_requests
--    The audit table. Every governed action attempt is recorded BEFORE it can
--    execute, including attempts that were refused, and is then updated in
--    place as it moves through the state machine:
--
--      proposed -> awaiting_confirmation -> authorized -> executing -> succeeded
--                                        \-> rejected                 \-> failed
--
--    The row is the record of WHO asked, WHICH tenant they were in, WHAT the
--    validated input was, WHETHER authorization passed and why, WHETHER a
--    human confirmed, WHICH executor ran it (local mock vs Azure Function),
--    and WHICH knowledge document + version the request was attributed to.
--    Source attribution is the auditable link between "the assistant told me
--    this" and "so I did that": an action taken on the strength of a policy
--    clause names the document and the exact version it came from.
CREATE TABLE IF NOT EXISTS role_action_permissions (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL,
	role_key TEXT NOT NULL,
	action_permission TEXT NOT NULL,
	granted_at TEXT NOT NULL,
	granted_by TEXT,
	UNIQUE (tenant_id, role_key, action_permission)
);
CREATE INDEX IF NOT EXISTS idx_role_action_permissions_lookup ON role_action_permissions (tenant_id, role_key);

CREATE TABLE IF NOT EXISTS action_requests (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL,
	action_id TEXT NOT NULL,
	action_name TEXT NOT NULL,
	status TEXT NOT NULL,
	required_permission TEXT NOT NULL,
	-- Identity is copied from the authenticated principal at request time, never
	-- from the request body, and is denormalised so the audit trail survives a
	-- later role change or user rename.
	requested_by_user_id TEXT NOT NULL,
	requested_by_name TEXT NOT NULL,
	requested_by_email TEXT NOT NULL DEFAULT '',
	requested_by_role_key TEXT NOT NULL,
	requested_by_department TEXT NOT NULL DEFAULT '',
	authorization_decision TEXT NOT NULL,
	authorization_reason TEXT NOT NULL,
	confirmation_required INTEGER NOT NULL DEFAULT 1,
	confirmed_at TEXT,
	-- The validated input, frozen at propose time. The confirm step replays THIS
	-- payload; it never accepts a new one, so a confirmation cannot be used to
	-- smuggle different arguments past the authorization check.
	input_json TEXT NOT NULL,
	result_json TEXT,
	error_code TEXT,
	error_message TEXT,
	executor TEXT NOT NULL,
	simulated INTEGER NOT NULL DEFAULT 1,
	conversation_id TEXT,
	source_document_id TEXT,
	source_version_id TEXT,
	source_document_title TEXT,
	source_version_label TEXT,
	request_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_requests_tenant ON action_requests (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_requests_tenant_user ON action_requests (tenant_id, requested_by_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_requests_status ON action_requests (tenant_id, status);
