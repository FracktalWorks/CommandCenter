"use client";

import Button from "@/components/ui/Button";
import Icon from "@/components/Icon";
import { useState, useCallback, KeyboardEvent } from "react";
import { useTaskStore } from "../lib/taskStore";

// F1 — frictionless capture. Type anything, Enter drops it in the Inbox as a
// LOCAL item. (Clarify happens later, in its own slice.)
export function CaptureBar() {
  const capture = useTaskStore((s) => s.capture);
  const selectView = useTaskStore((s) => s.selectView);
  const [value, setValue] = useState("");

  const submit = useCallback(() => {
    const t = value.trim();
    if (!t) return;
    capture(t);
    setValue("");
    selectView("inbox"); // show the user where it landed
  }, [value, capture, selectView]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2.5">
      <Icon name="Plus" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Capture anything — get it out of your head…"
        className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        aria-label="Capture a new task"
      />
      {value.trim() && (
        <Button size="none" radius="keep" layout="flex items-center" type="button" onClick={submit} className="gap-1 rounded-md px-2 py-1 text-[11px]">
          Add <Icon name="CornerDownLeft" className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
