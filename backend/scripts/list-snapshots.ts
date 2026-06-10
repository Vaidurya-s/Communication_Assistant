import { listSnapshots, getSnapshotDir } from "../src/snapshots.js";

const entries = listSnapshots();
if (entries.length === 0) {
  console.log(`No snapshots in ${getSnapshotDir()}`);
  process.exit(0);
}

console.log(`${entries.length} snapshot(s) in ${getSnapshotDir()}\n`);
for (const e of entries) {
  const stamp = e.capturedAt ?? e.savedAt;
  const anomalies = e.anomalies.length > 0 ? `anomalies=[${e.anomalies.join(",")}]` : "anomalies=none";
  const msgs = e.messagesFound !== null ? `msgs=${e.messagesFound}` : "msgs=?";
  const kb = (e.bytes / 1024).toFixed(1);
  console.log(`  ${stamp}  ${e.filename}  ${kb}KB  ${msgs}  ${anomalies}`);
  if (e.pageTitle) console.log(`    title: ${e.pageTitle}`);
}
