import { openStore } from "../dist/store.js";

let store;
try {
  store = openStore({ directory: process.argv[2], clock: () => 1_000 });
  process.send({ status: "locked" });
  process.on("message", (message) => {
    if (message === "close") {
      store.close();
      process.disconnect();
    }
  });
} catch (error) {
  process.send({ status: "refused", code: error.code });
  process.disconnect();
}
