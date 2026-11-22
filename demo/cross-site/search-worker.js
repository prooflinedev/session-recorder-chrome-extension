// demo/cross-site/search-worker.js: a dedicated worker that runs the order
// search. Its request and its exception belong to the worker, not the page.
self.onmessage = async (e) => {
  const res = await fetch(`/api/search?q=${encodeURIComponent(e.data.query)}`);
  self.postMessage(`Search returned ${res.status}`);
  throw new Error(`Search index unavailable (HTTP ${res.status})`);
};
