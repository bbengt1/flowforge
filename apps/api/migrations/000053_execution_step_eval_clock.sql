-- #650 E3.3: deterministic per-attempt clock for FFX run.clock.
--
-- eval_clock is set once, when the attempt is first claimed (the claim that
-- moves the row to running), and never changed after: a re-claim of the
-- same attempt after lease recovery keeps it (COALESCE). Every evaluation
-- in that attempt reads it as run.clock, so re-evaluating an attempt gives
-- the same result. A retry is a new execution_steps row, so it gets a new
-- value. Rows created before this migration, and attempts that have not
-- started, are NULL; an expression that reads run.clock without one fails
-- closed with expression-runtime.
--
-- Forward-only, no down script (repo convention).

ALTER TABLE execution_steps
    ADD COLUMN eval_clock timestamptz;
