// AUTO-GENERATED - reusable Pixel Lab character library. Assign one of these
// to a new agent (or person). Static assets under public/character-library/.
// Do not edit by hand — regenerate with scripts/characters/build_library.py.

export type Dir = "south"|"east"|"north"|"west"|"south-east"|"north-east"|"north-west"|"south-west";
export interface LibChar {
  id: string; gender: string; role: string; description: string;
  portrait: string; standing: Partial<Record<Dir, string>>;
  seated?: string; working?: string; workingFrames?: number;
  sleeping?: string;
  breathing?: Partial<Record<Dir, string>>; breathingFrames?: number; }

export const CHARACTER_LIBRARY: Record<string, LibChar> = {
};

export const LIBRARY_IDS = Object.keys(CHARACTER_LIBRARY);
