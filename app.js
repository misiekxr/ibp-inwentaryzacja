const { openDB } = idb;

const dbPromise = openDB("ibp-db", 1, {
  upgrade(db) {
    const markers = db.createObjectStore("markers", { keyPath: "id", autoIncrement: true });
    markers.createIndex("by-plan", "planKey");
    markers.createIndex("by-building", "buildingCode");
    db.createObjectStore("meta", { keyPath: "key" });
    const planImages = db.createObjectStore("planImages", { keyPath: "key" });
    planImages.createIndex("by-building", "buildingCode");
  },
});

async function dbAddMarker(marker) {
  const db = await dbPromise;
  const id = await db.add("markers", marker);
  return { ...marker, id };
}

async function dbUpdateMarker(id, changes) {
  const db = await dbPromise;
  const tx = db.transaction("markers", "readwrite");
  const existing = await tx.store.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...changes };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

async function dbDeleteMarker(id) {
  const db = await dbPromise;
  await db.delete("markers", id);
}

async function dbAddPhotoToMarker(id, blob, type) {
  const db = await dbPromise;
  const tx = db.transaction("markers", "readwrite");
  const existing = await tx.store.get(id);
  if (!existing) return null;
  const photos = [...(existing.photos || []), { blob, type, addedAt: new Date().toISOString() }];
  const updated = { ...existing, photos, updatedAt: new Date().toISOString() };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

async function dbRemovePhotoFromMarker(id, photoIndex) {
  const db = await dbPromise;
  const tx = db.transaction("markers", "readwrite");
  const existing = await tx.store.get(id);
  if (!existing) return null;
  const photos = (existing.photos || []).filter((_, i) => i !== photoIndex);
  const updated = { ...existing, photos, updatedAt: new Date().toISOString() };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

async function dbGetMarker(id) {
  const db = await dbPromise;
  return db.get("markers", id);
}

async function dbGetMarkersByPlan(planKey) {
  const db = await dbPromise;
  return db.getAllFromIndex("markers", "by-plan", planKey);
}

async function dbGetMarkersByBuilding(buildingCode) {
  const db = await dbPromise;
  return db.getAllFromIndex("markers", "by-building", buildingCode);
}

async function dbGetAllMarkers() {
  const db = await dbPromise;
  return db.getAll("markers");
}

async function dbGetMeta(key) {
  const db = await dbPromise;
  const row = await db.get("meta", key);
  return row ? row.value : null;
}

async function dbSetMeta(key, value) {
  const db = await dbPromise;
  await db.put("meta", { key, value });
}

async function dbPutPlanImage(record) {
  const db = await dbPromise;
  await db.put("planImages", record);
}

async function dbGetPlanImage(buildingCode, file) {
  const db = await dbPromise;
  return db.get("planImages", planKeyOf(buildingCode, file));
}

async function dbGetAllPlanImages() {
  const db = await dbPromise;
  return db.getAll("planImages");
}

// --- DOM ---
const buildingSelect = document.getElementById("building-select");
const planSelect = document.getElementById("plan-select");
const inventoryPlanFilter = document.getElementById("inventory-plan-filter");
const inventoryStatusFilter = document.getElementById("inventory-status-filter");
const inventoryCategoryFilter = document.getElementById("inventory-category-filter");
const exportCsvLink = document.getElementById("export-csv-link");
const fullReportBtn = document.getElementById("full-report-btn");
const reportBtn = document.getElementById("report-btn");
const backupBanner = document.getElementById("backup-banner");

const markerPanel = document.getElementById("marker-panel");
const markerPanelTitle = document.getElementById("marker-panel-title");
const markerDone = document.getElementById("marker-done");
const markerCategory = document.getElementById("marker-category");
const markerCategoryCustom = document.getElementById("marker-category-custom");
const markerNote = document.getElementById("marker-note");
const markerPhotoCamera = document.getElementById("marker-photo-camera");
const markerPhotoGalleryInput = document.getElementById("marker-photo-gallery-input");
const markerPhotoGallery = document.getElementById("marker-photo-gallery");
const saveStatus = document.getElementById("save-status");
const markerDeleteBtn = document.getElementById("marker-delete");
const markerCloseBtn = document.getElementById("marker-close");

const exportBackupBtn = document.getElementById("export-backup-btn");
const importBackupInput = document.getElementById("import-backup-input");
const lastExportInfo = document.getElementById("last-export-info");

const importPlansInput = document.getElementById("import-plans-input");
const buildingsLoadedInfo = document.getElementById("buildings-loaded-info");
const emptyState = document.getElementById("empty-state");

let buildingsData = [];
let map = null;
let imageOverlay = null;
let leafletMarkers = {}; // id -> L.marker
let currentBuildingCode = null;
let currentPlanKey = null;
let currentPlanFile = null;
let currentPlanName = null;
let editingMarkerId = null;
let noteDebounceTimer = null;
let currentPlanObjectUrl = null;

function planKeyOf(buildingCode, file) {
  return `${buildingCode}::${file}`;
}

const DEFAULT_CATEGORIES = [
  "Czujki a zwierzęta pozostawione na noc",
  "Propozycja lokalizacji punktów odbicia się dla ochroniarza",
  "Aktualizacja planów IBP",
];

// Lista kategorii = kategorie domyslne + wszystkie juz uzyte w bazie (np. wpisane
// recznie przez "+ Nowa kategoria") - dzieki temu raz wpisana kategoria pojawia sie
// pozniej sama w liscie, bez potrzeby wpisywania jej ponownie za kazdym razem.
async function knownCategories() {
  const markers = await dbGetAllMarkers();
  const set = new Set(DEFAULT_CATEGORIES);
  for (const m of markers) if (m.category) set.add(m.category);
  return Array.from(set).sort((a, b) => a.localeCompare(b, "pl"));
}

async function populateCategorySelect(selected) {
  const cats = await knownCategories();
  markerCategory.innerHTML = "";
  const optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = "(brak)";
  markerCategory.appendChild(optNone);
  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    markerCategory.appendChild(opt);
  }
  const optCustom = document.createElement("option");
  optCustom.value = "__custom__";
  optCustom.textContent = "+ Nowa kategoria…";
  markerCategory.appendChild(optCustom);

  if (selected && cats.includes(selected)) {
    markerCategory.value = selected;
    markerCategoryCustom.classList.add("hidden");
  } else {
    markerCategory.value = "";
    markerCategoryCustom.classList.add("hidden");
  }
}

function makeIcon(hasPhoto, done) {
  const badge = hasPhoto
    ? `<div style="position:absolute;top:-4px;right:-4px;font-size:9px;line-height:1;">📷</div>`
    : "";
  const color = done ? "#16a34a" : "#782834";
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:16px;height:16px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,0.5);">${badge}</div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

async function buildingsFromDb() {
  const rows = await dbGetAllPlanImages();
  const byCode = {};
  for (const r of rows) {
    if (!byCode[r.buildingCode]) {
      byCode[r.buildingCode] = { code: r.buildingCode, name: r.buildingName || r.buildingCode, plans: [] };
    }
    byCode[r.buildingCode].plans.push({ file: r.file, name: r.name, sortOrder: r.sortOrder });
  }
  const list = Object.values(byCode);
  list.sort((a, b) => a.code.localeCompare(b.code));
  for (const b of list) b.plans.sort((a, b2) => a.sortOrder - b2.sortOrder);
  return list;
}

async function loadBuildings() {
  buildingsData = await buildingsFromDb();
  buildingSelect.innerHTML = "";
  for (const b of buildingsData) {
    const opt = document.createElement("option");
    opt.value = b.code;
    opt.textContent = b.name;
    buildingSelect.appendChild(opt);
  }

  buildingsLoadedInfo.textContent = buildingsData.length
    ? `Wczytane budynki: ${buildingsData.map((b) => b.code).join(", ")}`
    : "Wczytane budynki: brak";

  if (!buildingsData.length) {
    emptyState.classList.remove("hidden");
    reportBtn.classList.add("hidden");
    return;
  }
  emptyState.classList.add("hidden");
  reportBtn.classList.remove("hidden");

  // Wracamy do ostatnio uzywanego budynku/kondygnacji (jesli nadal istnieje wsrod
  // wczytanych planow), zeby nie trzeba bylo za kazdym razem wyszukiwac ich od nowa.
  let building = buildingsData[0];
  let preferredFile = null;
  const lastPlanKey = await dbGetMeta("lastPlanKey");
  if (lastPlanKey) {
    const sep = lastPlanKey.indexOf("::");
    const lastBuildingCode = lastPlanKey.slice(0, sep);
    const lastFile = lastPlanKey.slice(sep + 2);
    const match = buildingsData.find((b) => b.code === lastBuildingCode);
    if (match && match.plans.some((p) => p.file === lastFile)) {
      building = match;
      preferredFile = lastFile;
    }
  }
  buildingSelect.value = building.code;
  await loadPlans(building.code, preferredFile);
}

async function loadPlans(buildingCode, preferredFile) {
  currentBuildingCode = buildingCode;
  const building = buildingsData.find((b) => b.code === buildingCode);
  planSelect.innerHTML = "";
  inventoryPlanFilter.innerHTML = '<option value="">Wszystkie</option>';
  if (!building) return;
  for (const p of building.plans) {
    const opt = document.createElement("option");
    opt.value = p.file;
    opt.textContent = p.name;
    planSelect.appendChild(opt);

    const opt2 = document.createElement("option");
    opt2.value = planKeyOf(buildingCode, p.file);
    opt2.textContent = p.name;
    inventoryPlanFilter.appendChild(opt2);
  }
  exportCsvLink.onclick = (e) => {
    e.preventDefault();
    exportCsv(buildingCode);
  };
  if (building.plans.length) {
    const chosen = (preferredFile && building.plans.find((p) => p.file === preferredFile)) || building.plans[0];
    planSelect.value = chosen.file;
    await selectPlan(buildingCode, chosen.file, chosen.name);
  }
  await loadInventory();
}

function initMapIfNeeded() {
  if (map) return;
  map = L.map("map", { crs: L.CRS.Simple, minZoom: -5, zoomSnap: 0.25 });
  map.on("click", onMapClick);
}

function loadImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = url;
  });
}

async function selectPlan(buildingCode, file, name) {
  await closeMarkerPanel();
  currentPlanFile = file;
  currentPlanName = name;
  currentPlanKey = planKeyOf(buildingCode, file);
  await dbSetMeta("lastPlanKey", currentPlanKey);
  initMapIfNeeded();

  const rec = await dbGetPlanImage(buildingCode, file);
  if (!rec) return;
  if (currentPlanObjectUrl) URL.revokeObjectURL(currentPlanObjectUrl);
  currentPlanObjectUrl = URL.createObjectURL(rec.blob);
  const url = currentPlanObjectUrl;

  const { width, height } = await loadImageDimensions(url);
  const bounds = [[0, 0], [height, width]];

  if (imageOverlay) map.removeLayer(imageOverlay);
  for (const id in leafletMarkers) map.removeLayer(leafletMarkers[id]);
  leafletMarkers = {};

  imageOverlay = L.imageOverlay(url, bounds).addTo(map);
  map.fitBounds(bounds);

  const markers = await dbGetMarkersByPlan(currentPlanKey);
  for (const m of markers) addLeafletMarker(m);
}

function addLeafletMarker(m) {
  const marker = L.marker([m.y, m.x], {
    icon: makeIcon(!!(m.photos && m.photos.length), !!m.done),
    draggable: true,
  });
  marker.markerData = m;
  marker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    openMarkerPanel(m);
  });
  marker.on("dragend", async () => {
    const latlng = marker.getLatLng();
    const updated = await dbUpdateMarker(m.id, {
      x: latlng.lng,
      y: latlng.lat,
      updatedAt: new Date().toISOString(),
    });
    if (updated) marker.markerData = updated;
  });
  marker.addTo(map);
  leafletMarkers[m.id] = marker;
}

function refreshLeafletMarker(m) {
  const old = leafletMarkers[m.id];
  if (old) map.removeLayer(old);
  addLeafletMarker(m);
}

function setSaveStatus(text, saving) {
  saveStatus.textContent = text;
  saveStatus.classList.toggle("saving", !!saving);
}

function renderPhotoGallery(photos) {
  markerPhotoGallery.innerHTML = "";
  (photos || []).forEach((p, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "photo-thumb";

    const img = document.createElement("img");
    img.src = URL.createObjectURL(p.blob);
    img.alt = "zdjęcie punktu";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "photo-thumb-del";
    del.textContent = "×";
    del.title = "Usuń zdjęcie";
    del.addEventListener("click", async () => {
      const id = editingMarkerId;
      if (id == null) return;
      const updated = await dbRemovePhotoFromMarker(id, idx);
      if (updated && editingMarkerId === id) {
        renderPhotoGallery(updated.photos);
        refreshLeafletMarker(updated);
      }
    });

    wrap.appendChild(img);
    wrap.appendChild(del);
    markerPhotoGallery.appendChild(wrap);
  });
}

function resetPhotoInput() {
  markerPhotoCamera.value = "";
  markerPhotoGalleryInput.value = "";
  markerPhotoGallery.innerHTML = "";
}

async function onMapClick(e) {
  const now = new Date().toISOString();
  const marker = await dbAddMarker({
    buildingCode: currentBuildingCode,
    planKey: currentPlanKey,
    planFile: currentPlanFile,
    planName: currentPlanName,
    x: e.latlng.lng,
    y: e.latlng.lat,
    note: "",
    category: "",
    photos: [],
    done: false,
    createdAt: now,
    updatedAt: now,
  });
  addLeafletMarker(marker);
  openMarkerPanel(marker);
}

async function openMarkerPanel(m) {
  editingMarkerId = m.id;
  markerPanelTitle.textContent = `Punkt #${m.id}`;
  markerDone.checked = !!m.done;
  await populateCategorySelect(m.category || "");
  markerNote.value = m.note || "";
  markerPhotoCamera.value = "";
  markerPhotoGalleryInput.value = "";
  renderPhotoGallery(m.photos);
  setSaveStatus("Zapisano", false);
  markerPanel.classList.remove("hidden");
  markerNote.focus();
}

async function closeMarkerPanel() {
  if (editingMarkerId != null) {
    const m = await dbGetMarker(editingMarkerId);
    // porzadek: pusty punkt (bez notatki i zdjecia) usuwamy, zeby przypadkowe
    // tapniecie na mape nie zostawialo "widmowych" pinezek
    if (m && !(m.note || "").trim() && !(m.photos && m.photos.length)) {
      await dbDeleteMarker(editingMarkerId);
      const old = leafletMarkers[editingMarkerId];
      if (old) map.removeLayer(old);
      delete leafletMarkers[editingMarkerId];
    }
  }
  markerPanel.classList.add("hidden");
  editingMarkerId = null;
  await loadInventory();
}

markerDone.addEventListener("change", async () => {
  if (editingMarkerId == null) return;
  const id = editingMarkerId;
  const updated = await dbUpdateMarker(id, { done: markerDone.checked, updatedAt: new Date().toISOString() });
  if (updated && editingMarkerId === id) {
    refreshLeafletMarker(updated);
    await loadInventory();
  }
});

markerCategory.addEventListener("change", async () => {
  if (editingMarkerId == null) return;
  if (markerCategory.value === "__custom__") {
    markerCategoryCustom.classList.remove("hidden");
    markerCategoryCustom.value = "";
    markerCategoryCustom.focus();
    return;
  }
  const id = editingMarkerId;
  await dbUpdateMarker(id, { category: markerCategory.value, updatedAt: new Date().toISOString() });
});

async function saveCustomCategory() {
  if (editingMarkerId == null) return;
  const id = editingMarkerId;
  const value = markerCategoryCustom.value.trim();
  markerCategoryCustom.classList.add("hidden");
  if (!value) {
    markerCategory.value = "";
    return;
  }
  await dbUpdateMarker(id, { category: value, updatedAt: new Date().toISOString() });
  if (editingMarkerId === id) await populateCategorySelect(value);
}

markerCategoryCustom.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveCustomCategory();
  }
});
markerCategoryCustom.addEventListener("blur", saveCustomCategory);

markerNote.addEventListener("input", () => {
  if (editingMarkerId == null) return;
  setSaveStatus("Zapisywanie…", true);
  clearTimeout(noteDebounceTimer);
  noteDebounceTimer = setTimeout(async () => {
    const id = editingMarkerId;
    const value = markerNote.value;
    const updated = await dbUpdateMarker(id, { note: value, updatedAt: new Date().toISOString() });
    if (updated && editingMarkerId === id) {
      setSaveStatus("Zapisano", false);
      refreshLeafletMarker(updated);
    }
  }, 500);
});

// Zdjecia z aparatu telefonu potrafia miec po kilka-kilkanascie MB - zapisane
// wprost do IndexedDB szybko zapychaja pamiec urzadzenia i spowalniaja kazdy
// kolejny zapis punktu (caly rekord, ze wszystkimi zdjeciami, jest przy kazdej
// zmianie odczytywany i zapisywany na nowo). Zmniejszamy je przed zapisem.
function compressImage(file, maxDim = 1600, quality = 0.75) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file); // np. nietypowy format - zapisz oryginal zamiast blokowac zapis
    };
    img.src = url;
  });
}

async function handlePhotoFiles(input) {
  const files = Array.from(input.files || []);
  if (!files.length || editingMarkerId == null) return;
  setSaveStatus(files.length > 1 ? "Zapisywanie zdjęć…" : "Zapisywanie zdjęcia…", true);
  const id = editingMarkerId;
  let updated = null;
  try {
    for (const file of files) {
      const compressed = await compressImage(file);
      updated = await dbAddPhotoToMarker(id, compressed, compressed.type || "image/jpeg");
    }
    input.value = "";
    if (updated && editingMarkerId === id) {
      renderPhotoGallery(updated.photos);
      setSaveStatus("Zapisano", false);
      refreshLeafletMarker(updated);
    }
  } catch (err) {
    setSaveStatus("Błąd zapisu zdjęcia — spróbuj ponownie", false);
    alert("Nie udało się zapisać zdjęcia (brak miejsca na urządzeniu?): " + err.message);
  }
}

// Strona/PWA nie moze po cichu zapisac zdjecia wprost do galerii telefonu (ograniczenie
// bezpieczenstwa przegladarek, dotyczy kazdej appki webowej) - jedyna droga to systemowe
// okno "Udostepnij" z opcja "Zapisz obraz". Otwieramy je od razu po zrobieniu zdjecia,
// rownolegle z zapisem w appce (ktory nie czeka na decyzje uzytkownika w oknie udostepniania).
function sanitizeFilenamePart(s) {
  return String(s).trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_");
}

function extensionForMime(type) {
  if (/png/i.test(type)) return "png";
  if (/webp/i.test(type)) return "webp";
  return "jpg";
}

// Nazwa zdjecia zawiera budynek, kondygnacje (nazwe planu) i wspolrzedne punktu na
// planie - dzieki temu w galerii telefonu widac po samej nazwie pliku, czego zdjecie
// dotyczy, bez otwierania appki.
function buildPhotoFilename(type) {
  const marker = leafletMarkers[editingMarkerId] && leafletMarkers[editingMarkerId].markerData;
  const building = sanitizeFilenamePart(currentBuildingCode || "budynek");
  const plan = sanitizeFilenamePart(currentPlanName || "plan");
  const x = marker ? Math.round(marker.x) : "0";
  const y = marker ? Math.round(marker.y) : "0";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `IBP_${building}_${plan}_X${x}_Y${y}_${stamp}.${extensionForMime(type)}`;
}

async function maybeShareToGallery(file) {
  if (!navigator.canShare) return;
  const named = new File([file], buildPhotoFilename(file.type), { type: file.type });
  if (!navigator.canShare({ files: [named] })) return;
  try {
    await navigator.share({ files: [named] });
  } catch (err) {
    // uzytkownik anulowal udostepnianie - nic nie robimy
  }
}

markerPhotoCamera.addEventListener("change", () => {
  const file = markerPhotoCamera.files && markerPhotoCamera.files[0];
  if (file) maybeShareToGallery(file);
  handlePhotoFiles(markerPhotoCamera);
});
markerPhotoGalleryInput.addEventListener("change", () => handlePhotoFiles(markerPhotoGalleryInput));

markerDeleteBtn.addEventListener("click", async () => {
  if (editingMarkerId == null) return;
  const id = editingMarkerId;
  await dbDeleteMarker(id);
  const old = leafletMarkers[id];
  if (old) map.removeLayer(old);
  delete leafletMarkers[id];
  editingMarkerId = null; // zapobiega ponownemu "sprzataniu" w closeMarkerPanel
  markerPanel.classList.add("hidden");
  await loadInventory();
});

markerCloseBtn.addEventListener("click", closeMarkerPanel);

buildingSelect.addEventListener("change", () => loadPlans(buildingSelect.value));
planSelect.addEventListener("change", () => {
  const opt = planSelect.options[planSelect.selectedIndex];
  selectPlan(currentBuildingCode, opt.value, opt.textContent);
});

reportBtn.addEventListener("click", () => generatePlanReport(currentBuildingCode, currentPlanKey, currentPlanFile, currentPlanName));

// --- Tabs ---
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "map" && map) setTimeout(() => map.invalidateSize(), 50);
    if (btn.dataset.tab === "inventory") loadInventory();
    if (btn.dataset.tab === "backup") refreshBackupInfo();
  });
});

// --- Inventory tab ---
inventoryPlanFilter.addEventListener("change", loadInventory);
inventoryStatusFilter.addEventListener("change", loadInventory);
inventoryCategoryFilter.addEventListener("change", loadInventory);

async function refreshCategoryFilterOptions() {
  const cats = await knownCategories();
  const current = inventoryCategoryFilter.value;
  inventoryCategoryFilter.innerHTML = '<option value="">Wszystkie</option>';
  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    inventoryCategoryFilter.appendChild(opt);
  }
  if (cats.includes(current)) inventoryCategoryFilter.value = current;
}

async function loadInventory() {
  if (!currentBuildingCode) return;
  await refreshCategoryFilterOptions();
  const planKey = inventoryPlanFilter.value;
  const statusFilter = inventoryStatusFilter.value;
  const categoryFilter = inventoryCategoryFilter.value;
  let markers = planKey
    ? await dbGetMarkersByPlan(planKey)
    : await dbGetMarkersByBuilding(currentBuildingCode);
  if (statusFilter === "open") markers = markers.filter((m) => !m.done);
  if (statusFilter === "done") markers = markers.filter((m) => !!m.done);
  if (categoryFilter) markers = markers.filter((m) => m.category === categoryFilter);
  markers.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const tbody = document.querySelector("#inventory-table tbody");
  tbody.innerHTML = "";
  markers.forEach((m, idx) => {
    const tr = document.createElement("tr");
    const photoCell = (m.photos && m.photos.length)
      ? `<img class="thumb" src="${URL.createObjectURL(m.photos[0].blob)}" alt="zdjęcie">${m.photos.length > 1 ? ` +${m.photos.length - 1}` : ""}`
      : "";
    const statusCell = m.done
      ? `<span class="status-chip done">Załatwione</span>`
      : `<span class="status-chip open">Do zrobienia</span>`;
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${m.planName}</td>
      <td>${statusCell}</td>
      <td>${(m.category || "").replace(/</g, "&lt;")}</td>
      <td>${(m.note || "").replace(/</g, "&lt;")}</td>
      <td>${photoCell}</td>
      <td>${(m.createdAt || "").replace("T", " ").slice(0, 19)}</td>
      <td class="row-actions"><a data-id="${m.id}" data-plan="${m.planFile}">Pokaż na mapie</a></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("a[data-id]").forEach((a) => {
    a.addEventListener("click", async () => {
      document.querySelector('.tab-btn[data-tab="map"]').click();
      const m = await dbGetMarker(Number(a.dataset.id));
      if (!m) return;
      if (m.buildingCode !== currentBuildingCode || m.planFile !== currentPlanFile) {
        buildingSelect.value = m.buildingCode;
        await loadPlans(m.buildingCode);
        planSelect.value = m.planFile;
        await selectPlan(m.buildingCode, m.planFile, m.planName);
      }
      const marker = leafletMarkers[m.id];
      if (marker) {
        map.panTo(marker.getLatLng());
        openMarkerPanel(m);
      }
    });
  });
}

// --- CSV export ---
function csvEscape(v) {
  const s = String(v ?? "");
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportCsv(buildingCode) {
  const markers = await dbGetMarkersByBuilding(buildingCode);
  markers.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const header = ["Budynek", "Plan", "Status", "Kategoria", "Uwagi", "X", "Y", "Utworzono", "Zaktualizowano"];
  const lines = [header.map(csvEscape).join(";")];
  for (const m of markers) {
    const status = m.done ? "Załatwione" : "Do zrobienia";
    lines.push(
      [buildingCode, m.planName, status, m.category || "", m.note, m.x, m.y, m.createdAt, m.updatedAt]
        .map(csvEscape)
        .join(";")
    );
  }
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `inwentaryzacja-${buildingCode}.csv`);
}

// --- Backup: eksport/import JSON ---
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*);base64/)[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function refreshBackupInfo() {
  const last = await dbGetMeta("lastExportAt");
  if (last) {
    const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    lastExportInfo.textContent = `Ostatni eksport kopii: ${days === 0 ? "dzisiaj" : days + " dni temu"}`;
  } else {
    lastExportInfo.textContent = "Ostatni eksport kopii: nigdy";
  }
  if (!last || Date.now() - new Date(last).getTime() > 7 * 86400000) {
    backupBanner.textContent = "⚠ Dawno nie robiłeś kopii zapasowej danych — zrób ją w zakładce \"Kopia zapasowa\"";
    backupBanner.classList.remove("hidden");
  } else {
    backupBanner.classList.add("hidden");
  }
}

exportBackupBtn.addEventListener("click", async () => {
  const markers = await dbGetAllMarkers();
  const out = [];
  for (const m of markers) {
    const photos = [];
    for (const p of m.photos || []) {
      photos.push({ image: await blobToDataUrl(p.blob), addedAt: p.addedAt });
    }
    out.push({
      buildingCode: m.buildingCode,
      planFile: m.planFile,
      planName: m.planName,
      x: m.x,
      y: m.y,
      note: m.note,
      category: m.category || "",
      done: !!m.done,
      photos,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    });
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `ibp-kopia-${stamp}.json`);
  await dbSetMeta("lastExportAt", new Date().toISOString());
  await refreshBackupInfo();
});

importBackupInput.addEventListener("change", async () => {
  const file = importBackupInput.files[0];
  if (!file) return;
  const text = await file.text();
  const records = JSON.parse(text);
  for (const r of records) {
    const photos = (r.photos || []).map((p) => {
      const blob = dataUrlToBlob(p.image);
      return { blob, type: blob.type, addedAt: p.addedAt || new Date().toISOString() };
    });
    await dbAddMarker({
      buildingCode: r.buildingCode,
      planKey: planKeyOf(r.buildingCode, r.planFile),
      planFile: r.planFile,
      planName: r.planName,
      x: r.x,
      y: r.y,
      note: r.note || "",
      category: r.category || "",
      done: !!r.done,
      photos,
      createdAt: r.createdAt || new Date().toISOString(),
      updatedAt: r.updatedAt || new Date().toISOString(),
    });
  }
  importBackupInput.value = "";
  alert(`Zaimportowano ${records.length} punktów.`);
  if (currentPlanKey) await selectPlan(currentBuildingCode, currentPlanFile, currentPlanName);
  await loadInventory();
});

// --- Import planow budynkow (lokalnie, jednorazowo) ---
importPlansInput.addEventListener("change", async () => {
  const file = importPlansInput.files[0];
  if (!file) return;
  importPlansInput.disabled = true;
  try {
    const text = await file.text();
    const records = JSON.parse(text);
    for (const r of records) {
      const blob = dataUrlToBlob(r.image);
      await dbPutPlanImage({
        key: planKeyOf(r.buildingCode, r.file),
        buildingCode: r.buildingCode,
        buildingName: r.buildingName || r.buildingCode,
        file: r.file,
        name: r.name,
        sortOrder: r.sortOrder || 0,
        blob,
      });
    }
    importPlansInput.value = "";
    alert(`Wczytano ${records.length} planów.`);
    await loadBuildings();
  } catch (err) {
    alert("Nie udało się wczytać pliku planów: " + err.message);
  } finally {
    importPlansInput.disabled = false;
  }
});

// --- Raport PDF: mapka z ponumerowanymi punktami + legenda notatek ---
const BRAND = [120, 40, 52]; // Pantone 202C - System Identyfikacji Wizualnej UPWr
const REPORT_CATEGORIES = [
  "Czujki a zwierzęta pozostawione na noc",
  "Propozycja lokalizacji punktów odbicia się dla ochroniarza",
];

// Rysuje w doc (od pozycji y) mapke z ponumerowanymi punktami i legende dla jednego
// planu/kondygnacji. Wspoldzielone przez raport pojedynczego rzutu i raport zbiorczy
// (wielu budynkow na raz) - obie wersje ukladaja tylko naglowki wokol tego bloku.
async function renderPlanSection(doc, y, buildingCode, planFile, planName, markers, opts) {
  const { pageW, pageH, margin, skipHeading } = opts;
  const availW = pageW - margin * 2;
  if (!markers.length) return y;

  const rec = await dbGetPlanImage(buildingCode, planFile);
  if (!rec) return y; // plan usuniety/niewczytany lokalnie - pomijamy sekcje, nie przerywamy calego raportu

  const url = URL.createObjectURL(rec.blob);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }

  const MAX_DIM = 3500; // bezpieczny limit dla canvasu na telefonach
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const cw = Math.round(img.naturalWidth * scale);
  const ch = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, cw, ch);

  const radius = Math.max(10, Math.round(cw * 0.012));
  markers.forEach((m, idx) => {
    const num = idx + 1;
    // Leaflet (CRS.Simple) liczy y "od dolu w gore" (jak szerokosc geograficzna),
    // a canvas/obrazek "od gory w dol" - trzeba odwrocic os Y przy przenoszeniu.
    const x = m.x * scale;
    const py = (img.naturalHeight - m.y) * scale;
    ctx.beginPath();
    ctx.arc(x, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = m.done ? "#16a34a" : "#782834";
    ctx.fill();
    ctx.lineWidth = Math.max(2, radius * 0.15);
    ctx.strokeStyle = "white";
    ctx.stroke();
    ctx.fillStyle = "white";
    ctx.font = `bold ${Math.round(radius * 1.1)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(num), x, py + 1);
  });

  const mapImageData = canvas.toDataURL("image/jpeg", 0.85);

  if (!skipHeading) {
    if (y + 10 > pageH - margin) {
      doc.addPage();
      y = margin;
    }
    doc.setFont("times", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...BRAND);
    doc.text(planName, margin, y);
    y += 6;
  }

  const maxImgH = pageH * (skipHeading ? 0.55 : 0.45);
  const imgRatio = ch / cw;
  let imgW = availW;
  let imgH = imgW * imgRatio;
  if (imgH > maxImgH) {
    imgH = maxImgH;
    imgW = imgH / imgRatio;
  }
  if (y + imgH > pageH - margin) {
    doc.addPage();
    y = margin;
  }
  const imgX = margin + (availW - imgW) / 2;
  doc.addImage(mapImageData, "JPEG", imgX, y, imgW, imgH);
  y += imgH + 8;

  doc.setTextColor(...BRAND);
  doc.setFont("times", "bold");
  doc.setFontSize(10);
  doc.text("Legenda:", margin, y);
  y += 5;
  doc.setFont("times", "normal");
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(9);

  const THUMB = 16;
  const THUMB_GAP = 2;
  const MAX_THUMBS = 6;

  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const num = i + 1;
    const photos = m.photos || [];
    const statusMark = m.done ? "[✓]" : "[ ]";
    const categoryPart = m.category ? ` [${m.category}]` : "";
    const noteLines = doc.splitTextToSize(`${statusMark} ${num}.${categoryPart} ${m.note || "(brak notatki)"}`, availW);
    const photosRowH = photos.length ? THUMB + 4 : 0;
    const blockH = noteLines.length * 4.2 + photosRowH + 4;
    if (y + blockH > pageH - margin) {
      doc.addPage();
      y = margin;
    }

    // najpierw tekst notatki (pelna szerokosc), zdjecia (jesli sa) ponizej niego
    doc.text(noteLines, margin, y + 4);
    y += noteLines.length * 4.2 + 2;

    if (photos.length) {
      let thumbX = margin;
      for (let p = 0; p < Math.min(photos.length, MAX_THUMBS); p++) {
        try {
          const dataUrl = await blobToDataUrl(photos[p].blob);
          const fmt = /png/i.test(dataUrl.slice(0, 30)) ? "PNG" : "JPEG";
          doc.addImage(dataUrl, fmt, thumbX, y, THUMB, THUMB);
        } catch (e) {
          // zdjecie w nieobslugiwanym formacie (np. HEIC) - pomijamy miniaturke, tekst zostaje
        }
        thumbX += THUMB + THUMB_GAP;
      }
      if (photos.length > MAX_THUMBS) {
        doc.setFontSize(7);
        doc.text(`+${photos.length - MAX_THUMBS}`, thumbX, y + THUMB / 2);
        doc.setFontSize(9);
      }
      y += THUMB + 2;
    }
    y += 4;
  }

  return y + 6; // odstep przed kolejnym planem/budynkiem w raporcie zbiorczym
}

async function generatePlanReport(buildingCode, planKey, planFile, planName) {
  const markers = await dbGetMarkersByPlan(planKey);
  markers.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (!markers.length) {
    alert("Ten rzut nie ma jeszcze żadnych punktów do raportu.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  doc.setFont("times", "normal");

  // pasek akcentu na gorze strony, nawiazujacy do SIW UPWr
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageW, 4, "F");

  doc.setTextColor(...BRAND);
  doc.setFont("times", "bold");
  doc.setFontSize(13);
  doc.text(`Inwentaryzacja — budynek ${buildingCode} — ${planName}`, margin, margin + 6);
  doc.setFont("times", "normal");
  doc.setTextColor(90, 90, 90);
  doc.setFontSize(9);
  doc.text(`Wygenerowano: ${new Date().toLocaleString("pl-PL")}`, margin, margin + 11);
  doc.setTextColor(20, 20, 20);

  await renderPlanSection(doc, margin + 20, buildingCode, planFile, planName, markers, {
    pageW,
    pageH,
    margin,
    skipHeading: true,
  });

  doc.save(`raport-${buildingCode}-${planName}.pdf`.replace(/[\\/:*?"<>|]/g, "_"));
}

// Raport zbiorczy: wszystkie budynki na raz, kazdy budynek od nowej strony, tylko
// punkty w kategoriach "czujki" i "propozycja lokalizacji dla ochroniarza".
async function generateFullReport() {
  const allMarkers = await dbGetAllMarkers();
  const filtered = allMarkers.filter((m) => REPORT_CATEGORIES.includes(m.category));
  if (!filtered.length) {
    alert('Brak punktów w kategoriach "czujki" / "lokalizacja dla ochroniarza" do raportu.');
    return;
  }

  const byBuilding = {};
  for (const m of filtered) {
    (byBuilding[m.buildingCode] = byBuilding[m.buildingCode] || []).push(m);
  }
  const buildingsWithMarkers = buildingsData.filter((b) => byBuilding[b.code] && byBuilding[b.code].length);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  const stamp = new Date().toLocaleString("pl-PL");

  // Jedna sekwencyjna petla (header + tresc na biezaco, z await) - addPage() w jsPDF
  // zawsze dokleja strone na koncu dokumentu, wiec budynki i ich ewentualne "przelewki"
  // tresci musza powstawac w scislej kolejnosci, a nie w dwoch osobnych przebiegach.
  for (let bi = 0; bi < buildingsWithMarkers.length; bi++) {
    const building = buildingsWithMarkers[bi];
    if (bi > 0) doc.addPage();

    doc.setFillColor(...BRAND);
    doc.rect(0, 0, pageW, 4, "F");
    doc.setFont("times", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...BRAND);
    doc.text(`Budynek ${building.code} — ${building.name}`, margin, margin + 8);
    doc.setFont("times", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90, 90, 90);
    doc.text("Kategorie: czujki a zwierzęta pozostawione na noc; propozycja lokalizacji punktów dla ochroniarza", margin, margin + 13);
    doc.text(`Wygenerowano: ${stamp}`, margin, margin + 17);
    doc.setTextColor(20, 20, 20);

    let y = margin + 24;
    const byPlan = {};
    for (const m of byBuilding[building.code]) (byPlan[m.planFile] = byPlan[m.planFile] || []).push(m);

    for (const plan of building.plans) {
      const planMarkers = byPlan[plan.file];
      if (!planMarkers || !planMarkers.length) continue;
      planMarkers.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      y = await renderPlanSection(doc, y, building.code, plan.file, plan.name, planMarkers, { pageW, pageH, margin });
    }
  }

  const dateStamp = new Date().toISOString().slice(0, 10);
  doc.save(`raport-zbiorczy-czujki-ochrona-${dateStamp}.pdf`);
}

fullReportBtn.addEventListener("click", generateFullReport);

// --- Service worker + PWA install ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

// --- Start ---
(async function init() {
  await loadBuildings();
  await refreshBackupInfo();
})();
