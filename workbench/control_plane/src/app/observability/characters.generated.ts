// AUTO-GENERATED - Pixel Lab character-creator cast (v3, 8 directions).
// Sprites live as static assets under public/characters/<agent>/<dir>.png.
// Regenerate/extend via scripts/characters (Pixel Lab MCP). Do not hand-edit.

export const CHARACTER_DIRECTIONS = [
  "south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west",
] as const;
export type Direction = (typeof CHARACTER_DIRECTIONS)[number];

export const CHARACTERS: Record<string, Record<Direction, string>> = {
  "orchestrator": { "south": "/characters/orchestrator/south.png", "south-east": "/characters/orchestrator/south-east.png", "east": "/characters/orchestrator/east.png", "north-east": "/characters/orchestrator/north-east.png", "north": "/characters/orchestrator/north.png", "north-west": "/characters/orchestrator/north-west.png", "west": "/characters/orchestrator/west.png", "south-west": "/characters/orchestrator/south-west.png" },
  "apis-config": { "south": "/characters/apis-config/south.png", "south-east": "/characters/apis-config/south-east.png", "east": "/characters/apis-config/east.png", "north-east": "/characters/apis-config/north-east.png", "north": "/characters/apis-config/north.png", "north-west": "/characters/apis-config/north-west.png", "west": "/characters/apis-config/west.png", "south-west": "/characters/apis-config/south-west.png" },
  "sales": { "south": "/characters/sales/south.png", "south-east": "/characters/sales/south-east.png", "east": "/characters/sales/east.png", "north-east": "/characters/sales/north-east.png", "north": "/characters/sales/north.png", "north-west": "/characters/sales/north-west.png", "west": "/characters/sales/west.png", "south-west": "/characters/sales/south-west.png" },
  "task-manager": { "south": "/characters/task-manager/south.png", "south-east": "/characters/task-manager/south-east.png", "east": "/characters/task-manager/east.png", "north-east": "/characters/task-manager/north-east.png", "north": "/characters/task-manager/north.png", "north-west": "/characters/task-manager/north-west.png", "west": "/characters/task-manager/west.png", "south-west": "/characters/task-manager/south-west.png" },
  "email-assistant": { "south": "/characters/email-assistant/south.png", "south-east": "/characters/email-assistant/south-east.png", "east": "/characters/email-assistant/east.png", "north-east": "/characters/email-assistant/north-east.png", "north": "/characters/email-assistant/north.png", "north-west": "/characters/email-assistant/north-west.png", "west": "/characters/email-assistant/west.png", "south-west": "/characters/email-assistant/south-west.png" },
  "reconciler": { "south": "/characters/reconciler/south.png", "south-east": "/characters/reconciler/south-east.png", "east": "/characters/reconciler/east.png", "north-east": "/characters/reconciler/north-east.png", "north": "/characters/reconciler/north.png", "north-west": "/characters/reconciler/north-west.png", "west": "/characters/reconciler/west.png", "south-west": "/characters/reconciler/south-west.png" },
  "delivery": { "south": "/characters/delivery/south.png", "south-east": "/characters/delivery/south-east.png", "east": "/characters/delivery/east.png", "north-east": "/characters/delivery/north-east.png", "north": "/characters/delivery/north.png", "north-west": "/characters/delivery/north-west.png", "west": "/characters/delivery/west.png", "south-west": "/characters/delivery/south-west.png" },
  "billing": { "south": "/characters/billing/south.png", "south-east": "/characters/billing/south-east.png", "east": "/characters/billing/east.png", "north-east": "/characters/billing/north-east.png", "north": "/characters/billing/north.png", "north-west": "/characters/billing/north-west.png", "west": "/characters/billing/west.png", "south-west": "/characters/billing/south-west.png" },
  "strategy": { "south": "/characters/strategy/south.png", "south-east": "/characters/strategy/south-east.png", "east": "/characters/strategy/east.png", "north-east": "/characters/strategy/north-east.png", "north": "/characters/strategy/north.png", "north-west": "/characters/strategy/north-west.png", "west": "/characters/strategy/west.png", "south-west": "/characters/strategy/south-west.png" },
};

/** All agent keys that have a bespoke character. */
export const CHARACTER_KEYS = Object.keys(CHARACTERS);
