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
  sampleBuildingLocation(marker.buildingCode);
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

// Cykl zycia wydarzen (markerow) - Kosz/Archiwum + prosby serwisu czekajace na
// zatwierdzenie administratora (patrz performMarkerLifecycleAction i zakladka
// Uprawnienia). "Aktywne" to widok domyslny wszedzie indziej w appce (mapa,
// inwentaryzacja, eksporty). SERVICE_MODE (app.js, ustawiane w init()) mowi,
// czy TO urzadzenie jest zgloszajacym - dla niego wlasna, jeszcze
// niezatwierdzona prosba juz oznacza "w koszu/archiwum u mnie", zgodnie z
// ustalonym modelem (u admina i innych urzadzen zostaje w pelni aktywny, dopoki
// ktos z uprawnieniami administratora nie zatwierdzi/odrzuci).
function isMarkerActive(m) {
  if (m.deletedAt || m.archivedAt) return false;
  if (m.pendingAction && SERVICE_MODE) return false;
  return true;
}
function isMarkerInTrash(m) {
  if (m.deletedAt) return true;
  return !!(m.pendingAction === "delete" && SERVICE_MODE);
}
function isMarkerInArchive(m) {
  if (m.archivedAt) return true;
  return !!(m.pendingAction === "archive" && SERVICE_MODE);
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
  // --- Znaki PN-EN ISO 7010 (grafiki: Wikimedia Commons, dane: norma) ---
  {
    name: "Wyj\u015bcie ewakuacyjne (lewostronne)",
    code: "ISO7010-E001",
    builtin: true,
    iconKind: "svg",
    svg: "<svg width=\"105.83333mm\" height=\"105.83333mm\" viewBox=\"0 0 105.83333 105.83333\" version=\"1.1\" id=\"svg1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:svg=\"http://www.w3.org/2000/svg\"> <defs id=\"defs1\" /> <g id=\"layer1\" transform=\"translate(-65.616667,-71.966666)\"> <g id=\"g7533\" transform=\"matrix(-0.26458333,0,0,0.26458333,171.45,71.966666)\"> <rect id=\"rect1662\" fill=\"#ffffff\" width=\"400\" height=\"400\" x=\"0\" y=\"0\" /> <rect id=\"rect1664\" x=\"10\" y=\"10\" fill=\"#237F52\" width=\"380\" height=\"380\" /> </g> <path id=\"path2\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke-width:0.264583\" d=\"m 148.169,80.709657 v 60.715533 c 6.31638,0.48241 10.5308,5.63536 10.5308,10.31517 v 2.4687 l -2.46869,-0.006 -8.06211,-0.0182 v 12.73893 l 6.08214,5.9854 h -40.12901 l -7.43227,-7.11934 h -9.238704 l 7.432844,7.11934 H 93.428076 l -6.08214,-5.98542 V 125.1738 h 10.66451 c 0.0833,5.9e-4 0.16247,0.004 0.24579,0.004 0.0556,0 0.0832,-0.007 0.13598,-0.008 0.0349,-5.8e-4 0.0686,-0.002 0.10294,-0.004 1.43847,-0.0274 1.750194,-0.28172 2.778784,-1.31031 l 6.24145,-7.37766 c 1.73064,3.78552 3.36138,7.00437 5.08475,10.65995 0.19459,0.37374 0.65441,1.21334 0.30951,1.86731 l -17.152864,34.63575 6.292634,-0.021 c 3.29001,0.0726 4.66137,-2.19803 5.81814,-4.23075 4.63991,-9.35178 9.30161,-18.69659 13.94909,-28.04895 l 0.87733,16.64253 c 0.22955,2.88042 2.17565,3.61243 4.72575,3.69137 l 28.81702,0.0659 c 0,-3.31243 -3.28192,-7.68712 -8.6265,-7.89482 0,0 -10.29203,0.11556 -15.67301,0.13711 -0.68225,0 -0.86922,-0.38098 -0.94846,-0.94845 -0.24993,-4.28189 -0.48763,-8.59103 -0.7533,-12.87205 -0.16632,-2.12536 -0.3528,-3.59821 -0.96949,-5.20708 -2.0106,-4.31016 -4.02228,-8.59953 -6.03491,-12.89424 l 7.36399,-0.0859 c 0.19342,-0.007 0.34356,0.0358 0.44435,0.20823 l 5.32998,9.33771 c 2.19819,4.00865 8.13833,1.08508 6.14813,-3.16681 l -6.53616,-10.93249 c -1.14949,-1.70937 -1.6747,-2.29896 -4.66145,-2.39188 0,0 -13.95626,-0.0222 -20.94497,-0.0222 v -5.8e-4 c -2.27014,-0.0504 -2.52919,0.66163 -3.61401,1.81782 -2.91625,3.5982 -6.10478,7.43502 -8.949664,10.7891 -0.3953,0.47396 -0.61745,0.67583 -1.55836,0.66796 -1.74231,-0.0292 -3.27034,0.002 -4.6188,0.0808 h -4.28821 V 80.709277 Z m -38.64915,8.33748 c -4.00109,0 -7.06757,3.07482 -7.06757,7.09658 0,4.029633 3.06678,7.103983 7.06757,7.103983 4.00049,0 7.07496,-3.07435 7.07496,-7.103983 0,-4.02205 -3.07447,-7.09658 -7.07496,-7.09658 z\" /> </g> </svg>",
  },
  {
    name: "Wyj\u015bcie ewakuacyjne (prawostronne)",
    code: "ISO7010-E002",
    builtin: true,
    iconKind: "svg",
    svg: "<svg width=\"105.83333mm\" height=\"105.83333mm\" viewBox=\"0 0 105.83333 105.83333\" version=\"1.1\" id=\"svg1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:svg=\"http://www.w3.org/2000/svg\"> <defs id=\"defs1\" /> <g id=\"layer1\" transform=\"translate(-65.616667,-71.966666)\"> <g id=\"g7533\" transform=\"matrix(0.26458333,0,0,0.26458333,65.616667,71.966666)\"> <rect id=\"rect1662\" fill=\"#ffffff\" width=\"400\" height=\"400\" x=\"0\" y=\"0\" /> <rect id=\"rect1664\" x=\"10\" y=\"10\" fill=\"#237F52\" width=\"380\" height=\"380\" /> </g> <path id=\"path2\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke-width:0.264583\" d=\"m 88.897663,80.709657 v 60.715533 c -6.316373,0.48241 -10.5308,5.63536 -10.5308,10.31517 v 2.4687 l 2.468698,-0.006 8.062102,-0.0182 v 12.73893 l -6.082136,5.9854 h 40.129013 l 7.43227,-7.11934 h 9.2387 l -7.43284,7.11934 h 11.45592 l 6.08214,-5.98542 V 125.1738 h -10.66451 c -0.0833,5.9e-4 -0.16247,0.004 -0.24579,0.004 -0.0556,0 -0.0832,-0.007 -0.13598,-0.008 -0.0349,-5.8e-4 -0.0686,-0.002 -0.10294,-0.004 -1.43847,-0.0274 -1.75019,-0.28172 -2.77878,-1.31031 l -6.24145,-7.37766 c -1.73064,3.78552 -3.36138,7.00437 -5.08475,10.65995 -0.19459,0.37374 -0.65441,1.21334 -0.30951,1.86731 l 17.15286,34.63575 -6.29263,-0.021 c -3.29001,0.0726 -4.66137,-2.19803 -5.81814,-4.23075 -4.63991,-9.35178 -9.30161,-18.69659 -13.94909,-28.04895 l -0.87733,16.64253 c -0.22955,2.88042 -2.17565,3.61243 -4.72575,3.69137 l -28.817027,0.0659 c 0,-3.31243 3.281927,-7.68712 8.626505,-7.89482 0,0 10.292026,0.11556 15.673012,0.13711 0.68225,0 0.86922,-0.38098 0.94846,-0.94845 0.24993,-4.28189 0.48763,-8.59103 0.7533,-12.87205 0.16632,-2.12536 0.3528,-3.59821 0.96949,-5.20708 2.0106,-4.31016 4.02228,-8.59953 6.03491,-12.89424 l -7.36399,-0.0859 c -0.19342,-0.007 -0.34356,0.0358 -0.44435,0.20823 l -5.32998,9.33771 c -2.198192,4.00865 -8.138332,1.08508 -6.148138,-3.16681 l 6.536168,-10.93249 c 1.14949,-1.70937 1.6747,-2.29896 4.66145,-2.39188 0,0 13.95626,-0.0222 20.94497,-0.0222 v -5.8e-4 c 2.27014,-0.0504 2.52919,0.66163 3.61401,1.81782 2.91625,3.5982 6.10478,7.43502 8.94966,10.7891 0.3953,0.47396 0.61745,0.67583 1.55836,0.66796 1.74231,-0.0292 3.27034,0.002 4.6188,0.0808 h 4.28821 V 80.709277 Z m 38.649157,8.33748 c 4.00109,0 7.06757,3.07482 7.06757,7.09658 0,4.029633 -3.06678,7.103983 -7.06757,7.103983 -4.00049,0 -7.07496,-3.07435 -7.07496,-7.103983 0,-4.02205 3.07447,-7.09658 7.07496,-7.09658 z\" /> </g> </svg>",
  },
  {
    name: "Pierwsza pomoc medyczna",
    code: "ISO7010-E003",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns:svg=\"http://www.w3.org/2000/svg\" xmlns=\"http://www.w3.org/2000/svg\" height=\"400px\" width=\"400px\" viewBox=\"0 0 200 200\" version=\"1.1\"> <g style=\"stroke:none; fill-rule:nonzero;\"> <rect style=\"fill:#ffffff;\" y=\"0\" x=\"0\" height=\"200\" width=\"200\" /> <rect style=\"fill:#237F52;\" y=\"5\" x=\"5\" height=\"190\" width=\"190\" /> <rect style=\"fill:#ffffff;\" x=\"75\" y=\"25\" width=\"50\" height=\"150\" /> <rect style=\"fill:#ffffff;\" x=\"25\" y=\"75\" width=\"150\" height=\"50\" /> </g> </svg>",
  },
  {
    name: "Miejsce zbi\u00f3rki do ewakuacji",
    code: "ISO7010-E007",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns:svg=\"http://www.w3.org/2000/svg\" xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" width=\"400px\" height=\"400px\" viewBox=\"0 0 200 200\"> <rect width=\"200\" height=\"200\" style=\"fill:#ffffff;\"/> <rect x=\"5\" y=\"5\" width=\"190\" height=\"190\" style=\"fill:#237F52\"/> <g style=\"fill:#ffffff; stroke:none;\"> <path d=\"m29.772 21.893-7.5945 7.5905 22.091 22.095h-22.08l10.065 10.065h29.682v-29.69l-10.081-10.061v22.091z\"/> <path d=\"m22.178 169.95 7.5905 7.5945 22.095-22.091v22.08l10.065-10.065v-29.682h-29.69l-10.061 10.081h22.091z\"/> <path d=\"m177.73 29.488-7.5905-7.5945-22.095 22.091v-22.08l-10.065 10.065v29.682h29.69l10.061-10.081h-22.091z\"/> <path d=\"m170.13 177.54 7.5945-7.5906-22.092-22.095h22.08l-10.065-10.065h-29.682v29.69l10.081 10.061v-22.091z\"/> <path d=\"m123.14 81.435h-12.701c-5.3996-0.15904-8.4884 3.0501-9.195 7.4104l-0.0738 19.594c0.0102 1.56 0.89469 2.9826 2.8087 2.975 1.9009-9e-3 2.7718-1.4266 2.7859-2.975v-17.981c4e-3 -0.26065 0.72981-0.47672 1.0558-0.48059 0.32944-0.0027 0.98013 0.21232 0.98365 0.48059v51.712c0.0101 1.779 1.6195 3.4194 3.8036 3.4129 2.1793-3e-3 3.7294-1.6377 3.7387-3.4129l0.0135-29.91c0.12117-0.25958 0.6984-0.40194 0.96202-0.39867 0.25936-5e-3 0.86657 0.13421 0.97838 0.39867l0.017 29.91c4e-3 1.779 1.4664 3.4194 3.6506 3.4129 2.1793-3e-3 3.8716-1.6377 3.8764-3.4129v-51.712c4e-3 -0.26065 0.66946-0.47672 0.99072-0.48059 0.32943-0.0027 1.005 0.21232 1.0086 0.48059v17.981c0.0102 1.56 0.76809 2.9826 2.6819 2.975 1.9009-9e-3 2.8973-1.4266 2.9066-2.975l-0.0748-19.594c-0.70659-4.3604-3.7957-7.5694-9.1905-7.4104\" /> <path d=\"m124.28 72.7c0-3.8268-3.1062-6.9282-6.933-6.9282-3.8282 0-6.9293 3.1012-6.9293 6.9282 0 3.8279 3.1012 6.9341 6.9293 6.9341 3.8268 0 6.933-3.1062 6.933-6.9341\" /> <path d=\"m107.03 61.505c0-3.8268-3.1062-6.9282-6.933-6.9282-3.8282 0-6.9293 3.1012-6.9293 6.9282 0 3.8279 3.1012 6.9341 6.9293 6.9341 3.8268 0 6.933-3.1062 6.933-6.9341\" /> <path d=\"m88.632 81.435h-12.701c-5.3996-0.15904-8.4884 3.0501-9.195 7.4104l-0.07382 19.594c0.01017 1.56 0.89469 2.9826 2.8087 2.975 1.901-9e-3 2.7718-1.4266 2.7859-2.975v-17.981c0.0033-0.26065 0.72981-0.47672 1.0558-0.48059 0.32943-0.0027 0.98012 0.21232 0.98365 0.48059v51.712c0.01016 1.779 1.6195 3.4194 3.8036 3.4129 2.1793-3e-3 3.7293-1.6377 3.7387-3.4129l0.01355-29.91c0.12118-0.25958 0.69841-0.40194 0.96202-0.39867 0.25935-5e-3 0.86657 0.13421 0.97837 0.39867l0.01693 29.91c0.0033 1.779 1.4664 3.4194 3.6506 3.4129 2.1793-3e-3 3.8716-1.6377 3.8764-3.4129v-51.712c0.0033-0.26065 0.66944-0.47672 0.99071-0.48059 0.32943-0.0027 1.005 0.21232 1.0086 0.48059v17.981c0.01017 1.56 0.76809 2.9826 2.6819 2.975 1.9009-9e-3 2.8973-1.4266 2.9066-2.975l-0.0748-19.594c-0.7066-4.3604-3.7957-7.5694-9.1905-7.4104\" /> <path d=\"m89.781 72.7c0-3.8268-3.1062-6.9282-6.933-6.9282-3.8282 0-6.9293 3.1012-6.9293 6.9282 0 3.8279 3.1012 6.9341 6.9293 6.9341 3.8268 0 6.933-3.1062 6.933-6.9341\" /> </g> </svg>",
  },
  {
    name: "St\u0142uc, aby uzyska\u0107 dost\u0119p",
    code: "ISO7010-E008",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"400\" height=\"400\"> <path fill=\"#fff\" d=\"M0 0h400v400H0z\"/> <path fill=\"#237F52\" d=\"M10 10h380v380H10z\"/> <path fill=\"#fff\" d=\"m277.01 168.69 2.4701 8.6452 43.538.61752-14.203 37.98-18.525-.31187 4.3226 14.827 26.247 12.35 36.128-13.28-24.701-51.26 22.536-97.268-119.8 47.243-36.44-82.753-40.762 67.627-113.63-37.363 58.364 99.738-55.582 85.841 73.802 4.6345-4.017 89.546 73.802-59.288 80.283 56.818.31188-47.86-46.937-33.97-56.818-22.542-25.012-32.111-53.73-.61754 24.707-38.292 33.963.31188 11.427-27.483c5.2457-6.9985 11.733-11.527 23.16-2.47.51147-9.6744 10.909-15.338 20.066-8.6452l8.9571 11.115c1.0292-9.6744 14.103-15.032 21.613-7.722l2.4763 3.0876c4.6282-6.7926 13.585-8.6452 19.449-1.8525z\"/> <path fill=\"#fff\" d=\"m270.84 173.02 17.908 62.681 66.698 30.57-.30564 89.858-128.77-91.398-54.341-21.925-20.384-26.247 25.012-.31188 3.0876 3.3994c4.3226 1.8525 5.252.61751 5.5576-2.782l1.235-25.936-14.82-16.055h-16.055l9.8802-21.619c1.3348-2.5699 6.6929-4.5284 8.6452-2.1582l24.083 25.936c3.3994 4.6345 12.045-.30563 8.0339-5.8633l-17.297-20.384c-2.6759-2.9815 2.0584-9.98 7.722-6.1751l26.553 29.647c1.5968.76722 3.8111.53642 5.3643-.58009 1.5594-1.1228 2.4576-3.125 1.4284-5.9069l-10.803-12.662c-3.9109-3.9109 1.7465-12.144 7.7158-7.0983l24.089 26.553c2.364 3.0876 8.1275-1.235 5.2457-4.6282l-14.203-15.444c-2.364-3.2934 1.1352-9.6744 6.7927-7.0983z\"/> </svg>",
  },
  {
    name: "Defibrylator",
    code: "ISO7010-E010",
    builtin: true,
    iconKind: "svg",
    svg: "<svg width=\"400px\" height=\"400px\" version=\"1.1\" viewBox=\"0 0 200 200\" xmlns=\"http://www.w3.org/2000/svg\"> <rect width=\"200\" height=\"200\" style=\"fill:#ffffff\"/> <rect x=\"5\" y=\"5\" width=\"190\" height=\"190\" style=\"fill:#237F52\"/> <path d=\"m132.73 36.116h47.168v15.723h-47.168zm15.723-15.723h15.723v47.168h-15.723z\" style=\"fill:#ffffff\"/> <path d=\"m56.258 65.861c-18.603 0.19378-35.268 18.7-30.23 43.116 3.7787 18.7 23.641 42.922 58.231 66.37 34.59-23.544 54.452-47.767 58.231-66.37 5.0383-24.513-11.53-42.922-30.23-43.116-9.5921-0.19378-21.607 4.9414-28.001 17.15-6.3948-12.208-18.409-17.343-28.001-17.15zm42.922 14.824-16.278 33.427h20.638l-36.14 42.05 13.952-32.943h-20.056z\" style=\"fill:#ffffff\"/> </svg>",
  },
  {
    name: "Okno ewakuacyjne z drabin\u0105 ewakuacyjn\u0105",
    code: "ISO7010-E016",
    builtin: true,
    iconKind: "svg",
    svg: "<svg width=\"105.83334mm\" height=\"105.83334mm\" viewBox=\"0 0 105.83334 105.83334\" version=\"1.1\" id=\"svg1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:svg=\"http://www.w3.org/2000/svg\"> <defs id=\"defs1\" /> <g id=\"layer1\" transform=\"translate(-51.858334,-40.745834)\"> <rect style=\"fill:#ffffff;fill-rule:nonzero;stroke:none;stroke-width:0.529167\" y=\"40.745834\" x=\"51.858334\" height=\"105.83334\" width=\"105.83334\" id=\"rect1\" /> <path style=\"fill:#237F52;fill-rule:nonzero;stroke:none;stroke-width:0.529167\" d=\"M 54.504168,43.391668 H 155.04583 V 143.93333 H 54.504168 Z\" id=\"path1\" /> <path id=\"path2-6\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke-width:0.529167;stroke-linecap:square;stroke-miterlimit:3.4;stroke-dashoffset:0.264567\" d=\"m 65.056565,51.673248 v 83.978502 h 2.002758 v -5.83524 h 18.693872 v 5.83524 h 2.003856 V 116.7865 c -0.688083,0.0105 -1.376988,-0.13783 -2.003856,-0.45044 v 11.87099 H 67.059323 v -12.4505 h 17.824325 c -0.08096,-0.0696 -0.162358,-0.13873 -0.238946,-0.21532 -0.410058,-0.41005 -0.718177,-0.88619 -0.926674,-1.39523 H 67.059323 v -12.4505 h 18.693872 v 6.64547 l 2.003856,-2.00386 V 89.648197 l -0.07141,0.07141 c -0.551624,0.55163 -1.222703,0.905597 -1.932447,1.073887 v 9.292556 H 67.059323 V 87.635552 h 1.456202 c -0.07053,-0.296701 -0.117007,-0.601866 -0.117002,-0.918433 0,-0.236019 0.02447,-0.466543 0.06427,-0.692122 h -1.40347 V 73.574496 h 18.693872 v 6.246126 l 2.003856,-2.003856 v -4.685009 c -0.806909,-0.52224 -1.490526,-1.216055 -2.003856,-2.029123 v 0.862409 H 67.059323 V 59.514545 h 18.693872 v 4.635565 c 0.513257,-0.812758 1.197218,-1.506473 2.003856,-2.028572 v -10.44829 h -2.003856 v 6.231838 H 67.059323 v -6.231838 z m 35.189435,5.29e-4 v 14.420842 c 0.35975,-0.105691 0.75092,-0.171929 1.18759,-0.171929 h 1.43478 V 54.295046 h 39.00269 v 40.886803 h -30.77414 l -2.62237,2.622375 h 36.01889 V 51.673799 Z m -8.949791,10.945955 c -2.76524,-2.3e-5 -5.006916,2.241651 -5.006895,5.006891 -2.4e-5,2.765242 2.241653,5.006919 5.006895,5.006896 2.765241,2.3e-5 5.006918,-2.241655 5.006894,-5.006896 2.1e-5,-2.765239 -2.241655,-5.006914 -5.006894,-5.006891 z m 10.137931,4.853636 c -0.7867,0 -1.717729,0.564595 -2.212042,1.07059 L 83.549942,84.216692 h -11.10086 c -1.385264,0 -2.500426,1.115168 -2.500426,2.500425 -10e-7,1.385262 1.115162,2.50043 2.500426,2.500424 H 83.779 c 0.922779,0 2.069999,0.124621 2.810783,-0.594345 l 8.815211,-8.815759 10.536726,10.537276 -20.20061,20.200607 c -1.080228,1.08023 -1.080225,2.81927 0,3.8995 1.080226,1.08023 2.819273,1.08023 3.8995,0 l 24.31598,-24.315438 3.42381,3.423808 h 7.79955 l -21.0784,-21.078945 h 7.29969 v 5.666057 l 4.63007,4.629524 c 0.23091,-0.378992 0.37078,-0.82047 0.37078,-1.29855 V 70.378653 c 0,-2.576912 -1.5216,-2.905263 -3.47049,-2.905263 z M 100.246,86.840684 v 7.007458 l 2.62237,-2.622373 v -1.762162 z\" /> </g> </svg>",
  },
  {
    name: "Okno ratunkowe",
    code: "ISO7010-E017",
    builtin: true,
    iconKind: "svg",
    svg: "<svg width=\"105.83334mm\" height=\"105.83334mm\" viewBox=\"0 0 105.83334 105.83334\" version=\"1.1\" id=\"svg1\" inkscape:version=\"1.3.2 (091e20e, 2023-11-25, custom)\" sodipodi:docname=\"Zeichnung-4.svg\" xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\" xmlns:sodipodi=\"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:svg=\"http://www.w3.org/2000/svg\"> <sodipodi:namedview id=\"namedview1\" pagecolor=\"#ffffff\" bordercolor=\"#000000\" borderopacity=\"0.25\" inkscape:showpageshadow=\"2\" inkscape:pageopacity=\"0.0\" inkscape:pagecheckerboard=\"0\" inkscape:deskcolor=\"#d1d1d1\" inkscape:document-units=\"mm\" inkscape:zoom=\"0.72426347\" inkscape:cx=\"-35.208182\" inkscape:cy=\"189.84804\" inkscape:window-width=\"1920\" inkscape:window-height=\"1009\" inkscape:window-x=\"-8\" inkscape:window-y=\"-8\" inkscape:window-maximized=\"1\" inkscape:current-layer=\"layer1\" /> <defs id=\"defs1\" /> <g inkscape:label=\"Ebene 1\" inkscape:groupmode=\"layer\" id=\"layer1\" transform=\"translate(-114.3,-98.425)\"> <g id=\"g9962\" inkscape:label=\"1\" transform=\"matrix(0.52916667,0,0,0.52916667,114.3,98.425)\"> <rect width=\"200\" height=\"200\" style=\"fill:#ffffff\" id=\"rect7890\" x=\"0\" y=\"0\" inkscape:label=\"1\" /> <rect x=\"5\" y=\"5\" width=\"190\" height=\"190\" style=\"fill:#237F52\" id=\"rect7892\" inkscape:label=\"1\" /> </g> <path id=\"path1\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke-width:3.15\" inkscape:label=\"1\" d=\"m 151.18974,119.72706 24.9468,32.87861 0.0806,0.16123 -0.59945,4.36873 7.8848,10.39161 c -0.80607,0.29804 -1.5211,0.79995 -2.07533,1.45676 h -7.54373 v 10.04951 h -25.2305 v -15.03835 h -6.69933 l -8.43101,0.53898 c -1.19769,0.10395 -1.33873,0.27995 -1.63091,0.97514 l -4.40645,10.9585 v 11.47475 c -0.008,0.2708 0.37298,0.56959 0.71262,0.56999 h 2.17971 c 0.0156,-3.98061 3.24624,-7.20284 7.23056,-7.20266 3.98408,1.8e-4 7.21394,3.2223 7.22954,7.20266 h 28.99513 c 0.0156,-3.98061 3.24571,-7.20284 7.23005,-7.20266 3.98407,1.8e-4 7.21445,3.2223 7.23005,7.20266 h 4.69119 l 4.49016,-1.56786 -0.28525,-8.12508 h -8.76639 v -2.83962 c 0.30825,-0.26135 0.58347,-0.55931 0.81959,-0.88729 l 1.5291,2.01487 4.03593,0.33744 0.1049,-0.0946 0.0196,0.0258 0.30696,-1.12706 0.009,0.0119 c 0.71605,-2.47415 1.15968,-5.02999 1.92391,-7.4905 l -37.19635,-49.02331 z m 8.18813,0.76481 5.69577,7.50652 -6.47092,-0.0336 -0.84232,-1.11053 z m -6.31848,0.16743 5.31337,0.0279 -1.32808,5.22398 z m 12.56668,8.06721 5.69526,7.50652 -6.47093,-0.0341 -0.84232,-1.11001 z m -6.31796,0.16795 5.31182,0.0279 -1.32757,5.22294 z m 12.56564,8.06617 5.69577,7.50652 -6.47092,-0.0336 -0.84284,-1.11053 z m -6.31796,0.16743 5.31285,0.0279 -1.32809,5.22449 z m 12.56564,8.0667 5.69577,7.50652 -6.47092,-0.0336 -0.84181,-1.10949 z m -6.31744,0.16794 5.31285,0.0284 -1.32809,5.22397 z m 12.56564,8.06669 5.69577,7.50704 -6.47144,-0.0346 -0.84181,-1.10949 z m -6.31796,0.16796 5.31336,0.0279 -1.32808,5.22397 z m -32.89722,5.39088 c -1.02996,0 -1.8588,0.82936 -1.8588,1.85932 v 2.25671 h 3.71812 v -2.25671 c 0,-1.02996 -0.82937,-1.85932 -1.85932,-1.85932 z m 45.46337,2.67632 5.69578,7.50652 -6.47093,-0.0341 -0.84232,-1.11001 z m -6.31847,0.16691 5.31336,0.0279 -1.32808,5.22449 z m -51.00154,5.55936 h 7.67963 c 0.32546,0.008 0.4074,0.008 0.40359,0.28887 v 7.04453 c 10e-4,0.18663 -0.0527,0.23812 -0.26148,0.27233 l -11.17451,1.23404 c -0.5783,0.0492 -0.79114,-0.50788 -0.51418,-1.09916 l 2.80138,-7.08381 c 0.21807,-0.52509 0.62351,-0.65696 1.06557,-0.6568 z m 57.24973,2.67529 5.31286,0.0279 -1.32809,5.22398 z m -52.89961,12.78015 c -3.18713,-1.5e-4 -5.77085,2.58357 -5.7707,5.77071 1.3e-4,3.18693 2.58377,5.77034 5.7707,5.77019 3.18674,-1.4e-4 5.77006,-2.58346 5.77019,-5.77019 1.6e-4,-3.18693 -2.58325,-5.77057 -5.77019,-5.77071 z m 43.3741,0 c -3.18693,1.3e-4 -5.77034,2.58377 -5.77019,5.77071 1.4e-4,3.18673 2.58346,5.77006 5.77019,5.77019 3.18694,1.5e-4 5.77057,-2.58326 5.77071,-5.77019 1.5e-4,-3.18714 -2.58357,-5.77086 -5.77071,-5.77071 z\" sodipodi:nodetypes=\"cccccccccccccccccsccscccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccssccssccccccccccccccccccccccssssssssss\" /> <path id=\"rect8\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke:none;stroke-width:0.926042;stroke-dasharray:none;stroke-opacity:1\" d=\"m 180.89232,110.09974 v 8.92504 h 1.5875 v -7.33754 h 23.14484 v 24.43055 h -18.49138 l -1.5875,1.5875 h 21.66638 v -27.60555 z m -5.46789,6.49934 a 3.0914174,3.0914174 0 0 0 -3.09128,3.09181 3.0914174,3.0914174 0 0 0 3.09128,3.09128 3.0914174,3.0914174 0 0 0 3.09129,-3.09128 3.0914174,3.0914174 0 0 0 -3.09129,-3.09181 z m 5.68183,3.02359 c -0.29287,0 -0.77637,0.17393 -1.17978,0.62632 -2.5e-4,2.8e-4 -3e-4,7.4e-4 -5.1e-4,10e-4 l -4.47622,4.48913 c -0.2235,0.20783 -0.2036,0.5464 -0.2036,0.82166 v 6.18928 h -6.00118 c -0.78814,0 -1.42266,0.63452 -1.42266,1.42265 0,0.78815 0.63452,1.42266 1.42266,1.42266 h 7.41195 c 1.40548,0 1.43453,-1.32065 1.43453,-1.62264 v -5.34647 l 5.96863,5.96863 -5.20847,5.20795 c -0.26909,0.26911 -0.43173,0.60141 -0.49144,0.94464 -0.10448,0.22582 -0.16484,0.47789 -0.16484,0.74569 v 8.55245 c 0,0.9575 0.74694,1.72858 1.67483,1.72858 0.92789,0 1.67483,-0.77108 1.67483,-1.72858 v -8.19846 l 7.5861,-7.56647 1.89653,1.89601 h 4.75526 l -12.73979,-12.70872 h 4.58009 v 3.38222 l 2.82824,2.82825 c 0.0101,-0.0685 0.017,-0.13791 0.017,-0.20929 v -7.41195 c 0,-1.40545 -1.19628,-1.43454 -1.62264,-1.43454 z m -0.21394,11.6427 v 4.65812 l 1.5875,-1.58802 v -1.4826 z\" inkscape:label=\"1\" /> </g> </svg>",
  },
  {
    name: "Ga\u015bnica",
    code: "ISO7010-F001",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:cc=\"http://creativecommons.org/ns#\" xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:svg=\"http://www.w3.org/2000/svg\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:sodipodi=\"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd\" xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\" height=\"200\" width=\"200\" version=\"1.0\" id=\"svg22\" sodipodi:docname=\"ISO_7010_F001.svg\" inkscape:version=\"1.0.2-2 (e86c870879, 2021-01-15)\"> <defs id=\"defs26\" /> <sodipodi:namedview pagecolor=\"#ffffff\" bordercolor=\"#666666\" borderopacity=\"1\" objecttolerance=\"10\" gridtolerance=\"10\" guidetolerance=\"10\" inkscape:pageopacity=\"0\" inkscape:pageshadow=\"2\" inkscape:window-width=\"1920\" inkscape:window-height=\"1001\" id=\"namedview24\" showgrid=\"false\" inkscape:zoom=\"3.7186616\" inkscape:cx=\"100\" inkscape:cy=\"100\" inkscape:window-x=\"-9\" inkscape:window-y=\"-9\" inkscape:window-maximized=\"1\" inkscape:current-layer=\"svg22\" /> <metadata id=\"metadata2\"> <rdf:RDF> <cc:Work rdf:about=\"\"> <dc:format>image/svg+xml</dc:format> <dc:type rdf:resource=\"http://purl.org/dc/dcmitype/StillImage\" /> <dc:title /> </cc:Work> </rdf:RDF> </metadata> <path d=\"m5.4189,5.423,189.16,0,0,189.15-189.16,0,0-189.15z\" fill-rule=\"evenodd\" fill=\"#9B2423\" id=\"path6\" /> <path d=\"m50,50,0-12-5,0c-16.763,17.711-15,11-15.935,25.799l-6.388,0.02405c0.323-24.823-1.677-17.823,21.782-38.958l8.541,0.135v-5h16v6c4.5631,0.1005,8.964,0.60059,13,2v9c-3.0449,0.87653-6.8647,1.3052-11,2l-0.208,10.963c10.633,3.325,17.309,7.857,17.208,19.037l-1,111h-54v-111c1.982-15.259,9.445-18.737,17-19z\" fill=\"#ffffff\" id=\"path8\" /> <path d=\"M140.84,85.974c-6.68-14.582-5.84-27.467-15.84-33.587,22.31-2.387,22.11,14.733,34.2,34.732,6.1612,10.209,9.2957,12.113,19.261,19.134-10.883,1.1136-23.49,2.7543-37.621-20.278z\" fill=\"#ffffff\" id=\"path10\" /> <path d=\"m178.22,148.83c-10.099,8.9642-25.395,7.8304-35.73,0.12286-9.0844-9.1994-13.227-19.521-28.507-22.043,24.088-14.798,35.883,7.0306,42.401,12.638,8.5275,6.854,14.675,6.4324,21.836,9.2819z\" fill=\"#ffffff\" id=\"path12\" /> <path d=\"m178.54,116.43,0,22.555c-33.72-6.9045-47.46-29.05-47.786-53.98,18.753,20.208,21.384,26.81,47.786,31.426z\" fill=\"#ffffff\" id=\"path14\" /> <path d=\"m178.4,180.29c-28.332,0.93009-42.124-5.7542-47.35-30.64,22.613,15.749,29.453,12.343,46.581,10.089,0.73556,6.7642,0.76879,13.754,0.76879,20.551z\" fill=\"#ffffff\" id=\"path16\" /> <path d=\"m177.52,73.365,0.75669,21.609c-20.65-11.003-28.25-32.075-21.28-51.974,7.0102,16.483,7.1352,23.157,20.522,30.365z\" fill=\"#ffffff\" id=\"path18\" /> <rect style=\"enable-background:accumulate;color:#000000;\" height=\"25\" width=\"40\" y=\"80\" x=\"40\" fill=\"#9B2423\" id=\"rect20\" /> </svg>",
  },
  {
    name: "Hydrant wewn\u0119trzny",
    code: "ISO7010-F002",
    builtin: true,
    iconKind: "svg",
    svg: "<svg width=\"52.916664mm\" height=\"52.916664mm\" viewBox=\"0 0 52.916664 52.916664\" version=\"1.1\" id=\"svg1\" inkscape:version=\"1.3.2 (091e20e, 2023-11-25, custom)\" sodipodi:docname=\"Zeichnung.svg\" xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\" xmlns:sodipodi=\"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:svg=\"http://www.w3.org/2000/svg\"> <sodipodi:namedview id=\"namedview1\" pagecolor=\"#ffffff\" bordercolor=\"#000000\" borderopacity=\"0.25\" inkscape:showpageshadow=\"2\" inkscape:pageopacity=\"0.0\" inkscape:pagecheckerboard=\"0\" inkscape:deskcolor=\"#d1d1d1\" inkscape:document-units=\"mm\" inkscape:zoom=\"0.72426347\" inkscape:cx=\"-47.634599\" inkscape:cy=\"4.8324956\" inkscape:window-width=\"1920\" inkscape:window-height=\"1009\" inkscape:window-x=\"-8\" inkscape:window-y=\"-8\" inkscape:window-maximized=\"1\" inkscape:current-layer=\"layer1\" /> <defs id=\"defs1\" /> <g inkscape:label=\"Ebene 1\" inkscape:groupmode=\"layer\" id=\"layer1\" transform=\"translate(-117.475,-147.10834)\"> <path d=\"m 118.79792,148.43124 h 50.27084 v 50.27084 h -50.27084 z\" fill-rule=\"evenodd\" fill=\"#9B2423\" id=\"path6\" style=\"fill:#9b2423;fill-opacity:1;stroke-width:0.264583\" inkscape:label=\"1\" /> <path id=\"path14553-3-5\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke:none;stroke-width:0.0365421px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1\" d=\"m 125.86852,154.82997 -0.95714,0.95719 v 24.74278 l 0.95714,0.95668 h 1.25302 v -26.65665 z m 16.68361,0 v 26.65665 h 1.253 l 0.95715,-0.95668 v -11.92393 h 0.68827 c 0.24447,1.49902 1.53851,2.60044 3.05726,2.60218 1.71287,6e-5 3.10144,-1.38858 3.10137,-3.10154 7e-5,-1.71297 -1.3885,-3.10161 -3.10137,-3.10155 -1.51875,0.002 -2.81279,1.10316 -3.05726,2.60218 h -0.68827 v -11.82012 l -0.95715,-0.95719 z m -13.66164,1.25255 c -0.56598,0 -1.02203,0.45556 -1.02203,1.02157 v 28.42777 h 2.04354 v -28.42777 c 0,-0.56601 -0.45553,-1.02157 -1.02151,-1.02157 z m 2.97317,0 c -0.56598,0 -1.02151,0.45556 -1.02151,1.02157 v 22.10841 c 0,0.56601 0.45553,1.02156 1.02151,1.02156 0.56598,0 1.02151,-0.45555 1.02151,-1.02156 v -22.10841 c 0,-0.56601 -0.45553,-1.02157 -1.02151,-1.02157 z m 2.97317,0 c -0.56598,0 -1.02151,0.45556 -1.02151,1.02157 v 22.10841 c 0,0.56601 0.45553,1.02156 1.02151,1.02156 0.56598,0 1.02151,-0.45555 1.02151,-1.02156 v -22.10841 c 0,-0.56601 -0.45553,-1.02157 -1.02151,-1.02157 z m 2.97317,0 c -0.56598,0 -1.02151,0.45556 -1.02151,1.02157 v 22.10841 c 0,0.56601 0.45553,1.02156 1.02151,1.02156 0.56598,0 1.02151,-0.45555 1.02151,-1.02156 v -22.10841 c 0,-0.56601 -0.45553,-1.02157 -1.02151,-1.02157 z m 2.97317,0 c -0.56598,0 -1.02151,0.45556 -1.02151,1.02157 v 22.10841 c 0,0.56601 0.45553,1.02156 1.02151,1.02156 0.56598,0 1.02203,-0.45555 1.02203,-1.02156 v -22.10841 c 0,-0.56601 -0.45605,-1.02157 -1.02203,-1.02157 z m 17.28623,3.86512 c -0.45304,1.71043 -0.58981,3.75566 -0.25954,5.50803 0.66564,2.49571 2.17535,4.43002 4.06216,6.0349 0.33296,0.29962 0.70927,0.50544 1.08328,0.69869 v -5.18671 c -1.12149,-0.17787 -1.96255,-1.18195 -2.56779,-2.06752 -1.01965,-1.57024 -1.66994,-3.28718 -2.31811,-4.98739 z m -6.46696,2.26011 c -0.25809,6.8e-4 -0.53279,0.01 -0.80766,0.0192 1.49056,1.14094 1.95508,2.8567 2.44581,4.47557 0.51166,1.77921 1.149,3.48529 2.15617,4.95675 1.88892,2.50683 4.75204,3.61288 7.55854,2.80722 -2.48282,-1.03311 -4.01109,-3.45188 -5.15426,-5.53034 -1.03631,-1.63828 -1.32962,-3.70902 -2.70949,-5.05487 -1.00982,-0.95777 -2.15742,-1.67596 -3.48911,-1.67353 z m -3.59397,3.59882 v 1.80071 h -1.80061 c 0.19716,-0.90033 0.90033,-1.60353 1.80061,-1.80071 z m 0.99919,5.3e-4 c 0.89994,0.19728 1.60283,0.90021 1.8001,1.80019 h -1.8001 z m -2.7998,2.79892 h 1.80061 v 1.80071 c -0.90028,-0.19718 -1.60345,-0.90038 -1.80061,-1.80071 z m 2.7998,0 h 1.8001 c -0.19727,0.89999 -0.90016,1.60292 -1.8001,1.80019 z m 2.99653,1.1015 c -0.17432,3.20265 0.90673,5.86631 2.84911,8.091 2.05645,2.40236 5.34247,3.62553 8.102,4.51086 v -5.18671 c -1.76536,-0.0346 -3.37342,-0.62088 -4.73019,-1.43787 -2.68185,-1.62696 -4.58614,-3.49442 -6.22092,-5.97728 z m -0.48947,8.80059 c -1.0209,-0.0478 -2.06238,0.28648 -3.22699,1.16587 2.50281,0.59607 3.67235,2.20675 5.06861,3.8864 1.1169,1.42612 2.59844,2.27397 4.23085,2.56221 2.0331,0.34221 3.96853,0.0254 5.36811,-1.47317 -3.25564,-0.57852 -5.16662,-2.58013 -7.38725,-4.40756 -1.46222,-0.97889 -2.74075,-1.67227 -4.05333,-1.73375 z m 0.47857,6.32611 c 0.29501,1.64233 0.81213,3.18555 1.74559,4.43871 2.56805,3.0273 5.90332,2.97126 9.21642,3.03043 v -5.18672 c -2.10258,0.49304 -4.67907,0.72755 -6.62735,0.25176 -1.77679,-0.36472 -3.11517,-1.41791 -4.33466,-2.53418 z m -24.1295,2.16926 0.53982,2.64838 0.48895,-0.007 0.48844,0.007 0.5393,-2.64838 h -0.0104 -2.03523 z\" sodipodi:nodetypes=\"cccccccccccccccccccccssccsssssssssssssssssssssssssssssscccccccsccccccssccccccccccccccccccccccscccccscccccccccccccc\" inkscape:label=\"1\" /> </g> </svg>",
  },
  {
    name: "Drabina po\u017carowa",
    code: "ISO7010-F003",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:cc=\"http://creativecommons.org/ns#\" xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:svg=\"http://www.w3.org/2000/svg\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:sodipodi=\"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd\" xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\" height=\"200\" width=\"200\" version=\"1.0\" id=\"svg22\" sodipodi:docname=\"ISO_7010_F003.svg\" inkscape:version=\"1.0.2-2 (e86c870879, 2021-01-15)\"> <defs id=\"defs26\" /> <sodipodi:namedview pagecolor=\"#ffffff\" bordercolor=\"#666666\" borderopacity=\"1\" objecttolerance=\"10\" gridtolerance=\"10\" guidetolerance=\"10\" inkscape:pageopacity=\"0\" inkscape:pageshadow=\"2\" inkscape:window-width=\"1920\" inkscape:window-height=\"1001\" id=\"namedview24\" showgrid=\"false\" inkscape:zoom=\"3.5855243\" inkscape:cx=\"100\" inkscape:cy=\"100\" inkscape:window-x=\"-9\" inkscape:window-y=\"-9\" inkscape:window-maximized=\"1\" inkscape:current-layer=\"svg22\" inkscape:document-rotation=\"0\" /> <metadata id=\"metadata2\"> <rdf:RDF> <cc:Work rdf:about=\"\"> <dc:format>image/svg+xml</dc:format> <dc:type rdf:resource=\"http://purl.org/dc/dcmitype/StillImage\" /> <dc:title /> </cc:Work> </rdf:RDF> </metadata> <path fill=\"#9B2423\" d=\"m5.4189,5.423,189.16,0,0,189.15-189.16,0,0-189.15z\" fill-rule=\"evenodd\" id=\"path6\" style=\"fill:#9b2423;fill-opacity:1\" /> <path style=\"color:#000000;enable-background:accumulate;\" d=\"M46.688,28.062l-12.688,144.22h7.562l1.469-16.53h50.625l1.469,16.53h7.565l-12.69-144.22h-7.562l1.031,11.563h-30.25l1.031-11.563h-7.562zm5.968,18.032h31.375l1.375,15.781h-34.125l1.375-15.781zm-1.937,22.25h35.25l1.406,15.812h-38.063l1.407-15.812zm-1.969,22.281h39.188l1.374,15.535h-41.937l1.375-15.535zm-1.938,21.965h43.063l1.281,14.75h-45.625l1.281-14.75zm-1.874,21.16h46.812l1.344,15.59h-49.5l1.344-15.59z\" fill=\"#ffffff\" id=\"path8\" /> <path id=\"path14553-3-5\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke:none;stroke-width:0.135485px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1\" d=\"m 148.98468,51.353762 c -1.67226,6.313288 -2.17756,13.862444 -0.95842,20.330533 2.45705,9.211801 8.02983,16.351235 14.99455,22.274947 1.22904,1.105905 2.61801,1.865497 3.99857,2.578816 V 77.394059 c -4.13972,-0.656524 -7.24274,-4.363172 -9.47685,-7.631888 -3.76382,-5.795834 -6.16522,-12.132857 -8.55779,-18.408409 z m -23.87127,8.341748 c -0.95267,0.0028 -1.96716,0.03649 -2.98177,0.07035 5.50202,4.211279 7.21791,10.545249 9.02933,16.520578 1.88866,6.567199 4.24165,12.863982 7.95938,18.295246 6.97248,9.252866 17.53949,13.335326 27.89897,10.361576 -9.16472,-3.81327 -14.80599,-12.741074 -19.02571,-20.41283 -3.82527,-6.046977 -4.90635,-13.689448 -9.9998,-18.657056 -3.72752,-3.535181 -7.96479,-6.186686 -12.8804,-6.177724 z m 1.48317,27.682922 c -0.64347,11.821175 3.3476,21.652498 10.51745,29.863958 7.59087,8.86726 19.71901,13.38135 29.90512,16.64919 v -19.144 c -6.5164,-0.12768 -12.45036,-2.29298 -17.45852,-5.30854 -9.89941,-6.0052 -16.92981,-12.896224 -22.96422,-22.060608 z m -13.71885,36.785858 c 9.23852,2.20011 13.55622,8.14502 18.71017,14.34471 4.12277,5.26391 9.59132,8.39406 15.61698,9.45797 7.50471,1.26311 14.64825,0.094 19.81444,-5.43712 -12.01741,-2.13538 -19.07107,-9.52512 -27.26798,-16.27027 -9.59544,-6.42339 -17.04756,-9.5145 -26.87361,-2.09529 z m 13.67939,19.04638 c 1.08898,6.06195 2.9963,11.75792 6.44195,16.38342 9.47931,11.17395 21.79075,10.96794 34.02025,11.18634 v -19.144 c -7.76116,1.81984 -17.27123,2.68549 -24.46284,0.92932 -6.55861,-1.3462 -11.49791,-5.23486 -15.99936,-9.35509 z\" sodipodi:nodetypes=\"ccccccccccccccccccccccccccccccccccccc\" /> </svg>",
  },
  {
    name: "Zestaw sprz\u0119tu ochrony przeciwpo\u017carowej",
    code: "ISO7010-F004",
    builtin: true,
    iconKind: "svg",
    svg: "<svg width=\"52.916664mm\" height=\"52.916664mm\" viewBox=\"0 0 52.916664 52.916664\" version=\"1.1\" id=\"svg1\" inkscape:version=\"1.3.2 (091e20e, 2023-11-25, custom)\" sodipodi:docname=\"Zeichnung-5.svg\" xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\" xmlns:sodipodi=\"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:svg=\"http://www.w3.org/2000/svg\"> <sodipodi:namedview id=\"namedview1\" pagecolor=\"#ffffff\" bordercolor=\"#000000\" borderopacity=\"0.25\" inkscape:showpageshadow=\"2\" inkscape:pageopacity=\"0.0\" inkscape:pagecheckerboard=\"0\" inkscape:deskcolor=\"#d1d1d1\" inkscape:document-units=\"mm\" inkscape:zoom=\"0.72426347\" inkscape:cx=\"-388.67072\" inkscape:cy=\"-234.03086\" inkscape:window-width=\"1920\" inkscape:window-height=\"1009\" inkscape:window-x=\"-8\" inkscape:window-y=\"-8\" inkscape:window-maximized=\"1\" inkscape:current-layer=\"layer1\" /> <defs id=\"defs1\" /> <g inkscape:label=\"1\" inkscape:groupmode=\"layer\" id=\"layer1\" transform=\"translate(-207.96251,-210.34375)\"> <path fill=\"#9B2423\" d=\"m 209.39654,211.77911 h 50.04859 v 50.04594 h -50.04859 z\" fill-rule=\"evenodd\" id=\"path6\" style=\"fill:#9b2423;fill-opacity:1;stroke-width:0.264583\" inkscape:label=\"1\" /> <g transform=\"matrix(0.26458333,0,0,0.26458333,208.03183,210.25887)\" fill=\"#ffffff\" id=\"g26\" inkscape:label=\"1\"> <path id=\"path14553-3-5\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke:none;stroke-width:0.137318px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1\" d=\"m 154.07169,49.866904 c -1.6949,6.398715 -2.20703,14.050021 -0.97139,20.605631 2.49029,9.336446 8.13848,16.572486 15.19745,22.576352 1.24567,1.12087 2.65343,1.890747 4.05267,2.613715 V 76.259559 c -4.19573,-0.665406 -7.34075,-4.42221 -9.60508,-7.735156 -3.81475,-5.874259 -6.24864,-12.297031 -8.67358,-18.657499 z m -24.19428,8.454623 c -0.96557,0.0029 -1.99378,0.03699 -3.02212,0.07129 5.57647,4.268263 7.31558,10.687939 9.15151,16.744123 1.91422,6.656061 4.29905,13.038049 8.06709,18.54281 7.06681,9.37807 17.77681,13.51577 28.27647,10.50179 -9.28873,-3.86487 -15.00633,-12.913494 -19.28315,-20.689052 -3.87704,-6.1288 -4.97274,-13.874688 -10.13512,-18.909515 -3.77795,-3.583016 -8.07256,-6.2704 -13.05468,-6.261315 z m 1.50324,28.057505 c -0.65217,11.981135 3.39289,21.945488 10.65976,30.268058 7.69359,8.98725 19.98583,13.56242 30.30978,16.87447 v -19.40304 c -6.60458,-0.1294 -12.61884,-2.324 -17.69476,-5.38036 -10.03336,-6.08647 -17.15889,-13.070733 -23.27495,-22.359128 z m -13.90448,37.283618 c 9.36353,2.22989 13.73965,8.25523 18.96334,14.53882 4.17855,5.33513 9.7211,8.50764 15.82829,9.58595 7.60627,1.28019 14.84646,0.0953 20.08256,-5.5107 -12.18003,-2.16427 -19.32913,-9.654 -27.63696,-16.49042 -9.72527,-6.51031 -17.27823,-9.64325 -27.23723,-2.12365 z m 13.86449,19.30411 c 1.10372,6.14397 3.03683,11.91701 6.52911,16.6051 9.60758,11.32516 22.08561,11.11635 34.48059,11.33771 v -19.40304 c -7.86618,1.84446 -17.50493,2.72182 -24.79386,0.94188 -6.64735,-1.36441 -11.65348,-5.30568 -16.21584,-9.48166 z\" sodipodi:nodetypes=\"ccccccccccccccccccccccccccccccccccccc\" inkscape:label=\"1\" /> </g> <path id=\"rect1\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke-width:1.5875\" d=\"m 225.41877,217.89215 c -1.11984,-0.0178 -1.8557,0.0956 -1.8557,0.0956 l -0.16588,2.60088 c 0,0 2.80474,-1.78526 6.76651,-0.30696 3.96177,1.4783 5.31021,7.10311 6.76496,9.22734 1.45476,2.12424 2.94246,2.1854 2.94246,2.1854 l 0.18448,-0.33228 c 0,0 -0.25842,-0.10602 -0.3855,-0.17311 -1.75098,-0.92443 -2.43547,-2.82203 -2.94297,-4.32119 -0.64889,-1.91678 -1.82703,-4.82679 -4.14032,-6.66781 -2.36882,-1.8852 -5.30164,-2.27821 -7.16804,-2.30787 z m 1.6521,2.40709 c -2.88976,0.0177 -5.03736,1.62282 -6.55981,3.55379 l -0.36483,-0.0341 -1.55236,5.10047 0.40462,0.0129 -0.0605,0.7462 c -0.8175,2.15933 -2.15566,2.64268 -2.60397,2.64222 -0.45931,-4.8e-4 -0.62776,0.22031 -0.67128,0.62425 h 25.65425 l -0.13643,-0.51005 c 0,0 -1.83856,0.19385 -3.88297,-1.49551 -2.04441,-1.68936 -3.18972,-10.19169 -9.63868,-10.62209 -0.19928,-0.0133 -0.39543,-0.0193 -0.58808,-0.0181 z m -11.59464,13.13357 v 1.48724 h 25.93278 v -1.48724 z\" inkscape:label=\"1\" /> </g> </svg>",
  },
  {
    name: "Alarm po\u017carowy",
    code: "ISO7010-F005",
    builtin: true,
    iconKind: "svg",
    svg: "<svg width=\"52.916664mm\" height=\"52.916664mm\" viewBox=\"0 0 52.916664 52.916664\" version=\"1.1\" id=\"svg2907\" inkscape:version=\"1.2.1 (9c6d41e410, 2022-07-14)\" sodipodi:docname=\"Zeichnung-1.svg\" xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\" xmlns:sodipodi=\"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:svg=\"http://www.w3.org/2000/svg\"> <sodipodi:namedview id=\"namedview2909\" pagecolor=\"#505050\" bordercolor=\"#eeeeee\" borderopacity=\"1\" inkscape:showpageshadow=\"0\" inkscape:pageopacity=\"0\" inkscape:pagecheckerboard=\"0\" inkscape:deskcolor=\"#505050\" inkscape:document-units=\"mm\" showgrid=\"false\" inkscape:zoom=\"0.76880612\" inkscape:cx=\"-213.31776\" inkscape:cy=\"2.6014361\" inkscape:window-width=\"1920\" inkscape:window-height=\"1017\" inkscape:window-x=\"-8\" inkscape:window-y=\"-8\" inkscape:window-maximized=\"1\" inkscape:current-layer=\"layer1\" /> <defs id=\"defs2904\" /> <g inkscape:label=\"Ebene 1\" inkscape:groupmode=\"layer\" id=\"layer1\" transform=\"translate(-122.21374,-147.68073)\"> <path d=\"m 123.64778,149.11609 h 50.04858 v 50.04593 h -50.04858 z\" fill-rule=\"evenodd\" fill=\"#9B2423\" id=\"path6\" style=\"fill:#9b2423;fill-opacity:1;stroke-width:0.264583\" inkscape:label=\"1\" /> <path id=\"path14553-3-5\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke:none;stroke-width:0.0371557px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1\" d=\"m 162.71015,160.39581 c -0.45861,1.73137 -0.59718,3.80166 -0.26284,5.57549 0.67383,2.52626 2.20212,4.4842 4.11214,6.10873 0.33705,0.30329 0.71797,0.5116 1.09657,0.70722 v -5.25009 c -1.13528,-0.18005 -1.98626,-1.19657 -2.59895,-2.09299 -1.03219,-1.58946 -1.69076,-3.32734 -2.3469,-5.04836 z m -6.54651,2.28766 c -0.26127,7.6e-4 -0.53948,0.01 -0.81773,0.0193 1.50889,1.15491 1.97945,2.89195 2.47622,4.53064 0.51795,1.801 1.16324,3.52785 2.1828,5.01733 1.91215,2.53753 4.81007,3.65711 7.65108,2.84158 -2.51335,-1.04576 -4.06043,-3.49414 -5.21766,-5.59806 -1.04905,-1.65834 -1.34552,-3.75423 -2.74236,-5.11655 -1.02225,-0.9695 -2.18429,-1.69666 -3.53235,-1.6942 z m 0.40674,7.59182 c -0.17646,3.24187 0.91806,5.93803 2.88433,8.18996 2.08174,2.43178 5.40779,3.66974 8.20125,4.56592 v -5.2501 c -1.78707,-0.035 -3.41441,-0.62883 -4.78786,-1.45582 -2.71484,-1.64688 -4.64287,-3.53669 -6.29776,-6.04996 z m -3.76228,10.08824 c 2.53359,0.60337 3.71768,2.23371 5.13112,3.93393 1.13063,1.44358 2.63034,2.302 4.28283,2.59378 2.05811,0.34639 4.01717,0.0258 5.43396,-1.49109 -3.29569,-0.58562 -5.23009,-2.61219 -7.47804,-4.462 -2.63147,-1.76157 -4.67516,-2.60928 -7.36987,-0.57462 z m 3.75146,5.22333 c 0.29865,1.66244 0.82171,3.22451 1.76666,4.49302 2.59963,3.06437 5.97594,3.00787 9.32979,3.06777 v -5.2501 c -2.12844,0.49908 -4.7365,0.73648 -6.70875,0.25486 -1.79864,-0.36918 -3.15321,-1.43561 -4.3877,-2.56556 z\" sodipodi:nodetypes=\"ccccccccccccccccccccccccccccccccccccc\" inkscape:label=\"1\" /> <path id=\"rect318\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke:none;stroke-width:1.265;stroke-dashoffset:2.39055;paint-order:markers stroke fill\" d=\"m 131.6018,155.52098 v 10.17612 h 2.70733 v -1.47484 h -1.23352 v -7.22747 h 7.22746 v 7.22747 h -1.60196 v 1.47484 h 3.07681 v -10.17612 z m 5.08754,2.22157 c -1.58333,-1.4e-4 -2.86663,1.28368 -2.86649,2.86701 3.2e-4,1.58301 1.28348,2.86611 2.86649,2.86597 1.58301,1.4e-4 2.8667,-1.28296 2.86701,-2.86597 1.4e-4,-1.58333 -1.28368,-2.86715 -2.86701,-2.86701 z m -0.75861,6.27042 c -0.64433,0 -1.16323,0.54775 -1.16323,1.22835 v 16.6951 c -0.18903,0.14404 -0.45188,0.30051 -0.71779,0.28991 -0.47785,-0.019 -0.43667,-0.71779 -0.43667,-0.71779 v -5.64048 c 0.0176,-0.96781 -1.2198,-1.76095 -2.11976,-1.8526 -1.21394,0.0139 -1.34049,0.98237 -1.34049,0.98237 v 8.88628 l 3.96152,7.73906 v 1.27021 h 13.20642 v -2.82619 c 0.95425,-0.43213 1.50706,-1.15639 1.52549,-2.33371 v -12.14189 c 0.0109,-0.43512 -0.50451,-0.98434 -1.2237,-1.00769 -1.11983,0.0323 -1.55725,1.50332 -1.73839,1.52342 -0.48172,-0.0242 0.68898,-3.1578 -1.89239,-3.11867 -1.36603,0.0226 -1.14958,1.39414 -1.64435,1.38751 -0.30967,0.004 -0.0382,-2.81953 -1.85828,-2.8267 -1.09886,-0.0132 -2.14664,1.48259 -2.14664,1.48259 l -0.21187,-0.19223 v -7.5985 c 0,-0.6806 -0.51839,-1.22835 -1.16272,-1.22835 z\" inkscape:label=\"1\" /> </g> </svg>",
  },
  {
    name: "Telefon alarmowania po\u017carowego",
    code: "ISO7010-F006",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:cc=\"http://creativecommons.org/ns#\" xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:svg=\"http://www.w3.org/2000/svg\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:sodipodi=\"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd\" xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\" width=\"200\" height=\"200\" version=\"1.0\" id=\"svg18\" sodipodi:docname=\"ISO_7010_F006.svg\" inkscape:version=\"1.0.2-2 (e86c870879, 2021-01-15)\"> <metadata id=\"metadata24\"> <rdf:RDF> <cc:Work rdf:about=\"\"> <dc:format>image/svg+xml</dc:format> <dc:type rdf:resource=\"http://purl.org/dc/dcmitype/StillImage\" /> </cc:Work> </rdf:RDF> </metadata> <defs id=\"defs22\" /> <sodipodi:namedview pagecolor=\"#ffffff\" bordercolor=\"#666666\" borderopacity=\"1\" objecttolerance=\"10\" gridtolerance=\"10\" guidetolerance=\"10\" inkscape:pageopacity=\"0\" inkscape:pageshadow=\"2\" inkscape:window-width=\"1920\" inkscape:window-height=\"1001\" id=\"namedview20\" showgrid=\"false\" inkscape:zoom=\"3.5855243\" inkscape:cx=\"100\" inkscape:cy=\"100\" inkscape:window-x=\"-9\" inkscape:window-y=\"-9\" inkscape:window-maximized=\"1\" inkscape:current-layer=\"svg18\" inkscape:document-rotation=\"0\" /> <path fill=\"#9B2423\" fill-rule=\"evenodd\" d=\"M5.4189 5.423h189.16v189.15H5.4189V5.423z\" id=\"path4\" style=\"fill:#9b2423;fill-opacity:1\" /> <g fill=\"#fff\" transform=\"translate(-3.53983 -5.8753451) scale(1.05373)\" id=\"g16\"> <path d=\"M93.41 168.98c6.0305-1.8156 12.238-3.7663 17.492-7.2881-8.6707-10.651-18.03-20.782-27.529-30.709-3.6261-.43813-8.2853 10.84-11.061 3.8855-5.2352-10.687-8.2145-22.293-12.381-33.412-3.0577-9.3861-6.597-18.673-8.7621-28.311 2.1705-5.8264 13.255 2.888 11.15-4.7442-2.637-12.366-5.189-24.742-7.74-37.118-9.74-.642-19.103 3.861-25.905 10.624.2098 13.629-.51421 27.311.8157 40.891 4.8418 28.01 15.232 56.329 35.917 76.583 4.3809 4.4125 9.3352 8.1808 14.164 12.078 4.68-.4204 9.289-1.3363 13.841-2.4874z\" id=\"path12\" /> <path d=\"M116.35 158.11c2.4246-1.1426 4.4134-4.3486 2.1963-6.6722-3.5803-4.5159-7.7162-8.5631-11.451-12.953-3.9843-4.5008-8.1093-8.8827-11.805-13.627-1.9078-2.4822-5.3584-.92452-7.2965.67063-2.0583 1.2783-3.45 3.7479-.8789 5.3034 8.5624 9.5502 17.214 19.031 26.187 28.198.81428.83975 2.2212-.63516 3.0484-.91937zM71.572 69.563c1.1456-.82759 2.7571-1.8064 2.687-3.4177-.40204-3.451-1.445-6.7926-2.1667-10.186-1.8608-7.6984-3.539-15.449-5.759-23.054-.40981-1.3459-.86033-3.1368-2.5919-3.1647-2.0439-.28546-4.2698-.47419-6.2183.32851-.75613 1.3593.0056 3.1251.12254 4.6366 1.5469 8.2208 3.4722 16.365 5.1678 24.556.77194 3.341 1.2785 6.7664 2.4467 9.9993.64378 1.7538 2.8584 1.1433 4.2769.9642.69913-.14456 1.3942-.3423 2.0349-.66238z\" id=\"path14\" /> </g> <path id=\"path14553-3-5\" style=\"display:inline;fill:#ffffff;fill-opacity:1;stroke:none;stroke-width:0.138277px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1\" d=\"m 153.943,49.449133 c -1.70672,6.443375 -2.22243,14.148082 -0.97816,20.749447 2.50767,9.401609 8.19528,16.688152 15.30351,22.733926 1.25436,1.128693 2.67195,1.903936 4.08096,2.631953 V 76.025995 c -4.22502,-0.670052 -7.39198,-4.453075 -9.67212,-7.789144 -3.84137,-5.915258 -6.29225,-12.382857 -8.73412,-18.787718 z m -24.36314,8.513632 c -0.9723,0.0029 -2.0077,0.03725 -3.04321,0.0718 5.61539,4.298053 7.36664,10.762535 9.21538,16.860988 1.92758,6.702516 4.32905,13.129048 8.12339,18.672222 7.11614,9.443525 17.90089,13.610105 28.47383,10.575085 -9.35356,-3.89184 -15.11107,-13.003614 -19.41773,-20.833442 -3.9041,-6.171576 -5.00745,-13.971526 -10.20586,-19.041492 -3.80433,-3.608025 -8.12891,-6.314164 -13.1458,-6.305017 z m 1.51373,28.25333 c -0.65672,12.064754 3.41658,22.098655 10.73416,30.479315 7.74729,9.04997 20.12532,13.65708 30.52133,16.99225 v -19.53847 c -6.65067,-0.1303 -12.70691,-2.34023 -17.81826,-5.41792 -10.10339,-6.12894 -17.27865,-13.161955 -23.4374,-22.515175 z m -14.00153,37.543835 c 9.42889,2.24545 13.83556,8.31285 19.0957,14.6403 4.20771,5.37236 9.78895,8.56701 15.93877,9.65285 7.65935,1.28913 14.95008,0.096 20.22272,-5.54916 -12.26503,-2.17937 -19.46403,-9.72138 -27.82984,-16.60552 -9.79316,-6.55575 -17.39883,-9.71055 -27.42735,-2.13847 z m 13.96126,19.43884 c 1.11142,6.18686 3.05803,12.00019 6.57468,16.721 9.67464,11.4042 22.23976,11.19394 34.72125,11.41684 v -19.53847 c -7.92108,1.85734 -17.6271,2.74083 -24.9669,0.94847 -6.69375,-1.37393 -11.73483,-5.34272 -16.32903,-9.54785 z\" sodipodi:nodetypes=\"ccccccccccccccccccccccccccccccccccccc\" /> </svg>",
  },
  {
    name: "Og\u00f3lny znak nakazu",
    code: "ISO7010-M001",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"265\" height=\"265\"><path d=\"M0 132.5C0 59.325 59.319 0 132.496 0 205.681 0 265 59.324 265 132.5c0 73.183-59.319 132.5-132.504 132.5C59.319 265.001 0 205.683 0 132.5\" fill=\"#005387\"/><path d=\"M148.558 216.313c0 8.857-7.201 16.058-16.054 16.058a16.07 16.07 0 0 1-16.047-16.058c0-8.85 7.197-16.047 16.047-16.047s16.054 7.197 16.054 16.047m5.349-176.987c4.611 5.188 6.876 11.422 6.209 17.032l-14.809 109.071c-1.266 8.337-6.046 13.32-12.804 13.32-6.75 0-11.534-4.982-12.789-13.255L104.896 56.398c-.696-5.642 1.519-11.844 6.083-17.01 5.592-6.335 13.637-10.112 21.523-10.112 7.811 0 15.812 3.759 21.404 10.051\" fill=\"#fff\" fill-rule=\"evenodd\"/></svg>",
  },
  {
    name: "Przeczytaj instrukcj\u0119",
    code: "ISO7010-M002",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"265\" height=\"265\" fill-rule=\"evenodd\"><path d=\"M265 132.5C265 59.322 205.679 0 132.5 0S0 59.322 0 132.5 59.322 265 132.5 265 265 205.678 265 132.5\" fill=\"#005387\"/><path d=\"M107.546 73.095c0-15.921-12.906-28.827-28.827-28.827S49.892 57.174 49.892 73.095s12.906 28.827 28.827 28.827 28.828-12.906 28.828-28.827zm134.165 53.851l-40.961 32.769-7.336-3.249c-2.19-11.378-15.097-16.983-25.636-11.353l-14.525-6.427 44.314-30.198zm-104.005 73.676a16.09 16.09 0 0 1-21.143-4.488l-25.309-34.856c-1.211-1.669-3.756.177-2.546 1.845l19.88 27.378v48.28c-25.784-7.433-49.3-21.549-68.486-48.428v-64.947a16.86 16.86 0 0 1 17.587-16.915l33.68 1.312c5.646.22 10.4 2.981 13.388 7.776l30.911 49.597 31.444-18.943c16.064-8.925 29.979 6.605 22.441 19.927a15.22 15.22 0 0 1-5.449 5.593h0zm14.244-64.854l-16.886-37.813 44.762-27.421 14.257 36.522zm-4.689-2.789l-30.694-36.684 52.402-30.651 3.627 5.632-41.521 25.457zm2.019 7.313l-22.199 7.158-14.671-23.541 18.241-5.881z\" fill=\"#fff\"/></svg>",
  },
  {
    name: "Nakaz stosowania ochrony s\u0142uchu",
    code: "ISO7010-M003",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"265\" height=\"265\"><path d=\"M0 132.499C0 59.32 59.319 0 132.5 0S265 59.321 265 132.5c0 73.184-59.32 132.5-132.5 132.5S0 205.684 0 132.499\" fill=\"#005387\"/><path d=\"M60.661 103.084c-.22-44.264 22.049-70.009 61.147-70.009h10.69 10.691c39.102 0 61.375 25.745 61.151 70.009m-139.273 8.487c0-35.992 30.188-65.162 67.431-65.162s67.436 29.17 67.436 65.162c0 14.347-12.885 67.074-14.85 73.999-7.53 26.515-23.717 45.56-52.586 45.56-28.796 0-45.29-19.26-52.71-46.009-1.887-6.797-14.721-59.203-14.721-73.55z\" fill=\"none\" stroke=\"#fff\" stroke-miterlimit=\"3.864\" stroke-width=\"7.816\"/><path d=\"M197.693 129.324c1.351-7.549 2.24-13.979 2.24-17.752 0-1.837-1.97-5.451-1.97-5.451v-21.29h12.738v18.633c18.18 6.431 24.678 16.993 21.514 32.36l-6.362 30.907c-2.556 12.413-12.148 18.793-26.373 18.793h-14.382c.898-3.174 3.948-15.399 7.054-29.232l-2.795-.889c-5.12-1.621-5.207-6.284-4.488-9.683l2.094-9.825c.691-3.252 2.72-7.791 7.928-6.994zm-124.84 26.964c3.083 13.732 6.096 25.805 6.935 28.833l.113.403H65.516c-14.222 0-23.813-6.38-26.369-18.792l-6.362-30.908c-3.165-15.367 3.334-25.929 21.514-32.36V84.832h12.737v21.288s-1.97 3.615-1.97 5.451c0 3.783.889 10.214 2.245 17.754l2.793-.422c5.213-.797 7.242 3.742 7.933 6.995l2.09 9.825c.723 3.398.636 8.061-4.49 9.683z\" fill=\"#fff\"/></svg>",
  },
  {
    name: "Nakaz stosowania ochrony oczu",
    code: "ISO7010-M004",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"265\" height=\"265\"><path d=\"M0 132.46C0 59.514 59.525 0 132.501 0 205.469 0 265 59.513 265 132.459 265 205.417 205.469 265 132.501 265 59.537 265 0 205.417 0 132.46\" fill=\"#005387\"/><path d=\"M132.509 235.575c-30.16.13-50.638-19.989-61.406-60.356-10.177 0-15.469-5.546-21.475-19.222-9.758-22.201-7.971-38.874 7.162-39.606-4.879-50.031 34.927-87.4 75.719-87.4 40.774 0 80.586 37.37 75.701 87.4 15.139.732 16.915 17.405 7.162 39.606-6.018 13.676-11.31 19.222-21.475 19.222-10.767 40.367-31.246 60.485-61.388 60.356m-7.882-8.401c-21.08-3.056-36.715-19.517-45.919-53.984l-1.563-5.853c-.867-3.493-5.859-3.186-6.909-.484-.761 2.024-7.688-1.044-13.393-14.024-4.649-10.561-5.953-18.614-5.186-23.446.584-3.676 4.018-6.395 6.301-5.168 1.215 5.994 8.602 3.522 7.865-.979l-.897-5.687 12.891 8.219-.059-6.826-13.458-8.219c-1.345-39.517 28.219-69.099 60.326-73.335 5.192-.69 10.484-.69 15.877 0 32.078 4.23 61.636 33.777 60.326 73.258l-13.593 8.295-.053 6.826 13.027-8.313-.903 5.782c-.737 4.502 6.643 6.974 7.853.979 2.289-1.227 5.735 1.493 6.307 5.168.773 4.832-.537 12.885-5.18 23.446-5.699 12.98-12.632 16.048-13.387 14.024-1.068-2.702-6.047-3.009-6.921.484l-1.563 5.853c-9.21 34.467-24.838 50.928-45.913 53.984a60.1 60.1 0 0 1-15.877 0m16.537-109.796c14.112-.808 28.614-.472 43.511 1.021l-.218 27.086c-.083 10.077-9.988 17.115-19.045 16.986l-3.965-.047c-11.67-.165-20.762-7.422-20.626-18.531zm38.591 5.469l-.183 22.591c-.059 6.661-6.956 12.26-14.089 12.154l-3.965-.053c-9.788-.142-15.9-5.912-15.818-13.587l.283-21.918c11.021-.437 22.272-.165 33.771.814m-3.015 22.567c-.035 4.726-5.257 9.44-11.222 9.351l-3.965-.053c-8.637-.124-13.086-4.997-13.015-10.72l.242-19.228c9.21-.266 18.585-.035 28.125.69zm19.835-34.721l-9.363 5.375-2.277-.23c-6.702-.667-13.31-1.109-19.841-1.316 9.794-1.681 22.496-3.328 31.482-3.829m-9.422 17.806l7.735-4.92c-.614 6.342-1.858 13.758-3.752 21.67l-4.413 3.381c.195-1.009.283-2.053.307-3.127zm-63.317-11.121c-14.107-.808-28.614-.472-43.511 1.021l.23 27.086c.083 10.077 9.971 17.115 19.033 16.986l3.965-.047c11.67-.165 20.762-7.422 20.626-18.531zm-38.597 5.469l.201 22.591c.053 6.661 6.95 12.26 14.077 12.154l3.971-.053c9.77-.142 15.906-5.912 15.8-13.587l-.277-21.918c-11.015-.437-22.272-.165-33.771.814m3.021 22.567c.035 4.726 5.257 9.44 11.222 9.351l3.959-.053c8.637-.124 13.104-4.997 13.027-10.72l-.248-19.228c-9.21-.266-18.585-.035-28.125.69zm-19.829-34.721l9.357 5.375 2.277-.23c6.69-.667 13.31-1.109 19.847-1.316-9.806-1.681-22.514-3.328-31.482-3.829m9.41 17.806l-7.723-4.92c.619 6.342 1.864 13.758 3.752 21.67l4.407 3.381a18.67 18.67 0 0 1-.295-3.127zm48.986-6.59c3.516-3.475 7.292-3.475 11.334 0v2.95h-11.334zm0 7.251c3.516-3.475 7.292-3.475 11.334 0v2.95h-11.334z\" fill=\"#fff\" fill-rule=\"evenodd\"/></svg>",
  },
  {
    name: "Og\u00f3lny znak zakazu",
    code: "ISO7010-P001",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"265\" height=\"265\" fill-rule=\"evenodd\"><path d=\"M251.75 132.5c0-65.86-53.39-119.25-119.25-119.25S13.25 66.64 13.25 132.5 66.64 251.75 132.5 251.75s119.25-53.39 119.25-119.25\" fill=\"#fff\"/><path d=\"M238.369 132.5c0-58.47-47.399-105.869-105.869-105.869a105.42 105.42 0 0 0-67.175 24.04l149.366 148.554c14.802-18.209 23.678-41.429 23.678-66.725zM50.309 65.775c-14.801 18.21-23.678 41.429-23.678 66.725 0 58.47 47.399 105.869 105.869 105.869 25.503 0 48.899-9.019 67.175-24.04zM265 132.5C265 59.322 205.678 0 132.5 0S0 59.322 0 132.5 59.322 265 132.5 265 265 205.678 265 132.5\" fill=\"#b71f2e\"/></svg>",
  },
  {
    name: "Zakaz palenia tytoniu",
    code: "ISO7010-P002",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"265\" height=\"265\"><defs><clipPath id=\"A\"><path d=\"M42.144 346.161h56.694v56.693H42.144z\"/></clipPath></defs><path d=\"M251.75 132.5c0-65.86-53.39-119.25-119.25-119.25S13.25 66.64 13.25 132.5 66.64 251.75 132.5 251.75s119.25-53.39 119.25-119.25\" fill=\"#fff\" fill-rule=\"evenodd\"/><g fill=\"none\" stroke=\"#000\" stroke-miterlimit=\"2.613\"><path d=\"M105.454 202.838l115.277-77.956-11.341-16.774-115.277 77.961\" stroke-width=\"9.4\"/><path d=\"M93.938 215.871l-16.36-24.19m25.271 18.165l-16.36-24.195\" stroke-width=\"7.383\"/></g><g clip-path=\"url(#A)\" transform=\"matrix(4.699819 0 0 -4.699819 -198.8744 1892.7827)\"><path d=\"M57.532 382.199c.653-.941.455-2.919-.486-3.507l-.617-.419c-2.249-1.367-1.34-3.733-.271-4.251.807-.39 1.409-.255 2.877-.15 1.631.116 2.158-.212 2.667-1.026.845-1.351.072-2.563-.988-3.695-.515-.548-.739-.87-.946-2.202-.137-.965-.047-2.022.738-3.137m-7.298 15.611c.641-.899.281-2.133-.556-2.862l-.544-.51c-2.005-1.703-.737-3.897.4-4.24.858-.259 1.308-.113 2.761.125 1.192.196 1.921-.166 2.429-.98.56-.899-.231-2.115-.42-3.536-.086-.65-.219-1.135-.048-1.875.066-.403.527-1.946 1.312-3.061\" fill=\"none\" stroke=\"#000\" stroke-width=\"1.429\" stroke-miterlimit=\"2.613\"/></g><path d=\"M238.369 132.5c0-58.47-47.399-105.869-105.869-105.869a105.42 105.42 0 0 0-67.175 24.04l149.366 148.554c14.802-18.209 23.678-41.429 23.678-66.725zM50.309 65.775c-14.801 18.21-23.678 41.429-23.678 66.725 0 58.47 47.399 105.869 105.869 105.869 25.503 0 48.899-9.019 67.175-24.04zM265 132.5C265 59.322 205.678 0 132.5 0S0 59.322 0 132.5 59.322 265 132.5 265 265 205.678 265 132.5\" fill=\"#b71f2e\" fill-rule=\"evenodd\"/></svg>",
  },
  {
    name: "Zakaz u\u017cywania otwartego ognia - Palenie tytoniu zabronione",
    code: "ISO7010-P003",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"265\" height=\"265\" fill-rule=\"evenodd\"><path d=\"M251.75 132.5c0-65.86-53.39-119.25-119.25-119.25S13.25 66.64 13.25 132.5 66.64 251.75 132.5 251.75s119.25-53.39 119.25-119.25\" fill=\"#fff\"/><path d=\"M83.21 158.864c-7.642 2.085-10.24-.353-13.937-3.232 2.537 11.803 10.711 17.222 17.867 18.923 8.27 1.965 14.525 2.396 17.349 9.101-.494-12.853 6.532-20.177 11.739-27.919s-2.848-23.963-11.858-25.445c-.228 5.104 3.437 8.318 2.297 15.041-2.513-4.5-4.216-15.041-21.514-15.07.368 1.841 1.26 1.791 1.853 3.294-5.493.706-11.384-3.236-13.424-9.682-4.813 15.352 4.552 28.462 9.628 34.991zm42.491 3.172c-5.2 6.091-4.098 14.222-7.853 20.99-4.591 8.274-15.402 9.125-21.877 14.033-5.872 4.45-7.541 14.472-1.659 19.739 6.453 5.778 15.727 2.589 20.396-2.848 4.361-5.079 4.143-17.564 12.288-24.569 4.863-4.182 12.685-5.384 17.29-10.779l71.012-83.183-1.434-13.809-19.348-.184zm15.685 13.531c-3.251 3.808-8.09 6.198-13.102 5.906l81.798-95.817.874 8.419zm-16.189 3.108c-1.422-4.952.089-9.722 3.08-13.226l68.141-79.836 8.153.078zm-58.688-63.416c-4.401-2.244-5.189-4.437-7.034-7.42-7.525 17.441-4.464 30.772 4.938 46.182-2.776.734-6.333.318-8.206-.568-.21 12.516 14.304 17.267 14.657 18.937l-3.906-.324c8.629 16.312 26.276 1.13 37.167 18.55 4.716.26 14.11-10.49 11.253-18.601-1.125 2.196-3.498 4.488-5.744 5.264 2.444-7.934 16.512-24.182 19.741-34.066 5.521-16.896-2.237-50.773-15.795-62.621.361 3.119.42 6.374-.018 9.855-13.942-5.47-7.743-24.803-.366-34.341-19.989 9.555-53.571 27.554-46.69 59.153\"/><path d=\"M238.369 132.5c0-58.47-47.399-105.869-105.869-105.869a105.42 105.42 0 0 0-67.175 24.04l149.366 148.554c14.802-18.209 23.678-41.429 23.678-66.725zM50.309 65.775c-14.801 18.21-23.678 41.429-23.678 66.725 0 58.47 47.399 105.869 105.869 105.869 25.503 0 48.899-9.019 67.175-24.04zM265 132.5C265 59.322 205.678 0 132.5 0S0 59.322 0 132.5 59.322 265 132.5 265 265 205.678 265 132.5\" fill=\"#b71f2e\"/></svg>",
  },
  {
    name: "Og\u00f3lny znak ostrzegawczy",
    code: "ISO7010-W001",
    builtin: true,
    iconKind: "svg",
    svg: "<svg viewBox=\"0 0 600 524\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m300 16 284 492h-568z\" fill=\"#F9A800\" stroke-linejoin=\"round\" stroke=\"#000\" stroke-width=\"32\"/><path d=\"m337 192a37 37 0 0 0-74 0l11 143a26 26 0 0 0 52 0m12 85a38 38 0 1 1 0-1\"/></svg>",
  },
  {
    name: "Niebezpiecze\u0144stwo wybuchu - Materia\u0142y wybuchowe",
    code: "ISO7010-W002",
    builtin: true,
    iconKind: "svg",
    svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"600\" height=\"525\"> <path d=\"M597.6 499.6 313.8 8c-2.9-5-8.2-8-13.9-8-5.7 0-11 3.1-13.9 8L2.2 499.6c-2.9 5-2.9 11.1 0 16 2.9 5 8.2 8 13.9 8h567.6c5.7 0 11-3.1 13.9-8 2.9-5 2.9-11.1 0-16z\"/> <path fill=\"#F9A800\" d=\"M44 491.52525977 300 50.03632646l256 441.48893331z\" overflow=\"visible\"/> <g transform=\"translate(644.96206 -315.81465) scale(1.13538)\"> <path d=\"M-435.08915 613.9898c-16.56308 4.29684-28.8125 19.34895-28.8125 37.25 0 21.24471 17.25529 38.5 38.5 38.5 12.94599 0 24.39754-6.40935 31.375-16.21875-.95903-.80793-1.98266-1.71188-2.25-2.78125-.32045-1.28182.0759-2.67405-.96875-3.71875-.8136-.8136-1.31653-1.84476-2.5625-2.15625-1.16665-.29166-3.02586-.44482-4.3125-.1875-.93305.18661-3.71875 1.29409-3.71875 0 0-1.04933.134-2.02967-.40625-2.75-.68515-.91354-3.03556.32656-3.3125-.78125-.31763-1.27052 1.3759-1.40715 2.53125-2.5625.19616-.19616-1.14196-1.35261.59375-.59375 1.33556.58392-.31623-3.17504.59375-4.3125.97957-1.22448 4.71875-2.15748 4.71875-3.71875 0-1.13328-.31466-1.64271 0-3.71875.26112-1.72275-.21361-1.36847-2.5625-.78125-.26155.0654-.70439-.86536-.96875-.8125-1.0197.20394-3.50056.89828-4.71875.59375-1.36266-.34067-1.45085-1.51002-2.5625-2.34375-1.02273-.76704-1.3299-.78124-2.75-.78125-1.65606 0-2.21864-1.46866-3.3125-2.5625-1.29245-1.29244-2.26815-1.75001-4.125-1.75-2.19453 0-4.08621.375-6.28125.375-1.23721 0-3.82274.52101-4.71875-.375-1.0717-1.0717-.92323-2.1607-.375-3.53125.49655-1.24139 1.72784-1.89315 2.15625-2.75.80845-1.61692 3.40721-1.48048 4.5-2.9375.77576-1.03435.78126-2.26734.78125-3.9375 0-1.67351-.93814-3.57379-1.9375-4.90625-.75049-1.00065-2.27343-1.45571-2.5625-1.9375-.49171-.8195-1.12658-2.50157-1.78125-3.15625-.21902-.21902-.47246-.43504-.75-.65625z\"/> <path fill-rule=\"evenodd\" d=\"M-448.64435 609.35193c1.91254 1.02983 2.89333 3.28565 1.96158 4.90395-.93175 1.6183-3.62892 1.6183-5.68858 1.56926-2.05966-.049-2.05966-.34327-2.55005-1.76542-.4904-1.42214-.98079-2.74621.58847-3.92316 1.56926-1.17695 3.77604-1.81446 5.68858-.78463zm8.82711-3.727c1.22599.68655 1.91255 2.20677 1.56927 3.33468-.34328 1.12791-1.71638 1.32407-2.94237 1.17695-1.22599-.14712-1.47118-.78463-1.96158-1.76542-.4904-.98079-.83367-1.47119 0-2.15774s2.10869-1.27502 3.33468-.58847zm25.10823 15.8888c2.30486-.44135 3.53085-1.32407 6.0809-.98079 2.55005.34328 2.01061 1.42214 4.11931 2.35389 2.1087.93175 2.3539.29424 4.31548 1.37311s3.62892 1.81446 3.53084 2.94237c-.0981 1.12791-2.15774.49039-3.92316 1.56926-1.76542 1.07887-1.6183 1.76543-3.13852 2.74622-1.52022.98079-1.52022.39231-2.94237 1.17694-1.42215.78463-1.52023 1.91254-2.74622 1.96158-1.22599.049-.68655-.68655-2.15773-1.76542-1.47119-1.07887-2.74622-2.55005-3.72701-2.55005-.98079 0-3.43276.34328-5.49242 0s-2.25582 0-2.74621-1.37311c-.4904-1.37311-.63751-2.45198.78463-4.11932 1.42215-1.66734 2.89333-1.71638 4.90395-2.55005 2.01062-.83367.83367-.34328 3.13853-.78463zm17.65422 20.79275c1.37311-2.3539 1.02983-3.77605 1.96158-5.68859.93175-1.91254-.4904-1.47119 1.76542-1.96158 2.25582-.49039 3.48181 0 7.25785 0 3.77604 0 5.29627-.29424 7.84632 0 2.55005.29424 1.71638.19616 2.35389 1.17695.63751.98079.58847 1.47118.19616 2.74621-.39232 1.27503-.73559 1.61831-1.76542 2.3539s-1.56927-.34328-2.3539.58847c-.78463.93175-1.12791 2.15774-.78463 3.13853.34328.98079 1.12791-.29424 2.15774.78463s1.96158 2.01063 1.96158 3.53085c0 1.52022-.58847 1.47118-1.96158 2.55005-1.37311 1.07887-1.12791 1.07887-3.53085 1.76542-2.40293.68655-3.2366.68655-6.08089.98079-2.84429.29424-4.31548.19616-5.29627.19616-.98079 0-3.08949.19615-5.10011-.19616s-2.01062-.0981-2.94237-1.3731c-.93175-1.27502-.98079-2.01062-.78463-3.727s.29423-1.42215 1.56926-3.13853c1.27503-1.71638 2.15774-1.3731 3.53085-3.727zm15.10416 41.78165c2.30486.78463 4.07029.63752 5.88475 2.55006 1.81446 1.91254 1.02982 3.13852 1.3731 5.1001.34327 1.96158 1.02983 2.01063 0 2.74622-1.02983.73559-2.3539.73558-4.11932.19615-1.76542-.53943-1.22599-1.22598-2.94237-2.35389-1.71638-1.12791-2.01062-1.42215-3.92316-2.15774-1.91254-.73559-2.64813.19616-3.727-.78463-1.07887-.98079-.49039-1.71638-.58847-3.13853-.0981-1.42214-.9808-1.8635.19615-2.55005 1.17695-.68655 2.55006-.29424 4.51164-.19616 1.96158.0981 1.02982-.19616 3.33468.58847zm24.80822-229.13714c1.40028-1.55837 2.58117-2.04034 4.22819-4.22818 1.64702-2.18784 1.86826-3.83486 2.35991-4.52317.49165-.68831 1.91743-3.0728 2.85157-4.91649.93414-1.84368-.12291-1.22912.88497-2.45825 1.00788-1.22912 2.6549-2.45825 3.14655-2.45825.49165 0 2.16326.73748 3.73654 1.17996 1.57328.44249 1.00788.61456 2.55657.58998 1.5487-.0246 1.99118-.29499 3.63821-.68831 1.64702-.39332 1.2537-1.27829 2.94989-.88497 1.69619.39332 2.87615 1.05705 3.83487 2.45825s.4179 1.45036 0 3.14655c-.4179 1.69619-1.37662 3.14656-1.67161 3.63821-.29499.49165-.39332 2.31075-1.17996 3.73653-.78664 1.42578-.68831.5654-1.9666 1.9666-1.27829 1.4012-2.75323 3.44154-3.14655 3.6382-.39332.19666-2.06493 1.59786-3.14656 3.14656-1.08163 1.54869-.17207 1.49952-1.17995 3.04822-1.00788 1.54869-1.22913 1.49954-2.85157 3.14656s-2.16325 1.74535-3.6382 3.44154c-1.47495 1.69619-.76206 2.55658-2.26159 3.34322-1.49953.78664-2.75324 0-3.73653-.19666-.9833-.19666-3.24489-2.45825-3.53988-2.85157-.29499-.39332-1.86827-2.6549-2.16326-3.04822-.29498-.39332-1.76993-2.9499-1.96659-3.34322-.19666-.39332-.78664-3.44154-.39332-3.93319.39332-.49165 2.53107-2.81208 2.6549-2.9499zm72.56743-1.17995c1.89285-.36874 3.93319-1.08163 4.22818-1.47495.29499-.39332.93414-1.32745 2.16326-2.16326 1.22913-.8358.86039-1.15538 2.75324-1.17996 1.89285-.0246 3.41696 0 4.81816 1.08163 1.4012 1.08163.51623 1.79453.78664 3.24489.27041 1.45036-.17207 1.20454.29499 2.55657.46707 1.35204 1.74535 1.32746 1.57327 2.85157s-1.6716 2.75323-2.26158 3.24488c-.58998.49165-1.67161 1.57328-2.85157 3.24489-1.17996 1.67161-1.27829 2.94989-1.86826 3.44154-.58998.49165-2.85157 2.45825-3.44155 2.65491-.58998.19666-2.94989 2.35992-3.73653 2.85156-.78664.49165-1.84369 1.91743-3.53988 3.14656-1.69619 1.22912-2.6549 1.76994-3.24488 1.76994-.58998 0-2.85157.39332-3.83487.0983-.98329-.29499-1.57327-.9833-2.55657-.9833-.9833 0-2.55658-.39332-3.24489-.78664s-1.47495-2.06493-1.96659-2.45825c-.49165-.39332-.88497-3.04822-1.17996-3.53987-.29499-.49165-.39332-2.06493-.39332-2.85157 0-.78664.39332-2.35991.88497-3.14655.49165-.78664.78664-.88497 1.27828-2.35992.49165-1.47495 1.37662-3.04822 1.47495-3.6382.0983-.58998 1.76994-2.45825 2.26159-2.85157.49165-.39332 1.76994-1.57328 2.16326-2.06492.39332-.49165 1.72077-.61456 3.24488-.78664 1.52411-.17208 2.16326.0983 2.85157.0983s1.45036.36874 3.34321 0zm18.58434 131.36867c2.85156-1.49953 5.01483-2.60574 8.94802-4.42484 3.9332-1.8191 6.19478-2.85157 6.78476-2.85157.58998 0 2.31075.66373 4.22818 2.06493 1.91743 1.4012 2.58116 2.11409 3.44155 3.53987.86039 1.42578.12291.66373 0 2.16326s.49165 2.21242-.49165 3.83486-3.04823 2.45825-3.44155 2.65491c-.39332.19666-.49164 2.33534-2.35991 3.04823-1.86827.71289-3.24489.19666-5.11316-.19666-1.86827-.39332-1.76993-1.47495-2.35991-1.37662-.58998.0983-3.73654.9833-4.52318.9833-.78663 0-2.55657.78664-3.93319.88496-1.37662.0983-2.75323-1.30287-4.22818-2.75323-1.47495-1.45036-1.76994-2.65491-1.67161-3.04823.0983-.39332 1.08163-1.8191 2.26159-2.94989s-.39333-.0737 2.45824-1.57328zm-39.92192 81.51544c1.88265.82741 3.19573 1.30287 5.21149 2.35992 2.01576 1.05705 2.33533.76206 2.85156 1.86827.51623 1.10621 1.2537 1.79451-.78664 2.55657-2.04035.76206-6.29311.58998-7.37474.49165-1.08162-.0983-4.32651-.54081-6.09645-1.76993s-.78663-2.55658-.98329-3.14656c-.19666-.58998-.29499-3.04823.0983-3.04823.39331 0 2.16326.4179 3.93319.58998 1.76993.17208 1.16975-.77046 3.14655.0983zm21.04259-4.6215c2.1608-.4549 4.57234-.0738 8.06305-.19666 3.49071-.12291 5.21148-.29499 5.89979-.29499.68831 0 7.47307.39332 8.25971.49165.78664.0983 1.03246 1.27829 2.75323 2.45825 1.72077 1.17996 2.21243 1.05704 4.12986 2.26158s2.6549 1.27829 3.53987 2.55658.27041 1.25371 0 2.55658c-.27041 1.30287.29499 1.79452-1.08163 2.6549-1.37662.86039-2.75323.9833-4.42484.78664-1.67161-.19666-8.35804-1.27829-9.04635-1.27829-.68831 0-8.16137-.49165-8.94801-.39332-.78664.0983-5.11315-.19666-5.50647-.19666-.39332 0-2.28617.0492-3.53988-.78664-1.25371-.8358-1.30287-1.27828-1.47495-2.55657-.17208-1.27829.78664-2.06493.78664-2.55658 0-.49165-.19666-2.35991-.68831-2.94989-.49165-.58998 1.10375-2.51983 1.27829-2.55658zm10.32464 47.68997c.88496-.49165-3.53987-3.39238-6.5881-5.50647-3.04823-2.11409-4.03153-1.94201-5.60481-2.94989-1.57328-1.00788-1.2537 0-.6883-1.08163s1.8191-1.8191 2.94989-3.24488c1.13079-1.42578-.68831-2.23701 1.57328-2.45825 2.26159-.22124 1.17996.22125 7.47307 1.57328 6.29311 1.35204 9.6609 1.52411 17.69937 3.83486 8.03847 2.31075 14.06117 5.30981 14.45449 5.40814.39332.0983 11.2096 4.52318 11.2096 4.52318l-42.47849-.0983zm-128.70206-155.43017c-2.15266 8.96109-2.35291 1.7772-5.00619 1.90236-2.65328.12516-5.20644-1.20149-5.60694-1.40174-.4005-.20024-3.10384-2.00247-3.60446-2.30285-.50062-.30037-2.1026-1.80223-2.5031-2.80347-.40049-1.00123-.50062-4.10508-.70087-4.80594-.20024-.70087-.70086-3.05378-.20024-4.90607.50062-1.85229.90111-1.15142 2.20272-2.5031 1.30161-1.35167 1.85229-1.40174 3.00372-2.9036s1.60198-2.70334 1.60198-3.10384c0-.40049-.90111-5.10632-1.00124-5.60694-.10012-.50061-.70086-2.30285-.90111-3.20396-.20025-.90112.67583-2.12763 2.20272-2.80347 1.52689-.67584 2.72838.3254 3.90484.10012 1.17646-.22528.70086-.60074.80099-1.00123.10012-.4005.57571-1.20149 2.40297-.90112 1.82726.30037 3.1539 1.52689 4.90607 2.1026 1.75217.57571 2.47807-8.33531 2.10261.20025-.37546 8.53556-1.4518 24.98091-3.60447 33.942zm22.82826-15.11871c0-.50061-1.22652-2.428-.90112-4.50557.3254-2.07757.70087-1.97745 2.20273-3.80471 1.50186-1.82726 2.20272-2.02751 3.8047-3.50434 1.60198-1.47683 1.2015-1.90235 2.60323-2.40297 1.40173-.50062 1.85229-.22527 3.00371.4005 1.15142.62577 1.02628.7259 1.60199 2.1026.57571 1.3767.85105 2.22776.70086 3.40421-.15019 1.17645-1.00124.90112-1.30161 1.30161-.30037.4005-1.15143 1.70211-1.30161 3.50434-.15018 1.80223.52565 2.02751.70087 3.70458.17522 1.67708.67584 1.95242 0 3.00372s-1.90235.90111-2.70335 1.20149c-.80099.30037-4.00495.90111-4.6057.60074-.60074-.30037-2.30285-1.60198-2.50309-2.00248-.20025-.40049-1.30161-2.90359-1.30161-3.00372zm1.90235 14.6181c1.42676 1.20149 1.80223 4.10508 1.40173 4.2052-.40049.10012-.80099 2.20273-1.80223 2.30285-1.00123.10012-2.90359.40049-3.40421.40049-.50062 0-2.12764.25032-3.00372-.50061-.87609-.75093-.60074-1.50186-.50062-2.5031.10013-1.00124.4005-2.70335.50062-3.10384.10013-.4005.80099-1.20149 2.5031-1.40174 1.70211-.20025 2.87856-.60074 4.30533.60075zm-60.87534 38.44758c1.40173 4.13011-.87608 1.95241-2.20272 3.50433-1.32664 1.55192-2.70335 2.70335-3.10384 2.70335-.4005 0-1.50186.60074-2.20273.60074-.70087 0-1.40174.17522-2.5031-.60074s-1.30161-1.50186-1.90235-2.5031-1.50186-2.70335-2.00248-3.40421c-.50062-.70087-1.90235-2.20273-2.30285-2.9036-.4005-.70086-.60074-1.80223-.4005-2.70334.20025-.90112 1.40174-1.90236 2.10261-2.40298.70086-.50061 2.20272-1.50185 2.80347-2.00247.60074-.50062 1.60198-.90112 2.1026-1.50186.50062-.60075-.60074-4.6057 1.80223-1.80223s6.40793 8.886 7.80966 13.01611zm62.47732-8.71078c1.71317-.85659 1.52689 1.3767 2.9036 2.40297 1.3767 1.02627 1.80223 1.00124 2.60322 1.70211.80099.70086 1.42676 2.32788 1.80223 4.2052.37547 1.87732-.30037 2.90359-.30037 3.30409 0 .40049.70086 1.80223 1.60198 1.40173.90111-.40049 2.1026-.50062 2.20272-1.20148.10013-.70087 1.40174-2.9036 1.40174-3.30409 0-.4005.20025-1.80223.40049-2.40298.20025-.60074.4005-1.60198 1.00124-2.20272.60075-.60075 1.30161-1.80223 2.20273-1.90236.90111-.10012 3.30409.20025 3.70458.20025.4005 0 1.60199 1.10136 1.70211 1.50186.10012.4005.4005 1.50186.50062 2.20273.10012.70086 0 2.00247 0 2.50309 0 .50062-1.00124 2.60323-1.40173 2.80347-.4005.20025-2.00248 1.90236-2.70335 2.10261-.70087.20024-1.00124.40049-2.00248.70086s-2.60322 1.20149-3.10384 1.80223c-.50062.60075-.6508 1.22652-1.40173 2.40298-.75093 1.17646-1.20149 1.90235-1.60199 2.30285-.40049.40049-1.40173 2.20272-1.90235 2.40297-.50062.20025-2.5031.30037-3.30409-.10012-.80099-.4005-.60074-.60075-1.50186-1.20149-.90111-.60074-1.7021-1.40173-2.80347-1.40173-1.10136 0-2.1026-.20025-3.40421-.20025-1.30161 0-1.70211-.4005-3.10384-.50062-1.40174-.10013-1.67708-.12516-2.5031-.20025-.82602-.0751-.60074.30037-.80099-.10012-.20025-.4005.22528-3.50434 1.70211-6.80843 1.47683-3.30409 3.8047-5.20644 4.2052-6.40793.4005-1.20149 3.81577-5.9629 3.90483-6.00743zm-48.96059-1.70211c.3204-.0801 4.73085.20025 9.81214.20025 5.08129 0 7.78463.60074 10.51301-.20025 1.82726 6.90855-2.80346 27.93457-3.20396 27.83445-.4005-.10013-5.90731-1.50186-7.50929-2.00248-1.60199-.50062-4.50558.50062-4.6057-1.60198-.10013-2.10261-5.0863-24.20997-5.0062-24.22999zm45.45626 24.83073c1.0127.0608 2.55316-.15018 3.90483.70087s1.3767 1.65204 1.50186 2.70334c.12515 1.0513-.30038 1.00124-1.00124 1.50186-.70087.50062-1.80223 1.10136-4.00496 1.00124-2.20272-.10012-2.12763.12515-3.20396-.20025s-1.10137-.10012-1.10137-1.10136-1.10136-.60074 0-1.80223c1.10137-1.20149.82602-1.20149 1.80223-1.90236.97621-.70087.61222-.99054 2.10261-.90111zm35.84435 6.3078c1.67707.67584 2.12764.92616 3.70459 1.80224 1.57695.87609 1.7772.72589 2.60322 1.7021.82602.97621 1.15143 1.37671.70087 2.20273-.45056.82602-1.70211 1.10136-2.5031 1.10136-.80099 0-2.70335-.20025-3.50434-.30037-.80099-.10012-3.8047-.10012-4.2052-.30037-.4005-.20025-1.60198-.70087-2.70335-1.00124-1.10136-.30037-2.20272.30037-2.40297-.90112-.20025-1.20148-.20025-1.90235-.20025-2.50309 0-.60075-.90111-1.40174.4005-2.00248 1.30161-.60075 1.90235-1.20149 2.60322-1.10137.70087.10013 1.1264.0751 2.5031.4005 1.3767.3254 1.32663.22527 3.00371.90111zm7.31833-80.95156c1.16415-1.01171 2.07885-2.18971 3.82508-3.49246 1.74623-1.30275 2.55006-1.77395 3.15985-1.71852.6098.0554 1.15029.62366 1.88482 1.27503.73453.65137.55437.41577 1.05329 1.33046.49892.91469.7761 1.20573.94241 2.32831.16631 1.12258-.0554 2.16201-.27718 2.16201-.22174 0-1.60764.83153-1.88482.94241-.27718.11087-1.60765 2.162-1.9957 2.27287-.38805.11087-.81768.2356-1.60764.94241-.78996.70681-1.33046 1.77395-1.55221 1.88483-.22174.11087-1.3859 1.33046-1.82938 1.38589-.44349.0554-.99785.38806-1.55221.0554-.55436-.33262-.66523-.27718-1.21959-1.05328-.55436-.77611-.27718.0554-1.10872-1.27503-.83154-1.33046-1.82939-.83154-1.55221-2.60549.27718-1.77395.16631-2.21744.83154-2.7718s1.33046-.69295 2.05113-1.10872c.72067-.41577-.33262.45735.83154-.55436zm-39.39756 133.06257c.79769.30681 6.42656 1.8162 7.05524 1.88605.62869.0699 3.21328 1.67649 3.84197 1.74635.62868.0698 5.51845 2.51474 6.07729 2.79415.55883.27942 1.8162 1.81621 2.16547 2.02577.34927.20956.78585 2.16546.69853 3.35298-.0873 1.18752 0 1.25737-1.0478 1.39708-1.04781.13971-2.37504 1.06527-3.70226 1.46693-1.32723.40166.0699-.1397-1.60664.13971-1.67649.27942-2.93386.48898-3.98167.13971-1.04781-.34927-2.02576-.62869-3.28313-.83825-1.25737-.20956-5.93758-1.88605-7.47437-2.93386-1.53679-1.04781-4.61036-2.37503-5.02948-2.86401-.41912-.48898-2.37503-2.02576-2.30518-2.30518.0699-.27941.62869-.27941 1.46693-1.25737.83825-.97795 1.60664-1.60664 2.16547-2.16547.55884-.55883 2.44489-1.74635 2.44489-2.02576 0-.27942.83825-1.32723 1.46693-1.25737.62869.0698.9374.65608 1.04781.69854zm37.7211-10.54794c1.1002.66361 2.93386 1.88605 2.93386 2.23532 0 .34927 1.15259.9605 1.53679 2.02577.3842 1.06527.0699 1.27483 0 2.23532-.0699.96049.0698 1.67649-.27942 1.60664-.34927-.0699-1.25737.20956-1.88605-.27942-.62869-.48897-1.32723-.83824-1.74635-1.32722-.41912-.48898.13971-.69854-1.25737-1.25737s-1.53678-.41912-2.65445-1.04781c-1.11766-.62868-.97795-.48897-1.60664-.9081-.62868-.41912-1.32722-.27941-1.74634-1.32722-.41913-1.04781-.69854-1.11766-.0699-1.8162.62869-.69854-.9081-.9081 1.04781-1.11767 1.95591-.20956 1.32723-.20956 2.16547-.20956.83825 0 1.20498.47152 2.09562.7684.89064.29688.36673-.24449 1.46693.41912zm5.09933 34.57767c.57298-1.30513.97796-1.88605 1.04781-2.30517.0699-.41913.69854-1.46694 1.32723-1.60664.62868-.13971 2.16547 0 2.93386.1397.76839.13971 2.23532.62869 2.65445.62869.41912 0 1.25737.34927 1.88605.62868.62869.27942 1.22244 1.06527 1.60664 1.88606.3842.82078-.15717.78586-.0699 1.39708.0873.61122.69854.9081.41912 1.04781-.27941.1397-1.74635.34926-2.02576.27941-.27942-.0699-.78586-.50644-1.53679-.13971-.75093.36673-.76839.97795-1.46693 1.60664-.69854.62869-.45405.47151-1.32722.9081-.87317.43659-.69854.69854-2.16547.83825s-1.46693.0698-2.37504-.20956c-.9081-.27942-1.25737-.55883-1.74634-1.04781-.48898-.48898-.62869-.69854-.62869-1.18752 0-.48897 1.41123-2.73713 1.46693-2.86401zm-101.7953-166.16466c.79475-.007 6.69888 0 7.49366 0 .79478 0 4.65515.5677 5.10932 0 .45416-.5677 1.24894-1.02186 1.36248-1.93018.11354-.90833.5677-2.61143.22708-3.06559-.34062-.45416-2.38435-2.38435-2.61143-3.51975-.22708-1.1354-1.24894.11354-.22708-2.27081 1.02186-2.38434 1.93019-3.4062 3.06559-5.22285 1.1354-1.81664.79478-.45416 2.15727-3.29267 1.36248-2.8385 1.81664-2.8385 2.2708-4.20099.45416-1.36248.90832-1.81664.90832-2.61142 0-.79479-.5677-1.13541 0-1.81665.56771-.68124.99348-.93671 2.38435-.68124 1.39087.25547 2.61143 1.7031 3.17913 1.7031.5677 0 1.78826.39739 3.06559-.22708 1.27733-.62447.90832.79478 2.04372-2.2708 1.1354-3.06559.82317-2.12888 1.1354-3.63329s-1.58956-1.13541.11354-2.38435c1.70311-1.24894.56771-.34062 1.81665-1.36248 1.24894-1.02186 2.15726-2.04373 2.2708-2.72497.11354-.68124.45417-1.93018.45417-3.06559 0-1.1354-.11354-1.81664 0-3.17912.11354-1.36249.11354-2.61143.11354-3.63329 0-1.02187 0-1.58957-.11354-2.49789s-.11354-1.1354-.56771-2.04373c-.45416-.90832-.90832-3.17912-2.04372-3.29266-1.1354-.11354-2.27081-.68125-6.13118.45416-3.86037 1.1354-8.40198 5.56347-9.3103 7.15304-.90832 1.58956-9.53738 19.30184-10.55925 22.02681-1.02186 2.72497-5.33639 8.7426-5.79055 11.58111-.45416 2.83851-3.40621 8.7426-3.51975 10.33217-.11354 1.58956-.53932 4.3713-.11354 5.79055.42577 1.41925-.51098-.0924 1.81664-.11354z\"/> <path fill-rule=\"evenodd\" d=\"M-281.1204 360.3648S-393.33964 603.961-393.77894 611.16552c-.59531 8.82373 132.53354-216.23822 132.53354-216.23822l-19.875-34.5625zm.4375 21.59375 3.46875 2.59375-22.0625 37.15625c0-2.16058 18.59375-39.75 18.59375-39.75zM-383.60375 628.4617c-4.66064 1.39222 166.01079-161.80477 166.01079-161.80477l17.15815 26.23115s-177.5459 133.90428-183.16894 135.57362zm199.7021-110.81565s-148.77978 85.05949-156.36869 91.35837c9.60328-3.13187 163.77495-73.01463 163.77494-73.01462l-7.40625-18.34375zm-10.6875 13.53125c.1768-.0179.39513.0564.8125.21875 1.66949.64923 3.49967 2.79894 3.46875 4.4375-.0309 1.63855-.68762.57885-3.59375 2.09375s-5.73846 4.47558-8.03125 3.96875c-.64424-.14241-3.4554-1.89837-2.21875-4.0625 1.23666-2.16414 4.59054-2.98611 7.1875-4.59375 1.94771-1.20572 1.84459-2.00888 2.375-2.0625zm-158.68829 94.49839c3.57041-2.52515 201.79826-47.53278 201.79826-47.53278l11.66714 20.30946s-206.98477 27.22332-213.4654 27.22332zm53.58241 9.93867 177.59975-9.07444 2.16058 13.82772-179.76033-4.75328zm-66.76912 6.46919c5.9671 5.84951 272.03125 36.53124 272.03125 36.53125l-5.1875-24s-261.06553-13.05351-266.84375-12.53125zm213.34375 19.96875 38.65625 1.375.75 1.8125.3125 2.125c.00001.00001.29588 1.68335-.3125 1.53125-.60837-.15208-39.40625-6.69165-39.40625-6.84375zm-226.94825 1.2175c8.90802-.41622 262.37413 51.44599 262.37413 51.44599l-63.60778-1.52093s-197.34208-44.45538-198.76635-49.92506zm-10.8029 7.34597c5.49535-1.56691 116.67137 42.34739 116.67137 42.34739l-41.05104 1.72846s-74.3581-41.13064-75.62033-44.07585zm-34.5693-64.38531c0-1.47261-27.22332-58.7678-27.22332-58.7678l-9.93867 9.93867s25.80188 51.41622 37.16199 48.82913zm4.24049 1.49362c-1.93292-2.10864-20.6609-84.02781-20.6609-84.02781l4.75328-19.01312s18.73 106.11988 15.90762 103.04093zm12.17993 1.96331c3.14115-5.98254 45.80432-206.98366 45.80432-206.98366l-25.49486 13.3956s-22.15452 190.07366-20.30946 193.58806zm70.86706-52.28606 99.38672-125.3137 7.77809 13.82772-107.16481 111.48598z\"/> </g> </svg>",
  },
  {
    name: "Ostrze\u017cenie przed materia\u0142em radioaktywnym lub promieniowaniem jonizuj\u0105cym",
    code: "ISO7010-W003",
    builtin: true,
    iconKind: "svg",
    svg: "<svg viewBox=\"0 0 600 524\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m300 16 284 492h-568z\" fill=\"#F9A800\" stroke=\"#000\" stroke-linejoin=\"round\" stroke-width=\"32\"/><path d=\"m367 230a150 150 0 0 1 67 116h-268a150 150 0 0 1 67-116l134 232a150 150 0 0 1-134 0\"/><circle cx=\"300\" cy=\"346\" r=\"36\" stroke=\"#F9A800\" stroke-width=\"12\"/></svg>",
  },
];

function symbolIconSrc(type) {
  if (type.iconKind === "svg") return "data:image/svg+xml;utf8," + encodeURIComponent(type.svg);
  return URL.createObjectURL(type.imageBlob);
}

// Dosiewanie jest addytywne (nie "tylko gdy pusto"), zeby dopisanie nowych
// wbudowanych typow (np. znakow ISO 7010) pozniej w kodzie dotarlo tez do
// urzadzen, ktore juz maja zasiane te pierwsze 5 - dopasowanie po "code" tam
// gdzie jest (nowe typy), a po nazwie dla starych piatek bez "code".
async function loadSymbolTypes() {
  let types = await dbGetAllSymbolTypes();
  const existingCodes = new Set(types.filter((t) => t.code).map((t) => t.code));
  const existingNames = new Set(types.filter((t) => !t.code).map((t) => t.name));
  const missing = DEFAULT_SYMBOL_TYPES.filter((t) =>
    t.code ? !existingCodes.has(t.code) : !existingNames.has(t.name)
  );
  if (missing.length) {
    for (const t of missing) await dbAddSymbolType(t);
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
const inventoryLifecycleFilter = document.getElementById("inventory-lifecycle-filter");
const inventoryLayerFilter = document.getElementById("inventory-layer-filter");
const inventoryCategoryFilter = document.getElementById("inventory-category-filter");
const exportCsvLink = document.getElementById("export-csv-link");
const fullReportBtn = document.getElementById("full-report-btn");
const workReportBtn = document.getElementById("work-report-btn");
const reportBtn = document.getElementById("report-btn");
const calibrateBtn = document.getElementById("calibrate-btn");
const rotateLeftBtn = document.getElementById("rotate-left-btn");
const rotateRightBtn = document.getElementById("rotate-right-btn");
const locateBtn = document.getElementById("locate-btn");
const mapLayerFilterSelect = document.getElementById("map-layer-filter");
const symbolPaletteToggle = document.getElementById("symbol-palette-toggle");
const symbolPaletteList = document.getElementById("symbol-palette-list");
const paletteCurrentLabel = document.getElementById("palette-current-label");
const placementLayer = document.getElementById("placement-layer");
const backupBanner = document.getElementById("backup-banner");

const startErrorBanner = document.getElementById("start-error-banner");
const startErrorText = document.getElementById("start-error-text");
const startErrorDetails = document.getElementById("start-error-details");
const startErrorRetryBtn = document.getElementById("start-error-retry");
const startErrorDetailsToggle = document.getElementById("start-error-details-toggle");

// Uzywane przy bledach krytycznych w init() (patrz nizej) - zamiast pustego
// ekranu i bledu tylko w konsoli (tak dzialalo wczesniej), pokazujemy baner
// z jasnym opisem i przyciskiem odswiezenia. Szczegoly techniczne (stack)
// sa zwijane, ale dostepne - przydatne przy zglaszaniu bledu.
const startErrorMessages = [];
function reportInitError(label, err) {
  console.error(`[init] ${label} nie powiodl sie:`, err);
  startErrorMessages.push(`${label}: ${err && err.message ? err.message : err}`);
  startErrorText.textContent =
    startErrorMessages.length === 1
      ? `Nie udało się uruchomić: ${startErrorMessages[0].split(":")[0]}. Spróbuj odświeżyć.`
      : `Nie udało się uruchomić ${startErrorMessages.length} elementów aplikacji. Spróbuj odświeżyć.`;
  startErrorDetails.textContent = startErrorMessages.join("\n");
  startErrorBanner.classList.remove("hidden");
}
startErrorRetryBtn.addEventListener("click", () => window.location.reload());
startErrorDetailsToggle.addEventListener("click", () => {
  startErrorDetails.classList.toggle("hidden");
});

const markerPanel = document.getElementById("marker-panel");
const markerPanelTitle = document.getElementById("marker-panel-title");
const markerAttribution = document.getElementById("marker-attribution");
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
const markerArchiveBtn = document.getElementById("marker-archive");
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
let SERVICE_MODE = false;
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

// Wspolne rozwijane menu nad mapa (paleta/filtr warstw/kalibracja/gdzie
// jestem/obrot) - zastepuje dawniej rozsypane po calym ekranie osobne
// przyciski. Zamyka sie po stuknieciu gdziekolwiek poza nim (w tym na samym
// planie), nie trzeba wiec osobno zamykac go po kazdej akcji w menu.
const mapMenuToggle = document.getElementById("map-menu-toggle");
const mapMenuList = document.getElementById("map-menu-list");
mapMenuToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  mapMenuList.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (mapMenuList.classList.contains("hidden")) return;
  if (e.target.closest("#map-menu")) return;
  mapMenuList.classList.add("hidden");
});

// Pasek Budynek/Plan nad mapa - domyslnie zwiniety na telefonie (patrz
// media query w style.css), zeby nie zajmowac na stale miejsca nad planem.
// Na desktopie ta logika jest niewidoczna (reguly .collapsed obowiazuja
// tylko ponizej 640px), wiec .controls tam zawsze zostaje widoczny.
const headerControlsToggle = document.getElementById("header-controls-toggle");
const headerControls = document.getElementById("header-controls");
function updateHeaderControlsSummary() {
  const buildingLabel = buildingSelect.selectedOptions[0] ? buildingSelect.selectedOptions[0].textContent : "";
  const planLabel = planSelect.selectedOptions[0] ? planSelect.selectedOptions[0].textContent : "";
  headerControlsToggle.textContent = buildingLabel ? `${buildingLabel}${planLabel ? " · " + planLabel : ""} ▾` : "Wybierz budynek/plan ▾";
}
headerControlsToggle.addEventListener("click", () => {
  headerControls.classList.toggle("collapsed");
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
  security: "Ochrona / kontrola nocna",
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
  // Tryb serwisowy: kategoria jest zablokowana na SERWIS (i tak wymuszana
  // przez serwer niezaleznie od tego co wyslemy - to tylko czytelnosc UI).
  if (SERVICE_MODE) {
    markerCategory.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "SERWIS";
    opt.textContent = "SERWIS";
    markerCategory.appendChild(opt);
    markerCategory.value = "SERWIS";
    markerCategory.disabled = true;
    markerCategoryCustom.classList.add("hidden");
    return;
  }
  markerCategory.disabled = false;
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
  // Budynki z etykieta "DS N ..." sortujemy po tym numerze (zeby lista
  // pokazywala DS 1, DS 2, DS 3... po kolei, nie alfabetycznie po kodzie -
  // ARKA/CENTAUR/LABIRYNT/RAJ/TALIZMAN/ZODIAK alfabetycznie wyszlyby w innej
  // kolejnosci niz numery domow studenckich), reszta zostaje alfabetycznie.
  const dsNumber = (code) => {
    const m = /^DS (\d+)/.exec(BUILDING_DISPLAY_NAMES[code] || "");
    return m ? Number(m[1]) : null;
  };
  list.sort((a, b) => {
    const da = dsNumber(a.code);
    const db = dsNumber(b.code);
    if (da !== null && db !== null) return da - db;
    return a.code.localeCompare(b.code);
  });
  for (const b of list) b.plans.sort((a, b2) => a.sortOrder - b2.sortOrder);
  return list;
}

// Recznie utrzymana lista czytelnych nazw dla kodow, ktore same w sobie nic
// nie mowia (numer domu studenckiego != nazwa) - dla reszty budynkow po
// prostu pokazujemy to, co juz mamy (kod albo buildingName z bazy).
const BUILDING_DISPLAY_NAMES = {
  ARKA: "DS 1 Arka",
  CENTAUR: "DS 2 Centaur",
  LABIRYNT: "DS 3 Labirynt",
  TALIZMAN: "DS 4 Talizman",
  ZODIAK: "DS 5 Zodiak",
  RAJ: "DS 6 Raj",
};

// Ekran "brak planów" wczesniej ZAWSZE kazal recznie wczytac plik planów -
// mylace, gdy plany po prostu jeszcze sciagaja sie z serwera (pierwsze
// uruchomienie na nowym urzadzeniu, albo po utracie lokalnych danych)
// i za chwile pojawia sie same. Zalogowanym pokazujemy wiec info o
// synchronizacji zamiast instrukcji recznego importu; syncSetProgress
// (sync.js) dopisuje tu na biezaco co konkretnie sie teraz pobiera.
async function updateEmptyStateSyncHint() {
  const hint = document.getElementById("empty-state-sync-status");
  if (!hint) return;
  const cfg = await syncGetConfig();
  if (syncIsLoggedIn(cfg)) {
    hint.innerHTML = "Trwa pobieranie planów budynków z serwera — przy pierwszym uruchomieniu może to chwilę potrwać. Nie zamykaj aplikacji.";
  } else {
    hint.innerHTML =
      'Przejdź do zakładki <strong>Kopia zapasowa</strong> i wczytaj plik planów (np. plany-B1.json), albo zaloguj się tam do synchronizacji, żeby pobrały się automatycznie.';
  }
}

async function loadBuildings() {
  buildingsData = await buildingsFromDb();
  buildingSelect.innerHTML = "";
  for (const b of buildingsData) {
    const opt = document.createElement("option");
    opt.value = b.code;
    opt.textContent = BUILDING_DISPLAY_NAMES[b.code] || b.name;
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
    rotateLeftBtn.classList.add("hidden");
    rotateRightBtn.classList.add("hidden");
    await updateEmptyStateSyncHint();
    return;
  }
  emptyState.classList.add("hidden");
  reportBtn.classList.remove("hidden");
  calibrateBtn.classList.remove("hidden");
  rotateLeftBtn.classList.remove("hidden");
  rotateRightBtn.classList.remove("hidden");

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
    // Bez jawnie podanego pliku: wroc na kondygnacje, na ktorej ostatnio
    // bylismy w TYM budynku (przydatne przy przeskakiwaniu miedzy budynkami,
    // np. przez podpowiedz GPS) - zamiast zawsze wracac na pierwszy plan.
    const remembered = preferredFile || (await dbGetMeta(`lastPlanFile:${buildingCode}`));
    const chosen = (remembered && building.plans.find((p) => p.file === remembered)) || building.plans[0];
    planSelect.value = chosen.file;
    await selectPlan(buildingCode, chosen.file, chosen.name);
  }
  await loadInventory();
  await loadPomiary();
}

function initMapIfNeeded() {
  if (map) return;
  // zoomControl: false - przyciski +/- sa zbedne na telefonie (pinch-to-zoom
  // i podwojne stukniecie dzialaja bez zmian, to tylko usuwa widoczne
  // przyciski, ktore na malym ekranie nakladaly sie na palete symboli).
  map = L.map("map", { crs: L.CRS.Simple, minZoom: -5, zoomSnap: 0.25, zoomControl: false });
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
  updateHeaderControlsSummary();
  headerControls.classList.add("collapsed"); // bez efektu na desktopie - patrz media query w style.css
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
  await dbSetMeta(`lastPlanFile:${buildingCode}`, file);
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

  await refreshMapMarkers();
  await renderMeasurementsForPlan(currentPlanKey);
}

// --- Obracanie planu o 90 stopni ---
// Fizycznie obraca piksele obrazu (canvas) i PRZELICZA wspolrzedne kazdego
// markera/punktu pomiaru na tym planie, zeby zostaly we wlasciwych miejscach
// wzgledem obroconego obrazu - to jedyny sposob, zeby nie rozjechaly sie przy
// starych, juz zsynchronizowanych danych na innych urzadzeniach (obraca sie
// "prawda", nie tylko widok).
async function rotateImageBlob(blob, direction) {
  const bitmap = await createImageBitmap(blob);
  const oldW = bitmap.width;
  const oldH = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = oldH;
  canvas.height = oldW;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(((direction === "cw" ? 90 : -90) * Math.PI) / 180);
  ctx.drawImage(bitmap, -oldW / 2, -oldH / 2);
  bitmap.close();
  const rotatedBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return { blob: rotatedBlob, oldW, oldH };
}

// x/y markerow to wspolrzedne Leaflet (lng=x, lat=y) na obrazie o szerokosci
// oldW i wysokosci oldH - wzory wyprowadzone i sprawdzone na naroznikach dla
// obu kierunkow, zeby po obrocie punkty trafily we wlasciwe miejsce.
function rotatePointCoords(x, y, oldW, oldH, direction) {
  if (direction === "cw") return { x: y, y: oldW - x };
  return { x: oldH - y, y: x };
}

async function rotateCurrentPlan(direction) {
  if (!currentPlanKey || !currentBuildingCode || !currentPlanFile) return;
  if (
    !confirm(
      "Obrócić ten plan o 90°? Wszystkie punkty i pomiary na nim zostaną przesunięte w odpowiadające miejsca (też na innych urządzeniach po synchronizacji)."
    )
  ) {
    return;
  }

  const rec = await dbGetPlanImage(currentBuildingCode, currentPlanFile);
  if (!rec) return;

  rotateLeftBtn.disabled = true;
  rotateRightBtn.disabled = true;
  try {
    const { blob: newBlob, oldW, oldH } = await rotateImageBlob(rec.blob, direction);

    await dbPutPlanImage({ ...rec, blob: newBlob });
    syncEnqueuePlan(currentPlanKey);

    const markers = await dbGetMarkersByPlan(currentPlanKey);
    for (const m of markers) {
      const { x, y } = rotatePointCoords(m.x, m.y, oldW, oldH, direction);
      await dbUpdateMarker(m.id, { x, y });
    }

    const measurements = await dbGetMeasurementsByBuilding(currentBuildingCode);
    for (const meas of measurements) {
      let changed = false;
      const newPoints = meas.points.map((p) => {
        if (p.planFile !== currentPlanFile) return p;
        changed = true;
        const { x, y } = rotatePointCoords(p.x, p.y, oldW, oldH, direction);
        return { ...p, x, y };
      });
      if (changed) await dbUpdateMeasurement(meas.id, { points: newPoints });
    }

    await selectPlan(currentBuildingCode, currentPlanFile, currentPlanName);
  } finally {
    rotateLeftBtn.disabled = false;
    rotateRightBtn.disabled = false;
  }
}

rotateLeftBtn.addEventListener("click", () => rotateCurrentPlan("ccw"));
rotateRightBtn.addEventListener("click", () => rotateCurrentPlan("cw"));

// Filtr widoczności na mapie (nie ma wpływu na dane, tylko na to co się rysuje -
// np. "pokaż tylko warstwę Ochrona" żeby ochroniarz widział wyłącznie swoje
// punkty kontrolne, bez reszty inwentaryzacji). Nowo dodany punkt i tak
// pojawia się od razu, nawet jeśli nie pasuje do aktywnego filtra - inaczej
// dotknięcie mapy wyglądałoby, jakby nic się nie zapisało.
let mapLayerFilter = "";

function markerMatchesMapFilter(m) {
  if (!isMarkerActive(m)) return false;
  return !mapLayerFilter || m.layer === mapLayerFilter;
}

async function refreshMapMarkers() {
  if (!currentPlanKey) return;
  for (const id in leafletMarkers) map.removeLayer(leafletMarkers[id]);
  leafletMarkers = {};
  const markers = await dbGetMarkersByPlan(currentPlanKey);
  for (const m of markers) if (markerMatchesMapFilter(m)) addLeafletMarker(m);
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
  if (m._updatedByDeviceName) {
    markerAttribution.textContent = `Ostatnio zmienione przez: ${m._updatedByDeviceName}`;
    markerAttribution.classList.remove("hidden");
  } else {
    markerAttribution.classList.add("hidden");
  }
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

// Usun/Archiwizuj punktu - odwracalne (Kosz/Archiwum, zakladka Inwentaryzacja),
// nie twarde kasowanie jak dawniej (patrz dbDeleteMarker - ten zostaje tylko
// dla "porzuconego pustego szkicu" w closeMarkerPanel, to inny przypadek).
// Administrator: dzieje sie od razu. Serwis: to tylko PROSBA - lokalnie u
// niego ląduje od razu w jego wlasnym Koszu/Archiwum (patrz isMarkerActive),
// ale u administratora zostaje w pelni aktywne, dopoki nie zatwierdzi/odrzuci
// (zakladka Uprawnienia, sekcja "Prosby serwisu").
async function performMarkerLifecycleAction(id, action) {
  const field = action === "delete" ? "deletedAt" : "archivedAt";
  if (SERVICE_MODE) {
    await dbUpdateMarker(id, { pendingAction: action, pendingAt: new Date().toISOString() });
    await syncEnqueueMarkerAction(id, `request-${action}`);
  } else {
    await dbUpdateMarker(id, { [field]: new Date().toISOString() });
    await syncEnqueueMarkerAction(id, action);
  }
}

async function undoMarkerLifecycleAction(id, action) {
  const field = action === "delete" ? "deletedAt" : "archivedAt";
  if (SERVICE_MODE) {
    await syncEnqueueMarkerAction(id, "cancel-request");
    await dbUpdateMarker(id, { pendingAction: null, pendingAt: null });
  } else {
    await syncEnqueueMarkerAction(id, "restore");
    await dbUpdateMarker(id, { [field]: null });
  }
  const restored = await dbGetMarker(id);
  if (restored && restored.planKey === currentPlanKey) addLeafletMarker(restored);
  await loadInventory();
}

async function handleMarkerLifecycleButtonClick(action) {
  if (editingMarkerId == null) return;
  const id = editingMarkerId;
  await performMarkerLifecycleAction(id, action);
  const old = leafletMarkers[id];
  if (old) map.removeLayer(old);
  delete leafletMarkers[id];
  editingMarkerId = null; // zapobiega ponownemu "sprzataniu" w closeMarkerPanel
  markerPanel.classList.add("hidden");
  await loadInventory();
  const verb = action === "delete" ? "usunięcie" : "archiwizację";
  const doneLabel = action === "delete" ? "Punkt usunięty" : "Punkt zarchiwizowany";
  showSnackbar(SERVICE_MODE ? `Zgłoszono ${verb} — zobaczysz w Koszu/Archiwum` : doneLabel, () =>
    undoMarkerLifecycleAction(id, action)
  );
}

markerDeleteBtn.addEventListener("click", () => handleMarkerLifecycleButtonClick("delete"));
markerArchiveBtn.addEventListener("click", () => handleMarkerLifecycleButtonClick("archive"));

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

// --- Podpowiedz budynku z GPS ---
// Uzywamy tylko szerokosci/dlugosci (dokladnosc GPS rzedu kilku-kilkunastu
// metrow wystarcza do rozpoznania BUDYNKU). Wysokosc z GPS celowo pomijamy -
// blad pomiaru wysokosci to typowo +/-10-30m, wiele razy wiecej niz odstep
// miedzy pietrami (~3m), wiec nie da sie tak zgadywac kondygnacji. Zamiast
// tego kondygnacja podpowiada sie sama z pamieci ostatnio uzywanej dla danego
// budynku (patrz loadPlans/selectPlan).
let buildingLocations = null;

// Plik building-locations.json to tylko startowy "bootstrap" (kilka recznie
// zgeokodowanych adresow) - prawdziwe, coraz dokladniejsze wspolrzedne
// pochodza z serwera (tabela building_locations, zbierana automatycznie z
// GPS w terenie - patrz sampleBuildingLocation) i majа pierwszenstwo tam,
// gdzie juz zebrano choc jedna probke.
async function loadBuildingLocations(forceRefresh) {
  if (buildingLocations && !forceRefresh) return buildingLocations;
  let merged = {};
  try {
    const res = await fetch("building-locations.json");
    merged = res.ok ? await res.json() : {};
  } catch {
    merged = {};
  }

  const cfg = await syncGetConfig();
  if (syncIsLoggedIn(cfg)) {
    try {
      const res = await fetch(`${cfg.serverUrl}/api/building-locations`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (res.ok) {
        const body = await res.json();
        for (const item of body.items) {
          merged[item.building_code] = {
            lat: item.lat,
            lon: item.lon,
            address: merged[item.building_code] && merged[item.building_code].address,
            samples: item.samples,
          };
        }
      }
    } catch {
      // offline - zostajemy przy tym co jest w pliku statycznym
    }
  }

  buildingLocations = merged;
  return buildingLocations;
}

// Wywolywane przy kazdym nowym punkcie - probkuje GPS i wysyla je jako
// kolejna probke lokalizacji tego budynku (srednia biegnaca po stronie
// serwera). Celowo ciche - to tylko poprawa podpowiedzi GPS w tle, nie akcja
// uzytkownika, wiec zaden blad/brak zgody nie powinien pokazywac alertu ani
// przeszkadzac w zapisie punktu (ktory juz i tak sie zapisal lokalnie).
function sampleBuildingLocation(buildingCode) {
  if (!("geolocation" in navigator) || !buildingCode) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      syncGetConfig().then((cfg) => {
        if (!syncIsLoggedIn(cfg)) return;
        fetch(`${cfg.serverUrl}/api/building-locations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
          body: JSON.stringify({ building_code: buildingCode, lat: pos.coords.latitude, lon: pos.coords.longitude }),
        }).catch(() => {});
      });
    },
    () => {},
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
  );
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const GPS_MATCH_RADIUS_M = 150;

const locateCandidatesPanel = document.getElementById("locate-candidates-panel");
const locateCandidatesList = document.getElementById("locate-candidates-list");

// Zamiast zgadywac JEDEN, najblizszy budynek (myliło to, gdy dwa budynki np.
// A1/A2 lezaly blisko siebie - zawsze wygrywal ten o kilka metrow blizszy, bez
// mozliwosci poprawnego wyboru), pokazujemy liste WSZYSTKICH pobliskich
// kandydatow posortowana wg odleglosci - uzytkownik wybiera wlasciwy.
function showLocateCandidates(candidates) {
  locateCandidatesList.innerHTML = "";
  for (const c of candidates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary locate-candidate-item";
    btn.textContent = `${BUILDING_DISPLAY_NAMES[c.code] || c.code} (~${Math.round(c.dist)} m)`;
    btn.addEventListener("click", () => {
      buildingSelect.value = c.code;
      loadPlans(c.code);
      locateCandidatesPanel.classList.add("hidden");
    });
    locateCandidatesList.appendChild(btn);
  }
  locateCandidatesPanel.classList.remove("hidden");
}
document.getElementById("locate-candidates-close").addEventListener("click", () => {
  locateCandidatesPanel.classList.add("hidden");
});

locateBtn.addEventListener("click", async () => {
  if (!("geolocation" in navigator)) {
    alert("Ten telefon/przeglądarka nie obsługuje lokalizacji GPS.");
    return;
  }
  const locations = await loadBuildingLocations(true);
  if (!Object.keys(locations).length) {
    alert("Baza współrzędnych budynków jest jeszcze pusta.");
    return;
  }
  locateBtn.disabled = true;
  const originalLabel = locateBtn.textContent;
  locateBtn.textContent = "Namierzam…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locateBtn.disabled = false;
      locateBtn.textContent = originalLabel;
      const { latitude, longitude } = pos.coords;
      const nearby = Object.entries(locations)
        .map(([code, loc]) => ({ code, dist: haversineMeters(latitude, longitude, loc.lat, loc.lon) }))
        .filter((c) => c.dist <= GPS_MATCH_RADIUS_M)
        .sort((a, b) => a.dist - b.dist);
      if (!nearby.length) {
        alert("Żaden ze znanych budynków nie jest wystarczająco blisko (albo nie mam jeszcze zapisanych jego współrzędnych).");
        return;
      }
      const candidates = nearby.filter((c) => c.code !== currentBuildingCode);
      if (!candidates.length) {
        alert(`Wygląda na to, że już tu jesteś (${currentBuildingCode}, ~${Math.round(nearby[0].dist)} m).`);
        return;
      }
      mapMenuList.classList.add("hidden");
      showLocateCandidates(candidates);
    },
    (err) => {
      locateBtn.disabled = false;
      locateBtn.textContent = originalLabel;
      alert("Nie udało się pobrać lokalizacji: " + err.message);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }
  );
});

mapLayerFilterSelect.addEventListener("change", () => {
  mapLayerFilter = mapLayerFilterSelect.value;
  refreshMapMarkers();
});

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
    if (btn.dataset.tab === "permissions") loadPermissions();
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
inventoryLifecycleFilter.addEventListener("change", loadInventory);
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
  const lifecycleFilter = inventoryLifecycleFilter.value; // "" (aktywne) | "trash" | "archive"
  const layerFilter = inventoryLayerFilter.value;
  const categoryFilter = inventoryCategoryFilter.value;
  let markers;
  if (planKey) markers = await dbGetMarkersByPlan(planKey);
  else if (buildingFilter) markers = await dbGetMarkersByBuilding(buildingFilter);
  else markers = await dbGetAllMarkers();
  if (lifecycleFilter === "trash") markers = markers.filter(isMarkerInTrash);
  else if (lifecycleFilter === "archive") markers = markers.filter(isMarkerInArchive);
  else markers = markers.filter(isMarkerActive);
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
    // W widoku aktywnym administrator widzi male "czeka na zatwierdzenie" przy
    // pozycjach zgloszonych przez serwis (samemu serwisowi taka pozycja w
    // ogole sie tu nie pokaze - patrz isMarkerActive - bo u niego juz jest
    // "w koszu/archiwum"). W Koszu/Archiwum: administrator zawsze moze
    // Przywrocic; serwis, dla WLASNEJ jeszcze niezatwierdzonej prosby, moze
    // ja Cofnac (to samo dzialanie co "Przywroc" pod spodem - patrz
    // undoMarkerLifecycleAction, ktora rozroznia to sama po roli).
    const pendingBadge = !SERVICE_MODE && !lifecycleFilter && m.pendingAction
      ? `<span class="status-chip pending">⏳ zgłoszenie: ${(m.pendingByDeviceName || "serwis").replace(/</g, "&lt;")}</span>`
      : "";
    let lifecycleAction = "";
    if (lifecycleFilter === "trash" || lifecycleFilter === "archive") {
      const action = lifecycleFilter === "trash" ? "delete" : "archive";
      const canAct = !SERVICE_MODE || m.pendingAction;
      const label = SERVICE_MODE ? "Cofnij prośbę" : "Przywróć";
      if (canAct) {
        lifecycleAction = ` · <a data-lifecycle-id="${m.id}" data-lifecycle-action="${action}">${label}</a>`;
      }
    }
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${m.buildingCode}</td>
      <td>${m.planName}</td>
      <td>${statusCell}${pendingBadge}</td>
      <td>${layerLabel(m.layer)}</td>
      <td>${(m.category || "").replace(/</g, "&lt;")}</td>
      <td>${(m.note || "").replace(/</g, "&lt;")}</td>
      <td>${m.dueDate || ""}${m.reviewDate ? ` / kontrola: ${m.reviewDate}` : ""}</td>
      <td>${photoCell}</td>
      <td>${(m.createdAt || "").replace("T", " ").slice(0, 19)}</td>
      <td class="row-actions"><a data-id="${m.id}" data-plan="${m.planFile}">Pokaż na mapie</a>${lifecycleAction}</td>
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
  tbody.querySelectorAll("a[data-lifecycle-id]").forEach((a) => {
    a.addEventListener("click", () => undoMarkerLifecycleAction(a.dataset.lifecycleId, a.dataset.lifecycleAction));
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
  let markers = buildingCode ? await dbGetMarkersByBuilding(buildingCode) : await dbGetAllMarkers();
  // Kosz/Archiwum nie wchodza do eksportu domyslnie - patrz zakladka
  // Inwentaryzacja (filtr "Widok") zeby je zobaczyc/wyeksportowac osobno.
  markers = markers.filter(isMarkerActive);
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

// --- Zakladka Uprawnienia (tylko administrator - patrz syncApplyUiRestrictions) ---

function permissionRowBox(titleHtml, subtitleLines, actionLabel, onAction) {
  const box = document.createElement("div");
  box.className = "sync-conflict-item";
  const p1 = document.createElement("p");
  p1.innerHTML = titleHtml;
  box.appendChild(p1);
  for (const line of subtitleLines) {
    if (!line) continue;
    const p = document.createElement("p");
    p.textContent = line;
    box.appendChild(p);
  }
  if (actionLabel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = actionLabel === "Usuń" ? "danger" : "secondary";
    btn.textContent = actionLabel;
    btn.addEventListener("click", onAction);
    box.appendChild(btn);
  }
  return box;
}

function formatPlDate(value) {
  if (!value) return null;
  return new Date(value.replace(" ", "T") + "Z").toLocaleString("pl-PL");
}

async function renderOwnerDevicesList() {
  const listEl = document.getElementById("owner-devices-list");
  if (!listEl) return;
  const { devices, currentDeviceId } = await syncListOwnerDevices();
  const active = devices.filter((d) => !d.revoked_at);
  listEl.innerHTML = "";
  if (!active.length) {
    listEl.textContent = "Brak kont administratora.";
    return;
  }
  for (const d of active) {
    const isCurrent = d.id === currentDeviceId;
    const box = permissionRowBox(
      `<strong>${d.device_name}</strong> — Administrator${isCurrent ? " (to urządzenie)" : ""}`,
      [
        `Utworzono: ${formatPlDate(d.created_at) || "—"}`,
        d.last_used_at ? `Ostatnio użyte: ${formatPlDate(d.last_used_at)}` : null,
      ],
      isCurrent ? null : "Usuń", // wlasnego, aktualnie uzywanego urzadzenia nie da sie usunac stad (natychmiastowe wylogowanie samego siebie)
      async () => {
        if (!confirm(`Usunąć dostęp administratora "${d.device_name}"? Trafi do Kosza uprawnień, można przywrócić.`)) return;
        await syncRevokeServiceLink(d.id); // ten sam mechanizm co odwolanie linku serwisowego - DELETE /api/devices/{id}
        await loadPermissions();
      }
    );
    listEl.appendChild(box);
  }
}

// Kosz uprawnien laczy odwolane konta administratora I odwolane/wygasle linki
// serwisowe w jednym miejscu - to jedno wspolne miejsce "co zostalo usuniete",
// mimo ze aktywne listy (Administratorzy / Linki dla serwisantow) sa osobne.
async function renderPermissionsTrash() {
  const listEl = document.getElementById("permissions-trash-list");
  if (!listEl) return;
  const [{ devices }, links] = await Promise.all([syncListOwnerDevices(), syncListServiceLinks()]);
  const revokedOwners = devices.filter((d) => d.revoked_at).map((d) => ({ ...d, roleLabel: "Administrator" }));
  const revokedLinks = links
    .filter((l) => syncServiceLinkStatus(l) !== "aktywny")
    .map((l) => ({ ...l, roleLabel: syncServiceLinkStatus(l) === "wygasł" ? "Serwis (wygasł)" : "Serwis" }));
  const rows = [...revokedOwners, ...revokedLinks];
  listEl.innerHTML = "";
  if (!rows.length) {
    listEl.textContent = "Kosz jest pusty.";
    return;
  }
  for (const row of rows) {
    const canRestore = row.roleLabel !== "Serwis (wygasł)"; // wygasly link trzeba wydac na nowo, samo przywrocenie nic nie da
    const box = permissionRowBox(
      `<strong>${row.device_name}</strong> — ${row.roleLabel}`,
      [row.revoked_at ? `Usunięto: ${formatPlDate(row.revoked_at)}` : null],
      canRestore ? "Przywróć" : null,
      async () => {
        await syncRestoreDevice(row.id);
        await loadPermissions();
      }
    );
    listEl.appendChild(box);
  }
}

// Zgloszenia serwisu czekajace na zatwierdzenie - budowane z lokalnej bazy
// (dokladnie jak kazdy inny widok w tej appce), nie osobnym zapytaniem do
// serwera: administrator i tak dostaje te pola przy zwyklym pull() (patrz
// syncApplyRemoteRecord), wiec sa juz na biezaco w IndexedDB.
async function renderPendingRequests() {
  const panel = document.getElementById("pending-requests-panel");
  const listEl = document.getElementById("pending-requests-list");
  if (!listEl || !panel) return;
  const pending = (await dbGetAllMarkers()).filter((m) => m.pendingAction);
  listEl.innerHTML = "";
  if (!pending.length) {
    listEl.textContent = "Brak oczekujących próśb.";
    return;
  }
  for (const m of pending) {
    const verb = m.pendingAction === "archive" ? "zarchiwizować" : "usunąć";
    const box = document.createElement("div");
    box.className = "sync-conflict-item";
    const p1 = document.createElement("p");
    p1.innerHTML = `<strong>${m.pendingByDeviceName || "Serwis"}</strong> chce ${verb} punkt w ${m.buildingCode} — ${m.planName}`;
    const p2 = document.createElement("p");
    p2.textContent = m.note ? `Notatka: ${m.note}` : "(bez notatki)";
    box.appendChild(p1);
    box.appendChild(p2);
    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.textContent = "Zatwierdź";
    approveBtn.addEventListener("click", async () => {
      await syncEnqueueMarkerAction(m.id, "approve");
      const col = m.pendingAction === "archive" ? "archivedAt" : "deletedAt";
      await dbUpdateMarker(m.id, { [col]: new Date().toISOString(), pendingAction: null, pendingAt: null });
      await loadPermissions();
      await loadInventory();
    });
    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "secondary";
    rejectBtn.textContent = "Odrzuć";
    rejectBtn.addEventListener("click", async () => {
      await syncEnqueueMarkerAction(m.id, "reject");
      await dbUpdateMarker(m.id, { pendingAction: null, pendingAt: null });
      await loadPermissions();
      await loadInventory();
    });
    box.appendChild(approveBtn);
    box.appendChild(rejectBtn);
    listEl.appendChild(box);
  }
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function renderTrashSizeBanner() {
  const banner = document.getElementById("permissions-trash-size-banner");
  if (!banner) return;
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) {
    banner.classList.add("hidden");
    return;
  }
  const res = await fetch(`${cfg.serverUrl}/api/markers/trash-size`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) {
    banner.classList.add("hidden");
    return;
  }
  const body = await res.json();
  const total = (body.trash_bytes || 0) + (body.archive_bytes || 0);
  banner.textContent =
    `Zdjęcia w Koszu: ${formatBytes(body.trash_bytes)} · w Archiwum: ${formatBytes(body.archive_bytes)}` +
    (total > body.alert_bytes ? " — ⚠ dużo miejsca, warto ręcznie opróżnić Kosz (zakładka Inwentaryzacja)." : ".");
  banner.classList.remove("hidden");
}

async function loadPermissions() {
  try {
    await renderOwnerDevicesList();
  } catch (err) {
    console.error("[permissions] konta administratora:", err);
  }
  try {
    await renderPermissionsTrash();
  } catch (err) {
    console.error("[permissions] kosz uprawnień:", err);
  }
  try {
    await renderPendingRequests();
  } catch (err) {
    console.error("[permissions] prośby serwisu:", err);
  }
  try {
    await renderTrashSizeBanner();
  } catch (err) {
    console.error("[permissions] rozmiar kosza:", err);
  }
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
      // Kosz/Archiwum/prosby serwisu - kopia zapasowa to jedyne miejsce, ktore
      // NIE filtruje po statusie (musi zachowac wszystko), wiec te pola musza
      // tu jechac, zeby przywrocenie z kopii nie "odzyskiwalo" po cichu
      // punktow z kosza jako znowu aktywnych.
      deletedAt: m.deletedAt || null,
      archivedAt: m.archivedAt || null,
      pendingAction: m.pendingAction || null,
      pendingAt: m.pendingAt || null,
      pendingByDeviceName: m.pendingByDeviceName || null,
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
      deletedAt: r.deletedAt || null,
      archivedAt: r.archivedAt || null,
      pendingAction: r.pendingAction || null,
      pendingAt: r.pendingAt || null,
      pendingByDeviceName: r.pendingByDeviceName || null,
    });
    existingKeys.add(key);
    imported++;
  }

  let plansImported = 0;
  for (const r of planRecords) {
    const blob = dataUrlToBlob(r.image);
    const planKey = planKeyOf(r.buildingCode, r.file);
    await dbPutPlanImagePreserveScale({
      key: planKey,
      buildingCode: r.buildingCode,
      buildingName: r.buildingName || r.buildingCode,
      file: r.file,
      name: r.name,
      sortOrder: r.sortOrder || 0,
      blob,
    });
    syncEnqueuePlan(planKey);
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
          const planKey = planKeyOf(r.buildingCode, r.file);
          await dbPutPlanImagePreserveScale({
            key: planKey,
            buildingCode: r.buildingCode,
            buildingName: r.buildingName || r.buildingCode,
            file: r.file,
            name: r.name,
            sortOrder: r.sortOrder || 0,
            blob,
          });
          syncEnqueuePlan(planKey);
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
    const planKey = planKeyOf(code, fileName);
    await dbPutPlanImagePreserveScale({
      key: planKey,
      buildingCode: code,
      buildingName,
      file: fileName,
      name: planName,
      sortOrder,
      blob: pendingPlanBlob,
    });
    syncEnqueuePlan(planKey);

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
  const markers = (await dbGetMarkersByPlan(planKey)).filter(isMarkerActive);
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
  const filtered = allMarkers.filter((m) => isMarkerActive(m) && REPORT_CATEGORIES.includes(m.category));
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
  const markers = (await dbGetAllMarkers()).filter((m) => isMarkerActive(m) && !m.done);
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
//
// Sama rejestracja ponizej nigdy wczesniej nie sprawdzala, czy jest nowsza
// wersja - przegladarka robi to z wlasnej inicjatywy rzadko (glownie przy
// twardym przeladowaniu), a nawet gdy nowy service worker sie juz zainstaluje
// (skipWaiting+clients.claim w service-worker.js), otwarta karta ma stare
// app.js/sync.js/index.html wciaz wczytane w pamieci - std konicznosc
// recznego zamkniecia i otwarcia appki po kazdym wdrozeniu. Sprawdzamy wiec
// aktywnie (te same momenty co synchronizacja danych - online/powrot do
// karty/co 60s) i przeladowujemy raz, gdy nowy sw faktycznie przejmie kontrole.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    const registration = await navigator.serviceWorker.register("service-worker.js").catch(() => null);
    if (!registration) return;
    const checkForUpdate = () => registration.update().catch(() => {});
    window.addEventListener("online", checkForUpdate);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });
    setInterval(checkForUpdate, 60000);
  });

  let swRefreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swRefreshing) return;
    swRefreshing = true;
    window.location.reload();
  });
}

// Chowa zakladki Pomiary i Kopia zapasowa w trybie serwisowym (link bez
// logowania - patrz syncTryUrlServiceLogin w sync.js). Prawdziwa granica
// bezpieczenstwa (jedna kategoria, brak dostepu do cudzych notatek) jest
// egzekwowana przez serwer, nie tutaj - to tylko upraszcza interfejs.
async function syncApplyUiRestrictions() {
  if (!SERVICE_MODE) return;
  document
    .querySelectorAll('.tab-btn[data-tab="pomiary"], .tab-btn[data-tab="backup"], .tab-btn[data-tab="permissions"]')
    .forEach((btn) => btn.classList.add("hidden"));
}

// --- Start ---
//
// Kazdy krok w wlasnym try/catch: dawniej to byl jeden nieopakowany lancuch
// await - jeden wyjatek gdziekolwiek (np. nieprawidlowy/odwolany link
// serwisowy, blad IndexedDB) przerywal WSZYSTKO po nim, dajac pusty ekran
// bez zadnego komunikatu. Krytyczne kroki (bez ktorych appka jest
// bezuzyteczna) pokazuja baner bledu przez reportInitError; pomniejsze tylko
// loguja i appka jedzie dalej na tym, co sie udalo wczytac.
(async function init() {
  // Prosimy przegladarke o "trwaly" status dla naszego zapisu (IndexedDB +
  // Cache Storage). Bez tego przegladarka (zwlaszcza Android przy malej
  // ilosci wolnego miejsca) moze pod presja miejsca sama, bez ostrzezenia,
  // wyczyscic cala baze urzadzenia - w tym plany budynkow i jeszcze
  // niewyslane na serwer punkty/zdjecia z terenu. To tylko prosba (przegladarka
  // moze odmowic), wiec brak efektu nie jest bledem - i tak nic tu nie da sie
  // wiecej zrobic z poziomu appki.
  try {
    if (navigator.storage && navigator.storage.persist) {
      const granted = await navigator.storage.persist();
      console.log("[init] trwale przechowywanie danych:", granted ? "przyznane" : "odmowione/niedostepne");
    }
  } catch (err) {
    console.error("[init] navigator.storage.persist:", err);
  }

  let serviceLinkResult = "none";
  try {
    serviceLinkResult = await syncTryUrlServiceLogin();
  } catch (err) {
    reportInitError("Link serwisowy", err);
  }
  if (serviceLinkResult === "invalid") {
    startErrorText.textContent =
      "Ten link serwisowy jest nieprawidłowy, wygasł albo został odwołany. Poproś o nowy link.";
    startErrorDetails.textContent = "";
    startErrorBanner.classList.remove("hidden");
  }

  // Wczesniej niz w oryginalnym kodzie: musimy znac SERVICE_MODE PRZED
  // loadBuildings()/loadInventory() (ponizej), zeby filtry Kosza/Archiwum
  // (isMarkerActive itd.) nie dzialaly chwile na domyslnym "false", zanim
  // syncApplyUiRestrictions rozstrzygnie to pozniej w tym samym init().
  try {
    SERVICE_MODE = await syncIsServiceMode();
  } catch (err) {
    console.error("[init] syncIsServiceMode:", err);
  }

  try {
    await syncMigrateLegacyIds();
  } catch (err) {
    reportInitError("Migracja danych lokalnych", err);
  }

  try {
    await loadSymbolTypes();
    renderSymbolPalette();
  } catch (err) {
    reportInitError("Wczytanie typów symboli", err);
  }

  try {
    await loadBuildings();
  } catch (err) {
    reportInitError("Wczytanie budynków i planów", err);
  }

  try {
    await ensureDeviceLabel();
  } catch (err) {
    console.error("[init] ensureDeviceLabel:", err);
  }

  try {
    reportEmails.value = (await dbGetMeta("reportEmails")) || "";
  } catch (err) {
    console.error("[init] wczytanie adresow e-mail raportu:", err);
  }

  try {
    await refreshBackupInfo();
  } catch (err) {
    console.error("[init] refreshBackupInfo:", err);
  }

  try {
    await refreshBackupDirUI();
  } catch (err) {
    console.error("[init] refreshBackupDirUI:", err);
  }

  try {
    await maybeAutoRestore();
  } catch (err) {
    console.error("[init] maybeAutoRestore:", err);
  }

  try {
    syncWireUi();
  } catch (err) {
    reportInitError("Uruchomienie panelu synchronizacji", err);
  }

  try {
    await syncApplyUiRestrictions();
  } catch (err) {
    console.error("[init] syncApplyUiRestrictions:", err);
  }

  try {
    syncTryFlush();
    syncPull();
  } catch (err) {
    console.error("[init] syncTryFlush/syncPull:", err);
  }
})();
