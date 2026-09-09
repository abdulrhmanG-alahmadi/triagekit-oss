ALTER TABLE tickets ADD COLUMN classification_run_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE classification_runs (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY,
  ticket_id varchar(128) NOT NULL REFERENCES tickets(id),
  previous_run_id uuid,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  requested_by char(64) CHECK (requested_by ~ '^[a-f0-9]{64}$'),
  snapshot jsonb CHECK (snapshot IS NULL OR (jsonb_typeof(snapshot) = 'object'
    AND snapshot->>'status' IN ('classified', 'failed'))),
  UNIQUE (ticket_id, id),
  FOREIGN KEY (ticket_id, previous_run_id) REFERENCES classification_runs(ticket_id, id),
  CHECK (id IS DISTINCT FROM previous_run_id)
);
CREATE INDEX classification_runs_page ON classification_runs (ticket_id, sequence DESC);

INSERT INTO classification_runs (id, ticket_id, requested_at)
SELECT classification_run_id, id, created_at FROM tickets;

-- Deferred so ingestion can create the ticket and its initial run in one statement.
ALTER TABLE tickets ADD CONSTRAINT tickets_current_run
  FOREIGN KEY (id, classification_run_id) REFERENCES classification_runs(ticket_id, id)
  DEFERRABLE INITIALLY DEFERRED;
