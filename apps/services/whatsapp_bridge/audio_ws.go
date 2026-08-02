package main

// Duplex call audio over a WebSocket — the browser's microphone and speakers.
//
// The mic lives in a browser and the WhatsApp session lives here, so real-time
// audio has to cross a process boundary in both directions. This is that pipe:
//
//	browser mic  ──► WS ──► wsSource ──► Player ──► MLow ──► SRTP ──► peer
//	browser spkr ◄── WS ◄── callSink listener ◄── decoded peer frames
//
// The wire format is deliberately dumb: raw little-endian int16 mono at 16 kHz,
// one 960-sample (60 ms) frame per binary message — exactly meowcaller's native
// framing, so neither end resamples or reframes. Getting that wrong is the
// classic source of audio that sounds fine for a second and then drifts.

import (
	"context"
	"encoding/binary"
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/purpshell/meowcaller"
)

// uplinkBuffer is how many mic frames we hold before dropping the oldest —
// ~600 ms. Deep enough to ride out a scheduling hiccup, shallow enough that
// recovering from a stall doesn't leave the peer hearing a delayed monologue.
const uplinkBuffer = 10

// wsSource feeds browser microphone frames into the call.
//
// It never returns io.EOF: the Player stops on EOF, and a stopped Player means
// the send loop falls back to silence permanently. A starved source returns
// silence for that frame instead, so a momentary gap is a momentary gap.
type wsSource struct {
	frames  chan []float32
	silence []float32
}

func newWSSource() *wsSource {
	return &wsSource{
		frames:  make(chan []float32, uplinkBuffer),
		silence: make([]float32, meowcaller.FrameSamples),
	}
}

func (s *wsSource) ReadFrame() ([]float32, error) {
	select {
	case f := <-s.frames:
		return f, nil
	default:
		return s.silence, nil
	}
}

func (s *wsSource) Close() error { return nil }

// push adds a mic frame, dropping the oldest if the browser is running ahead of
// the 60 ms send cadence. Dropping beats blocking: the WS reader must keep
// draining or the whole socket backs up.
func (s *wsSource) push(frame []float32) {
	select {
	case s.frames <- frame:
	default:
		select {
		case <-s.frames:
		default:
		}
		select {
		case s.frames <- frame:
		default:
		}
	}
}

func pcmToFloat(b []byte) []float32 {
	out := make([]float32, len(b)/2)
	for i := range out {
		out[i] = float32(int16(binary.LittleEndian.Uint16(b[i*2:]))) / 32768.0
	}
	return out
}

func floatToPCM(f []float32) []byte {
	out := make([]byte, len(f)*2)
	for i, v := range f {
		// Clamp before scaling: a value past ±1 would wrap and click loudly.
		if v > 1 {
			v = 1
		} else if v < -1 {
			v = -1
		}
		binary.LittleEndian.PutUint16(out[i*2:], uint16(int16(v*32767)))
	}
	return out
}

// handleCallAudio upgrades to a WebSocket and runs duplex audio for one call.
//
// Attaching the Player here rather than at call setup is deliberate: a call
// with no browser attached should send silence (which holds the relay bridge),
// not block waiting for a microphone that may never arrive.
func (s *Server) handleCallAudio(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	session, callID := q.Get("session"), q.Get("call_id")
	lc, ok := s.mgr.calls.get(callID)
	if !ok || (session != "" && lc.accountID != session) {
		http.Error(w, ErrCallNotFound.Error(), http.StatusNotFound)
		return
	}
	lc.mu.RLock()
	sink, call, ended := lc.counter, lc.call, !lc.endedAt.IsZero()
	lc.mu.RUnlock()
	if ended || call == nil || sink == nil {
		http.Error(w, "call is not live", http.StatusConflict)
		return
	}

	// The gateway proxies this hop, so Origin is not a browser origin we can
	// meaningfully check; the shared secret on the request is the real gate.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		s.log.Warnf("call %s: audio websocket accept: %v", callID, err)
		return
	}
	defer func() { _ = conn.CloseNow() }()
	// A long call is a long socket; the deadline lives on each read/write.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	src := newWSSource()
	player := meowcaller.NewPlayer()
	call.Subscribe(player)
	player.Play(src)
	defer player.Stop()

	frames, detach := sink.listen()
	defer detach()

	s.log.Infof("call %s: browser audio attached", callID)
	defer s.log.Infof("call %s: browser audio detached", callID)

	// Uplink: browser mic → call. Runs in its own goroutine; when it returns
	// (socket closed) it cancels the downlink too.
	go func() {
		defer cancel()
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					s.log.Infof("call %s: audio uplink closed: %v", callID, err)
				}
				return
			}
			if typ != websocket.MessageBinary || len(data) < 2 {
				continue // control/text chatter, or a runt frame
			}
			src.push(pcmToFloat(data))
		}
	}()

	// Downlink: peer audio → browser speakers.
	for {
		select {
		case <-ctx.Done():
			return
		case frame, open := <-frames:
			if !open {
				return // call ended and the sink closed
			}
			wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Write(wctx, websocket.MessageBinary, floatToPCM(frame))
			wcancel()
			if err != nil {
				s.log.Infof("call %s: audio downlink closed: %v", callID, err)
				return
			}
		}
	}
}
