import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import frontMatterPlugin from "markdown-it-front-matter";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { DockController, parseSide, parseCorner } from "./dock";

// hljs theme CSS as strings, so HTML export can be fully self-contained.
import hljsLightCss from "highlight.js/styles/github.css?inline";
import hljsDarkCss from "highlight.js/styles/github-dark.css?inline";

// Desktop: the dialog plugin returns a plain filesystem path.
// Android: scoped storage means we must go through the Storage Access Framework
// and get back a `content://` URI that the backend can actually read.
const IS_ANDROID = /Android/i.test(navigator.userAgent);

/// Whether the dockable-sidebar toolbar should replace the floating bar.
/// Android only: desktop keeps the hover-based bar byte-for-byte.
const USE_DOCKED_TOOLBAR = IS_ANDROID;

/// Human-readable name for a path or a `content://` document URI.
/// SAF URIs percent-encode the filename as the last segment, e.g.
/// `content://…/document/primary%3ANotes%2Ftodo.md` → `todo.md`.
function displayName(pathOrUri: string): string {
  if (!pathOrUri.startsWith("content://")) {
    return pathOrUri.split(/[\\/]/).pop() || pathOrUri;
  }
  const last = pathOrUri.split("/").pop() ?? pathOrUri;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Malformed escape: fall back to the raw segment.
  }
  // The document id looks like `primary:Notes/todo.md`.
  const tail = decoded.split(":").pop() ?? decoded;
  return tail.split("/").pop() || tail;
}


// ---------- Color theme (system / light / dark) ----------
type ThemePref = "system" | "light" | "dark";
const systemDarkMQ = window.matchMedia("(prefers-color-scheme: dark)");
let themePref = (localStorage.getItem("theme") as ThemePref | null) ?? "system";

// Whether the *effective* theme is dark, given the user's preference.
function currentDark(): boolean {
  return themePref === "dark" || (themePref === "system" && systemDarkMQ.matches);
}

// highlight.js theme is swapped by rewriting this <style> element's contents.
const hljsStyle = document.createElement("style");
hljsStyle.textContent = currentDark() ? hljsDarkCss : hljsLightCss;
document.head.appendChild(hljsStyle);

let lastFrontMatter = "";

// ---------- GitHub-style callouts (> [!note], > [!tip], > [!warning] …) ----------
// Rendered as a bordered box with a coloured spine and an icon glyph, so
// notes stand out the way they do in markview and on GitHub.
const CALLOUT_KINDS: Record<string, { label: string; icon: string }> = {
  note: { label: "说明", icon: "ℹ" },
  tip: { label: "提示", icon: "💡" },
  important: { label: "重要", icon: "❗" },
  warning: { label: "警告", icon: "⚠" },
  caution: { label: "小心", icon: "🛑" },
};

function calloutPlugin(mdInstance: MarkdownIt): void {
  // Runs before blockquote parsing so the alert marker is still inline text.
  mdInstance.core.ruler.after("block", "callout", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i];
      if (open.type !== "blockquote_open") continue;

      // Find the first inline token inside this blockquote.
      let inlineIdx = -1;
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].type === "blockquote_close") break;
        if (tokens[j].type === "inline") { inlineIdx = j; break; }
      }
      if (inlineIdx < 0) continue;

      const inline = tokens[inlineIdx];
      const m = /^\s*\[!(note|tip|important|warning|caution)\]\s*\n?/i.exec(inline.content);
      if (!m) continue;

      const kind = m[1].toLowerCase();
      const meta = CALLOUT_KINDS[kind];
      inline.content = inline.content.slice(m[0].length);

      // Drop the marker from the first child text node too.
      const first = inline.children?.[0];
      if (first && first.type === "text") {
        first.content = first.content.replace(/^\s*\[![a-z]+\]\s*/i, "");
      }

      open.attrJoin("class", `md-callout md-callout-${kind}`);
      open.attrSet("data-callout", kind);

      // Inject a header token so the label renders above the body.
      const header = new state.Token("html_inline", "", 0);
      header.content =
        `<span class="md-callout-title"><span class="md-callout-icon">${meta.icon}</span>${meta.label}</span>`;
      inline.children = inline.children ?? [];
      inline.children.unshift(header);
    }
    return true;
  });
}

const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str, lang) => {
    // Leave mermaid blocks untouched so we can render them lazily later.
    if (lang === "mermaid") {
      return `<pre class="mermaid">${md.utils.escapeHtml(str)}</pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${
          hljs.highlight(str, { language: lang }).value
        }</code></pre>`;
      } catch {
        /* fall through to plain escaping */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
})
  .use(calloutPlugin)
  .use(taskLists, { enabled: true, label: true })
  .use(frontMatterPlugin, (fm: string) => {
    lastFrontMatter = fm;
  });

// Disable setext headings so `text` immediately above `---` / `===` stays a
// paragraph + horizontal rule (the usual intent) instead of becoming a heading
// that pollutes the outline.
md.disable("lheading");

const content = document.getElementById("content") as HTMLElement;
const toc = document.getElementById("toc") as HTMLElement;
const layout = document.getElementById("layout") as HTMLElement;
const tocToggle = document.getElementById("toc-toggle") as HTMLButtonElement;
const editor = document.getElementById("editor") as HTMLTextAreaElement;
const editToggle = document.getElementById("edit-toggle") as HTMLButtonElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const saveAsBtn = document.getElementById("save-as-btn") as HTMLButtonElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
const fontInc = document.getElementById("font-inc") as HTMLButtonElement;
const fontDec = document.getElementById("font-dec") as HTMLButtonElement;
const wideToggle = document.getElementById("wide-toggle") as HTMLButtonElement;
const themeToggle = document.getElementById("theme-toggle") as HTMLButtonElement;
const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
const filesBtn = document.getElementById("files-btn") as HTMLButtonElement;
const filesPanel = document.getElementById("files") as HTMLElement;
const findBar = document.getElementById("find-bar") as HTMLElement;
const findInput = document.getElementById("find-input") as HTMLInputElement;
const findCount = document.getElementById("find-count") as HTMLElement;
const closeModal = document.getElementById("close-modal") as HTMLElement;
const closeDocBtn = document.getElementById("close-doc-btn") as HTMLButtonElement;
const toastEl = document.getElementById("toast") as HTMLElement;
const appWindow = getCurrentWindow();
const EMPTY_STATE_HTML = `<div class="empty-state">
  <h1>Markdown 阅读器</h1>
  <p>把 <code>.md</code> 文件拖到这里，或<a id="empty-open" href="#">打开一个</a>。</p>
  <p class="app-version"><a id="about-open" href="#">关于 / About</a></p>
  <div id="recent-list"></div>
</div>`;
let closeAction: "window" | "doc" | "switch" = "window";
let pendingSwitchPath: string | null = null;
let currentPath: string | null = null;
let currentText = "";
let editMode = false;
let dirty = false;
let suppressReloadUntil = 0;
let spy: IntersectionObserver | null = null;
// Last title pushed to the native window, to avoid redundant IPC.
let lastNativeTitle = "";

// Build the left-hand outline from the rendered headings.
function buildToc(): void {
  spy?.disconnect();
  toc.innerHTML = "";
  const headings = Array.from(
    content.querySelectorAll<HTMLElement>("h1, h2, h3"),
  );

  if (headings.length < 2) {
    layout.classList.remove("has-toc");
    return;
  }
  layout.classList.add("has-toc");

  const links = new Map<string, HTMLAnchorElement>();
  headings.forEach((h, i) => {
    h.id = `h-${i}`;
    const a = document.createElement("a");
    a.href = `#h-${i}`;
    a.textContent = h.textContent ?? "";
    a.className = `toc-link toc-${h.tagName.toLowerCase()}`;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      // Expand any collapsed <details> the heading lives inside, otherwise it's
      // hidden and scrollIntoView can't reach it (e.g. unclosed <details>).
      let p: HTMLElement | null = h.parentElement;
      while (p && p !== content) {
        if (p instanceof HTMLDetailsElement) p.open = true;
        p = p.parentElement;
      }
      h.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    toc.appendChild(a);
    links.set(h.id, a);
  });

  // Scroll-spy: highlight the heading currently near the top.
  spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          toc.querySelector(".active")?.classList.remove("active");
          const link = links.get(e.target.id);
          link?.classList.add("active");
          link?.scrollIntoView({ block: "nearest" });
        }
      }
    },
    { root: content, rootMargin: "0px 0px -80% 0px", threshold: 0 },
  );
  headings.forEach((h) => spy!.observe(h));
}

// Add a "copy" button to each highlighted code block (skips mermaid diagrams).
function addCopyButtons(): void {
  content
    .querySelectorAll<HTMLPreElement>("pre.hljs")
    .forEach((pre) => {
      if (pre.querySelector(".copy-btn")) return; // already added
      pre.classList.add("has-copy");
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.title = "复制";
      btn.setAttribute("aria-label", "复制代码");
      btn.textContent = "📋";
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const code = pre.querySelector("code")?.textContent ?? "";
        try {
          await navigator.clipboard.writeText(code);
          btn.textContent = "✓";
          btn.classList.add("copied");
          window.setTimeout(() => {
            btn.textContent = "📋";
            btn.classList.remove("copied");
          }, 1400);
        } catch {
          toast("复制失败");
        }
      });
      pre.appendChild(btn);
    });
}

// ---------- Resizable table columns (drag the header borders) ----------
const MIN_COL_W = 40;

// Per-file, per-table storage key so column widths are remembered on reopen.
function tableKey(tableIndex: number): string | null {
  if (!currentPath) return null;
  return `colw:${currentPath}::${tableIndex}`;
}
function loadColWidths(tableIndex: number): number[] | null {
  const key = tableKey(tableIndex);
  if (!key) return null;
  try {
    const arr = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(arr) && arr.every((n) => typeof n === "number")
      ? arr
      : null;
  } catch {
    return null;
  }
}
function saveColWidths(tableIndex: number, widths: number[]): void {
  const key = tableKey(tableIndex);
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(widths.map((w) => Math.round(w))));
}

// Give every table a drag handle on each header cell's right edge. The first
// drag (or a stored width) switches the table to a fixed layout with an
// explicit <colgroup>, after which columns can be widened or narrowed freely.
function makeTablesResizable(): void {
  content.querySelectorAll<HTMLTableElement>("table").forEach((table, tIndex) => {
    // Wrap once for horizontal scrolling when columns exceed the viewport.
    if (!table.parentElement?.classList.contains("md-table-wrap")) {
      const wrap = document.createElement("div");
      wrap.className = "md-table-wrap";
      table.parentNode?.insertBefore(wrap, table);
      wrap.appendChild(table);
    }

    const cells = Array.from(
      table.querySelectorAll<HTMLTableCellElement>("thead th"),
    );
    if (cells.length < 1) return;

    const getColgroup = (): HTMLElement => {
      let cg = table.querySelector("colgroup");
      if (!cg) {
        cg = document.createElement("colgroup");
        for (let i = 0; i < cells.length; i++) {
          cg.appendChild(document.createElement("col"));
        }
        table.insertBefore(cg, table.firstChild);
      }
      return cg as HTMLElement;
    };

    const applyFixed = (widths: number[]): void => {
      const cols = Array.from(getColgroup().children) as HTMLElement[];
      widths.forEach((w, i) => {
        if (cols[i]) cols[i].style.width = `${w}px`;
      });
      table.classList.add("resizable");
      table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
    };

    // Restore remembered widths (only if the column count still matches).
    const stored = loadColWidths(tIndex);
    if (stored && stored.length === cells.length) applyFixed(stored);

    const ensureFixed = (): void => {
      if (table.classList.contains("resizable")) return;
      applyFixed(cells.map((c) => c.getBoundingClientRect().width));
    };

    cells.forEach((th, i) => {
      th.classList.add("has-resizer");
      const handle = document.createElement("div");
      handle.className = "col-resizer";
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        ensureFixed();
        const cols = Array.from(getColgroup().children) as HTMLElement[];
        const startX = e.clientX;
        const startW =
          parseFloat(cols[i].style.width) ||
          cells[i].getBoundingClientRect().width;
        document.body.classList.add("col-resizing");
        const onMove = (me: MouseEvent): void => {
          const w = Math.max(MIN_COL_W, startW + (me.clientX - startX));
          cols[i].style.width = `${w}px`;
          table.style.width = `${cols.reduce(
            (a, c) => a + (parseFloat(c.style.width) || 0),
            0,
          )}px`;
        };
        const onUp = (): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          document.body.classList.remove("col-resizing");
          saveColWidths(
            tIndex,
            cols.map((c) => parseFloat(c.style.width) || 0),
          );
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
      th.appendChild(handle);
    });
  });
}

// Resolve relative-path images against the open file's folder.
function resolveImages(): void {
  if (!currentPath) return;
  const dir = currentPath.replace(/[\\/][^\\/]*$/, "");
  content.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    // Skip absolute URLs (http:, data:, asset:, file:, …) and protocol-relative.
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return;
    const abs = `${dir}/${src}`.replace(/\\/g, "/");
    if (IS_ANDROID) {
      // Android has no `asset:` protocol and the sandbox path would need a
      // fragile scope pattern, so read the bytes and inline them instead:
      // one request, no scope rules, works for any nesting depth.
      void import("tauri-plugin-android-fs-api")
        .then((fs) => fs.readFileAsDataURL(abs))
        .then((url) => {
          img.src = url;
        })
        .catch(() => {
          // Missing or unreadable image: leave the browser's broken-image state
          // rather than inventing a placeholder.
        });
      return;
    }
    img.src = convertFileSrc(abs);
  });
}

function formatFmValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function buildFmCard(data: Record<string, unknown>): HTMLElement | null {
  const card = document.createElement("div");
  card.className = "fm-card";
  const used = new Set<string>();

  if (typeof data.title === "string" && data.title.trim()) {
    const t = document.createElement("div");
    t.className = "fm-title";
    t.textContent = data.title;
    card.appendChild(t);
  }
  used.add("title");

  if (typeof data.description === "string" && data.description.trim()) {
    const d = document.createElement("div");
    d.className = "fm-desc";
    d.textContent = data.description;
    card.appendChild(d);
  }
  used.add("description");

  const meta = document.createElement("div");
  meta.className = "fm-meta";
  const dateVal = data.pubDate ?? data.date ?? data.published;
  ["pubDate", "date", "published"].forEach((k) => used.add(k));
  if (dateVal) {
    const s = document.createElement("span");
    s.className = "fm-chip fm-date";
    s.textContent = `📅 ${formatFmValue(dateVal)}`;
    meta.appendChild(s);
  }
  used.add("tags");
  if (Array.isArray(data.tags)) {
    data.tags.forEach((tag) => {
      const c = document.createElement("span");
      c.className = "fm-chip fm-tag";
      c.textContent = `#${String(tag)}`;
      meta.appendChild(c);
    });
  }
  used.add("draft");
  if (data.draft === true) {
    const b = document.createElement("span");
    b.className = "fm-chip fm-badge";
    b.textContent = "Draft";
    meta.appendChild(b);
  }
  if (meta.childNodes.length) card.appendChild(meta);

  const rest = Object.keys(data).filter((k) => {
    if (used.has(k)) return false;
    const v = data[k];
    if (v === null || v === "" || v === undefined) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
  if (rest.length) {
    const dl = document.createElement("dl");
    dl.className = "fm-dl";
    rest.forEach((k) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = formatFmValue(data[k]);
      dl.append(dt, dd);
    });
    card.appendChild(dl);
  }

  return card.childNodes.length ? card : null;
}

// Parse YAML front matter (lazy-loaded) and prepend a metadata card.
async function renderFrontMatter(): Promise<void> {
  if (!lastFrontMatter.trim()) return;
  try {
    const yaml = await import("js-yaml");
    const data = yaml.load(lastFrontMatter);
    if (!data || typeof data !== "object") return;
    const card = buildFmCard(data as Record<string, unknown>);
    if (card) content.prepend(card);
  } catch (e) {
    console.error("front matter parse failed", e);
  }
}

async function renderMarkdown(
  text: string,
  preserveScroll = false,
): Promise<void> {
  const scrollTop = content.scrollTop;
  lastFrontMatter = "";
  // Sanitize rendered HTML to neutralise scripts / event handlers in untrusted docs.
  content.innerHTML = DOMPurify.sanitize(md.render(text), {
    ADD_TAGS: ["pre"],
    ADD_ATTR: ["class"],
  });
  await renderFrontMatter();
  resolveImages();
  addCopyButtons();
  makeTablesResizable();
  buildToc();

  // Lazily pull in mermaid only when a diagram is actually present.
  const diagrams = content.querySelectorAll<HTMLElement>("pre.mermaid");
  if (diagrams.length > 0) {
    const mermaid = (await import("mermaid")).default;
    // Re-initialise each render so diagrams follow the current theme.
    mermaid.initialize({
      startOnLoad: false,
      theme: currentDark() ? "dark" : "default",
      securityLevel: "strict",
    });
    try {
      await mermaid.run({ nodes: Array.from(diagrams) });
    } catch (e) {
      console.error("mermaid render failed", e);
    }
    // Click a rendered diagram to open it in the zoom/pan lightbox.
    diagrams.forEach((pre) => {
      const svg = pre.querySelector("svg");
      if (!svg) return;
      pre.classList.add("mermaid-zoomable");
      pre.addEventListener("click", () => openDiagram(svg));
    });
  }

  // New documents start at the top; only hot-reload / live-edit keep position.
  content.scrollTop = preserveScroll ? scrollTop : 0;
  updateStatusBar();
}

// ---------- Status bar: counts, progress, optional path ----------
const statusBar = document.getElementById("statusbar") as HTMLElement;
const sbCounts = document.getElementById("sb-counts") as HTMLElement;
const sbPath = document.getElementById("sb-path") as HTMLElement;
const sbProgress = document.getElementById("sb-progress") as HTMLElement;
const sbPathRow = document.getElementById("sb-path-row") as HTMLElement;
const SHOW_PATH_KEY = "showPath";
const SHOW_STATUSBAR_KEY = "showStatusBar";

/** Whether the bottom status bar is drawn at all (default: yes). */
function showStatusBarEnabled(): boolean {
  return localStorage.getItem(SHOW_STATUSBAR_KEY) !== "false";
}

function showPathEnabled(): boolean {
  return localStorage.getItem(SHOW_PATH_KEY) === "true";
}

/** Copy the full path, falling back to a selection when clipboard is blocked. */
async function copyPathToClipboard(): Promise<void> {
  const p = currentPath;
  if (!p) return;
  try {
    await navigator.clipboard.writeText(p);
    toast(`已复制路径：${p}`);
  } catch {
    // The Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = document.createElement("textarea");
    ta.value = p;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    toast(ok ? `已复制路径：${p}` : "复制失败，请手动选中路径");
  }
}

/** Count CJK characters individually and Latin words by whitespace runs. */
function countText(text: string): { chars: number; words: number } {
  const chars = Array.from(text.replace(/\s/g, "")).length;
  const cjk = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  const latinWords = (text.replace(/[\u3400-\u9FFF\uF900-\uFAFF]/g, " ")
    .match(/[A-Za-z0-9_'’-]+/g) ?? []).length;
  return { chars, words: cjk + latinWords };
}

/** Publish the bar's rendered height so `#content` can reserve exactly that. */
function syncStatusBarHeight(): void {
  const root = document.documentElement;
  if (statusBar.hidden) {
    root.style.setProperty("--statusbar-h", "0px");
    return;
  }
  const h = Math.ceil(statusBar.getBoundingClientRect().height);
  root.style.setProperty("--statusbar-h", `${h}px`);
}

/// Path to show in the UI for a document.
///
/// On Android the real path is an unreadable sandbox location such as
/// `/data/user/0/com.craig.mdviewer/files/…`, so it is replaced with a short
/// marker that tells the user this is the in-app copy rather than their
/// original file.
function pathForDisplay(path: string): string {
  if (!IS_ANDROID) return path;
  return `应用内副本 / ${displayName(path)}`;
}

function updateStatusBar(): void {
  const hasDoc = currentPath !== null && showStatusBarEnabled();
  statusBar.hidden = !hasDoc;
  syncStatusBarHeight();
  if (!hasDoc) return;

  const source = editMode ? editor.value : currentText;
  const { chars, words } = countText(source);
  sbCounts.textContent = `${chars} 字符 · ${words} 词`;

  // The path lives on its own row so it never competes with the counts.
  const wantsPath = showPathEnabled();
  sbPathRow.hidden = !wantsPath;
  if (wantsPath) {
    const label = pathForDisplay(currentPath ?? "");
    sbPath.textContent = label;
    sbPath.title = label;
  }

  const max = content.scrollHeight - content.clientHeight;
  const pct = max <= 4 ? 100 : Math.min(100, Math.max(0, Math.round((content.scrollTop / max) * 100)));
  sbProgress.textContent = `${pct}%`;
}

function setTitle(): void {
  const name = currentPath?.split(/[\\/]/).pop() ?? "Markdown 阅读器";
  document.title = `${dirty ? "● " : ""}${name} — Markdown 阅读器`;
  // Also drive the real native window title — that is what the title bar shows.
  const nativeTitle = currentPath
    ? `${dirty ? "● " : ""}${name}`
    : "Markdown 阅读器";
  if (nativeTitle !== lastNativeTitle) {
    lastNativeTitle = nativeTitle;
    void appWindow.setTitle(nativeTitle).catch(() => {
      /* outside Tauri (plain browser preview) — ignore */
    });
  }
  // Respect the buttons the user hid in the toolbar customizer.
  const userHidden = (id: string): boolean =>
    document.getElementById(id)?.dataset.userHidden === "1";
  saveBtn.hidden = !editMode || !dirty || userHidden("save-btn");
  saveBtn.disabled = !dirty;
  // Hidden entirely when there is nothing to save: an untouched document
  // showing "saved" was noise, not information.
  setIconButton(saveBtn, ICON_SVG.save, "保存");
  // Android: export the buffer to a real file. Always available while a
  // document is open, because the sandbox copy is never the user's original.
  saveAsBtn.hidden = !IS_ANDROID || !currentPath || userHidden("save-as-btn");
  closeDocBtn.hidden = !currentPath || userHidden("close-doc-btn");
}

// Close the current document and return to the home / empty-state screen.
function goHome(): void {
  currentPath = null;
  currentText = "";
  dirty = false;
  if (editMode) {
    editMode = false;
    layout.classList.remove("mode-edit");
    setIconButton(editToggle, ICON_SVG.edit, "编辑");
  }
  content.innerHTML = EMPTY_STATE_HTML;
  buildToc();
  renderRecents();
  if (filesOpen) void renderFiles(null);
  setTitle();
}

async function openFile(
  path: string,
  watch = true,
  preserveScroll = false,
): Promise<void> {
  try {
    const text = await invoke<string>("read_md", { path });
    currentPath = path;
    currentText = text;
    dirty = false;
    addRecent(path);
    if (editMode) editor.value = text;
    setTitle();
    await renderMarkdown(text, preserveScroll);
    // The imported copy is an ordinary file, but `notify` itself is not built
    // for Android, so live-reload stays desktop-only.
    if (watch && !IS_ANDROID) {
      await invoke("watch_file", { path });
    }
    if (filesOpen) void renderFiles(dirOf(path));
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><p>${String(e)}</p></div>`;
    buildToc();
  }
}

// ---------- Edit mode + live preview ----------

let previewTimer: number | undefined;
function schedulePreview(): void {
  dirty = editor.value !== currentText;
  setTitle();
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(
    () => void renderMarkdown(editor.value, true),
    180,
  );
}

function setEditMode(on: boolean): void {
  editMode = on;
  layout.classList.toggle("mode-edit", on);
  setIconButton(editToggle, on ? ICON_SVG.preview : ICON_SVG.edit, on ? "预览" : "编辑");
  if (on) {
    // Only reload from the saved snapshot when there are no unsaved edits;
    // otherwise entering edit mode would wipe the user's unsaved buffer
    // (worst case: a freshly-opened empty file loses everything typed).
    if (!dirty) editor.value = currentText;
    editor.focus();
  } else {
    // Leaving edit mode: render the latest source, keep position.
    void renderMarkdown(editor.value, true);
  }
  setTitle();
}

function toggleEdit(): void {
  setEditMode(!editMode);
}

async function save(): Promise<void> {
  if (!currentPath || !dirty) return;
  try {
    // Ignore the watcher event our own write is about to trigger.
    suppressReloadUntil = Date.now() + 1000;
    await invoke("write_md", { path: currentPath, content: editor.value });
    currentText = editor.value;
    dirty = false;
    setTitle();
    // The private copy is what got written; tell the user where the real
    // document still is, since editing here does not touch it.
    if (IS_ANDROID) toast("已保存到应用内副本，需要覆盖原文件请用「另存为」");
  } catch (e) {
    console.error("save failed", e);
  }
}

/// Android: write the current buffer out to a location the user picks.
///
/// This is the only path that produces a file the rest of the phone can see,
/// because the working copy lives inside the app sandbox.
async function saveAs(): Promise<void> {
  if (!currentPath) {
    toast("没有打开的文件");
    return;
  }
  const name = displayName(currentPath);
  try {
    const fs = await import("tauri-plugin-android-fs-api");
    const target = await fs.showSaveFilePicker(name, "text/markdown", {
      localOnly: true,
    });
    if (!target) return;
    const text = editMode ? editor.value : currentText;
    await fs.writeTextFile(target, text);
    toast(`已另存为 ${name}`);
  } catch (e) {
    toast(`另存为失败：${String(e)}`);
  }
}

editToggle.addEventListener("click", toggleEdit);
editor.addEventListener("input", schedulePreview);
saveBtn.addEventListener("click", () => void save());
// Android only: the working copy is sandboxed, so exporting needs its own button.
saveAsBtn.addEventListener("click", () => void saveAs());

// ---------- Toast ----------
let toastTimer: number | undefined;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2800);
}

// ---------- Export to standalone HTML (with TOC sidebar) ----------
const EXPORT_CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code-bg:#f6f8fa;--accent:#0969da;--stripe:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#30363d;--code-bg:#161b22;--accent:#4493f8;--stripe:#161b22}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;display:flex;align-items:flex-start}
.toc{flex:0 0 264px;width:264px;position:sticky;top:0;max-height:100vh;overflow:auto;padding:24px 12px 40px;border-right:1px solid var(--border);font-size:13.5px;line-height:1.5}
.toc a{display:block;padding:3px 10px;margin:1px 0;color:var(--muted);text-decoration:none;border-left:2px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc a:hover{color:var(--fg);background:var(--code-bg)}
.toc .l1{font-weight:600}.toc .l2{padding-left:22px}.toc .l3{padding-left:34px;font-size:13px}
.markdown-body{flex:1;min-width:0;max-width:860px;margin:0 auto;padding:32px 40px 80px;word-wrap:break-word}
.markdown-body h1,.markdown-body h2{border-bottom:1px solid var(--border);padding-bottom:.3em}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{margin-top:1.4em;margin-bottom:.6em;font-weight:600;line-height:1.25}
.markdown-body a{color:var(--accent);text-decoration:none}.markdown-body a:hover{text-decoration:underline}
.markdown-body code{background:var(--code-bg);padding:.2em .4em;border-radius:6px;font-size:85%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.markdown-body pre{background:var(--code-bg);padding:16px;border-radius:8px;overflow:auto;line-height:1.45}
.markdown-body pre code{background:transparent;padding:0;font-size:90%}
.markdown-body blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:4px solid var(--border)}
.markdown-body table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow:auto;margin:1em 0}
.markdown-body th,.markdown-body td{border:1px solid var(--border);padding:6px 13px}
.markdown-body tr:nth-child(2n){background:var(--stripe)}
.markdown-body img{max-width:100%}
.markdown-body hr{border:none;border-top:1px solid var(--border);margin:1.6em 0}
.markdown-body .task-list-item{list-style:none}
.markdown-body .task-list-item input{margin:0 .4em .25em -1.4em}
.markdown-body pre.mermaid{background:transparent;text-align:center;padding:8px 0}
`;

function buildExportHtml(): string {
  // Clone so we don't mutate the live DOM.
  const article = content.cloneNode(true) as HTMLElement;
  // Copy buttons are UI-only — strip them from the exported document.
  article.querySelectorAll(".copy-btn").forEach((b) => b.remove());
  // Strip column-resize scaffolding so exported tables use the default layout.
  article.querySelectorAll(".col-resizer").forEach((h) => h.remove());
  article.querySelectorAll<HTMLTableElement>("table.resizable").forEach((t) => {
    t.classList.remove("resizable");
    t.removeAttribute("style");
    t.querySelector("colgroup")?.remove();
  });
  article.querySelectorAll(".md-table-wrap").forEach((w) => {
    const t = w.querySelector("table");
    if (t) w.replaceWith(t);
  });
  const headings = Array.from(
    article.querySelectorAll<HTMLElement>("h1, h2, h3"),
  );

  let tocHtml = "";
  if (headings.length >= 2) {
    const items = headings
      .map((h, i) => {
        if (!h.id) h.id = `h-${i}`;
        const level = h.tagName.toLowerCase().replace("h", "l");
        const label = (h.textContent ?? "").replace(/[<>&]/g, "");
        return `<a class="${level}" href="#${h.id}">${label}</a>`;
      })
      .join("\n");
    tocHtml = `<nav class="toc">\n${items}\n</nav>\n`;
  }

  const title = currentPath?.split(/[\\/]/).pop()?.replace(/\.(md|markdown)$/i, "") ?? "Document";
  const themeCss = currentDark() ? hljsDarkCss : hljsLightCss;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>${EXPORT_CSS}</style>
<style>${themeCss}</style>
</head>
<body>
${tocHtml}<article class="markdown-body">
${article.innerHTML}
</article>
</body>
</html>`;
}

async function exportHtml(): Promise<void> {
  if (!currentPath) {
    toast("没有打开的文件");
    return;
  }
  // Make sure the preview reflects the latest source (e.g. while editing).
  if (editMode) await renderMarkdown(editor.value, true);

  const base = currentPath.replace(/\.(md|markdown)$/i, "");
  const out = `${base}.html`;
  try {
    await invoke("write_md", { path: out, content: buildExportHtml() });
    toast(`已导出 ${out.split(/[\\/]/).pop()}`);
  } catch (e) {
    toast(`导出失败: ${String(e)}`);
  }
}

exportBtn.addEventListener("click", () => void exportHtml());

// ---------- Synced scrolling (editor <-> preview) ----------
let syncing = false;
function syncScroll(from: HTMLElement, to: HTMLElement): void {
  if (syncing || !editMode) return;
  syncing = true;
  const max = from.scrollHeight - from.clientHeight;
  const ratio = max > 0 ? from.scrollTop / max : 0;
  to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
  requestAnimationFrame(() => {
    syncing = false;
  });
}
editor.addEventListener("scroll", () => syncScroll(editor, content));
content.addEventListener("scroll", () => syncScroll(content, editor));

// ---------- Close confirmation when there are unsaved changes ----------
function showCloseModal(): void {
  closeModal.hidden = false;
}
function hideCloseModal(): void {
  closeModal.hidden = true;
}
(document.getElementById("modal-cancel") as HTMLButtonElement).addEventListener(
  "click",
  hideCloseModal,
);
function finishClose(): void {
  dirty = false;
  if (closeAction === "doc") {
    goHome();
  } else if (closeAction === "switch") {
    if (pendingSwitchPath) void openFile(pendingSwitchPath);
  } else {
    void appWindow.destroy();
  }
}
(document.getElementById("modal-discard") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    hideCloseModal();
    finishClose();
  },
);
(document.getElementById("modal-save") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    await save();
    hideCloseModal();
    finishClose();
  },
);

// Close the current document (back to home), confirming if there are edits.
closeDocBtn.addEventListener("click", () => {
  if (dirty) {
    closeAction = "doc";
    showCloseModal();
  } else {
    goHome();
  }
});

// ---------- Icons (mirror of the inline SVGs in index.html) ----------
// Kept as markup strings so buttons whose label changes at runtime can swap
// between them without falling back to emoji.
const ICON_SVG = {
  save: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 3.6h11L20.4 8v11.4A1.6 1.6 0 0 1 18.8 21H5a1.6 1.6 0 0 1-1.6-1.6V5.2A1.6 1.6 0 0 1 5 3.6z"/><path d="M7.6 3.6v4.8h6.8V3.6"/><rect x="7.4" y="13" width="9.2" height="8" rx="1"/></svg>',
  edit: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13.7 4.5a1.9 1.9 0 0 1 2.7 0l3.1 3.1a1.9 1.9 0 0 1 0 2.7L9.1 20.7l-5.3 1.2 1.2-5.3z"/><path d="M12.4 5.8 18.2 11.6"/></svg>',
  preview: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.4 12S6 5.6 12 5.6 21.6 12 21.6 12 18 18.4 12 18.4 2.4 12 2.4 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  themeSystem: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="4.6" width="18" height="12" rx="2"/><path d="M9 20h6"/><path d="M12 16.6V20"/></svg>',
  themeLight: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2.4v2.2M12 19.4v2.2M4.35 4.35l1.56 1.56M18.09 18.09l1.56 1.56M2.4 12h2.2M19.4 12h2.2M4.35 19.65l1.56-1.56M18.09 5.91l1.56-1.56"/></svg>',
  themeDark: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a7 7 0 1 0 10.8 10.8z"/></svg>',
};

/** Replace a button's contents with an icon plus an optional label. */
function setIconButton(el: HTMLElement, icon: string, label?: string): void {
  el.innerHTML = label ? `${icon}<span>${label}</span>` : icon;
}

// ---------- Floating toolbar: auto-hide + user customization ----------

// Every toolbar button, in default order. `key` is what we persist; `locked`
// entries can never be hidden (otherwise the Settings gear that opens this
// very panel could disappear and strand the user).
interface ToolbarButton {
  id: string;
  label: string;
  glyph: string;
  locked?: boolean;
  /** Dropped entirely on Android: the feature cannot work there. */
  androidHidden?: boolean;
  /** Shown *only* on Android: the feature only exists there. */
  androidOnly?: boolean;
}
const TOOLBAR_BUTTONS: ToolbarButton[] = [
  { id: "open-btn", label: "打开文件", glyph: "📂" },
  { id: "files-btn", label: "文件浏览器", glyph: "🗂" },
  { id: "font-dec", label: "缩小字体", glyph: "A−" },
  { id: "font-inc", label: "放大字体", glyph: "A+" },
  { id: "wide-toggle", label: "宽版 / 窄版切换", glyph: "↔" },
  { id: "theme-toggle", label: "切换配色主题", glyph: "🖥️" },
  { id: "settings-btn", label: "设置", glyph: "⚙", locked: true },
  { id: "save-btn", label: "保存", glyph: "💾" },
  // Android edits a sandbox copy, so writing a real file out needs its own step.
  { id: "save-as-btn", label: "另存为", glyph: "📤", androidOnly: true },
  { id: "export-btn", label: "导出为 HTML", glyph: "⬇" },
  { id: "edit-toggle", label: "切换编辑模式", glyph: "✎" },
  { id: "toc-toggle", label: "切换大纲", glyph: "☰" },
  { id: "close-doc-btn", label: "关闭文档", glyph: "✕" },
];
const TOOLBAR_ORDER_KEY = "toolbarOrder";
const TOOLBAR_HIDDEN_KEY = "toolbarHidden";
const DOCK_SIDE_KEY = "dockSide";
const DOCK_CORNER_KEY = "dockCorner";
const DOCK_HANDLE_KEY = "dockHandleVisible";

const toolbarEl = document.getElementById("toolbar") as HTMLElement;
const toolbarHotzone = document.getElementById("toolbar-hotzone") as HTMLElement;
const tbListEl = document.getElementById("tb-list") as HTMLElement;
const tbResetBtn = document.getElementById("tb-reset") as HTMLButtonElement;

// Saved order (ids), filtered to known buttons, then any missing ones appended
// in default order so new buttons in a future version still show up.
function readToolbarOrder(): string[] {
  const known = new Set(TOOLBAR_BUTTONS.map((b) => b.id));
  let saved: string[] = [];
  try {
    const raw = localStorage.getItem(TOOLBAR_ORDER_KEY);
    if (raw) saved = (JSON.parse(raw) as string[]).filter((id) => known.has(id));
  } catch {
    /* corrupt value — fall back to the default order */
  }
  const missing = TOOLBAR_BUTTONS.map((b) => b.id).filter((id) => !saved.includes(id));
  return [...saved, ...missing];
}

function readToolbarHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(TOOLBAR_HIDDEN_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* corrupt value — treat as nothing hidden */
  }
  return new Set();
}

function saveToolbarState(order: string[], hidden: Set<string>): void {
  localStorage.setItem(TOOLBAR_ORDER_KEY, JSON.stringify(order));
  localStorage.setItem(TOOLBAR_HIDDEN_KEY, JSON.stringify([...hidden]));
}

// Buttons whose visibility is driven by app state, not by the user:
// Save only exists in edit mode, ✕ only once a document is open, and "save as"
// only on Android with a document loaded.
const STATE_DRIVEN = new Set(["save-btn", "save-as-btn", "close-doc-btn"]);

function applyToolbarLayout(): void {
  const order = readToolbarOrder();
  const hidden = readToolbarHidden();

  for (const id of order) {
    const el = document.getElementById(id);
    if (el) toolbarEl.appendChild(el);
  }

  for (const btn of TOOLBAR_BUTTONS) {
    const el = document.getElementById(btn.id);
    if (!el) continue;
    // Buttons whose feature cannot work on this platform never appear.
    if (btn.androidHidden && IS_ANDROID) {
      el.hidden = true;
      continue;
    }
    // Mobile-only buttons stay out of the way on desktop.
    if (btn.androidOnly && !IS_ANDROID) {
      el.hidden = true;
      continue;
    }
    const shouldHide = !btn.locked && hidden.has(btn.id);
    if (STATE_DRIVEN.has(btn.id)) {
      // Remember the user's preference here; setTitle() decides the rest.
      el.dataset.userHidden = shouldHide ? "1" : "";
    } else {
      el.hidden = shouldHide;
    }
  }
  // Re-apply state-driven visibility for the current document/edit mode.
  if (typeof setTitle === "function" && currentPath !== null) setTitle();
  if (typeof syncToolbarHotzone === "function") syncToolbarHotzone();
}

// Build the checkbox + reorder list shown in Settings.
function renderToolbarList(): void {
  const order = readToolbarOrder();
  const hidden = readToolbarHidden();
  tbListEl.innerHTML = "";

  order.forEach((id, index) => {
    const btn = TOOLBAR_BUTTONS.find((b) => b.id === id);
    if (!btn) return;
    // Do not offer a toggle for something that can never appear here.
    if (btn.androidHidden && IS_ANDROID) return;
    if (btn.androidOnly && !IS_ANDROID) return;

    const row = document.createElement("div");
    row.className = "tb-row" + (btn.locked ? " tb-locked" : "");

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = btn.locked || !hidden.has(id);
    cb.disabled = !!btn.locked;
    cb.addEventListener("change", () => {
      const nextHidden = readToolbarHidden();
      if (cb.checked) nextHidden.delete(id);
      else nextHidden.add(id);
      saveToolbarState(readToolbarOrder(), nextHidden);
      applyToolbarLayout();
    });

    const glyph = document.createElement("span");
    glyph.className = "tb-glyph";
    glyph.textContent = btn.glyph;

    const text = document.createElement("span");
    text.className = "tb-label";
    text.textContent = btn.label;

    label.append(cb, glyph, text);
    row.appendChild(label);

    const up = document.createElement("button");
    up.className = "tb-move";
    up.textContent = "↑";
    up.title = "上移";
    up.disabled = index === 0;
    up.addEventListener("click", () => moveToolbarItem(index, -1));

    const down = document.createElement("button");
    down.className = "tb-move";
    down.textContent = "↓";
    down.title = "下移";
    down.disabled = index === order.length - 1;
    down.addEventListener("click", () => moveToolbarItem(index, 1));

    row.append(up, down);
    tbListEl.appendChild(row);
  });
}

function moveToolbarItem(index: number, delta: number): void {
  const order = readToolbarOrder();
  const target = index + delta;
  if (target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  saveToolbarState(order, readToolbarHidden());
  applyToolbarLayout();
  renderToolbarList();
}

tbResetBtn.addEventListener("click", () => {
  localStorage.removeItem(TOOLBAR_ORDER_KEY);
  localStorage.removeItem(TOOLBAR_HIDDEN_KEY);
  applyToolbarLayout();
  renderToolbarList();
});

applyToolbarLayout();

// --- Hot zone sizing: the trapezoid must match the live toolbar width. ---
// The toolbar is right-anchored and sized by its content, so its width changes
// whenever buttons are shown, hidden or reordered. Mirror that width (plus the
// bar's right offset) onto the hot zone so the two always line up.
function syncToolbarHotzone(): void {
  const bar = toolbarEl.getBoundingClientRect();
  const root = document.documentElement;
  if (bar.width > 0) {
    root.style.setProperty("--toolbar-width", `${Math.ceil(bar.width)}px`);
    const right = Math.round(window.innerWidth - bar.right);
    root.style.setProperty("--toolbar-right", `${right}px`);
  }
}

// Keep it in sync as the window, the toolbar contents, and fonts change.
window.addEventListener("resize", syncToolbarHotzone);
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(syncToolbarHotzone).observe(toolbarEl);
}
syncToolbarHotzone();

// --- Auto-hide: the bar sits off-screen until the top edge is approached. ---
let toolbarPinned = false; // dialogs force the bar to stay visible
let toolbarHideTimer: number | undefined;

function showToolbar(): void {
  window.clearTimeout(toolbarHideTimer);
  document.body.classList.add("toolbar-shown");
}
function hideToolbar(): void {
  // Keep it up while the keyboard focus lives inside the bar. A mouse click
  // also focuses a button, so only honour focus that came from the keyboard.
  if (toolbarPinned) return;
  const focused = document.activeElement;
  if (focused && toolbarEl.contains(focused) && focused.matches(":focus-visible")) {
    return;
  }
  document.body.classList.remove("toolbar-shown");
}
function hideToolbarSoon(): void {
  window.clearTimeout(toolbarHideTimer);
  toolbarHideTimer = window.setTimeout(hideToolbar, 220);
}

// Android swaps the hover model for the docked sheet (see src/dock.ts). On
// desktop the original hover behaviour is registered exactly as before.
let dock: DockController | null = null;

if (USE_DOCKED_TOOLBAR) {
  dock = new DockController({
    bar: toolbarEl,
    hotzone: toolbarHotzone,
    side: parseSide(localStorage.getItem(DOCK_SIDE_KEY)),
    handleCorner: parseCorner(localStorage.getItem(DOCK_CORNER_KEY)),
    // Default on: without it a user who has not discovered tap-to-reveal has
    // no visible way in at all.
    handleVisible: localStorage.getItem(DOCK_HANDLE_KEY) !== "false",
    storageKey: DOCK_SIDE_KEY,
    onToggle: () => {
      // The reading position shifts when the sheet overlays the text.
      syncToolbarHotzone();
    },
  });
} else {
  // Approaching the top edge reveals the bar; leaving it starts the hide timer.
  toolbarHotzone.addEventListener("mouseenter", showToolbar);
  toolbarHotzone.addEventListener("mouseleave", hideToolbarSoon);
  toolbarEl.addEventListener("mouseenter", showToolbar);
  toolbarEl.addEventListener("mouseleave", hideToolbarSoon);
}

// Dock settings are Android-only; on desktop the hint text and the selects stay
// out of the way entirely.
const dockSettingsEl = document.getElementById("dock-settings") as HTMLElement | null;
const dockSideSel = document.getElementById("dock-side") as HTMLSelectElement | null;
const dockCornerSel = document.getElementById("dock-corner") as HTMLSelectElement | null;
const tbHintDesktop = document.getElementById("tb-hint-desktop") as HTMLElement | null;

if (USE_DOCKED_TOOLBAR && dock && dockSettingsEl && dockSideSel && dockCornerSel) {
  dockSettingsEl.hidden = false;
  if (tbHintDesktop) tbHintDesktop.hidden = true;

  dockSideSel.value = parseSide(localStorage.getItem(DOCK_SIDE_KEY));
  dockCornerSel.value = parseCorner(localStorage.getItem(DOCK_CORNER_KEY));

  dockSideSel.addEventListener("change", () => {
    const side = parseSide(dockSideSel.value);
    localStorage.setItem(DOCK_SIDE_KEY, side);
    dock?.applySide(side);
  });
  dockCornerSel.addEventListener("change", () => {
    const corner = parseCorner(dockCornerSel.value);
    localStorage.setItem(DOCK_CORNER_KEY, corner);
    dock?.applyCorner(corner);
  });

  // Handle visibility. Previously this was only read at startup, so ticking
  // the box did nothing until a restart — the reported bug.
  const dockHandleToggle = document.getElementById(
    "dock-handle-visible",
  ) as HTMLInputElement | null;
  if (dockHandleToggle) {
    dockHandleToggle.checked = localStorage.getItem(DOCK_HANDLE_KEY) !== "false";
    dockHandleToggle.addEventListener("change", () => {
      localStorage.setItem(DOCK_HANDLE_KEY, String(dockHandleToggle.checked));
      dock?.setHandleVisible(dockHandleToggle.checked);
    });
  }
}

// Keyboard users: focusing any button must bring the bar into view.
toolbarEl.addEventListener("focusin", showToolbar);
toolbarEl.addEventListener("focusout", () => {
  // Wait for the focus to settle before deciding to hide.
  window.setTimeout(hideToolbar, 0);
});

// Leaving the window entirely also hides it (desktop only).
if (!USE_DOCKED_TOOLBAR) {
  document.addEventListener("mouseleave", hideToolbarSoon);
}

// Expose a pin/unpin pair for dialogs opened from the toolbar.
function setToolbarPinned(pinned: boolean): void {
  toolbarPinned = pinned;
  if (pinned) showToolbar();
}

// First run: show the bar briefly so new users discover it (desktop only).
if (!USE_DOCKED_TOOLBAR && localStorage.getItem("toolbarSeen") !== "1") {
  showToolbar();
  window.setTimeout(() => {
    localStorage.setItem("toolbarSeen", "1");
    hideToolbar();
  }, 2200);
}

// Content font scaling (persisted).
let fontScale = parseFloat(localStorage.getItem("fontScale") ?? "1") || 1;
function applyFontScale(): void {
  fontScale = Math.min(2.6, Math.max(0.6, Math.round(fontScale * 10) / 10));
  document.documentElement.style.setProperty("--content-scale", String(fontScale));
  localStorage.setItem("fontScale", String(fontScale));
}
function bumpFont(delta: number): void {
  fontScale += delta;
  applyFontScale();
}
fontInc.addEventListener("click", () => bumpFont(0.1));
fontDec.addEventListener("click", () => bumpFont(-0.1));
applyFontScale();

// Wide-content mode: fill the available width instead of the centered column.
// Defaults to wide when the user has no saved preference yet.
let wideContent = (localStorage.getItem("wideContent") ?? "true") === "true";
function applyWide(): void {
  layout.classList.toggle("wide-content", wideContent);
  wideToggle.classList.toggle("on", wideContent);
  localStorage.setItem("wideContent", String(wideContent));
}
function toggleWide(): void {
  wideContent = !wideContent;
  applyWide();
}
wideToggle.addEventListener("click", toggleWide);
applyWide();

// Cycle the color theme: system → light → dark → system.
const THEME_ICON: Record<ThemePref, string> = {
  system: ICON_SVG.themeSystem,
  light: ICON_SVG.themeLight,
  dark: ICON_SVG.themeDark,
};
const THEME_TITLE: Record<ThemePref, string> = {
  system: "主题：跟随系统 （点击切换）",
  light: "主题：亮色 （点击切换）",
  dark: "主题：暗色 （点击切换）",
};
function applyTheme(): void {
  document.documentElement.dataset.theme = themePref;
  hljsStyle.textContent = currentDark() ? hljsDarkCss : hljsLightCss;
  setIconButton(themeToggle, THEME_ICON[themePref]);
  themeToggle.title = THEME_TITLE[themePref];
  localStorage.setItem("theme", themePref);
  // Re-render the open document so mermaid diagrams pick up the new theme
  // (highlighted code recolors automatically via the swapped <style>).
  if (currentPath) {
    void renderMarkdown(editMode ? editor.value : currentText, true);
  }
}
function cycleTheme(): void {
  themePref =
    themePref === "system" ? "light" : themePref === "light" ? "dark" : "system";
  applyTheme();
}
themeToggle.addEventListener("click", cycleTheme);
// Follow live OS theme changes while in "system" mode.
systemDarkMQ.addEventListener("change", () => {
  if (themePref === "system") applyTheme();
});
applyTheme();

// ---------- Settings: reading font (separate Latin + CJK) ----------
// Each option is a fallback stack; unavailable fonts degrade gracefully, and
// the browser's last-resort fallback still renders glyphs a font lacks.
interface FontOption {
  id: string;
  label: string;
  stack: string; // families only (no generic); empty = system default
  generic?: string; // appended after the CJK families
}
const DEFAULT_LATIN_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial';
const LATIN_FONTS: FontOption[] = [
  { id: "system", label: "系统默认 Sans", stack: DEFAULT_LATIN_STACK, generic: "sans-serif" },
  { id: "serif", label: "Serif (Georgia)", stack: 'Georgia, "Times New Roman"', generic: "serif" },
  { id: "helvetica", label: "Helvetica / Arial", stack: "Helvetica, Arial", generic: "sans-serif" },
  { id: "verdana", label: "Verdana", stack: "Verdana, Geneva", generic: "sans-serif" },
  { id: "mono", label: "等宽 Mono", stack: "ui-monospace, Consolas", generic: "monospace" },
];
const CJK_FONTS: FontOption[] = [
  { id: "system", label: "系统默认", stack: "" },
  {
    id: "yahei",
    label: "微软雅黑 / 苹方",
    stack: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB"',
  },
  {
    id: "notosans",
    label: "思源黑体 Noto Sans",
    stack: '"Noto Sans SC", "Source Han Sans SC", "Noto Sans CJK SC"',
  },
  {
    id: "notoserif",
    label: "思源宋体 Noto Serif",
    stack: '"Noto Serif SC", "Source Han Serif SC", "Noto Serif CJK SC"',
  },
  { id: "kai", label: "楷体", stack: 'KaiTi, "Kaiti SC", STKaiti' },
  { id: "simsun", label: "宋体", stack: 'SimSun, "Songti SC", STSong' },
  // Traditional-Chinese faces, kept for reading 繁體 documents.
  {
    id: "pmingliu",
    label: "繁体 · 微软正黑体",
    stack: '"Microsoft JhengHei", "PingFang TC"',
  },
  {
    id: "pmingliu_song",
    label: "繁体 · 新细明体",
    stack: '"PMingLiU", "MingLiU", "Songti TC"',
  },
  {
    id: "pmingliu_kai",
    label: "繁体 · 标楷体",
    stack: '"DFKai-SB", "BiauKai", "Kaiti TC"',
  },
];

const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const settingsModal = document.getElementById("settings-modal") as HTMLElement;
const fontLatinSel = document.getElementById("font-latin") as HTMLSelectElement;
const fontCjkSel = document.getElementById("font-cjk") as HTMLSelectElement;
const fontLatinCustomEl = document.getElementById("font-latin-custom") as HTMLInputElement;
const fontCjkCustomEl = document.getElementById("font-cjk-custom") as HTMLInputElement;
const fontList = document.getElementById("font-list") as HTMLDataListElement;

function fillFontSelect(sel: HTMLSelectElement, opts: FontOption[]): void {
  opts.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.label;
    sel.appendChild(opt);
  });
  // "Custom" lets the user type any installed font family by name.
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "自定义… / Custom…";
  sel.appendChild(custom);
}
fillFontSelect(fontLatinSel, LATIN_FONTS);
fillFontSelect(fontCjkSel, CJK_FONTS);

let fontLatinId = localStorage.getItem("fontLatin") ?? "system";
let fontCjkId = localStorage.getItem("fontCjk") ?? "system";
let fontLatinCustom = localStorage.getItem("fontLatinCustom") ?? "";
let fontCjkCustom = localStorage.getItem("fontCjkCustom") ?? "";

// Turn a typed font name into a CSS family fragment (quote it unless the user
// already typed a comma-separated stack of their own).
function toFamily(v: string): string {
  const t = v.trim();
  if (!t) return "";
  return t.includes(",") ? t : `"${t.replace(/["']/g, "")}"`;
}

function applyReadingFont(): void {
  const latin = LATIN_FONTS.find((f) => f.id === fontLatinId) ?? LATIN_FONTS[0];
  const latinStack = fontLatinId === "custom" ? toFamily(fontLatinCustom) : latin.stack;
  const latinGeneric = fontLatinId === "custom" ? "sans-serif" : latin.generic ?? "sans-serif";
  const cjkStack =
    fontCjkId === "custom"
      ? toFamily(fontCjkCustom)
      : (CJK_FONTS.find((f) => f.id === fontCjkId) ?? CJK_FONTS[0]).stack;

  const parts = [latinStack, cjkStack, latinGeneric,
    '"Apple Color Emoji"', '"Segoe UI Emoji"'].filter(Boolean);
  document.documentElement.style.setProperty("--reading-font", parts.join(", "));

  fontLatinSel.value = fontLatinId;
  fontCjkSel.value = fontCjkId;
  fontLatinCustomEl.hidden = fontLatinId !== "custom";
  fontCjkCustomEl.hidden = fontCjkId !== "custom";
  fontLatinCustomEl.value = fontLatinCustom;
  fontCjkCustomEl.value = fontCjkCustom;

  localStorage.setItem("fontLatin", fontLatinId);
  localStorage.setItem("fontCjk", fontCjkId);
  localStorage.setItem("fontLatinCustom", fontLatinCustom);
  localStorage.setItem("fontCjkCustom", fontCjkCustom);
}
fontLatinSel.addEventListener("change", () => {
  fontLatinId = fontLatinSel.value;
  applyReadingFont();
  if (fontLatinId === "custom") fontLatinCustomEl.focus();
});
fontCjkSel.addEventListener("change", () => {
  fontCjkId = fontCjkSel.value;
  applyReadingFont();
  if (fontCjkId === "custom") fontCjkCustomEl.focus();
});
fontLatinCustomEl.addEventListener("input", () => {
  fontLatinCustom = fontLatinCustomEl.value;
  applyReadingFont();
});
fontCjkCustomEl.addEventListener("input", () => {
  fontCjkCustom = fontCjkCustomEl.value;
  applyReadingFont();
});
(document.getElementById("settings-reset") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    fontLatinId = "system";
    fontCjkId = "system";
    applyReadingFont();
  },
);

// Populate the autocomplete list with actually-installed fonts (once). Uses the
// Local Font Access API — available on WebView2/Windows; on WKWebView (macOS)
// and WebKitGTK (Linux) it's absent, so users just type the name manually.
let fontsQueried = false;
async function populateInstalledFonts(): Promise<void> {
  if (fontsQueried) return;
  fontsQueried = true;
  const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> })
    .queryLocalFonts;
  if (typeof query !== "function") return;
  try {
    const fonts = await query();
    const seen = new Set<string>();
    for (const f of fonts) {
      if (f.family && !seen.has(f.family)) {
        seen.add(f.family);
        const o = document.createElement("option");
        o.value = f.family;
        fontList.appendChild(o);
      }
    }
  } catch {
    /* unsupported or permission denied — manual typing still works */
  }
}

// ---------- Settings tabs ----------
type SettingsTab = "font" | "toolbar" | "statusbar" | "about";
let activeSettingsTab: SettingsTab = "font";

function activateSettingsTab(tab: SettingsTab): void {
  activeSettingsTab = tab;
  for (const btn of settingsModal.querySelectorAll<HTMLElement>(".settings-tab")) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
  }
  for (const pane of settingsModal.querySelectorAll<HTMLElement>(".settings-pane")) {
    pane.classList.toggle("active", pane.id === `pane-${tab}`);
  }
  // The toolbar list is rebuilt on entry so it always mirrors saved state.
  if (tab === "toolbar") renderToolbarList();
}

for (const btn of settingsModal.querySelectorAll<HTMLElement>(".settings-tab")) {
  btn.addEventListener("click", () => {
    activateSettingsTab(btn.dataset.tab as SettingsTab);
  });
  // Left/Right arrows move between tabs, as expected of a tablist.
  btn.addEventListener("keydown", (ev) => {
    const order: SettingsTab[] = ["font", "toolbar", "statusbar", "about"];
    const i = order.indexOf(btn.dataset.tab as SettingsTab);
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    ev.preventDefault();
    const next = ev.key === "ArrowRight"
      ? order[(i + 1) % order.length]
      : order[(i - 1 + order.length) % order.length];
    activateSettingsTab(next);
    settingsModal.querySelector<HTMLElement>(`.settings-tab[data-tab="${next}"]`)?.focus();
  });
}

function openSettings(): void {
  settingsModal.hidden = false;
  activateSettingsTab(activeSettingsTab);
  renderToolbarList();
  void populateInstalledFonts();
}
function closeSettings(): void {
  settingsModal.hidden = true;
  setToolbarPinned(false);
  hideToolbarSoon();
}
settingsBtn.addEventListener("click", () => {
  setToolbarPinned(true);
  openSettings();
});
(document.getElementById("settings-close") as HTMLButtonElement).addEventListener(
  "click",
  closeSettings,
);
// Click the dimmed backdrop (outside the box) to dismiss.
settingsModal.addEventListener("click", (ev) => {
  if (ev.target === settingsModal) closeSettings();
});
applyReadingFont();

// ---------- Status bar preferences ----------
// Two independent switches: whether the bar exists, and whether it carries the
// full path on its own row.
const showStatusBarToggle = document.getElementById("show-statusbar") as HTMLInputElement;
showStatusBarToggle.checked = showStatusBarEnabled();
showStatusBarToggle.addEventListener("change", () => {
  localStorage.setItem(SHOW_STATUSBAR_KEY, String(showStatusBarToggle.checked));
  // Hiding the bar also hides the path row, so drop the reserved space too.
  document.body.classList.toggle("no-statusbar", !showStatusBarToggle.checked);
  updateStatusBar();
});
document.body.classList.toggle("no-statusbar", !showStatusBarEnabled());

const showPathToggle = document.getElementById("show-path") as HTMLInputElement;
showPathToggle.checked = showPathEnabled();
showPathToggle.addEventListener("change", () => {
  localStorage.setItem(SHOW_PATH_KEY, String(showPathToggle.checked));
  updateStatusBar();
});

// Keep the progress percentage live while scrolling.
content.addEventListener("scroll", updateStatusBar, { passive: true });
// The bar changes height when the path row appears, so re-measure on resize too.
window.addEventListener("resize", syncStatusBarHeight);

// Clicking the path in the status bar copies it.
sbPath.addEventListener("click", () => void copyPathToClipboard());
sbPath.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    void copyPathToClipboard();
  }
});

// ---------- Check for updates (GitHub latest release) ----------
const updateCheckBtn = document.getElementById("update-check") as HTMLButtonElement;
const updateStatus = document.getElementById("update-status") as HTMLElement;
const updateCurrent = document.getElementById("update-current") as HTMLElement;
updateCurrent.textContent = `v${__APP_VERSION__}`;

// Compare dotted versions: >0 if a newer than b, <0 if older, 0 if equal.
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function showUpdateStatus(text: string, isNew = false, url?: string): void {
  updateStatus.hidden = false;
  updateStatus.classList.toggle("new", isNew);
  updateStatus.textContent = text;
  if (url) {
    const a = document.createElement("a");
    a.textContent = "前往下载";
    a.href = "#";
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openUrl(url);
    });
    updateStatus.append(" ", a);
  }
}

async function checkUpdate(): Promise<void> {
  updateCheckBtn.disabled = true;
  showUpdateStatus("检查中…");
  try {
    const res = await fetch(
      "https://api.github.com/repos/lonswon/bookMDViewer/releases/latest",
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = (data.tag_name ?? "").replace(/^v/, "");
    if (!latest) throw new Error("no tag");
    if (compareVersions(latest, __APP_VERSION__) > 0) {
      showUpdateStatus(`发现新版 v${latest}`, true, data.html_url);
    } else {
      showUpdateStatus("已是最新版本 ✓");
    }
  } catch {
    showUpdateStatus("无法检查更新（请确认网络）");
  } finally {
    updateCheckBtn.disabled = false;
  }
}
updateCheckBtn.addEventListener("click", () => void checkUpdate());

// ---------- About dialog (version info) ----------
const REPO_URL = "https://github.com/lonswon/bookMDViewer";
const aboutModal = document.getElementById("about-modal") as HTMLElement;
const aboutVersion = document.getElementById("about-version") as HTMLElement;
aboutVersion.textContent = `v${__APP_VERSION__}`;
document.getElementById("about-close")?.addEventListener("click", () => {
  aboutModal.hidden = true;
});
document.getElementById("about-github")?.addEventListener("click", () => {
  void openUrl(REPO_URL);
});

// ---------- Open file dialog + recent files ----------
//
/// Ensure the app can reach storage, asking once if needed.
///
/// Returns false only when the user explicitly denied it, so callers can explain
/// why the picker is about to fail. Cached for the session: re-asking on every
/// file open would be noise.
let storagePermission: boolean | null = null;
async function ensureStoragePermission(): Promise<boolean> {
  if (!IS_ANDROID) return true;
  if (storagePermission !== null) return storagePermission;
  try {
    const already = await invoke<boolean>("has_storage_permission");
    if (already) {
      storagePermission = true;
      return true;
    }
    storagePermission = await invoke<boolean>("request_storage_permission");
    if (!storagePermission) {
      toast("未获得存储权限，可能无法打开文件");
    }
  } catch (e) {
    // A failing permission probe must not block the picker: SAF can still work.
    console.warn("storage permission check failed", e);
    storagePermission = true;
  }
  return storagePermission;
}

async function pickFile(): Promise<string | null> {
  if (!IS_ANDROID) {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    return typeof selected === "string" ? selected : null;
  }
  // Make sure the app actually holds storage access before opening the picker.
  // On Android 11+ this is a no-op that resolves true; on 10 and below it is what
  // triggers the system permission dialog.
  await ensureStoragePermission();
  const fs = await import("tauri-plugin-android-fs-api");
  // Returns an array; we asked for a single pick.
  const picked = await fs.showOpenFilePicker({
    mimeTypes: [
      "text/markdown",
      "text/x-markdown",
      "application/markdown",
      "application/x-markdown",
      "text/plain",
      "application/octet-stream",
    ],
    multiple: false,
    localOnly: true,
    needWritePermission: false,
  });
  const uri = picked[0];
  if (!uri) return null;
  // Keep the grant across restarts so a later re-import can still read the file.
  await fs.persistPickerUriPermission(uri).catch(() => {});
  return await importDocument(uri.uri);
}

/// Copy a `content://` document into app storage and return its local path.
///
/// Everything downstream (reading, editing, images, the folder browser) then
/// works on an ordinary path, which is why those features exist on Android at
/// all. The trade-off is that the copy is what gets edited; the original is
/// untouched until the user explicitly exports.
async function importDocument(uri: string): Promise<string> {
  const doc = await invoke<{ path: string; name: string; cached: boolean }>(
    "import_document",
    { uri },
  );
  if (!doc.cached) toast(`已导入 ${doc.name}`);
  return doc.path;
}

async function openViaDialog(): Promise<void> {
  try {
    const path = await pickFile();
    if (path) await openFile(path);
  } catch (e) {
    toast(`打开失败：${String(e)}`);
  }
}
openBtn.addEventListener("click", () => void openViaDialog());
// Delegated so the empty-state links keep working after goHome() rebuilds them.
content.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  if (target.closest("#empty-open")) {
    ev.preventDefault();
    void openViaDialog();
  } else if (target.closest("#about-open")) {
    ev.preventDefault();
    aboutModal.hidden = false;
  }
});

function getRecents(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem("recents") ?? "[]") as string[];
    // On Android, entries written by older versions are `content://` URIs from
    // before documents were imported; they can no longer be opened, so drop
    // them instead of leaving dead links in the list.
    if (IS_ANDROID) return list.filter((p) => !p.startsWith("content://"));
    return list;
  } catch {
    return [];
  }
}
function addRecent(path: string): void {
  const list = getRecents().filter((p) => p !== path);
  list.unshift(path);
  localStorage.setItem("recents", JSON.stringify(list.slice(0, 8)));
}
function renderRecents(): void {
  const host = document.getElementById("recent-list");
  if (!host) return;
  host.innerHTML = "";
  const list = getRecents();
  if (!list.length) return;
  const h = document.createElement("h3");
  h.textContent = "最近打开";
  host.appendChild(h);
  list.forEach((p) => {
    const a = document.createElement("a");
    a.className = "recent-item";
    a.href = "#";
    const name = document.createElement("span");
    name.className = "rf-name";
    name.textContent = displayName(p);
    const full = document.createElement("span");
    full.className = "rf-path";
    // A raw content:// URI is unreadable, so on Android the sub-line shows the
    // decoded document path (minus the file name, which the title already has).
    // Falling back to the name alone would just repeat the line above.
    const sub = IS_ANDROID ? "应用内副本" : p;
    if (sub && sub !== displayName(p)) {
      full.textContent = sub;
      a.append(name, full);
    } else {
      a.append(name);
    }
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openFile(p);
    });
    host.appendChild(a);
  });
}

// ---------- File explorer panel ----------
interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}
interface DirListing {
  dir: string;
  parent: string | null;
  entries: DirEntry[];
}

let filesOpen = localStorage.getItem("filesOpen") === "true";
function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, "");
}

function fileRow(
  label: string,
  icon: string,
  onClick: () => void,
  opts: { active?: boolean; muted?: boolean; onContext?: (ev: MouseEvent) => void } = {},
): HTMLElement {
  const a = document.createElement("a");
  a.className = "file-item";
  if (opts.active) a.classList.add("active");
  if (opts.muted) a.classList.add("muted");
  a.href = "#";
  const ic = document.createElement("span");
  ic.className = "fi-icon";
  ic.textContent = icon;
  const nm = document.createElement("span");
  nm.className = "fi-name";
  nm.textContent = label;
  a.append(ic, nm);
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    onClick();
  });
  if (opts.onContext) a.addEventListener("contextmenu", opts.onContext);
  return a;
}

// Right-click context menu for files.
let fileMenuEl: HTMLElement | null = null;
function closeFileMenu(): void {
  fileMenuEl?.remove();
  fileMenuEl = null;
}
function showFileMenu(ev: MouseEvent, path: string): void {
  ev.preventDefault();
  closeFileMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  const item = document.createElement("button");
  item.textContent = "在新窗口打开";
  item.addEventListener("click", () => {
    closeFileMenu();
    void invoke("open_new_window", { path });
  });
  // Android has no multi-window instance model.
  if (!IS_ANDROID) menu.appendChild(item);
  document.body.appendChild(menu);
  // Keep within the viewport.
  const mw = 180;
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - mw)}px`;
  menu.style.top = `${ev.clientY}px`;
  fileMenuEl = menu;
}
window.addEventListener("click", closeFileMenu);
window.addEventListener("blur", closeFileMenu);

async function renderFiles(dir: string | null): Promise<void> {
  if (!dir) {
    // Desktop: nothing to list yet, ask the user to open a file first.
    // Android: every document lives in the import area, so show the whole
    // library — that is the only browseable "folder" the app owns.
    if (!IS_ANDROID) {
      filesPanel.innerHTML = "";
      const hint = document.createElement("div");
      hint.className = "files-hint";
      hint.textContent = "打开文件后可浏览其目录";
      filesPanel.appendChild(hint);
      return;
    }
    dir = "";
  }
  let listing: DirListing;
  try {
    listing = await invoke<DirListing>("list_dir", { path: dir });
  } catch (e) {
    // Keep the current view; just report (e.g. typed a path that doesn't exist).
    toast(String(e));
    return;
  }

  filesPanel.innerHTML = "";

  if (IS_ANDROID) {
    // The sandbox path is meaningless to a phone user, and there is no way to
    // type a different one, so show a plain heading instead of an edit box.
    const head = document.createElement("div");
    head.className = "files-hint";
    head.textContent = listing.dir;
    filesPanel.appendChild(head);
  } else {
    // Editable full-path bar — type a folder and press Enter to jump there.
    const pathInput = document.createElement("input");
    pathInput.className = "files-path";
    pathInput.value = listing.dir;
    pathInput.spellcheck = false;
    pathInput.title = listing.dir;
    pathInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const v = pathInput.value.trim();
        if (v) void renderFiles(v);
      } else if (ev.key === "Escape") {
        pathInput.value = listing.dir;
        pathInput.blur();
      }
    });
    filesPanel.appendChild(pathInput);
  }

  if (listing.parent) {
    filesPanel.appendChild(
      fileRow("..", "📁", () => void renderFiles(listing.parent), {
        muted: true,
      }),
    );
  }
  for (const entry of listing.entries) {
    if (entry.is_dir) {
      filesPanel.appendChild(
        fileRow(entry.name, "📁", () => void renderFiles(entry.path)),
      );
    } else {
      filesPanel.appendChild(
        fileRow(entry.name, "📄", () => switchToFile(entry.path), {
          active: entry.path === currentPath,
          onContext: (ev) => showFileMenu(ev, entry.path),
        }),
      );
    }
  }
}

function switchToFile(path: string): void {
  if (path === currentPath) return;
  if (dirty) {
    closeAction = "switch";
    pendingSwitchPath = path;
    showCloseModal();
  } else {
    void openFile(path);
  }
}

function toggleFiles(): void {
  filesOpen = !filesOpen;
  layout.classList.toggle("files-open", filesOpen);
  localStorage.setItem("filesOpen", String(filesOpen));
  if (filesOpen) void renderFiles(currentPath ? dirOf(currentPath) : null);
}
filesBtn.addEventListener("click", toggleFiles);
if (filesOpen) layout.classList.add("files-open");

// ---------- Mermaid diagram lightbox (click to zoom/pan) ----------
const diagramModal = document.getElementById("diagram-modal") as HTMLElement;
const diagramStage = document.getElementById("diagram-stage") as HTMLElement;
const dgZoomLabel = document.getElementById("dg-zoom") as HTMLElement;
let dgEl: HTMLElement | null = null;
let dgScale = 1;
let dgX = 0;
let dgY = 0;
let dgNatW = 0;
let dgNatH = 0;

function dgApply(): void {
  if (dgEl) dgEl.style.transform = `translate(${dgX}px, ${dgY}px) scale(${dgScale})`;
  dgZoomLabel.textContent = `${Math.round(dgScale * 100)}%`;
}
function dgFit(): void {
  const sw = diagramStage.clientWidth;
  const sh = diagramStage.clientHeight;
  if (!dgNatW || !dgNatH) return;
  dgScale = Math.min(sw / dgNatW, sh / dgNatH, 1) || 1;
  dgX = (sw - dgNatW * dgScale) / 2;
  dgY = (sh - dgNatH * dgScale) / 2;
  dgApply();
}
function dgZoomAt(cx: number, cy: number, factor: number): void {
  const ns = Math.min(8, Math.max(0.1, dgScale * factor));
  const k = ns / dgScale;
  dgX = cx - (cx - dgX) * k;
  dgY = cy - (cy - dgY) * k;
  dgScale = ns;
  dgApply();
}
function openDiagram(svg: SVGElement): void {
  diagramStage.innerHTML = "";
  const card = document.createElement("div");
  card.className = "dg-card";
  const clone = svg.cloneNode(true) as SVGElement;
  const vb = (svg as SVGSVGElement).viewBox?.baseVal;
  clone.removeAttribute("style");
  if (vb && vb.width && vb.height) {
    clone.setAttribute("width", String(vb.width));
    clone.setAttribute("height", String(vb.height));
  }
  card.appendChild(clone);
  diagramStage.appendChild(card);
  dgEl = card;
  diagramModal.hidden = false;
  dgNatW = card.offsetWidth;
  dgNatH = card.offsetHeight;
  dgFit();
}
function closeDiagram(): void {
  diagramModal.hidden = true;
  diagramStage.innerHTML = "";
  dgEl = null;
}

diagramStage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = diagramStage.getBoundingClientRect();
    dgZoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);
let dgDragging = false;
let dgLastX = 0;
let dgLastY = 0;
diagramStage.addEventListener("mousedown", (e) => {
  dgDragging = true;
  dgLastX = e.clientX;
  dgLastY = e.clientY;
  diagramStage.classList.add("grabbing");
});
window.addEventListener("mousemove", (e) => {
  if (!dgDragging) return;
  dgX += e.clientX - dgLastX;
  dgY += e.clientY - dgLastY;
  dgLastX = e.clientX;
  dgLastY = e.clientY;
  dgApply();
});
window.addEventListener("mouseup", () => {
  dgDragging = false;
  diagramStage.classList.remove("grabbing");
});
function dgCenterZoom(factor: number): void {
  dgZoomAt(diagramStage.clientWidth / 2, diagramStage.clientHeight / 2, factor);
}
(document.getElementById("dg-zoomin") as HTMLButtonElement).addEventListener("click", () => dgCenterZoom(1.25));
(document.getElementById("dg-zoomout") as HTMLButtonElement).addEventListener("click", () => dgCenterZoom(0.8));
(document.getElementById("dg-reset") as HTMLButtonElement).addEventListener("click", dgFit);
(document.getElementById("dg-close") as HTMLButtonElement).addEventListener("click", closeDiagram);

// ---------- Find in document (Ctrl+F) ----------
function openFind(): void {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
}
function closeFind(): void {
  findBar.hidden = true;
  findCount.textContent = "";
  window.getSelection()?.removeAllRanges();
}
function runFind(backwards: boolean): void {
  const q = findInput.value;
  if (!q) {
    findCount.textContent = "";
    return;
  }
  // window.find(text, caseSensitive, backwards, wrapAround)
  const found = (
    window as unknown as {
      find: (s: string, c: boolean, b: boolean, w: boolean) => boolean;
    }
  ).find(q, false, backwards, true);
  findCount.textContent = found ? "" : "无相符";
}
findInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    runFind(ev.shiftKey);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeFind();
  }
});
findInput.addEventListener("input", () => runFind(false));
(document.getElementById("find-next") as HTMLButtonElement).addEventListener("click", () => runFind(false));
(document.getElementById("find-prev") as HTMLButtonElement).addEventListener("click", () => runFind(true));
(document.getElementById("find-close") as HTMLButtonElement).addEventListener("click", closeFind);

// ---------- Outline: collapsed by default ----------
// The sidebar used to open automatically for any document with 2+ headings,
// which competed with the reading column. It now starts collapsed and only
// expands when the user asks for it; that choice is remembered.
const TOC_OPEN_KEY = "tocOpen";

function applyTocState(): void {
  const open = localStorage.getItem(TOC_OPEN_KEY) === "true";
  layout.classList.toggle("toc-collapsed", !open);
  tocToggle.classList.toggle("on", open);
  tocToggle.setAttribute("aria-expanded", String(open));
}

function toggleToc(): void {
  const open = localStorage.getItem(TOC_OPEN_KEY) === "true";
  localStorage.setItem(TOC_OPEN_KEY, String(!open));
  applyTocState();
}
tocToggle.addEventListener("click", toggleToc);
applyTocState();
window.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey && (ev.key === "\\" || ev.key === "|")) {
    // Shift turns "\" into "|" on many layouts; treat both as the same chord.
    ev.preventDefault();
    if (ev.shiftKey) toggleWide();
    else toggleToc();
  } else if (ev.ctrlKey && (ev.key === "e" || ev.key === "E")) {
    ev.preventDefault();
    toggleEdit();
  } else if (ev.ctrlKey && (ev.key === "s" || ev.key === "S")) {
    ev.preventDefault();
    void save();
  } else if (ev.ctrlKey && (ev.key === "=" || ev.key === "+")) {
    ev.preventDefault();
    bumpFont(0.1);
  } else if (ev.ctrlKey && ev.key === "-") {
    ev.preventDefault();
    bumpFont(-0.1);
  } else if (ev.ctrlKey && (ev.key === "o" || ev.key === "O")) {
    ev.preventDefault();
    void openViaDialog();
  } else if (ev.ctrlKey && (ev.key === "f" || ev.key === "F")) {
    ev.preventDefault();
    openFind();
  } else if (ev.ctrlKey && (ev.key === "b" || ev.key === "B")) {
    ev.preventDefault();
    toggleFiles();
  } else if (ev.key === "Escape" && !diagramModal.hidden) {
    closeDiagram();
  } else if (ev.key === "Escape" && !settingsModal.hidden) {
    closeSettings();
  } else if (ev.key === "Escape" && !findBar.hidden) {
    closeFind();
  }
});

// Open external links in the user's default browser instead of navigating
// the webview away from the document.
content.addEventListener("click", (ev) => {
  const anchor = (ev.target as HTMLElement).closest("a");
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      ev.preventDefault();
      void openUrl(href);
    }
  }
});

// ---------- Window size persistence ----------
// macOS is single-instance and, when a window's Space is re-activated, the OS
// sometimes resizes it to fill the screen. We remember the user's size and
// restore it on focus so switching desktops keeps the chosen width.
interface WinSize {
  width: number;
  height: number;
}
// Matches the window's minWidth/minHeight in tauri.conf.json. Sizes below this
// are degenerate (e.g. the OS reports 0×0 while minimized) and must never be
// saved or restored — doing so shrinks the window to an unusable sliver.
const MIN_WIN_W = 400;
const MIN_WIN_H = 300;
function isSaneSize(w: unknown, h: unknown): w is number {
  return (
    typeof w === "number" &&
    typeof h === "number" &&
    w >= MIN_WIN_W &&
    h >= MIN_WIN_H
  );
}
function loadWinSize(): WinSize | null {
  try {
    const s = JSON.parse(localStorage.getItem("winSize") ?? "null");
    // Reject degenerate stored values so an upgrade auto-heals a corrupt size.
    return s && isSaneSize(s.width, s.height)
      ? { width: s.width, height: s.height }
      : null;
  } catch {
    return null;
  }
}
function saveWinSize(width: number, height: number): void {
  // Never persist a minimized / degenerate size.
  if (!isSaneSize(width, height)) return;
  localStorage.setItem(
    "winSize",
    JSON.stringify({ width: Math.round(width), height: Math.round(height) }),
  );
}

let suppressWinSaveUntil = 0;
let winSaveTimer: number | undefined;
let monitorWidth = 0; // cached (physical px) so the resize handler stays sync

async function refreshMonitorWidth(): Promise<void> {
  try {
    const m = await currentMonitor();
    if (m) monitorWidth = m.size.width;
  } catch {
    /* ignore */
  }
}

async function setupWindowSize(): Promise<void> {
  await refreshMonitorWidth();

  // Restore the last size on launch.
  const saved = loadWinSize();
  if (saved) {
    try {
      await appWindow.setSize(new PhysicalSize(saved.width, saved.height));
    } catch {
      /* ignore */
    }
  }

  // Persist user resizes (debounced). Skips saving while suppressed and ignores
  // a width that fills the monitor — that's the Spaces-switch jump, not a drag.
  await appWindow.onResized(({ payload }) => {
    if (Date.now() < suppressWinSaveUntil) return;
    if (monitorWidth && payload.width >= monitorWidth - 2) return;
    // Ignore minimized / degenerate sizes (0×0 etc.) — saveWinSize also guards.
    if (!isSaneSize(payload.width, payload.height)) return;
    const { width, height } = payload;
    window.clearTimeout(winSaveTimer);
    winSaveTimer = window.setTimeout(() => saveWinSize(width, height), 300);
  });

  // On regaining focus (e.g. switching back to this Space), restore the saved
  // size and briefly suppress saving so the OS resize can't overwrite it.
  await appWindow.onFocusChanged(({ payload: focused }) => {
    if (!focused) return;
    void refreshMonitorWidth();
    const s = loadWinSize();
    if (!s) return;
    suppressWinSaveUntil = Date.now() + 600;
    void appWindow.setSize(new PhysicalSize(s.width, s.height));
  });
}

async function init(): Promise<void> {
  // Remember/restore the window size (see setupWindowSize).
  await setupWindowSize();

  // Hot reload when the watched file changes on disk. Skip while editing or
  // when the change came from our own save.
  await listen<string>("md-changed", () => {
    if (currentPath && !editMode && Date.now() > suppressReloadUntil) {
      void openFile(currentPath, false, true);
    }
  });

  // macOS delivers file-association opens at runtime.
  await listen<string>("open-file", (ev) => {
    void openFile(ev.payload);
  });

  // Drag-and-drop a .md file onto the window (desktop only).
  if (!IS_ANDROID) {
    await getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "drop") {
        const file = ev.payload.paths.find((p) => /\.(md|markdown)$/i.test(p));
        if (file) {
          void openFile(file);
        }
      }
    });
  }

  // Intercept window close when there are unsaved edits.
  await appWindow.onCloseRequested((event) => {
    if (dirty) {
      event.preventDefault();
      closeAction = "window";
      showCloseModal();
    }
  });

  // Signal the backend that listeners are ready, flushing any file-open
  // requests that arrived during cold start (fixes macOS first-open blank).
  await invoke("frontend_ready");

  // Establish the initial window title (home screen) before any document
  // opens, so the native title bar never shows a stale name.
  setTitle();

  // Populate the empty-state recent-files list.
  renderRecents();

  // Restore the file-explorer panel if it was left open.
  if (filesOpen) void renderFiles(null);

  // File the app was launched with (Windows / Linux association).
  const initial = await invoke<string | null>("get_initial_path");
  if (initial) {
    await openFile(initial);
    // Optional `--edit` flag opens straight into edit mode.
    if (await invoke<boolean>("start_in_edit")) {
      setEditMode(true);
    }
  }

  // Optional `--zoom=<factor>` flag scales the whole UI (desktop only).
  if (!IS_ANDROID) {
    const zoom = await invoke<number>("start_zoom");
    if (zoom && zoom > 0) {
      await getCurrentWebview().setZoom(zoom);
    }
  }
}

void init();
