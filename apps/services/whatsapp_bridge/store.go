package main

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go sqlite driver, registered as "sqlite"
)

// MetaStore holds the bridge's own bookkeeping — kept in a small sqlite file
// beside whatsmeow's device store so the two never contend on the same handle:
//
//   - sessions: account_id (the wa_account UUID the gateway assigned) ↔ the
//     device JID whatsmeow paired. Lets us reload the right device on restart.
//   - media: a normalized media_id ↔ the marshaled message proto, so a later
//     /media call can re-download the bytes on demand (whatsmeow downloads from
//     the original message, not from a Meta-style media handle).
type MetaStore struct {
	db *sql.DB
}

// OpenMetaStore opens (creating if needed) the bridge bookkeeping database.
func OpenMetaStore(ctx context.Context, path string) (*MetaStore, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, fmt.Errorf("open meta store: %w", err)
	}
	db.SetMaxOpenConns(1) // sqlite: serialize writers, avoids SQLITE_BUSY
	schema := `
	CREATE TABLE IF NOT EXISTS sessions (
		account_id TEXT PRIMARY KEY,
		jid        TEXT NOT NULL DEFAULT ''
	);
	CREATE TABLE IF NOT EXISTS media (
		account_id TEXT NOT NULL,
		media_id  TEXT NOT NULL,
		mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
		proto     BLOB NOT NULL,
		PRIMARY KEY (account_id, media_id)
	);
	CREATE TABLE IF NOT EXISTS flags (
		account_id TEXT NOT NULL,
		key        TEXT NOT NULL,
		PRIMARY KEY (account_id, key)
	);
	CREATE TABLE IF NOT EXISTS avatar_checks (
		account_id TEXT NOT NULL,
		wa_chat_id TEXT NOT NULL,
		hash       TEXT NOT NULL DEFAULT '',
		checked_at INTEGER NOT NULL,
		PRIMARY KEY (account_id, wa_chat_id)
	);`
	if _, err := db.ExecContext(ctx, schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init meta schema: %w", err)
	}
	return &MetaStore{db: db}, nil
}

// Close releases the database handle.
func (m *MetaStore) Close() error { return m.db.Close() }

// PutSession records (or clears) the device JID a paired account maps to.
func (m *MetaStore) PutSession(ctx context.Context, accountID, jid string) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO sessions (account_id, jid) VALUES (?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET jid = excluded.jid`,
		accountID, jid)
	return err
}

// AllSessions returns every account_id→jid mapping, for reconnect on startup.
func (m *MetaStore) AllSessions(ctx context.Context) (map[string]string, error) {
	rows, err := m.db.QueryContext(ctx, `SELECT account_id, jid FROM sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var acc, jid string
		if err := rows.Scan(&acc, &jid); err != nil {
			return nil, err
		}
		out[acc] = jid
	}
	return out, rows.Err()
}

// PutMedia caches a downloadable message proto so /media can fetch it later.
// Keyed by (account_id, media_id): the same group message received by two paired
// numbers shares a whatsmeow message id, so scoping by account keeps them apart.
func (m *MetaStore) PutMedia(ctx context.Context, accountID, mediaID, mime string, proto []byte) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO media (account_id, media_id, mime_type, proto) VALUES (?, ?, ?, ?)
		 ON CONFLICT(account_id, media_id) DO UPDATE SET proto = excluded.proto, mime_type = excluded.mime_type`,
		accountID, mediaID, mime, proto)
	return err
}

// GetMedia returns the cached proto + mime for one account's media_id.
func (m *MetaStore) GetMedia(ctx context.Context, accountID, mediaID string) (proto []byte, mime string, ok bool) {
	err := m.db.QueryRowContext(ctx,
		`SELECT proto, mime_type FROM media WHERE account_id = ? AND media_id = ?`,
		accountID, mediaID).Scan(&proto, &mime)
	if err != nil {
		return nil, "", false
	}
	return proto, mime, true
}

// HasFlag reports whether a per-account boolean flag is set (its presence in the
// flags table). Used to guard one-time work like the initial label backfill.
func (m *MetaStore) HasFlag(ctx context.Context, accountID, key string) (bool, error) {
	var one int
	err := m.db.QueryRowContext(ctx,
		`SELECT 1 FROM flags WHERE account_id = ? AND key = ?`,
		accountID, key).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// SetFlag records a per-account flag (idempotent).
func (m *MetaStore) SetFlag(ctx context.Context, accountID, key string) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO flags (account_id, key) VALUES (?, ?)
		 ON CONFLICT(account_id, key) DO NOTHING`,
		accountID, key)
	return err
}

// ClearFlag removes a per-account flag so its one-time work runs again.
func (m *MetaStore) ClearFlag(ctx context.Context, accountID, key string) error {
	_, err := m.db.ExecContext(ctx,
		`DELETE FROM flags WHERE account_id = ? AND key = ?`, accountID, key)
	return err
}

// AvatarCheckState returns the last-known profile-picture hash for a chat and
// whether that answer is older than ttl (never-checked counts as stale, with an
// empty hash). The hash doubles as whatsmeow's ExistingID param — passing it lets
// the server reply "unchanged" instead of re-sending a URL we already have.
func (m *MetaStore) AvatarCheckState(ctx context.Context, accountID, jid string, ttl time.Duration) (hash string, stale bool, err error) {
	var checkedAt int64
	err = m.db.QueryRowContext(ctx,
		`SELECT hash, checked_at FROM avatar_checks WHERE account_id = ? AND wa_chat_id = ?`,
		accountID, jid).Scan(&hash, &checkedAt)
	if err == sql.ErrNoRows {
		return "", true, nil
	}
	if err != nil {
		return "", false, err
	}
	return hash, time.Since(time.Unix(checkedAt, 0)) > ttl, nil
}

// MarkAvatarChecked records that a chat's profile picture was just checked
// (found, unchanged, not-set, or hidden — any definitive answer), resetting its
// TTL. hash is whatever whatsmeow reported, or "" if there is no picture.
func (m *MetaStore) MarkAvatarChecked(ctx context.Context, accountID, jid, hash string) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO avatar_checks (account_id, wa_chat_id, hash, checked_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(account_id, wa_chat_id) DO UPDATE SET hash = excluded.hash, checked_at = excluded.checked_at`,
		accountID, jid, hash, time.Now().Unix())
	return err
}
