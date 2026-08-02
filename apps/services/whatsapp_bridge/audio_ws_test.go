package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/purpshell/meowcaller"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func TestPCMRoundTripPreservesAudio(t *testing.T) {
	// Values the browser actually produces, including the rails.
	in := []float32{0, 0.5, -0.5, 1, -1, 0.25}
	out := pcmToFloat(floatToPCM(in))

	if len(out) != len(in) {
		t.Fatalf("round trip changed length: %d -> %d", len(in), len(out))
	}
	for i := range in {
		// int16 quantisation, so exact equality isn't available.
		if diff := out[i] - in[i]; diff > 0.001 || diff < -0.001 {
			t.Errorf("sample %d: %v -> %v (drift %v)", i, in[i], out[i], diff)
		}
	}
}

func TestFloatToPCMClampsInsteadOfWrapping(t *testing.T) {
	// Un-clamped, +2.0 would wrap to a large negative int16 — a loud click
	// rather than the intended clip.
	for _, v := range []float32{2, -2, 100, -100} {
		got := pcmToFloat(floatToPCM([]float32{v}))[0]
		if got > 1.001 || got < -1.001 {
			t.Errorf("%v clamped to %v, want within ±1", v, got)
		}
		if (v > 0) != (got > 0) {
			t.Errorf("%v flipped sign to %v — that's a wrap, not a clamp", v, got)
		}
	}
}

func TestWSSourceReturnsSilenceWhenStarved(t *testing.T) {
	s := newWSSource()
	f, err := s.ReadFrame()
	if err != nil {
		// EOF here would stop the Player permanently — silence for the rest of
		// the call, which is the bug this guards.
		t.Fatalf("starved source errored: %v", err)
	}
	if len(f) != meowcaller.FrameSamples {
		t.Fatalf("frame length %d, want %d", len(f), meowcaller.FrameSamples)
	}
	for i, v := range f {
		if v != 0 {
			t.Fatalf("sample %d = %v, want silence", i, v)
		}
	}
}

func TestWSSourceSilenceBuffersAreNotShared(t *testing.T) {
	// If the encoder ever mutates the frame it was handed, a shared buffer
	// would stay corrupted for the rest of the call.
	s := newWSSource()
	a, _ := s.ReadFrame()
	a[0] = 0.9
	b, _ := s.ReadFrame()
	if b[0] != 0 {
		t.Fatal("silence buffer is shared between reads")
	}
}

func TestWSSourceDropsOldestWhenTheBrowserRunsAhead(t *testing.T) {
	s := newWSSource()
	for i := 0; i < uplinkBuffer+5; i++ {
		f := make([]float32, meowcaller.FrameSamples)
		f[0] = float32(i)
		s.push(f) // must never block
	}
	got, _ := s.ReadFrame()
	// The oldest frames are gone; what's left must be recent, not frame 0.
	if got[0] == 0 {
		t.Error("kept the oldest frame — the drop should shed stale audio")
	}
}

// The sink is on meowcaller's media path: a listener that stops reading must
// not stall it, or one wedged browser silences the recording too.
func TestCallSinkDoesNotBlockOnASlowListener(t *testing.T) {
	sink := newCallSink(nil)
	_, detach := sink.listen()
	defer detach()

	frame := make([]float32, meowcaller.FrameSamples)
	for i := 0; i < 500; i++ { // far beyond the listener's buffer
		if err := sink.WriteFrame(frame); err != nil {
			t.Fatalf("WriteFrame errored: %v", err)
		}
	}
	if got := sink.seconds(); got < 29 {
		t.Errorf("counted %.1fs of audio, want ~30s — frames were lost", got)
	}
}

func TestCallSinkFansOutToEveryListener(t *testing.T) {
	sink := newCallSink(nil)
	a, detachA := sink.listen()
	b, detachB := sink.listen()
	defer detachA()
	defer detachB()

	frame := make([]float32, meowcaller.FrameSamples)
	frame[0] = 0.42
	_ = sink.WriteFrame(frame)

	for name, ch := range map[string]<-chan []float32{"a": a, "b": b} {
		select {
		case got := <-ch:
			if got[0] != 0.42 {
				t.Errorf("listener %s got %v, want 0.42", name, got[0])
			}
		default:
			t.Errorf("listener %s received nothing", name)
		}
	}
}

func TestCallSinkDetachIsIdempotent(t *testing.T) {
	sink := newCallSink(nil)
	_, detach := sink.listen()
	detach()
	detach() // a double close would panic
	if err := sink.WriteFrame(make([]float32, meowcaller.FrameSamples)); err != nil {
		t.Fatalf("WriteFrame after detach errored: %v", err)
	}
}

func TestCallSinkCloseThenDetachDoesNotPanic(t *testing.T) {
	// Close (call ended) races detach (browser left) in practice.
	sink := newCallSink(nil)
	_, detach := sink.listen()
	_ = sink.Close()
	detach()
}

// ── the HTTP surface ──────────────────────────────────────────────────────────

func newTestServer(t *testing.T, secret string) *Server {
	t.Helper()
	log := waLog.Noop
	return &Server{
		cfg: Config{Secret: secret},
		mgr: &SessionManager{
			sessions: map[string]*Session{},
			calls:    NewCallManager(nil, log, ""),
			log:      log,
		},
		log: log,
	}
}

func TestCallAudioRejectsAnUnknownCall(t *testing.T) {
	s := newTestServer(t, "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/call/audio?session=a&call_id=nope", nil)

	s.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
}

func TestCallAudioRequiresTheSharedSecret(t *testing.T) {
	s := newTestServer(t, "s3cret")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/call/audio?session=a&call_id=x", nil)

	s.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403 — the audio socket must not be open", rec.Code)
	}
}

func TestCallAudioRefusesACallThatHasEnded(t *testing.T) {
	s := newTestServer(t, "")
	lc := &liveCall{callID: "DONE", accountID: "a", phase: callEnded}
	lc.finish("hangup")
	s.mgr.calls.put(lc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/call/audio?session=a&call_id=DONE", nil)
	s.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409", rec.Code)
	}
}
