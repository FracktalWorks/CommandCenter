// AUTO-GENERATED - Pixel Lab office environment tiles (create_topdown_tileset).
// Seamless carpet floor + wood wall sliced from the Wang sheet by build_env.py.
// Do not edit by hand.

export interface OfficeEnv {
  /** Seamless repeating floor tile (public path). */
  floor?: string;
  /** Tile render size in px for the repeating background. */
  floorSize?: number;
  /** Optional wall / skirting tile for the top wall band. */
  wall?: string;
}

export const OFFICE_ENV: OfficeEnv = {
  floor: "/office-env/floor.png",
  floorSize: 64,
  wall: "/office-env/wall.png",
};
