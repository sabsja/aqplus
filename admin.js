// =========================================================
// Admin page
//   Overview  quick numbers: posts, views, seedlings, visits
//   Posts     write, edit, draft/publish, feature, search
//   Folders   make main types and nested sub-folders
//   Calendar  add notes and markers to any date
//   Settings  tagline, About text, announcement, default view, backup
// The admin area only appears after login, and Firestore rules
// make sure only YOUR account can save anything.
// =========================================================

import { auth, db } from "./firebase-config.js";
import { SITE_NAME } from "./hardin-config.js";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
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
  dateKey,
  enableButtonEffects
} from "./shared.js";

// Tells the little script in admin.html that this file loaded fine
window.__adminReady = true;

const $ = (id) => document.getElementById(id);

// ---------- State ----------
let folders = [];
let tree = buildFolderTree([]);
let posts = [];
let events = [];
let siteVisits = 0;
let editingId = null;                                   // post being edited (null = new post)
let editingEventId = null;                              // event being edited (null = new event)
const listFilters = { search: "", status: "all" };

// Shows a message under a form. (isError makes it red)
function say(id, text, isError) {
  const box = $(id);
  box.textContent = text;
  box.className = "form-message " + (isError ? "error" : "success");
}

// If Firestore refuses a save, the usual reason is that the UID written in
// firestore.rules isn't this account's UID (for example after making a new account).
function saveProblem(error, fallback) {
  if (error && error.code === "permission-denied") {
    return "Firestore refused this. The UID in firestore.rules doesn't match your account. Open the Overview tab, copy your UID, paste it into firestore.rules, and publish the rules.";
  }
  return fallback;
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
    $("account-email").textContent = `Signed in as ${user.email || "(no email)"}`;
    $("account-uid").textContent = user.uid;
    loadEverything();
  }
});

// What Firebase's error codes actually mean, in plain words
function explainAuthError(error) {
  const code = (error && error.code) || "unknown";
  const project = auth.app.options.projectId;

  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-login-credentials"].includes(code)) {
    return {
      message: "Firebase says that email and password don't match an account.",
      help: [
        `This page is connected to the Firebase project "${project}". The account has to exist in that same project (Firebase console, then Authentication, then Users).`,
        "Tick \"Show password\" and check for typos, extra spaces or Caps Lock.",
        "Use \"Forgot password?\" below to get a fresh reset link, and open it from the same email address."
      ]
    };
  }
  if (code === "auth/invalid-email") return { message: "That doesn't look like a valid email address.", help: [] };
  if (code === "auth/user-disabled") return { message: "This account is disabled.", help: ["In Firebase, open Authentication, then Users, and enable it again."] };
  if (code === "auth/too-many-requests") {
    return {
      message: "Firebase has paused logins from this device after too many tries.",
      help: ["Wait about 15 minutes and try again, or use \"Forgot password?\". Trying again sooner keeps the pause going."]
    };
  }
  if (code === "auth/network-request-failed") {
    return { message: "Couldn't reach Firebase.", help: ["Check your internet connection, and make sure this page isn't opened as a file from your computer."] };
  }
  if (code === "auth/operation-not-allowed") {
    return { message: "Email and password login is switched off in your Firebase project.", help: ["In Firebase: Authentication, then Sign-in method, then turn on Email/Password."] };
  }
  if (code === "auth/configuration-not-found") {
    return { message: "Authentication isn't set up in this Firebase project yet.", help: ["In Firebase, open Authentication and click Get started."] };
  }
  if (code.includes("api-key")) {
    return { message: "The API key in firebase-config.js isn't accepted.", help: ["Copy the config again from Firebase: Project settings, then Your apps, and paste it into firebase-config.js."] };
  }
  if (code.startsWith("auth/requests-from") || code === "auth/unauthorized-domain") {
    return {
      message: "Firebase is blocking requests from this website address.",
      help: ["In Firebase, open Authentication, then Settings, then Authorized domains, and add your website's domain (for example yourname.github.io).",
             "If you restricted the API key in Google Cloud, allow this website address there too."]
    };
  }
  return { message: "Couldn't log in.", help: ["Press F12 and look at the Console tab for the red error, and check the code shown below."] };
}

function showLoginProblem(error) {
  const info = explainAuthError(error);
  $("login-error").textContent = info.message;

  const help = $("login-help");
  help.replaceChildren(...info.help.map((line) => el("li", "", line)));
  help.hidden = info.help.length === 0;

  const code = $("login-code");
  code.textContent = `Error code: ${(error && error.code) || "none"}`;
  code.hidden = false;
}

function clearLoginProblem() {
  $("login-error").textContent = "";
  $("login-help").hidden = true;
  $("login-code").hidden = true;
}

// Shows which Firebase project this page is talking to (a common mix-up is
// creating the account in one project while firebase-config.js points at another)
const projectId = auth.app.options.projectId || "";
$("login-project").textContent = projectId.includes("PASTE")
  ? "firebase-config.js still has placeholder keys. Paste in your real Firebase config."
  : `Connected to Firebase project: ${projectId}`;

$("show-password").addEventListener("change", (event) => {
  $("login-password").type = event.target.checked ? "text" : "password";
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearLoginProblem();
  $("login-btn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("login-email").value.trim().toLowerCase(), $("login-password").value);
    $("login-form").reset();
    $("login-password").type = "password";
  } catch (error) {
    console.error(error);
    showLoginProblem(error);
  } finally {
    $("login-btn").disabled = false;
  }
});

// Sends a password reset link to the email typed above
$("reset-btn").addEventListener("click", async () => {
  clearLoginProblem();
  const email = $("login-email").value.trim().toLowerCase();
  if (!email) {
    $("login-error").textContent = "Type your email above first, then press Forgot password.";
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    $("login-error").className = "form-message success";
    $("login-error").textContent = "If that email has an account in this project, a reset link is on its way. Check your spam folder too.";
  } catch (error) {
    console.error(error);
    $("login-error").className = "form-message error";
    showLoginProblem(error);
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

// If events fail to load, the most likely reason is that the
// Firestore rules haven't been published yet.
async function loadEvents() {
  try {
    const snap = await getDocs(collection(db, "events"));
    events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (error) {
    console.error(error);
    events = [];
    say("event-message", "Couldn't load events. Publish the new firestore.rules, then reload.", true);
  }
}

async function loadVisits() {
  try {
    const snap = await getDoc(doc(db, "siteStats", "counter"));
    siteVisits = snap.exists() ? snap.data().visits || 0 : 0;
  } catch (error) {
    console.error(error);
    siteVisits = 0;
  }
}

async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "site"));
  if (snap.exists()) {
    const data = snap.data();
    $("set-tagline").value = data.tagline || "";
    $("set-about").value = data.about || "";
    $("set-announcement").value = data.announcement || "";
    $("set-announcement-link").value = data.announcementLink || "";
    $("set-folder-view").value = data.folderView === "tree" ? "accordion" : data.folderView || "tiles";
  }
}

// Posts made with the very first version have no status yet.
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
    await Promise.all([loadFolders(), loadPosts(), loadEvents(), loadVisits(), loadSettings()]);
    await upgradeOldPosts();
  } catch (error) {
    console.error(error);
    const text = saveProblem(error, "Couldn't load everything. Check your Firestore rules and try again.");
    $("admin-alert").textContent = text;
    $("admin-alert").hidden = false;
  }
  renderAll();
}

function renderAll() {
  renderFolderSelects();
  renderFolderList();
  renderPostList();
  renderEventList();
  renderOverview();
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
    say("folder-message", saveProblem(error, "Couldn't add the folder. Make sure you're logged in."), true);
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

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function markdownToHtml(text) {
  return text.split(/\n{2,}/).filter((block) => block.trim()).map((raw) => {
    const lines = raw.trim().split("\n");
    const inline = (value) => escapeHtml(value)
      .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
    if (raw.startsWith("## ")) return `<h3>${inline(raw.slice(3))}</h3>`;
    if (raw.startsWith("> ")) return `<blockquote>${inline(lines.map((line) => line.replace(/^>\s?/, "")).join(" "))}</blockquote>`;
    if (lines.every((line) => line.startsWith("- "))) return `<ul>${lines.map((line) => `<li>${inline(line.slice(2))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

function nodeToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const content = [...node.childNodes].map(nodeToMarkdown).join("");
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "STRONG" || node.tagName === "B") return `**${content}**`;
  if (node.tagName === "EM" || node.tagName === "I") return `*${content}*`;
  if (node.tagName === "A") return `[${content}](${node.href})`;
  if (node.tagName === "H3") return `## ${content}\n\n`;
  if (node.tagName === "BLOCKQUOTE") return `> ${content}\n\n`;
  if (node.tagName === "LI") return `- ${content}\n`;
  if (node.tagName === "UL") return `${content}\n`;
  if (node.tagName === "P" || node.tagName === "DIV") return `${content}\n\n`;
  return content;
}

function syncBodyMarkdown() {
  $("post-body").value = [...$("post-body-editor").childNodes].map(nodeToMarkdown).join("").trim();
  updateWordCount();
}

$("post-body-editor").addEventListener("input", syncBodyMarkdown);

// ----- Formatting buttons above the body box -----
document.querySelectorAll(".fmt").forEach((btn) => {
  btn.addEventListener("click", () => applyFormat(btn.dataset.format));
});

function applyFormat(kind) {
  const editor = $("post-body-editor");
  editor.focus();
  if (kind === "heading") document.execCommand("formatBlock", false, "h3");
  else if (kind === "quote") document.execCommand("formatBlock", false, "blockquote");
  else if (kind === "link") {
    const url = window.prompt("Paste the https:// link");
    if (url && url.startsWith("https://")) document.execCommand("createLink", false, url);
  } else if (kind === "list") document.execCommand("insertUnorderedList", false);
  else document.execCommand(kind, false);
  syncBodyMarkdown();
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
    say("form-message", status === "published" ? `Post saved. It's live on ${SITE_NAME}.` : "Draft saved. Only you can see it.", false);
  } catch (error) {
    console.error(error);
    say("form-message", saveProblem(error, "Couldn't save the post. Make sure you're logged in."), true);
  }
});

function resetForm() {
  $("post-form").reset();
  $("post-body-editor").replaceChildren();
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
  $("post-body-editor").innerHTML = markdownToHtml(post.body || "");
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
// 7. Overview: the numbers at a glance
// =========================================================

function renderOverview() {
  const published = posts.filter((p) => (p.status || "published") === "published");
  const drafts = posts.length - published.length;
  const views = posts.reduce((sum, p) => sum + (p.views || 0), 0);
  const seedlings = posts.reduce((sum, p) => sum + (p.reactions || 0), 0);
  const today = dateKey(new Date());
  const upcoming = events.filter((e) => (e.date || "") >= today).length;

  const stats = [
    ["Published posts", published.length],
    ["Drafts", drafts],
    ["Post views", views],
    ["Seedlings", seedlings],
    ["Site visits", siteVisits],
    ["Upcoming events", upcoming]
  ];

  const box = $("overview-stats");
  box.replaceChildren();
  stats.forEach(([label, value]) => {
    const card = el("div", "stat-card");
    card.appendChild(el("strong", "", value.toLocaleString()));
    card.appendChild(el("span", "", label));
    box.appendChild(card);
  });

  fillTopList($("overview-viewed"), published, "views", "eye", "No views yet.");
  fillTopList($("overview-loved"), published, "reactions", "seedling", "No seedlings yet.");
}

// The top five posts by a number (views or seedlings)
function fillTopList(list, source, field, iconName, emptyText) {
  list.replaceChildren();
  const top = [...source].filter((p) => (p[field] || 0) > 0)
    .sort((a, b) => (b[field] || 0) - (a[field] || 0))
    .slice(0, 5);

  if (top.length === 0) {
    list.appendChild(el("li", "empty", emptyText));
    return;
  }
  top.forEach((post) => {
    const item = el("li", "top-item");
    item.appendChild(el("span", "top-title", post.title));
    item.appendChild(stat(iconName, post[field], field === "views" ? "Views" : "Seedlings"));
    list.appendChild(item);
  });
}

// =========================================================
// 8. Calendar events
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
    say("event-message", saveProblem(error, "Couldn't save the event. Publish the latest firestore.rules and make sure you're logged in."), true);
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
// 9. Settings + backup
// =========================================================

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const announcementLink = $("set-announcement-link").value.trim();
  if (announcementLink && !isHttps(announcementLink)) {
    return say("settings-message", "The message link must start with https://", true);
  }

  try {
    await setDoc(doc(db, "settings", "site"), {
      tagline: $("set-tagline").value.trim(),
      about: $("set-about").value.trim(),
      announcement: $("set-announcement").value.trim(),
      announcementLink,
      folderView: $("set-folder-view").value,
      updatedAt: serverTimestamp()
    }, { merge: true });
    say("settings-message", "Settings saved.", false);
  } catch (error) {
    console.error(error);
    say("settings-message", saveProblem(error, "Couldn't save the settings."), true);
  }
});

// Downloads your folders, posts and calendar events
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

$("copy-uid").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("account-uid").textContent);
    $("copy-uid").textContent = "Copied";
    setTimeout(() => { $("copy-uid").textContent = "Copy"; }, 1500);
  } catch (error) {
    console.error(error);
  }
});

$("admin-search-icon").appendChild(icon("search"));
enableButtonEffects();
updateWordCount();
