const ADAPTER_METHODS = ["open", "backup"];
const CONNECTION_METHODS = [
  "all",
  "close",
  "exec",
  "get",
  "integrityCheck",
  "run",
  "transaction",
];

export function assertStorageAdapter(adapter) {
  if (adapter == null || typeof adapter !== "object") {
    throw new TypeError("storage adapter must be an object");
  }
  if (typeof adapter.name !== "string" || adapter.name.length === 0) {
    throw new TypeError("storage adapter must have a name");
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new TypeError(`storage adapter ${adapter.name} is missing ${method}()`);
    }
  }
  return adapter;
}

export function assertStorageConnection(connection, adapterName = "unknown") {
  if (connection == null || typeof connection !== "object") {
    throw new TypeError(`${adapterName} open() must return a connection object`);
  }
  for (const method of CONNECTION_METHODS) {
    if (typeof connection[method] !== "function") {
      throw new TypeError(`${adapterName} connection is missing ${method}()`);
    }
  }
  return connection;
}

export function openStorage(adapter, databasePath) {
  assertStorageAdapter(adapter);
  return assertStorageConnection(adapter.open(databasePath), adapter.name);
}
