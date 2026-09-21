// =========================================================
// Hardin: public site
//
// Hardin is one HTML file (index.html) that acts like several pages.
// The address after the # decides which page you see:
//
//   #/                Home
//   #/folder/ID       A folder page
//   #/post/ID         One post (the reading page)
////   #/day/2026-09-21  Everything from one calendar day
//   #/search          Search results
//   #/about           About me
//
// The templates for each page live in index.html.
// This file fills them in and swaps them with a soft transition.
// Visitors can only read, react, view and search.
// The Firestore rules decide exactly what they may write.
// =========================================================

import { db } from "./firebase-config.js";
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
const settings = { tagline: "", about: "" };

let postsByDay = {};    // "2026-09-21" -> how many posts
let eventsByDay = {};   // "2026-09-21" -> [events]

let dataReady = false;
let navToken = 0;
let currentRoute = { name: "home", arg: "" };
let searchText = "";
let searchUI = null;

// ---------- Small storage helpers (a blocked browser never breaks the page) ----------
function readList(storage, key) {
  try { return JSON.parse(storage.getItem(key) || "[]"); } catch (e) { return []; }
}
function writeList(storage, key, list) {
  try { storage.setItem(key, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
function isAdminBrowser() {
  try { return localStorage.getItem("hardin-is-admin") === "1"; } catch (e) { return false; }
}

const reacted = new Set(readList(localStorage, "hardin-reacted"));
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
      // These two are extras: if they fail, the rest of the site still works
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
    }

    buildDayIndexes();
    dataReady = true;
    route();
  } catch (error) {
    console.error(error);
    view.replaceChildren(el("p", "status", "Couldn't load Hardin. Check firebase-config.js and your Firestore rules."));
  }
}

// Quick lookups for the calendar
function buildDayIndexes() {
  postsByDay = {};
  posts.forEach((post) => {
    const key = postDayKey(post);
    if (key) postsByDay[key] = (postsByDay[key] || 0) + 1;
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

  const pathPart = raw.replace(/^#\/?/, "").split("?")[0];
  let parts = pathPart.split("/").filter(Boolean);
  try { parts = parts.map(decodeURIComponent); } catch (e) { /* keep the raw text */ }

  return {
    name: parts[0] || "home",
    arg: parts.slice(1).join("/")
  };
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
  document.title = page.title ? `${page.title} · Hardin` : "Hardin";

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
    case "home":   return pageHome(r);
    case "folder": return pageFolder(r);
    case "post":   return pagePost(r);
    case "day":    return pageDay(r);
    case "search": return pageSearch();
    case "about":  return pageAbout();
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
  return [post.title, post.subtitle, post.summary, post.body]
    .join(" ").toLowerCase().includes(q);
}

function fillGrid(container, list) {
  container.replaceChildren(...list.map(makeCard));
}

function setEmpty(node, text) {
  const box = slot(node, "empty");
  box.textContent = text;
  box.hidden = !text;
}

function getViewMode() {
  try {
    const saved = localStorage.getItem("hardin-view-mode");
    return ["grid", "list", "accordion"].includes(saved) ? saved : "grid";
  } catch (e) {
    return "grid";
  }
}

function saveViewMode(mode) {
  try { localStorage.setItem("hardin-view-mode", mode); } catch (e) { /* ignore */ }
}

function fillFolderAccordion(container, parentId, postsList) {
  container.replaceChildren();

  const groups = tree.children(parentId).map((folder) => {
    const ids = tree.descendants(folder.id);
    const items = postsList.filter((post) => ids.has(post.folderId));
    return { folder, items };
  }).filter((group) => group.items.length > 0);

  if (groups.length === 0) {
    const details = el("details", "folder-accordion-item");
    details.open = true;
    const summary = el("summary", "", "Items");
    details.appendChild(summary);
    const body = el("div", "accordion-items");
    postsList.forEach((post) => body.appendChild(makeCard(post)));
    details.appendChild(body);
    container.appendChild(details);
    return;
  }

  groups.forEach(({ folder, items }) => {
    const look = tree.look(folder.id);
    const details = el("details", `folder-accordion-item color-${look.color}`);
    const summary = el("summary");
    summary.append(
      el("span", "accordion-icon", look.icon),
      el("span", "accordion-name", folder.name),
      el("span", "accordion-count", countText(items.length, "post"))
    );
    const body = el("div", "accordion-items");
    items.forEach((post) => body.appendChild(makeCard(post)));
    details.append(summary, body);
    container.appendChild(details);
  });

  // Posts directly in the current folder are kept visible in their own section.
  const childFolderIds = new Set(groups.flatMap(({ folder }) => [...tree.descendants(folder.id)]));
  const direct = postsList.filter((post) => !childFolderIds.has(post.folderId));
  if (direct.length) {
    const details = el("details", "folder-accordion-item");
    details.open = true;
    details.appendChild(el("summary", "", `Items · ${countText(direct.length, "post")}`));
    const body = el("div", "accordion-items");
    direct.forEach((post) => body.appendChild(makeCard(post)));
    details.appendChild(body);
    container.appendChild(details);
  }
}

function setupViewSwitcher(node, parentId, postsList) {
  const toolbar = slot(node, "view-toolbar");
  const tiles = slot(node, "tiles");
  const grid = slot(node, "grid");
  const accordion = slot(node, "accordion");
  if (!toolbar || !tiles || !grid || !accordion) return;

  toolbar.hidden = false;
  const apply = (mode) => {
    const buttons = toolbar.querySelectorAll(".view-switch");
    buttons.forEach((button) => {
      const active = button.dataset.view === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    const hasFolders = !tiles.hidden && tiles.children.length > 0;
    tiles.classList.toggle("view-list", mode === "list");
    grid.classList.toggle("view-list", mode === "list");
    tiles.hidden = mode === "accordion" || !hasFolders;
    grid.hidden = mode === "accordion";
    accordion.hidden = mode !== "accordion";

    if (mode === "accordion") fillFolderAccordion(accordion, parentId, postsList);
    saveViewMode(mode);
  };

  toolbar.querySelectorAll(".view-switch").forEach((button) => {
    button.addEventListener("click", () => apply(button.dataset.view));
  });

  apply(getViewMode());
}

function fillQuickGlance(container) {
  const stats = [
    ["seedling", tree.children(null).length, "folders"],
    ["book", posts.length, "posts"],
    ["calendar", events.length, "events"]
  ];
  container.replaceChildren();
  const copy = el("div", "quick-copy");
  copy.appendChild(el("strong", "quick-title", "A little overview"));
  copy.appendChild(el("span", "quick-sub", "Everything you've planted in Hardin, at a glance."));
  const row = el("div", "quick-stats");
  stats.forEach(([iconName, value, label]) => {
    const item = el("div", "quick-stat");
    item.append(icon(iconName, 18), el("strong", "", String(value)), el("span", "", label));
    row.appendChild(item);
  });
  container.append(copy, row);
}

// Folder tiles for the folders inside a folder (null = top level)
function fillTiles(container, parentId) {
  container.replaceChildren();

  tree.children(parentId).forEach((folder) => {
    const ids = tree.descendants(folder.id);
    const count = posts.filter((p) => ids.has(p.folderId)).length;
    if (count === 0) return;   // never show empty folders to visitors

    const look = tree.look(folder.id);
    const tile = el("a", `folder-tile color-${look.color}`);
    tile.href = href.folder(folder.id);
    tile.appendChild(el("span", "tile-icon", look.icon));
    tile.appendChild(el("span", "tile-name", folder.name));
    tile.appendChild(el("span", "tile-count", countText(count, "post")));
    container.appendChild(tile);
  });

  container.hidden = container.children.length === 0;
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

  // Bottom row: seedling, share, views
  const foot = el("div", "card-foot");
  foot.append(makeReactButton(post), makeShareButton(post), makeViews(post));
  card.appendChild(foot);

  return card;
}

// =========================================================
// 4. The pages
// =========================================================

// ---------- Home ----------
function pageHome() {
  const node = cloneTemplate("tpl-home");
  if (settings.tagline) slot(node, "tagline").textContent = settings.tagline;

  const tiles = slot(node, "tiles");
  fillTiles(tiles, null);
  slot(node, "folders-block").hidden = tiles.hidden;

  const sorted = sortPosts(posts);
  const featured = sorted.filter((p) => p.pinned);
  const latest = sorted.filter((p) => !p.pinned);

  fillGrid(slot(node, "featured"), featured);
  slot(node, "featured-block").hidden = featured.length === 0;
  slot(node, "latest-title").textContent = featured.length > 0 ? "Latest" : "All posts";
  fillGrid(slot(node, "grid"), latest);

  if (latest.length === 0 && featured.length === 0) {
    setEmpty(node, posts.length === 0 ? "Nothing planted here yet. Check back soon." : "Nothing to show here yet.");
  }

  fillQuickGlance(slot(node, "quick-glance"));
  slot(node, "calendar").appendChild(makeCalendar(""));
  fillUpcoming(slot(node, "upcoming-block"), slot(node, "upcoming"));

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

  const ids = tree.descendants(folder.id);
  const inFolder = sortPosts(posts.filter((p) => ids.has(p.folderId)));
  slot(node, "sub").textContent = countText(inFolder.length, "post");
  fillTiles(slot(node, "tiles"), folder.id);
  fillGrid(slot(node, "grid"), inFolder);
  setupViewSwitcher(node, folder.id, inFolder);

  if (inFolder.length === 0 && slot(node, "tiles").hidden) setEmpty(node, "Nothing in this folder yet.");

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

  fillGrid(slot(node, "grid"), dayPosts);
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
  fillGrid(searchUI.grid, list);
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

// ---------- One post (Substack-style reading page) ----------
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

  if (post.linkUrl && post.linkUrl.startsWith("https://")) {
    const link = el("a", "btn primary", "Open project");
    link.href = post.linkUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    slot(node, "link").appendChild(link);
  }
  tagBox.hidden = tagBox.children.length === 0;

  slot(node, "actions").append(makeReactButton(post), makeShareButton(post));

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
  slot(node, "portrait").appendChild(icon("seedling", 64));

  if (settings.about) {
    const box = slot(node, "about-text");
    box.replaceChildren();
    renderBody(settings.about, box);
  }
  return { node, title: "About" };
}

function pageMissing() {
  return { node: cloneTemplate("tpl-missing"), title: "Not found" };
}

// =========================================================
// 5. Calendar (Telegram-style)
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

  // Header: previous, month name, next
  const head = el("div", "cal-head");
  const prev = el("button", "cal-nav");
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous month");
  prev.appendChild(icon("chevronLeft", 18));
  prev.addEventListener("click", () => {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    drawCalendar(wrap, activeKey);
  });

  const next = el("button", "cal-nav");
  next.type = "button";
  next.setAttribute("aria-label", "Next month");
  next.appendChild(icon("chevronRight", 18));
  next.addEventListener("click", () => {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    drawCalendar(wrap, activeKey);
  });

  const title = el("h3", "cal-title",
    new Date(calYear, calMonth, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }));
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

  // Legend + jump back to this month
  const foot = el("div", "cal-foot");
  const legend = el("span", "cal-legend");
  legend.innerHTML = '<i class="dot post"></i> posts <i class="dot event"></i> events';
  const today = el("button", "cal-today", "Today");
  today.type = "button";
  today.addEventListener("click", () => {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    drawCalendar(wrap, activeKey);
  });
  foot.append(legend, today);
  wrap.appendChild(foot);
}

// The next few events, under the calendar on Home
function fillUpcoming(block, list) {
  const todayKey = dateKey(new Date());
  const upcoming = events
    .filter((e) => isDayKey(e.date) && e.date >= todayKey)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4);

  list.replaceChildren();
  upcoming.forEach((event) => {
    const item = el("li");
    const link = el("a", "upcoming-link");
    link.href = href.day(event.date);
    link.append(
      el("span", "upcoming-marker", event.marker || "📌"),
      el("span", "upcoming-title", event.title),
      el("span", "upcoming-date", formatDayKey(event.date))
    );
    item.appendChild(link);
    list.appendChild(item);
  });
  block.hidden = upcoming.length === 0;
}

// =========================================================
// 6. Views, seedling reaction, share
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
// 7. Site visit counter
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
// 8. Day / night mode
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
  try { localStorage.setItem("hardin-theme", night ? "day" : "night"); } catch (e) { /* ignore */ }
  paintTheme();
});

// =========================================================
// Start
// =========================================================

$("brand-icon").appendChild(icon("seedling", 26));
$("search-icon").appendChild(icon("search"));
paintTheme();
enableButtonEffects();
loadData();
trackVisit();
