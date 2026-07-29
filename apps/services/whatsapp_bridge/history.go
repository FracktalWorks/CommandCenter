package main

import (
	"context"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

const (
	// Messages per backfill POST — keeps each gateway transaction bounded.
	histBatchSize = 200
	// Reclassify once no history payload has arrived for this long (the on-link
	// sync comes in several payloads; mirror mautrix's dispatch-wait debounce).
	histDispatchWait = 90 * time.Second
)

// onHistorySync ingests an on-link (or on-demand) history payload: every
// conversation's messages are normalized and streamed to the gateway as a
// BACKFILL batch (persisted, but the post-sync hooks are skipped so no
// auto-reply fires on months-old messages). A debounced Reclassify runs once the
// payloads stop, to compute reply statuses over the imported chats.
func (m *SessionManager) onHistorySync(s *Session, e *events.HistorySync) {
	ctx := context.Background()
	data := e.Data
	if data == nil {
		return
	}

	var msgs []bridgeMessage
	contacts := map[string]bridgeContact{}
	total := 0

	flush := func() {
		if len(msgs) == 0 {
			return
		}
		batch := make([]bridgeMessage, len(msgs))
		copy(batch, msgs)
		if err := m.gw.Ingest(ctx, ingestPayload{
			AccountID: s.accountID, Messages: batch, Backfill: true,
		}); err != nil {
			m.log.Errorf("history flush %s: %v", s.accountID, err)
		}
		msgs = msgs[:0]
	}

	for _, conv := range data.GetConversations() {
		chatID := conv.GetID()
		if !isSyncableChat(chatID) {
			continue // skip status/broadcast/newsletter pseudo-chats
		}
		isGroup := strings.HasSuffix(chatID, "@g.us")
		groupSubject := ""
		if isGroup {
			groupSubject = firstNonEmpty(conv.GetName(), conv.GetDisplayName())
		} else if name := firstNonEmpty(conv.GetName(), conv.GetDisplayName()); name != "" {
			// Name the DM from the conversation header (contacts upsert on wa_id).
			if u := jidUser(chatID); u != "" {
				contacts[u] = bridgeContact{WAID: u, PhoneNumber: phoneFromUserJID(chatID), Name: name}
			}
		}
		// One check per conversation (not per message) — a fresh number's whole
		// history backfills here, so this is the main way avatars populate.
		if jid, err := types.ParseJID(chatID); err == nil {
			m.enqueueAvatarCheck(s, jid)
		}
		for _, hm := range conv.GetMessages() {
			bm, ok := m.webMsgToBridge(ctx, s.accountID, chatID, isGroup, groupSubject, hm.GetMessage())
			if !ok {
				continue
			}
			msgs = append(msgs, bm)
			total++
			if len(msgs) >= histBatchSize {
				flush()
			}
		}
	}
	flush()

	if len(contacts) > 0 {
		cs := make([]bridgeContact, 0, len(contacts))
		for _, c := range contacts {
			cs = append(cs, c)
		}
		if err := m.gw.Ingest(ctx, ingestPayload{
			AccountID: s.accountID, Contacts: cs, Backfill: true,
		}); err != nil {
			m.log.Errorf("history contacts flush %s: %v", s.accountID, err)
		}
	}

	if total > 0 {
		m.log.Infof("history sync %s for %s: %d messages",
			data.GetSyncType(), s.accountID, total)
	}
	m.scheduleReclassify(s)
}

// webMsgToBridge normalizes a history WebMessageInfo into the same bridgeMessage
// shape live events produce. Returns false for rows we skip (no id / no payload —
// status/protocol messages). Media protos are cached so /media can re-download on
// demand (older media may have expired server-side; that download simply 404s).
func (m *SessionManager) webMsgToBridge(
	ctx context.Context, accountID, chatID string, isGroup bool,
	groupSubject string, wmi *waWeb.WebMessageInfo,
) (bridgeMessage, bool) {
	if wmi == nil {
		return bridgeMessage{}, false
	}
	key := wmi.GetKey()
	if key == nil || key.GetID() == "" {
		return bridgeMessage{}, false
	}
	inner := wmi.GetMessage()
	if inner == nil {
		return bridgeMessage{}, false
	}
	kind, body, media := classifyMessage(inner)

	fromMe := key.GetFromMe()
	senderWAID := ""
	switch {
	case isGroup:
		senderWAID = jidUser(firstNonEmpty(key.GetParticipant(), wmi.GetParticipant()))
	case !fromMe:
		senderWAID = jidUser(chatID)
	}

	bm := bridgeMessage{
		WAMessageID: key.GetID(),
		ChatID:      chatID,
		Direction:   directionOf(fromMe),
		Kind:        kind,
		SenderWAID:  senderWAID,
		SenderName:  wmi.GetPushName(),
		BodyText:    body,
		ChatKind:    chatKindOf(isGroup),
		SentAt:      time.Unix(int64(wmi.GetMessageTimestamp()), 0).UTC().Format(time.RFC3339),
	}
	if isGroup {
		bm.GroupSubject = groupSubject
	}
	if ci := contextInfoOf(inner); ci != nil {
		bm.QuotedWAMessageID = ci.GetStanzaID()
		bm.Mentions = ci.GetMentionedJID()
	}
	if media != nil {
		if raw, err := proto.Marshal(inner); err == nil {
			_ = m.meta.PutMedia(ctx, accountID, key.GetID(), media.mime, raw)
		}
		bm.Media = &bridgeMedia{
			WAMediaID: key.GetID(), MimeType: media.mime,
			Filename: media.filename, SizeBytes: int64(media.size),
		}
	}
	return bm, true
}

// scheduleReclassify (re)arms the debounce: when the history payloads stop
// arriving, run the chat-status classifier once over the account.
func (m *SessionManager) scheduleReclassify(s *Session) {
	acc := s.accountID
	s.histMu.Lock()
	defer s.histMu.Unlock()
	if s.histTimer != nil {
		s.histTimer.Stop()
	}
	s.histTimer = time.AfterFunc(histDispatchWait, func() {
		if err := m.gw.Reclassify(context.Background(), acc); err != nil {
			m.log.Warnf("reclassify after backfill %s: %v", acc, err)
			return
		}
		m.log.Infof("backfill settled for %s — reclassified", acc)
	})
}

// isSyncableChat keeps real DMs/groups and drops status, broadcast lists and
// newsletters, which don't belong in the triage inbox.
func isSyncableChat(jid string) bool {
	if jid == "" {
		return false
	}
	return strings.HasSuffix(jid, "@s.whatsapp.net") ||
		strings.HasSuffix(jid, "@g.us") ||
		strings.HasSuffix(jid, "@lid")
}

// jidUser returns the user part of a JID string ("919…@s.whatsapp.net" → "919…").
func jidUser(jid string) string {
	if i := strings.IndexByte(jid, '@'); i >= 0 {
		return jid[:i]
	}
	return jid
}

// phoneFromUserJID returns "+<number>" for a phone-number JID, else "" (LID JIDs
// are not phone numbers).
func phoneFromUserJID(jid string) string {
	if strings.HasSuffix(jid, "@s.whatsapp.net") {
		if u := jidUser(jid); u != "" {
			return "+" + u
		}
	}
	return ""
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
