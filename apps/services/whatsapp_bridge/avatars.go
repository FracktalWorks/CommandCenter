package main

import (
	"context"
	"errors"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

// Chats render with colored initials until we've actually fetched a profile
// picture — WhatsApp doesn't push these proactively, so the bridge has to ask
// for one per chat. Kept off the hot path deliberately:
//
//   - A fixed-size worker pool (avatarWorkerCount) bounds how many concurrent
//     GetProfilePictureInfo calls the bridge makes — this is a real WhatsApp API
//     call per chat, not free, and a history-sync backfill can surface hundreds
//     of chats at once.
//   - A per-(account, chat) TTL cache (MetaStore.AvatarCheckState) means a chat
//     is asked about at most once a day no matter how many messages it sends —
//     enqueueAvatarCheck is called from every inbound/outbound message.
//   - The cached hash doubles as whatsmeow's ExistingID param, so an unchanged
//     picture costs a cheap "not modified" round-trip instead of a full URL
//     re-fetch + re-report to the gateway.
const (
	avatarWorkerCount  = 3                // concurrent GetProfilePictureInfo calls
	avatarQueueSize    = 256              // buffered jobs before enqueue starts dropping
	avatarCheckTTL     = 24 * time.Hour   // re-check cadence per chat
	avatarFetchTimeout = 20 * time.Second // per-request ceiling
)

// avatarJob is one queued "check this chat's profile picture" request.
type avatarJob struct {
	session *Session
	jid     types.JID
}

// enqueueAvatarCheck asks (non-blockingly) for a chat's profile picture to be
// checked, if the cached answer is missing or stale. Called from onMessage (live
// traffic) and onHistorySync (backfill) — cheap no-ops for a chat checked
// recently, so it's safe to call on every message without extra bookkeeping at
// the call sites.
func (m *SessionManager) enqueueAvatarCheck(s *Session, jid types.JID) {
	if jid.IsEmpty() || !isSyncableChat(jid.String()) {
		return
	}
	_, stale, err := m.meta.AvatarCheckState(context.Background(), s.accountID, jid.String(), avatarCheckTTL)
	if err != nil {
		m.log.Warnf("avatar cache read %s (%s): %v", s.accountID, jid, err)
		return
	}
	if !stale {
		return
	}
	select {
	case m.avatarQueue <- avatarJob{session: s, jid: jid}:
	default:
		// Queue saturated — drop it. The next message (or the next history-sync
		// conversation) for this chat will try again; the TTL check above keeps
		// a saturated queue from being the common case.
	}
}

// avatarWorker drains the queue for the process lifetime. Started N times
// (avatarWorkerCount) by NewSessionManager.
func (m *SessionManager) avatarWorker() {
	for job := range m.avatarQueue {
		m.fetchAvatar(job.session, job.jid)
	}
}

// fetchAvatar asks WhatsApp for one chat's current profile picture and reports
// any change to the gateway. Every branch ends by marking the check done (even
// on a hard error) so a persistently-failing chat costs one request per TTL
// window, not one per message.
func (m *SessionManager) fetchAvatar(s *Session, jid types.JID) {
	if s.client == nil || !s.client.IsLoggedIn() {
		return // not connected — skip marking, so this retries once live again
	}
	ctx, cancel := context.WithTimeout(context.Background(), avatarFetchTimeout)
	defer cancel()

	existingHash, _, err := m.meta.AvatarCheckState(ctx, s.accountID, jid.String(), avatarCheckTTL)
	if err != nil {
		m.log.Warnf("avatar cache read %s (%s): %v", s.accountID, jid, err)
	}

	info, err := s.client.GetProfilePictureInfo(ctx, jid, &whatsmeow.GetProfilePictureParams{
		Preview: true, ExistingID: existingHash,
	})
	mark := context.Background() // outlives ctx; this write shouldn't be cut off by the fetch timeout
	switch {
	case err == nil && info == nil:
		// whatsmeow reports "unchanged from ExistingID" as (nil, nil).
		_ = m.meta.MarkAvatarChecked(mark, s.accountID, jid.String(), existingHash)
	case err == nil && info != nil && info.URL != "":
		_ = m.meta.MarkAvatarChecked(mark, s.accountID, jid.String(), info.ID)
		if rerr := m.gw.IngestAvatars(mark, avatarsPayload{
			AccountID: s.accountID,
			Avatars: []bridgeAvatar{
				{WAChatID: jid.String(), AvatarURL: info.URL, AvatarHash: info.ID},
			},
		}); rerr != nil {
			m.log.Warnf("avatar report %s (%s): %v", s.accountID, jid, rerr)
		}
	case errors.Is(err, whatsmeow.ErrProfilePictureNotSet), errors.Is(err, whatsmeow.ErrProfilePictureUnauthorized):
		_ = m.meta.MarkAvatarChecked(mark, s.accountID, jid.String(), "")
	default:
		m.log.Debugf("avatar fetch %s (%s): %v", s.accountID, jid, err)
		_ = m.meta.MarkAvatarChecked(mark, s.accountID, jid.String(), existingHash)
	}
}
