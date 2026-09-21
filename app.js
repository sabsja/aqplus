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

import { auth, db } from "./firebase-config.js";
import { SITE_NAME } from "./hardin-config.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  updateDoc,
  addDoc,
  deleteDoc,
  setDoc,
  increment,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  el,
  icon,
  MOODS,
  buildFolderTree,
  formatDate,
  formatRelativeDate,
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
let isAdmin = false;
let adminUser = null;
let adminEditingId = null;
const ADMIN_UID = "dq1svskEn1SmaJQsB2AHugYjvis1";

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

onAuthStateChanged(auth, (user) => {
  adminUser = user;
  isAdmin = Boolean(user && user.uid === ADMIN_UID);
  document.body.classList.toggle("is-admin", isAdmin);
  const button = $("admin-login");
  if (button) button.textContent = isAdmin ? "Admin · Sign out" : "Admin";
  if (user && !isAdmin) $("admin-login-status").textContent = "This account is not the configured Haqin admin account.";
  if (!isAdmin) closeAdminModal();
  else if ($("admin-modal") && !$('admin-modal').hidden) openAdminEditor(null);
  if (dataReady) loadData();
});

setPersistence(auth, browserLocalPersistence).catch((error) => console.error(error));

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

function closeAdminModal() {
  $("admin-modal").hidden = true;
  adminEditingId = null;
}

function openAdminEditor(post) {
  if (!isAdmin) return;
  const modal = $("admin-modal");
  modal.hidden = false;
  $("admin-login-view").hidden = true;
  $("admin-editor-view").hidden = false;
  const folder = $("admin-folder");
  folder.replaceChildren(new Option("Unsorted (no folder)", ""), ...tree.flat().map(({ folder: item }) => new Option(tree.label(item.id), item.id)));
  adminEditingId = post ? post.id : null;
  $("admin-editor-title").textContent = post ? "Edit post" : "New post";
  $("admin-title").value = post?.title || "";
  $("admin-subtitle").value = post?.subtitle || "";
  folder.value = post?.folderId || "";
  $("admin-status").value = post?.status || "published";
  $("admin-summary").value = post?.summary || "";
  $("admin-body").value = post?.body || "";
  $("admin-pinned").checked = Boolean(post?.pinned);
  $("admin-post-status").textContent = "";
  setAdminView("posts");
}

function setAdminView(name) {
  document.querySelectorAll("[data-admin-view]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.adminView === name)));
  document.querySelectorAll("[data-admin-panel]").forEach((panel) => { panel.hidden = panel.dataset.adminPanel !== name; });
  if (name === "site") loadAdminSite();
}

function renderAdminFolders() {
  const list = document.querySelector("[data-admin-folder-list]");
  if (!list) return;
  list.replaceChildren();
  tree.flat().forEach(({ folder, depth }) => {
    const item = el("li", "admin-mini-item");
    item.style.paddingLeft = `${depth * 0.9}rem`;
    item.append(el("span", "", `${folder.icon || "🌿"} ${folder.name}`));
    const actions = el("span", "admin-mini-actions");
    const rename = el("button", "btn ghost small", "Rename");
    rename.type = "button";
    rename.addEventListener("click", async () => {
      const name = (window.prompt("New folder name", folder.name) || "").trim();
      if (!name || name === folder.name) return;
      await updateDoc(doc(db, "folders", folder.id), { name });
      await loadData();
      loadAdminSite();
    });
    const remove = el("button", "btn danger small", "Delete");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (tree.children(folder.id).length || posts.some((post) => post.folderId === folder.id)) {
        document.querySelector("[data-admin-site-status]").textContent = "Move its posts and child folders before deleting it.";
        return;
      }
      if (!window.confirm(`Delete ${folder.name}?`)) return;
      await deleteDoc(doc(db, "folders", folder.id));
      await loadData();
      loadAdminSite();
    });
    actions.append(rename, remove);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

function loadAdminSite() {
  $("admin-tagline").value = settings.tagline || "";
  $("admin-about").value = settings.about || "";
  $("admin-announcement").value = settings.announcement || "";
  $("admin-site-status").textContent = "";
  renderAdminFolders();
}

function openAdminLogin() {
  const modal = $("admin-modal");
  modal.hidden = false;
  $("admin-login-view").hidden = isAdmin;
  $("admin-editor-view").hidden = !isAdmin;
  if (isAdmin) openAdminEditor(null);
}

$("admin-login").addEventListener("click", () => {
  if (isAdmin) signOut(auth);
  else openAdminLogin();
});
document.querySelectorAll("[data-admin-close]").forEach((node) => node.addEventListener("click", closeAdminModal));
document.querySelector("[data-admin-login-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("admin-login-status");
  status.textContent = "Signing in...";
  try {
    await signInWithEmailAndPassword(auth, $("admin-email").value.trim(), $("admin-password").value);
    status.textContent = "Signed in.";
  } catch (error) {
    console.error(error);
    const code = error?.code || "unknown";
    status.textContent = code === "auth/unauthorized-domain"
      ? "Firebase blocked this address. Open the site from an authorized web address, not file://."
      : code === "auth/invalid-credential"
        ? "That email or password does not match a Firebase Auth account in this project."
        : `Couldn't sign in (${code}).`;
  }
});
document.querySelector("[data-admin-signout]").addEventListener("click", () => signOut(auth));
document.querySelector("[data-admin-new]").addEventListener("click", () => openAdminEditor(null));
document.querySelectorAll("[data-admin-view]").forEach((button) => button.addEventListener("click", () => setAdminView(button.dataset.adminView)));
document.querySelector("[data-admin-site-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = { tagline: $("admin-tagline").value.trim(), about: $("admin-about").value.trim(), announcement: $("admin-announcement").value.trim() };
  try {
    await setDoc(doc(db, "settings", "site"), data, { merge: true });
    Object.assign(settings, data);
    setupAnnouncement();
    $("admin-site-status").textContent = "Profile saved.";
  } catch (error) {
    console.error(error);
    $("admin-site-status").textContent = "Couldn't save the profile.";
  }
});
document.querySelector("[data-admin-folder-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("admin-folder-name").value.trim();
  if (!name) return;
  try {
    await addDoc(collection(db, "folders"), { name, parentId: null, icon: $("admin-folder-icon").value.trim() || "🌿", color: "sage", createdAt: serverTimestamp() });
    event.target.reset();
    await loadData();
    loadAdminSite();
  } catch (error) {
    console.error(error);
    $("admin-site-status").textContent = "Couldn't add the folder.";
  }
});
document.querySelector("[data-admin-post-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdmin) return;
  const data = {
    title: $("admin-title").value.trim(), subtitle: $("admin-subtitle").value.trim(), folderId: $("admin-folder").value,
    summary: $("admin-summary").value.trim(), body: $("admin-body").value.trim(), status: $("admin-status").value,
    pinned: $("admin-pinned").checked
  };
  const status = $("admin-post-status");
  try {
    if (adminEditingId) await updateDoc(doc(db, "posts", adminEditingId), { ...data, updatedAt: serverTimestamp() });
    else await addDoc(collection(db, "posts"), { ...data, views: 0, reactions: 0, createdAt: serverTimestamp(), publishedAt: data.status === "published" ? serverTimestamp() : null });
    status.textContent = "Post saved.";
    await loadData();
    openAdminEditor(null);
  } catch (error) {
    console.error(error);
    status.textContent = "Couldn't save the post. Check your Firebase permissions.";
  }
});

// =========================================================
// 1. Load everything from Firestore
// =========================================================

async function loadData() {
  try {
    const [folderSnap, postSnap, eventSnap, settingsSnap] = await Promise.all([
      getDocs(collection(db, "folders")),
      // Visitors only receive published posts; the authenticated admin can manage drafts too.
      isAdmin ? getDocs(collection(db, "posts")) : getDocs(query(collection(db, "posts"), where("status", "==", "published"))),
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
    case "garden": return pageGarden();
    case "klase":  return pageKlase();
    case "cycle":  return pageCycle();
    case "focus":  return pageFocus();
    case "tasks":  return pageTasks();
    case "wallet":  return pageWallet();
    case "prayer":  return pageDevotionals();
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
  const mode = getPref("hardin-post-sort", "newest");
  return [...list].sort((a, b) => {
    const featured = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (featured) return featured;
    if (mode === "oldest") return postDateMs(a) - postDateMs(b);
    if (mode === "updated") return (timestampDate(b.updatedAt)?.getTime() || postDateMs(b)) - (timestampDate(a.updatedAt)?.getTime() || postDateMs(a));
    if (mode === "title") return (a.title || "").localeCompare(b.title || "");
    return postDateMs(b) - postDateMs(a);
  });
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
  const updated = formatRelativeDate(post.updatedAt);
  if (updated) parts.push(el("span", "updated-meta", updated));
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

  if (isAdmin) {
    const adminTools = el("div", "admin-card-tools");
    const edit = el("button", "btn ghost small", "Edit");
    edit.type = "button";
    edit.addEventListener("click", (event) => { event.preventDefault(); openAdminEditor(post); });
    const remove = el("button", "btn danger small", "Delete");
    remove.type = "button";
    remove.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!window.confirm(`Delete “${post.title}”?`)) return;
      await deleteDoc(doc(db, "posts", post.id));
      await loadData();
    });
    adminTools.append(edit, remove);
    card.appendChild(adminTools);
  }

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
  container.replaceChildren(...sortPosts(list).map((post) => (cards ? makeCard(post) : makePostRow(post))));
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

  const sort = el("select", "sort-select");
  sort.setAttribute("aria-label", "Sort posts");
  [["newest", "Newest first"], ["updated", "Recently updated"], ["oldest", "Oldest first"], ["title", "Title A-Z"]].forEach(([value, label]) => sort.appendChild(new Option(label, value)));
  sort.value = getPref("hardin-post-sort", "newest");
  sort.addEventListener("change", () => { setPref("hardin-post-sort", sort.value); redraw(); buildViewControls(bar, redraw); });
  bar.append(el("span", "view-label sort-label", "Sort"), sort);

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
  fillGreeting(node);
  fillHomePersonal(node);

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

function fillGreeting(node) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  slot(node, "today").textContent = today;
}

function timestampDate(value) {
  return value && value.toDate ? value.toDate() : value ? new Date(value) : null;
}

function personalStats() {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const monthPosts = posts.filter((post) => {
    const date = timestampDate(post.createdAt || post.publishedAt);
    return date && date.getMonth() === month && date.getFullYear() === year;
  }).length;
  const activeDays = new Set(posts.map(postDayKey).filter(Boolean)).size;
  const words = posts.reduce((sum, post) => sum + wordCount(post.body), 0);
  const klaseTasks = readList(localStorage, "hardin-klase-tasks");
  const quickTasks = readList(localStorage, "hardin-tasks");
  return {
    entries: posts.length,
    folders: folders.length,
    saved: posts.filter((post) => saved.has(post.id)).length,
    monthPosts,
    activeDays,
    words,
    completed: quickTasks.filter((task) => task.done).length + klaseTasks.filter((task) => task.status === "completed").length
  };
}

function fillHomePersonal(node) {
  const stats = personalStats();
  const analytics = slot(node, "analytics");
  analytics.appendChild(el("div", "personal-heading", "Your Haqin"));
  const statGrid = el("div", "personal-stats");
  [["🌱", stats.entries, "entries"], ["🍃", stats.folders, "folders"], ["🔖", stats.saved, "saved"], ["🌼", stats.monthPosts, "this month"]].forEach(([symbol, value, label]) => {
    const item = el("div", "personal-stat");
    item.append(el("span", "personal-stat-symbol", symbol), el("strong", "", String(value)), el("span", "", label));
    statGrid.appendChild(item);
  });
  analytics.append(statGrid, el("p", "growth-whisper", stats.entries ? "🌱 Growing slowly" : "🌱 Ready for the first planting"));

  const klase = slot(node, "home-klase");
  const klaseCard = el("section", "home-feature");
  klaseCard.append(el("p", "eyebrow", "Klase"), el("h2", "", "Today's rhythm"));
  const todayName = new Date().toLocaleDateString("en-US", { weekday: "long" });
  const todayClasses = readList(localStorage, "hardin-klase-schedule").filter((entry) => entry.day === todayName).sort((a, b) => a.start.localeCompare(b.start));
  klaseCard.appendChild(el("p", "home-feature-text", todayClasses[0] ? `${todayClasses[0].start} · ${todayClasses[0].subject}` : "No classes planned for today."));
  klaseCard.appendChild(el("a", "text-link", "Open Klase →")).href = "#/klase";
  klase.appendChild(klaseCard);

  const garden = slot(node, "home-garden");
  const gardenCard = el("section", "home-feature");
  const growth = gardenGrowth(stats.entries);
  gardenCard.append(el("p", "eyebrow", "Garden"), el("h2", "", `${growth.icon} ${growth.name}`));
  const preview = el("div", "garden-mini", growth.unlocked.map((item) => item.symbol).join(" ") || "🌱");
  gardenCard.append(preview, el("p", "home-feature-text", `${stats.entries} / ${GARDEN_DECORATIONS.length} entries`));
  const gardenLink = el("a", "text-link", "Decorate garden →"); gardenLink.href = "#/garden"; gardenCard.appendChild(gardenLink);
  garden.appendChild(gardenCard);

  fillQuickNotes(node, slot(node, "home-notes"));
}

const GARDEN_DECORATIONS = [
  { symbol: "🌱", name: "Sprout" }, { symbol: "🌿", name: "Grass" }, { symbol: "🌼", name: "Flower" },
  { symbol: "🌷", name: "Tulip" }, { symbol: "🍃", name: "Leaf" }, { symbol: "🌻", name: "Sunflower" },
  { symbol: "🪻", name: "Lavender" }, { symbol: "🪨", name: "Stone" }, { symbol: "🦋", name: "Butterfly" },
  { symbol: "🐝", name: "Bee" }, { symbol: "☀️", name: "Sun" }, { symbol: "☁️", name: "Cloud" },
  { symbol: "🍄", name: "Mushroom" }, { symbol: "🌳", name: "Tree" }
];

function gardenGrowth(count) {
  const unlocked = GARDEN_DECORATIONS.slice(0, Math.min(count, GARDEN_DECORATIONS.length));
  const stages = count < 1 ? ["Seedling", "🌱"] : count < 6 ? ["Seedling", "🌱"] : count < 16 ? ["Growing", "🌿"] : count < 31 ? ["Young Garden", "🪴"] : ["Little Garden", "🌳"];
  return { name: stages[0], icon: stages[1], unlocked };
}

function fillQuickNotes(root, target) {
  const box = el("section", "home-feature quick-notes");
  box.append(el("p", "eyebrow", "Quick notes"), el("h2", "", "Small things to remember"));
  const form = el("form", "quick-note-form");
  const input = el("input"); input.type = "text"; input.placeholder = "Add a quick note"; input.maxLength = 120; input.required = true;
  const add = el("button", "icon-btn small", "+"); add.type = "submit"; add.setAttribute("aria-label", "Add quick note");
  form.append(input, add);
  const list = el("ul", "quick-note-list");
  const draw = () => {
    list.replaceChildren();
    const notes = readList(localStorage, "hardin-quick-notes");
    if (!notes.length) list.appendChild(el("li", "empty-state", "Nothing waiting here."));
    notes.slice(0, 5).forEach((note) => {
      const item = el("li", `quick-note${note.done ? " is-done" : ""}`);
      const check = el("input"); check.type = "checkbox"; check.checked = Boolean(note.done); check.setAttribute("aria-label", `Complete ${note.text}`);
      check.addEventListener("change", () => { writeList(localStorage, "hardin-quick-notes", readList(localStorage, "hardin-quick-notes").map((entry) => entry.id === note.id ? { ...entry, done: check.checked } : entry)); draw(); });
      const text = el("span", "", note.text); text.title = "Double-click to edit"; text.addEventListener("dblclick", () => { const next = window.prompt("Edit quick note", note.text); if (next && next.trim()) { writeList(localStorage, "hardin-quick-notes", readList(localStorage, "hardin-quick-notes").map((entry) => entry.id === note.id ? { ...entry, text: next.trim() } : entry)); draw(); } }); const remove = el("button", "icon-btn small", "×"); remove.type = "button"; remove.setAttribute("aria-label", `Delete ${note.text}`);
      remove.addEventListener("click", () => { writeList(localStorage, "hardin-quick-notes", readList(localStorage, "hardin-quick-notes").filter((entry) => entry.id !== note.id)); draw(); });
      item.append(check, text, remove); list.appendChild(item);
    });
  };
  form.addEventListener("submit", (event) => { event.preventDefault(); writeList(localStorage, "hardin-quick-notes", [...readList(localStorage, "hardin-quick-notes"), { id: Date.now().toString(), text: input.value.trim(), done: false }]); input.value = ""; draw(); });
  box.append(form, list);
  target.appendChild(box);
  draw();
}

function pageGarden() {
  const node = cloneTemplate("tpl-garden");
  const stage = node.querySelector("[data-garden-stage]");
  const palette = node.querySelector("[data-garden-palette]");
  const progress = node.querySelector("[data-garden-progress]");
  const status = node.querySelector("[data-garden-status]");
  const growth = gardenGrowth(posts.length);
  let selected = null;
  const layoutKey = "hardin-garden-layout";
  const draw = () => {
    const layout = readList(localStorage, layoutKey);
    stage.replaceChildren();
    if (!layout.length) stage.appendChild(el("p", "garden-empty", "Choose something below, then tap the garden to place it."));
    layout.forEach((item) => {
      const decoration = GARDEN_DECORATIONS[item.type];
      if (!decoration) return;
      const placed = el("button", "garden-decoration", decoration.symbol);
      placed.type = "button"; placed.style.left = `${item.x}%`; placed.style.top = `${item.y}%`;
      placed.title = `Remove ${decoration.name}`; placed.setAttribute("aria-label", `Remove ${decoration.name}`);
      placed.addEventListener("click", (event) => { event.stopPropagation(); writeList(localStorage, layoutKey, layout.filter((entry) => entry.id !== item.id)); draw(); });
      stage.appendChild(placed);
    });
    palette.replaceChildren();
    growth.unlocked.forEach((item, index) => {
      const button = el("button", `garden-choice${selected === index ? " selected" : ""}`, `${item.symbol} ${item.name}`);
      button.type = "button"; button.disabled = false; button.setAttribute("aria-pressed", String(selected === index));
      button.addEventListener("click", () => { selected = index; status.textContent = `Place ${item.name} anywhere in the garden.`; draw(); });
      palette.appendChild(button);
    });
    const next = Math.min(GARDEN_DECORATIONS.length, Math.max(posts.length + 1, 1));
    progress.replaceChildren(el("strong", "", `${posts.length} / ${GARDEN_DECORATIONS.length} entries`), el("span", "", posts.length >= GARDEN_DECORATIONS.length ? "Your little garden is in bloom." : `${next - posts.length} more ${next - posts.length === 1 ? "entry" : "entries"} unlocks the next decoration.`));
  };
  stage.addEventListener("click", (event) => {
    if (selected === null) { status.textContent = "Choose an unlocked decoration first."; return; }
    const rect = stage.getBoundingClientRect();
    const x = Math.max(5, Math.min(95, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(8, Math.min(82, ((event.clientY - rect.top) / rect.height) * 100));
    const layout = readList(localStorage, layoutKey);
    writeList(localStorage, layoutKey, [...layout, { id: Date.now().toString(), type: selected, x, y }]);
    status.textContent = "A new little thing has found its place.";
    selected = null; draw();
  });
  node.querySelector("[data-garden-reset]").addEventListener("click", () => { writeList(localStorage, layoutKey, []); status.textContent = "The garden is ready for a new arrangement."; draw(); });
  draw();
  return { node, title: "Garden" };
}

const KLASE_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DEFAULT_KLASE_SCHEDULE = [
  { day: "Monday", code: "CCCS 101", subject: "Introduction to Computing", start: "08:00", end: "10:00", room: "AB4-TR001", teacher: "Ms. Pandes T.", section: "BSCS 1A", units: "3", order: 0 },
  { day: "Monday", code: "CCCS 101", subject: "Introduction to Computing", start: "10:00", end: "13:00", room: "AB4-RISE", teacher: "Ms. Pandes T.", section: "BSCS 1A", units: "3", order: 1 },
  { day: "Tuesday", code: "PATHFIT 1", subject: "Movement Competency Training", start: "08:00", end: "10:00", room: "PE CLASS 3", teacher: "Ms. Alfelor R", section: "BSCS 1A", units: "2" },
  { day: "Tuesday", code: "GE ELECT 4", subject: "Gender and Society", start: "14:00", end: "17:00", room: "ONLINE 22", teacher: "Ms. Severo G", section: "BSCS 1A", units: "3" },
  { day: "Wednesday", code: "CCCS 102", subject: "Fundamentals of Programming", start: "10:00", end: "13:00", room: "AB4-RISE", teacher: "Mr. Ibo A", section: "BSCS 1A", units: "3", order: 0 },
  { day: "Wednesday", code: "CCCS 102", subject: "Fundamentals of Programming", start: "13:00", end: "15:00", room: "AB4-TR001", teacher: "Mr. Ibo A", section: "BSCS 1A", units: "3", order: 1 },
  { day: "Tuesday", code: "CCCS 102", subject: "Fundamentals of Programming", start: "10:00", end: "13:00", room: "AB4-RISE", teacher: "Mr. Ibo A", section: "BSCS 1A", units: "3" },
  { day: "Saturday", code: "GE 1", subject: "Understanding the Self", start: "08:00", end: "11:00", room: "ONLINE 34", teacher: "Ms. Hosana L.", section: "BSCS 1A", units: "3" },
  { day: "Saturday", code: "GE 2", subject: "Readings in Philippine History", start: "12:00", end: "15:00", room: "ONLINE 28", teacher: "Mr. Sablayan E.", section: "BSCS 1A", units: "3" },
  { day: "Saturday", code: "CSAM 112", subject: "Linear Algebra", start: "15:00", end: "18:00", room: "ONLINE 146", teacher: "Mr. Ramos M", section: "BSCS 1A", units: "3" },
  { day: "Sunday", code: "NSTP 1 (ROTC)", subject: "National Service Training Program", start: "07:30", end: "11:30", room: "FIELD 1", teacher: "Mr. Sazon JL", section: "BSCS 1A", units: "3" }
].map((entry, index) => ({ id: `starter-${index + 1}`, ...entry }));

function klaseSchedule() { return readList(localStorage, "hardin-klase-schedule"); }
function klaseTasks() { return readList(localStorage, "hardin-klase-tasks"); }
function klaseGrades() { return readList(localStorage, "hardin-klase-grades"); }
function subjectNames() { return [...new Set(klaseSchedule().map((entry) => entry.subject).filter(Boolean))].sort(); }
function subjectCodes() { return [...new Set(klaseSchedule().map((entry) => entry.code || entry.subject).filter(Boolean))].sort(); }
function timeText(value) { return value ? new Date(`2000-01-01T${value}`).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""; }

function pageKlase() {
  const node = cloneTemplate("tpl-klase");
  const form = node.querySelector("[data-klase-schedule-form]");
  const editor = node.querySelector(".schedule-editor");
  const fields = {
    id: node.querySelector("[data-klase-edit-id]"), day: node.querySelector("[data-klase-day]"), subject: node.querySelector("[data-klase-subject]"),
    start: node.querySelector("[data-klase-start]"), end: node.querySelector("[data-klase-end]"), room: node.querySelector("[data-klase-room]"),
    teacher: node.querySelector("[data-klase-teacher]"), notes: node.querySelector("[data-klase-class-notes]"), code: node.querySelector("[data-klase-code]"),
    units: node.querySelector("[data-klase-units]"), section: node.querySelector("[data-klase-section]"), description: node.querySelector("[data-klase-description]")
  };
  const status = node.querySelector("[data-klase-schedule-status]");
  const notepad = node.querySelector("[data-klase-notepad]");
  const noteStatus = node.querySelector("[data-klase-note-status]");
  notepad.value = getPref("hardin-klase-notepad", "");
  notepad.addEventListener("input", () => { setPref("hardin-klase-notepad", notepad.value); noteStatus.textContent = "Saved locally"; });
  if (!getPref("hardin-klase-seeded", "") && !klaseSchedule().length) {
    writeList(localStorage, "hardin-klase-schedule", DEFAULT_KLASE_SCHEDULE);
    setPref("hardin-klase-seeded", "1");
  }
  const currentSchedule = klaseSchedule();
  const hasTuesdayCccs102 = currentSchedule.some((entry) => entry.day === "Tuesday" && entry.code === "CCCS 102" && entry.start === "10:00" && entry.end === "13:00");
  if (!hasTuesdayCccs102) {
    writeList(localStorage, "hardin-klase-schedule", [...currentSchedule, DEFAULT_KLASE_SCHEDULE.find((entry) => entry.day === "Tuesday" && entry.code === "CCCS 102" && entry.start === "10:00")]);
  }
  const clearForm = () => { form.reset(); fields.id.value = ""; fields.day.value = "Monday"; node.querySelector("[data-klase-save]").textContent = "Save class"; node.querySelector("[data-klase-cancel]").hidden = true; };
  const drawWeek = () => {
    const week = node.querySelector("[data-klase-week]"); week.replaceChildren();
    const schedule = klaseSchedule();
    KLASE_DAYS.forEach((day) => {
      const column = el("section", "day-column"); column.appendChild(el("h3", "", day));
      const entries = schedule.filter((entry) => entry.day === day).sort((a, b) => (a.order || 0) - (b.order || 0) || a.start.localeCompare(b.start));
      if (!entries.length) column.appendChild(el("p", "empty-state", "No classes"));
      entries.forEach((entry) => {
        const item = el("article", "class-item");
        item.title = [entry.subject, entry.description, entry.teacher, entry.section, entry.units ? `${entry.units} units` : ""].filter(Boolean).join(" · ");
        item.append(el("strong", "", entry.code || entry.subject), el("span", "class-time", `${timeText(entry.start)} - ${timeText(entry.end)}`));
        if (entry.room) item.appendChild(el("small", "feature-item-meta", entry.room));
        column.appendChild(item);
      });
      week.appendChild(column);
    });
  };
  const drawUpcoming = () => {
    const list = node.querySelector("[data-klase-upcoming]"); list.replaceChildren();
    const upcoming = klaseTasks().filter((task) => task.status !== "completed" && task.due).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6);
    if (!upcoming.length) list.appendChild(el("li", "empty-state", "No upcoming deadlines."));
    upcoming.forEach((task) => { const item = el("li", "feature-item"); item.append(el("span", "feature-item-text", task.name), el("small", "feature-item-meta", `${task.subject} · ${new Date(`${task.due}T12:00:00`).toLocaleDateString([], { dateStyle: "medium" })}`)); list.appendChild(item); });
  };
  const drawSubject = () => {
    const select = node.querySelector("[data-klase-subject-select]"); const current = select.value; const names = subjectCodes();
    select.replaceChildren(new Option(names.length ? "Choose a subject code" : "Add a class first", ""), ...names.map((name) => new Option(name, name))); select.value = names.includes(current) ? current : (names[0] || "");
    const workspace = node.querySelector("[data-klase-subject-workspace]"); workspace.replaceChildren();
    if (!select.value) return;
    const subject = select.value;
    const subjectEntries = klaseSchedule().filter((entry) => (entry.code || entry.subject) === subject);
    const taskForm = el("form", "feature-form subject-form");
    taskForm.appendChild(el("h3", "", "School tasks"));
    const taskName = el("input"); taskName.placeholder = "Task name"; taskName.required = true;
    const taskDue = el("input"); taskDue.type = "date";
    const taskPriority = el("select"); ["Normal", "High", "Low"].forEach((value) => taskPriority.appendChild(new Option(value, value.toLowerCase())));
    const taskDescription = el("textarea"); taskDescription.rows = 2; taskDescription.placeholder = "Description or notes";
    const taskAdd = el("button", "btn primary small", "Add task"); taskAdd.type = "submit";
    taskForm.append(el("label", "field", "Task name"), el("label", "field", "Due date"), el("label", "field", "Priority"));
    taskForm.children[1].appendChild(taskName); taskForm.children[2].appendChild(taskDue); taskForm.children[3].appendChild(taskPriority); taskForm.appendChild(taskDescription); taskForm.appendChild(taskAdd);
    taskForm.addEventListener("submit", (event) => { event.preventDefault(); writeList(localStorage, "hardin-klase-tasks", [...klaseTasks(), { id: Date.now().toString(), subject, name: taskName.value.trim(), due: taskDue.value, priority: taskPriority.value, description: taskDescription.value.trim(), status: "todo" }]); drawSubject(); drawUpcoming(); });
    workspace.appendChild(taskForm);
    const taskList = el("ul", "feature-list"); klaseTasks().filter((task) => task.subject === subject).forEach((task) => { const item = el("li", `feature-item${task.status === "completed" ? " is-done" : ""}`); const text = el("span", "feature-item-text", task.name); text.appendChild(el("small", "feature-item-meta", [task.due ? `Due ${task.due}` : "No due date", task.priority].join(" · "))); const state = el("select"); [["todo", "To-do"], ["in-progress", "In progress"], ["completed", "Completed"]].forEach(([value, label]) => state.appendChild(new Option(label, value))); state.value = task.status; state.addEventListener("change", () => { writeList(localStorage, "hardin-klase-tasks", klaseTasks().map((entry) => entry.id === task.id ? { ...entry, status: state.value } : entry)); drawSubject(); drawUpcoming(); }); const remove = el("button", "btn danger small", "Delete"); remove.type = "button"; remove.addEventListener("click", () => { writeList(localStorage, "hardin-klase-tasks", klaseTasks().filter((entry) => entry.id !== task.id)); drawSubject(); drawUpcoming(); }); item.append(text, state, remove); taskList.appendChild(item); });
    if (!taskList.children.length) taskList.appendChild(el("li", "empty-state", "No tasks for this subject yet.")); workspace.appendChild(taskList);
  };
  const drawGrades = (workspace, subject) => {
    const entries = klaseGrades().filter((entry) => entry.subject === subject || entry.code === subject);
    const scoreForm = el("form", "feature-form subject-form scorebook");
    scoreForm.appendChild(el("h3", "", subject));
    const label = el("input"); label.placeholder = "Activity, quiz, project..."; label.required = true;
    const score = el("input"); score.type = "number"; score.min = "0"; score.step = "any"; score.placeholder = "Score"; score.required = true;
    const outOf = el("input"); outOf.type = "number"; outOf.min = "1"; outOf.step = "any"; outOf.placeholder = "Out of"; outOf.required = true;
    const addScore = el("button", "btn primary small", "Add score"); addScore.type = "submit";
    const row = el("div", "score-entry"); row.append(label, score, outOf, addScore); scoreForm.append(row);
    scoreForm.addEventListener("submit", (event) => { event.preventDefault(); writeList(localStorage, "hardin-klase-grades", [...klaseGrades(), { id: Date.now().toString(), subject, code: subject, label: label.value.trim(), score: Number(score.value), outOf: Number(outOf.value) }]); label.value = ""; score.value = ""; outOf.value = ""; drawSubject(); });
    workspace.appendChild(scoreForm);
    const totalScore = entries.reduce((sum, entry) => sum + Number(entry.score || 0), 0);
    const totalOutOf = entries.reduce((sum, entry) => sum + Number(entry.outOf || 0), 0);
    const percent = totalOutOf ? (totalScore / totalOutOf) * 100 : null;
    const summary = el("div", "grade-summary"); summary.append(el("p", "eyebrow", "Current score"), el("strong", "", percent === null ? "—" : `${percent.toFixed(1)}%`), el("p", "hint", percent === null ? "Add your first score below." : `${totalScore} / ${totalOutOf} total points`)); workspace.appendChild(summary);
    const table = el("div", "score-table");
    const headings = el("div", "score-row score-head"); headings.append(el("strong", "", "Score"), el("strong", "", "Points"), el("strong", "", "")); table.appendChild(headings);
    entries.forEach((entry) => { const scoreRow = el("div", "score-row"); scoreRow.append(el("span", "", entry.label), el("span", "", `${entry.score} / ${entry.outOf}`)); const remove = el("button", "btn danger small", "Delete"); remove.type = "button"; remove.addEventListener("click", () => { writeList(localStorage, "hardin-klase-grades", klaseGrades().filter((saved) => saved.id !== entry.id)); drawSubject(); }); scoreRow.appendChild(remove); table.appendChild(scoreRow); });
    if (entries.length) workspace.appendChild(table);
  };
  const drawManager = () => {
    const manager = node.querySelector("[data-klase-manager]");
    manager.replaceChildren(el("h3", "", "Manage classes"));
    const schedule = klaseSchedule();
    if (!schedule.length) { manager.appendChild(el("p", "empty-state", "No classes yet.")); return; }
    schedule.forEach((entry) => {
      const row = el("div", "manager-row");
      row.append(el("span", "manager-class", `${entry.day} · ${entry.code || entry.subject} · ${timeText(entry.start)}`));
      const actions = el("span", "manager-actions");
      const move = (direction) => { const dayEntries = schedule.filter((saved) => saved.day === entry.day).sort((a, b) => (a.order || 0) - (b.order || 0) || a.start.localeCompare(b.start)); const index = dayEntries.findIndex((saved) => saved.id === entry.id); const swap = dayEntries[index + direction]; if (!swap) return; const currentOrder = entry.order || index; const swapOrder = swap.order || index + direction; writeList(localStorage, "hardin-klase-schedule", schedule.map((saved) => saved.id === entry.id ? { ...saved, order: swapOrder } : saved.id === swap.id ? { ...saved, order: currentOrder } : saved)); draw(); };
      const up = el("button", "btn ghost small", "Up"); up.type = "button"; up.addEventListener("click", () => move(-1));
      const down = el("button", "btn ghost small", "Down"); down.type = "button"; down.addEventListener("click", () => move(1));
      const edit = el("button", "btn ghost small", "Edit"); edit.type = "button"; edit.addEventListener("click", () => { fields.id.value = entry.id; fields.day.value = entry.day; fields.code.value = entry.code || ""; fields.subject.value = entry.subject; fields.units.value = entry.units || ""; fields.start.value = entry.start; fields.end.value = entry.end; fields.room.value = entry.room || ""; fields.teacher.value = entry.teacher || ""; fields.section.value = entry.section || ""; fields.description.value = entry.description || ""; fields.notes.value = entry.notes || ""; node.querySelector("[data-klase-save]").textContent = "Update class"; node.querySelector("[data-klase-cancel]").hidden = false; form.scrollIntoView({ behavior: "smooth", block: "start" }); });
      const remove = el("button", "btn danger small", "Delete"); remove.type = "button"; remove.addEventListener("click", () => { writeList(localStorage, "hardin-klase-schedule", schedule.filter((saved) => saved.id !== entry.id)); draw(); });
      actions.append(up, down, edit, remove); row.appendChild(actions); manager.appendChild(row);
    });
  };
  const draw = () => { drawWeek(); drawManager(); drawUpcoming(); drawSubject(); };
  form.addEventListener("submit", (event) => { event.preventDefault(); const existing = klaseSchedule().find((saved) => saved.id === fields.id.value); const entry = { id: fields.id.value || Date.now().toString(), day: fields.day.value, code: fields.code.value.trim(), subject: fields.subject.value.trim(), units: fields.units.value, start: fields.start.value, end: fields.end.value, room: fields.room.value.trim(), teacher: fields.teacher.value.trim(), section: fields.section.value.trim(), description: fields.description.value.trim(), notes: fields.notes.value.trim(), order: existing ? existing.order : undefined }; const schedule = klaseSchedule().filter((saved) => saved.id !== entry.id); writeList(localStorage, "hardin-klase-schedule", [...schedule, entry]); setPref("hardin-klase-seeded", "1"); status.textContent = "Class saved."; clearForm(); draw(); });
  node.querySelector("[data-klase-cancel]").addEventListener("click", clearForm); node.querySelector("[data-klase-subject-select]").addEventListener("change", drawSubject); draw();
  return { node, title: "Klase" };
}

function pageCycle() {
  const node = cloneTemplate("tpl-cycle"); const form = node.querySelector("[data-cycle-form]"); const start = node.querySelector("[data-cycle-start]"); const end = node.querySelector("[data-cycle-end]"); const length = node.querySelector("[data-cycle-length]"); const status = node.querySelector("[data-cycle-status]");
  const draw = () => { const entries = readList(localStorage, "hardin-cycles").sort((a, b) => b.start.localeCompare(a.start)); const list = node.querySelector("[data-cycle-list]"); list.replaceChildren(); if (!entries.length) list.appendChild(el("li", "empty-state", "No cycles recorded yet.")); entries.forEach((entry) => { const item = el("li", "feature-item"); item.append(el("span", "feature-item-text", new Date(`${entry.start}T12:00:00`).toLocaleDateString([], { dateStyle: "medium" })), el("small", "feature-item-meta", `${entry.end ? `Ended ${entry.end}` : "End date not recorded"} · ${entry.length || "No length"} days`)); const remove = el("button", "btn danger small", "Delete"); remove.type = "button"; remove.addEventListener("click", () => { writeList(localStorage, "hardin-cycles", entries.filter((saved) => saved.id !== entry.id)); draw(); }); item.appendChild(remove); list.appendChild(item); }); const latest = entries[0]; const next = node.querySelector("[data-cycle-next]"); if (!latest || !(latest.length || entries[1])) next.textContent = "Not enough history yet"; else { const days = Number(latest.length) || Math.round((new Date(`${latest.start}T12:00:00`) - new Date(`${entries[1].start}T12:00:00`)) / 86400000); const date = new Date(`${latest.start}T12:00:00`); date.setDate(date.getDate() + days); next.textContent = date.toLocaleDateString([], { dateStyle: "long" }); } };
  form.addEventListener("submit", (event) => { event.preventDefault(); writeList(localStorage, "hardin-cycles", [...readList(localStorage, "hardin-cycles"), { id: Date.now().toString(), start: start.value, end: end.value, length: Number(length.value) || null }]); form.reset(); status.textContent = "Cycle saved privately on this device."; draw(); }); draw(); return { node, title: "Cycle" };
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

document.addEventListener("click", (event) => {
  const menu = document.querySelector(".feature-menu");
  if (menu && (!menu.contains(event.target) || event.target.closest(".menu-panel a"))) {
    menu.removeAttribute("open");
  }
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

function pageFocus() {
  const node = cloneTemplate("tpl-focus");
  const modeLabel = node.querySelector("[data-focus-mode]");
  const clock = node.querySelector("[data-focus-clock]");
  const message = node.querySelector("[data-focus-message]");
  const start = node.querySelector("[data-focus-start]");
  const progress = node.querySelector("[data-focus-progress]");
  const workInput = node.querySelector("[data-focus-work]");
  const restInput = node.querySelector("[data-focus-rest]");
  workInput.value = getPref("hardin-focus-work", "25");
  restInput.value = getPref("hardin-focus-rest", "5");
  let mode = "work";
  let seconds = Number(workInput.value) * 60;
  let running = false;
  let interval = null;

  const duration = () => Number(mode === "work" ? workInput.value : restInput.value) * 60;
  const paint = () => {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const remaining = (seconds % 60).toString().padStart(2, "0");
    clock.textContent = `${minutes}:${remaining}`;
    modeLabel.textContent = mode === "work" ? "Focus time" : "Rest time";
    progress.style.width = `${Math.max(0, Math.min(100, ((duration() - seconds) / duration()) * 100))}%`;
    start.textContent = running ? "Pause" : "Start";
  };
  const switchMode = () => {
    mode = mode === "work" ? "rest" : "work";
    seconds = duration();
    message.textContent = mode === "work" ? "Rest finished. Ready for another gentle round?" : "Focus round complete. Take a real pause.";
    paint();
  };
  const stop = () => { if (interval) window.clearInterval(interval); interval = null; running = false; paint(); };
  const tick = () => { if (seconds <= 0) { switchMode(); return; } seconds -= 1; paint(); };
  start.addEventListener("click", () => {
    running = !running;
    if (running) interval = window.setInterval(tick, 1000);
    else if (interval) { window.clearInterval(interval); interval = null; }
    paint();
  });
  node.querySelector("[data-focus-reset]").addEventListener("click", () => { stop(); mode = "work"; seconds = duration(); message.textContent = "Ready when you are."; paint(); });
  [workInput, restInput].forEach((input) => input.addEventListener("change", () => { const value = Math.max(1, Number(input.value) || 1); input.value = value; setPref(input === workInput ? "hardin-focus-work" : "hardin-focus-rest", String(value)); if (!running) { seconds = duration(); paint(); } }));
  paint();
  return { node, title: "Focus timer" };
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
  const prayerMonth = node.querySelector("[data-prayer-month]");
  const prayerText = node.querySelector("[data-prayer-text]");
  const prayerStatus = node.querySelector("[data-prayer-status]");
  prayerMonth.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const loadPrayer = () => { prayerText.value = getPref(`hardin-prayer-${prayerMonth.value}`, ""); };
  prayerMonth.addEventListener("change", loadPrayer);
  node.querySelector("[data-save-prayer]").addEventListener("click", () => { setPref(`hardin-prayer-${prayerMonth.value}`, prayerText.value); prayerStatus.textContent = "Saved for this month."; });

  const bibleDate = node.querySelector("[data-bible-date]");
  const bibleReference = node.querySelector("[data-bible-reference]");
  const bibleTitle = node.querySelector("[data-bible-title]");
  const bibleNotes = node.querySelector("[data-bible-notes]");
  const bibleList = node.querySelector("[data-bible-list]");
  bibleDate.value = todayKey;
  const drawBible = () => {
    const readings = readList(localStorage, "hardin-bible-tracker").sort((a, b) => b.date.localeCompare(a.date));
    node.querySelector("[data-bible-count]").textContent = `${readings.length} ${readings.length === 1 ? "reading" : "readings"}`;
    bibleList.replaceChildren();
    if (!readings.length) bibleList.appendChild(el("li", "empty-state", "No readings tracked yet."));
    readings.forEach((readingEntry) => {
      const item = el("li", `feature-item${readingEntry.done ? " is-done" : ""}`);
      const check = el("input"); check.type = "checkbox"; check.checked = Boolean(readingEntry.done); check.setAttribute("aria-label", `Mark ${readingEntry.reference} complete`);
      check.addEventListener("change", () => { writeList(localStorage, "hardin-bible-tracker", readList(localStorage, "hardin-bible-tracker").map((entry) => entry.id === readingEntry.id ? { ...entry, done: check.checked } : entry)); drawBible(); });
      const text = el("span", "feature-item-text", readingEntry.reference); text.appendChild(el("small", "feature-item-meta", `${readingEntry.date}${readingEntry.title ? ` · ${readingEntry.title}` : ""}${readingEntry.notes ? ` · ${readingEntry.notes}` : ""}`));
      const remove = el("button", "btn danger small", "Delete"); remove.type = "button"; remove.addEventListener("click", () => { writeList(localStorage, "hardin-bible-tracker", readList(localStorage, "hardin-bible-tracker").filter((entry) => entry.id !== readingEntry.id)); drawBible(); });
      item.append(check, text, remove); bibleList.appendChild(item);
    });
  };
  node.querySelector("[data-bible-form]").addEventListener("submit", (event) => { event.preventDefault(); writeList(localStorage, "hardin-bible-tracker", [...readList(localStorage, "hardin-bible-tracker"), { id: Date.now().toString(), date: bibleDate.value, reference: bibleReference.value.trim(), title: bibleTitle.value.trim(), notes: bibleNotes.value.trim(), done: true }]); event.target.reset(); bibleDate.value = todayKey; drawBible(); });
  loadPrayer();
  drawBible();
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
