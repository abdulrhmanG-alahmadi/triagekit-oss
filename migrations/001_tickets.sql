CREATE TABLE tickets (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id varchar(128) PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  subject varchar(500) NOT NULL,
  body varchar(20000) NOT NULL CHECK (body ~ '[^[:space:]]'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'classified', 'failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  category text CHECK (category IN ('billing', 'technical', 'account', 'other')),
  priority text CHECK (priority IN ('low', 'medium', 'high')),
  summary varchar(500) CHECK (summary ~ '[^[:space:]]' AND summary !~ E'[\r\n]'),
  model text,
  prompt_version text,
  classified_at timestamptz,
  failure_code varchar(64),
  last_error_code varchar(64),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_token uuid,
  lease_until timestamptz,
  CONSTRAINT classification_consistency CHECK (
    (status = 'classified' AND category IS NOT NULL AND priority IS NOT NULL AND summary IS NOT NULL
      AND model IS NOT NULL AND prompt_version IS NOT NULL AND classified_at IS NOT NULL)
    OR (status <> 'classified' AND category IS NULL AND priority IS NULL AND summary IS NULL
      AND model IS NULL AND prompt_version IS NULL AND classified_at IS NULL)
  ),
  CONSTRAINT failure_consistency CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT lease_consistency CHECK (
    (attempt_token IS NULL AND lease_until IS NULL)
    OR (status = 'pending' AND attempt_token IS NOT NULL AND lease_until IS NOT NULL)
  )
);
CREATE INDEX tickets_queue ON tickets (available_at, sequence) WHERE status = 'pending';
CREATE INDEX tickets_exhausted ON tickets (attempts, lease_until) WHERE status = 'pending';
CREATE INDEX tickets_category_page ON tickets (category, sequence DESC) WHERE status = 'classified';
CREATE INDEX tickets_priority_page ON tickets (priority, sequence DESC) WHERE status = 'classified';

CREATE TABLE rate_limits (
  principal text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  requests integer NOT NULL CHECK (requests > 0)
);
