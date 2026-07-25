package main

import (
	"context"
	"database/sql"
	"fmt"

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
