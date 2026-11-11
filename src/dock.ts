// Dockable toolbar for touch devices.
//
// The desktop UI reveals its floating toolbar from a top-edge hover zone. On a
// phone there is no hover and no room for a horizontal row of 11 buttons, so
// Android gets this instead:
//
//   * the same buttons, laid out along one screen edge (top/right/bottom/left),
//   * revealed by tapping (nearly) anywhere on the page, or by tapping the
//     optional persistent handle,
//   * hidden again on the next tap or after an idle delay.
//
// Nothing here runs on desktop: `USE_DOCKED_TOOLBAR` is false there and the
// original hover logic in main.ts is left untouched.
//
// Why tap instead of an edge swipe: Android reserves every screen edge for
// system gestures (back, home, notification shade), so an inward drag is
// unreliable at best and navigates away at worst. A plain tap has no such
// conflict, works one-handed, and needs no aiming.

export type DockSide = "left" | "right" | "top" | "bottom";
export type HandleCorner = "tl" | "tr" | "bl" | "br";

export interface DockOptions {
  /** The `#toolbar` element whose buttons we move. */
  bar: HTMLElement;
  /** The legacy top-edge hover zone, disabled in docked mode. */
  hotzone: HTMLElement;
  side: DockSide;
  handleCorner: HandleCorner;
  /** Whether the floating "..." opener is drawn at all. */
  handleVisible: boolean;
  /** Where to persist the side/corner choice. */
  storageKey: string;
  /** Called after the sheet opens or closes, so callers can re-measure layout. */
  onToggle?: (open: boolean) => void;
}

const SIDES: DockSide[] = ["left", "right", "top", "bottom"];
const CORNERS: HandleCorner[] = ["tl", "tr", "bl", "br"];

/** Idle time before an untouched sheet closes itself, in ms. */
const IDLE_CLOSE = 6000;
/**
 * Taps this close to a link, button or input belong to that control, not to the
 * reveal gesture — otherwise tapping "打开一个" would open the toolbar instead.
 */
const INTERACTIVE = "a,button,input,textarea,select,label,[contenteditable]"

export class DockController {
  private opts: DockOptions;
  private open = false;
  private handle: HTMLButtonElement;
  private scrim: HTMLDivElement;
  private idleTimer: number | undefined;

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
    this.scrim.addEventListener("click", (ev) => {
      // Close here and stop: if the tap also reached the document handler it
      // would immediately reopen the sheet (close → open in one click).
      ev.stopPropagation();
      ev.preventDefault();
      this.setOpen(false);
    });
    document.body.appendChild(this.scrim);

    // The always-available way in.
    this.handle = document.createElement("button");
    this.handle.type = "button";
    this.handle.className = "dock-handle";
    this.handle.setAttribute("aria-label", "打开工具栏");
    // Three dots as three separate spans so the gaps are exact rather than
    // coming from font letter-spacing, which is what made the glyph look
    // off-centre and the dots too small.
    this.handle.innerHTML =
      '<span class="dock-dot"></span><span class="dock-dot"></span><span class="dock-dot"></span>';
    this.handle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.setOpen(!this.open);
    });
    document.body.appendChild(this.handle);

    this.applySide(side);
    this.applyCorner(handleCorner);
    this.setHandleVisible(opts.handleVisible);
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

  /** Show or hide the floating "..." opener. */
  setHandleVisible(visible: boolean): void {
    this.opts.handleVisible = visible;
    this.handle.hidden = !visible;
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
   * Reveal with a tap, close with the next tap.
   *
   * A clipboard-style double-tap-to-select, scroll, or a tap on a real control
   * must not toggle the sheet, so those are filtered out. `click` is used
   * rather than `touchend` because the browser already discards drags and
   * long-presses for us.
   */
  private bindGestures(): void {
    document.addEventListener(
      "click",
      (ev) => {
        const target = ev.target as HTMLElement | null;
        if (!target) return;
        // The sheet's own buttons and the handle manage their own state.
        if (this.opts.bar.contains(target)) return;
        if (this.handle.contains(target)) return;

        if (this.open) {
          // Any tap outside dismisses, including on links — but let the link
          // do its job first by not swallowing the event.
          this.setOpen(false);
          return;
        }

        // Closed: tapping a control should activate it, not open the toolbar.
        if (target.closest(INTERACTIVE)) return;

        // Ignore the tail of a text selection (a tap that ends a selection).
        const sel = window.getSelection?.();
        if (sel && !sel.isCollapsed && (sel.toString().length > 0)) return;

        this.setOpen(true);
      },
      // Bubble phase on purpose: the scrim and the sheet handle their own
      // clicks and stop propagation, so this only sees taps on the page body.
      { capture: false },
    );

    // Escape closes, matching the desktop dialogs.
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.open) this.setOpen(false);
    });
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
