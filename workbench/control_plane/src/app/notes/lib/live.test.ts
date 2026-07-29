/**
 * Tests for the live-caption wire parsers.
 *
 * Two providers speak different protocols into one LiveCaption shape, and the
 * downstream relay uses those timings/speakers to build the server-side roster.
 * A silent parse regression would look like "live just stopped working", so the
 * message shapes are pinned here.
 */
import { describe, expect, it } from "vitest";
import { parseAssemblyAI, parseDeepgram, speakerIndex } from "./live";

describe("AssemblyAI v3 Turn messages", () => {
  it("marks end_of_turn as final and converts ms offsets to seconds", () => {
    const c = parseAssemblyAI({
      type: "Turn",
      transcript: "Hi, I'm Priya",
      end_of_turn: true,
      words: [
        { start: 500, end: 800, speaker: "A" },
        { start: 800, end: 1500, speaker: "A" },
      ],
    });
    expect(c).toEqual({
      text: "Hi, I'm Priya",
      isFinal: true,
      speaker: 0,
      startS: 0.5,
      endS: 1.5,
    });
  });

  it("treats an in-progress turn as interim", () => {
    expect(parseAssemblyAI({ type: "Turn", transcript: "Hi", end_of_turn: false }))
      .toMatchObject({ isFinal: false, text: "Hi" });
  });

  it("ignores non-Turn frames and empty transcripts", () => {
    expect(parseAssemblyAI({ type: "Begin" })).toBeNull();
    expect(parseAssemblyAI({ type: "Termination" })).toBeNull();
    expect(parseAssemblyAI({ type: "Turn", transcript: "   " })).toBeNull();
  });

  it("survives a turn with no words array", () => {
    expect(parseAssemblyAI({ type: "Turn", transcript: "ok", end_of_turn: true }))
      .toEqual({ text: "ok", isFinal: true, speaker: null, startS: 0, endS: 0 });
  });
});

describe("Deepgram messages", () => {
  it("reads the transcript, speaker and timings", () => {
    const c = parseDeepgram({
      is_final: true,
      start: 2,
      duration: 1.5,
      channel: { alternatives: [{ transcript: "Good to meet you", words: [{ speaker: 1 }] }] },
    });
    expect(c).toEqual({
      text: "Good to meet you",
      isFinal: true,
      speaker: 1,
      startS: 2,
      endS: 3.5,
    });
  });

  it("ignores keepalive/metadata frames", () => {
    expect(parseDeepgram({})).toBeNull();
    expect(parseDeepgram({ channel: { alternatives: [{ transcript: "" }] } })).toBeNull();
  });
});

describe("speakerIndex", () => {
  it("normalises both providers onto a 0-based index", () => {
    // Deepgram emits ints, AssemblyAI letters — both must land on the same axis
    // so the S1/S2 label space stays provider-agnostic.
    expect(speakerIndex(0)).toBe(0);
    expect(speakerIndex("A")).toBe(0);
    expect(speakerIndex("C")).toBe(2);
    expect(speakerIndex("2")).toBe(2);
  });

  it("returns null when the provider said nothing usable", () => {
    expect(speakerIndex(undefined)).toBeNull();
    expect(speakerIndex(null)).toBeNull();
    expect(speakerIndex("speaker one")).toBeNull();
  });
});

describe("AssemblyAI streaming diarization", () => {
  it("reads a turn-level speaker", () => {
    const c = parseAssemblyAI({
      type: "Turn",
      transcript: "so the pricing works",
      end_of_turn: true,
      speaker: "B",
      words: [{ start: 0, end: 500 }],
    });
    expect(c?.speaker).toBe(1); // "B" → index 1
  });

  it("falls back to a word-level speaker when the turn has none", () => {
    // Which field carries the label varies by streaming model; reading only
    // one would present as "diarization is broken".
    const c = parseAssemblyAI({
      type: "Turn",
      transcript: "hello",
      end_of_turn: true,
      words: [{ start: 0, end: 500, speaker: "A" }],
    });
    expect(c?.speaker).toBe(0);
  });

  it("skips leading words that carry no speaker", () => {
    const c = parseAssemblyAI({
      type: "Turn",
      transcript: "hello",
      end_of_turn: true,
      words: [{ start: 0, end: 100 }, { start: 100, end: 200, speaker: "C" }],
    });
    expect(c?.speaker).toBe(2);
  });

  it("reports null rather than a wrong speaker when undiarized", () => {
    const c = parseAssemblyAI({
      type: "Turn",
      transcript: "hello",
      end_of_turn: true,
      words: [{ start: 0, end: 500 }],
    });
    expect(c?.speaker).toBeNull();
  });
});
