-- First-run one-time local login (#376). must_change_password is set
-- only by the empty-table bootstrap seed. Change-password clears it
-- and replaces the hash so the one-time password is dead. Never
-- selected into User JSON, GET /session bodies as a hash, bootstrap
-- status, logs, or localStorage.

ALTER TABLE local_logins
    ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
