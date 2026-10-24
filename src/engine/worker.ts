/*
File purpose: Serialize engine requests and forward incremental indexing progress to the extension host.
*/
import { parentPort } from 'node:worker_threads';
import { CsvFile } from './CsvFile';
import type { WorkerRequest, WorkerResponse, EngineResult } from '../protocol';

if (!parentPort) throw new Error('The CSV engine must run in a worker.');
const port = parentPort;
let file: CsvFile | undefined;
let queue = Promise.resolve();
const send = (message: WorkerResponse) => port.postMessage(message);
port.on('message', (request: WorkerRequest) => {
  queue = queue.then(async () => {
    try {
      let result: EngineResult;
      if (request.method === 'open') {
        await file?.dispose();
        file = new CsvFile(request.path, data => send({ event: 'metadata', data }), error => send({ event: 'error', message: error.message }), { hasHeader: request.hasHeader, format: request.format });
        result = await file.open();
      } else {
        if (!file) throw new Error('Open a CSV file first.');
        switch (request.method) {
          case 'configure': result = await file.configure(request.format); break;
          case 'change': result = await file.change(request.operation); break;
          case 'restore': result = await file.restore(request.token); break;
          case 'search': result = await file.search(request.options); break;
          case 'check': result = await file.check(request.options); break;
          case 'distinct': result = await file.distinct(request.col); break;
          case 'locate': result = await file.locate(request.row); break;
          case 'textPage': result = await file.textPage(request.start, request.count); break;
          case 'textEdit': result = await file.textEdit(request.edit); break;
          case 'page': result = await file.page(request.start, request.count); break;
          case 'copy': result = await file.copy(request.start, request.count, request.columns, request.ranges, request.cells, request.includeHeaders); break;
          case 'stats': result = await file.stats(request.start, request.count, request.columns, request.ranges, request.cells); break;
          case 'query': result = await file.query(request.query); break;
          case 'pinRows': result = await file.pinRows(request.rows); break;
          case 'edit': result = await file.edit(request.edit); break;
          case 'save': result = await file.save(request.target, request.options); break;
          case 'reload': result = await file.reload(); break;
        }
      }
      send({ id: request.id, result });
    } catch (error) {
      send({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
