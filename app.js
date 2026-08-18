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
const exportCsvLink = document.getElementById("export-csv-link");
const reportBtn = document.getElementById("report-btn");
const backupBanner = document.getElementById("backup-banner");

const markerPanel = document.getElementById("marker-panel");
const markerPanelTitle = document.getElementById("marker-panel-title");
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

function makeIcon(hasPhoto) {
  const badge = hasPhoto
    ? `<div style="position:absolute;top:-4px;right:-4px;font-size:9px;line-height:1;">📷</div>`
    : "";
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:16px;height:16px;border-radius:50%;background:#2563eb;border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,0.5);">${badge}</div>`,
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
  currentBuildingCode = buildingsData[0].code;
  await loadPlans(currentBuildingCode);
}

async function loadPlans(buildingCode) {
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
    const first = building.plans[0];
    await selectPlan(buildingCode, first.file, first.name);
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
  const marker = L.marker([m.y, m.x], { icon: makeIcon(!!(m.photos && m.photos.length)), draggable: false });
  marker.markerData = m;
  marker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    openMarkerPanel(m);
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
    photos: [],
    createdAt: now,
    updatedAt: now,
  });
  addLeafletMarker(marker);
  openMarkerPanel(marker);
}

function openMarkerPanel(m) {
  editingMarkerId = m.id;
  markerPanelTitle.textContent = `Punkt #${m.id}`;
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

async function handlePhotoFiles(input) {
  const files = Array.from(input.files || []);
  if (!files.length || editingMarkerId == null) return;
  setSaveStatus(files.length > 1 ? "Zapisywanie zdjęć…" : "Zapisywanie zdjęcia…", true);
  const id = editingMarkerId;
  let updated = null;
  for (const file of files) {
    updated = await dbAddPhotoToMarker(id, file, file.type);
  }
  input.value = "";
  if (updated && editingMarkerId === id) {
    renderPhotoGallery(updated.photos);
    setSaveStatus("Zapisano", false);
    refreshLeafletMarker(updated);
  }
}

markerPhotoCamera.addEventListener("change", () => handlePhotoFiles(markerPhotoCamera));
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

async function loadInventory() {
  if (!currentBuildingCode) return;
  const planKey = inventoryPlanFilter.value;
  const markers = planKey
    ? await dbGetMarkersByPlan(planKey)
    : await dbGetMarkersByBuilding(currentBuildingCode);
  markers.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const tbody = document.querySelector("#inventory-table tbody");
  tbody.innerHTML = "";
  markers.forEach((m, idx) => {
    const tr = document.createElement("tr");
    const photoCell = (m.photos && m.photos.length)
      ? `<img class="thumb" src="${URL.createObjectURL(m.photos[0].blob)}" alt="zdjęcie">${m.photos.length > 1 ? ` +${m.photos.length - 1}` : ""}`
      : "";
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${m.planName}</td>
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
  const header = ["Budynek", "Plan", "Uwagi", "X", "Y", "Utworzono", "Zaktualizowano"];
  const lines = [header.map(csvEscape).join(";")];
  for (const m of markers) {
    lines.push(
      [buildingCode, m.planName, m.note, m.x, m.y, m.createdAt, m.updatedAt].map(csvEscape).join(";")
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
async function generatePlanReport(buildingCode, planKey, planFile, planName) {
  const markers = await dbGetMarkersByPlan(planKey);
  markers.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (!markers.length) {
    alert("Ten rzut nie ma jeszcze żadnych punktów do raportu.");
    return;
  }

  const rec = await dbGetPlanImage(buildingCode, planFile);
  if (!rec) {
    alert("Nie znaleziono obrazka tego planu.");
    return;
  }
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
    const y = (img.naturalHeight - m.y) * scale;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#dc2626";
    ctx.fill();
    ctx.lineWidth = Math.max(2, radius * 0.15);
    ctx.strokeStyle = "white";
    ctx.stroke();
    ctx.fillStyle = "white";
    ctx.font = `bold ${Math.round(radius * 1.1)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(num), x, y + 1);
  });

  const mapImageData = canvas.toDataURL("image/jpeg", 0.85);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;

  doc.setFontSize(13);
  doc.text(`Inwentaryzacja — budynek ${buildingCode} — ${planName}`, margin, margin);
  doc.setFontSize(9);
  doc.text(`Wygenerowano: ${new Date().toLocaleString("pl-PL")}`, margin, margin + 5);

  const availW = pageW - margin * 2;
  const maxImgH = pageH * 0.55;
  const imgRatio = ch / cw;
  let imgW = availW;
  let imgH = imgW * imgRatio;
  if (imgH > maxImgH) {
    imgH = maxImgH;
    imgW = imgH / imgRatio;
  }
  const imgX = margin + (availW - imgW) / 2;
  const imgY = margin + 10;
  doc.addImage(mapImageData, "JPEG", imgX, imgY, imgW, imgH);

  let y = imgY + imgH + 10;
  doc.setFontSize(11);
  doc.text("Legenda:", margin, y);
  y += 6;
  doc.setFontSize(9);

  const THUMB = 16;
  const THUMB_GAP = 2;
  const MAX_THUMBS = 6;

  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const num = i + 1;
    const photos = m.photos || [];
    const noteLines = doc.splitTextToSize(`${num}. ${m.note || "(brak notatki)"}`, availW);
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

  doc.save(`raport-${buildingCode}-${planName}.pdf`.replace(/[\\/:*?"<>|]/g, "_"));
}

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
