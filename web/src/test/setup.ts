// Every test starts with empty browser storage and no stubbed globals.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
