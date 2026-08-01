package main

// WhatsApp voice calls over the personal (whatsmeow) session.
//
// whatsmeow itself carries call SIGNALLING only — it can tell you a call is
// offered and that it ended, but it has no media stack, so it can neither
// place a call that carries audio nor hear one. meowcaller supplies the missing
// half (MLow codec, SRTP, RTP, relay) in pure Go on top of the same session, so
// a paired number can place and answer calls the way WhatsApp Desktop does.
//
// This is the media seam the note taker needs: Call.Receive hands us decoded
// 16 kHz mono PCM, which is exactly what acb_stt transcribes. For now we record
// it to a WAV per call — proof the media path is live, and the raw material the
// transcription pipeline will consume next.
//
// > The ToS warning on this whole service applies doubly here. Placing
// > automated calls from an unofficial client is a fast way to get a number
// > banned. Use a number you are willing to lose.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/purpshell/meowcaller"
)

// placeTimeout bounds how long we wait for WhatsApp to accept a call offer.
// It must stay under the gateway's own budget (20s) so a wedged offer surfaces
// as a real error there instead of tripping the workbench proxy's abort, which
// would tell the user only "gateway unreachable".
const placeTimeout = 12 * time.Second

// ErrCallNotFound is returned for an unknown (or already reaped) call id.
var ErrCallNotFound = errors.New("call not found")

// ErrPlaceTimeout means WhatsApp never acknowledged the call offer in time.
var ErrPlaceTimeout = errors.New(
	"WhatsApp did not accept the call offer in time — the session may be " +
		"connected but unhealthy; check the bridge log and re-pair if it persists")

// ErrNoCaller means the account has no calling stack — the session predates
// pairing, or meowcaller failed to attach.
var ErrNoCaller = errors.New("calling not available for this account")

// Lifecycle phases as reported to the gateway. These mirror meowcaller's
// CallPhase, kept as strings so the wire contract doesn't depend on the
// library's iota ordering.
const (
	callIdle        = "idle"
	callCalling     = "calling"
	callRinging     = "ringing"
	callConnecting  = "connecting"
	callActive      = "active"
	callEnded       = "ended"
	callWaitingRoom = "waiting_room"
)

func phaseName(p meowcaller.CallPhase) string {
	switch p {
	case meowcaller.CallPhaseIdle:
		return callIdle
	case meowcaller.CallPhaseCalling:
		return callCalling
	case meowcaller.CallPhaseRinging:
		return callRinging
	case meowcaller.CallPhaseConnecting:
		return callConnecting
	case meowcaller.CallPhaseActive:
		return callActive
	case meowcaller.CallPhaseEnded:
		return callEnded
	case meowcaller.CallPhaseWaitingRoom:
		return callWaitingRoom
	}
	return "unknown"
}

// callInfo is the JSON snapshot handed to the gateway (and through it, the UI).
type callInfo struct {
	CallID    string   `json:"call_id"`
	AccountID string   `json:"account_id"`
	Peer      string   `json:"peer"`
	Direction string   `json:"direction"` // outgoing | incoming
	Kind      string   `json:"kind"`      // direct | group
	Phase     string   `json:"phase"`
	Targets   []string `json:"targets,omitempty"`
	StartedAt string   `json:"started_at,omitempty"`
	EndedAt   string   `json:"ended_at,omitempty"`
	EndReason string   `json:"end_reason,omitempty"`
	Recording string   `json:"recording,omitempty"` // server-side WAV path
}

// liveCall is one call plus the bookkeeping the HTTP surface reports on. The
// mutex guards every mutable field: meowcaller fires its callbacks from its own
// goroutines while HTTP handlers read concurrently.
type liveCall struct {
	mu sync.RWMutex

	call      *meowcaller.Call
	accountID string
	callID    string
	peer      string
	direction string
	kind      string
	targets   []string

	phase     string
	startedAt time.Time
	endedAt   time.Time
	endReason string

	recording string
	sink      meowcaller.AudioSink
	closeOnce sync.Once
}

func (lc *liveCall) snapshot() callInfo {
	lc.mu.RLock()
	defer lc.mu.RUnlock()
	info := callInfo{
		CallID: lc.callID, AccountID: lc.accountID, Peer: lc.peer,
		Direction: lc.direction, Kind: lc.kind, Phase: lc.phase,
		Targets: lc.targets, EndReason: lc.endReason, Recording: lc.recording,
	}
	if !lc.startedAt.IsZero() {
		info.StartedAt = lc.startedAt.UTC().Format(time.RFC3339)
	}
	if !lc.endedAt.IsZero() {
		info.EndedAt = lc.endedAt.UTC().Format(time.RFC3339)
	}
	return info
}

func (lc *liveCall) setPhase(phase string) {
	lc.mu.Lock()
	lc.phase = phase
	lc.mu.Unlock()
}

// finish records the terminal state and closes the recorder exactly once.
//
// Idempotent by necessity: meowcaller's OnEnd routinely races an explicit
// Hangup, so this runs twice for most calls. The FIRST reason and timestamp
// win — a later overwrite would push endedAt forward and stretch the call's
// apparent duration — and the recorder closes once, because finalizing a WAV
// header twice leaves the file unreadable.
func (lc *liveCall) finish(reason string) {
	lc.mu.Lock()
	if lc.endedAt.IsZero() {
		lc.endedAt = time.Now()
		lc.endReason = reason
	}
	lc.phase = callEnded
	sink := lc.sink
	lc.mu.Unlock()

	lc.closeOnce.Do(func() {
		if sink != nil {
			// Best effort: a failed WAV flush costs us the recording, but it
			// must not stop the call from being marked ended.
			_ = sink.Close()
		}
	})
}

// CallManager owns every live call across accounts and reports transitions to
// the gateway. Call ids are 32 hex chars from WhatsApp, unique across accounts,
// so one flat map is enough.
type CallManager struct {
	gw        *GatewayClient
	log       logf
	recordDir string

	mu    sync.RWMutex
	calls map[string]*liveCall
}

// logf is the slice of waLog.Logger this file needs, named so calls.go doesn't
// depend on the logging package directly.
type logf interface {
	Warnf(msg string, args ...any)
	Errorf(msg string, args ...any)
	Infof(msg string, args ...any)
}

// NewCallManager builds the registry. recordDir may be empty to disable
// recording (calls still work; nothing is written to disk).
func NewCallManager(gw *GatewayClient, log logf, recordDir string) *CallManager {
	return &CallManager{gw: gw, log: log, recordDir: recordDir, calls: map[string]*liveCall{}}
}

func (cm *CallManager) put(lc *liveCall) {
	cm.mu.Lock()
	cm.calls[lc.callID] = lc
	cm.mu.Unlock()
}

func (cm *CallManager) get(callID string) (*liveCall, bool) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	lc, ok := cm.calls[callID]
	return lc, ok
}

// list returns snapshots for one account, or every account when accountID is
// empty. Ended calls are included — a UI that polls needs to see the terminal
// state at least once.
func (cm *CallManager) list(accountID string) []callInfo {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	out := make([]callInfo, 0, len(cm.calls))
	for _, lc := range cm.calls {
		if accountID != "" && lc.accountID != accountID {
			continue
		}
		out = append(out, lc.snapshot())
	}
	return out
}

// reap drops calls that ended more than ttl ago, so a long-lived bridge doesn't
// accumulate every call it ever placed.
func (cm *CallManager) reap(ttl time.Duration) int {
	cutoff := time.Now().Add(-ttl)
	cm.mu.Lock()
	defer cm.mu.Unlock()
	n := 0
	for id, lc := range cm.calls {
		lc.mu.RLock()
		ended := lc.endedAt
		lc.mu.RUnlock()
		if !ended.IsZero() && ended.Before(cutoff) {
			delete(cm.calls, id)
			n++
		}
	}
	return n
}

// sweepRecordings deletes recorded audio older than retentionDays. Recording
// runs at roughly 115 MB per hour of call, so on a VPS an unbounded directory
// is a slow outage rather than a tidiness problem. Zero days disables it.
// Returns the number of files removed.
func (cm *CallManager) sweepRecordings(retentionDays uint32) int {
	if cm.recordDir == "" || retentionDays == 0 {
		return 0
	}
	cutoff := time.Now().AddDate(0, 0, -int(retentionDays))
	entries, err := os.ReadDir(cm.recordDir)
	if err != nil {
		if !os.IsNotExist(err) { // not yet created is normal, not worth logging
			cm.log.Warnf("sweep recordings: %v", err)
		}
		return 0
	}

	// Only ever delete files this service writes (<call-id>.wav) — the
	// directory is operator-configurable and could point somewhere shared.
	removed := 0
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".wav" {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.ModTime().Before(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(cm.recordDir, e.Name())); err != nil {
			cm.log.Warnf("remove old recording %s: %v", e.Name(), err)
			continue
		}
		removed++
	}
	if removed > 0 {
		cm.log.Infof("swept %d call recording(s) older than %d days", removed, retentionDays)
	}
	return removed
}

// recordingPath allocates the WAV path for a call, creating the directory. An
// empty return means recording is off (or the directory is unusable) — never a
// reason to fail the call itself.
func (cm *CallManager) recordingPath(callID string) string {
	if cm.recordDir == "" {
		return ""
	}
	if err := os.MkdirAll(cm.recordDir, 0o750); err != nil {
		cm.log.Warnf("call recording dir %s: %v", cm.recordDir, err)
		return ""
	}
	return filepath.Join(cm.recordDir, callID+".wav")
}

// track wires our bookkeeping and the recorder onto a live meowcaller Call and
// registers it. Shared by the outbound and inbound paths.
func (cm *CallManager) track(lc *liveCall) {
	c := lc.call
	lc.callID = c.ID()
	if lc.peer == "" {
		lc.peer = c.Peer().String()
	}
	lc.phase = phaseName(c.State())
	lc.startedAt = time.Now()

	if path := cm.recordingPath(lc.callID); path != "" {
		sink, err := meowcaller.WAVRecorder(path)
		if err != nil {
			cm.log.Warnf("call %s: recorder: %v", lc.callID, err)
		} else {
			lc.sink = sink
			lc.recording = path
			c.Receive(sink)
		}
	}

	c.OnStateChange(func(p meowcaller.CallPhase) {
		lc.setPhase(phaseName(p))
		cm.push(lc)
	})
	c.OnReady(func() {
		cm.log.Infof("call %s: media active", lc.callID)
		cm.push(lc)
	})
	c.OnEnd(func(reason string) {
		cm.log.Infof("call %s: ended (%s)", lc.callID, reason)
		lc.finish(reason)
		cm.push(lc)
	})
	if lc.kind == "group" {
		c.OnGroupState(func(st meowcaller.GroupCallState) {
			names := make([]string, 0, len(st.Participants))
			for _, p := range st.Participants {
				names = append(names, p.JID.String())
			}
			lc.mu.Lock()
			lc.targets = names
			lc.mu.Unlock()
			cm.push(lc)
		})
	}

	cm.put(lc)
	cm.push(lc)
}

// push reports the current snapshot to the gateway, best-effort: a call must
// not drop because the gateway is down.
func (cm *CallManager) push(lc *liveCall) {
	if cm.gw == nil {
		return
	}
	info := lc.snapshot()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := cm.gw.CallEvent(ctx, info); err != nil {
			cm.log.Warnf("call %s: notify gateway: %v", info.CallID, err)
		}
	}()
}

// ── SessionManager surface (what the HTTP handlers call) ──────────────────────

// PlaceCall dials a 1:1 voice call from a paired account. target is a phone
// number, a phone JID, or an @lid JID.
func (m *SessionManager) PlaceCall(ctx context.Context, accountID, target string) (callInfo, error) {
	s, ok := m.get(accountID)
	if !ok || !s.client.IsLoggedIn() {
		return callInfo{}, ErrNotConnected
	}
	if s.caller == nil {
		return callInfo{}, ErrNoCaller
	}
	if target == "" {
		return callInfo{}, fmt.Errorf("target required")
	}

	ctx, cancel := context.WithTimeout(ctx, placeTimeout)
	defer cancel()
	c, err := s.caller.Call(ctx, target)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return callInfo{}, ErrPlaceTimeout
		}
		return callInfo{}, fmt.Errorf("place call: %w", err)
	}
	lc := &liveCall{
		call: c, accountID: accountID, peer: target,
		direction: "outgoing", kind: "direct",
	}
	m.calls.track(lc)
	return lc.snapshot(), nil
}

// PlaceGroupCall dials a group call. Pass groupID to ring every remote member
// of a WhatsApp group, or targets for an ad-hoc group call (two or more).
func (m *SessionManager) PlaceGroupCall(
	ctx context.Context, accountID, groupID string, targets []string,
) (callInfo, error) {
	s, ok := m.get(accountID)
	if !ok || !s.client.IsLoggedIn() {
		return callInfo{}, ErrNotConnected
	}
	if s.caller == nil {
		return callInfo{}, ErrNoCaller
	}

	var (
		c   *meowcaller.Call
		err error
	)
	ctx, cancel := context.WithTimeout(ctx, placeTimeout)
	defer cancel()
	switch {
	case groupID != "":
		c, err = s.caller.GroupCallByID(ctx, groupID)
	case len(targets) >= 2:
		c, err = s.caller.GroupCall(ctx, targets...)
	default:
		return callInfo{}, fmt.Errorf("group_id, or at least two targets, required")
	}
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return callInfo{}, ErrPlaceTimeout
		}
		return callInfo{}, fmt.Errorf("place group call: %w", err)
	}

	lc := &liveCall{
		call: c, accountID: accountID, peer: groupID,
		direction: "outgoing", kind: "group", targets: targets,
	}
	m.calls.track(lc)
	return lc.snapshot(), nil
}

// Hangup ends a call we placed or answered.
func (m *SessionManager) Hangup(accountID, callID string) (callInfo, error) {
	lc, ok := m.calls.get(callID)
	if !ok || (accountID != "" && lc.accountID != accountID) {
		return callInfo{}, ErrCallNotFound
	}
	if err := lc.call.Hangup(); err != nil {
		return lc.snapshot(), fmt.Errorf("hangup: %w", err)
	}
	lc.finish("hangup")
	m.calls.push(lc)
	return lc.snapshot(), nil
}

// Answer accepts a ringing inbound call.
func (m *SessionManager) Answer(accountID, callID string) (callInfo, error) {
	lc, ok := m.calls.get(callID)
	if !ok || (accountID != "" && lc.accountID != accountID) {
		return callInfo{}, ErrCallNotFound
	}
	if err := lc.call.Answer(); err != nil {
		return lc.snapshot(), fmt.Errorf("answer: %w", err)
	}
	return lc.snapshot(), nil
}

// Reject declines a ringing inbound call.
func (m *SessionManager) Reject(accountID, callID string) (callInfo, error) {
	lc, ok := m.calls.get(callID)
	if !ok || (accountID != "" && lc.accountID != accountID) {
		return callInfo{}, ErrCallNotFound
	}
	if err := lc.call.Reject(); err != nil {
		return lc.snapshot(), fmt.Errorf("reject: %w", err)
	}
	lc.finish("rejected")
	m.calls.push(lc)
	return lc.snapshot(), nil
}

// ListCalls returns every tracked call for an account (all accounts if empty).
func (m *SessionManager) ListCalls(accountID string) []callInfo {
	return m.calls.list(accountID)
}

// registerCallHandlers attaches the inbound listener for one session. Inbound
// calls are NEVER auto-answered — they are surfaced as ringing so the operator
// (or the gateway) decides. Auto-answering would make the number a bot that
// picks up strangers, which is both a consent problem and a ban risk.
func (m *SessionManager) registerCallHandlers(s *Session) {
	if s.caller == nil {
		return
	}
	s.caller.OnIncomingCall(func(c *meowcaller.Call) {
		lc := &liveCall{
			call: c, accountID: s.accountID, peer: c.Peer().String(),
			direction: "incoming", kind: "direct",
		}
		m.calls.track(lc)
	})
}
