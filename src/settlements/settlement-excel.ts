import { Worker } from 'node:worker_threads';
import * as XLSX from 'xlsx';
import { invalid, integer, account } from './settlement-policy';

export const uploadHeaders = [
  '입금은행',
  '입금계좌번호',
  '이체금액',
  '수취인',
  '입금통장표시내용',
  'CMS코드',
  '비고',
];
export const downloadHeaders = [
  '입금은행',
  '입금계좌번호',
  '입금액',
  '예상예금주',
  '입금통장표시',
  '출금통장표시',
  '메모',
  'CMS코드',
  '받는분 휴대폰번호',
];
export const maxFileBytes = 5 * 1024 * 1024;
const maxRows = 10_000;
let runningParsers = 0;

export type TransferRow = {
  bank: string;
  account: string;
  amount: number;
  reference: string;
};
export type ExportRow = {
  bank_code: string;
  account_number: string;
  mileage_amount: number;
  account_holder: string;
  reference: string;
};

export function exportWorkbook(rows: ExportRow[]): Buffer {
  if (!rows.length || rows.length > maxRows) invalid('SETTLEMENT_EXPORT_EMPTY');
  const sheet = XLSX.utils.aoa_to_sheet([
    downloadHeaders,
    ...rows.map((row) => [
      row.bank_code.padStart(3, '0'),
      row.account_number,
      String(integer(row.mileage_amount)),
      row.account_holder,
      '',
      '',
      '',
      row.reference,
      '',
    ]),
  ]);
  for (const [key, value] of Object.entries(sheet))
    if (!key.startsWith('!')) (value as XLSX.CellObject).z = '@';
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }) as Buffer;
}

// Parse untrusted workbooks outside the HTTP event loop, with memory/time/row limits.
const parser = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
try {
  const X = require(workerData.module);
  const bytes = Buffer.from(workerData.bytes);
  const wb = X.read(bytes, { type: 'buffer', cellFormula: true, cellHTML: false, bookVBA: true, bookFiles: true, sheetRows: workerData.maxRows + 2 });
  if (wb.vbaraw || wb.keys?.some(k => /externalLinks|vbaProject|macrosheets|dialogsheets|embeddings|connections\.xml/i.test(k)) || (wb.Workbook?.Names || []).some(n => /\[|https?:|file:|DDE/i.test(n.Ref || ''))) throw 0;
  if (wb.cfb) {
    const stream = wb.cfb.FileIndex.find(f => /^(Workbook|Book)$/.test(f.name));
    if (!stream) throw 0;
    const b = Buffer.from(stream.content);
    for (let p = 0; p + 4 <= b.length;) {
      const id = b.readUInt16LE(p), len = b.readUInt16LE(p + 2); p += 4;
      if (p + len > b.length) throw 0;
      if (id === 0x01ae && (len < 4 || b.readUInt16LE(p + 2) !== 0x0401)) throw 0;
      if (id === 0x0085 && len >= 6 && b[p + 5] !== 0) throw 0;
      if (id === 0x0006 || id === 0x0221 || id === 0x01b8) throw 0;
      p += len;
    }
  }
  if (!wb.SheetNames.length || wb.SheetNames.length > 8) throw 0;
  const sheet = wb.Sheets[wb.SheetNames[0]];
  for (const [i, name] of wb.SheetNames.entries()) {
    const s = wb.Sheets[name];
    const range = X.utils.decode_range(s['!fullref'] || s['!ref'] || 'A1');
    if (range.e.r > workerData.maxRows || range.e.c > 6 || s['!merges']?.length || wb.Workbook?.Sheets?.[i]?.Hidden) throw 0;
    for (const [key, cell] of Object.entries(s)) if (!key.startsWith('!')) {
      if (cell.f || cell.F || cell.l || cell.t === 'e' || (i > 0 && cell.v !== undefined && cell.v !== '')) throw 0;
    }
  }
  parentPort.postMessage(X.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: false }));
} catch { parentPort.postMessage(null); }
`;

export async function importWorkbook(bytes: Buffer): Promise<TransferRow[]> {
  if (
    !bytes.length ||
    bytes.length > maxFileBytes ||
    (!bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) &&
      !bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')))
  )
    invalid();
  if (runningParsers >= 2) invalid('SETTLEMENT_IMPORT_BUSY');
  runningParsers++;
  let data: unknown;
  try {
    data = await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(parser, {
        eval: true,
        workerData: { bytes, module: require.resolve('xlsx'), maxRows },
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('Workbook timeout'));
      }, 10_000);
      worker.once('message', (value: unknown) => {
        clearTimeout(timer);
        void worker.terminate();
        resolve(value);
      });
      worker.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Workbook worker exited'));
      });
    });
  } catch {
    invalid();
  } finally {
    runningParsers--;
  }
  if (
    !Array.isArray(data) ||
    data.length < 2 ||
    data.length > maxRows + 1 ||
    JSON.stringify(data[0]) !== JSON.stringify(uploadHeaders)
  )
    invalid();
  return (data as unknown[][]).slice(1).map((row) => {
    if (
      row.length !== 7 ||
      row.some((cell) => typeof cell !== 'string' && typeof cell !== 'number')
    )
      invalid();
    const bank = String(row[0]).trim();
    if (!bank || bank.length > 50) invalid();
    const reference = row[5] === '' ? '' : String(row[5]);
    if (reference && !/^\d{10}$/.test(reference)) invalid();
    return {
      bank,
      account: account(row[1]),
      amount: integer(row[2]),
      reference,
    };
  });
}
