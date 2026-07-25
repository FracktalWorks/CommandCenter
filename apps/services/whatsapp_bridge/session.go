package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

// Status values reported back to the gateway's /bridge/status poll.
const (
	statusPairing   = "pairing" // QR shown, waiting for the phone to scan
	statusLive      = "live"    // paired + connected, messages flowing
	statusLoggedOut = "logged_out"
)

// Sentinel errors so the HTTP layer can map manager failures to the right status
// code (a disconnected account or missing media is a client/state error, not a
// downstream 502).
var (
	ErrNotConnected  = errors.New("account not connected")
	ErrMediaNotFound = errors.New("media not found")
)

// Session is one paired (or pairing) personal number: a whatsmeow client plus
// the current QR (while pairing) and status. Guarded by its own mutex because
// the QR-channel goroutine and HTTP handlers both touch it.
type Session struct {
	accountID string
	client    *whatsmeow.Client

	mu     sync.RWMutex
	qr     string // data-URI PNG of the current pairing code, "" once live
	status string
}

func (s *Session) snapshot() (status, qr string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status, s.qr
}

func (s *Session) setQR(dataURI string) {
	s.mu.Lock()
	s.qr, s.status = dataURI, statusPairing
	s.mu.Unlock()
}

func (s *Session) setStatus(status string) {
	s.mu.Lock()
	s.status = status
	if status == statusLive || status == statusLoggedOut {
		s.qr = ""
	}
	s.mu.Unlock()
}

// SessionManager owns the whatsmeow device container + every live Session, and
// bridges inbound messages to the gateway.
type SessionManager struct {
	container *sqlstore.Container
	meta      *MetaStore
	gw        *GatewayClient
	log       waLog.Logger

	mu       sync.RWMutex
	sessions map[string]*Session
}

// NewSessionManager wires the manager to its stores + gateway client.
func NewSessionManager(c *sqlstore.Container, meta *MetaStore, gw *GatewayClient, log waLog.Logger) *SessionManager {
	return &SessionManager{
		container: c, meta: meta, gw: gw, log: log,
		sessions: map[string]*Session{},
	}
}

func (m *SessionManager) get(accountID string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[accountID]
	return s, ok
}

func (m *SessionManager) put(s *Session) {
	m.mu.Lock()
	m.sessions[s.accountID] = s
	m.mu.Unlock()
}

// claim atomically inserts s only if the account has no session yet. It returns
// the winning session and whether s was the one stored — so check-and-insert is a
// single critical section (no TOCTOU where two callers both build a client).
func (m *SessionManager) claim(s *Session) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.sessions[s.accountID]; ok {
		return existing, false
	}
	m.sessions[s.accountID] = s
	return s, true
}

// remove drops a session from the map and disconnects its client. Used to undo a
// half-started session when pairing setup fails, so a retry starts clean instead
// of hitting a zombie that serves an empty QR forever.
func (m *SessionManager) remove(accountID string) {
	m.mu.Lock()
	s, ok := m.sessions[accountID]
	delete(m.sessions, accountID)
	m.mu.Unlock()
	if ok && s.client != nil {
		s.client.Disconnect()
	}
}

// newClient builds a whatsmeow client around a device store + attaches the
// per-account event handler.
func (m *SessionManager) newClient(accountID string, device *store.Device) *Session {
	client := whatsmeow.NewClient(device, m.log.Sub("wa:"+accountID))
	s := &Session{accountID: accountID, client: client, status: statusPairing}
	client.AddEventHandler(m.handler(s))
	return s
}

// StartSession begins (or resumes) pairing for an account. If the device is
// already paired it just connects and reports live; otherwise it opens a QR
// channel, connects, and returns the first QR as a data-URI PNG to render.
func (m *SessionManager) StartSession(ctx context.Context, accountID string) (qr string, err error) {
	if s, ok := m.get(accountID); ok {
		status, qr := s.snapshot()
		if status == statusLive {
			return "", nil
		}
		return qr, nil // pairing already in flight — hand back the current code
	}

	// Build the client, then atomically claim the slot. If another goroutine
	// claimed it first, drop ours (it was never Connect()-ed, so nothing leaks)
	// and hand back the winner's current QR.
	device := m.container.NewDevice()
	s := m.newClient(accountID, device)
	if winner, mine := m.claim(s); !mine {
		_, qr := winner.snapshot()
		return qr, nil
	}

	// GetQRChannel must be called before Connect and only when not logged in.
	// On any setup failure, remove the half-started session so a retry is clean.
	qrChan, err := s.client.GetQRChannel(context.Background())
	if err != nil {
		m.remove(accountID)
		return "", fmt.Errorf("qr channel: %w", err)
	}
	if err := s.client.Connect(); err != nil {
		m.remove(accountID)
		return "", fmt.Errorf("connect: %w", err)
	}

	first := make(chan string, 1)
	go m.pumpQR(accountID, s, qrChan, first)

	select {
	case code := <-first:
		return code, nil
	case <-time.After(15 * time.Second):
		return "", nil // still initializing; the client will poll /status for it
	}
}

// pumpQR drains the QR channel: each "code" becomes a rendered data URI; the
// terminal "success" event means the phone scanned it and the device paired.
func (m *SessionManager) pumpQR(accountID string, s *Session, qrChan <-chan whatsmeow.QRChannelItem, first chan<- string) {
	sentFirst := false
	for item := range qrChan {
		switch item.Event {
		case "code":
			uri := renderQR(item.Code)
			if uri == "" {
				m.log.Warnf("failed to render QR code for %s", accountID)
			}
			s.setQR(uri)
			if !sentFirst {
				sentFirst = true
				select {
				case first <- uri:
				default:
				}
			}
		case "success":
			m.onPaired(accountID, s)
			return
		default: // timeout / err-* → pairing failed, drop back so a retry can start fresh
			m.log.Warnf("pairing ended for %s: %s", accountID, item.Event)
			s.setStatus(statusLoggedOut)
			return
		}
	}
}

// onPaired records the paired device JID + tells the gateway who connected.
func (m *SessionManager) onPaired(accountID string, s *Session) {
	s.setStatus(statusLive)
	ctx := context.Background()
	jid := ""
	name := s.client.Store.PushName
	if s.client.Store.ID != nil {
		jid = s.client.Store.ID.String()
	}
	if err := m.meta.PutSession(ctx, accountID, jid); err != nil {
		m.log.Errorf("persist session %s: %v", accountID, err)
	}
	phone := ""
	if s.client.Store.ID != nil {
		phone = "+" + s.client.Store.ID.User
	}
	if err := m.gw.Paired(ctx, pairedPayload{
		Session: accountID, PhoneNumber: phone, DisplayName: name, JID: jid,
	}); err != nil {
		m.log.Errorf("notify gateway paired %s: %v", accountID, err)
	}
}

// RestoreSessions reconnects every already-paired account on startup.
func (m *SessionManager) RestoreSessions(ctx context.Context) {
	sessions, err := m.meta.AllSessions(ctx)
	if err != nil {
		m.log.Errorf("load sessions: %v", err)
		return
	}
	for accountID, jidStr := range sessions {
		if jidStr == "" {
			continue
		}
		jid, err := types.ParseJID(jidStr)
		if err != nil {
			continue
		}
		device, err := m.container.GetDevice(ctx, jid)
		if err != nil || device == nil {
			m.log.Warnf("no stored device for %s (%s)", accountID, jidStr)
			continue
		}
		s := m.newClient(accountID, device)
		s.setStatus(statusLive)
		m.put(s)
		if err := s.client.Connect(); err != nil {
			m.log.Errorf("reconnect %s: %v", accountID, err)
		}
	}
}

// Status returns the pairing status + current QR for an account.
func (m *SessionManager) Status(accountID string) (status, qr string) {
	if s, ok := m.get(accountID); ok {
		return s.snapshot()
	}
	return "unknown", ""
}

// Send delivers a free-form text message from a paired account. Returns the
// whatsmeow message id.
func (m *SessionManager) Send(ctx context.Context, accountID, to, body, replyTo string) (string, error) {
	s, ok := m.get(accountID)
	if !ok || !s.client.IsLoggedIn() {
		return "", ErrNotConnected
	}
	toJID, err := parseRecipient(to)
	if err != nil {
		return "", err
	}
	msg := buildTextMessage(body, replyTo, toJID)
	resp, err := s.client.SendMessage(ctx, toJID, msg)
	if err != nil {
		return "", err
	}
	return resp.ID, nil
}

// DownloadMedia re-downloads a cached media object's bytes on demand.
func (m *SessionManager) DownloadMedia(ctx context.Context, accountID, mediaID string) ([]byte, string, error) {
	s, ok := m.get(accountID)
	if !ok || !s.client.IsLoggedIn() {
		return nil, "", ErrNotConnected
	}
	raw, mime, ok := m.meta.GetMedia(ctx, accountID, mediaID)
	if !ok {
		return nil, "", ErrMediaNotFound
	}
	var msg waE2E.Message
	if err := proto.Unmarshal(raw, &msg); err != nil {
		return nil, "", fmt.Errorf("decode media proto: %w", err)
	}
	data, err := s.client.DownloadAny(ctx, &msg)
	if err != nil {
		return nil, "", err
	}
	return data, mime, nil
}

// MarkRead sends a best-effort read receipt.
func (m *SessionManager) MarkRead(ctx context.Context, accountID, chat, sender, msgID string) {
	s, ok := m.get(accountID)
	if !ok {
		return
	}
	chatJID, err1 := types.ParseJID(chat)
	senderJID, err2 := types.ParseJID(sender)
	if err1 != nil || err2 != nil {
		return
	}
	_ = s.client.MarkRead(ctx, []types.MessageID{msgID}, time.Now(), chatJID, senderJID)
}

// renderQR encodes a whatsmeow pairing string as a base64 PNG data URI so the
// frontend can render it with a plain <img>.
func renderQR(code string) string {
	png, err := qrcode.Encode(code, qrcode.Medium, 320)
	if err != nil {
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
}

// parseRecipient accepts either a full JID ("919...@s.whatsapp.net") or a bare
// number/wa_id and coerces it to a user JID.
func parseRecipient(to string) (types.JID, error) {
	if to == "" {
		return types.JID{}, fmt.Errorf("empty recipient")
	}
	if strings.Contains(to, "@") {
		return types.ParseJID(to)
	}
	return types.NewJID(strings.TrimPrefix(to, "+"), types.DefaultUserServer), nil
}

// buildTextMessage builds a plain or reply text message.
func buildTextMessage(body, replyTo string, to types.JID) *waE2E.Message {
	if replyTo == "" {
		return &waE2E.Message{Conversation: proto.String(body)}
	}
	remote := to.String()
	return &waE2E.Message{
		ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String(body),
			ContextInfo: &waE2E.ContextInfo{
				StanzaID:  proto.String(replyTo),
				RemoteJID: proto.String(remote),
			},
		},
	}
}

// Shutdown disconnects every live client and closes the whatsmeow device
// container so a SIGTERM releases the websocket + sqlite handle cleanly.
func (m *SessionManager) Shutdown() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.mu.Unlock()
	for _, s := range sessions {
		if s.client != nil {
			s.client.Disconnect()
		}
	}
	if err := m.container.Close(); err != nil {
		m.log.Warnf("closing whatsmeow container: %v", err)
	}
}
