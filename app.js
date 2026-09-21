// =========================================================
// Public pages
//
// index.html is one file that acts like several pages.
// The address after the # decides which page you see:
//
//   #/                Home
//   #/folder/ID       A folder page
//   #/post/ID         One post (the reading page)
//   #/day/2026-09-21  Everything from one calendar day
//   #/search          Search results
//   #/saved           Posts a visitor saved for later
//   #/about           About me
//
// The templates for each page live in index.html.
// This file fills them in and swaps them with a soft transition.
// Visitors can only read, react, view, save and search.
// The Firestore rules decide exactly what they may write.
// =========================================================

import { db } from "./firebase-config.js";
import { SITE_NAME } from "./hardin-config.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  updateDoc,
  setDoc,
  increment
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  el,
  icon,
  MOODS,
  buildFolderTree,
  formatDate,
  postDate,
  postDateMs,
  wordCount,
  readMinutes,
  renderBody,
  postLink,
  dateKey,
  keyToDate,
  isDayKey,
  formatDayKey,
  postDayKey,
  sleep,
  prefersReducedMotion,
  enableButtonEffects
} from "./shared.js";

const $ = (id) => document.getElementById(id);
const view = $("view");

// ---------- State ----------
let folders = [];
let tree = buildFolderTree([]);
let posts = [];
let events = [];
const settings = {
  tagline: "",
  about: "",
  announcement: "",
  announcementLink: "",
  folderView: ""
};

let postsByDay = {};       // "2026-09-21" -> how many posts
let eventsByDay = {};      // "2026-09-21" -> [events]
let folderCounts = {};     // folder id -> posts inside it, including sub-folders
let directCounts = {};     // folder id -> posts directly inside it

let dataReady = false;
let navToken = 0;
let currentRoute = { name: "home", arg: "" };
let searchText = "";
let searchUI = null;
let installPrompt = null;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  const button = $("install-app");
  if (button) button.hidden = false;
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  const button = $("install-app");
  if (button) button.hidden = true;
});

// ---------- Small storage helpers (a blocked browser never breaks the page) ----------
function readList(storage, key) {
  try { return JSON.parse(storage.getItem(key) || "[]"); } catch (e) { return []; }
}
function writeList(storage, key, list) {
  try { storage.setItem(key, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
function getPref(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch (e) { return fallback; }
}
function setPref(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}
function isAdminBrowser() {
  return getPref("hardin-is-admin", "") === "1";
}

const reacted = new Set(readList(localStorage, "hardin-reacted"));
const saved = new Set(readList(localStorage, "hardin-saved"));
const viewed = new Set(readList(sessionStorage, "hardin-viewed"));

// Where each kind of page lives
const href = {
  home: () => "#/",
  folder: (id) => `#/folder/${encodeURIComponent(id)}`,
  post: (id) => `#/post/${encodeURIComponent(id)}`,
  day: (key) => `#/day/${key}`
};

function cloneTemplate(id) { return document.getElementById(id).content.cloneNode(true); }
function slot(root, name) { return root.querySelector(`[data-slot="${name}"]`); }
function countText(n, word) { return `${n} ${n === 1 ? word : word + "s"}`; }

// =========================================================
// 1. Load everything from Firestore
// =========================================================

async function loadData() {
  try {
    const [folderSnap, postSnap, eventSnap, settingsSnap] = await Promise.all([
      getDocs(collection(db, "folders")),
      // Only published posts. Drafts are never sent to visitors.
      getDocs(query(collection(db, "posts"), where("status", "==", "published"))),
      // Extras: if these fail, the rest of the site still works
      getDocs(collection(db, "events")).catch(() => null),
      getDoc(doc(db, "settings", "site")).catch(() => null)
    ]);

    folders = folderSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    tree = buildFolderTree(folders);
    posts = postSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    events = eventSnap ? eventSnap.docs.map((d) => ({ id: d.id, ...d.data() })) : [];

    if (settingsSnap && settingsSnap.exists()) {
      const data = settingsSnap.data();
      settings.tagline = data.tagline || "";
      settings.about = data.about || "";
      settings.announcement = data.announcement || "";
      settings.announcementLink = data.announcementLink || "";
      settings.folderView = data.folderView || "";
    }

    buildIndexes();
    dataReady = true;
    setupAnnouncement();
    updateSavedBadge();
    route();
  } catch (error) {
    console.error(error);
    view.replaceChildren(el("p", "status", `Couldn't load ${SITE_NAME}. Check firebase-config.js and your Firestore rules.`));
  }
}

// Quick lookups for the calendar and the folder counts
function buildIndexes() {
  postsByDay = {};
  folderCounts = {};
  directCounts = {};

  posts.forEach((post) => {
    const key = postDayKey(post);
    if (key) postsByDay[key] = (postsByDay[key] || 0) + 1;

    if (post.folderId && tree.byId[post.folderId]) {
      directCounts[post.folderId] = (directCounts[post.folderId] || 0) + 1;
      // Count the post in its folder and in every folder above it
      tree.path(post.folderId).forEach((f) => { folderCounts[f.id] = (folderCounts[f.id] || 0) + 1; });
    }
  });

  eventsByDay = {};
  events.forEach((event) => {
    if (!isDayKey(event.date)) return;
    if (!eventsByDay[event.date]) eventsByDay[event.date] = [];
    eventsByDay[event.date].push(event);
  });
}

// =========================================================
// 2. Router: reads the address, draws the right page
// =========================================================

function parseRoute() {
  const raw = location.hash;

  // Old-style links from earlier versions still work
  if (raw.startsWith("#post=")) return { name: "post", arg: raw.slice(6) };
  if (raw.startsWith("#folder=")) {
    const id = raw.slice(8);
    return id ? { name: "folder", arg: id } : { name: "home", arg: "" };
  }

  const [pathPart] = raw.replace(/^#\/?/, "").split("?");
  let parts = pathPart.split("/").filter(Boolean);
  try { parts = parts.map(decodeURIComponent); } catch (e) { /* keep the raw text */ }

  // #/tag/... links from the old #tags feature just go Home
  if (parts[0] === "tag") return { name: "home", arg: "" };
  return { name: parts[0] || "home", arg: parts.slice(1).join("/") };
}

async function route() {
  if (!dataReady) return;

  const r = parseRoute();
  const token = ++navToken;
  currentRoute = r;

  // Leaving the search page clears the search box
  if (r.name !== "search") {
    searchUI = null;
    if (searchText) { searchText = ""; $("search").value = ""; }
  }
  highlightNav(r.name);

  const firstPage = view.dataset.ready !== "1";
  if (!firstPage) {
    startRouteBar();
    if (!prefersReducedMotion()) {
      view.classList.add("leaving");
      await sleep(170);
      if (token !== navToken) return;      // you clicked somewhere else meanwhile
      view.classList.remove("leaving");
    }
  }

  const page = buildPage(r);
  view.replaceChildren(page.node);
  view.dataset.ready = "1";
  document.title = page.title ? `${page.title} · ${SITE_NAME}` : SITE_NAME;

  // Fade the new page in
  view.classList.remove("entering");
  void view.offsetWidth;
  view.classList.add("entering");

  window.scrollTo(0, 0);
  updateProgress();
  if (!firstPage) view.focus({ preventScroll: true });
  if (page.after) page.after();
}

window.addEventListener("hashchange", route);

function buildPage(r) {
  switch (r.name) {
    case "home":   return pageHome();
    case "folder": return pageFolder(r);
    case "post":   return pagePost(r);
    case "day":    return pageDay(r);
    case "search": return pageSearch();
    case "saved":  return pageSaved();
    case "about":  return pageAbout();
    case "tasks":  return pageTasks();
    case "wallet":  return pageWallet();
    case "prayer":  return pagePrayer();
    case "devotionals": return pageDevotionals();
    default:       return pageMissing();
  }
}

function startRouteBar() {
  const bar = $("route-bar");
  bar.classList.remove("run");
  void bar.offsetWidth;
  bar.classList.add("run");
}

function highlightNav(name) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

// =========================================================
// 3. Building blocks shared by several pages
// =========================================================

// Home > Journal > School
function fillCrumbs(nav, steps) {
  nav.replaceChildren();
  steps.forEach((step, index) => {
    if (index > 0) nav.appendChild(el("span", "crumb-sep", "›"));
    if (step.href) {
      const link = el("a", "crumb", step.name);
      link.href = step.href;
      nav.appendChild(link);
    } else {
      const current = el("span", "crumb current", step.name);
      current.setAttribute("aria-current", "page");
      nav.appendChild(current);
    }
  });
}

function sortPosts(list) {
  // Featured (pinned) first, then newest first
  return [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || postDateMs(b) - postDateMs(a));
}

function matchesSearch(post, q) {
  return [post.title, post.subtitle, post.summary, post.body].join(" ").toLowerCase().includes(q);
}

function setEmpty(node, text) {
  const box = slot(node, "empty");
  box.textContent = text;
  box.hidden = !text;
}

// "Sep 20, 2026   😃 Happy   3 min read"
function metaParts(post, shortDate) {
  const parts = [];
  const date = formatDate(postDate(post), shortDate);
  if (date) parts.push(el("span", "", date));
  const mood = MOODS[post.mood];
  if (mood) parts.push(el("span", "mood", `${mood.emoji} ${mood.label}`));
  if (wordCount(post.body) > 0) parts.push(el("span", "", `${readMinutes(post.body)} min read`));
  return parts;
}

// ---------- Post cards ----------

function makeCard(post) {
  const look = tree.look(post.folderId);
  const folder = tree.byId[post.folderId];

  const card = el("article", `card color-${look.color}${post.pinned ? " featured" : ""}`);

  // The main clickable area: a real link to the post's own page
  const open = el("a", "card-open");
  open.href = href.post(post.id);

  const media = el("span", "card-media");
  if (post.coverUrl) {
    const img = el("img");
    img.src = post.coverUrl;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => { img.remove(); media.textContent = look.icon; };
    media.appendChild(img);
  } else {
    media.textContent = look.icon;
  }
  if (post.pinned) {
    const flag = el("span", "featured-flag");
    flag.append(icon("pin", 15), el("span", "", "Featured"));
    media.appendChild(flag);
  }

  const body = el("span", "card-body");
  body.appendChild(el("span", "badge", `${look.icon} ${folder ? folder.name : "Unsorted"}`));
  body.appendChild(el("span", "card-title", post.title));
  const blurb = post.summary || post.subtitle;
  if (blurb) body.appendChild(el("span", "card-summary", blurb));
  const meta = el("span", "meta-row");
  metaParts(post, true).forEach((part) => meta.appendChild(part));
  body.appendChild(meta);

  open.append(media, body);
  card.appendChild(open);

  // Bottom row: seedling, share, save, views
  const foot = el("div", "card-foot");
  foot.append(makeReactButton(post), makeShareButton(post), makeSaveButton(post, false), makeViews(post));
  card.appendChild(foot);

  return card;
}

// =========================================================
// 4. How things are shown: Tiles, List or Accordion
// =========================================================

const VIEW_MODES = ["tiles", "list", "accordion"];

// A visitor's own choice wins. Otherwise the default you set in Admin > Settings.
function viewMode() {
  const clean = (value) => (value === "tree" ? "accordion" : value);   // "tree" was the old name
  const own = clean(getPref("hardin-folder-view", ""));
  if (VIEW_MODES.includes(own)) return own;
  const fallback = clean(settings.folderView);
  return VIEW_MODES.includes(fallback) ? fallback : "tiles";
}

// ----- Folders -----

// Tiles: big colored cards
function folderTile(folder) {
  const look = tree.look(folder.id);
  const tile = el("a", `folder-tile color-${look.color}`);
  tile.href = href.folder(folder.id);
  tile.appendChild(el("span", "tile-icon", look.icon));
  tile.appendChild(el("span", "tile-name", folder.name));
  tile.appendChild(el("span", "tile-count", countText(folderCounts[folder.id], "post")));
  return tile;
}

// List: one slim row per folder
function folderRow(folder) {
  const look = tree.look(folder.id);
  const row = el("a", `folder-row color-${look.color}`);
  row.href = href.folder(folder.id);

  const subs = tree.children(folder.id).filter((f) => folderCounts[f.id] > 0).length;
  row.appendChild(el("span", "row-icon", look.icon));
  row.appendChild(el("span", "row-name", folder.name));
  row.appendChild(el("span", "row-meta",
    subs > 0 ? `${countText(folderCounts[folder.id], "post")}, ${countText(subs, "folder")}` : countText(folderCounts[folder.id], "post")));
  row.appendChild(icon("chevronRight", 18));
  return row;
}

// Accordion: folders that open and close, with the sub-folders and posts inside
function folderNode(folder) {
  const look = tree.look(folder.id);
  const node = el("details", `tree-node color-${look.color}`);

  const summary = el("summary", "tree-summary");
  const caret = el("span", "tree-caret");
  caret.appendChild(icon("chevronRight", 16));
  summary.append(
    caret,
    el("span", "tree-icon", look.icon),
    el("span", "tree-name", folder.name),
    el("span", "tree-count", String(folderCounts[folder.id]))
  );
  const open = el("a", "tree-open", "Open");
  open.href = href.folder(folder.id);
  open.setAttribute("aria-label", `Open the ${folder.name} page`);
  summary.appendChild(open);
  node.appendChild(summary);

  const body = el("div", "tree-body");
  tree.children(folder.id)
    .filter((child) => folderCounts[child.id] > 0)
    .forEach((child) => body.appendChild(folderNode(child)));

  const direct = sortPosts(posts.filter((p) => p.folderId === folder.id));
  if (direct.length > 0) {
    const list = el("ul", "tree-posts");
    direct.slice(0, 8).forEach((post) => {
      const item = el("li");
      const link = el("a", "tree-post");
      link.href = href.post(post.id);
      link.append(el("span", "tree-post-title", post.title), el("span", "tree-post-date", formatDate(postDate(post), true)));
      item.appendChild(link);
      list.appendChild(item);
    });
    if (direct.length > 8) {
      const more = el("li");
      const link = el("a", "tree-more", `See all ${direct.length} posts`);
      link.href = href.folder(folder.id);
      more.appendChild(link);
      list.appendChild(more);
    }
    body.appendChild(list);
  }

  node.appendChild(body);
  return node;
}

// Draws the folders inside a folder (null = the top level). Returns true if there are any.
function fillFolders(container, parentId) {
  container.replaceChildren();
  const mode = viewMode();
  const shown = tree.children(parentId).filter((f) => folderCounts[f.id] > 0);   // never show empty folders

  container.className = `folders folders-${mode}`;
  shown.forEach((folder) => {
    if (mode === "list") container.appendChild(folderRow(folder));
    else if (mode === "accordion") container.appendChild(folderNode(folder));
    else container.appendChild(folderTile(folder));
  });

  container.hidden = shown.length === 0;
  return shown.length > 0;
}

// ----- Posts (the "items") -----

// List: one slim row per post
function makePostRow(post) {
  const look = tree.look(post.folderId);
  const folder = tree.byId[post.folderId];

  const row = el("article", `post-row color-${look.color}`);
  const link = el("a", "row-link");
  link.href = href.post(post.id);

  const main = el("span", "row-main");
  main.appendChild(el("span", "row-title", post.title));
  const blurb = post.summary || post.subtitle;
  if (blurb) main.appendChild(el("span", "row-sub", blurb));

  const meta = el("span", "meta-row");
  meta.appendChild(el("span", "", `${look.icon} ${folder ? folder.name : "Unsorted"}`));
  metaParts(post, true).forEach((part) => meta.appendChild(part));
  if (post.pinned) meta.appendChild(el("span", "row-featured", "Featured"));
  main.appendChild(meta);

  link.appendChild(main);
  row.appendChild(link);

  const actions = el("div", "row-actions");
  actions.append(makeReactButton(post), makeSaveButton(post, false));
  row.appendChild(actions);
  return row;
}

// Tiles show post cards. List and Accordion show slim rows.
function fillPosts(container, list) {
  const cards = viewMode() === "tiles";
  container.className = cards ? "grid" : "post-list";
  container.replaceChildren(...list.map((post) => (cards ? makeCard(post) : makePostRow(post))));
}

// ----- The switcher: Tiles / List / Accordion (remembered on this device) -----

function buildViewControls(bar, redraw) {
  bar.replaceChildren();
  bar.hidden = false;
  const current = viewMode();

  bar.appendChild(el("span", "view-label", "View"));
  const group = el("div", "seg");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "How to show folders and posts");

  [["tiles", "Tiles", "grid"], ["list", "List", "list"], ["accordion", "Accordion", "tree"]].forEach(([mode, label, iconName]) => {
    const btn = el("button", "seg-btn");
    btn.type = "button";
    btn.append(icon(iconName, 16), el("span", "", label));
    btn.setAttribute("aria-pressed", String(current === mode));
    btn.addEventListener("click", () => {
      setPref("hardin-folder-view", mode);
      redraw();
      buildViewControls(bar, redraw);
    });
    group.appendChild(btn);
  });
  bar.appendChild(group);

  // Only the accordion can be opened and closed
  if (current === "accordion") {
    const expand = el("button", "btn ghost small", "Open all");
    expand.type = "button";
    expand.addEventListener("click", () => view.querySelectorAll("details.tree-node").forEach((d) => { d.open = true; }));
    const collapse = el("button", "btn ghost small", "Close all");
    collapse.type = "button";
    collapse.addEventListener("click", () => view.querySelectorAll("details.tree-node").forEach((d) => { d.open = false; }));
    bar.append(expand, collapse);
  }
}

// =========================================================
// 5. The pages
// =========================================================

// ---------- Home ----------
function pageHome() {
  const node = cloneTemplate("tpl-home");
  if (settings.tagline) slot(node, "tagline").textContent = settings.tagline;

  // "Surprise me" opens a random post
  const surprise = slot(node, "surprise");
  if (posts.length > 0) {
    surprise.append(icon("shuffle", 16), el("span", "", "Surprise me"));
    surprise.hidden = false;
    surprise.addEventListener("click", () => {
      const pick = posts[Math.floor(Math.random() * posts.length)];
      location.hash = href.post(pick.id);
    });
  }

  const sorted = sortPosts(posts);
  const featured = sorted.filter((p) => p.pinned);
  const latest = sorted.filter((p) => !p.pinned);

  const foldersBlock = slot(node, "folders-block");
  const folderBox = slot(node, "tiles");
  const featuredBlock = slot(node, "featured-block");
  const featuredBox = slot(node, "featured");
  const latestBox = slot(node, "grid");
  slot(node, "latest-title").textContent = featured.length > 0 ? "Latest" : "All posts";

  // Draws folders and posts in whichever view is chosen
  const redraw = () => {
    foldersBlock.hidden = !fillFolders(folderBox, null);
    fillPosts(featuredBox, featured);
    featuredBlock.hidden = featured.length === 0;
    fillPosts(latestBox, latest);
  };
  redraw();
  buildViewControls(slot(node, "folder-controls"), redraw);

  if (posts.length === 0) setEmpty(node, "Nothing planted here yet. Check back soon.");
  slot(node, "calendar").appendChild(makeCalendar(""));

  return { node, title: "" };
}

// ---------- Folder page ----------
function pageFolder(r) {
  const folder = tree.byId[r.arg];
  if (!folder) return pageMissing();

  const node = cloneTemplate("tpl-list");
  const look = tree.look(folder.id);
  const path = tree.path(folder.id);

  fillCrumbs(slot(node, "crumbs"), [
    { name: "Home", href: href.home() },
    ...path.map((f, i) => (i === path.length - 1 ? { name: f.name } : { name: f.name, href: href.folder(f.id) }))
  ]);
  slot(node, "title").textContent = `${look.icon} ${folder.name}`;
  slot(node, "layout").classList.add("no-side");

  const ids = tree.descendants(folder.id);
  const inFolder = sortPosts(posts.filter((p) => ids.has(p.folderId)));
  slot(node, "sub").textContent = countText(inFolder.length, "post");

  const folderBox = slot(node, "tiles");
  const grid = slot(node, "grid");
  const redraw = () => {
    fillFolders(folderBox, folder.id);   // the folders inside this folder
    fillPosts(grid, inFolder);
  };
  redraw();
  buildViewControls(slot(node, "folder-controls"), redraw);
  if (inFolder.length === 0) setEmpty(node, "Nothing in this folder yet.");

  return { node, title: folder.name };
}

// ---------- Calendar day page ----------
function pageDay(r) {
  const key = r.arg;
  if (!isDayKey(key)) return pageMissing();

  const node = cloneTemplate("tpl-list");
  const dayPosts = sortPosts(posts.filter((p) => postDayKey(p) === key));
  const dayEvents = eventsByDay[key] || [];

  fillCrumbs(slot(node, "crumbs"), [{ name: "Home", href: href.home() }, { name: formatDayKey(key) }]);
  slot(node, "title").textContent = formatDayKey(key, true);
  slot(node, "sub").textContent =
    `${countText(dayPosts.length, "post")}, ${countText(dayEvents.length, "event")}`;

  // Custom notes and markers you added for this day
  const eventBox = slot(node, "events");
  dayEvents.forEach((event) => {
    const card = el("div", "event-card");
    card.appendChild(el("span", "event-marker", event.marker || "📌"));
    const text = el("div", "event-text");
    text.appendChild(el("strong", "", event.title));
    if (event.note) text.appendChild(el("p", "", event.note));
    card.appendChild(text);
    eventBox.appendChild(card);
  });
  eventBox.hidden = dayEvents.length === 0;

  const dayGrid = slot(node, "grid");
  const redrawDay = () => fillPosts(dayGrid, dayPosts);
  redrawDay();
  buildViewControls(slot(node, "folder-controls"), redrawDay);
  if (dayPosts.length === 0 && dayEvents.length === 0) setEmpty(node, "Nothing was posted on this day.");

  // The calendar stays beside the list so you can hop to another day
  const side = slot(node, "side");
  side.appendChild(makeCalendar(key));
  side.hidden = false;

  return { node, title: formatDayKey(key) };
}

// ---------- Search page ----------
function pageSearch() {
  const node = cloneTemplate("tpl-list");
  fillCrumbs(slot(node, "crumbs"), [{ name: "Home", href: href.home() }, { name: "Search" }]);
  slot(node, "title").textContent = "Search";
  slot(node, "layout").classList.add("no-side");

  searchUI = { sub: slot(node, "sub"), grid: slot(node, "grid"), empty: slot(node, "empty") };
  refreshSearchResults();

  return { node, title: "Search" };
}

// Runs on every keystroke in the search box
function refreshSearchResults() {
  if (!searchUI) return;
  const q = searchText.trim().toLowerCase();

  if (!q) {
    searchUI.sub.textContent = "Type in the search box to look through every post.";
    searchUI.grid.replaceChildren();
    searchUI.empty.hidden = true;
    return;
  }

  const list = sortPosts(posts.filter((p) => matchesSearch(p, q)));
  searchUI.sub.textContent = `${countText(list.length, "result")} for “${searchText.trim()}”`;
  fillPosts(searchUI.grid, list);
  searchUI.empty.textContent = "Nothing matches that. Try a different word.";
  searchUI.empty.hidden = list.length > 0;
}

$("search").addEventListener("input", (event) => {
  searchText = event.target.value;

  if (!searchText.trim()) {
    if (currentRoute.name === "search") location.hash = "#/";
    return;
  }
  if (currentRoute.name !== "search") location.hash = "#/search";
  else refreshSearchResults();
});

// Press / anywhere to jump to the search box
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  event.preventDefault();
  $("search").focus();
});

// ---------- Saved for later ----------
function pageSaved() {
  const node = cloneTemplate("tpl-list");
  const list = sortPosts(posts.filter((p) => saved.has(p.id)));

  fillCrumbs(slot(node, "crumbs"), [{ name: "Home", href: href.home() }, { name: "Saved" }]);
  slot(node, "title").textContent = "Saved for later";
  slot(node, "sub").textContent = countText(list.length, "post");
  slot(node, "layout").classList.add("no-side");

  const savedGrid = slot(node, "grid");
  const redrawSaved = () => fillPosts(savedGrid, list);
  redrawSaved();
  buildViewControls(slot(node, "folder-controls"), redrawSaved);
  if (list.length === 0) {
    setEmpty(node, "Nothing saved yet. Tap the bookmark on any post to keep it here. It's saved on this device only.");
  } else {
    const clear = el("button", "btn ghost small", "Clear all");
    clear.type = "button";
    clear.addEventListener("click", () => {
      saved.clear();
      writeList(localStorage, "hardin-saved", []);
      updateSavedBadge();
      route();
    });
    slot(node, "sub").after(clear);
  }

  return { node, title: "Saved" };
}

// The bookmark button (saved on this device only)
function makeSaveButton(post, withLabel) {
  const btn = el("button", "save-btn");
  btn.type = "button";
  btn.dataset.id = post.id;
  btn.append(icon("bookmark", 18));
  if (withLabel) btn.appendChild(el("span", "btn-label", "Save"));
  paintSave(btn);
  btn.addEventListener("click", () => toggleSaved(post));
  return btn;
}

function paintSave(btn) {
  const on = saved.has(btn.dataset.id);
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", on ? "Remove from saved" : "Save for later");
  btn.title = on ? "Saved. Click to remove" : "Save for later";
  const label = btn.querySelector(".btn-label");
  if (label) label.textContent = on ? "Saved" : "Save";
}

function toggleSaved(post) {
  if (saved.has(post.id)) saved.delete(post.id); else saved.add(post.id);
  writeList(localStorage, "hardin-saved", [...saved]);
  document.querySelectorAll(`.save-btn[data-id="${post.id}"]`).forEach(paintSave);
  updateSavedBadge();
}

function updateSavedBadge() {
  const count = posts.filter((p) => saved.has(p.id)).length;
  const badge = $("saved-count");
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

// ---------- One post (Substack-style reading page) ----------
const TEXT_SIZES = ["sm", "md", "lg", "xl"];

function textSize() {
  const value = getPref("hardin-text-size", "md");
  return TEXT_SIZES.includes(value) ? value : "md";
}

function pagePost(r) {
  const post = posts.find((p) => p.id === r.arg);
  if (!post) return pageMissing();

  const node = cloneTemplate("tpl-post");
  const look = tree.look(post.folderId);
  const folder = tree.byId[post.folderId];
  const path = tree.path(post.folderId);

  node.querySelector(".post-page").classList.add(`color-${look.color}`);

  // Home > Journal > School > This post
  fillCrumbs(slot(node, "crumbs"), [
    { name: "Home", href: href.home() },
    ...path.map((f) => ({ name: f.name, href: href.folder(f.id) })),
    { name: post.title }
  ]);

  slot(node, "badge").textContent = `${look.icon} ${folder ? folder.name : "Unsorted"}`;
  slot(node, "title").textContent = post.title;

  if (post.subtitle) {
    const dek = slot(node, "dek");
    dek.textContent = post.subtitle;
    dek.hidden = false;
  }

  const meta = slot(node, "meta");
  metaParts(post, false).forEach((part) => meta.appendChild(part));
  meta.appendChild(makeViews(post));

  // Embedded Canva / Slides / anything with an https link
  if (post.embedUrl && post.embedUrl.startsWith("https://")) {
    const frame = el("iframe", "embed-frame");
    frame.src = post.embedUrl;
    frame.title = post.title;
    frame.loading = "lazy";
    frame.allowFullscreen = true;
    slot(node, "embed").appendChild(frame);
  }

  const prose = slot(node, "body");
  renderBody(post.body, prose);
  prose.hidden = prose.children.length === 0;
  prose.dataset.size = textSize();

  // Reader tools: text size
  const tools = slot(node, "tools");
  tools.appendChild(el("span", "tools-label", "Text size"));
  const smaller = el("button", "action-btn", "A−");
  const bigger = el("button", "action-btn", "A+");
  smaller.type = bigger.type = "button";
  smaller.setAttribute("aria-label", "Smaller text");
  bigger.setAttribute("aria-label", "Bigger text");
  const resize = (step) => {
    const next = Math.min(TEXT_SIZES.length - 1, Math.max(0, TEXT_SIZES.indexOf(prose.dataset.size) + step));
    prose.dataset.size = TEXT_SIZES[next];
    setPref("hardin-text-size", TEXT_SIZES[next]);
  };
  smaller.addEventListener("click", () => resize(-1));
  bigger.addEventListener("click", () => resize(1));
  tools.append(smaller, bigger);
  tools.hidden = prose.hidden;

  // "On this page": a clickable outline when a long post has three or more headings
  const headings = [...prose.querySelectorAll("h3")];
  if (headings.length >= 3) {
    const toc = slot(node, "toc");
    const tocList = slot(node, "toc-list");
    headings.forEach((heading, index) => {
      heading.id = `section-${index + 1}`;
      const item = el("li");
      const link = el("button", "toc-link", heading.textContent);
      link.type = "button";
      link.addEventListener("click", () => heading.scrollIntoView({ behavior: "smooth", block: "start" }));
      item.appendChild(link);
      tocList.appendChild(item);
    });
    toc.hidden = false;
  }

  if (post.linkUrl && post.linkUrl.startsWith("https://")) {
    const link = el("a", "btn primary", "Open project");
    link.href = post.linkUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    slot(node, "link").appendChild(link);
  }

  slot(node, "actions").append(makeReactButton(post), makeShareButton(post), makeSaveButton(post, true));

  // "Keep reading": same folder first, then the same main folder, then the newest posts
  const others = sortPosts(posts.filter((p) => p.id !== post.id));
  const root = tree.root(post.folderId);
  const sameFolder = others.filter((p) => p.folderId === post.folderId);
  const sameRoot = others.filter((p) => root && p.folderId !== post.folderId && tree.root(p.folderId) === root);
  const more = [...new Set([...sameFolder, ...sameRoot, ...others])].slice(0, 3);

  const moreList = slot(node, "more");
  more.forEach((p) => {
    const item = el("li");
    const link = el("a", "more-link");
    link.href = href.post(p.id);
    link.append(el("span", "more-title", p.title), el("span", "more-date", formatDate(postDate(p), true)));
    item.appendChild(link);
    moreList.appendChild(item);
  });
  slot(node, "more-block").hidden = more.length === 0;

  return { node, title: post.title, after: () => countView(post) };
}

// ---------- About ----------
function pageAbout() {
  const node = cloneTemplate("tpl-about");
  fillCrumbs(slot(node, "crumbs"), [{ name: "Home", href: href.home() }, { name: "About" }]);
  const portrait = slot(node, "portrait");
  const portraitImage = el("img", "portrait-image");
  portraitImage.src = "profile.jpg";
  portraitImage.alt = "Ann";
  portraitImage.addEventListener("error", () => {
    portraitImage.remove();
    portrait.appendChild(icon("seedling", 64));
  }, { once: true });
  portrait.appendChild(portraitImage);

  if (settings.about) {
    const box = slot(node, "about-text");
    box.replaceChildren();
    renderBody(settings.about, box);
  }
  return { node, title: "About" };
}

function pageTasks() {
  const node = cloneTemplate("tpl-tasks");
  const tasks = readList(localStorage, "hardin-tasks");
  const list = node.querySelector("[data-task-list]");
  const status = node.querySelector("[data-task-status]");
  const draw = () => {
    list.replaceChildren();
    const ordered = [...readList(localStorage, "hardin-tasks")].sort((a, b) => Number(a.done) - Number(b.done) || (a.due || "").localeCompare(b.due || ""));
    if (!ordered.length) list.appendChild(el("li", "empty-state", "No tasks yet."));
    ordered.forEach((task) => {
      const item = el("li", `feature-item${task.done ? " is-done" : ""}`);
      const check = el("input");
      check.type = "checkbox";
      check.checked = task.done;
      check.setAttribute("aria-label", `Mark ${task.title} complete`);
      check.addEventListener("change", () => {
        const next = readList(localStorage, "hardin-tasks").map((entry) => entry.id === task.id ? { ...entry, done: check.checked } : entry);
        writeList(localStorage, "hardin-tasks", next);
        draw();
      });
      const text = el("span", "feature-item-text", task.title);
      if (task.due) text.appendChild(el("small", "feature-item-meta", new Date(task.due).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })));
      const remove = el("button", "btn danger small", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => { writeList(localStorage, "hardin-tasks", readList(localStorage, "hardin-tasks").filter((entry) => entry.id !== task.id)); draw(); });
      item.append(check, text, remove);
      list.appendChild(item);
    });
  };
  node.querySelector("[data-feature-form=task]").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = node.querySelector("[data-task-title]").value.trim();
    const due = node.querySelector("[data-task-due]").value;
    writeList(localStorage, "hardin-tasks", [...readList(localStorage, "hardin-tasks"), { id: Date.now().toString(), title, due, done: false }]);
    event.target.reset();
    status.textContent = "Task added.";
    draw();
  });
  node.querySelector("[data-clear-done]").addEventListener("click", () => { writeList(localStorage, "hardin-tasks", readList(localStorage, "hardin-tasks").filter((task) => !task.done)); draw(); });
  node.querySelector("[data-notify]").addEventListener("click", async () => {
    if (!("Notification" in window)) { status.textContent = "Notifications are not supported in this browser."; return; }
    const permission = await Notification.requestPermission();
    status.textContent = permission === "granted" ? "Notifications are on for this browser." : "Notifications were not allowed.";
  });
  draw();
  return { node, title: "Tasks" };
}

function pageWallet() {
  const node = cloneTemplate("tpl-wallet");
  const draw = () => {
    const entries = readList(localStorage, "hardin-wallet");
    const balance = entries.reduce((sum, entry) => sum + (entry.kind === "in" ? entry.amount : -entry.amount), 0);
    node.querySelector("[data-wallet-balance]").textContent = `$${balance.toFixed(2)}`;
    const totals = {};
    entries.forEach((entry) => { totals[entry.category] = (totals[entry.category] || 0) + (entry.kind === "in" ? entry.amount : -entry.amount); });
    node.querySelector("[data-wallet-breakdown]").replaceChildren(...Object.entries(totals).map(([category, total]) => el("span", "wallet-chip", `${category}: $${total.toFixed(2)}`)));
    const list = node.querySelector("[data-wallet-list]");
    list.replaceChildren();
    if (!entries.length) list.appendChild(el("li", "empty-state", "No entries yet."));
    [...entries].reverse().forEach((entry) => {
      const item = el("li", "feature-item");
      item.append(el("span", "feature-item-text", `${entry.kind === "in" ? "+" : "-"}$${entry.amount.toFixed(2)} · ${entry.category}`), el("small", "feature-item-meta", entry.note || ""));
      const remove = el("button", "btn danger small", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => { writeList(localStorage, "hardin-wallet", entries.filter((saved) => saved.id !== entry.id)); draw(); });
      item.appendChild(remove);
      list.appendChild(item);
    });
  };
  node.querySelector("[data-feature-form=wallet]").addEventListener("submit", (event) => {
    event.preventDefault();
    const amount = Number(node.querySelector("[data-wallet-amount]").value);
    const entry = { id: Date.now().toString(), kind: node.querySelector("[data-wallet-kind]").value, category: node.querySelector("[data-wallet-category]").value, amount, note: node.querySelector("[data-wallet-note]").value.trim() };
    writeList(localStorage, "hardin-wallet", [...readList(localStorage, "hardin-wallet"), entry]);
    event.target.reset();
    draw();
  });
  draw();
  return { node, title: "Wallet" };
}

function pagePrayer() {
  const node = cloneTemplate("tpl-prayer");
  const month = node.querySelector("[data-prayer-month]");
  const text = node.querySelector("[data-prayer-text]");
  const status = node.querySelector("[data-prayer-status]");
  const today = new Date();
  month.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const load = () => { text.value = getPref(`hardin-prayer-${month.value}`, ""); };
  month.addEventListener("change", load);
  node.querySelector("[data-save-prayer]").addEventListener("click", () => { setPref(`hardin-prayer-${month.value}`, text.value); status.textContent = "Saved for this month."; });
  load();
  return { node, title: "Prayer Wall" };
}

function pageDevotionals() {
  const node = cloneTemplate("tpl-devotionals");
  const form = node.querySelector("[data-feature-form=devotional]");
  const date = node.querySelector("[data-devotional-date]");
  const title = node.querySelector("[data-devotional-title]");
  const reference = node.querySelector("[data-devotional-reference]");
  const reading = node.querySelector("[data-devotional-reading]");
  const reflection = node.querySelector("[data-devotional-reflection]");
  const prayer = node.querySelector("[data-devotional-prayer]");
  const status = node.querySelector("[data-devotional-status]");
  const today = new Date();
  const todayKey = dateKey(today);
  let editingDate = null;

  const getEntries = () => readList(localStorage, "hardin-devotionals").sort((a, b) => b.date.localeCompare(a.date));
  const clearForm = () => {
    form.reset();
    date.value = todayKey;
    editingDate = null;
    node.querySelector("[data-devotional-form-title]").textContent = "New devotional";
    node.querySelector("[data-devotional-cancel]").hidden = true;
  };
  const showEntry = (entry) => {
    node.querySelector("[data-today-title]").textContent = entry ? entry.title : "Begin with a reading";
    node.querySelector("[data-today-reference]").textContent = entry ? entry.reference : "Choose a passage and write what you notice.";
    node.querySelector("[data-today-reading]").textContent = entry ? entry.reading : "Your daily reading notes will appear here.";
    const reflectionBox = node.querySelector("[data-today-reflection]");
    reflectionBox.textContent = entry ? entry.reflection : "";
    reflectionBox.hidden = !entry || !entry.reflection;
    node.querySelector("[data-today-prayer]").textContent = entry && entry.prayer ? `Prayer: ${entry.prayer}` : "";
  };
  const draw = () => {
    const entries = getEntries();
    const todayEntry = entries.find((entry) => entry.date === todayKey);
    showEntry(todayEntry);
    node.querySelector("[data-devotional-count]").textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
    const list = node.querySelector("[data-devotional-list]");
    list.replaceChildren();
    if (!entries.length) list.appendChild(el("li", "empty-state", "No devotionals yet."));
    entries.forEach((entry) => {
      const item = el("li", "feature-item");
      const text = el("span", "feature-item-text", entry.title);
      text.appendChild(el("small", "feature-item-meta", `${new Date(`${entry.date}T12:00:00`).toLocaleDateString([], { dateStyle: "medium" })}${entry.reference ? ` · ${entry.reference}` : ""}`));
      const edit = el("button", "btn ghost small", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => {
        editingDate = entry.date;
        date.value = entry.date;
        title.value = entry.title;
        reference.value = entry.reference || "";
        reading.value = entry.reading || "";
        reflection.value = entry.reflection || "";
        prayer.value = entry.prayer || "";
        node.querySelector("[data-devotional-form-title]").textContent = "Edit devotional";
        node.querySelector("[data-devotional-cancel]").hidden = false;
        form.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      const remove = el("button", "btn danger small", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => { writeList(localStorage, "hardin-devotionals", entries.filter((saved) => saved.date !== entry.date)); if (editingDate === entry.date) clearForm(); draw(); });
      item.append(text, edit, remove);
      list.appendChild(item);
    });
  };

  date.value = todayKey;
  node.querySelector("[data-devotional-today-button]").addEventListener("click", clearForm);
  node.querySelector("[data-devotional-cancel]").addEventListener("click", clearForm);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const entry = { date: date.value, title: title.value.trim(), reference: reference.value.trim(), reading: reading.value.trim(), reflection: reflection.value.trim(), prayer: prayer.value.trim() };
    const entries = getEntries().filter((saved) => saved.date !== (editingDate || entry.date));
    writeList(localStorage, "hardin-devotionals", [...entries, entry]);
    status.textContent = "Devotional saved.";
    clearForm();
    draw();
  });
  draw();
  return { node, title: "Devotionals" };
}

function checkTaskReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const notified = new Set(readList(localStorage, "hardin-task-notified"));
  const now = Date.now();
  readList(localStorage, "hardin-tasks").forEach((task) => {
    if (!task.done && task.due && new Date(task.due).getTime() <= now && !notified.has(task.id)) {
      new Notification("Haqin reminder", { body: task.title });
      notified.add(task.id);
    }
  });
  writeList(localStorage, "hardin-task-notified", [...notified]);
}

checkTaskReminders();
window.setInterval(checkTaskReminders, 30000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

function pageMissing() {
  return { node: cloneTemplate("tpl-missing"), title: "Not found" };
}

// =========================================================
// 6. Announcement bar
// =========================================================

function setupAnnouncement() {
  const bar = $("announcement");
  const text = (settings.announcement || "").trim();

  // Hidden if there's no message, or this visitor already dismissed this exact message
  if (!text || getPref("hardin-announcement-dismissed", "") === text) {
    bar.hidden = true;
    return;
  }

  $("announcement-text").textContent = text;
  const link = $("announcement-link");
  if (settings.announcementLink && settings.announcementLink.startsWith("https://")) {
    link.href = settings.announcementLink;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  bar.hidden = false;
}

$("announcement-close").addEventListener("click", () => {
  setPref("hardin-announcement-dismissed", (settings.announcement || "").trim());
  $("announcement").hidden = true;
});

// =========================================================
// 7. Calendar (small and simple)
// Days with a post get a green dot, days with a note you added get a gold dot.
// Click a day to see what's on it.
// =========================================================

let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

function makeCalendar(activeKey) {
  const wrap = el("section", "calendar");
  wrap.setAttribute("aria-label", "Calendar of posts and events");

  // Open on the month of the day you're looking at
  if (activeKey) {
    const date = keyToDate(activeKey);
    calYear = date.getFullYear();
    calMonth = date.getMonth();
  }
  drawCalendar(wrap, activeKey);
  return wrap;
}

function drawCalendar(wrap, activeKey) {
  wrap.replaceChildren();
  const todayKey = dateKey(new Date());

  // Header: previous month, month name, next month
  const head = el("div", "cal-head");
  const prev = el("button", "cal-nav");
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous month");
  prev.appendChild(icon("chevronLeft", 16));
  prev.addEventListener("click", () => {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    drawCalendar(wrap, activeKey);
  });

  const next = el("button", "cal-nav");
  next.type = "button";
  next.setAttribute("aria-label", "Next month");
  next.appendChild(icon("chevronRight", 16));
  next.addEventListener("click", () => {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    drawCalendar(wrap, activeKey);
  });

  const title = el("h3", "cal-title",
    new Date(calYear, calMonth, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" }));
  title.setAttribute("aria-live", "polite");
  head.append(prev, title, next);
  wrap.appendChild(head);

  // S M T W T F S
  const weekdays = el("div", "cal-grid cal-weekdays");
  ["S", "M", "T", "W", "T", "F", "S"].forEach((letter) => weekdays.appendChild(el("span", "", letter)));
  wrap.appendChild(weekdays);

  // The days
  const grid = el("div", "cal-grid");
  const firstWeekday = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  for (let i = 0; i < firstWeekday; i++) grid.appendChild(el("span", "cal-blank"));

  for (let day = 1; day <= daysInMonth; day++) {
    const key = dateKey(new Date(calYear, calMonth, day));
    const postCount = postsByDay[key] || 0;
    const eventCount = (eventsByDay[key] || []).length;
    const busy = postCount > 0 || eventCount > 0;

    const cell = busy ? el("a", "cal-day has") : el("span", "cal-day");
    if (busy) {
      cell.href = href.day(key);
      const bits = [];
      if (postCount) bits.push(countText(postCount, "post"));
      if (eventCount) bits.push(countText(eventCount, "event"));
      cell.setAttribute("aria-label", `${formatDayKey(key, true)}: ${bits.join(", ")}`);
    }
    if (key === todayKey) cell.classList.add("today");
    if (key === activeKey) {
      cell.classList.add("active");
      cell.setAttribute("aria-current", "date");
    }

    cell.appendChild(el("span", "cal-num", String(day)));
    if (busy) {
      const dots = el("span", "cal-dots");
      if (postCount) dots.appendChild(el("i", "dot post"));
      if (eventCount) dots.appendChild(el("i", "dot event"));
      cell.appendChild(dots);
    }
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
}

// =========================================================
// 8. Views, seedling reaction, share
// =========================================================

function makeViews(post) {
  const wrap = el("span", "views-label");
  wrap.dataset.viewsId = post.id;
  wrap.title = "Views";
  wrap.append(icon("eye", 17), el("span", "views-num", String(post.views || 0)));
  return wrap;
}

function refreshViews(post) {
  document.querySelectorAll(`[data-views-id="${post.id}"] .views-num`).forEach((node) => {
    node.textContent = String(post.views || 0);
  });
}

// Count one view per post per browser session.
// (Your own browser is skipped once you've logged in to /admin.html.)
async function countView(post) {
  if (isAdminBrowser() || viewed.has(post.id)) return;
  viewed.add(post.id);
  writeList(sessionStorage, "hardin-viewed", [...viewed]);

  post.views = (post.views || 0) + 1;
  refreshViews(post);
  try {
    await updateDoc(doc(db, "posts", post.id), { views: increment(1) });
  } catch (error) {
    console.error(error);
  }
}

// The seedling button: gray until you click it, then filled green
function makeReactButton(post) {
  const btn = el("button", "react-btn");
  btn.type = "button";
  btn.dataset.id = post.id;
  btn.append(icon("seedling"), el("span", "react-count", String(post.reactions || 0)));
  paintReact(btn, post);
  btn.addEventListener("click", () => toggleReaction(post));
  return btn;
}

function paintReact(btn, post) {
  const on = reacted.has(post.id);
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", on ? "Take back your seedling" : "Plant a seedling to show you liked this");
  btn.title = on ? "You planted a seedling" : "Plant a seedling";
  btn.querySelector(".react-count").textContent = String(post.reactions || 0);
}

function refreshReactButtons(post) {
  document.querySelectorAll(`.react-btn[data-id="${post.id}"]`).forEach((btn) => paintReact(btn, post));
}

async function toggleReaction(post) {
  const turningOn = !reacted.has(post.id);

  // Update the screen straight away, then save
  if (turningOn) reacted.add(post.id); else reacted.delete(post.id);
  post.reactions = Math.max(0, (post.reactions || 0) + (turningOn ? 1 : -1));
  writeList(localStorage, "hardin-reacted", [...reacted]);
  refreshReactButtons(post);

  try {
    await updateDoc(doc(db, "posts", post.id), { reactions: increment(turningOn ? 1 : -1) });
  } catch (error) {
    console.error(error);
    // Saving failed, so undo what we showed
    if (turningOn) reacted.delete(post.id); else reacted.add(post.id);
    post.reactions = Math.max(0, (post.reactions || 0) + (turningOn ? -1 : 1));
    writeList(localStorage, "hardin-reacted", [...reacted]);
    refreshReactButtons(post);
  }
}

// Copies the direct link to this post
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const box = document.createElement("textarea");
    box.value = text;
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    document.execCommand("copy");
    box.remove();
  }
}

function makeShareButton(post) {
  const btn = el("button", "action-btn");
  btn.type = "button";
  btn.append(icon("share"), el("span", "btn-label", "Share"));
  btn.addEventListener("click", async () => {
    await copyText(postLink(post.id));
    const label = btn.querySelector(".btn-label");
    label.textContent = "Link copied";
    btn.classList.add("done");
    setTimeout(() => {
      label.textContent = "Share";
      btn.classList.remove("done");
    }, 1800);
  });
  return btn;
}

// Thin green bar at the top while you read a post
function updateProgress() {
  const bar = $("read-progress");
  if (currentRoute.name !== "post") { bar.style.width = "0"; return; }
  const max = document.documentElement.scrollHeight - window.innerHeight;
  bar.style.width = max > 0 ? `${Math.min(100, (window.scrollY / max) * 100)}%` : "0";
}
window.addEventListener("scroll", updateProgress, { passive: true });

// =========================================================
// 9. Site visit counter
// =========================================================

async function trackVisit() {
  const ref = doc(db, "siteStats", "counter");
  try {
    // One count per browser session. Your own logged-in browser is skipped.
    if (!sessionStorage.getItem("hardin-visited") && !isAdminBrowser()) {
      await setDoc(ref, { visits: increment(1) }, { merge: true });
      sessionStorage.setItem("hardin-visited", "1");
    }
    const snap = await getDoc(ref);
    if (snap.exists()) {
      $("visit-count").textContent = `${snap.data().visits.toLocaleString()} visits so far`;
    }
  } catch (error) {
    console.error(error);
  }
}

// =========================================================
// 10. Day / night mode
// =========================================================

function paintTheme() {
  const night = document.documentElement.dataset.theme === "night";
  const btn = $("theme-toggle");
  btn.replaceChildren(icon(night ? "sun" : "moon"));
  btn.setAttribute("aria-label", night ? "Switch to day mode" : "Switch to night mode");
}

$("theme-toggle").addEventListener("click", () => {
  const night = document.documentElement.dataset.theme === "night";
  if (night) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = "night";
  setPref("hardin-theme", night ? "day" : "night");
  paintTheme();
});

$("install-app").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("install-app").hidden = true;
});

// =========================================================
// Start
// =========================================================

$("brand-icon").appendChild(icon("seedling", 26));
$("search-icon").appendChild(icon("search"));
$("announcement-close").appendChild(icon("close", 16));
paintTheme();
enableButtonEffects();
loadData();
trackVisit();
