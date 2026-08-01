/**
 * The email assistant is configured PER ACCOUNT.
 *
 * Everything the mail app stores — rules, knowledge, learned patterns, models,
 * signature, About, standing instructions — is keyed by account_id, and the
 * drafting pipeline loads it by account_id. The chat assistant was the one
 * surface that didn't: it knew which account_id to hand its tools, but nothing
 * about how the user wants THAT mailbox handled, so it conversed identically on
 * a work account and a personal one.
 *
 * These pin the contract that closes that gap: the persona carries the ACTIVE
 * account's configuration, says plainly that it applies to that account only,
 * and degrades safely when the settings haven't loaded.
 */
import { describe, expect, it } from "vitest";

import { buildEmailAssistantPersona } from "./emailAssistantPersona";

const ACCOUNTS = [
  { id: "acc-work", emailAddress: "me@fracktal.in" },
  { id: "acc-personal", emailAddress: "me@gmail.com" },
];

describe("buildEmailAssistantPersona", () => {
  it("names the active account and tells the agent to scope tools to it", () => {
    const p = buildEmailAssistantPersona({
      accounts: ACCOUNTS,
      selectedAccountId: "acc-work",
    });
    expect(p).toContain("acc-work");
    expect(p).toContain("me@fracktal.in");
    expect(p).toMatch(/account-scoped tools/i);
    // Both accounts are still listed, so "check my other inbox" is reachable.
    expect(p).toContain("acc-personal");
  });

  it("carries the active account's standing configuration", () => {
    const p = buildEmailAssistantPersona({
      accounts: ACCOUNTS,
      selectedAccountId: "acc-work",
      settings: {
        about: "I am the CTO of Fracktal Works.",
        personal_instructions: "Never promise delivery dates.",
        writing_style: "Short, direct, no filler.",
        learned_writing_style: "Tends to drop pleasantries.",
      },
    });
    expect(p).toContain("I am the CTO of Fracktal Works.");
    expect(p).toContain("Never promise delivery dates.");
    expect(p).toContain("Short, direct, no filler.");
    expect(p).toContain("Tends to drop pleasantries.");
    // Scoped explicitly — the model must not carry these across a switch.
    expect(p).toMatch(/ACTIVE account only/i);
  });

  it("marks standing instructions as binding and learned style as advisory", () => {
    const p = buildEmailAssistantPersona({
      accounts: ACCOUNTS,
      selectedAccountId: "acc-work",
      settings: {
        personal_instructions: "Always cc finance on invoices.",
        learned_writing_style: "Uses bullet points.",
      },
    });
    expect(p).toMatch(/follow these/i);
    expect(p).toMatch(/advisory/i);
  });

  it("switching the active account switches the configuration", () => {
    const work = buildEmailAssistantPersona({
      accounts: ACCOUNTS,
      selectedAccountId: "acc-work",
      settings: { personal_instructions: "Formal tone with customers." },
    });
    const personal = buildEmailAssistantPersona({
      accounts: ACCOUNTS,
      selectedAccountId: "acc-personal",
      settings: { personal_instructions: "Keep it casual." },
    });
    expect(work).toContain("Formal tone with customers.");
    expect(work).not.toContain("Keep it casual.");
    expect(personal).toContain("Keep it casual.");
    expect(personal).not.toContain("Formal tone with customers.");
  });

  it("degrades to account-awareness when settings aren't loaded", () => {
    const p = buildEmailAssistantPersona({
      accounts: ACCOUNTS,
      selectedAccountId: "acc-work",
      settings: null,
    });
    expect(p).toContain("acc-work");
    expect(p).not.toMatch(/assistant configuration/i);
  });

  it("omits the block when every setting is blank", () => {
    const p = buildEmailAssistantPersona({
      accounts: ACCOUNTS,
      selectedAccountId: "acc-work",
      settings: { about: "", personal_instructions: "   ", writing_style: null },
    });
    expect(p).not.toMatch(/assistant configuration/i);
  });

  it("still points at the open email when one is selected", () => {
    const p = buildEmailAssistantPersona({
      accounts: ACCOUNTS,
      selectedAccountId: "acc-work",
      settings: { about: "CTO." },
      openEmail: {
        id: "msg-1",
        subject: "Quote request",
        from: { name: "Ayush", email: "ayush@x.com" },
      },
    });
    expect(p).toContain("msg-1");
    expect(p).toContain("Quote request");
    expect(p).toContain("CTO.");
  });
});
