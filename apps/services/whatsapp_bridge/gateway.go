package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// GatewayClient posts inbound messages + pairing events to the CommandCenter
// gateway. The JSON shapes here are the exact contract the gateway's
// parse_bridge_payload / bridge_paired handlers consume — keep them in sync with
// apps/services/gateway/gateway/routes/whatsapp/transport/bridge.py.
type GatewayClient struct {
	baseURL string
	secret  string
	http    *http.Client
}

// NewGatewayClient builds a client for the given gateway base URL + shared secret.
func NewGatewayClient(baseURL, secret string) *GatewayClient {
	return &GatewayClient{
		baseURL: baseURL,
		secret:  secret,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// bridgeMedia mirrors the WhatsAppMedia dataclass the gateway parser expects.
type bridgeMedia struct {
	WAMediaID string `json:"wa_media_id"`
	MimeType  string `json:"mime_type,omitempty"`
	Filename  string `json:"filename,omitempty"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
}

// bridgeMessage mirrors the WhatsAppMessage dataclass fields the parser reads.
type bridgeMessage struct {
	WAMessageID       string       `json:"wa_message_id"`
	ChatID            string       `json:"chat_id"`
	Direction         string       `json:"direction"`
	Kind              string       `json:"kind"`
	SenderWAID        string       `json:"sender_wa_id"`
	SenderName        string       `json:"sender_name"`
	BodyText          string       `json:"body_text"`
	QuotedWAMessageID string       `json:"quoted_wa_message_id,omitempty"`
	Mentions          []string     `json:"mentions,omitempty"`
	Media             *bridgeMedia `json:"media,omitempty"`
	GroupSubject      string       `json:"group_subject,omitempty"`
	ChatKind          string       `json:"chat_kind"`
	SentAt            string       `json:"sent_at,omitempty"` // RFC3339
}

// bridgeContact mirrors the WhatsAppContact dataclass.
type bridgeContact struct {
	WAID        string `json:"wa_id"`
	PhoneNumber string `json:"phone_number,omitempty"`
	Name        string `json:"name,omitempty"`
}

// ingestPayload is the body POSTed to /whatsapp/bridge/ingest.
type ingestPayload struct {
	AccountID string          `json:"account_id"`
	Messages  []bridgeMessage `json:"messages"`
	Contacts  []bridgeContact `json:"contacts,omitempty"`
}

// pairedPayload is the body POSTed to /whatsapp/bridge/paired.
type pairedPayload struct {
	Session     string `json:"session"`
	PhoneNumber string `json:"phone_number"`
	DisplayName string `json:"display_name"`
	JID         string `json:"jid"`
}

func (g *GatewayClient) post(ctx context.Context, path string, body any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, g.baseURL+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if g.secret != "" {
		req.Header.Set("X-Bridge-Secret", g.secret)
	}
	resp, err := g.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("gateway %s -> HTTP %d", path, resp.StatusCode)
	}
	return nil
}

// Ingest streams a normalized message batch for a paired account to the gateway,
// where it flows through the same persist + triage pipeline as a Cloud API number.
func (g *GatewayClient) Ingest(ctx context.Context, p ingestPayload) error {
	return g.post(ctx, "/whatsapp/bridge/ingest", p)
}

// Paired tells the gateway a QR pairing completed and carries the number's identity.
func (g *GatewayClient) Paired(ctx context.Context, p pairedPayload) error {
	return g.post(ctx, "/whatsapp/bridge/paired", p)
}
