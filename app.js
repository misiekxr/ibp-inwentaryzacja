const { openDB } = idb;

const dbPromise = openDB("ibp-db", 4, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      const markers = db.createObjectStore("markers", { keyPath: "id", autoIncrement: true });
      markers.createIndex("by-plan", "planKey");
      markers.createIndex("by-building", "buildingCode");
      db.createObjectStore("meta", { keyPath: "key" });
      const planImages = db.createObjectStore("planImages", { keyPath: "key" });
      planImages.createIndex("by-building", "buildingCode");
    }
    if (oldVersion < 2) {
      db.createObjectStore("symbolTypes", { keyPath: "id", autoIncrement: true });
    }
    if (oldVersion < 3) {
      const measurements = db.createObjectStore("measurements", { keyPath: "id", autoIncrement: true });
      measurements.createIndex("by-building", "buildingCode");
    }
    if (oldVersion < 4) {
      // Kolejka wysylki do serwera (przetrwa restart appki/utrate polaczenia)
      // i lista wykrytych konfliktow do recznego przejrzenia - patrz sync.js.
      db.createObjectStore("syncQueue", { keyPath: "key" });
      db.createObjectStore("syncConflicts", { keyPath: "key" });
    }
  },
});

async function dbAddMarker(marker) {
  const db = await dbPromise;
  if (!marker.id) marker.id = uuidv4();
  const id = await db.add("markers", marker);
  syncEnqueue("marker", id, marker.buildingCode);
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
  syncEnqueue("marker", id, updated.buildingCode);
  return updated;
}

async function dbDeleteMarker(id) {
  const db = await dbPromise;
  const existing = await db.get("markers", id);
  await db.delete("markers", id);
  if (existing) syncEnqueueDelete("marker", id, existing.buildingCode, existing._syncUpdatedAt || null);
}

async function dbAddPhotoToMarker(id, blob, type) {
  const db = await dbPromise;
  const tx = db.transaction("markers", "readwrite");
  const existing = await tx.store.get(id);
  if (!existing) return null;
  const photoEntry = { id: uuidv4(), blob, type, addedAt: new Date().toISOString(), synced: false };
  const photos = [...(existing.photos || []), photoEntry];
  const updated = { ...existing, photos, updatedAt: new Date().toISOString() };
  await tx.store.put(updated);
  await tx.done;
  syncEnqueue("marker", id, updated.buildingCode);
  syncEnqueuePhoto(id, photoEntry.id);
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
  syncEnqueue("marker", id, updated.buildingCode);
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

async function dbAddSymbolType(type) {
  const db = await dbPromise;
  if (!type.id) type.id = uuidv4();
  const id = await db.add("symbolTypes", type);
  if (!type.builtin) syncEnqueue("symbolType", id, null);
  return { ...type, id };
}

async function dbGetAllSymbolTypes() {
  const db = await dbPromise;
  return db.getAll("symbolTypes");
}

async function dbDeleteSymbolType(id) {
  const db = await dbPromise;
  const existing = await db.get("symbolTypes", id);
  await db.delete("symbolTypes", id);
  if (existing && !existing.builtin) syncEnqueueDelete("symbolType", id, null, existing._syncUpdatedAt || null);
}

async function dbAddMeasurement(measurement) {
  const db = await dbPromise;
  if (!measurement.id) measurement.id = uuidv4();
  const id = await db.add("measurements", measurement);
  syncEnqueue("measurement", id, measurement.buildingCode);
  return { ...measurement, id };
}

async function dbUpdateMeasurement(id, changes) {
  const db = await dbPromise;
  const tx = db.transaction("measurements", "readwrite");
  const existing = await tx.store.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...changes };
  await tx.store.put(updated);
  await tx.done;
  syncEnqueue("measurement", id, updated.buildingCode);
  return updated;
}

async function dbDeleteMeasurement(id) {
  const db = await dbPromise;
  const existing = await db.get("measurements", id);
  await db.delete("measurements", id);
  if (existing) syncEnqueueDelete("measurement", id, existing.buildingCode, existing._syncUpdatedAt || null);
}

async function dbGetAllMeasurements() {
  const db = await dbPromise;
  return db.getAll("measurements");
}

async function dbGetMeasurementsByBuilding(buildingCode) {
  const db = await dbPromise;
  return db.getAllFromIndex("measurements", "by-building", buildingCode);
}

async function dbGetPlanImageByKey(key) {
  const db = await dbPromise;
  return db.get("planImages", key);
}

// Jak dbPutPlanImage, ale nigdy nie kasuje juz ustawionej skali kalibracji
// (scaleMPerPx) danego planu, jesli wywolujacy jej wprost nie poda - inaczej
// podmiana/re-import tego samego pliku planu (np. nowa wersja rzutu) zgubilaby
// wczesniej wykonana kalibracje bez ostrzezenia.
async function dbPutPlanImagePreserveScale(record) {
  if (record.scaleMPerPx === undefined) {
    const existing = await dbGetPlanImageByKey(record.key);
    if (existing && existing.scaleMPerPx) record.scaleMPerPx = existing.scaleMPerPx;
  }
  await dbPutPlanImage(record);
}

async function dbSetPlanScale(key, scaleMPerPx) {
  const db = await dbPromise;
  const tx = db.transaction("planImages", "readwrite");
  const existing = await tx.store.get(key);
  if (!existing) return null;
  const updated = { ...existing, scaleMPerPx };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

// 5 wbudowanych symboli PPOZ jako proste SVG (rysowane raz, przy pierwszym starcie appki
// na danym urzadzeniu - potem zyja jako zwykle rekordy w symbolTypes, tak jak wlasne typy
// uzytkownika). Drzwi = standardowy architektoniczny symbol (skrzydlo + luk otwarcia).
// Gasnica/hydranty = czerwone tlo + uproszczony bialy piktogram, w duchu znakow PPOZ.
const DEFAULT_SYMBOL_TYPES = [
  {
    name: "Drzwi pojedyncze",
    builtin: true,
    iconKind: "svg",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><line x1="10" y1="90" x2="10" y2="15" stroke="black" stroke-width="5"/><path d="M10 15 A 75 75 0 0 1 85 90" fill="none" stroke="black" stroke-width="2.5" stroke-dasharray="5 4"/></svg>',
  },
  {
    name: "Drzwi podwójne",
    builtin: true,
    iconKind: "svg",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><line x1="5" y1="90" x2="5" y2="20" stroke="black" stroke-width="5"/><path d="M5 20 A 70 70 0 0 1 50 90" fill="none" stroke="black" stroke-width="2.5" stroke-dasharray="5 4"/><line x1="95" y1="90" x2="95" y2="20" stroke="black" stroke-width="5"/><path d="M95 20 A 70 70 0 0 0 50 90" fill="none" stroke="black" stroke-width="2.5" stroke-dasharray="5 4"/></svg>',
  },
  {
    name: "Gaśnica",
    builtin: true,
    iconKind: "svg",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="4" y="4" width="92" height="92" rx="10" fill="#c8102e"/><rect x="42" y="35" width="20" height="45" rx="6" fill="white"/><rect x="46" y="20" width="12" height="16" rx="3" fill="white"/><path d="M40 26 h24" stroke="white" stroke-width="4" stroke-linecap="round"/><path d="M42 40 C 25 45, 22 60, 30 72" stroke="white" stroke-width="4" fill="none" stroke-linecap="round"/></svg>',
  },
  {
    name: "Hydrant wewnętrzny",
    builtin: true,
    iconKind: "svg",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="4" y="4" width="92" height="92" rx="10" fill="#c8102e"/><circle cx="42" cy="45" r="22" fill="none" stroke="white" stroke-width="5"/><circle cx="42" cy="45" r="7" fill="white"/><path d="M60 60 C 75 68, 80 78, 78 88" stroke="white" stroke-width="5" fill="none" stroke-linecap="round"/></svg>',
  },
  {
    name: "Hydrant zewnętrzny",
    builtin: true,
    iconKind: "svg",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="4" y="4" width="92" height="92" rx="10" fill="#c8102e"/><rect x="40" y="30" width="20" height="40" rx="4" fill="white"/><ellipse cx="50" cy="28" rx="13" ry="8" fill="white"/><rect x="26" y="42" width="12" height="10" rx="3" fill="white"/><rect x="62" y="42" width="12" height="10" rx="3" fill="white"/><rect x="38" y="70" width="24" height="8" rx="2" fill="white"/></svg>',
  },
];

function symbolIconSrc(type) {
  if (type.iconKind === "svg") return "data:image/svg+xml;utf8," + encodeURIComponent(type.svg);
  return URL.createObjectURL(type.imageBlob);
}

async function loadSymbolTypes() {
  let types = await dbGetAllSymbolTypes();
  if (!types.length) {
    for (const t of DEFAULT_SYMBOL_TYPES) await dbAddSymbolType(t);
    types = await dbGetAllSymbolTypes();
  }
  symbolTypesData = types;
  symbolIconCache.clear();
  for (const t of types) symbolIconCache.set(t.id, symbolIconSrc(t));
}

function setPlacementMode(id, label) {
  // Zmiana trybu w trakcie niezapisanego pomiaru odrzucilaby jego punkty od
  // ostatniego zapisu - ostrzegamy zamiast cicho gubic prace w terenie.
  if (activeMeasurement && placementMode === "measure" && id !== "measure") {
    if (!confirm("Masz niezapisany pomiar w toku. Zmiana trybu odrzuci punkty dodane od ostatniego zapisu. Kontynuować?")) return;
    closeMeasurePanel();
  }
  placementMode = id;
  paletteCurrentLabel.textContent = label;
  symbolPaletteList.classList.add("hidden");
  renderSymbolPalette();
}

// Paleta: "Punkt" (domyslny) + kazdy typ symbolu (wbudowany albo wlasny) + formularz
// dodania nowego typu. Wybrany tryb zostaje aktywny miedzy kliknieciami na mapie, zeby
// mozna bylo postawic kilka tych samych symboli pod rzad bez przelaczania za kazdym razem.
function renderSymbolPalette() {
  symbolPaletteList.innerHTML = "";

  const pointBtn = document.createElement("button");
  pointBtn.type = "button";
  pointBtn.className = "palette-item" + (placementMode === null ? " active" : "");
  pointBtn.innerHTML = '<span class="palette-dot"></span><span>Punkt (notatka)</span>';
  pointBtn.addEventListener("click", () => setPlacementMode(null, "Punkt"));
  symbolPaletteList.appendChild(pointBtn);

  const measureBtn = document.createElement("button");
  measureBtn.type = "button";
  measureBtn.className = "palette-item" + (placementMode === "measure" ? " active" : "");
  measureBtn.innerHTML = '<span class="palette-dot" style="background:#0891b2;"></span><span>Pomiar odległości</span>';
  measureBtn.title = "Stukaj na planie, żeby dodawać punkty pomiaru - suma odcinków (nawet między piętrami) liczy się automatycznie";
  measureBtn.addEventListener("click", () => setPlacementMode("measure", "Pomiar odległości"));
  symbolPaletteList.appendChild(measureBtn);

  for (const t of symbolTypesData) {
    const row = document.createElement("div");
    row.className = "palette-type-row";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-item" + (placementMode === t.id ? " active" : "");
    btn.innerHTML = `<img class="palette-icon" src="${symbolIconCache.get(t.id)}" alt="">` +
      `<span>${t.name}</span>`;
    btn.addEventListener("click", () => setPlacementMode(t.id, t.name));
    row.appendChild(btn);

    if (!t.builtin) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "palette-type-del";
      del.textContent = "×";
      del.title = "Usuń ten typ symbolu";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        const allMarkers = await dbGetAllMarkers();
        const inUse = allMarkers.some((m) => m.symbolTypeId === t.id);
        if (inUse) {
          alert(`Nie można usunąć „${t.name}” — jest użyty na co najmniej jednym punkcie. Usuń najpierw te punkty albo zmień im typ.`);
          return;
        }
        if (!confirm(`Usunąć typ symbolu „${t.name}”?`)) return;
        await dbDeleteSymbolType(t.id);
        if (placementMode === t.id) placementMode = null;
        await loadSymbolTypes();
        renderSymbolPalette();
      });
      row.appendChild(del);
    }

    symbolPaletteList.appendChild(row);
  }

  const addForm = document.createElement("div");
  addForm.className = "palette-add-form";
  addForm.innerHTML =
    '<input type="text" id="new-symbol-name" placeholder="Nazwa nowego symbolu">' +
    '<input type="file" id="new-symbol-file" accept="image/*">' +
    '<button type="button" id="new-symbol-save" class="secondary">+ Dodaj nowy typ symbolu</button>';
  symbolPaletteList.appendChild(addForm);

  document.getElementById("new-symbol-save").addEventListener("click", async () => {
    const nameInput = document.getElementById("new-symbol-name");
    const fileInput = document.getElementById("new-symbol-file");
    const name = nameInput.value.trim();
    const file = fileInput.files && fileInput.files[0];
    if (!name || !file) {
      alert("Podaj nazwę i wybierz obrazek.");
      return;
    }
    const added = await dbAddSymbolType({ name, builtin: false, iconKind: "image", imageBlob: file });
    await loadSymbolTypes();
    setPlacementMode(added.id, added.name);
  });
}

// --- DOM ---
const buildingSelect = document.getElementById("building-select");
const planSelect = document.getElementById("plan-select");
const inventoryBuildingFilter = document.getElementById("inventory-building-filter");
const inventoryPlanFilter = document.getElementById("inventory-plan-filter");
const inventoryStatusFilter = document.getElementById("inventory-status-filter");
const inventoryLayerFilter = document.getElementById("inventory-layer-filter");
const inventoryCategoryFilter = document.getElementById("inventory-category-filter");
const exportCsvLink = document.getElementById("export-csv-link");
const fullReportBtn = document.getElementById("full-report-btn");
const workReportBtn = document.getElementById("work-report-btn");
const reportBtn = document.getElementById("report-btn");
const calibrateBtn = document.getElementById("calibrate-btn");
const symbolPaletteToggle = document.getElementById("symbol-palette-toggle");
const symbolPaletteList = document.getElementById("symbol-palette-list");
const paletteCurrentLabel = document.getElementById("palette-current-label");
const placementLayer = document.getElementById("placement-layer");
const backupBanner = document.getElementById("backup-banner");

const markerPanel = document.getElementById("marker-panel");
const markerPanelTitle = document.getElementById("marker-panel-title");
const markerDone = document.getElementById("marker-done");
const markerLayer = document.getElementById("marker-layer");
const markerDueDate = document.getElementById("marker-due-date");
const markerReviewDate = document.getElementById("marker-review-date");
const markerCategory = document.getElementById("marker-category");
const markerCategoryCustom = document.getElementById("marker-category-custom");
const manageCategoriesBtn = document.getElementById("manage-categories-btn");
const categoryManageList = document.getElementById("category-manage-list");
const symbolRotateRow = document.getElementById("symbol-rotate-row");
const symbolRotateLeftBtn = document.getElementById("symbol-rotate-left");
const symbolRotateRightBtn = document.getElementById("symbol-rotate-right");
const symbolMirrorBtn = document.getElementById("symbol-mirror");
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
const deviceLabelInput = document.getElementById("device-label-input");
const backupDirSection = document.getElementById("backup-dir-section");
const backupDirInfo = document.getElementById("backup-dir-info");
const connectBackupDirBtn = document.getElementById("connect-backup-dir-btn");
const reportEmails = document.getElementById("report-emails");
const saveReportSettingsBtn = document.getElementById("save-report-settings-btn");

const importPlansInput = document.getElementById("import-plans-input");
const buildingsLoadedInfo = document.getElementById("buildings-loaded-info");

const planAddCode = document.getElementById("plan-add-code");
const planAddCodeList = document.getElementById("plan-add-code-list");
const planAddBuildingName = document.getElementById("plan-add-building-name");
const planAddName = document.getElementById("plan-add-name");
const planAddStatus = document.getElementById("plan-add-status");
const planAddCamera = document.getElementById("plan-add-camera");
const planAddFile = document.getElementById("plan-add-file");
const planAddSubmitBtn = document.getElementById("plan-add-submit-btn");
const emptyState = document.getElementById("empty-state");

const snackbar = document.getElementById("snackbar");
const snackbarText = document.getElementById("snackbar-text");
const snackbarUndoBtn = document.getElementById("snackbar-undo");

const photoLightbox = document.getElementById("photo-lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");

const measurePanel = document.getElementById("measure-panel");
const measurePanelTitle = document.getElementById("measure-panel-title");
const measureCategory = document.getElementById("measure-category");
const measureCategoryCustom = document.getElementById("measure-category-custom");
const measureLabelInput = document.getElementById("measure-label");
const measureSegmentsList = document.getElementById("measure-segments-list");
const measureTotalValue = document.getElementById("measure-total-value");
const measureWarning = document.getElementById("measure-warning");
const measureUndoBtn = document.getElementById("measure-undo-point");
const measureFinishBtn = document.getElementById("measure-finish");
const measureCancelBtn = document.getElementById("measure-cancel");
const measureDeleteBtn = document.getElementById("measure-delete");

const pomiaryBuildingFilter = document.getElementById("pomiary-building-filter");
const pomiaryCategoryFilter = document.getElementById("pomiary-category-filter");

const valueModal = document.getElementById("value-modal");
const valueModalTitle = document.getElementById("value-modal-title");
const valueModalMessage = document.getElementById("value-modal-message");
const valueModalInput = document.getElementById("value-modal-input");
const valueModalOk = document.getElementById("value-modal-ok");
const valueModalCancel = document.getElementById("value-modal-cancel");

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
let symbolTypesData = [];
const symbolIconCache = new Map(); // symbolTypeId -> src (data: albo blob: URL)
let placementMode = null; // null = zwykly punkt, id typu symbolu, albo "measure" (pomiar dlugosci)

// Pomiar w budowie/edycji (jeszcze niezapisany do bazy, albo zapisany ale z
// doklejanymi na biezaco kolejnymi punktami) - patrz sekcja "Pomiar dlugosci".
let activeMeasurement = null; // { id?, buildingCode, category, label, points:[], segments:[] }
let measurementLeafletLayers = []; // warstwy (markery+linie) pomiarow na aktualnie widocznym planie
let calibrating = false;
let calibrationPoint1 = null; // {x,y} pierwszy stukniety punkt kalibracji skali
let calibrationMarker1 = null; // tymczasowy L.circleMarker dla powyzszego

symbolPaletteToggle.addEventListener("click", () => {
  symbolPaletteList.classList.toggle("hidden");
});

function planKeyOf(buildingCode, file) {
  return `${buildingCode}::${file}`;
}

// Generyczny modal "podaj liczbę" (kalibracja skali, ręczna długość odcinka
// pomiaru) - zwraca Promise<number|null> (null = anulowano/wpisano śmieci).
let valueModalResolve = null;

function askNumberModal(title, message, defaultValue) {
  valueModalTitle.textContent = title;
  valueModalMessage.textContent = message;
  valueModalInput.value = defaultValue != null ? defaultValue : "";
  valueModal.classList.remove("hidden");
  setTimeout(() => valueModalInput.focus(), 50);
  return new Promise((resolve) => {
    valueModalResolve = resolve;
  });
}

function closeValueModal(result) {
  valueModal.classList.add("hidden");
  const resolve = valueModalResolve;
  valueModalResolve = null;
  if (resolve) resolve(result);
}

valueModalOk.addEventListener("click", () => {
  const v = parseFloat(String(valueModalInput.value).replace(",", "."));
  closeValueModal(Number.isFinite(v) ? v : null);
});
valueModalCancel.addEventListener("click", () => closeValueModal(null));
valueModal.addEventListener("click", (e) => {
  if (e.target === valueModal) closeValueModal(null); // klik w tlo = anuluj
});
valueModalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    valueModalOk.click();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeValueModal(null);
  }
});

const DEFAULT_CATEGORIES = [
  "Czujki a zwierzęta pozostawione na noc",
  "Propozycja lokalizacji punktów odbicia się dla ochroniarza",
  "Aktualizacja planów IBP",
  "DOSTAWA",
];

const LAYER_LABELS = {
  inventory: "Inwentaryzacja IBP",
  delivery: "DOSTAWY / poprawki",
  renovation: "Nadzór nad remontem",
};

function layerLabel(layer) {
  return LAYER_LABELS[layer] || LAYER_LABELS.inventory;
}

// Lista kategorii = kategorie domyslne (pomniejszone o usuniete przez uzytkownika,
// patrz deleteCategory) + wszystkie juz uzyte w bazie (np. wpisane recznie przez
// "+ Nowa kategoria") - dzieki temu raz wpisana kategoria pojawia sie pozniej sama
// w liscie, bez potrzeby wpisywania jej ponownie za kazdym razem.
async function knownCategories() {
  const removedDefaults = (await dbGetMeta("removedDefaultCategories")) || [];
  const markers = await dbGetAllMarkers();
  const set = new Set(DEFAULT_CATEGORIES.filter((c) => !removedDefaults.includes(c)));
  for (const m of markers) if (m.category) set.add(m.category);
  return Array.from(set).sort((a, b) => a.localeCompare(b, "pl"));
}

// Usuniecie kategorii: punkty ktore ja mialy wracaja do "(brak)". Kategorie domyslne
// sa "na stale" w kodzie, wiec zeby faktycznie znikaly z listy po usunieciu, zapisujemy
// je w IndexedDB jako wykluczone (removedDefaultCategories) - patrz knownCategories().
async function deleteCategory(name) {
  const markers = await dbGetAllMarkers();
  for (const m of markers) {
    if (m.category === name) await dbUpdateMarker(m.id, { category: "", updatedAt: new Date().toISOString() });
  }
  if (DEFAULT_CATEGORIES.includes(name)) {
    const removed = (await dbGetMeta("removedDefaultCategories")) || [];
    if (!removed.includes(name)) {
      removed.push(name);
      await dbSetMeta("removedDefaultCategories", removed);
    }
  }
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

async function renderCategoryManageList() {
  const cats = await knownCategories();
  categoryManageList.innerHTML = "";
  if (!cats.length) {
    categoryManageList.innerHTML = '<p class="category-manage-empty">Brak kategorii.</p>';
    return;
  }
  for (const c of cats) {
    const row = document.createElement("div");
    row.className = "category-manage-row";

    const label = document.createElement("span");
    label.textContent = c;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "category-manage-del";
    del.textContent = "×";
    del.title = "Usuń kategorię";
    del.addEventListener("click", async () => {
      if (!confirm(`Usunąć kategorię „${c}”? Punkty z tą kategorią wrócą do statusu (brak).`)) return;
      await deleteCategory(c);
      await renderCategoryManageList();
      if (editingMarkerId != null) {
        const current = await dbGetMarker(editingMarkerId);
        await populateCategorySelect(current ? current.category || "" : "");
      }
      await loadInventory();
    });

    row.appendChild(label);
    row.appendChild(del);
    categoryManageList.appendChild(row);
  }
}

manageCategoriesBtn.addEventListener("click", async () => {
  const willShow = categoryManageList.classList.contains("hidden");
  if (willShow) await renderCategoryManageList();
  categoryManageList.classList.toggle("hidden");
});

// Kropka odblokowania przesuwania jest zawsze obecna w DOM (tylko ukryta) i
// przelaczana pozniej bezposrednio przez klase CSS, NIGDY przez marker.setIcon() -
// setIcon() tworzy nowy element ikony i po drodze potrafi urwac wlasne sciezki
// zdarzen Leaflet (m.in. przeciaganie), co bylo przyczyna buga "wibracja dziala,
// nic wiecej sie nie dzieje".
function makeIcon(m) {
  const hasPhoto = !!(m.photos && m.photos.length);
  const done = !!m.done;
  const photoBadge = hasPhoto
    ? `<div style="position:absolute;top:-4px;right:-4px;font-size:9px;line-height:1;">📷</div>`
    : "";
  const unlockDotHtml = `<div class="marker-unlock-dot" style="display:none;position:absolute;bottom:-3px;left:-3px;width:9px;height:9px;border-radius:50%;background:#dc2626;border:1.5px solid white;"></div>`;

  if (m.symbolTypeId != null && symbolIconCache.has(m.symbolTypeId)) {
    const src = symbolIconCache.get(m.symbolTypeId);
    const transform = `rotate(${m.rotation || 0}deg)${m.mirrored ? " scaleX(-1)" : ""}`;
    const statusDot = `<div style="position:absolute;top:-3px;left:-3px;width:9px;height:9px;border-radius:50%;background:${done ? "#16a34a" : "#782834"};border:1.5px solid white;"></div>`;
    return L.divIcon({
      className: "",
      html: `<div style="position:relative;width:30px;height:30px;">
        <img src="${src}" style="width:100%;height:100%;display:block;transform:${transform};" />
        ${statusDot}${photoBadge}${unlockDotHtml}
      </div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
  }

  const color = done ? "#16a34a" : "#782834";
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:16px;height:16px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,0.5);">${photoBadge}${unlockDotHtml}</div>`,
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
  refreshPlanAddCodeList();

  if (!buildingsData.length) {
    emptyState.classList.remove("hidden");
    reportBtn.classList.add("hidden");
    calibrateBtn.classList.add("hidden");
    return;
  }
  emptyState.classList.add("hidden");
  reportBtn.classList.remove("hidden");
  calibrateBtn.classList.remove("hidden");

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
  if (!building) return;
  for (const p of building.plans) {
    const opt = document.createElement("option");
    opt.value = p.file;
    opt.textContent = p.name;
    planSelect.appendChild(opt);
  }
  if (building.plans.length) {
    const chosen = (preferredFile && building.plans.find((p) => p.file === preferredFile)) || building.plans[0];
    planSelect.value = chosen.file;
    await selectPlan(buildingCode, chosen.file, chosen.name);
  }
  await loadInventory();
  await loadPomiary();
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
  // Kalibracja (2 stukniecia) jest przywiazana do jednego, konkretnego planu -
  // zmiana planu/budynku w trakcie musi ja anulowac, inaczej punkt 1. sprzed
  // zmiany i punkt 2. po zmianie policzylyby bezsensowna, fikcyjna odleglosc.
  if (calibrating) {
    calibrating = false;
    calibrationPoint1 = null;
    clearCalibrationMarker();
    setCalibrateBtnLabel();
  }
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
  await renderMeasurementsForPlan(currentPlanKey);
}

function addLeafletMarker(m) {
  const marker = L.marker([m.y, m.x], {
    icon: makeIcon(m),
    draggable: false,
  });
  marker.markerData = m;
  marker.dragUnlocked = false;

  // Przesuwanie pinezki wymaga przytrzymania 3 sek. (jak "tryb edycji" po
  // przytrzymaniu ikony na ekranie glownym telefonu) - chroni przed przypadkowym
  // przesunieciem punktu przy zwyklym tapnieciu, ktore otwiera panel notatki.
  // Dwuklik ponownie blokuje przesuwanie.
  let longPressTimer = null;
  const cancelLongPress = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };
  // Kropka jest przelaczana bezposrednio na stabilnym elemencie DOM (patrz
  // komentarz w makeIcon) - nie wolno tu wywolywac marker.setIcon().
  const setUnlockDotVisible = (visible) => {
    const el = marker.getElement();
    const dot = el && el.querySelector(".marker-unlock-dot");
    if (dot) dot.style.display = visible ? "block" : "none";
  };
  const unlockDrag = () => {
    marker.dragUnlocked = true;
    marker.dragging.enable();
    setUnlockDotVisible(true);
    if (navigator.vibrate) navigator.vibrate(50);
  };
  const lockDrag = () => {
    cancelLongPress();
    marker.dragUnlocked = false;
    marker.dragging.disable();
    setUnlockDotVisible(false);
  };

  marker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    openMarkerPanel(marker.markerData);
  });
  marker.on("dblclick", (e) => {
    L.DomEvent.stopPropagation(e);
    lockDrag();
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
  const el = marker.getElement();
  if (el) {
    el.style.webkitTouchCallout = "none";
    el.style.userSelect = "none";
    el.addEventListener("pointerdown", () => {
      cancelLongPress();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        unlockDrag();
      }, 3000);
    });
    el.addEventListener("pointerup", cancelLongPress);
    el.addEventListener("pointercancel", cancelLongPress);
    el.addEventListener("pointerleave", cancelLongPress);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }
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

// Pasek "Usunieto [Cofnij]" znany z Androida (np. Gmail, Pliki Google) - usuniecie
// punktu/zdjecia od razu zapisuje sie w bazie (zgodnie z zasada natychmiastowego
// zapisu), ale przez chwile mozna to cofnac, zamiast bezpowrotnie tracic dane
// przez pomylke.
let snackbarTimer = null;
function showSnackbar(message, onUndo) {
  clearTimeout(snackbarTimer);
  snackbarText.textContent = message;
  // Jesli panel punktu (mobilny "bottom sheet") jest akurat otwarty, podnies pasek ponad niego
  if (!markerPanel.classList.contains("hidden")) {
    const rect = markerPanel.getBoundingClientRect();
    snackbar.style.bottom = `${Math.max(16, window.innerHeight - rect.top + 10)}px`;
  } else {
    snackbar.style.bottom = "16px";
  }
  snackbar.classList.remove("hidden");
  snackbarUndoBtn.onclick = () => {
    clearTimeout(snackbarTimer);
    snackbar.classList.add("hidden");
    onUndo();
  };
  snackbarTimer = setTimeout(() => snackbar.classList.add("hidden"), 6000);
}

// Pelnoekranowy podglad zdjecia (lightbox) - dziala i z panelu punktu, i z tabeli
// Inwentaryzacji, dla dowolnego zestawu zdjec przekazanego jako photos[].
let lightboxPhotos = [];
let lightboxIndex = 0;
let lightboxObjectUrl = null;

function showLightboxPhoto() {
  if (lightboxObjectUrl) URL.revokeObjectURL(lightboxObjectUrl);
  lightboxObjectUrl = URL.createObjectURL(lightboxPhotos[lightboxIndex].blob);
  lightboxImg.src = lightboxObjectUrl;
  const multi = lightboxPhotos.length > 1;
  lightboxPrev.classList.toggle("hidden", !multi);
  lightboxNext.classList.toggle("hidden", !multi);
}

function openLightbox(photos, startIndex) {
  if (!photos || !photos.length) return;
  lightboxPhotos = photos;
  lightboxIndex = startIndex || 0;
  showLightboxPhoto();
  photoLightbox.classList.remove("hidden");
}

function closeLightbox() {
  photoLightbox.classList.add("hidden");
  if (lightboxObjectUrl) {
    URL.revokeObjectURL(lightboxObjectUrl);
    lightboxObjectUrl = null;
  }
}

lightboxClose.addEventListener("click", closeLightbox);
photoLightbox.addEventListener("click", (e) => {
  if (e.target === photoLightbox) closeLightbox(); // klik w tlo zamyka podglad
});
lightboxPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  lightboxIndex = (lightboxIndex - 1 + lightboxPhotos.length) % lightboxPhotos.length;
  showLightboxPhoto();
});
lightboxNext.addEventListener("click", (e) => {
  e.stopPropagation();
  lightboxIndex = (lightboxIndex + 1) % lightboxPhotos.length;
  showLightboxPhoto();
});

function renderPhotoGallery(photos) {
  markerPhotoGallery.innerHTML = "";
  (photos || []).forEach((p, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "photo-thumb";

    const img = document.createElement("img");
    img.src = URL.createObjectURL(p.blob);
    img.alt = "zdjęcie punktu";
    img.addEventListener("click", () => openLightbox(photos, idx));

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
      showSnackbar("Zdjęcie usunięte", async () => {
        const restored = await dbAddPhotoToMarker(id, p.blob, p.type);
        if (restored && editingMarkerId === id) {
          renderPhotoGallery(restored.photos);
          refreshLeafletMarker(restored);
        }
      });
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
  if (calibrating) {
    await handleCalibrationClick(e.latlng);
    return;
  }
  if (placementMode === "measure") {
    await addMeasurementVertex(e.latlng);
    return;
  }

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
    layer: placementLayer.value || "inventory",
    dueDate: "",
    reviewDate: "",
    photos: [],
    done: false,
    symbolTypeId: placementMode,
    rotation: 0,
    mirrored: false,
    createdAt: now,
    updatedAt: now,
  });
  addLeafletMarker(marker);
  // Zwykly punkt od razu otwiera panel (jak dotad). Symbol NIE otwiera panelu
  // automatycznie - pozwala szybko postawic kilka tych samych symboli pod rzad
  // bez przerywania; nadal zapisuje sie natychmiast w bazie.
  if (!placementMode) openMarkerPanel(marker);
}

// --- Pomiar dlugosci (przejscia/dojscia ewakuacyjne i inne wymiary) ---
//
// Kazdy punkt pomiaru pamieta, na ktorym planie (planKey) zostal postawiony -
// dzieki temu jeden pomiar moze biec przez kilka kondygnacji/rzutow (np. przez
// klatke schodowa): odcinek miedzy punktami na TYM SAMYM planie liczy sie z
// pikseli * skala kalibracji tego planu, a odcinek miedzy RÓŻNYMI planami (albo
// na planie bez ustawionej skali) trzeba wpisac recznie (np. dlugosc biegu
// schodow) - nie da sie go policzyc geometrycznie ze wspolrzednych.

function pixelDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function formatMeters(v) {
  return v.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " m";
}

// Zwraca {lengthM, manual, crossPlan} dla nowego odcinka albo null, jesli
// uzytkownik anulowal wpisywanie recznej dlugosci - wtedy NIE dodajemy punktu,
// zeby kazdy istniejacy punkt zawsze mial rozwiazany poprzedzajacy odcinek.
async function resolveSegment(prev, next) {
  if (prev.planKey === next.planKey) {
    const rec = await dbGetPlanImageByKey(prev.planKey);
    if (rec && rec.scaleMPerPx) {
      return { lengthM: pixelDist(prev, next) * rec.scaleMPerPx, manual: false, crossPlan: false };
    }
    const val = await askNumberModal(
      "Długość odcinka",
      `Plan „${prev.planName}” nie ma jeszcze ustawionej skali (patrz przycisk „Kalibruj skalę”) — podaj długość tego odcinka ręcznie, w metrach.`,
      ""
    );
    if (val == null || !(val >= 0)) return null;
    return { lengthM: val, manual: true, crossPlan: false };
  }
  const val = await askNumberModal(
    "Długość odcinka między planami",
    `Ten punkt jest na innym planie niż poprzedni („${prev.planName}” → „${next.planName}”). Podaj długość tego odcinka ręcznie, w metrach (np. długość biegu schodów).`,
    ""
  );
  if (val == null || !(val >= 0)) return null;
  return { lengthM: val, manual: true, crossPlan: true };
}

async function addMeasurementVertex(latlng) {
  const point = {
    planKey: currentPlanKey,
    planFile: currentPlanFile,
    planName: currentPlanName,
    x: latlng.lng,
    y: latlng.lat,
  };

  if (!activeMeasurement) {
    activeMeasurement = { buildingCode: currentBuildingCode, category: "", label: "", points: [], segments: [] };
  }

  const points = activeMeasurement.points;
  if (points.length > 0) {
    const seg = await resolveSegment(points[points.length - 1], point);
    if (!seg) return;
    activeMeasurement.segments.push(seg);
  }
  points.push(point);

  await openMeasurePanel(activeMeasurement);
  await renderMeasurementsForPlan(currentPlanKey);
}

// --- Kalibracja skali planu: stuknij 2 punkty o znanej rzeczywistej odleglosci
// (np. szerokosc futryny drzwi, wymiar z rysunku) i podaj te odleglosc w metrach.
function setCalibrateBtnLabel() {
  if (!calibrating) {
    calibrateBtn.textContent = "Kalibruj skalę";
    return;
  }
  calibrateBtn.textContent = calibrationPoint1 ? "Stuknij punkt 2 (tu = anuluj)" : "Stuknij punkt 1 (tu = anuluj)";
}

function clearCalibrationMarker() {
  if (calibrationMarker1) {
    map.removeLayer(calibrationMarker1);
    calibrationMarker1 = null;
  }
}

calibrateBtn.addEventListener("click", () => {
  if (calibrating) {
    calibrating = false;
    calibrationPoint1 = null;
    clearCalibrationMarker();
    setCalibrateBtnLabel();
    return;
  }
  if (activeMeasurement) {
    alert("Zakończ albo anuluj bieżący pomiar (panel po prawej), zanim skalibrujesz plan.");
    return;
  }
  calibrating = true;
  calibrationPoint1 = null;
  setCalibrateBtnLabel();
});

async function handleCalibrationClick(latlng) {
  if (!calibrationPoint1) {
    calibrationPoint1 = { x: latlng.lng, y: latlng.lat };
    calibrationMarker1 = L.circleMarker(latlng, {
      radius: 6,
      color: "#1d4ed8",
      weight: 2,
      fillColor: "#1d4ed8",
      fillOpacity: 0.9,
    }).addTo(map);
    setCalibrateBtnLabel();
    return;
  }

  const p2 = { x: latlng.lng, y: latlng.lat };
  const pxDist = pixelDist(calibrationPoint1, p2);
  clearCalibrationMarker();
  calibrating = false;
  calibrationPoint1 = null;
  setCalibrateBtnLabel();
  if (pxDist < 1) return;

  const realM = await askNumberModal(
    "Kalibracja skali",
    "Podaj rzeczywistą długość zaznaczonego odcinka w metrach (np. znana szerokość drzwi albo wymiar podany na rysunku).",
    ""
  );
  if (realM == null || !(realM > 0)) return;
  await dbSetPlanScale(currentPlanKey, realM / pxDist);
  alert(`Zapisano skalę planu „${currentPlanName}”.`);
  await renderMeasurementsForPlan(currentPlanKey);
}

// --- Panel pomiaru (analogicznie do panelu punktu) ---
const MEASUREMENT_DEFAULT_CATEGORIES = ["Przejście ewakuacyjne", "Dojście ewakuacyjne", "Inne"];

async function knownMeasurementCategories() {
  const removedDefaults = (await dbGetMeta("removedDefaultMeasurementCategories")) || [];
  const measurements = await dbGetAllMeasurements();
  const set = new Set(MEASUREMENT_DEFAULT_CATEGORIES.filter((c) => !removedDefaults.includes(c)));
  for (const m of measurements) if (m.category) set.add(m.category);
  return Array.from(set).sort((a, b) => a.localeCompare(b, "pl"));
}

async function populateMeasureCategorySelect(selected) {
  const cats = await knownMeasurementCategories();
  measureCategory.innerHTML = "";
  const optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = "(brak)";
  measureCategory.appendChild(optNone);
  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    measureCategory.appendChild(opt);
  }
  const optCustom = document.createElement("option");
  optCustom.value = "__custom__";
  optCustom.textContent = "+ Nowa kategoria…";
  measureCategory.appendChild(optCustom);
  measureCategory.value = selected && cats.includes(selected) ? selected : "";
  measureCategoryCustom.classList.add("hidden");
}

measureCategory.addEventListener("change", () => {
  if (measureCategory.value === "__custom__") {
    measureCategoryCustom.classList.remove("hidden");
    measureCategoryCustom.value = "";
    measureCategoryCustom.focus();
    return;
  }
  if (activeMeasurement) activeMeasurement.category = measureCategory.value;
});

function saveMeasureCustomCategory() {
  const value = measureCategoryCustom.value.trim();
  measureCategoryCustom.classList.add("hidden");
  if (!value) {
    measureCategory.value = "";
    if (activeMeasurement) activeMeasurement.category = "";
    return;
  }
  if (activeMeasurement) activeMeasurement.category = value;
  populateMeasureCategorySelect(value);
}
measureCategoryCustom.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveMeasureCustomCategory();
  }
});
measureCategoryCustom.addEventListener("blur", saveMeasureCustomCategory);

measureLabelInput.addEventListener("input", () => {
  if (activeMeasurement) activeMeasurement.label = measureLabelInput.value;
});

function renderMeasureSegmentsList(m) {
  measureSegmentsList.innerHTML = "";
  let total = 0;
  let hasCrossPlan = false;
  for (let i = 0; i < m.segments.length; i++) {
    const seg = m.segments[i];
    total += seg.lengthM;
    if (seg.crossPlan) hasCrossPlan = true;
    const fromPt = m.points[i];
    const toPt = m.points[i + 1];
    const planLabel = seg.crossPlan ? `${fromPt.planName} → ${toPt.planName}` : fromPt.planName;
    const row = document.createElement("div");
    row.className = "measure-segment-row" + (seg.manual ? " manual" : "");
    row.innerHTML =
      `<span>${i + 1} → ${i + 2}<span class="seg-plan">${planLabel}${seg.manual ? " · ręcznie" : ""}</span></span>` +
      `<span class="seg-len">${formatMeters(seg.lengthM)}</span>`;
    measureSegmentsList.appendChild(row);
  }
  measureTotalValue.textContent = formatMeters(total);
  measureUndoBtn.disabled = m.points.length === 0;
  measureFinishBtn.disabled = m.points.length < 2;
  if (hasCrossPlan) {
    measureWarning.textContent =
      "Pomiar przechodzi między planami — te odcinki wpisano ręcznie i nie przeliczą się same po zmianie kalibracji.";
    measureWarning.classList.remove("hidden");
  } else {
    measureWarning.classList.add("hidden");
  }
}

async function openMeasurePanel(m) {
  measurePanelTitle.textContent = m.id != null ? `Pomiar #${m.id}` : "Nowy pomiar";
  await populateMeasureCategorySelect(m.category || "");
  measureLabelInput.value = m.label || "";
  measureDeleteBtn.classList.toggle("hidden", m.id == null);
  renderMeasureSegmentsList(m);
  measurePanel.classList.remove("hidden");
}

async function closeMeasurePanel() {
  activeMeasurement = null;
  measurePanel.classList.add("hidden");
  await renderMeasurementsForPlan(currentPlanKey);
}

measureUndoBtn.addEventListener("click", async () => {
  if (!activeMeasurement || !activeMeasurement.points.length) return;
  activeMeasurement.points.pop();
  if (activeMeasurement.segments.length) activeMeasurement.segments.pop();
  if (!activeMeasurement.points.length) {
    await closeMeasurePanel();
    return;
  }
  renderMeasureSegmentsList(activeMeasurement);
  await renderMeasurementsForPlan(currentPlanKey);
});

measureCancelBtn.addEventListener("click", async () => {
  await closeMeasurePanel();
  if (placementMode === "measure") setPlacementMode(null, "Punkt");
});

measureFinishBtn.addEventListener("click", async () => {
  if (!activeMeasurement || activeMeasurement.points.length < 2) return;
  const now = new Date().toISOString();
  const payload = {
    buildingCode: activeMeasurement.buildingCode,
    category: activeMeasurement.category || "",
    label: activeMeasurement.label || "",
    points: activeMeasurement.points,
    segments: activeMeasurement.segments,
    updatedAt: now,
  };
  if (activeMeasurement.id != null) {
    await dbUpdateMeasurement(activeMeasurement.id, payload);
  } else {
    await dbAddMeasurement({ ...payload, createdAt: now });
  }
  await closeMeasurePanel();
  if (placementMode === "measure") setPlacementMode(null, "Punkt");
  await loadPomiary();
});

measureDeleteBtn.addEventListener("click", async () => {
  if (!activeMeasurement || activeMeasurement.id == null) return;
  if (!confirm("Usunąć cały ten pomiar?")) return;
  await dbDeleteMeasurement(activeMeasurement.id);
  await closeMeasurePanel();
  if (placementMode === "measure") setPlacementMode(null, "Punkt");
  await loadPomiary();
});

// --- Rysowanie pomiarow na mapie (tylko wierzcholki/odcinki nalezace do
// aktualnie wyswietlanego planu - reszta trasy jest na innych planach) ---
function clearMeasurementLayers() {
  for (const layer of measurementLeafletLayers) map.removeLayer(layer);
  measurementLeafletLayers = [];
}

function measureVertexIcon(globalIndex, opts) {
  const color = opts.active ? "#1d4ed8" : "#0891b2";
  const badge = opts.crossPlanIn || opts.crossPlanOut
    ? `<div style="position:absolute;top:-4px;right:-4px;font-size:9px;line-height:1;">⇅</div>`
    : "";
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:20px;height:20px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:white;font-size:10px;font-weight:bold;">${globalIndex}${badge}</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

async function editMeasurementFromList(id) {
  if (activeMeasurement && activeMeasurement.id === id) {
    await openMeasurePanel(activeMeasurement); // juz edytowany - tylko pokaz panel, nie gub niezapisanych punktow
    return;
  }
  if (activeMeasurement) {
    if (!confirm("Masz niezapisany pomiar w toku. Otworzenie innego pomiaru go porzuci. Kontynuować?")) return;
    await closeMeasurePanel();
  }
  const all = await dbGetAllMeasurements();
  const m = all.find((x) => x.id === id);
  if (!m || !m.points.length) return;
  document.querySelector('.tab-btn[data-tab="map"]').click();
  const firstPoint = m.points[0];
  if (m.buildingCode !== currentBuildingCode) {
    buildingSelect.value = m.buildingCode;
    await loadPlans(m.buildingCode, firstPoint.planFile);
  } else if (firstPoint.planFile !== currentPlanFile) {
    planSelect.value = firstPoint.planFile;
    await selectPlan(m.buildingCode, firstPoint.planFile, firstPoint.planName);
  }
  activeMeasurement = {
    id: m.id,
    buildingCode: m.buildingCode,
    category: m.category || "",
    label: m.label || "",
    points: [...m.points],
    segments: [...m.segments],
  };
  placementMode = "measure";
  paletteCurrentLabel.textContent = "Pomiar odległości";
  renderSymbolPalette();
  await openMeasurePanel(activeMeasurement);
  await renderMeasurementsForPlan(currentPlanKey);
}

async function renderMeasurementsForPlan(planKey) {
  if (!map || !planKey) return;
  clearMeasurementLayers();

  const saved = currentBuildingCode ? await dbGetMeasurementsByBuilding(currentBuildingCode) : [];
  const all = activeMeasurement ? [...saved.filter((m) => m.id !== activeMeasurement.id), activeMeasurement] : saved;

  for (const m of all) {
    const isActive = activeMeasurement === m;

    for (let i = 0; i < m.segments.length; i++) {
      const seg = m.segments[i];
      if (seg.crossPlan) continue;
      const a = m.points[i];
      const b = m.points[i + 1];
      if (a.planKey !== planKey) continue;
      const line = L.polyline([[a.y, a.x], [b.y, b.x]], {
        color: isActive ? "#1d4ed8" : "#0891b2",
        weight: 3,
        dashArray: seg.manual ? "6 4" : null,
      }).addTo(map);
      measurementLeafletLayers.push(line);
    }

    for (let i = 0; i < m.points.length; i++) {
      const p = m.points[i];
      if (p.planKey !== planKey) continue;
      const crossPlanIn = i > 0 && m.segments[i - 1] && m.segments[i - 1].crossPlan;
      const crossPlanOut = i < m.segments.length && m.segments[i] && m.segments[i].crossPlan;
      const marker = L.marker([p.y, p.x], {
        icon: measureVertexIcon(i + 1, { crossPlanIn, crossPlanOut, active: isActive }),
      }).addTo(map);
      if (!isActive) {
        marker.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          editMeasurementFromList(m.id);
        });
        let title = m.label || m.category || `Pomiar #${m.id}`;
        if (crossPlanIn || crossPlanOut) title += " (przechodzi na inny plan)";
        marker.bindTooltip(title, { direction: "top" });
      }
      measurementLeafletLayers.push(marker);
    }
  }
}

async function openMarkerPanel(m) {
  editingMarkerId = m.id;
  const symbolType = m.symbolTypeId != null ? symbolTypesData.find((t) => t.id === m.symbolTypeId) : null;
  markerPanelTitle.textContent = symbolType ? `${symbolType.name} #${m.id}` : `Punkt #${m.id}`;
  markerDone.checked = !!m.done;
  markerLayer.value = m.layer || "inventory";
  markerDueDate.value = m.dueDate || "";
  markerReviewDate.value = m.reviewDate || "";
  await populateCategorySelect(m.category || "");
  categoryManageList.classList.add("hidden");
  symbolRotateRow.classList.toggle("hidden", !symbolType);
  markerNote.value = m.note || "";
  markerPhotoCamera.value = "";
  markerPhotoGalleryInput.value = "";
  renderPhotoGallery(m.photos);
  setSaveStatus("Zapisano", false);
  markerPanel.classList.remove("hidden");
  markerNote.focus();
}

async function updateSymbolTransform(changes) {
  if (editingMarkerId == null) return;
  const id = editingMarkerId;
  const updated = await dbUpdateMarker(id, { ...changes, updatedAt: new Date().toISOString() });
  if (updated && editingMarkerId === id) {
    refreshLeafletMarker(updated);
    setSaveStatus("Zapisano", false);
  }
}

symbolRotateLeftBtn.addEventListener("click", async () => {
  if (editingMarkerId == null) return;
  const m = await dbGetMarker(editingMarkerId);
  if (!m) return;
  await updateSymbolTransform({ rotation: ((m.rotation || 0) - 90 + 360) % 360 });
});
symbolRotateRightBtn.addEventListener("click", async () => {
  if (editingMarkerId == null) return;
  const m = await dbGetMarker(editingMarkerId);
  if (!m) return;
  await updateSymbolTransform({ rotation: ((m.rotation || 0) + 90) % 360 });
});
symbolMirrorBtn.addEventListener("click", async () => {
  if (editingMarkerId == null) return;
  const m = await dbGetMarker(editingMarkerId);
  if (!m) return;
  await updateSymbolTransform({ mirrored: !m.mirrored });
});

async function closeMarkerPanel() {
  if (editingMarkerId != null) {
    const m = await dbGetMarker(editingMarkerId);
    // porzadek: pusty punkt (bez notatki i zdjecia) usuwamy, zeby przypadkowe
    // tapniecie na mape nie zostawialo "widmowych" pinezek - ale NIE dotyczy to
    // symboli (drzwi/gasnica/hydrant), ktore sa uzyteczne samą swoja obecnoscia
    // na planie nawet bez notatki
    if (m && !m.symbolTypeId && !(m.note || "").trim() && !(m.photos && m.photos.length)) {
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

async function saveMarkerField(field, value) {
  if (editingMarkerId == null) return;
  const updated = await dbUpdateMarker(editingMarkerId, { [field]: value, updatedAt: new Date().toISOString() });
  if (updated) {
    refreshLeafletMarker(updated);
    await loadInventory();
    setSaveStatus("Zapisano", false);
  }
}

markerLayer.addEventListener("change", () => saveMarkerField("layer", markerLayer.value));
markerDueDate.addEventListener("change", () => saveMarkerField("dueDate", markerDueDate.value));
markerReviewDate.addEventListener("change", () => saveMarkerField("reviewDate", markerReviewDate.value));

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
  setSaveStatus("Zapisano", false);
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
  if (editingMarkerId === id) {
    await populateCategorySelect(value);
    setSaveStatus("Zapisano", false);
  }
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

// Zdjecia z aparatu telefonu potrafia miec po kilka-kilkanascie (a przy nowszych
// aparatach - kilkadziesiat) MB. Wczytanie takiego pliku w pelnej rozdzielczosci
// przez zwykle <img> + canvas samo w sobie potrafi wyczerpac pamiec na slabszym
// telefonie, zanim jeszcze dojdzie do kompresji. createImageBitmap z opcja resize
// pozwala przegladarce dekodowac i pomniejszac obraz "w locie", bez trzymania
// pelnej rozdzielczosci w pamieci - to najbardziej odporny sposob obrobki.
async function compressImage(file, maxDim = 1600, quality = 0.75) {
  if (window.createImageBitmap) {
    try {
      const bitmap = await createImageBitmap(file, { resizeWidth: maxDim, resizeQuality: "medium" });
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob) return blob;
    } catch (err) {
      // np. format bez wsparcia dekodera (HEIC na starszym Androidzie) - proba zapasowej metody ponizej
    }
  }

  // Zapasowa metoda + twardy limit czasu: jesli dekodowanie sie zawiesi (nigdy nie
  // odpali ani onload, ani onerror), po 8s i tak zapisujemy oryginal zamiast
  // blokowac zapis punktu w nieskonczonosc - priorytetem jest, zeby zdjecie
  // zawsze trafilo do appki, nawet nieskompresowane.
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const timeout = setTimeout(() => finish(file), 8000);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => finish(blob || file), "image/jpeg", quality);
    };
    img.onerror = () => {
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      finish(file);
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
  // Cala funkcja w jednym try/catch, zeby zaden blad API (np. brak wsparcia
  // udostepniania plikow na danym telefonie) nie odbil sie echem na zapisie
  // zdjecia w appce - ten zapis (handlePhotoFiles) dziala calkowicie niezaleznie.
  const named = new File([file], buildPhotoFilename(file.type), { type: file.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [named] })) {
      await navigator.share({ files: [named] });
      return;
    }
  } catch (err) {
    // uzytkownik anulowal okno Udostepnij albo API zawiodlo w trakcie -
    // sprobuj zapasowej metody ponizej zamiast konczyc po cichu bez efektu
  }
  // Zapasowa metoda dla przegladarek bez wsparcia Web Share API dla plikow
  // (na to trafilismy w praktyce): zwykle pobranie pliku. Trafia do folderu
  // Pobrane, skad wiekszosc galerii/Zdjec na Androidzie i tak go zaindeksuje.
  try {
    downloadBlob(named, named.name);
  } catch (err) {
    // ostatecznosc - appka i tak juz zapisala zdjecie u siebie, wiec dane nie gina
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
  const snapshot = await dbGetMarker(id);
  await dbDeleteMarker(id);
  const old = leafletMarkers[id];
  if (old) map.removeLayer(old);
  delete leafletMarkers[id];
  editingMarkerId = null; // zapobiega ponownemu "sprzataniu" w closeMarkerPanel
  markerPanel.classList.add("hidden");
  await loadInventory();
  if (snapshot) {
    showSnackbar("Punkt usunięty", async () => {
      const restored = await dbAddMarker(snapshot);
      if (restored.planKey === currentPlanKey) addLeafletMarker(restored);
      await loadInventory();
    });
  }
});

markerCloseBtn.addEventListener("click", closeMarkerPanel);

buildingSelect.addEventListener("change", async () => {
  // Pomiar w toku ma sens tylko w obrebie jednego budynku (jego punkty
  // wskazuja na konkretne plany tego budynku) - zmiana budynku go porzuca.
  if (activeMeasurement) {
    if (!confirm("Masz niezapisany pomiar w toku. Zmiana budynku go porzuci. Kontynuować?")) {
      buildingSelect.value = currentBuildingCode;
      return;
    }
    await closeMeasurePanel();
    if (placementMode === "measure") setPlacementMode(null, "Punkt");
  }
  loadPlans(buildingSelect.value);
});
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
    if (btn.dataset.tab === "pomiary") loadPomiary();
    if (btn.dataset.tab === "backup") refreshBackupInfo();
  });
});

// --- Zakladka Pomiary ---
pomiaryBuildingFilter.addEventListener("change", loadPomiary);
pomiaryCategoryFilter.addEventListener("change", loadPomiary);

function populatePomiaryBuildingFilter() {
  const current = pomiaryBuildingFilter.value;
  pomiaryBuildingFilter.innerHTML = '<option value="">Wszystkie</option>';
  for (const b of buildingsData) {
    const opt = document.createElement("option");
    opt.value = b.code;
    opt.textContent = b.name;
    pomiaryBuildingFilter.appendChild(opt);
  }
  if (buildingsData.some((b) => b.code === current)) pomiaryBuildingFilter.value = current;
}

async function refreshPomiaryCategoryFilterOptions() {
  const cats = await knownMeasurementCategories();
  const current = pomiaryCategoryFilter.value;
  pomiaryCategoryFilter.innerHTML = '<option value="">Wszystkie</option>';
  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    pomiaryCategoryFilter.appendChild(opt);
  }
  if (cats.includes(current)) pomiaryCategoryFilter.value = current;
}

function measurementTotal(m) {
  return m.segments.reduce((sum, s) => sum + s.lengthM, 0);
}

function measurementPlanSpan(m) {
  const names = [];
  for (const p of m.points) if (!names.includes(p.planName)) names.push(p.planName);
  return names.join(" → ");
}

async function loadPomiary() {
  if (!buildingsData.length) return;
  populatePomiaryBuildingFilter();
  await refreshPomiaryCategoryFilterOptions();
  const buildingFilter = pomiaryBuildingFilter.value;
  const categoryFilter = pomiaryCategoryFilter.value;
  let measurements = buildingFilter ? await dbGetMeasurementsByBuilding(buildingFilter) : await dbGetAllMeasurements();
  if (categoryFilter) measurements = measurements.filter((m) => m.category === categoryFilter);
  measurements.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const tbody = document.querySelector("#pomiary-table tbody");
  tbody.innerHTML = "";
  measurements.forEach((m, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${m.buildingCode}</td>
      <td>${(m.category || "").replace(/</g, "&lt;")}</td>
      <td>${(m.label || "").replace(/</g, "&lt;")}</td>
      <td>${measurementPlanSpan(m).replace(/</g, "&lt;")}</td>
      <td>${formatMeters(measurementTotal(m))}</td>
      <td>${(m.createdAt || "").replace("T", " ").slice(0, 19)}</td>
      <td class="row-actions"><a data-id="${m.id}">Pokaż/edytuj</a> · <a data-del="${m.id}">Usuń</a></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("a[data-id]").forEach((a) => {
    a.addEventListener("click", () => editMeasurementFromList(Number(a.dataset.id)));
  });
  tbody.querySelectorAll("a[data-del]").forEach((a) => {
    a.addEventListener("click", async () => {
      const id = Number(a.dataset.del);
      if (!confirm("Usunąć ten pomiar?")) return;
      await dbDeleteMeasurement(id);
      if (activeMeasurement && activeMeasurement.id === id) await closeMeasurePanel();
      await loadPomiary();
      await renderMeasurementsForPlan(currentPlanKey);
    });
  });
}

// --- Inventory tab ---
// Filtry budynku i kondygnacji sa niezalezne od tego, co jest akurat pokazane na mapie -
// zakladka Inwentaryzacja moze pokazywac "Wszystkie" budynki / "Wszystkie" kondygnacje naraz.
inventoryBuildingFilter.addEventListener("change", () => {
  populateInventoryPlanFilter();
  loadInventory();
});
inventoryPlanFilter.addEventListener("change", loadInventory);
inventoryStatusFilter.addEventListener("change", loadInventory);
inventoryLayerFilter.addEventListener("change", loadInventory);
inventoryCategoryFilter.addEventListener("change", loadInventory);

function populateInventoryBuildingFilter() {
  const current = inventoryBuildingFilter.value;
  inventoryBuildingFilter.innerHTML = '<option value="">Wszystkie</option>';
  for (const b of buildingsData) {
    const opt = document.createElement("option");
    opt.value = b.code;
    opt.textContent = b.name;
    inventoryBuildingFilter.appendChild(opt);
  }
  if (buildingsData.some((b) => b.code === current)) inventoryBuildingFilter.value = current;
}

function populateInventoryPlanFilter() {
  const buildingCode = inventoryBuildingFilter.value;
  const current = inventoryPlanFilter.value;
  inventoryPlanFilter.innerHTML = '<option value="">Wszystkie</option>';
  const relevantBuildings = buildingCode ? buildingsData.filter((b) => b.code === buildingCode) : buildingsData;
  for (const b of relevantBuildings) {
    for (const p of b.plans) {
      const opt = document.createElement("option");
      opt.value = planKeyOf(b.code, p.file);
      opt.textContent = buildingCode ? p.name : `${b.code} — ${p.name}`;
      inventoryPlanFilter.appendChild(opt);
    }
  }
  const stillValid = Array.from(inventoryPlanFilter.options).some((o) => o.value === current);
  inventoryPlanFilter.value = stillValid ? current : "";
}

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
  if (!buildingsData.length) return;
  populateInventoryBuildingFilter();
  populateInventoryPlanFilter();
  await refreshCategoryFilterOptions();
  const buildingFilter = inventoryBuildingFilter.value;
  const planKey = inventoryPlanFilter.value;
  const statusFilter = inventoryStatusFilter.value;
  const layerFilter = inventoryLayerFilter.value;
  const categoryFilter = inventoryCategoryFilter.value;
  let markers;
  if (planKey) markers = await dbGetMarkersByPlan(planKey);
  else if (buildingFilter) markers = await dbGetMarkersByBuilding(buildingFilter);
  else markers = await dbGetAllMarkers();
  if (statusFilter === "open") markers = markers.filter((m) => !m.done);
  if (statusFilter === "done") markers = markers.filter((m) => !!m.done);
  if (layerFilter) markers = markers.filter((m) => (m.layer || "inventory") === layerFilter);
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
      <td>${m.buildingCode}</td>
      <td>${m.planName}</td>
      <td>${statusCell}</td>
      <td>${layerLabel(m.layer)}</td>
      <td>${(m.category || "").replace(/</g, "&lt;")}</td>
      <td>${(m.note || "").replace(/</g, "&lt;")}</td>
      <td>${m.dueDate || ""}${m.reviewDate ? ` / kontrola: ${m.reviewDate}` : ""}</td>
      <td>${photoCell}</td>
      <td>${(m.createdAt || "").replace("T", " ").slice(0, 19)}</td>
      <td class="row-actions"><a data-id="${m.id}" data-plan="${m.planFile}">Pokaż na mapie</a></td>
    `;
    if (m.photos && m.photos.length) {
      const thumbImg = tr.querySelector("img.thumb");
      if (thumbImg) thumbImg.addEventListener("click", () => openLightbox(m.photos, 0));
    }
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
  const markers = buildingCode ? await dbGetMarkersByBuilding(buildingCode) : await dbGetAllMarkers();
  markers.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const header = ["Budynek", "Plan", "Typ", "Warstwa", "Status", "Kategoria", "Uwagi", "Termin", "Weryfikacja", "X", "Y", "Utworzono", "Zaktualizowano"];
  const lines = [header.map(csvEscape).join(";")];
  for (const m of markers) {
    const status = m.done ? "Załatwione" : "Do zrobienia";
    const symbolType = m.symbolTypeId != null ? symbolTypesData.find((t) => t.id === m.symbolTypeId) : null;
    const typeName = symbolType ? symbolType.name : "Punkt";
    lines.push(
      [m.buildingCode, m.planName, typeName, layerLabel(m.layer), status, m.category || "", m.note, m.dueDate || "", m.reviewDate || "", m.x, m.y, m.createdAt, m.updatedAt]
        .map(csvEscape)
        .join(";")
    );
  }
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, buildingCode ? `inwentaryzacja-${buildingCode}.csv` : "inwentaryzacja-wszystkie.csv");
}

exportCsvLink.addEventListener("click", (e) => {
  e.preventDefault();
  exportCsv(inventoryBuildingFilter.value || null);
});

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

// --- Nazwa urzadzenia: dokladana do nazwy pliku kopii (i do jej srodka), zeby w
// jednym, wspoldzielonym folderze kopii dalo sie rozroznic, z ktorego urzadzenia
// pochodzi dany plik. Zgadywana raz przy pierwszym starcie, potem trzymana w
// IndexedDB (meta) i edytowalna w zakladce "Kopia zapasowa".
function guessDeviceLabel() {
  const ua = navigator.userAgent || "";
  if (/iPad/i.test(ua)) return "iPad";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Telefon Android";
  if (/Windows/i.test(ua)) return "Komputer Windows";
  if (/Macintosh/i.test(ua)) return "Mac";
  return "Urządzenie";
}

async function ensureDeviceLabel() {
  let label = await dbGetMeta("deviceLabel");
  if (!label) {
    label = guessDeviceLabel();
    await dbSetMeta("deviceLabel", label);
  }
  deviceLabelInput.value = label;
  return label;
}

async function saveDeviceLabel() {
  const value = deviceLabelInput.value.trim() || guessDeviceLabel();
  deviceLabelInput.value = value;
  await dbSetMeta("deviceLabel", value);
}
deviceLabelInput.addEventListener("blur", saveDeviceLabel);
deviceLabelInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    deviceLabelInput.blur();
  }
});

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

async function buildBackupPayload() {
  const markers = await dbGetAllMarkers();
  const markerOut = [];
  for (const m of markers) {
    const photos = [];
    for (const p of m.photos || []) {
      photos.push({ image: await blobToDataUrl(p.blob), addedAt: p.addedAt });
    }
    markerOut.push({
      buildingCode: m.buildingCode,
      planFile: m.planFile,
      planName: m.planName,
      x: m.x,
      y: m.y,
      note: m.note,
      category: m.category || "",
      done: !!m.done,
      layer: m.layer || "inventory",
      dueDate: m.dueDate || "",
      reviewDate: m.reviewDate || "",
      photos,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    });
  }

  const planImages = await dbGetAllPlanImages();
  const planOut = [];
  for (const p of planImages) {
    planOut.push({
      buildingCode: p.buildingCode,
      buildingName: p.buildingName,
      file: p.file,
      name: p.name,
      sortOrder: p.sortOrder || 0,
      image: await blobToDataUrl(p.blob),
    });
  }

  const measurements = await dbGetAllMeasurements();
  const measurementOut = measurements.map((m) => ({
    buildingCode: m.buildingCode,
    category: m.category || "",
    label: m.label || "",
    points: m.points,
    segments: m.segments,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }));

  const device = (await dbGetMeta("deviceLabel")) || guessDeviceLabel();
  const reportEmails = (await dbGetMeta("reportEmails")) || "";
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    device,
    reportEmails,
    markers: markerOut,
    planImages: planOut,
    measurements: measurementOut,
  };
}

// Punkt uznajemy za juz istniejacy, jesli w tym samym budynku/planie jest juz
// wpis z dokladnie tym samym createdAt - to wystarczajaco unikalny "odcisk palca"
// (znacznik czasu utworzenia, przenoszony przez eksport/import bez zmian), zeby
// wykryc powtorny import tej samej kopii zapasowej bez ryzyka falszywych trafien.
// Akceptuje stary format (goła tablica markerow) i nowy ({markers, planImages}).
async function importBackupPayload(parsed) {
  const records = Array.isArray(parsed) ? parsed : parsed.markers || [];
  const planRecords = Array.isArray(parsed) ? [] : parsed.planImages || [];
  const measurementRecords = Array.isArray(parsed) ? [] : parsed.measurements || [];
  if (!Array.isArray(parsed) && parsed.reportEmails) await dbSetMeta("reportEmails", parsed.reportEmails);

  const existing = await dbGetAllMarkers();
  const existingKeys = new Set(existing.map((m) => `${m.buildingCode}::${m.planFile}::${m.createdAt}`));
  let imported = 0;
  let skipped = 0;
  for (const r of records) {
    const key = `${r.buildingCode}::${r.planFile}::${r.createdAt}`;
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }
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
      layer: r.layer || "inventory",
      dueDate: r.dueDate || "",
      reviewDate: r.reviewDate || "",
      done: !!r.done,
      photos,
      createdAt: r.createdAt || new Date().toISOString(),
      updatedAt: r.updatedAt || new Date().toISOString(),
    });
    existingKeys.add(key);
    imported++;
  }

  let plansImported = 0;
  for (const r of planRecords) {
    const blob = dataUrlToBlob(r.image);
    await dbPutPlanImagePreserveScale({
      key: planKeyOf(r.buildingCode, r.file),
      buildingCode: r.buildingCode,
      buildingName: r.buildingName || r.buildingCode,
      file: r.file,
      name: r.name,
      sortOrder: r.sortOrder || 0,
      blob,
    });
    plansImported++;
  }

  const existingMeasurements = await dbGetAllMeasurements();
  const existingMeasurementKeys = new Set(existingMeasurements.map((m) => `${m.buildingCode}::${m.createdAt}`));
  let measurementsImported = 0;
  let measurementsSkipped = 0;
  for (const r of measurementRecords) {
    const key = `${r.buildingCode}::${r.createdAt}`;
    if (existingMeasurementKeys.has(key)) {
      measurementsSkipped++;
      continue;
    }
    await dbAddMeasurement({
      buildingCode: r.buildingCode,
      category: r.category || "",
      label: r.label || "",
      points: r.points || [],
      segments: r.segments || [],
      createdAt: r.createdAt || new Date().toISOString(),
      updatedAt: r.updatedAt || new Date().toISOString(),
    });
    existingMeasurementKeys.add(key);
    measurementsImported++;
  }

  return { imported, skipped, plansImported, measurementsImported, measurementsSkipped };
}

// --- Zapis/odczyt kopii bezposrednio z folderu na dysku (File System Access API,
// dostepne tylko na komputerze - Chrome/Edge). Uchwyt folderu trzymany jest trwale
// w IndexedDB (store "meta"), zeby po pierwszym polaczeniu appka juz nigdy wiecej
// nie musiala pytac o folder.
const FSA_SUPPORTED = "showDirectoryPicker" in window;

async function getBackupDirHandle() {
  if (!FSA_SUPPORTED) return null;
  return await dbGetMeta("backupDirHandle");
}

async function hasDirPermission(handle, mode) {
  return (await handle.queryPermission({ mode })) === "granted";
}

async function refreshBackupDirUI() {
  if (!FSA_SUPPORTED) {
    backupDirSection.classList.add("hidden");
    return;
  }
  backupDirSection.classList.remove("hidden");
  const handle = await getBackupDirHandle();
  if (!handle) {
    backupDirInfo.textContent = "Folder na dysku: niepołączony";
    return;
  }
  const granted = await hasDirPermission(handle, "readwrite");
  backupDirInfo.textContent = granted
    ? `Folder na dysku: „${handle.name}” ✓ (auto-zapis i auto-odczyt włączone)`
    : `Folder na dysku: „${handle.name}” — kliknij przycisk, by odnowić zezwolenie`;
}

connectBackupDirBtn.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: "ibp-backup-dir", mode: "readwrite" });
    if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      alert("Brak zgody na zapis do wybranego folderu.");
      return;
    }
    await dbSetMeta("backupDirHandle", handle);
    await refreshBackupDirUI();
    await maybeAutoRestore();
  } catch (err) {
    if (err.name !== "AbortError") alert("Nie udało się połączyć folderu: " + err.message);
  }
});

async function saveBackupCopyToDir(filename, blob) {
  const handle = await getBackupDirHandle();
  if (!handle) return false;
  try {
    if (!(await hasDirPermission(handle, "readwrite"))) return false;
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    console.warn("Zapis kopii na dysku nie powiódł się:", err);
    return false;
  }
}

// Przy starcie appki, jesli lokalnie nie ma jeszcze zadnych punktow (swiezy telefon/
// przegladarka) i folder kopii jest juz polaczony z przyznanym dostepem (bez pytania
// uzytkownika o zgode - to wymagaloby gestu), wczytujemy najnowsza kopie z folderu.
async function maybeAutoRestore() {
  if (!FSA_SUPPORTED) return;
  const handle = await getBackupDirHandle();
  if (!handle) return;
  const markers = await dbGetAllMarkers();
  if (markers.length) return;
  if (!(await hasDirPermission(handle, "readwrite"))) return;

  let latestEntry = null;
  try {
    for await (const entry of handle.values()) {
      if (entry.kind === "file" && /^ibp-kopia-.*\.json$/i.test(entry.name)) {
        if (!latestEntry || entry.name > latestEntry.name) latestEntry = entry;
      }
    }
  } catch (err) {
    console.warn("Nie udało się przejrzeć folderu kopii zapasowych:", err);
    return;
  }
  if (!latestEntry) return;

  try {
    const file = await latestEntry.getFile();
    const parsed = JSON.parse(await file.text());
    const { imported, plansImported, measurementsImported } = await importBackupPayload(parsed);
    if (plansImported) await loadBuildings();
    await loadInventory();
    await loadPomiary();
    if (currentPlanKey) await renderMeasurementsForPlan(currentPlanKey);
    backupDirInfo.textContent =
      `Folder na dysku: „${handle.name}” ✓ — automatycznie przywrócono ${latestEntry.name} ` +
      `(${imported} punktów, ${plansImported} planów, ${measurementsImported} pomiarów)`;
  } catch (err) {
    console.warn("Automatyczne przywracanie kopii nie powiodło się:", err);
  }
}

exportBackupBtn.addEventListener("click", async () => {
  exportBackupBtn.disabled = true;
  try {
    const out = await buildBackupPayload();
    const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    // Znacznik czasu musi zostac PIERWSZA zmienna czescia nazwy (zaraz po stalym
    // prefiksie) - tylko wtedy proste porownanie tekstowe nazw plikow w
    // maybeAutoRestore() nadal poprawnie znajduje NAJNOWSZY plik, nawet gdy w
    // jednym, wspoldzielonym folderze ladują kopie z kilku roznych urzadzen.
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const device = sanitizeFilenamePart((await dbGetMeta("deviceLabel")) || guessDeviceLabel());
    const filename = `ibp-kopia-${stamp}-${device}.json`;
    downloadBlob(blob, filename);
    const savedToDir = await saveBackupCopyToDir(filename, blob);
    await dbSetMeta("lastExportAt", new Date().toISOString());
    await refreshBackupInfo();
    if (savedToDir) {
      const handle = await getBackupDirHandle();
      backupDirInfo.textContent = `Folder na dysku: „${handle.name}” ✓ — zapisano ${filename}`;
    }
  } finally {
    exportBackupBtn.disabled = false;
  }
});

importBackupInput.addEventListener("change", async () => {
  const file = importBackupInput.files[0];
  if (!file) return;
  const text = await file.text();
  const parsed = JSON.parse(text);
  const { imported, skipped, plansImported, measurementsImported, measurementsSkipped } = await importBackupPayload(parsed);
  importBackupInput.value = "";
  if (plansImported) await loadBuildings();
  alert(
    `Zaimportowano ${imported} punktów.` +
      (skipped ? ` Pominięto ${skipped} jako duplikaty (już istniały).` : "") +
      (plansImported ? ` Wczytano ${plansImported} planów budynków.` : "") +
      (measurementsImported ? ` Zaimportowano ${measurementsImported} pomiarów.` : "") +
      (measurementsSkipped ? ` Pominięto ${measurementsSkipped} pomiarów jako duplikaty.` : "")
  );
  if (currentPlanKey) await selectPlan(currentBuildingCode, currentPlanFile, currentPlanName);
  await loadInventory();
  await loadPomiary();
});

// --- Import planow budynkow (lokalnie, jednorazowo, mozna wiele plikow naraz) ---
importPlansInput.addEventListener("change", async () => {
  const files = Array.from(importPlansInput.files || []);
  if (!files.length) return;
  importPlansInput.disabled = true;
  const results = [];
  try {
    for (const file of files) {
      try {
        const text = await file.text();
        const records = JSON.parse(text);
        for (const r of records) {
          const blob = dataUrlToBlob(r.image);
          await dbPutPlanImagePreserveScale({
            key: planKeyOf(r.buildingCode, r.file),
            buildingCode: r.buildingCode,
            buildingName: r.buildingName || r.buildingCode,
            file: r.file,
            name: r.name,
            sortOrder: r.sortOrder || 0,
            blob,
          });
        }
        results.push({ name: file.name, ok: true, count: records.length });
      } catch (err) {
        // blad jednego pliku nie przerywa wczytywania pozostalych
        results.push({ name: file.name, ok: false, error: err.message });
      }
    }
    await loadBuildings();
  } finally {
    importPlansInput.value = "";
    importPlansInput.disabled = false;
  }

  const summary = results
    .map((r) => (r.ok ? `✓ ${r.name} — wczytano ${r.count} planów` : `✗ ${r.name} — błąd: ${r.error}`))
    .join("\n");
  alert(summary);
});

// --- Dodawanie planu wprost ze zdjecia/PDF, bez posredniego pliku JSON -
// przydatne w terenie, gdy nie ma czasu/laptopa na scripts/build-plan-bundle.ps1.
// Zapisuje bezposrednio do IndexedDB tego urzadzenia (tak jak import-plans-input),
// bez tworzenia pliku plany-<KOD>.json - ten plik sluzy tylko do przenoszenia
// planow MIEDZY urzadzeniami (patrz sekcja "Kopia zapasowa" wyzej).
//
// Przeplyw: wybor pliku -> appka od razu go "czyta" (nazwa pliku + tekst z PDF-a,
// jesli jest) i PODPOWIADA budynek/nazwe planu w polach - Robert tylko potwierdza
// albo poprawia i klika "Dodaj plan". Nic nie zapisuje sie same, dopoki nie klikniesz.
let pendingPlanBlob = null;

function refreshPlanAddCodeList() {
  planAddCodeList.innerHTML = "";
  for (const b of buildingsData) {
    const opt = document.createElement("option");
    opt.value = b.code;
    planAddCodeList.appendChild(opt);
  }
}

planAddCode.addEventListener("input", () => {
  const code = planAddCode.value.trim().toUpperCase();
  const existing = buildingsData.find((b) => b.code === code);
  if (existing) {
    planAddBuildingName.value = existing.name;
    planAddBuildingName.disabled = true;
  } else {
    planAddBuildingName.disabled = false;
  }
});

function slugifyPlanFile(name) {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ");
  return (cleaned || "plan") + ".png";
}

// \b traktuje "_" jako znak slowa, wiec nie widzi granicy w "C2_piwnica" - wlasna
// klasa znakow (bez "_") jako "nie-litera/cyfra" lapie tez separatory w plikach typu
// "C2_piętro1.png".
function looseWordBoundaryRegex(word) {
  return new RegExp("(?:^|[^a-ząćęłńóśźż0-9])" + word + "(?:[^a-ząćęłńóśźż0-9]|$)");
}

// Zgaduje kod budynku na podstawie tekstu (nazwa pliku + ewentualny tekst z PDF-a) -
// najpierw szuka samego kodu (np. "C2"), potem slow z nazwy budynku (np. "GIH" dla
// budynku o nazwie "C5 (GIH)"), zeby zlapac tez potoczne oznaczenia z dokumentow.
function guessBuildingCodeFromText(text) {
  const lower = text.toLowerCase();
  for (const b of buildingsData) {
    if (looseWordBoundaryRegex(b.code.toLowerCase()).test(lower)) return b.code;
  }
  for (const b of buildingsData) {
    const words = (b.name.toLowerCase().match(/[a-ząćęłńóśźż0-9]+/g) || []).filter(
      (w) => w.length >= 3 && w !== b.code.toLowerCase()
    );
    for (const w of words) {
      if (looseWordBoundaryRegex(w).test(lower)) return b.code;
    }
  }
  return "";
}

// Zgaduje nazwe planu (kondygnacje) po typowych slowach kluczowych PL, jakie widac
// w realnych plikach IBP: PZT/plan sytuacyjny, piwnica, przyziemie, parter, oraz
// pietro w roznych zapisach - "pietro 2", "2 pietro", "pietro II" (cyfry rzymskie,
// jak w zdjeciach z telefonu), z separatorem spacja/podkreslnik/myslnik albo bez.
function guessPlanNameFromText(text) {
  const lower = text.toLowerCase();
  if (/\bpzt\b/.test(lower) || /plan[\s_-]*sytuacyjny/.test(lower) || /zagospodarowania[\s_-]*terenu/.test(lower)) {
    return "Plan zagospodarowania terenu (PZT)";
  }
  const floorAfter = lower.match(/pi[ęe]tr[oa]?[\s_-]*(-?\d+)/);
  if (floorAfter) return `Piętro ${floorAfter[1]}`;
  const floorBefore = lower.match(/(?:^|[^a-ząćęłńóśźż0-9])(-?\d+)[\s_-]+pi[ęe]tr[oa]?\b/);
  if (floorBefore) return `Piętro ${floorBefore[1]}`;
  const romanToNumber = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
  const floorRoman = lower.match(/pi[ęe]tr[oa]?[\s_-]*\b(i{1,3}|iv|v|vi)\b/);
  if (floorRoman && romanToNumber[floorRoman[1]]) return `Piętro ${romanToNumber[floorRoman[1]]}`;
  if (/przyziemi/.test(lower)) return "Przyziemie";
  if (/piwnic/.test(lower)) return "Piwnica";
  if (/parter/.test(lower)) return "Parter";
  if (/poddasz/.test(lower)) return "Poddasze";
  return "";
}

// pdf.min.mjs jest wczytywany przez <script type="module"> w index.html, ktory
// wykonuje sie po wszystkich zwyklych <script> (w tym po tym pliku) - w praktyce
// window.pdfjsLib jest gotowe dlugo przed pierwszym kliknieciem uzytkownika, ale
// na wszelki wypadek czekamy chwile zamiast zakladac, ze juz jest.
async function getPdfjs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (window.pdfjsLib) return window.pdfjsLib;
  }
  throw new Error("Biblioteka do PDF jeszcze się nie wczytała — spróbuj ponownie za chwilę.");
}

// Renderuje 1. strone (juz otwartego) PDF-a do PNG (~200dpi, z limitem wymiaru dla
// bezpieczenstwa pamieci na telefonie - tak samo jak limit przy generowaniu raportu).
async function renderPdfPageToPngBlob(page) {
  const MAX_DIM = 4000;
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(200 / 72, MAX_DIM / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Otwiera plik (obraz albo PDF), przygotowuje PNG do zapisu i podpowiada budynek/nazwe
// planu - ale jeszcze NIC nie zapisuje do bazy. Zapis dopiero po kliknieciu przycisku.
async function prepareNewPlanFile(file) {
  pendingPlanBlob = null;
  planAddSubmitBtn.disabled = true;
  planAddStatus.textContent = "Wczytywanie…";

  try {
    let textSample = file.name;
    let statusPrefix = "";
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);

    if (isPdf) {
      const pdfjsLib = await getPdfjs();
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const page = await pdf.getPage(1);
      try {
        const content = await page.getTextContent();
        textSample += " " + content.items.map((it) => it.str).join(" ");
      } catch (err) {
        console.warn("Nie udało się odczytać tekstu z PDF-a (do podpowiedzi):", err);
      }
      pendingPlanBlob = await renderPdfPageToPngBlob(page);
      if (pdf.numPages > 1) {
        statusPrefix = `Uwaga: PDF ma ${pdf.numPages} stron, użyto tylko strony 1. `;
      }
    } else {
      pendingPlanBlob = file;
    }

    if (!planAddCode.value.trim()) {
      const guessedCode = guessBuildingCodeFromText(textSample) || currentBuildingCode || "";
      if (guessedCode) {
        planAddCode.value = guessedCode;
        planAddCode.dispatchEvent(new Event("input"));
      }
    }
    const guessedName = guessPlanNameFromText(textSample);
    if (guessedName) planAddName.value = guessedName;

    planAddStatus.textContent =
      statusPrefix + `Gotowe: „${file.name}” — sprawdź budynek i nazwę planu, potem kliknij „Dodaj plan”.`;
    planAddSubmitBtn.disabled = false;
  } catch (err) {
    console.error(err);
    planAddStatus.textContent = "Błąd: " + err.message;
    pendingPlanBlob = null;
  }
}

planAddSubmitBtn.addEventListener("click", async () => {
  if (!pendingPlanBlob) return;
  const code = planAddCode.value.trim().toUpperCase();
  const planName = planAddName.value.trim();
  if (!code || !planName) {
    alert("Podaj kod budynku i nazwę planu (np. „Piętro 1”), zanim dodasz.");
    return;
  }

  const existing = buildingsData.find((b) => b.code === code);
  const buildingName = existing ? existing.name : planAddBuildingName.value.trim() || code;
  const fileName = slugifyPlanFile(planName);
  const existingPlan = existing ? existing.plans.find((p) => p.file === fileName) : null;
  const sortOrder = existingPlan
    ? existingPlan.sortOrder
    : existing && existing.plans.length
    ? Math.max(...existing.plans.map((p) => p.sortOrder)) + 1
    : 0;

  planAddSubmitBtn.disabled = true;
  try {
    await dbPutPlanImagePreserveScale({
      key: planKeyOf(code, fileName),
      buildingCode: code,
      buildingName,
      file: fileName,
      name: planName,
      sortOrder,
      blob: pendingPlanBlob,
    });

    await loadBuildings();
    planAddStatus.textContent = `Dodano „${planName}” do budynku ${code}.`;
    planAddName.value = "";
    pendingPlanBlob = null;
  } catch (err) {
    console.error(err);
    planAddStatus.textContent = "Błąd: " + err.message;
    planAddSubmitBtn.disabled = false;
  }
});

planAddCamera.addEventListener("change", async () => {
  const file = planAddCamera.files[0];
  planAddCamera.value = "";
  if (file) await prepareNewPlanFile(file);
});

planAddFile.addEventListener("change", async () => {
  const file = planAddFile.files[0];
  planAddFile.value = "";
  if (file) await prepareNewPlanFile(file);
});

planAddFile.addEventListener("change", async () => {
  const file = planAddFile.files[0];
  planAddFile.value = "";
  if (file) await prepareNewPlanFile(file);
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
  const symbolImgCache = new Map(); // symbolTypeId -> zaladowany Image (raz na raport)
  async function loadSymbolImage(typeId) {
    if (symbolImgCache.has(typeId)) return symbolImgCache.get(typeId);
    const src = symbolIconCache.get(typeId);
    const loaded = src
      ? await new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = src;
        })
      : null;
    symbolImgCache.set(typeId, loaded);
    return loaded;
  }

  for (let idx = 0; idx < markers.length; idx++) {
    const m = markers[idx];
    const num = idx + 1;
    // Leaflet (CRS.Simple) liczy y "od dolu w gore" (jak szerokosc geograficzna),
    // a canvas/obrazek "od gory w dol" - trzeba odwrocic os Y przy przenoszeniu.
    const x = m.x * scale;
    const py = (img.naturalHeight - m.y) * scale;

    const symImg = m.symbolTypeId != null ? await loadSymbolImage(m.symbolTypeId) : null;
    if (symImg) {
      const size = radius * 3.2;
      ctx.save();
      ctx.translate(x, py);
      ctx.rotate(((m.rotation || 0) * Math.PI) / 180);
      if (m.mirrored) ctx.scale(-1, 1);
      ctx.drawImage(symImg, -size / 2, -size / 2, size, size);
      ctx.restore();
      // numer symbolu w malym kolku obok, zeby nadal dalo sie powiazac z legenda
      const bx = x + size / 2 - radius * 0.5;
      const by = py - size / 2 + radius * 0.5;
      ctx.beginPath();
      ctx.arc(bx, by, radius * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = m.done ? "#16a34a" : "#782834";
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, radius * 0.1);
      ctx.strokeStyle = "white";
      ctx.stroke();
      ctx.fillStyle = "white";
      ctx.font = `bold ${Math.round(radius * 0.65)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(num), bx, by + 1);
      continue;
    }

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
  }

  const mapImageData = canvas.toDataURL("image/jpeg", 0.85);

  if (!skipHeading) {
    if (y + 10 > pageH - margin) {
      doc.addPage();
      y = margin;
    }
    doc.setFont("PTSerif", "bold");
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
  doc.setFont("PTSerif", "bold");
  doc.setFontSize(10);
  doc.text("Legenda:", margin, y);
  y += 5;
  doc.setFont("PTSerif", "normal");
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
  doc.setFont("PTSerif", "normal");

  // pasek akcentu na gorze strony, nawiazujacy do SIW UPWr
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageW, 4, "F");

  doc.setTextColor(...BRAND);
  doc.setFont("PTSerif", "bold");
  doc.setFontSize(13);
  doc.text(`Inwentaryzacja — budynek ${buildingCode} — ${planName}`, margin, margin + 6);
  doc.setFont("PTSerif", "normal");
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
    doc.setFont("PTSerif", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...BRAND);
    doc.text(`Budynek ${building.code} — ${building.name}`, margin, margin + 8);
    doc.setFont("PTSerif", "normal");
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

async function generateWorkReport() {
  const markers = (await dbGetAllMarkers()).filter((m) => !m.done);
  if (!markers.length) {
    alert("Nie ma otwartych zadań do raportu.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  let y = 20;
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageW, 4, "F");
  doc.setFont("PTSerif", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...BRAND);
  doc.text("Draft raportu zadań ochrony przeciwpożarowej", margin, y);
  y += 7;
  doc.setFont("PTSerif", "normal");
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  doc.text(`Wygenerowano: ${new Date().toLocaleString("pl-PL")} | Liczba otwartych zadań: ${markers.length}`, margin, y);
  y += 10;
  doc.setTextColor(20, 20, 20);
  markers.sort((a, b) => (a.reviewDate || a.dueDate || "9999") .localeCompare(b.reviewDate || b.dueDate || "9999"));
  for (const m of markers) {
    const lines = doc.splitTextToSize(
      `${m.buildingCode} / ${m.planName} — ${layerLabel(m.layer)}\n` +
      `Kategoria: ${m.category || "(brak)"} | Wykonanie: ${m.dueDate || "brak"} | Weryfikacja: ${m.reviewDate || "brak"}\n` +
      `${m.note || "Brak opisu"}`,
      pageW - margin * 2 - 8
    );
    if (y + lines.length * 4.5 + 8 > pageH - margin) {
      doc.addPage();
      y = margin + 8;
    }
    doc.setDrawColor(210, 210, 210);
    doc.rect(margin, y - 4, pageW - margin * 2, lines.length * 4.5 + 6);
    doc.setFontSize(9);
    doc.text(lines, margin + 4, y);
    y += lines.length * 4.5 + 10;
  }
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `draft-raport-zadan-${dateStamp}.pdf`;
  doc.save(filename);
  const recipients = (await dbGetMeta("reportEmails")) || "";
  const subject = encodeURIComponent(`Draft zadań PPOŻ — ${dateStamp}`);
  const body = encodeURIComponent(`Dzień dobry,\n\nW załączeniu draft raportu zadań PPOŻ z dnia ${dateStamp}.\n\nLiczba otwartych zadań: ${markers.length}.\n\nRaport został pobrany jako plik PDF i należy go dołączyć do wiadomości.`);
  window.location.href = `mailto:${encodeURIComponent(recipients)}?subject=${subject}&body=${body}`;
}

workReportBtn.addEventListener("click", generateWorkReport);
saveReportSettingsBtn.addEventListener("click", async () => {
  await dbSetMeta("reportEmails", reportEmails.value.trim());
  saveReportSettingsBtn.textContent = "Zapisano odbiorców";
  setTimeout(() => (saveReportSettingsBtn.textContent = "Zapisz odbiorców"), 1800);
});

// --- Service worker + PWA install ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

// --- Start ---
(async function init() {
  await syncMigrateLegacyIds();
  await loadSymbolTypes();
  renderSymbolPalette();
  await loadBuildings();
  await ensureDeviceLabel();
  reportEmails.value = (await dbGetMeta("reportEmails")) || "";
  await refreshBackupInfo();
  await refreshBackupDirUI();
  await maybeAutoRestore();
  syncWireUi();
  syncTryFlush();
  syncPull();
})();
