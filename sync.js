// === Synchronizacja z serwerem (ppoz.gteam.pl) ===
//
// Priorytet (ustalony z Robertem): zapis lokalny w IndexedDB dzieje sie
// natychmiast i nigdy nie czeka na siec (to juz dzialalo, tu nic nie
// zmieniamy). Zaraz po nim proba wyslania zmiany na serwer w tle - jesli
// offline/blad, zmiana zostaje w kolejce i probujemy ponownie. Konflikty
// (ten sam rekord zmieniony na dwoch urzadzeniach) NIGDY nie blokuja pracy -
// obie wersje ladujа do listy "Konflikty do przejrzenia", uzytkownik decyduje
// kiedy chce.
//
// Zakres na teraz: markery (punkty/notatki), zdjecia do markerow, pomiary,
// wlasne typy symboli. Plany budynkow zostaja na obecnym rocznym imporcie
// (plik JSON z plany-budynkow) - automatyczna dystrybucja planow miedzy
// urzadzeniami to osobny, nastepny krok.

const SYNC_STORE = { marker: "markers", measurement: "measurements", symbolType: "symbolTypes" };
const SYNC_TYPE_OF_STORE = { markers: "marker", measurements: "measurement", symbolTypes: "symbolType" };

function uuidv4() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// --- Konfiguracja / logowanie ---

async function syncGetConfig() {
  const serverUrl = await dbGetMeta("syncServerUrl");
  const token = await dbGetMeta("syncToken");
  return { serverUrl, token };
}

function syncGuessDeviceName() {
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) return "Telefon Android";
  if (/iPhone|iPad/i.test(ua)) return "iPhone";
  if (/Windows/i.test(ua)) return "Laptop Windows";
  if (/Macintosh/i.test(ua)) return "Mac";
  return "Nieznane urzadzenie";
}

// Usuwa koncowe "/" i koncowy "/api" niezaleznie od tego, ile razy ktos je
// wklei - reszta kodu sama dokleja "/api/..." do adresu serwera, wiec ten
// adres ma byc "goly" (bez /api).
function syncNormalizeServerUrl(serverUrl) {
  let url = serverUrl.trim().replace(/\/+$/, "");
  while (/\/api$/i.test(url)) url = url.replace(/\/api$/i, "").replace(/\/+$/, "");
  return url;
}

async function syncLogin(serverUrl, email, password) {
  const url = syncNormalizeServerUrl(serverUrl);
  const res = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, device_name: syncGuessDeviceName() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Blad logowania (HTTP ${res.status})`);
  await dbSetMeta("syncServerUrl", url);
  await dbSetMeta("syncToken", body.token);
  await syncMigrateLegacyIds();
  await syncEnqueueAllExisting();
  syncTryFlush();
  syncPull();
  return body.token;
}

async function syncLogout() {
  const { serverUrl, token } = await syncGetConfig();
  if (serverUrl && token) {
    try {
      await fetch(`${serverUrl}/api/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // offline przy wylogowaniu - i tak kasujemy token lokalnie, serwer go
      // sam uzna za nieaktywny po prostu przy kolejnej probie uzycia
    }
  }
  await dbSetMeta("syncToken", null);
}

function syncIsLoggedIn(cfg) {
  return !!(cfg && cfg.serverUrl && cfg.token);
}

// --- Migracja starych, numerycznych ID (auto-increment) na UUID ---
// Jednorazowa, uruchamiana przy pierwszym logowaniu do synchronizacji (a
// takze przy kazdym starcie appki, na wypadek gdyby poprzednim razem sie nie
// dokonczyla). Symbol types najpierw, bo markery je referencjonuja przez
// symbolTypeId - trzeba przemapowac razem, inaczej symbole na planie by "obsunely
// sie" na zle typy po migracji.
async function syncMigrateLegacyIds() {
  const done = await dbGetMeta("syncUuidMigrationDone");
  if (done) return;
  const db = await dbPromise;

  const symbolIdMap = new Map();
  const symTypes = await db.getAll("symbolTypes");
  for (const t of symTypes) {
    if (typeof t.id === "string") continue;
    const oldId = t.id;
    const newId = uuidv4();
    symbolIdMap.set(oldId, newId);
    const tx = db.transaction("symbolTypes", "readwrite");
    await tx.store.delete(oldId);
    await tx.store.add({ ...t, id: newId });
    await tx.done;
  }

  const markers = await db.getAll("markers");
  for (const m of markers) {
    if (typeof m.id === "string") continue;
    const oldId = m.id;
    const newId = uuidv4();
    const remapped = symbolIdMap.has(m.symbolTypeId) ? symbolIdMap.get(m.symbolTypeId) : m.symbolTypeId;
    const tx = db.transaction("markers", "readwrite");
    await tx.store.delete(oldId);
    await tx.store.add({ ...m, id: newId, symbolTypeId: remapped });
    await tx.done;
  }

  const measurements = await db.getAll("measurements");
  for (const meas of measurements) {
    if (typeof meas.id === "string") continue;
    const oldId = meas.id;
    const newId = uuidv4();
    const tx = db.transaction("measurements", "readwrite");
    await tx.store.delete(oldId);
    await tx.store.add({ ...meas, id: newId });
    await tx.done;
  }

  await dbSetMeta("syncUuidMigrationDone", true);
}

// Po migracji/pierwszym logowaniu: wrzuc WSZYSTKO co jest lokalnie do kolejki,
// zeby serwer poznal tez dane sprzed wlaczenia synchronizacji.
async function syncEnqueueAllExisting() {
  const db = await dbPromise;
  const markers = await db.getAll("markers");
  for (const m of markers) {
    await syncEnqueue("marker", m.id, m.buildingCode);
    for (const p of m.photos || []) {
      if (!p.synced) await syncEnqueuePhoto(m.id, p.id);
    }
  }
  const measurements = await db.getAll("measurements");
  for (const meas of measurements) await syncEnqueue("measurement", meas.id, meas.buildingCode);
  const symTypes = await db.getAll("symbolTypes");
  for (const t of symTypes) if (!t.builtin) await syncEnqueue("symbolType", t.id, null);
}

// --- Kolejka wysylki (przetrwa restart appki/utrate polaczenia) ---

async function syncEnqueue(type, id, buildingCode) {
  const db = await dbPromise;
  await db.put("syncQueue", { key: `${type}:${id}`, type, id, buildingCode: buildingCode || null, deleted: false });
  syncTryFlush();
}

async function syncEnqueueDelete(type, id, buildingCode, baseUpdatedAt) {
  const db = await dbPromise;
  await db.put("syncQueue", {
    key: `${type}:${id}`,
    type,
    id,
    buildingCode: buildingCode || null,
    deleted: true,
    baseUpdatedAtSnapshot: baseUpdatedAt || null,
  });
  syncTryFlush();
}

async function syncEnqueuePhoto(markerId, photoId) {
  const db = await dbPromise;
  await db.put("syncQueue", { key: `photo:${photoId}`, type: "photo", id: photoId, markerId });
  syncTryFlush();
}

// Plany budynkow (importPlansInput / "Dodaj plan" / przywracanie z kopii) -
// wywolywane jawnie z tych trzech miejsc w app.js, NIE z samego
// dbPutPlanImage/dbPutPlanImagePreserveScale, bo te funkcje sa uzywane tez
// przy zapisie planu POBRANEGO z serwera (syncFetchAndStorePlan) - gdyby
// enqueue siedzial w nich, kazdy pobrany plan bylby zaraz odsylany z powrotem.
async function syncEnqueuePlan(planKey) {
  const db = await dbPromise;
  await db.put("syncQueue", { key: `plan:${planKey}`, type: "plan", id: planKey });
  syncTryFlush();
}

let syncFlushInFlight = false;
let syncFlushQueued = false;

async function syncTryFlush() {
  if (syncFlushInFlight) {
    syncFlushQueued = true;
    return;
  }
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) return;
  syncFlushInFlight = true;
  try {
    const db = await dbPromise;
    const items = await db.getAll("syncQueue");
    for (const item of items) {
      try {
        if (item.type === "photo") await syncPushPhoto(cfg, item);
        else if (item.type === "plan") await syncPushPlan(cfg, item);
        else await syncPushRecord(cfg, item);
      } catch {
        // brak sieci/blad - zostaw w kolejce, sprobujemy przy kolejnej okazji
      }
    }
  } finally {
    syncFlushInFlight = false;
    await syncRenderStatus();
    if (syncFlushQueued) {
      syncFlushQueued = false;
      syncTryFlush();
    }
  }
}

async function syncPushRecord(cfg, item) {
  const db = await dbPromise;
  const store = SYNC_STORE[item.type];
  let data;
  let baseUpdatedAt;

  if (item.deleted) {
    data = {};
    baseUpdatedAt = item.baseUpdatedAtSnapshot || null;
  } else {
    const record = await db.get(store, item.id);
    if (!record) {
      // rekord zniknal lokalnie zanim zdazyl wyjsc (np. skasowany zaraz po utworzeniu) - nic do wyslania
      await db.delete("syncQueue", item.key);
      return;
    }
    const { id, photos, planKey, _syncUpdatedAt, ...rest } = record;
    data = rest;
    baseUpdatedAt = _syncUpdatedAt || null;
  }

  const res = await fetch(`${cfg.serverUrl}/api/sync/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({
      changes: [{ id: item.id, type: item.type, building_code: item.buildingCode, base_updated_at: baseUpdatedAt, deleted: !!item.deleted, data }],
    }),
  });
  if (!res.ok) return; // np. 401 - zostaw w kolejce, uzytkownik zobaczy status "niezalogowany" po odswiezeniu
  const body = await res.json();
  const result = (body.results || [])[0];
  if (!result) return;

  if (result.status === "conflict") {
    const local = item.deleted ? null : await db.get(store, item.id);
    await syncStoreConflict(item.type, item.id, item.buildingCode, local, result.server_payload, result.server_updated_at, !!result.server_deleted);
    await db.delete("syncQueue", item.key);
    return;
  }

  if (!item.deleted) {
    const record = await db.get(store, item.id);
    if (record) await db.put(store, { ...record, _syncUpdatedAt: result.server_updated_at });
  }
  await db.delete("syncQueue", item.key);
}

async function syncPushPhoto(cfg, item) {
  const db = await dbPromise;
  const marker = await db.get("markers", item.markerId);
  if (!marker) {
    await db.delete("syncQueue", item.key);
    return;
  }
  const photo = (marker.photos || []).find((p) => p.id === item.id);
  if (!photo) {
    await db.delete("syncQueue", item.key);
    return;
  }
  if (photo.synced) {
    await db.delete("syncQueue", item.key);
    return;
  }

  const form = new FormData();
  form.append("record_id", item.markerId);
  form.append("file", photo.blob, `photo.${(photo.type || "image/jpeg").split("/")[1] || "jpg"}`);

  const res = await fetch(`${cfg.serverUrl}/api/photos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
    body: form,
  });
  if (!res.ok) return; // zostaw w kolejce
  const uploaded = await res.json();

  const fresh = await db.get("markers", item.markerId);
  if (fresh) {
    const photos = (fresh.photos || []).map((p) => (p.id === item.id ? { ...p, id: uploaded.id, synced: true } : p));
    await db.put("markers", { ...fresh, photos });
  }
  await db.delete("syncQueue", item.key);
}

async function syncPushPlan(cfg, item) {
  const db = await dbPromise;
  const plan = await db.get("planImages", item.id);
  if (!plan) {
    await db.delete("syncQueue", item.key);
    return;
  }

  const form = new FormData();
  form.append("building_code", plan.buildingCode);
  form.append("name", plan.name);
  form.append("sort_order", String(plan.sortOrder || 0));
  form.append("file_key", plan.file);
  form.append("file", plan.blob, `plan.${(plan.blob.type || "image/png").split("/")[1] || "png"}`);

  const res = await fetch(`${cfg.serverUrl}/api/plans`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
    body: form,
  });
  if (!res.ok) return; // zostaw w kolejce
  await db.delete("syncQueue", item.key);
}

// --- Konflikty ---

async function syncStoreConflict(type, id, buildingCode, localData, serverData, serverUpdatedAt, serverDeleted) {
  const db = await dbPromise;
  await db.put("syncConflicts", {
    key: `${type}:${id}`,
    type,
    id,
    buildingCode,
    localData,
    serverData,
    serverUpdatedAt,
    serverDeleted: !!serverDeleted,
    detectedAt: new Date().toISOString(),
  });
}

async function syncResolveConflict(key, choice) {
  const db = await dbPromise;
  const conflict = await db.get("syncConflicts", key);
  if (!conflict) return;
  const store = SYNC_STORE[conflict.type];

  if (choice === "server") {
    if (conflict.serverDeleted) {
      await db.delete(store, conflict.id);
    } else {
      const existing = (await db.get(store, conflict.id)) || {};
      const record = { ...existing, ...conflict.serverData, id: conflict.id, _syncUpdatedAt: conflict.serverUpdatedAt };
      if (store === "markers" && !record.planKey) record.planKey = planKeyOf(record.buildingCode, record.planFile);
      await db.put(store, record);
    }
  } else {
    const local = await db.get(store, conflict.id);
    if (local) {
      await db.put(store, { ...local, _syncUpdatedAt: conflict.serverUpdatedAt });
      await syncEnqueue(conflict.type, conflict.id, conflict.buildingCode);
    }
  }
  await db.delete("syncConflicts", key);
  await syncRenderStatus();
  if (choice === "local") syncTryFlush();
}

// Rozstrzygniecie pole-po-polu: fieldChoices to { nazwaPola: "local" | "server" }
// dla kazdego pola, ktore sie rozniglo (patrz syncBuildFieldDiff). Wynik to
// nowy rekord zbudowany z wybranych wartosci, ktory od razu ladujemy z
// powrotem do kolejki wysylki - jesli w miedzyczasie nikt inny go znowu nie
// ruszyl, push powinien przejsc bez kolejnego konfliktu.
async function syncResolveConflictFields(key, fieldChoices) {
  const db = await dbPromise;
  const conflict = await db.get("syncConflicts", key);
  if (!conflict) return;
  const store = SYNC_STORE[conflict.type];

  const localData = conflict.localData || {};
  const serverData = conflict.serverData || {};
  const merged = { ...localData };
  for (const [field, choice] of Object.entries(fieldChoices)) {
    merged[field] = choice === "server" ? serverData[field] : localData[field];
  }

  const existing = (await db.get(store, conflict.id)) || {};
  const record = { ...existing, ...merged, id: conflict.id, _syncUpdatedAt: conflict.serverUpdatedAt };
  if (store === "markers" && !record.planKey) record.planKey = planKeyOf(record.buildingCode, record.planFile);
  await db.put(store, record);

  await db.delete("syncConflicts", key);
  await syncRenderStatus();
  await syncEnqueue(conflict.type, conflict.id, conflict.buildingCode);
}

function syncFormatValue(v) {
  if (v === undefined) return "(brak)";
  if (v === null || v === "") return "(puste)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Buduje tabelke roznic pole-po-polu miedzy lokalna a serwerowa wersja
// konfliktowego rekordu - pola identyczne po obu stronach sa tylko pokazane
// (bez wyboru), pola rozne dostaja dwa przyciski radio (domyslnie zaznaczone
// "Twoje", bo to zwykle ta wersja, ktora ma sie przed oczami w terenie).
function syncBuildConflictBox(c) {
  const box = document.createElement("div");
  box.className = "sync-conflict-item";

  const header = document.createElement("p");
  header.innerHTML = `<strong>${c.type}</strong> — ${c.buildingCode || ""}`;
  box.appendChild(header);

  if (c.serverDeleted || !c.localData) {
    const info = document.createElement("p");
    info.textContent = c.serverDeleted
      ? "Ten rekord zostal usuniety na innym urzadzeniu."
      : "Ten rekord zostal usuniety lokalnie na tym urzadzeniu.";
    box.appendChild(info);
    const keepLocalBtn = document.createElement("button");
    keepLocalBtn.type = "button";
    keepLocalBtn.textContent = c.serverDeleted ? "Przywroc moja wersje" : "Zaakceptuj usuniecie";
    keepLocalBtn.addEventListener("click", () => syncResolveConflict(c.key, c.serverDeleted ? "local" : "server"));
    const keepServerBtn = document.createElement("button");
    keepServerBtn.type = "button";
    keepServerBtn.className = "secondary";
    keepServerBtn.textContent = c.serverDeleted ? "Zaakceptuj usuniecie" : "Przywroc mimo to";
    keepServerBtn.addEventListener("click", () => syncResolveConflict(c.key, c.serverDeleted ? "server" : "local"));
    box.appendChild(keepLocalBtn);
    box.appendChild(keepServerBtn);
    return box;
  }

  const localData = c.localData;
  const serverData = c.serverData || {};
  const allKeys = Array.from(new Set([...Object.keys(localData), ...Object.keys(serverData)])).sort();

  const table = document.createElement("table");
  table.className = "sync-diff-table";
  const theadRow = document.createElement("tr");
  theadRow.innerHTML = "<th>Pole</th><th>Twoje</th><th>Serwer</th>";
  table.appendChild(theadRow);

  const radioGroupPrefix = `conflict-${c.key}`;
  const differingFields = [];
  for (const field of allKeys) {
    const lv = localData[field];
    const sv = serverData[field];
    const same = JSON.stringify(lv) === JSON.stringify(sv);
    const row = document.createElement("tr");
    if (same) {
      row.innerHTML = `<td>${field}</td><td colspan="2">${syncFormatValue(lv)}</td>`;
    } else {
      differingFields.push(field);
      const radioName = `${radioGroupPrefix}-${field}`;
      row.className = "sync-diff-row-changed";
      row.innerHTML = `
        <td>${field}</td>
        <td><label><input type="radio" name="${radioName}" value="local" checked> ${syncFormatValue(lv)}</label></td>
        <td><label><input type="radio" name="${radioName}" value="server"> ${syncFormatValue(sv)}</label></td>
      `;
    }
    table.appendChild(row);
  }
  box.appendChild(table);

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.textContent = "Zastosuj wybor";
  applyBtn.addEventListener("click", () => {
    const fieldChoices = {};
    for (const field of differingFields) {
      const checked = box.querySelector(`input[name="${radioGroupPrefix}-${field}"]:checked`);
      fieldChoices[field] = checked ? checked.value : "local";
    }
    syncResolveConflictFields(c.key, fieldChoices);
  });
  box.appendChild(applyBtn);

  return box;
}

// --- Pobieranie zmian z serwera (od innych urzadzen) ---

// Podczas dlugotrwalego pobierania (duzo planow/zdjec przy pierwszej
// synchronizacji) pokazujemy co sie dzieje - inaczej wyglada to jak
// zawieszona apka (tak wlasnie wygladalo, zanim to dodalismy).
function syncSetProgress(text) {
  const el = document.getElementById("sync-status-info");
  if (el) el.textContent = text;
}

async function syncPull() {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) return;
  try {
    await syncPullRecords(cfg);
    await syncPullPlans(cfg);
    await syncPullPhotosMeta(cfg);
  } catch {
    // brak sieci - sprobujemy przy kolejnej okazji
  }
  await syncRenderStatus();
}

async function syncPullRecords(cfg) {
  const db = await dbPromise;
  let since = (await dbGetMeta("syncPullCursor")) || "1970-01-01 00:00:00.000000";
  let hasMore = true;
  while (hasMore) {
    const res = await fetch(`${cfg.serverUrl}/api/sync/pull?since=${encodeURIComponent(since)}&limit=200`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return;
    const body = await res.json();
    for (const item of body.items) await syncApplyRemoteRecord(item);
    since = body.next_since;
    hasMore = body.has_more;
    await dbSetMeta("syncPullCursor", since);
  }
}

async function syncApplyRemoteRecord(item) {
  const store = SYNC_STORE[item.type];
  if (!store) return;
  const db = await dbPromise;

  const pending = await db.get("syncQueue", `${item.type}:${item.id}`);
  if (pending) {
    const local = item.deleted ? null : await db.get(store, item.id);
    await syncStoreConflict(item.type, item.id, item.building_code, local, item.data, item.updated_at, !!item.deleted);
    return;
  }

  if (item.deleted) {
    await db.delete(store, item.id);
    return;
  }

  const record = { ...item.data, id: item.id, _syncUpdatedAt: item.updated_at };
  if (store === "markers") {
    if (!record.planKey) record.planKey = planKeyOf(record.buildingCode, record.planFile);
    const existing = await db.get(store, item.id);
    record.photos = (existing && existing.photos) || [];
  }
  await db.put(store, record);
}

async function syncPullPlans(cfg) {
  const db = await dbPromise;
  let since = (await dbGetMeta("syncPlansCursor")) || "1970-01-01 00:00:00.000000";
  let hasMore = true;
  let done = 0;
  while (hasMore) {
    const res = await fetch(`${cfg.serverUrl}/api/plans?since=${encodeURIComponent(since)}&limit=50`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return;
    const body = await res.json();
    for (const p of body.items) {
      if (!p.deleted && p.file_key) {
        done++;
        syncSetProgress(`Pobieram plany budynków… (${done})`);
        await syncFetchAndStorePlan(cfg, p);
      }
    }
    since = body.next_since;
    hasMore = body.has_more;
    await dbSetMeta("syncPlansCursor", since);
  }
  if (typeof loadBuildings === "function") await loadBuildings();
}

async function syncFetchAndStorePlan(cfg, p) {
  const db = await dbPromise;
  const key = planKeyOf(p.building_code, p.file_key);
  const existing = await db.get("planImages", key);
  if (existing) return; // juz mamy ten plan lokalnie pod tym samym kluczem

  const res = await fetch(`${cfg.serverUrl}/api/plans/${p.id}/image`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) return;
  const blob = await res.blob();
  await dbPutPlanImagePreserveScale({
    key,
    buildingCode: p.building_code,
    buildingName: p.building_code,
    file: p.file_key,
    name: p.name,
    sortOrder: p.sort_order,
    blob,
  });
}

async function syncPullPhotosMeta(cfg) {
  const db = await dbPromise;
  let since = (await dbGetMeta("syncPhotosCursor")) || "1970-01-01 00:00:00.000000";
  let hasMore = true;
  let done = 0;
  while (hasMore) {
    const res = await fetch(`${cfg.serverUrl}/api/photos?since=${encodeURIComponent(since)}&limit=100`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return;
    const body = await res.json();
    for (const p of body.items) {
      if (!p.deleted) {
        done++;
        syncSetProgress(`Pobieram zdjęcia… (${done})`);
        await syncFetchAndAttachPhoto(cfg, p);
      }
    }
    since = body.next_since;
    hasMore = body.has_more;
    await dbSetMeta("syncPhotosCursor", since);
  }
}

async function syncFetchAndAttachPhoto(cfg, p) {
  const db = await dbPromise;
  const marker = await db.get("markers", p.record_id);
  if (!marker) return; // marker jeszcze nie dotarl (np. inna kolejnosc synchronizacji) - dogonimy przy nastepnym pull
  if ((marker.photos || []).some((ph) => ph.id === p.id)) return;

  const res = await fetch(`${cfg.serverUrl}/api/photos/${p.id}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) return;
  const blob = await res.blob();

  const fresh = await db.get("markers", p.record_id);
  if (!fresh) return;
  const photos = [...(fresh.photos || []), { id: p.id, blob, type: p.content_type, addedAt: p.updated_at, synced: true }];
  await db.put("markers", { ...fresh, photos });
}

// --- Status / UI ---

async function syncRenderStatus() {
  const cfg = await syncGetConfig();
  const loginSection = document.getElementById("sync-login-section");
  const activeSection = document.getElementById("sync-active-section");
  const statusInfo = document.getElementById("sync-status-info");
  const pendingInfo = document.getElementById("sync-pending-info");
  const conflictsSection = document.getElementById("sync-conflicts-section");
  const conflictsList = document.getElementById("sync-conflicts-list");
  const conflictsTitle = document.getElementById("sync-conflicts-title");
  if (!statusInfo) return; // sekcja jeszcze nie wyrenderowana (np. w trakcie startu)

  const db = await dbPromise;
  const queueCount = (await db.getAll("syncQueue")).length;
  const conflicts = await db.getAll("syncConflicts");

  if (!syncIsLoggedIn(cfg)) {
    statusInfo.textContent = "Status: niezalogowany (dane zapisują się tylko lokalnie)";
    loginSection.classList.remove("hidden");
    activeSection.classList.add("hidden");
  } else {
    statusInfo.textContent = navigator.onLine
      ? `Status: zalogowany, online (${cfg.serverUrl})`
      : `Status: zalogowany, offline - zmiany czekają w kolejce (${cfg.serverUrl})`;
    pendingInfo.textContent = queueCount > 0 ? `Do wysłania: ${queueCount}` : "Wszystko wysłane.";
    loginSection.classList.add("hidden");
    activeSection.classList.remove("hidden");
  }

  if (conflicts.length > 0) {
    conflictsSection.classList.remove("hidden");
    conflictsTitle.textContent = `Konflikty do przejrzenia (${conflicts.length})`;
    conflictsList.innerHTML = "";
    for (const c of conflicts) {
      conflictsList.appendChild(syncBuildConflictBox(c));
    }
  } else {
    conflictsSection.classList.add("hidden");
  }
}

function syncWireUi() {
  const loginBtn = document.getElementById("sync-login-btn");
  const logoutBtn = document.getElementById("sync-logout-btn");
  const syncNowBtn = document.getElementById("sync-now-btn");
  if (!loginBtn) return;

  loginBtn.addEventListener("click", async () => {
    const serverUrl = document.getElementById("sync-server-url").value.trim();
    const email = document.getElementById("sync-email").value.trim();
    const password = document.getElementById("sync-password").value;
    if (!serverUrl || !email || !password) {
      alert("Podaj adres serwera, e-mail i hasło.");
      return;
    }
    loginBtn.disabled = true;
    loginBtn.textContent = "Logowanie…";
    try {
      await syncLogin(serverUrl, email, password);
      document.getElementById("sync-password").value = "";
      await syncRenderStatus();
    } catch (err) {
      alert(err.message || "Nie udało się zalogować.");
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "Zaloguj i włącz synchronizację";
    }
  });

  logoutBtn.addEventListener("click", async () => {
    if (!confirm("Wyłączyć synchronizację na tym urządzeniu? Dane lokalne zostaną, ale przestaną się wysyłać.")) return;
    await syncLogout();
    await syncRenderStatus();
  });

  syncNowBtn.addEventListener("click", async () => {
    syncNowBtn.disabled = true;
    syncNowBtn.textContent = "Synchronizuję…";
    try {
      await syncTryFlush();
      await syncPull();
    } finally {
      syncNowBtn.disabled = false;
      syncNowBtn.textContent = "Synchronizuj teraz";
    }
  });

  window.addEventListener("online", () => {
    syncTryFlush();
    syncPull();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncTryFlush();
      syncPull();
    }
  });
  setInterval(() => {
    syncTryFlush();
    syncPull();
  }, 60000);

  syncRenderStatus();
}

// syncMigrateLegacyIds() i start (syncWireUi/syncTryFlush/syncPull) sa wywolywane
// z init() w app.js, w konkretnej kolejnosci (migracja PRZED wczytaniem markerow) -
// zwykly listener DOMContentLoaded tutaj mogłby wystartować rownolegle z app.js
// i wyscigowo nadpisac markery w trakcie ich renderowania.
