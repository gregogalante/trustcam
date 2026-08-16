import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(process.env.DB_PATH || path.join(dir, '..', 'trustcam.db'))
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    model TEXT NOT NULL,
    public_key_pem TEXT NOT NULL,
    attestation_chain TEXT,          -- JSON array of base64 DER certs
    security_level TEXT,             -- strongbox | tee | software (claimed; server-validated later)
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS proofs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    device_id INTEGER NOT NULL REFERENCES devices(id),
    sha256 TEXT NOT NULL,            -- hex, lowercase
    signature TEXT NOT NULL,         -- base64 ECDSA-SHA256 over the 32 raw hash bytes
    media_type TEXT NOT NULL,        -- photo | video
    size_bytes INTEGER NOT NULL,
    captured_at TEXT NOT NULL,       -- ISO 8601, device clock
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_proofs_sha256 ON proofs(sha256);
`)

// payload: 24-bit watermark payload embedded on-device (deviceId<<14 | counter)
try {
  db.exec('ALTER TABLE proofs ADD COLUMN payload INTEGER')
} catch { /* column already exists */ }
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_proofs_payload ON proofs(payload) WHERE payload IS NOT NULL')
db.exec('DROP INDEX IF EXISTS idx_proofs_wm_sha256')

export default db
