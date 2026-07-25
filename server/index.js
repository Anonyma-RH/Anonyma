import { createApp } from "./app.js";
const service = createApp();
const server = service.app.listen(service.cfg.port, service.cfg.host, () =>
  console.log(
    `Anonyma service: http://${service.cfg.host}:${service.cfg.port} (${service.cfg.testMode ? "LOCAL TEST MODE" : "live mode; service configuration required"})`,
  ),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 30000);
    force.unref();
    // Stop accepting traffic, cancel generation and finish its accounting
    // while SQLite remains open; stop background polling before closing it.
    const drained = new Promise((resolve) => server.close(resolve));
    await service.stopWork();
    await drained;
    service.close();
    clearTimeout(force);
    process.exit(0);
  });
