// =========================================================
// Hardin: admin page
//   Posts     write, edit, draft/publish, feature, search
//   Folders   make main types and nested sub-folders
//   Calendar  add notes and markers to any date
//   //   Settings  tagline, About text, backup
// The admin area only appears after login, and Firestore rules
// make sure only YOUR account can save anything.
// =========================================================

import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  el,
  icon,
  MOODS,
  COLOR_NAMES,
  buildFolderTree,
  formatDate,
  formatDayKey,
  isDayKey,
  postDateMs,
  wordCount,
  readMinutes,
  enableButtonEffects
} from "./shared.js";

const $ = (id) => document.getElementById(id);

// ---------- State ----------
let folders = [];
let tree = buildFolderTree([]);
let posts = [];
let events = [];
let editingId = null;                                   // post being edited (null = new post)
let editingEventId = null;                              // event being edited (null = new event)
const listFilters = { search: "", status: "all" };

// Shows a message under a form. (isError makes it red)
function say(id, text, isError) {
  const box = $(id);
  box.textContent = text;
  box.className = "form-message " + (isError ? "error" : "success");
}

function actionButton(text, kind, onClick) {
  const btn = el("button", `btn ${kind} small`, text);
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

// =========================================================
// 1. Login / logout
// =========================================================

// Runs on page load and every time you log in or out
onAuthStateChanged(auth, (user) => {
  const loggedIn = Boolean(user);
  $("login-section").hidden = loggedIn;
  $("admin-app").hidden = !loggedIn;
  $("logout-btn").hidden = !loggedIn;

  if (loggedIn) {
    // Tells the public page not to count YOUR visits and views on this browser
    try { localStorage.setItem("hardin-is-admin", "1"); } catch (e) { /* ignore */ }
    loadEverything();
  }
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("login-email").value.trim(), $("login-password").value);
    $("login-form").reset();
  } catch (error) {
    console.error(error);
    $("login-error").textContent = "Couldn't log in. Check your email and password.";
  }
});

$("logout-btn").addEventListener("click", () => signOut(auth));

// =========================================================
// 2. Tabs
// =========================================================

function showTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.hidden = panel.id !== `tab-${name}`;
  });
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
});

// =========================================================
// 3. Load data
// =========================================================

async function loadFolders() {
  const snap = await getDocs(collection(db, "folders"));
  folders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  tree = buildFolderTree(folders);
}

async function loadPosts() {
  const snap = await getDocs(collection(db, "posts"));
  posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "site"));
  if (snap.exists()) {
    const data = snap.data();
    $("set-tagline").value = data.tagline || "";
    $("set-about").value = data.about || "";
  }
}

// Posts made with the first version of Hardin have no status yet.
// This quietly gives them the new fields so they keep showing up.
async function upgradeOldPosts() {
  for (const post of posts.filter((p) => !p.status)) {
    const fix = {
      status: "published",
      views: post.views || 0,
      reactions: post.reactions || 0,
      pinned: false,
      subtitle: post.subtitle || "",
      mood: post.mood || "",
      folderId: post.folderId || "",
      publishedAt: post.createdAt || serverTimestamp()
    };
    await updateDoc(doc(db, "posts", post.id), fix);
    Object.assign(post, fix, { publishedAt: post.createdAt || null });
  }
}

async function loadEverything() {
  try {
    await Promise.all([loadFolders(), loadPosts(), loadEvents(), loadSettings()]);
    await upgradeOldPosts();
  } catch (error) {
    console.error(error);
    say("form-message", "Couldn't load everything. Check your Firestore rules and try again.", true);
  }
  renderAll();
}

function renderAll() {
  renderFolderSelects();
  renderFolderList();
  renderPostList();
  renderEventList();
}

// =========================================================
// 4. Folders
// =========================================================

const STARTER_FOLDERS = [
  { name: "Articles", icon: "📖", color: "sage" },
  { name: "Journal", icon: "📝", color: "petal" },
  { name: "Canva designs", icon: "🎨", color: "lichen" },
  { name: "Slides", icon: "📊", color: "seed" },
  { name: "Code projects", icon: "💻", color: "moss" }
];

// Fill the color dropdown once
Object.entries(COLOR_NAMES).forEach(([value, name]) => {
  $("folder-color").appendChild(new Option(name, value));
});

// Keep the folder dropdowns (post form + folder form) in step with Firestore
function renderFolderSelects() {
  const postSelect = $("post-folder");
  const keepPost = postSelect.value;
  postSelect.replaceChildren(new Option("Unsorted (no folder)", ""));
  tree.flat().forEach(({ folder }) => postSelect.appendChild(new Option(tree.label(folder.id), folder.id)));
  postSelect.value = keepPost;

  const parentSelect = $("folder-parent");
  const keepParent = parentSelect.value;
  parentSelect.replaceChildren(new Option("Top level (a new main type)", ""));
  tree.flat().forEach(({ folder }) => parentSelect.appendChild(new Option(tree.label(folder.id), folder.id)));
  parentSelect.value = keepParent;

  $("starter-folders").hidden = folders.length > 0;
}

$("folder-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = $("folder-name").value.trim();
  const parentId = $("folder-parent").value || null;
  if (!name) return;

  const duplicate = tree.children(parentId).some((f) => f.name.toLowerCase() === name.toLowerCase());
  if (duplicate) return say("folder-message", "There's already a folder with that name in that spot.", true);

  try {
    await addDoc(collection(db, "folders"), {
      name,
      parentId,
      icon: $("folder-icon").value.trim() || "🌿",
      color: $("folder-color").value,
      createdAt: serverTimestamp()
    });
    $("folder-name").value = "";
    say("folder-message", "Folder added.", false);
    await loadFolders();
    renderAll();
  } catch (error) {
    console.error(error);
    say("folder-message", "Couldn't add the folder. Make sure you're logged in.", true);
  }
});

$("starter-folders").addEventListener("click", async () => {
  try {
    await Promise.all(STARTER_FOLDERS.map((f) => addDoc(collection(db, "folders"), {
      ...f, parentId: null, createdAt: serverTimestamp()
    })));
    say("folder-message", "Starter folders added.", false);
    await loadFolders();
    renderAll();
  } catch (error) {
    console.error(error);
    say("folder-message", "Couldn't add the starter folders.", true);
  }
});

function renderFolderList() {
  const list = $("folder-list");
  list.replaceChildren();

  if (folders.length === 0) {
    list.appendChild(el("li", "empty", "No folders yet. Add one above, or use the starter folders."));
    return;
  }

  tree.flat().forEach(({ folder, depth }) => {
    const look = tree.look(folder.id);
    const item = el("li", "admin-item");

    const info = el("div", "admin-info");
    info.style.marginLeft = `${depth * 1.5}rem`;
    const title = el("div", "admin-title");
    title.appendChild(el("span", `badge color-${look.color}`, look.icon));
    title.appendChild(el("strong", "", folder.name));
    info.appendChild(title);

    const postCount = posts.filter((p) => p.folderId === folder.id).length;
    const subCount = tree.children(folder.id).length;
    const bits = [`${postCount} ${postCount === 1 ? "post" : "posts"}`];
    if (subCount > 0) bits.push(`${subCount} ${subCount === 1 ? "sub-folder" : "sub-folders"}`);
    info.appendChild(el("div", "meta muted", bits.join(", ")));

    const actions = el("div", "actions");
    actions.appendChild(actionButton("Rename", "ghost", () => renameFolder(folder)));
    if (!folder.parentId) actions.appendChild(actionButton("Change look", "ghost", () => restyleFolder(folder)));
    actions.appendChild(actionButton("Delete", "danger", () => deleteFolder(folder)));

    item.append(info, actions);
    list.appendChild(item);
  });
}

async function renameFolder(folder) {
  const name = (prompt("New name for this folder:", folder.name) || "").trim();
  if (!name || name === folder.name) return;
  try {
    await updateDoc(doc(db, "folders", folder.id), { name });
    say("folder-message", "Folder renamed.", false);
    await loadFolders();
    renderAll();
  } catch (error) {
    console.error(error);
    say("folder-message", "Couldn't rename the folder.", true);
  }
}

async function restyleFolder(folder) {
  const newIcon = prompt("Icon (paste an emoji):", folder.icon || "🌿");
  if (newIcon === null) return;
  const colorChoice = prompt(`Color (${Object.keys(COLOR_NAMES).join(", ")}):`, folder.color || "sage");
  if (colorChoice === null) return;

  const color = COLOR_NAMES[colorChoice.trim().toLowerCase()] ? colorChoice.trim().toLowerCase() : "sage";
  try {
    await updateDoc(doc(db, "folders", folder.id), { icon: newIcon.trim() || "🌿", color });
    say("folder-message", "Folder look updated.", false);
    await loadFolders();
    renderAll();
  } catch (error) {
    console.error(error);
    say("folder-message", "Couldn't update the folder.", true);
  }
}

async function deleteFolder(folder) {
  if (tree.children(folder.id).length > 0) {
    return say("folder-message", "This folder has folders inside it. Delete or move those first.", true);
  }
  const count = posts.filter((p) => p.folderId === folder.id).length;
  if (count > 0) {
    return say("folder-message", `This folder still has ${count} ${count === 1 ? "post" : "posts"}. Move them to another folder first.`, true);
  }
  if (!confirm(`Delete the folder "${folder.name}"?`)) return;

  try {
    await deleteDoc(doc(db, "folders", folder.id));
    say("folder-message", "Folder deleted.", false);
    await loadFolders();
    renderAll();
  } catch (error) {
    console.error(error);
    say("folder-message", "Couldn't delete the folder.", true);
  }
}

// =========================================================
// 5. Post editor
// =========================================================

// A plain link OR a whole <iframe ...> code goes in; just the link comes out.
// A normal Canva link also becomes an embeddable one.
function cleanEmbed(raw) {
  let url = raw.trim();
  if (!url) return "";
  const match = url.match(/src=["']([^"']+)["']/i);
  if (match) url = match[1];
  if (url.includes("canva.com/design/") && !url.includes("embed")) {
    url += url.includes("?") ? "&embed" : "?embed";
  }
  return url;
}

const isHttps = (url) => url.startsWith("https://");
const isHttpsOrLocalPath = (url) => isHttps(url) || !/^[a-z]+:/i.test(url);

function updateWordCount() {
  const words = wordCount($("post-body").value);
  $("word-count").textContent = words === 0
    ? "0 words"
    : `${words} ${words === 1 ? "word" : "words"} · ${readMinutes($("post-body").value)} min read`;
}
$("post-body").addEventListener("input", updateWordCount);

// ----- Formatting buttons above the body box -----
document.querySelectorAll(".fmt").forEach((btn) => {
  btn.addEventListener("click", () => applyFormat(btn.dataset.format));
});

function applyFormat(kind) {
  const box = $("post-body");
  const start = box.selectionStart;
  const end = box.selectionEnd;
  const selected = box.value.slice(start, end);
  const before = box.value.slice(0, start);
  let insert = "";

  if (kind === "bold") insert = `**${selected || "bold text"}**`;
  else if (kind === "italic") insert = `*${selected || "italic text"}*`;
  else if (kind === "link") insert = `[${selected || "link text"}](https://)`;
  else {
    // Headings, quotes and lists need to start on their own paragraph
    const lead = start === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    if (kind === "heading") insert = `${lead}## ${selected || "Heading"}\n\n`;
    if (kind === "quote") insert = `${lead}> ${selected || "Quote"}\n\n`;
    if (kind === "list") {
      insert = lead + (selected || "List item").split("\n").map((line) => `- ${line}`).join("\n") + "\n\n";
    }
  }

  box.setRangeText(insert, start, end, "end");
  box.focus();
  updateWordCount();
}

// ----- Save (new post or edited post) -----
$("post-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const embedUrl = cleanEmbed($("post-embed").value);
  const linkUrl = $("post-link").value.trim();
  const coverUrl = $("post-cover").value.trim();

  if (embedUrl && !isHttps(embedUrl)) return say("form-message", "The embed link must start with https://", true);
  if (linkUrl && !isHttps(linkUrl)) return say("form-message", "The project link must start with https://", true);
  if (coverUrl && !isHttpsOrLocalPath(coverUrl)) {
    return say("form-message", "The cover image link must start with https:// or be a file path like images/cover.png", true);
  }

  const status = $("post-status").value;
  const existing = editingId ? posts.find((p) => p.id === editingId) : null;

  const data = {
    title: $("post-title").value.trim(),
    subtitle: $("post-subtitle").value.trim(),
    folderId: $("post-folder").value,
    mood: $("post-mood").value,
    summary: $("post-summary").value.trim(),
    body: $("post-body").value.trim(),
    embedUrl,
    linkUrl,
    coverUrl,
    status,
    pinned: $("post-pinned").checked
  };

  try {
    if (existing) {
      const changes = { ...data, updatedAt: serverTimestamp() };
      if (status === "published" && !existing.publishedAt) changes.publishedAt = serverTimestamp();
      await updateDoc(doc(db, "posts", editingId), changes);
    } else {
      await addDoc(collection(db, "posts"), {
        ...data,
        views: 0,
        reactions: 0,
        createdAt: serverTimestamp(),
        publishedAt: status === "published" ? serverTimestamp() : null
      });
    }

    resetForm();
    await loadPosts();
    renderAll();
    say("form-message", status === "published" ? "Post saved. It's live on Hardin." : "Draft saved. Only you can see it.", false);
  } catch (error) {
    console.error(error);
    say("form-message", "Couldn't save the post. Make sure you're logged in and your Firestore rules use your account's UID.", true);
  }
});

function resetForm() {
  $("post-form").reset();
  editingId = null;
  $("editor-heading").textContent = "New post";
  $("cancel-edit").hidden = true;
  updateWordCount();
}

$("cancel-edit").addEventListener("click", () => {
  resetForm();
  say("form-message", "", false);
});

function startEditing(post) {
  editingId = post.id;
  $("post-title").value = post.title || "";
  $("post-subtitle").value = post.subtitle || "";
  $("post-folder").value = post.folderId || "";
  $("post-mood").value = post.mood || "";
  $("post-summary").value = post.summary || "";
  $("post-body").value = post.body || "";
  $("post-embed").value = post.embedUrl || "";
  $("post-link").value = post.linkUrl || "";
  $("post-cover").value = post.coverUrl || "";
  $("post-status").value = post.status || "published";
  $("post-pinned").checked = Boolean(post.pinned);

  $("editor-heading").textContent = "Edit post";
  $("cancel-edit").hidden = false;
  say("form-message", "", false);
  updateWordCount();
  showTab("posts");
  $("editor-heading").scrollIntoView({ behavior: "smooth" });
}

// =========================================================
// 6. Post list: live search and status filter
// =========================================================

$("admin-search").addEventListener("input", (event) => {
  listFilters.search = event.target.value;
  renderPostList();
});

$("admin-status-filter").addEventListener("change", (event) => {
  listFilters.status = event.target.value;
  renderPostList();
});

function filteredPosts() {
  const q = listFilters.search.trim().toLowerCase();

  return posts
    .filter((p) => listFilters.status === "all" || (p.status || "published") === listFilters.status)
    .filter((p) => {
      if (!q) return true;
      return [p.title, p.subtitle, p.summary, p.body]
        .join(" ").toLowerCase().includes(q);
    })
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || postDateMs(b) - postDateMs(a));
}

function stat(iconName, value, title) {
  const wrap = el("span", "stat");
  wrap.title = title;
  wrap.append(icon(iconName, 16), el("span", "", String(value || 0)));
  return wrap;
}

function renderPostList() {
  const list = $("admin-list");
  list.replaceChildren();
  const shown = filteredPosts();

  if (shown.length === 0) {
    list.appendChild(el("li", "empty", posts.length === 0
      ? "No posts yet. Your first one will show up here."
      : "No posts match those filters."));
    return;
  }

  shown.forEach((post) => {
    const status = post.status || "published";
    const look = tree.look(post.folderId);
    const folder = tree.byId[post.folderId];
    const item = el("li", "admin-item");

    const info = el("div", "admin-info");
    const title = el("div", "admin-title");
    title.appendChild(el("strong", "", post.title));
    if (post.pinned) title.appendChild(el("span", "pill featured", "Featured"));
    title.appendChild(el("span", `pill ${status}`, status === "draft" ? "Draft" : "Published"));
    info.appendChild(title);

    const meta = el("div", "meta");
    meta.appendChild(el("span", `badge color-${look.color}`, `${look.icon} ${folder ? folder.name : "Unsorted"}`));
    const date = formatDate(post.publishedAt || post.createdAt, true);
    if (date) meta.appendChild(el("span", "muted", date));
    if (MOODS[post.mood]) meta.appendChild(el("span", "mood", `${MOODS[post.mood].emoji} ${MOODS[post.mood].label}`));
    meta.appendChild(stat("eye", post.views, "Views"));
    meta.appendChild(stat("seedling", post.reactions, "Seedlings"));
    info.appendChild(meta);

    const actions = el("div", "actions");
    actions.appendChild(actionButton("Edit", "ghost", () => startEditing(post)));
    actions.appendChild(actionButton(post.pinned ? "Unfeature" : "Feature", "ghost", () => togglePin(post)));
    actions.appendChild(actionButton(status === "draft" ? "Publish" : "Make draft", "ghost", () => toggleStatus(post)));
    actions.appendChild(actionButton("Delete", "danger", () => deletePost(post)));

    item.append(info, actions);
    list.appendChild(item);
  });
}

async function refreshPosts() {
  await loadPosts();
  renderAll();
}

async function togglePin(post) {
  try {
    await updateDoc(doc(db, "posts", post.id), { pinned: !post.pinned });
    say("list-message", post.pinned ? "Post is no longer featured." : "Post is now featured.", false);
    await refreshPosts();
  } catch (error) {
    console.error(error);
    say("list-message", "Couldn't update the post.", true);
  }
}

async function toggleStatus(post) {
  const publishing = (post.status || "published") === "draft";
  const changes = { status: publishing ? "published" : "draft", updatedAt: serverTimestamp() };
  if (publishing && !post.publishedAt) changes.publishedAt = serverTimestamp();
  try {
    await updateDoc(doc(db, "posts", post.id), changes);
    say("list-message", publishing ? "Post published." : "Post moved back to drafts.", false);
    await refreshPosts();
  } catch (error) {
    console.error(error);
    say("list-message", "Couldn't update the post.", true);
  }
}

async function deletePost(post) {
  if (!confirm(`Delete "${post.title}"? This can't be undone.`)) return;
  try {
    await deleteDoc(doc(db, "posts", post.id));
    if (editingId === post.id) resetForm();
    say("list-message", "Post deleted.", false);
    await refreshPosts();
  } catch (error) {
    console.error(error);
    say("list-message", "Couldn't delete the post.", true);
  }
}

// =========================================================
// 7. Calendar events
// =========================================================

$("event-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const date = $("event-date").value;
  if (!isDayKey(date)) return say("event-message", "Pick a date for this event.", true);

  const data = {
    date,
    marker: $("event-marker").value.trim() || "📌",
    title: $("event-title").value.trim(),
    note: $("event-note").value.trim()
  };

  try {
    if (editingEventId) {
      await updateDoc(doc(db, "events", editingEventId), { ...data, updatedAt: serverTimestamp() });
    } else {
      await addDoc(collection(db, "events"), { ...data, createdAt: serverTimestamp() });
    }
    resetEventForm();
    say("event-message", "Event saved. It's on the calendar.", false);
    await loadEvents();
    renderEventList();
  } catch (error) {
    console.error(error);
    say("event-message", "Couldn't save the event. Publish the new firestore.rules and make sure you're logged in.", true);
  }
});

function resetEventForm() {
  $("event-form").reset();
  $("event-marker").value = "📌";
  editingEventId = null;
  $("event-heading").textContent = "Calendar events";
  $("event-cancel").hidden = true;
}

$("event-cancel").addEventListener("click", () => {
  resetEventForm();
  say("event-message", "", false);
});

function startEditingEvent(event) {
  editingEventId = event.id;
  $("event-date").value = event.date || "";
  $("event-marker").value = event.marker || "📌";
  $("event-title").value = event.title || "";
  $("event-note").value = event.note || "";
  $("event-heading").textContent = "Edit event";
  $("event-cancel").hidden = false;
  say("event-message", "", false);
  $("event-heading").scrollIntoView({ behavior: "smooth" });
}

function renderEventList() {
  const list = $("event-list");
  list.replaceChildren();

  if (events.length === 0) {
    list.appendChild(el("li", "empty", "No events yet. Add one above and it will appear on the calendar."));
    return;
  }

  [...events]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .forEach((event) => {
      const item = el("li", "admin-item");

      const info = el("div", "admin-info");
      const title = el("div", "admin-title");
      title.appendChild(el("span", "", event.marker || "📌"));
      title.appendChild(el("strong", "", event.title));
      info.appendChild(title);

      const meta = el("div", "meta muted");
      meta.appendChild(el("span", "", isDayKey(event.date) ? formatDayKey(event.date, true) : "No date"));
      if (event.note) meta.appendChild(el("span", "", event.note.length > 80 ? `${event.note.slice(0, 80)}…` : event.note));
      info.appendChild(meta);

      const actions = el("div", "actions");
      actions.appendChild(actionButton("Edit", "ghost", () => startEditingEvent(event)));
      actions.appendChild(actionButton("Delete", "danger", () => deleteEvent(event)));

      item.append(info, actions);
      list.appendChild(item);
    });
}

async function deleteEvent(event) {
  if (!confirm(`Delete the event "${event.title}"?`)) return;
  try {
    await deleteDoc(doc(db, "events", event.id));
    if (editingEventId === event.id) resetEventForm();
    say("event-message", "Event deleted.", false);
    await loadEvents();
    renderEventList();
  } catch (error) {
    console.error(error);
    say("event-message", "Couldn't delete the event.", true);
  }
}

// =========================================================
// 8. Settings + backup
// =========================================================

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await setDoc(doc(db, "settings", "site"), {
      tagline: $("set-tagline").value.trim(),
      about: $("set-about").value.trim(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    say("settings-message", "Settings saved.", false);
  } catch (error) {
    console.error(error);
    say("settings-message", "Couldn't save the settings.", true);
  }
});

// Downloads folders, posts and calendar events
$("backup-btn").addEventListener("click", () => {
  const backup = { exportedAt: new Date().toISOString(), folders, posts, events };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `hardin-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
});

// =========================================================
// Start
// =========================================================

$("admin-search-icon").appendChild(icon("search"));
enableButtonEffects();
updateWordCount();
