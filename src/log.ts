export type Log = (entry: Record<string, unknown>) => void;
// Callers pass operational metadata only, never request bodies or upstream errors.
export const createLogger =
  (service: string): Log =>
  (entry) =>
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        ...entry,
        service,
      }),
    );
export const log = createLogger("triagekit");
