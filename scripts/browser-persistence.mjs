export function installBrowserPersistenceAudit() {
  const evidence = { mutations: [], instrumentationErrors: [] };
  Object.defineProperty(window, "__wildbloomPersistenceEvidence", {
    configurable: false,
    value: evidence,
  });

  const instrument = (target, method, label) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, method);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) {
      evidence.instrumentationErrors.push(label);
      return;
    }
    const original = descriptor.value;
    Object.defineProperty(target, method, {
      ...descriptor,
      value(...arguments_) {
        evidence.mutations.push(label);
        return Reflect.apply(original, this, arguments_);
      },
    });
  };

  for (const method of ["setItem", "removeItem", "clear"]) {
    instrument(Storage.prototype, method, `Storage.${method}`);
  }
  const cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (!cookieDescriptor || typeof cookieDescriptor.set !== "function" || !cookieDescriptor.configurable) {
    evidence.instrumentationErrors.push("document.cookie");
  } else {
    Object.defineProperty(Document.prototype, "cookie", {
      ...cookieDescriptor,
      set(value) {
        evidence.mutations.push("document.cookie");
        cookieDescriptor.set.call(this, value);
      },
    });
  }
  if (typeof IDBFactory !== "undefined") {
    for (const method of ["open", "deleteDatabase"]) instrument(IDBFactory.prototype, method, `IndexedDB.${method}`);
  }
  if (globalThis.caches) {
    const cacheStoragePrototype = Object.getPrototypeOf(globalThis.caches);
    for (const method of ["open", "delete"]) instrument(cacheStoragePrototype, method, `CacheStorage.${method}`);
  }
  if (navigator.serviceWorker) {
    instrument(Object.getPrototypeOf(navigator.serviceWorker), "register", "ServiceWorker.register");
  }
}

export async function assertNoBrowserPersistence(page, context, label) {
  const state = await page.evaluate(async () => ({
    evidence: window.__wildbloomPersistenceEvidence ?? null,
    localStorageLength: globalThis.localStorage.length,
    sessionStorageLength: globalThis.sessionStorage.length,
    visibleCookie: document.cookie,
    indexedDatabases: typeof globalThis.indexedDB.databases === "function"
      ? (await globalThis.indexedDB.databases()).length
      : null,
    cacheEntries: globalThis.caches ? (await globalThis.caches.keys()).length : null,
    serviceWorkers: navigator.serviceWorker
      ? (await navigator.serviceWorker.getRegistrations()).length
      : null,
  }));
  const contextCookies = await context.cookies();
  const failures = [];
  if (!state.evidence) failures.push("the mutation audit was not installed");
  else {
    if (state.evidence.instrumentationErrors.length > 0) {
      failures.push(`mutation instrumentation unavailable for ${state.evidence.instrumentationErrors.join(", ")}`);
    }
    if (state.evidence.mutations.length > 0) {
      failures.push(`persistent APIs were mutated (${state.evidence.mutations.join(", ")})`);
    }
  }
  if (state.localStorageLength !== 0) failures.push(`localStorage has ${state.localStorageLength} entries`);
  if (state.sessionStorageLength !== 0) failures.push(`sessionStorage has ${state.sessionStorageLength} entries`);
  if (state.visibleCookie !== "") failures.push("document.cookie is not empty");
  if (state.indexedDatabases === null) failures.push("IndexedDB enumeration is unavailable");
  else if (state.indexedDatabases !== 0) failures.push(`IndexedDB has ${state.indexedDatabases} databases`);
  if (state.cacheEntries === null) failures.push("Cache Storage enumeration is unavailable");
  else if (state.cacheEntries !== 0) failures.push(`Cache Storage has ${state.cacheEntries} entries`);
  if (state.serviceWorkers === null) failures.push("service-worker enumeration is unavailable");
  else if (state.serviceWorkers !== 0) failures.push(`${state.serviceWorkers} service workers are registered`);
  if (contextCookies.length !== 0) failures.push(`the browser context has ${contextCookies.length} cookies`);
  if (failures.length > 0) throw new Error(`${label} retained browser state: ${failures.join("; ")}.`);
}
