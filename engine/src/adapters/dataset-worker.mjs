import { parentPort, workerData } from 'node:worker_threads';
import { DatasetAdapter } from './local-services.mjs';
try {
  const result = await new DatasetAdapter(workerData.directory).query(
    workerData.actor,
    workerData.payload,
  );
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
