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
  await dbSetMeta("isServiceMode", false);
  await dbSetMeta("restrictBuildings", null);
  await syncMigrateLegacyIds();
  await syncEnqueueAllExisting();
  syncTryFlush();
  syncPull();
  return body.token;
}

// Link dla serwisanta: token w adresie URL (?service=...), bez logowania.
// Uprawnienia (jedna kategoria, brak pomiarow, brak cudzych notatek) sa
// egzekwowane przez serwer - to tutaj tylko przelacza interfejs w tryb
// uproszczony (patrz syncApplyUiRestrictions w app.js) i chowa token z paska
// adresu, zeby nie zostal np. w historii przegladarki po zrzucie ekranu.
//
// Link synchronizacji budynkow (?buildingSync=...) to ten sam mechanizm
// (token w adresie, bez logowania), ale odwrotne uprawnienia: PELNY dostep
// (rola owner) ograniczony tylko do WYBRANYCH budynkow (filtrowanie po
// stronie serwera - Auth::restrictedBuildings w PlanController/SyncController/
// PhotoController) - do urzadzen, ktore maja pracowac tylko w czesci kampusu
// i nie musza sciagac planow/danych wszystkich budynkow (168 planow, 372MB
// lacznie na dzien pisania tego kodu).
const SYNC_DEFAULT_SERVER_URL = "https://ppoz.gteam.pl";

// Zwraca "none" (brak parametru - nic do zrobienia), "ok" (link przyjety -
// zweryfikowany online albo, gdy offline, przyjety optymistycznie zgodnie z
// zasada offline-first) albo "invalid" (serwer jednoznacznie odmowil - link
// odwolany/wygasly, NIE zapisujemy tokenu). Rozroznienie "invalid" od
// "offline" jest wazne: bez niego kazdy problem z siecia przy pierwszym
// otwarciu linku wygladalby dla uzytkownika jak odwolany dostep.
async function syncTryUrlServiceLogin() {
  const params = new URLSearchParams(window.location.search);
  const serviceToken = params.get("service");
  const buildingToken = params.get("buildingSync");
  const token = serviceToken || buildingToken;
  if (!token) return "none";

  // Czyscimy adres z tokenu niezaleznie od wyniku weryfikacji - zeby link nie
  // zostal w historii przegladarki / na zrzucie ekranu.
  params.delete("service");
  params.delete("buildingSync");
  const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : "") + window.location.hash;
  window.history.replaceState({}, "", cleanUrl);

  let deviceName = null;
  // Offline (brak odpowiedzi z /api/whoami) - przyjmujemy optymistycznie role
  // wynikajaca z tego, KTORY parametr uzyto (skad w ogole wziety token), i
  // brak ograniczenia budynkow dopoki nie potwierdzi tego serwer.
  let role = serviceToken ? "service" : "owner";
  let restrictBuildings = null;
  try {
    const res = await fetch(`${SYNC_DEFAULT_SERVER_URL}/api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return "invalid";
    }
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      deviceName = body.device_name || null;
      role = body.role || role;
      restrictBuildings = Array.isArray(body.restrict_buildings) ? body.restrict_buildings : null;
    }
    // Inny kod (np. 5xx) - traktujemy jak brak sieci, kontynuujemy nizej.
  } catch (err) {
    console.warn("[sync] nie udalo sie zweryfikowac linku online, przyjmuje offline:", err);
  }

  await dbSetMeta("syncServerUrl", SYNC_DEFAULT_SERVER_URL);
  await dbSetMeta("syncToken", token);
  // isServiceMode wynika z FAKTYCZNEJ roli zwroconej przez serwer (whoami), a
  // nie z tego, ktorego parametru URL uzyto - link synchronizacji budynkow to
  // rola "owner" (pelny dostep), wiec NIE ma dostawac ograniczen interfejsu
  // serwisanta (patrz syncApplyUiRestrictions w app.js).
  await dbSetMeta("isServiceMode", role === "service");
  await dbSetMeta("restrictBuildings", restrictBuildings);
  if (deviceName) await dbSetMeta("serviceLinkLabel", deviceName);

  await syncMigrateLegacyIds();
  syncTryFlush();
  syncPull();
  return "ok";
}

async function syncIsServiceMode() {
  return !!(await dbGetMeta("isServiceMode"));
}

// null = brak ograniczenia (widzi wszystkie budynki - konto administratora
// albo zwykly link serwisowy sprzed tej funkcji). Tablica kodow - urzadzenie
// przyszlo z linku synchronizacji budynkow (patrz syncTryUrlServiceLogin).
async function syncRestrictedBuildings() {
  const value = await dbGetMeta("restrictBuildings");
  return Array.isArray(value) && value.length ? value : null;
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
  await dbSetMeta("isServiceMode", false);
  await dbSetMeta("restrictBuildings", null);
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

// Kosz/Archiwum wydarzen + workflow zatwierdzania serwisu (patrz
// performMarkerLifecycleAction w app.js) - osobny "rodzaj" wpisu w TEJ SAMEJ
// kolejce syncQueue (klucz "action:<id>", nie koliduje z "marker:<id>" powyzej,
// wiec oba moga czekac jednoczesnie), zeby zadarmo dziedziczyc caly istniejacy
// mechanizm retry/offline (syncTryFlush, wyzwalacze online/visibilitychange/60s).
async function syncEnqueueMarkerAction(recordId, action) {
  const db = await dbPromise;
  await db.put("syncQueue", { key: `action:${recordId}`, kind: "action", recordId, action });
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
        if (item.kind === "action") await syncPushAction(cfg, item);
        else if (item.type === "photo") await syncPushPhoto(cfg, item);
        else if (item.type === "plan") await syncPushPlan(cfg, item);
        else await syncPushRecord(cfg, item);
      } catch (err) {
        // brak sieci/blad - zostaw w kolejce, sprobujemy przy kolejnej okazji,
        // ale zaloguj zeby dalo sie zdiagnozowac (patrz syncPull - ten sam powod)
        console.error("[sync] push nie powiodl sie:", item.type, item.id, err);
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

  if (result.status !== "ok") {
    // 'invalid'/'forbidden' (i przyszle 'locked') - serwer ODRZUCIL zmiane, to
    // NIE jest sukces. Wczesniej ten przypadek po cichu spadal do usuniecia
    // z kolejki ponizej, wygladajac jak wyslane, mimo ze serwer nic nie zapisal -
    // pokazujemy to w istniejacym UI konfliktow zamiast cichego znikniecia.
    console.error("[sync] serwer odrzucil zmiane:", item.type, item.id, result.status);
    const local = item.deleted ? null : await db.get(store, item.id);
    await syncStoreConflict(item.type, item.id, item.buildingCode, local, null, null, false);
    await db.delete("syncQueue", item.key);
    return;
  }

  if (!item.deleted) {
    const record = await db.get(store, item.id);
    if (record) await db.put(store, { ...record, _syncUpdatedAt: result.server_updated_at });
  }
  await db.delete("syncQueue", item.key);
}

// Kosz/Archiwum + zatwierdzanie serwisu - patrz syncEnqueueMarkerAction.
const MARKER_ACTION_ENDPOINT = {
  "request-delete": "request-delete",
  "request-archive": "request-archive",
  "cancel-request": "cancel-request",
  approve: "approve",
  reject: "reject",
  delete: "delete",
  archive: "archive",
  restore: "restore",
};

async function syncPushAction(cfg, item) {
  const db = await dbPromise;
  const endpoint = MARKER_ACTION_ENDPOINT[item.action];
  if (!endpoint) {
    await db.delete("syncQueue", item.key);
    return;
  }
  const res = await fetch(`${cfg.serverUrl}/api/markers/${item.recordId}/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 409) return; // siec/serwer - zostaw w kolejce, sprobuj pozniej
  // 404 (marker juz nie istnieje) / 409 (akcja juz rozstrzygnieta przez kogos
  // innego, np. admin zdazyl zatwierdzic zanim doszlo tu "cofnij prosbe") sa
  // KONCOWE, nie do ponowienia - porzucamy wpis, kolejny pull() sprowadzi
  // prawdziwy stan.
  await db.delete("syncQueue", item.key);
  syncPull();
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
  // Ten sam komunikat tez na ekranie "brak planów" (zakladka Mapa) - to tam
  // uzytkownik faktycznie patrzy przy pierwszym uruchomieniu, nie w ukrytej
  // wtedy zakladce Kopia zapasowa. Element jest niewidoczny, dopoki
  // #empty-state ma klase "hidden", wiec nadpisywanie go tutaj jest
  // nieszkodliwe rowniez wtedy, gdy plany sa juz wczytane.
  const hint = document.getElementById("empty-state-sync-status");
  if (hint) hint.textContent = text;
}

// Bez tej blokady kilka wyzwalaczy pull-a (login, powrot online, powrot do
// karty, timer co 60s) moglo odpalic sie prawie rownoczesnie - kazde
// wywolanie zaczynaloby od TEGO SAMEGO, jeszcze nie zaawansowanego kursora i
// ponownie sciagalo ten sam pakiet planow/zdjec w kolko, zamiast tylko raz.
let syncPullInFlight = false;
let syncPullQueued = false;

// Ostatnio uzywane budynki (max 3, najnowszy pierwszy) - zapisywane przy
// kazdym wyborze budynku (patrz syncTouchRecentBuilding w loadPlans w
// app.js). syncPull() dociaga je PRZED reszta kampusu przy kazdym tyku
// synchronizacji, zeby budynki, do ktorych uzytkownik faktycznie wraca,
// byly zawsze maksymalnie swieze - zamiast czekac w zwyklej kolejce kursora
// razem z calym kampusem.
const SYNC_RECENT_BUILDINGS_MAX = 3;

async function syncGetRecentBuildings() {
  const list = await dbGetMeta("syncRecentBuildings");
  return Array.isArray(list) ? list : [];
}

async function syncTouchRecentBuilding(buildingCode) {
  if (!buildingCode) return;
  const list = await syncGetRecentBuildings();
  const next = [buildingCode, ...list.filter((b) => b !== buildingCode)].slice(0, SYNC_RECENT_BUILDINGS_MAX);
  await dbSetMeta("syncRecentBuildings", next);
}

async function syncPull() {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) return;
  if (syncPullInFlight) {
    syncPullQueued = true;
    return;
  }
  syncPullInFlight = true;
  try {
    // Wlasne, osobne kursory per budynek (patrz syncPullRecords/Plans/
    // PhotosMeta) sprawiaja, ze powtarzanie tego co tyk jest tanie -
    // pobiera sie tylko to, co sie faktycznie zmienilo od ostatniego razu,
    // nie caly budynek od nowa za kazdym razem. Osobny try/catch - blad przy
    // doraznym odswiezaniu "ostatnich budynkow" (np. jeden nieudany fetch)
    // NIE MOZE zablokowac normalnego, pelnego sync ponizej - to by bylo
    // gorsze niz brak tej funkcji w ogole.
    try {
      const recentBuildings = await syncGetRecentBuildings();
      for (const code of recentBuildings) {
        await syncPullPlans(cfg, code);
        await syncPullRecords(cfg, code);
        await syncPullPhotosMeta(cfg, code);
      }
    } catch (err) {
      console.error("[sync] odswiezanie ostatnich budynkow nie dokonczylo sie (pelny sync ponizej i tak ruszy):", err);
    }
    await syncPullRecords(cfg);
    await syncPullPlans(cfg);
    await syncPullPhotosMeta(cfg);
  } catch (err) {
    // Lapiemy tu zarowno "brak sieci" jak i realne bledy (np. IndexedDB odmawia
    // zapisu przy przepelnionej przestrzeni dyskowej) - loguj do konsoli, zeby
    // dalo sie to zdiagnozowac z DevTools zamiast cichego "nic sie nie stalo".
    console.error("[sync] syncPull nie dokonczyl sie:", err);
    syncSetProgress(`Błąd synchronizacji: ${err && err.message ? err.message : err}`);
  } finally {
    syncPullInFlight = false;
    await syncRenderStatus();
    if (syncPullQueued) {
      syncPullQueued = false;
      syncPull();
    }
  }
}

// Gdy uzytkownik wybiera budynek (loadPlans w app.js), ten budynek ma dostac
// priorytet: najpierw jego plany, potem markery/pomiary, na koncu zdjecia -
// w tej kolejnosci, bo zdjecia i tak wymagaja, zeby marker byl juz lokalnie
// (patrz syncFetchAndAttachPhoto). Dziala ROWNOLEGLE do zwyklego syncPull()
// w tle (bez wzajemnego blokowania) i NIE rusza zadnego z globalnych
// kursorow - to tylko "podejrzyj ten budynek teraz", normalny pelny
// przebieg synchronizacji i tak kiedys do niego dojdzie sam. Pokazuje
// widoczny baner "Ładowanie budynku… X%" (polaczony procent z 3 kategorii
// naraz), ale TYLKO jesli faktycznie jest cokolwiek do pobrania - budynek
// juz w pelni zsynchronizowany nie miga niepotrzebnym komunikatem.
async function syncPrioritizeBuilding(buildingCode) {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg) || !buildingCode) return;
  await syncTouchRecentBuilding(buildingCode);

  const totals = { plans: 0, records: 0, photos: 0 };
  const dones = { plans: 0, records: 0, photos: 0 };
  let bannerShown = false;
  const updateBanner = () => {
    const totalAll = totals.plans + totals.records + totals.photos;
    const doneAll = dones.plans + dones.records + dones.photos;
    if (totalAll <= 0) return;
    bannerShown = true;
    syncShowBuildingProgress(buildingCode, Math.min(100, Math.round((doneAll / totalAll) * 100)));
  };

  try {
    await syncPullPlans(cfg, buildingCode, (d, t) => {
      dones.plans = d;
      totals.plans = t !== null ? t : d;
      updateBanner();
    });
    const recordsChanged = await syncPullRecords(cfg, buildingCode, (d, t) => {
      dones.records = d;
      totals.records = t !== null ? t : d;
      updateBanner();
    });
    const photosChanged = await syncPullPhotosMeta(cfg, buildingCode, (d, t) => {
      dones.photos = d;
      totals.photos = t !== null ? t : d;
      updateBanner();
    });
    // Odswiez widok tylko jesli uzytkownik nadal patrzy na ten sam budynek -
    // w miedzyczasie mogl juz przejsc do kolejnego.
    if (
      (recordsChanged || photosChanged) &&
      typeof currentBuildingCode !== "undefined" &&
      currentBuildingCode === buildingCode
    ) {
      if (typeof refreshMapMarkers === "function") await refreshMapMarkers();
      if (typeof loadInventory === "function") await loadInventory();
      if (typeof loadPomiary === "function") await loadPomiary();
    }
  } catch (err) {
    console.error("[sync] syncPrioritizeBuilding nie dokonczyl sie:", buildingCode, err);
  } finally {
    if (bannerShown) syncHideBuildingProgress();
    await syncRenderStatus();
  }
}

function syncShowBuildingProgress(buildingCode, percent) {
  const el = document.getElementById("building-sync-banner");
  if (!el) return;
  el.textContent = `Ładowanie budynku ${buildingCode}… ${percent}%`;
  el.classList.remove("hidden");
}

function syncHideBuildingProgress() {
  const el = document.getElementById("building-sync-banner");
  if (el) el.classList.add("hidden");
}

// buildingCode (opcjonalny): doraznie dociaga markery/pomiary TYLKO tego
// budynku - uzywa WLASNEGO kursora (osobnego per budynek), zeby powtarzane
// wywolania (np. co tyk synchronizacji dla "ostatnich 3 budynkow" - patrz
// syncPull) byly przyrostowe/tanie, a nie za kazdym razem od zera. Nigdy nie
// dotyka globalnego kursora "syncPullCursor" - normalny, pelny przebieg w
// tle (ktory i tak kiedys dojdzie do tego budynku) zostaje nienaruszony.
// onProgress(done, total) - opcjonalny callback do paska postepu w UI;
// "total" to total_count z pierwszej strony odpowiedzi (null, jesli serwer
// go nie policzyl - np. stara wersja API).
// Zwraca true, jesli cokolwiek faktycznie przyszlo (uzyteczne do odswiezenia UI).
async function syncPullRecords(cfg, buildingCode = null, onProgress = null) {
  const db = await dbPromise;
  const cursorKey = buildingCode ? `syncPullCursor:${buildingCode}` : "syncPullCursor";
  let since = (await dbGetMeta(cursorKey)) || "1970-01-01 00:00:00.000000";
  let hasMore = true;
  let got = false;
  let done = 0;
  let total = null;
  while (hasMore) {
    const buildingParam = buildingCode ? `&building_code=${encodeURIComponent(buildingCode)}` : "";
    const res = await fetch(`${cfg.serverUrl}/api/sync/pull?since=${encodeURIComponent(since)}&limit=200${buildingParam}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return got;
    const body = await res.json();
    if (total === null && typeof body.total_count === "number") total = body.total_count;
    for (const item of body.items) {
      await syncApplyRemoteRecord(item);
      got = true;
      done++;
      if (onProgress) onProgress(done, total);
    }
    since = body.next_since;
    hasMore = body.has_more;
    await dbSetMeta(cursorKey, since);
  }
  if (onProgress) onProgress(total !== null ? total : done, total !== null ? total : done);
  return got;
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

  if (item.type !== "marker") {
    // pomiary/typy symboli: bez Kosza/Archiwum, zachowanie bez zmian.
    if (item.deleted) {
      await db.delete(store, item.id);
      return;
    }
    const record = { ...item.data, id: item.id, _syncUpdatedAt: item.updated_at, _updatedByDeviceName: item.updated_by_device_name || null };
    await db.put(store, record);
    return;
  }

  // Markery: usuniecie/archiwizacja to teraz STATUS na rekordzie, nie
  // zniknięcie - inaczej Kosz/Archiwum nie mialyby czego pokazac. Wyjatek:
  // "porzucony pusty szkic" (patrz closeMarkerPanel w app.js) nadal idzie
  // starym, generycznym mechanizmem push z deleted:true - to jedyny przypadek,
  // w ktorym prawdziwe znikniecie tutaj jest poprawne.
  const existing = await db.get(store, item.id);
  const record = {
    ...(existing || {}),
    ...item.data,
    id: item.id,
    buildingCode: item.building_code,
    deletedAt: item.deleted ? item.updated_at : null,
    archivedAt: item.archived ? item.updated_at : null,
    pendingAction: item.pending_action || null,
    pendingByDeviceName: item.pending_by_device_name || null,
    pendingAt: item.pending_at || null,
    _syncUpdatedAt: item.updated_at,
    _updatedByDeviceName: item.updated_by_device_name || null,
    photos: (existing && existing.photos) || [],
  };
  if (!record.planKey) record.planKey = planKeyOf(record.buildingCode, record.planFile);
  await db.put(store, record);
}

// buildingCode (opcjonalny): jak w syncPullRecords - doraznie dociaga plany
// TYLKO tego budynku, z wlasnym, osobnym kursorem (patrz komentarz przy
// syncPullRecords). onProgress(done, total) - jak w syncPullRecords.
async function syncPullPlans(cfg, buildingCode = null, onProgress = null) {
  const db = await dbPromise;
  const cursorKey = buildingCode ? `syncPlansCursor:${buildingCode}` : "syncPlansCursor";
  let since = (await dbGetMeta(cursorKey)) || "1970-01-01 00:00:00.000000";
  let hasMore = true;
  let done = 0;
  let total = null;
  while (hasMore) {
    const buildingParam = buildingCode ? `&building_code=${encodeURIComponent(buildingCode)}` : "";
    const res = await fetch(`${cfg.serverUrl}/api/plans?since=${encodeURIComponent(since)}&limit=50${buildingParam}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return done > 0;
    const body = await res.json();
    if (total === null && typeof body.total_count === "number") total = body.total_count;
    for (const p of body.items) {
      if (!p.deleted && p.file_key) {
        done++;
        syncSetProgress(`Pobieram plany budynków… (${done})`);
        if (onProgress) onProgress(done, total);
        const ok = await syncFetchAndStorePlan(cfg, p);
        // Nie przesuwamy kursora za nieudany pobór (np. polaczenie padlo w
        // trakcie sciagania duzego pliku planu) - inaczej ten plan zostalby
        // pominiety NA ZAWSZE, bo kazda kolejna proba zaczynalaby sie juz za
        // nim. Zamiast tego przerywamy caly pull teraz; kolejna proba (powrot
        // online, powrot do appki, timer co 60s albo "Synchronizuj teraz")
        // zacznie od tego samego "since" i powtorzy caly pakiet - plany juz
        // zapisane lokalnie w tym przebiegu pomija blyskawicznie (sa juz pod
        // tym samym kluczem), wiec nic nie sciaga sie dwa razy.
        if (!ok) return done > 0;
      }
    }
    since = body.next_since;
    hasMore = body.has_more;
    await dbSetMeta(cursorKey, since);
  }
  if (onProgress) onProgress(total !== null ? total : done, total !== null ? total : done);
  // Tylko gdy faktycznie cos przyszlo (done > 0) - inaczej to walalo
  // bezwarunkowo po KAZDYM tiku synchronizacji (co 60s/online/powrot do karty),
  // co w loadBuildings()->loadPlans()->selectPlan() zamykalo panel edytowanego
  // punktu (i mogloby go skasowac jako "pusty", jesli notatka/zdjecie jeszcze
  // sie nie zdazyly zapisac) oraz resetowalo widok mapy - w trakcie zwyklego
  // wpisywania notatki albo dodawania kilku zdjec pod rzad.
  if (done > 0 && typeof loadBuildings === "function") await loadBuildings();
  return done > 0;
}

// Zwraca true, jesli plan jest juz bezpiecznie zapisany lokalnie (byl juz
// wczesniej albo wlasnie go zapisalismy), false przy jakimkolwiek bledzie
// sieci/serwera - patrz komentarz w syncPullPlans o tym, dlaczego to rozroznienie
// jest wazne (decyduje, czy wolno przesunac kursor pobierania dalej).
async function syncFetchAndStorePlan(cfg, p) {
  const db = await dbPromise;
  const key = planKeyOf(p.building_code, p.file_key);
  const existing = await db.get("planImages", key);
  if (existing) return true; // juz mamy ten plan lokalnie pod tym samym kluczem

  try {
    const res = await fetch(`${cfg.serverUrl}/api/plans/${p.id}/image`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!res.ok) return false;
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
    return true;
  } catch (err) {
    console.error("[sync] pobranie planu nie powiodlo sie:", p.building_code, p.file_key, err);
    return false;
  }
}

// buildingCode (opcjonalny): jak w syncPullRecords/syncPullPlans - doraznie
// dociaga zdjecia TYLKO markerow tego budynku, bez ruszania globalnego
// kursora "syncPhotosCursor".
// buildingCode (opcjonalny): jak w syncPullRecords - doraznie dociaga zdjecia
// TYLKO markerow tego budynku, z wlasnym, osobnym kursorem. onProgress(done,
// total) - jak w syncPullRecords.
async function syncPullPhotosMeta(cfg, buildingCode = null, onProgress = null) {
  const db = await dbPromise;
  const cursorKey = buildingCode ? `syncPhotosCursor:${buildingCode}` : "syncPhotosCursor";
  let since = (await dbGetMeta(cursorKey)) || "1970-01-01 00:00:00.000000";
  let hasMore = true;
  let done = 0;
  let total = null;
  while (hasMore) {
    const buildingParam = buildingCode ? `&building_code=${encodeURIComponent(buildingCode)}` : "";
    const res = await fetch(`${cfg.serverUrl}/api/photos?since=${encodeURIComponent(since)}&limit=100${buildingParam}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return done > 0;
    const body = await res.json();
    if (total === null && typeof body.total_count === "number") total = body.total_count;
    for (const p of body.items) {
      if (!p.deleted) {
        done++;
        syncSetProgress(`Pobieram zdjęcia… (${done})`);
        if (onProgress) onProgress(done, total);
        const ok = await syncFetchAndAttachPhoto(cfg, p);
        // Jak w syncPullPlans: bez tego kazde zdjecie, ktorego nie udalo sie
        // pobrac (padla siec w trakcie, albo marker jeszcze nie dotarl przez
        // inna kolejnosc synchronizacji) zostalby pominiety na zawsze, mimo
        // ze komentarz nizej mowil "dogonimy przy nastepnym pull" - bez tego
        // przerwania to nigdy sie nie dzialo, bo kursor byl juz za nim.
        if (!ok) return done > 0;
      }
    }
    since = body.next_since;
    hasMore = body.has_more;
    await dbSetMeta(cursorKey, since);
  }
  if (onProgress) onProgress(total !== null ? total : done, total !== null ? total : done);
  return done > 0;
}

// Jak syncFetchAndStorePlan: true = bezpiecznie zapisane/juz obecne, false =
// trzeba powtorzyc przy kolejnym pull (patrz syncPullPhotosMeta).
async function syncFetchAndAttachPhoto(cfg, p) {
  const db = await dbPromise;
  const marker = await db.get("markers", p.record_id);
  if (!marker) return false; // marker jeszcze nie dotarl (np. inna kolejnosc synchronizacji) - dogonimy przy nastepnym pull
  if ((marker.photos || []).some((ph) => ph.id === p.id)) return true;

  try {
    const res = await fetch(`${cfg.serverUrl}/api/photos/${p.id}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!res.ok) return false;
    const blob = await res.blob();

    const fresh = await db.get("markers", p.record_id);
    if (!fresh) return false;
    const photos = [...(fresh.photos || []), { id: p.id, blob, type: p.content_type, addedAt: p.updated_at, synced: true }];
    await db.put("markers", { ...fresh, photos });
    return true;
  } catch (err) {
    console.error("[sync] pobranie zdjecia nie powiodlo sie:", p.id, err);
    return false;
  }
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
    const restrictBuildings = await syncRestrictedBuildings();
    const scopeSuffix = restrictBuildings ? ` — tylko budynki: ${restrictBuildings.join(", ")}` : "";
    statusInfo.textContent = navigator.onLine
      ? `Status: zalogowany, online (${cfg.serverUrl})${scopeSuffix}`
      : `Status: zalogowany, offline - zmiany czekają w kolejce (${cfg.serverUrl})${scopeSuffix}`;
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
  syncWireServiceLinksUi();
  syncWireBuildingSyncLinksUi();
}

// --- Linki dla serwisantow (dostep bez logowania, jedna kategoria) ---

async function syncCreateServiceLink(label, category, expiresInDays) {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) throw new Error("Zaloguj się najpierw.");
  const res = await fetch(`${cfg.serverUrl}/api/service-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ label, category, expires_in_days: expiresInDays || null }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Błąd (HTTP ${res.status})`);
  return body;
}

async function syncListServiceLinks() {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) return [];
  const res = await fetch(`${cfg.serverUrl}/api/service-links`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) return [];
  const body = await res.json();
  return body.links || [];
}

async function syncRevokeServiceLink(id) {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) return;
  await fetch(`${cfg.serverUrl}/api/devices/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
}

// --- Zakladka Uprawnienia: konta-wlasciciele (GET /api/devices istnieje od
// dawna po stronie serwera, ale do tej pory PWA go nie wywolywalo w ogole -
// tylko linki serwisowe mialy swoj widok) + Kosz uprawnien (Przywroc). ---

// Zwraca tez current_device_id (juz dawno zwracane przez serwer, ale nigdy
// dotad nie uzywane) - zeby UI moglo oznaczyc/zablokowac usuniecie WLASNEGO,
// aktualnie uzywanego urzadzenia (natychmiastowe wylogowanie samego siebie).
async function syncListOwnerDevices() {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) return { devices: [], currentDeviceId: null };
  const res = await fetch(`${cfg.serverUrl}/api/devices`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) return { devices: [], currentDeviceId: null };
  const body = await res.json();
  return { devices: body.devices || [], currentDeviceId: body.current_device_id || null };
}

// Wspolna dla obu typow wierszy w zakladce Uprawnienia (konto-wlasciciel i
// link serwisowy) - to ten sam mechanizm co syncRevokeServiceLink, tylko z
// druga strona (przywroc zamiast odwolaj).
async function syncRestoreDevice(id) {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) return;
  await fetch(`${cfg.serverUrl}/api/devices/${id}/restore`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
}

function syncServiceLinkStatus(link) {
  if (link.revoked_at) return "odwołany";
  if (link.expires_at && new Date(link.expires_at.replace(" ", "T") + "Z") < new Date()) return "wygasł";
  return "aktywny";
}

async function syncRenderServiceLinks() {
  const listEl = document.getElementById("service-links-list");
  if (!listEl) return;
  const links = await syncListServiceLinks();
  listEl.innerHTML = "";
  if (!links.length) {
    listEl.textContent = "Brak utworzonych linków.";
    return;
  }
  for (const link of links) {
    const box = document.createElement("div");
    box.className = "sync-conflict-item";
    const status = syncServiceLinkStatus(link);
    const p1 = document.createElement("p");
    p1.innerHTML = `<strong>${link.device_name}</strong> — kategoria: ${link.restrict_category || "SERWIS"} — status: ${status}`;
    const p2 = document.createElement("p");
    p2.textContent =
      `Utworzono: ${new Date(link.created_at.replace(" ", "T") + "Z").toLocaleString("pl-PL")}` +
      (link.expires_at ? ` · Ważny do: ${new Date(link.expires_at.replace(" ", "T") + "Z").toLocaleDateString("pl-PL")}` : "") +
      (link.last_used_at ? ` · Ostatnio użyty: ${new Date(link.last_used_at.replace(" ", "T") + "Z").toLocaleString("pl-PL")}` : "");
    box.appendChild(p1);
    box.appendChild(p2);
    if (status === "aktywny") {
      const revokeBtn = document.createElement("button");
      revokeBtn.type = "button";
      revokeBtn.className = "danger";
      revokeBtn.textContent = "Wyłącz link";
      revokeBtn.addEventListener("click", async () => {
        if (!confirm(`Wyłączyć link "${link.device_name}"? Serwisant straci dostęp natychmiast.`)) return;
        await syncRevokeServiceLink(link.id);
        await syncRenderServiceLinks();
      });
      box.appendChild(revokeBtn);
    }
    listEl.appendChild(box);
  }
}

function syncWireServiceLinksUi() {
  const createBtn = document.getElementById("service-link-create-btn");
  if (!createBtn) return;

  createBtn.addEventListener("click", async () => {
    const label = document.getElementById("service-link-label").value.trim();
    const category = document.getElementById("service-link-category").value.trim() || "SERWIS";
    const expiresInput = document.getElementById("service-link-expires").value.trim();
    const expiresInDays = expiresInput ? Number(expiresInput) : null;
    if (!label) {
      alert("Podaj etykietę linku (np. nazwę firmy).");
      return;
    }
    createBtn.disabled = true;
    try {
      const result = await syncCreateServiceLink(label, category, expiresInDays);
      const url = `${window.location.origin}${window.location.pathname}?service=${result.token}`;
      const resultEl = document.getElementById("service-link-result");
      resultEl.innerHTML = "";
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.textContent = url;
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "secondary";
      copyBtn.textContent = "Kopiuj";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(url).catch(() => {});
      });
      resultEl.appendChild(document.createTextNode("Link gotowy: "));
      resultEl.appendChild(link);
      resultEl.appendChild(document.createTextNode(" "));
      resultEl.appendChild(copyBtn);
      document.getElementById("service-link-label").value = "";
      document.getElementById("service-link-expires").value = "";
      await syncRenderServiceLinks();
    } catch (err) {
      alert(err.message || "Nie udało się utworzyć linku.");
    } finally {
      createBtn.disabled = false;
    }
  });

  syncRenderServiceLinks();
}

// --- Linki synchronizacji budynkow (dostep bez logowania, PELNE uprawnienia
// ograniczone do wybranych budynkow - patrz komentarz przy SYNC_DEFAULT_SERVER_URL
// wyzej). Rewokacja to ten sam mechanizm co link serwisowy (DELETE /api/devices/{id}) -
// oba to po prostu wiersze w `devices`, wiec syncRevokeServiceLink dziala dla obu. ---

async function syncCreateBuildingSyncLink(label, buildings, expiresInDays) {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) throw new Error("Zaloguj się najpierw.");
  const res = await fetch(`${cfg.serverUrl}/api/building-sync-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ label, buildings, expires_in_days: expiresInDays || null }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Błąd (HTTP ${res.status})`);
  return body;
}

async function syncListBuildingSyncLinks() {
  const cfg = await syncGetConfig();
  if (!syncIsLoggedIn(cfg)) return [];
  const res = await fetch(`${cfg.serverUrl}/api/building-sync-links`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) return [];
  const body = await res.json();
  return body.links || [];
}

async function syncRenderBuildingSyncLinks() {
  const listEl = document.getElementById("building-sync-links-list");
  if (!listEl) return;
  const links = await syncListBuildingSyncLinks();
  listEl.innerHTML = "";
  if (!links.length) {
    listEl.textContent = "Brak utworzonych linków.";
    return;
  }
  for (const link of links) {
    const box = document.createElement("div");
    box.className = "sync-conflict-item";
    const status = syncServiceLinkStatus(link);
    const p1 = document.createElement("p");
    p1.innerHTML = `<strong>${link.device_name}</strong> — budynki: ${(link.buildings || []).join(", ")} — status: ${status}`;
    const p2 = document.createElement("p");
    p2.textContent =
      `Utworzono: ${new Date(link.created_at.replace(" ", "T") + "Z").toLocaleString("pl-PL")}` +
      (link.expires_at ? ` · Ważny do: ${new Date(link.expires_at.replace(" ", "T") + "Z").toLocaleDateString("pl-PL")}` : "") +
      (link.last_used_at ? ` · Ostatnio użyty: ${new Date(link.last_used_at.replace(" ", "T") + "Z").toLocaleString("pl-PL")}` : "");
    box.appendChild(p1);
    box.appendChild(p2);
    if (status === "aktywny") {
      const revokeBtn = document.createElement("button");
      revokeBtn.type = "button";
      revokeBtn.className = "danger";
      revokeBtn.textContent = "Wyłącz link";
      revokeBtn.addEventListener("click", async () => {
        if (!confirm(`Wyłączyć link "${link.device_name}"? Urządzenie straci dostęp natychmiast.`)) return;
        await syncRevokeServiceLink(link.id);
        await syncRenderBuildingSyncLinks();
      });
      box.appendChild(revokeBtn);
    }
    listEl.appendChild(box);
  }
}

// Checkboxy budynkow budowane z buildingsData (app.js) - lista budynkow, ktore
// TO urzadzenie ma juz lokalnie zsynchronizowane. Zaklada, ze administrator
// tworzacy link ma juz u siebie pelny komplet planow (normalny przypadek dla
// konta-wlasciciela bez wlasnych ograniczen).
function syncRenderBuildingCheckboxes() {
  const container = document.getElementById("building-sync-link-buildings");
  if (!container) return;
  container.innerHTML = "";
  for (const b of buildingsData) {
    const label = document.createElement("label");
    label.className = "building-sync-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = b.code;
    label.appendChild(input);
    label.appendChild(document.createTextNode(" " + (BUILDING_DISPLAY_NAMES[b.code] || b.name)));
    container.appendChild(label);
  }
}

function syncWireBuildingSyncLinksUi() {
  const createBtn = document.getElementById("building-sync-link-create-btn");
  if (!createBtn) return;

  syncRenderBuildingCheckboxes();

  createBtn.addEventListener("click", async () => {
    const label = document.getElementById("building-sync-link-label").value.trim();
    const buildings = Array.from(
      document.querySelectorAll("#building-sync-link-buildings input[type=checkbox]:checked")
    ).map((el) => el.value);
    const expiresInput = document.getElementById("building-sync-link-expires").value.trim();
    const expiresInDays = expiresInput ? Number(expiresInput) : null;
    if (!label) {
      alert("Podaj etykietę linku (np. nazwę urządzenia/lokalizacji).");
      return;
    }
    if (!buildings.length) {
      alert("Zaznacz przynajmniej jeden budynek.");
      return;
    }
    createBtn.disabled = true;
    try {
      const result = await syncCreateBuildingSyncLink(label, buildings, expiresInDays);
      const url = `${window.location.origin}${window.location.pathname}?buildingSync=${result.token}`;
      const resultEl = document.getElementById("building-sync-link-result");
      resultEl.innerHTML = "";
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.textContent = url;
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "secondary";
      copyBtn.textContent = "Kopiuj";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(url).catch(() => {});
      });
      resultEl.appendChild(document.createTextNode("Link gotowy: "));
      resultEl.appendChild(link);
      resultEl.appendChild(document.createTextNode(" "));
      resultEl.appendChild(copyBtn);
      document.getElementById("building-sync-link-label").value = "";
      document.getElementById("building-sync-link-expires").value = "";
      document
        .querySelectorAll("#building-sync-link-buildings input[type=checkbox]")
        .forEach((el) => (el.checked = false));
      await syncRenderBuildingSyncLinks();
    } catch (err) {
      alert(err.message || "Nie udało się utworzyć linku.");
    } finally {
      createBtn.disabled = false;
    }
  });

  syncRenderBuildingSyncLinks();
}

// syncMigrateLegacyIds() i start (syncWireUi/syncTryFlush/syncPull) sa wywolywane
// z init() w app.js, w konkretnej kolejnosci (migracja PRZED wczytaniem markerow) -
// zwykly listener DOMContentLoaded tutaj mogłby wystartować rownolegle z app.js
// i wyscigowo nadpisac markery w trakcie ich renderowania.
