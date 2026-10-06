-- session.mfa_bypassed (#570). Written when MFA_ENFORCEMENT=off skips
-- step-up for a privileged grant. Outcome is allowed. The reason is
-- human text (1-200 characters), not a machine token.
-- #557 uses 000043. Schema migrations are forward-only, so this file
-- has no down script.

ALTER TABLE session_audit_events DROP CONSTRAINT session_audit_events_type_check;
ALTER TABLE session_audit_events ADD CONSTRAINT session_audit_events_type_check CHECK (event_type IN (
    'session.created',
    'session.refreshed',
    'session.revoked',
    'session.expired',
    'session.csrf_rejected',
    'session.origin_rejected',
    'session.privilege_denied',
    'session.auth_rejected',
    'bootstrap.admin_password_set',
    'session.mfa_bypassed'
));
