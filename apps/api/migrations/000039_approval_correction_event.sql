-- Approval correction events.
--
-- Boot resync and decide record a corrected event when the stored
-- approver role or policy pin is rewritten. This migration only widens
-- the event-type check. It does not set row_security off and does not
-- grant BYPASSRLS.

ALTER TABLE approval_events DROP CONSTRAINT IF EXISTS approval_events_type_check;
ALTER TABLE approval_events ADD CONSTRAINT approval_events_type_check CHECK (event_type IN (
    'created', 'approved', 'rejected', 'expired', 'invalidated', 'canceled', 'corrected'
));
