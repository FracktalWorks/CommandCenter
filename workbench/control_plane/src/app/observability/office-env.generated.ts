// AUTO-GENERATED - zoned office floor mosaics (create_tiles_pro), gen_honeytan.py.
// Each zone is a mosaic of similar tile variations. Pre-upscaled; use natural size.
// Do not edit by hand.

export interface OfficeEnv {
  /** Base floor mosaic (the majority of the room). */
  floor?: string;
  /** Decorative accent mosaic for the four room corners. */
  corner?: string;
  /** Darker mosaic for the walkway lanes. */
  lane?: string;
  /** Wood-plank mosaic for the top wall band. */
  wall?: string;
}

export const OFFICE_ENV: OfficeEnv = {
  floor: "/office-env/floor-floor.png",
  corner: "/office-env/floor-corner.png",
  lane: "/office-env/floor-lane.png",
  wall: "/office-env/floor-wall.png",
};
