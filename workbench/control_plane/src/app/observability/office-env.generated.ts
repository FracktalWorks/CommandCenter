// AUTO-GENERATED - Honeytan (create_tiles_pro) zoned floor, gen_honeytan.py.
// Base checker + plank lanes + corner accent + wood wall. Do not edit by hand.

export interface OfficeEnv {
  /** Base repeating floor tile. */
  floor?: string;
  /** On-screen tile repeat size in px. */
  floorSize?: number;
  /** Accent tile for the four room corners. */
  corner?: string;
  /** Plank tile for the walkway lanes between areas. */
  lane?: string;
  /** Wood tile for the top wall band. */
  wall?: string;
}

export const OFFICE_ENV: OfficeEnv = {
  floor: "/office-env/floor-floor.png",
  floorSize: 96,
  corner: "/office-env/floor-corner.png",
  lane: "/office-env/floor-lane.png",
  wall: "/office-env/floor-wall.png",
};
