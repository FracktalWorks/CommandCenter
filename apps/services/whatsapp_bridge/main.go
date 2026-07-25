// Command whatsapp_bridge is CommandCenter's unofficial WhatsApp transport: it
// pairs a PERSONAL number by QR (via the whatsmeow multi-device library), holds
// the session locally, and streams normalized messages to the gateway's
// /whatsapp/bridge/ingest endpoint — where they flow through the exact same
// store + AI triage brain as an official Cloud API number.
//
// It exposes a tiny HTTP API the gateway calls (all guarded by a shared secret):
//
//	POST /session          {session}                       -> {status, qr}
//	GET  /session/{id}                                      -> {status, qr}
//	POST /send             {session,to,body,reply_to}       -> {id}
//	POST /media            {session,media_id}               -> raw bytes
//	POST /read             {session,message_id,chat,sender} -> {ok}
//	GET  /health                                            -> {ok}
//
// It holds NO gateway credentials and never talks to Meta's Graph API. NOTE:
// using an unofficial multi-device client for a personal number is outside
// WhatsApp's Terms of Service and can get the number banned — this is for
// managing a personal line at the operator's own risk, not a business number.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func main() {
	cfg := LoadConfig()
	logger := waLog.Stdout("bridge", "INFO", true)
	ctx := context.Background()

	store.DeviceProps.Os = strPtr("CommandCenter")

	container, err := sqlstore.New(
		ctx, "sqlite",
		"file:"+cfg.StorePath+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)",
		logger.Sub("db"))
	if err != nil {
		logger.Errorf("open whatsmeow store: %v", err)
		os.Exit(1)
	}

	meta, err := OpenMetaStore(ctx, cfg.StorePath+".meta")
	if err != nil {
		logger.Errorf("open meta store: %v", err)
		os.Exit(1)
	}
	defer meta.Close()

	gw := NewGatewayClient(cfg.GatewayURL, cfg.Secret)
	mgr := NewSessionManager(container, meta, gw, logger)
	mgr.RestoreSessions(ctx)

	srv := &Server{cfg: cfg, mgr: mgr, log: logger}
	httpSrv := &http.Server{Addr: cfg.Addr, Handler: srv.routes(), ReadHeaderTimeout: 10 * time.Second}

	go func() {
		logger.Infof("bridge listening on %s -> gateway %s", cfg.Addr, cfg.GatewayURL)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Errorf("http server: %v", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	logger.Infof("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutCtx)
}

// Server holds the HTTP handlers' shared dependencies.
type Server struct {
	cfg Config
	mgr *SessionManager
	log waLog.Logger
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /session", s.auth(s.handleStartSession))
	mux.HandleFunc("GET /session/{id}", s.auth(s.handleSessionStatus))
	mux.HandleFunc("POST /send", s.auth(s.handleSend))
	mux.HandleFunc("POST /media", s.auth(s.handleMedia))
	mux.HandleFunc("POST /read", s.auth(s.handleRead))
	return mux
}

// auth wraps a handler with the constant-time shared-secret check. An unset
// secret allows everything (local dev).
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.Secret != "" {
			got := r.Header.Get("X-Bridge-Secret")
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Secret)) != 1 {
				http.Error(w, "bad secret", http.StatusForbidden)
				return
			}
		}
		next(w, r)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleStartSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Session string `json:"session"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Session == "" {
		http.Error(w, "session required", http.StatusBadRequest)
		return
	}
	qr, err := s.mgr.StartSession(r.Context(), body.Session)
	if err != nil {
		s.log.Errorf("start session %s: %v", body.Session, err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	status, _ := s.mgr.Status(body.Session)
	writeJSON(w, http.StatusOK, map[string]any{"session": body.Session, "status": status, "qr": qr})
}

func (s *Server) handleSessionStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	status, qr := s.mgr.Status(id)
	writeJSON(w, http.StatusOK, map[string]any{"session": id, "status": status, "qr": qr})
}

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Session string `json:"session"`
		To      string `json:"to"`
		Body    string `json:"body"`
		ReplyTo string `json:"reply_to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	id, err := s.mgr.Send(r.Context(), body.Session, body.To, body.Body, body.ReplyTo)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (s *Server) handleMedia(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Session string `json:"session"`
		MediaID string `json:"media_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	data, mime, err := s.mgr.DownloadMedia(r.Context(), body.Session, body.MediaID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Session   string `json:"session"`
		MessageID string `json:"message_id"`
		Chat      string `json:"chat"`
		Sender    string `json:"sender"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.Chat != "" && body.Sender != "" {
		s.mgr.MarkRead(r.Context(), body.Session, body.Chat, body.Sender, body.MessageID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func strPtr(s string) *string { return &s }
