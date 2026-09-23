-- NOVA Phase 6: Microsoft Entra ID authentication + NOVA identity mapping.
--
-- Microsoft Entra answers "who is this human?".
-- Neon answers "which NOVA user is this, in which tenant, with which role,
-- department, classification clearance and permissions?".
--
-- entra_object_id   the stable Entra directory object id (the `oid` claim).
--                   NEVER an email, UPN or display name: those change.
--                   Globally unique because the NOVA Entra application is
--                   single-tenant: one Entra identity maps to exactly one
--                   NOVA user, so a linked identity cannot be claimed twice
--                   (including across NOVA tenants).
-- entra_upn         last seen userPrincipalName/preferred_username. Display
--                   and support only; it is never used to resolve identity.
-- status            'active'   - normal NOVA user
--                   'pending'  - auto-provisioned first-time Entra user with
--                                no privileges; must be approved by an admin
--                   'disabled' - retained but refused at authentication
--
-- Demo users are unaffected: entra_object_id stays NULL and status defaults
-- to 'active', so LOCAL/DEMO mode keeps working exactly as before.
ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_object_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_upn TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- Unique only over linked rows: many demo users may have no Entra identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_object_id ON users (entra_object_id) WHERE entra_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_tenant_status ON users (tenant_id, status);
