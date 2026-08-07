import { runThreadPersistenceContractSuite } from "./testing/contract-suite.js";
import { InMemoryThreadPersistence } from "./in-memory.js";

runThreadPersistenceContractSuite("InMemoryThreadPersistence", async () => ({
  port: new InMemoryThreadPersistence(),
}));
