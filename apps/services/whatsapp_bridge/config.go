package main

import (
	"os"
	"strings"
)

// Config is the bridge's runtime configuration, all from the environment so the
// same binary runs in dev and on the VPS with no code changes.
type Config struct {
	// Addr is the host:port the bridge's own HTTP API listens on. The gateway's
	// BridgeProvider + connect routes talk to this. Default ":8790".
	Addr string
	// GatewayURL is the CommandCenter gateway base URL the bridge posts inbound
	// messages + pairing events to (…/whatsapp/bridge/ingest and …/paired).
	GatewayURL string
	// Secret is the shared secret sent as X-Bridge-Secret in BOTH directions.
	// Empty disables auth (local dev only) — set it in production.
	Secret string
	// StorePath is the sqlite file holding whatsmeow device sessions + our
	// account↔jid and media-reference tables. One file serves every number.
	StorePath string
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// LoadConfig reads the bridge configuration from the environment.
func LoadConfig() Config {
	return Config{
		Addr:       env("WHATSAPP_BRIDGE_ADDR", ":8790"),
		GatewayURL: strings.TrimRight(env("WHATSAPP_BRIDGE_GATEWAY_URL", "http://localhost:8000"), "/"),
		Secret:     env("WHATSAPP_BRIDGE_SECRET", ""),
		StorePath:  env("WHATSAPP_BRIDGE_STORE", "./bridge-store.db"),
	}
}
