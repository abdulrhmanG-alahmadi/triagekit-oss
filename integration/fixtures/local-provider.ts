// Keep the real worker entrypoint and HTTP client; route only its provider request locally.
const fetchProvider = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (input !== "https://openrouter.ai/api/v1/chat/completions")
    throw new Error("Unexpected worker fetch in process test");
  return fetchProvider(process.env.TEST_PROVIDER_URL!, init);
}) as typeof fetch;
