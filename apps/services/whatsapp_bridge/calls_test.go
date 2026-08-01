package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// testLog satisfies logf without printing during tests.
type testLog struct{ t *testing.T }

func (l testLog) Warnf(msg string, args ...any)  { l.t.Logf("WARN "+msg, args...) }
func (l testLog) Errorf(msg string, args ...any) { l.t.Logf("ERROR "+msg, args...) }
func (l testLog) Infof(msg string, args ...any)  { l.t.Logf("INFO "+msg, args...) }

// writeAged creates a file and backdates its mtime by the given age.
func writeAged(t *testing.T, dir, name string, age time.Duration) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("riff"), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
	return path
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestSweepRecordingsRemovesOnlyExpiredWAVs(t *testing.T) {
	dir := t.TempDir()
	cm := NewCallManager(nil, testLog{t}, dir)

	old := writeAged(t, dir, "OLDCALL.wav", 10*24*time.Hour)
	fresh := writeAged(t, dir, "NEWCALL.wav", 1*time.Hour)
	// A non-WAV in the same directory must survive: the path is operator
	// configurable and could point somewhere shared.
	other := writeAged(t, dir, "notes.txt", 30*24*time.Hour)

	if got := cm.sweepRecordings(7); got != 1 {
		t.Fatalf("removed %d files, want 1", got)
	}
	if exists(old) {
		t.Error("expired recording survived the sweep")
	}
	if !exists(fresh) {
		t.Error("recent recording was deleted")
	}
	if !exists(other) {
		t.Error("a non-.wav file was deleted")
	}
}

func TestSweepRecordingsZeroRetentionKeepsEverything(t *testing.T) {
	dir := t.TempDir()
	cm := NewCallManager(nil, testLog{t}, dir)
	old := writeAged(t, dir, "ANCIENT.wav", 365*24*time.Hour)

	if got := cm.sweepRecordings(0); got != 0 {
		t.Fatalf("removed %d files with retention disabled, want 0", got)
	}
	if !exists(old) {
		t.Error("retention 0 must mean keep forever")
	}
}

func TestSweepRecordingsToleratesMissingDir(t *testing.T) {
	cm := NewCallManager(nil, testLog{t}, filepath.Join(t.TempDir(), "not-created-yet"))
	if got := cm.sweepRecordings(7); got != 0 {
		t.Fatalf("removed %d from a missing dir, want 0", got)
	}
}

func TestSweepRecordingsNoopWhenRecordingDisabled(t *testing.T) {
	cm := NewCallManager(nil, testLog{t}, "")
	if got := cm.sweepRecordings(7); got != 0 {
		t.Fatalf("removed %d with recording disabled, want 0", got)
	}
}

// reap drops ended calls past their TTL but must never drop a live one.
func TestReapKeepsLiveCalls(t *testing.T) {
	cm := NewCallManager(nil, testLog{t}, "")
	live := &liveCall{callID: "LIVE", accountID: "a", phase: callActive}
	recent := &liveCall{callID: "RECENT", accountID: "a", phase: callEnded, endedAt: time.Now()}
	stale := &liveCall{
		callID: "STALE", accountID: "a", phase: callEnded,
		endedAt: time.Now().Add(-2 * time.Hour),
	}
	for _, c := range []*liveCall{live, recent, stale} {
		cm.put(c)
	}

	if got := cm.reap(time.Hour); got != 1 {
		t.Fatalf("reaped %d calls, want 1", got)
	}
	if _, ok := cm.get("LIVE"); !ok {
		t.Error("an in-progress call was reaped")
	}
	if _, ok := cm.get("RECENT"); !ok {
		t.Error("a recently ended call was reaped too early")
	}
	if _, ok := cm.get("STALE"); ok {
		t.Error("a long-ended call survived the reaper")
	}
}

func TestListFiltersByAccount(t *testing.T) {
	cm := NewCallManager(nil, testLog{t}, "")
	cm.put(&liveCall{callID: "A", accountID: "acct-1", phase: callActive})
	cm.put(&liveCall{callID: "B", accountID: "acct-2", phase: callActive})

	if got := cm.list("acct-1"); len(got) != 1 || got[0].CallID != "A" {
		t.Fatalf("list(acct-1) = %+v, want just A", got)
	}
	if got := cm.list(""); len(got) != 2 {
		t.Fatalf("list(all) returned %d calls, want 2", len(got))
	}
}

// finish must be idempotent: OnEnd can race an explicit Hangup, and closing a
// WAV recorder twice would otherwise corrupt the finalized header.
func TestFinishIsIdempotent(t *testing.T) {
	closes := 0
	lc := &liveCall{callID: "X", sink: sinkFunc(func() error { closes++; return nil })}

	lc.finish("hangup")
	lc.finish("timeout")

	if closes != 1 {
		t.Fatalf("sink closed %d times, want exactly 1", closes)
	}
	if lc.phase != callEnded {
		t.Errorf("phase = %q, want %q", lc.phase, callEnded)
	}
	// The first reason wins — it's the one that actually ended the call.
	if lc.endReason != "hangup" {
		t.Errorf("endReason = %q, want %q", lc.endReason, "hangup")
	}
}

// sinkFunc is a meowcaller.AudioSink whose Close is observable.
type sinkFunc func() error

func (f sinkFunc) WriteFrame(_ []float32) error { return nil }
func (f sinkFunc) Close() error                 { return f() }
