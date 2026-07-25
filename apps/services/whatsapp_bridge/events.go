package main

import (
	"context"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// handler returns the whatsmeow event callback for one session. It normalizes
// each inbound (or self-sent) message into the bridge JSON contract and streams
// it to the gateway, where it joins the same triage brain as a Cloud API number.
func (m *SessionManager) handler(s *Session) func(any) {
	return func(evt any) {
		switch e := evt.(type) {
		case *events.Message:
			m.onMessage(s, e)
		case *events.Connected:
			s.setStatus(statusLive)
		case *events.LoggedOut:
			s.setStatus(statusLoggedOut)
			_ = m.meta.PutSession(context.Background(), s.accountID, "")
		}
	}
}

func (m *SessionManager) onMessage(s *Session, e *events.Message) {
	ctx := context.Background()
	kind, body, media := classifyMessage(e.Message)

	msg := bridgeMessage{
		WAMessageID: e.Info.ID,
		ChatID:      e.Info.Chat.String(),
		Direction:   directionOf(e.Info.IsFromMe),
		Kind:        kind,
		SenderWAID:  e.Info.Sender.User,
		SenderName:  e.Info.PushName,
		BodyText:    body,
		ChatKind:    chatKindOf(e.Info.IsGroup),
		SentAt:      e.Info.Timestamp.UTC().Format(time.RFC3339),
	}
	if ci := contextInfoOf(e.Message); ci != nil {
		msg.QuotedWAMessageID = ci.GetStanzaID()
		msg.Mentions = ci.GetMentionedJID()
	}

	var contacts []bridgeContact
	if !e.Info.IsGroup && e.Info.Sender.User != "" {
		contacts = append(contacts, bridgeContact{
			WAID:        e.Info.Sender.User,
			PhoneNumber: phoneOf(e.Info.Sender),
			Name:        e.Info.PushName,
		})
	}

	if media != nil {
		// Cache the message proto so a later /media call can re-download it;
		// key the media on (account, message id) — one media per message here.
		if raw, err := proto.Marshal(e.Message); err == nil {
			_ = m.meta.PutMedia(ctx, s.accountID, e.Info.ID, media.mime, raw)
		}
		msg.Media = &bridgeMedia{
			WAMediaID: e.Info.ID,
			MimeType:  media.mime,
			Filename:  media.filename,
			SizeBytes: int64(media.size),
		}
	}

	if err := m.gw.Ingest(ctx, ingestPayload{
		AccountID: s.accountID,
		Messages:  []bridgeMessage{msg},
		Contacts:  contacts,
	}); err != nil {
		m.log.Errorf("ingest %s msg %s: %v", s.accountID, e.Info.ID, err)
	}
}

func directionOf(fromMe bool) string {
	if fromMe {
		return "out"
	}
	return "in"
}

func chatKindOf(isGroup bool) string {
	if isGroup {
		return "group"
	}
	return "dm"
}

// phoneOf returns the "+E.164" phone for a sender, but ONLY when the JID is a
// real phone-number address. Under WhatsApp's LID addressing the User part is an
// opaque numeric id, not a phone — prefixing it with "+" would be a bogus number,
// so we return "" and let the gateway fall back to the push name.
func phoneOf(jid types.JID) string {
	if jid.Server == types.DefaultUserServer && jid.User != "" {
		return "+" + jid.User
	}
	return ""
}

// mediaInfo is the normalized media metadata extracted from a message proto.
type mediaInfo struct {
	mime     string
	filename string
	size     uint64
}

// classifyMessage maps a whatsmeow message proto to our normalized (kind, body,
// media) triple. Unknown/unsupported types become "system" with an empty body so
// the row still lands — the same never-drop rule as the Cloud API parser.
func classifyMessage(msg *waE2E.Message) (kind, body string, media *mediaInfo) {
	switch {
	case msg.GetConversation() != "":
		return "text", msg.GetConversation(), nil
	case msg.GetExtendedTextMessage() != nil:
		return "text", msg.GetExtendedTextMessage().GetText(), nil
	case msg.GetImageMessage() != nil:
		im := msg.GetImageMessage()
		return "image", im.GetCaption(), &mediaInfo{mime: im.GetMimetype(), size: im.GetFileLength()}
	case msg.GetVideoMessage() != nil:
		vm := msg.GetVideoMessage()
		return "video", vm.GetCaption(), &mediaInfo{mime: vm.GetMimetype(), size: vm.GetFileLength()}
	case msg.GetAudioMessage() != nil:
		am := msg.GetAudioMessage()
		k := "audio"
		if am.GetPTT() {
			k = "voice"
		}
		return k, "", &mediaInfo{mime: am.GetMimetype(), size: am.GetFileLength()}
	case msg.GetDocumentMessage() != nil:
		dm := msg.GetDocumentMessage()
		return "document", dm.GetCaption(), &mediaInfo{
			mime: dm.GetMimetype(), filename: dm.GetFileName(), size: dm.GetFileLength()}
	case msg.GetStickerMessage() != nil:
		sm := msg.GetStickerMessage()
		return "sticker", "", &mediaInfo{mime: sm.GetMimetype(), size: sm.GetFileLength()}
	case msg.GetLocationMessage() != nil:
		return "location", msg.GetLocationMessage().GetName(), nil
	case msg.GetContactMessage() != nil:
		return "contact", msg.GetContactMessage().GetDisplayName(), nil
	case msg.GetReactionMessage() != nil:
		return "reaction", msg.GetReactionMessage().GetText(), nil
	default:
		return "system", "", nil
	}
}

// contextInfoOf returns the reply/context info from whichever message variant
// carries it (text vs media), or nil.
func contextInfoOf(msg *waE2E.Message) *waE2E.ContextInfo {
	switch {
	case msg.GetExtendedTextMessage() != nil:
		return msg.GetExtendedTextMessage().GetContextInfo()
	case msg.GetImageMessage() != nil:
		return msg.GetImageMessage().GetContextInfo()
	case msg.GetVideoMessage() != nil:
		return msg.GetVideoMessage().GetContextInfo()
	case msg.GetDocumentMessage() != nil:
		return msg.GetDocumentMessage().GetContextInfo()
	case msg.GetAudioMessage() != nil:
		return msg.GetAudioMessage().GetContextInfo()
	}
	return nil
}
