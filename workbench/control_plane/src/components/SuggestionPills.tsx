"use client";

/**
 * SuggestionPills — starter prompt suggestions shown in the empty state
 * and after each assistant response (CopilotKit-style).
 *
 * Usage:
 *   <SuggestionPills suggestions={["Write a sonnet", "Summarize sales"]} onPick={handleChoice} />
 */

interface SuggestionPillsProps {
  suggestions: string[];
  onPick: (suggestion: string) => void;
  /** Show a header label above the pills (default: "Suggestions") */
  label?: string;
}

export default function SuggestionPills({
  suggestions,
  onPick,
  label = "Try asking",
}: SuggestionPillsProps) {
  if (!suggestions.length) return null;

  return (
    <div className="mt-4">
      <div className="text-[10px] text-zinc-500 mb-2">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => onPick(s)}
            className="text-[11px] sm:text-xs px-3 py-1.5 rounded-full border border-zinc-700/60 bg-zinc-800/50 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-700/50 hover:text-zinc-100 transition-colors text-left"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
