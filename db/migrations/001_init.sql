-- FITNESS AI — esquema inicial
-- Multi-gimnasio desde el inicio: toda entidad de negocio lleva gym_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;

-- ===================== Gimnasios y configuración =====================
CREATE TABLE gyms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  country       text NOT NULL DEFAULT 'EC',
  timezone      text NOT NULL DEFAULT 'America/Guayaquil',
  currency      text NOT NULL DEFAULT 'USD',
  capacity      integer NOT NULL DEFAULT 300 CHECK (capacity > 0),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gym_settings (
  gym_id                       uuid PRIMARY KEY REFERENCES gyms(id) ON DELETE CASCADE,
  config_level                 text NOT NULL DEFAULT 'basic' CHECK (config_level IN ('basic','advanced','automatic')),
  ai_enabled                   boolean NOT NULL DEFAULT true,
  ai_model                     text NOT NULL DEFAULT 'claude-opus-5-5',
  ai_effort                    text NOT NULL DEFAULT 'medium' CHECK (ai_effort IN ('low','medium','high','xhigh','max')),
  ai_monthly_budget_usd        numeric(12,2) NOT NULL DEFAULT 50,
  ai_alert_threshold           numeric(4,3) NOT NULL DEFAULT 0.8 CHECK (ai_alert_threshold > 0 AND ai_alert_threshold <= 1),
  max_adjustments_per_month    integer NOT NULL DEFAULT 2 CHECK (max_adjustments_per_month BETWEEN 0 AND 4),
  min_days_between_adjustments integer NOT NULL DEFAULT 14 CHECK (min_days_between_adjustments BETWEEN 1 AND 60),
  assistant_daily_limit        integer NOT NULL DEFAULT 30 CHECK (assistant_daily_limit BETWEEN 0 AND 500),
  nutrition_weight_change_pct  numeric(5,2) NOT NULL DEFAULT 3 CHECK (nutrition_weight_change_pct > 0),
  -- Precios por millón de tokens, editables (los precios del proveedor cambian; cada solicitud guarda una copia).
  ai_pricing                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Parámetros avanzados (nivel avanzado) y límites del modo automático
  advanced                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Costos operativos mensuales reales (infraestructura, almacenamiento, notificaciones, pasarela...) y tarifa cobrada
  operating_costs              jsonb NOT NULL DEFAULT '{}'::jsonb,
  monthly_fee_usd              numeric(12,2),
  target_margin                numeric(4,3) NOT NULL DEFAULT 0.6,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   uuid
);

-- ===================== Usuarios, sesiones, perfiles =====================
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id               uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  email                citext NOT NULL UNIQUE,
  password_hash        text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('admin','coach','athlete')),
  full_name            text NOT NULL,
  phone                text,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','deleted')),
  must_change_password boolean NOT NULL DEFAULT false,
  failed_logins        integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_gym_role_idx ON users(gym_id, role, status);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE coach_profiles (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialty   text,
  bio         text
);

CREATE TABLE athlete_profiles (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  coach_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Autorización médica registrada por admin/entrenador cuando el cuestionario detecta señales de alerta
  medical_clearance  boolean NOT NULL DEFAULT false,
  medical_clearance_note text,
  nutrition_clearance boolean NOT NULL DEFAULT false,
  nutrition_clearance_note text,
  joined_at          date NOT NULL DEFAULT current_date
);
CREATE INDEX athlete_profiles_coach_idx ON athlete_profiles(coach_id);

-- ===================== Evaluación inicial =====================
CREATE TABLE assessments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id           uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  athlete_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL DEFAULT 'initial' CHECK (kind IN ('initial','followup')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','reviewed')),
  current_step     text,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- secciones no sensibles
  health_enc       text,                                 -- sección de salud cifrada (AES-256-GCM)
  missing_critical jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_flags       jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_at     timestamptz,
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  review_notes     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assessments_athlete_idx ON assessments(athlete_id, created_at DESC);
CREATE INDEX assessments_gym_status_idx ON assessments(gym_id, status);

-- ===================== Biblioteca de ejercicios =====================
CREATE TABLE exercises (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id             uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name               text NOT NULL,
  media_url          text,
  media_type         text CHECK (media_type IN ('image','video')),
  primary_muscles    text[] NOT NULL DEFAULT '{}',
  secondary_muscles  text[] NOT NULL DEFAULT '{}',
  equipment          text[] NOT NULL DEFAULT '{}',
  movement_type      text,
  level              text NOT NULL DEFAULT 'beginner' CHECK (level IN ('beginner','intermediate','advanced')),
  execution          text,
  breathing          text,
  common_errors      text[] NOT NULL DEFAULT '{}',
  variations         text[] NOT NULL DEFAULT '{}',
  alternatives       text[] NOT NULL DEFAULT '{}',
  contraindications  text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','proposed')),
  source             text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','ai_proposed','seed')),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gym_id, name)
);
CREATE INDEX exercises_gym_status_idx ON exercises(gym_id, status);

-- ===================== IA: solicitudes, consumo y costos =====================
CREATE TABLE ai_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id             uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  athlete_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  operation          text NOT NULL CHECK (operation IN ('initial_generation','biweekly_adjustment','nutrition_update','admin_assistant')),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','refused','blocked','reused')),
  model              text NOT NULL,
  served_model       text,
  request_hash       text NOT NULL,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cost_usd           numeric(12,6) NOT NULL DEFAULT 0,
  price_snapshot     jsonb,
  latency_ms         integer,
  error              text,
  response           jsonb,
  reused_from        uuid REFERENCES ai_requests(id),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX ai_requests_gym_month_idx ON ai_requests(gym_id, created_at);
CREATE INDEX ai_requests_athlete_idx ON ai_requests(athlete_id, operation, created_at);
-- Evita solicitudes duplicadas simultáneas (mismo contenido en curso)
CREATE UNIQUE INDEX ai_requests_pending_hash_uq ON ai_requests(request_hash) WHERE status = 'pending';
CREATE INDEX ai_requests_hash_idx ON ai_requests(request_hash, status);

-- ===================== Planes =====================
CREATE TABLE training_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id          uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  athlete_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending_review','active','rejected','archived')),
  source          text NOT NULL CHECK (source IN ('ai_initial','ai_adjustment','manual')),
  content         jsonb NOT NULL,
  rationale       text,
  change_summary  jsonb,
  ai_request_id   uuid REFERENCES ai_requests(id),
  parent_plan_id  uuid REFERENCES training_plans(id),
  created_by      uuid REFERENCES users(id),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  review_notes    text,
  activated_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (athlete_id, version)
);
CREATE UNIQUE INDEX training_plans_one_active_uq ON training_plans(athlete_id) WHERE status = 'active';
CREATE INDEX training_plans_gym_status_idx ON training_plans(gym_id, status);

CREATE TABLE nutrition_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id          uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  athlete_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending_review','active','rejected','archived')),
  source          text NOT NULL CHECK (source IN ('ai_initial','ai_update','manual')),
  content         jsonb NOT NULL,
  rationale       text,
  update_reason   text,
  baseline        jsonb,  -- peso/objetivo/restricciones con los que se generó (para detectar cambios relevantes)
  ai_request_id   uuid REFERENCES ai_requests(id),
  parent_plan_id  uuid REFERENCES nutrition_plans(id),
  created_by      uuid REFERENCES users(id),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  review_notes    text,
  activated_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (athlete_id, version)
);
CREATE UNIQUE INDEX nutrition_plans_one_active_uq ON nutrition_plans(athlete_id) WHERE status = 'active';
CREATE INDEX nutrition_plans_gym_status_idx ON nutrition_plans(gym_id, status);

-- ===================== Seguimiento (sin IA) =====================
CREATE TABLE workout_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id            uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  athlete_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id           uuid REFERENCES training_plans(id) ON DELETE SET NULL,
  day_key           text,
  performed_on      date NOT NULL DEFAULT current_date,
  duration_min      integer CHECK (duration_min BETWEEN 0 AND 600),
  fatigue           integer CHECK (fatigue BETWEEN 1 AND 10),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workout_sessions_athlete_idx ON workout_sessions(athlete_id, performed_on DESC);

CREATE TABLE set_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
  exercise_id  uuid REFERENCES exercises(id) ON DELETE SET NULL,
  set_number   integer NOT NULL CHECK (set_number BETWEEN 1 AND 50),
  reps         integer NOT NULL CHECK (reps BETWEEN 0 AND 200),
  load_kg      numeric(7,2) CHECK (load_kg >= 0 AND load_kg <= 1000),
  rir          numeric(3,1) CHECK (rir BETWEEN 0 AND 10),
  rpe          numeric(3,1) CHECK (rpe BETWEEN 1 AND 10)
);
CREATE INDEX set_logs_session_idx ON set_logs(session_id);
CREATE INDEX set_logs_exercise_idx ON set_logs(exercise_id);

CREATE TABLE body_measurements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id        uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  athlete_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  measured_on   date NOT NULL DEFAULT current_date,
  weight_kg     numeric(5,2) CHECK (weight_kg BETWEEN 20 AND 400),
  body_fat_pct  numeric(4,1) CHECK (body_fat_pct BETWEEN 2 AND 75),
  waist_cm      numeric(5,1),
  hip_cm        numeric(5,1),
  chest_cm      numeric(5,1),
  arm_cm        numeric(5,1),
  thigh_cm      numeric(5,1),
  notes         text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX body_measurements_athlete_idx ON body_measurements(athlete_id, measured_on DESC);

CREATE TABLE food_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id       uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  athlete_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_on    date NOT NULL DEFAULT current_date,
  meal         text NOT NULL,
  description  text,
  kcal         integer CHECK (kcal BETWEEN 0 AND 10000),
  protein_g    numeric(6,1) CHECK (protein_g >= 0),
  carbs_g      numeric(6,1) CHECK (carbs_g >= 0),
  fat_g        numeric(6,1) CHECK (fat_g >= 0),
  adherence    text CHECK (adherence IN ('followed','partial','skipped')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX food_logs_athlete_idx ON food_logs(athlete_id, logged_on DESC);

CREATE TABLE wellness_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id          uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  athlete_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_on     date NOT NULL DEFAULT current_date,
  fatigue         integer CHECK (fatigue BETWEEN 1 AND 10),
  sleep_hours     numeric(3,1) CHECK (sleep_hours BETWEEN 0 AND 24),
  stress          integer CHECK (stress BETWEEN 1 AND 10),
  soreness        integer CHECK (soreness BETWEEN 1 AND 10),
  pain            boolean NOT NULL DEFAULT false,
  pain_location   text,
  pain_intensity  integer CHECK (pain_intensity BETWEEN 0 AND 10),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wellness_reports_athlete_idx ON wellness_reports(athlete_id, reported_on DESC);

CREATE TABLE coach_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  athlete_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coach_notes_athlete_idx ON coach_notes(athlete_id, created_at DESC);

-- ===================== Centro de conocimiento (RAG) =====================
CREATE TABLE knowledge_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id              uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('scientific','empirical')),
  title               text NOT NULL,
  topic               text NOT NULL,
  summary             text NOT NULL,
  body                text,
  tags                text[] NOT NULL DEFAULT '{}',
  -- científico
  source              text,
  authors             text,
  published_on        date,
  reference_list      text[] NOT NULL DEFAULT '{}',
  evidence_level      text CHECK (evidence_level IN ('meta_analysis','systematic_review','rct','cohort','case_series','expert_opinion','consensus')),
  -- empírico
  author_id           uuid REFERENCES users(id),
  specialty           text,
  objective           text,
  context             text,
  applicable_profile  text,
  results             text,
  limitations         text,
  classification      text CHECK (classification IN ('individual','repeated','evidence_backed','hypothesis')),
  -- control
  validation_status   text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','validated','rejected')),
  validated_by        uuid REFERENCES users(id),
  validated_at        timestamptz,
  version             integer NOT NULL DEFAULT 1,
  archived            boolean NOT NULL DEFAULT false,
  search              tsvector,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'scientific' OR (source IS NOT NULL AND evidence_level IS NOT NULL AND cardinality(reference_list) > 0)),
  CHECK (kind <> 'empirical' OR classification IS NOT NULL)
);
CREATE INDEX knowledge_search_idx ON knowledge_entries USING gin(search);
CREATE INDEX knowledge_gym_idx ON knowledge_entries(gym_id, kind, validation_status);

CREATE FUNCTION knowledge_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search :=
    setweight(to_tsvector('spanish', coalesce(NEW.title,'')), 'A') ||
    setweight(to_tsvector('spanish', coalesce(NEW.topic,'') || ' ' || array_to_string(NEW.tags,' ')), 'A') ||
    setweight(to_tsvector('spanish', coalesce(NEW.summary,'')), 'B') ||
    setweight(to_tsvector('spanish', coalesce(NEW.body,'') || ' ' || coalesce(NEW.results,'') || ' ' || coalesce(NEW.applicable_profile,'')), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER knowledge_search_trg BEFORE INSERT OR UPDATE ON knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION knowledge_search_update();

CREATE TABLE knowledge_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  snapshot    jsonb NOT NULL,
  changed_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, version)
);

-- Trazabilidad: qué conocimiento usó cada generación de IA
CREATE TABLE ai_citations (
  ai_request_id  uuid NOT NULL REFERENCES ai_requests(id) ON DELETE CASCADE,
  entry_id       uuid NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  entry_version  integer NOT NULL,
  usage_note     text,
  PRIMARY KEY (ai_request_id, entry_id)
);

-- ===================== Comunicación =====================
CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id        uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  sender_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          text NOT NULL,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_pair_idx ON messages(sender_id, recipient_id, created_at);
CREATE INDEX messages_recipient_idx ON messages(recipient_id, read_at);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text,
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, read_at, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ===================== Auditoría =====================
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  gym_id      uuid REFERENCES gyms(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  details     jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_gym_idx ON audit_logs(gym_id, created_at DESC);
