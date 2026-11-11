// Dockable toolbar for touch devices.
//
// The desktop UI reveals its floating toolbar from a top-edge hover zone. On a
// phone there is no hover and no room for a horizontal row of 11 buttons, so
// Android gets this instead:
//
//   * the same buttons, laid out along one screen edge (top/right/bottom/left),
//   * revealed by dragging *inward* from that edge, or by tapping a small
//     persistent handle,
//   * hidden again on tap-outside or after an idle delay.
//
// Nothing here runs on desktop: `USE_DOCKED_TOOLBAR` is false there and the
// original hover logic in main.ts is left untouched.
//
// Edge-swipe caveat: Android reserves screen edges for system gestures (back,
// home, notification shade). A pure inward swipe is therefore unreliable, which
// is why the handle exists — it is the guaranteed way in.

export type DockSide = "left" | "right" | "top" | "bottom";
export type HandleCorner = "tl" | "tr" | "bl" | "br";

export interface DockOptions {
  /** The `#toolbar` element whose buttons we move. */
  bar: HTMLElement;
  /** The legacy top-edge hover zone, disabled in docked mode. */
  hotzone: HTMLElement;
  side: DockSide;
  handleCorner: HandleCorner;
  /** Where to persist the side/corner choice. */
  storageKey: string;
  /** Called after the sheet opens or closes, so callers can re-measure layout. */
  onToggle?: (open: boolean) => void;
}

const SIDES: DockSide[] = ["left", "right", "top", "bottom"];
const CORNERS: HandleCorner[] = ["tl", "tr", "bl", "br"];

/** How far from an edge a drag must start, in px. */
const EDGE_ZONE = 24;
/** How far inward the finger must travel to count as a reveal, in px. */
const SWIPE_MIN = 28;
/** Idle time before an untouched sheet closes itself, in ms. */
const IDLE_CLOSE = 6000;

export class DockController {
  private opts: DockOptions;
  private open = false;
  private handle: HTMLButtonElement;
  private scrim: HTMLDivElement;
  private idleTimer: number | undefined;
  private touchStart: { x: number; y: number; t: number } | null = null;

  constructor(opts: DockOptions) {
    this.opts = opts;
    const { bar, hotzone, side, handleCorner } = opts;

    // The legacy hot zone actively fights the new model: it only covers the
    // top edge and fires on hover, which never happens here.
    hotzone.style.display = "none";

    document.body.classList.add("docked-toolbar");
    bar.classList.add("dock-sheet");
    bar.setAttribute("data-dock", side);

    // Tap-outside backdrop. Sits under the sheet but over the page.
    this.scrim = document.createElement("div");
    this.scrim.className = "dock-scrim";
    this.scrim.addEventListener("click", () => this.setOpen(false));
    document.body.appendChild(this.scrim);

    // The always-available way in.
    this.handle = document.createElement("button");
    this.handle.type = "button";
    this.handle.className = "dock-handle";
    this.handle.setAttribute(
      "aria-label",
      "工具栏（点按或从屏幕边缘向内滑动打开）",
    );
    this.handle.textContent = "···";
    this.handle.addEventListener("click", () => this.setOpen(!this.open));
    document.body.appendChild(this.handle);

    this.applySide(side);
    this.applyCorner(handleCorner);
    this.bindGestures();

    // Start closed: opening on launch would cover the welcome screen.
    this.setOpen(false);
  }

  /** Reposition the sheet and the handle for a new dock edge. */
  applySide(side: DockSide): void {
    this.opts.side = side;
    this.opts.bar.setAttribute("data-dock", side);
    // A closed sheet is off its own edge; nothing else changes.
    if (!this.open) this.setOpen(false);
  }

  /** Move the corner handle. */
  applyCorner(corner: HandleCorner): void {
    this.opts.handleCorner = corner;
    this.handle.setAttribute("data-corner", corner);
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(next: boolean): void {
    const wasOpen = this.open;
    this.open = next;
    document.body.classList.toggle("dock-open", next);
    this.opts.bar.setAttribute("aria-hidden", next ? "false" : "true");

    window.clearTimeout(this.idleTimer);
    if (next) {
      // Auto-close so a forgotten sheet doesn't sit on top of the text.
      this.idleTimer = window.setTimeout(() => this.setOpen(false), IDLE_CLOSE);
    }
    if (wasOpen !== next) this.opts.onToggle?.(next);
  }

  /**
   * Reveal by dragging inward from a screen edge.
   *
   * The gesture must *start* within EDGE_ZONE of the matching edge and move
   * away from it by SWIPE_MIN. We deliberately use touch events rather than
   * pointer events so a mouse on a phone-sized window can never trigger it.
   */
  private bindGestures(): void {
    document.addEventListener(
      "touchstart",
      (ev) => {
        const t = ev.touches[0];
        if (!t) return;
        // Zeros while another element owns the gesture (e.g. sheet scrolling).
        this.touchStart = { x: t.clientX, y: t.clientY, t: Date.now() };
      },
      { passive: true },
    );

    document.addEventListener(
      "touchmove",
      (ev) => {
        const start = this.touchStart;
        if (!start) return;
        const t = ev.touches[0];
        if (!t) return;

        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;

        // Swiping on the open sheet itself must scroll, not re-reveal.
        const target = ev.target as Node | null;
        if (this.open && target && this.opts.bar.contains(target)) return;

        if (this.detectEdgeSwipe(start.x, start.y, dx, dy)) {
          this.touchStart = null;
          this.setOpen(true);
        }
      },
      { passive: true },
    );

    document.addEventListener(
      "touchend",
      () => {
        this.touchStart = null;
      },
      { passive: true },
    );

    // Escape closes, matching the desktop dialogs.
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.open) this.setOpen(false);
    });
  }

  /** True if this drag looks like an inward reveal from the active edge. */
  private detectEdgeSwipe(
    startX: number,
    startY: number,
    dx: number,
    dy: number,
  ): boolean {
    const w = window.innerWidth;
    const h = window.innerHeight;
    switch (this.opts.side) {
      case "left":
        return startX <= EDGE_ZONE && dx >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy);
      case "right":
        return startX >= w - EDGE_ZONE && -dx >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy);
      case "top":
        return startY <= EDGE_ZONE && dy >= SWIPE_MIN && Math.abs(dy) > Math.abs(dx);
      case "bottom":
        return startY >= h - EDGE_ZONE && -dy >= SWIPE_MIN && Math.abs(dy) > Math.abs(dx);
      default:
        return false;
    }
  }
}

export function parseSide(v: string | null): DockSide {
  return SIDES.includes(v as DockSide) ? (v as DockSide) : "left";
}

export function parseCorner(v: string | null): HandleCorner {
  return CORNERS.includes(v as HandleCorner) ? (v as HandleCorner) : "bl";
}

export const DOCK_SIDES = SIDES;
export const DOCK_CORNERS = CORNERS;
