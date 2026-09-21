// =========================================================
// Shared helpers used by BOTH the public page (app.js)
// and the admin page (admin.js).
// =========================================================

import { SITE_URL } from "./hardin-config.js";

// ---------- Tiny DOM helper ----------
// Makes an element with an optional class and text.
// textContent keeps things safe: text is never run as HTML.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// ---------- Moods ----------
export const MOODS = {
  happy:  { emoji: "😃", label: "Happy" },
  sad:    { emoji: "😢", label: "Sad" },
  upset:  { emoji: "😠", label: "Upset" },
  love:   { emoji: "❤️", label: "Love" },
  praise: { emoji: "🌿", label: "Praise" }
};

// ---------- Folder colors ----------
export const COLOR_NAMES = {
  sage: "Sage",
  lichen: "Lichen",
  seed: "Seed gold",
  moss: "Moss",
  petal: "Petal",
  sand: "Sand"
};

// ---------- Icons (small line drawings, all in one place) ----------
function iconAttrs(size) {
  return `viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
}

const ICON_PATHS = {
  // The seedling: two leaves, a stem and a little soil line
  seedling:
    '<path d="M12 21v-9"/>' +
    '<path d="M12 13C7.5 13 5 10.5 5 6.5c4.5 0 7 2.5 7 6.5z" fill="currentColor" fill-opacity=".18"/>' +
    '<path d="M12 11c0-4 2.5-6.5 7-6.5 0 4-2.5 6.5-7 6.5z" fill="currentColor" fill-opacity=".18"/>' +
    '<path d="M8 21h8"/>',
  share:
    '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/>' +
    '<path d="M8.2 10.8l7.6-4.3M8.2 13.2l7.6 4.3"/>',
  eye:
    '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  search:
    '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  moon:
    '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun:
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  pin:
    '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/><path d="M12 14v7"/>',
  book:
    '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
  shuffle:
    '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  calendar:
    '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  bookmark:
    '<path d="M6.5 4h11v16.5L12 16.5l-5.5 4z"/>',
  grid:
    '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/>' +
    '<rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  list:
    '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.8" cy="6" r="1"/><circle cx="4.8" cy="12" r="1"/><circle cx="4.8" cy="18" r="1"/>',
  tree:
    '<path d="M5 4v14M5 8h5M5 16h5"/><rect x="10" y="5.5" width="9" height="5" rx="1.5"/><rect x="10" y="13.5" width="9" height="5" rx="1.5"/>'
};

// Returns a <span class="icon"> with the drawing inside.
// (These strings are written by me above, never from visitors, so innerHTML is safe here.)
export function icon(name, size) {
  const span = document.createElement("span");
  span.className = "icon";
  span.innerHTML = `<svg ${iconAttrs(size || 20)}>${ICON_PATHS[name] || ""}</svg>`;
  return span;
}

// ---------- Dates and reading time ----------

// Use the publish date if there is one, otherwise the created date
export function postDate(post) {
  return post.publishedAt || post.createdAt || null;
}

export function postDateMs(post) {
  const d = postDate(post);
  return d && d.toMillis ? d.toMillis() : 0;
}

export function formatDate(timestamp, short) {
  if (!timestamp || !timestamp.toDate) return "";
  return timestamp.toDate().toLocaleDateString("en-US", {
    year: "numeric",
    month: short ? "short" : "long",
    day: "numeric"
  });
}

export function wordCount(text) {
  const clean = (text || "").trim();
  return clean ? clean.split(/\s+/).length : 0;
}

// Average reading speed is about 200 words a minute
export function readMinutes(text) {
  return Math.max(1, Math.ceil(wordCount(text) / 200));
}

// ---------- Links ----------

// The address of index.html, wherever the site is hosted
export function siteBase() {
  return SITE_URL || new URL("index.html", location.href).href;
}

// Direct link to one post's page.
export function postLink(id) {
  return `${siteBase()}#/post/${id}`;
}

// ---------- Folder tree ----------
// Folders are stored flat in Firestore: { id, name, parentId, icon, color }.
// This turns that flat list into helpers for breadcrumbs, dropdowns and filters.
export function buildFolderTree(list) {
  const byId = {};
  list.forEach((f) => { byId[f.id] = f; });

  const kids = {};
  list.forEach((f) => {
    const key = f.parentId && byId[f.parentId] ? f.parentId : "root";
    if (!kids[key]) kids[key] = [];
    kids[key].push(f);
  });
  Object.keys(kids).forEach((key) => {
    kids[key].sort((a, b) => a.name.localeCompare(b.name));
  });

  // Folders directly inside a folder (null = the top level)
  function children(id) {
    return kids[id || "root"] || [];
  }

  // [Journal, School, English] for the English folder
  function path(id) {
    const result = [];
    let current = byId[id];
    let guard = 0;
    while (current && guard < 20) {
      result.unshift(current);
      current = current.parentId ? byId[current.parentId] : null;
      guard++;
    }
    return result;
  }

  function root(id) {
    return path(id)[0] || null;
  }

  // "Journal / School / English"
  function label(id) {
    return path(id).map((f) => f.name).join(" / ");
  }

  // This folder plus everything nested inside it
  function descendants(id) {
    const ids = new Set();
    (function walk(folderId) {
      if (ids.has(folderId)) return;
      ids.add(folderId);
      children(folderId).forEach((child) => walk(child.id));
    })(id);
    return ids;
  }

  // Every folder in reading order, with how deep it is
  function flat() {
    const out = [];
    (function walk(parentId, depth) {
      children(parentId).forEach((f) => {
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      });
    })(null, 0);
    return out;
  }

  // Icon and color come from the main (top-level) folder
  function look(id) {
    const r = root(id);
    return { icon: (r && r.icon) || "🌿", color: (r && r.color) || "sage" };
  }

  return { byId, children, path, root, label, descendants, flat, look };
}

// ---------- Article text ----------
// Turns the text you type into nicely formatted paragraphs, safely.
//   ## Heading          -> a heading
//   > Quote             -> a quote
//   - Item              -> a bullet list (every line starts with "- ")
//   **bold**  *italic*  [words](https://link)
//   blank line          -> new paragraph

function addInline(text, parent) {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https:\/\/[^\s)]+\))/g;
  text.split(pattern).forEach((part) => {
    if (!part) return;

    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      parent.appendChild(el("strong", "", part.slice(2, -2)));
    } else if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      parent.appendChild(el("em", "", part.slice(1, -1)));
    } else if (part.startsWith("[")) {
      const match = part.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/);
      if (match) {
        const link = el("a", "", match[1]);
        link.href = match[2];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.appendChild(link);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

export function renderBody(text, container) {
  const blocks = (text || "").replace(/\r\n/g, "\n").split(/\n{2,}/);

  blocks.forEach((raw) => {
    const block = raw.trim();
    if (!block) return;
    const lines = block.split("\n");

    if (block.startsWith("## ")) {
      const heading = el("h3");
      addInline(block.slice(3), heading);
      container.appendChild(heading);
    } else if (block.startsWith("> ")) {
      const quote = el("blockquote");
      const p = el("p");
      addInline(lines.map((l) => l.replace(/^>\s?/, "")).join(" "), p);
      quote.appendChild(p);
      container.appendChild(quote);
    } else if (lines.every((l) => l.startsWith("- "))) {
      const list = el("ul");
      lines.forEach((l) => {
        const item = el("li");
        addInline(l.slice(2), item);
        list.appendChild(item);
      });
      container.appendChild(list);
    } else {
      const p = el("p");
      lines.forEach((line, i) => {
        if (i > 0) p.appendChild(document.createElement("br"));
        addInline(line, p);
      });
      container.appendChild(p);
    }
  });
}

// ---------- Calendar days ----------
// Days are written as "2026-09-21" (year-month-day, in the visitor's own time zone).

export function dateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function keyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function isDayKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(key || "");
}

export function formatDayKey(key, long) {
  return keyToDate(key).toLocaleDateString("en-US", long
    ? { weekday: "long", year: "numeric", month: "long", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}

// Which day a post was published on
export function postDayKey(post) {
  const ts = postDate(post);
  return ts && ts.toDate ? dateKey(ts.toDate()) : "";
}

// ---------- Small utilities ----------

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Button feel: a small burst of leaves + a soft glow ----------
// One listener handles every button on the page (public and admin).
const EFFECT_TARGETS = [
  ".btn", ".icon-btn", ".react-btn", ".action-btn", ".save-btn", ".tab", ".fmt",
  ".contact", ".seg-btn", ".cal-nav", ".cal-day.has"
].join(",");

export function enableButtonEffects() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest(EFFECT_TARGETS);
    if (!target || target.disabled || target.getAttribute("aria-disabled") === "true") return;

    // A soft glow ring around whatever you pressed
    target.classList.remove("pulse");
    void target.offsetWidth;   // lets the animation restart
    target.classList.add("pulse");

    if (prefersReducedMotion()) return;

    // Leaves fly out from the click. The seedling gets a bigger burst when it turns on.
    const rect = target.getBoundingClientRect();
    const x = event.clientX || rect.left + rect.width / 2;
    const y = event.clientY || rect.top + rect.height / 2;
    const big = target.classList.contains("react-btn") && target.classList.contains("active");
    const count = big ? 10 : 5;

    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
      const distance = (big ? 46 : 28) + Math.random() * 22;
      const leaf = document.createElement("span");
      leaf.className = "leaf-burst";
      leaf.style.left = `${x}px`;
      leaf.style.top = `${y}px`;
      leaf.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
      leaf.style.setProperty("--dy", `${Math.sin(angle) * distance - 10}px`);
      leaf.style.setProperty("--rot", `${Math.round(Math.random() * 240 - 120)}deg`);
      leaf.style.setProperty("--size", `${7 + Math.round(Math.random() * 5)}px`);
      leaf.addEventListener("animationend", () => leaf.remove());
      document.body.appendChild(leaf);
    }
  });
}
