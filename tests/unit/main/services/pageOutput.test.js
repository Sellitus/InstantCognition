// pageOutput — Print and Save as PDF for a guest page. Electron (dialog, app,
// the guest webContents and the main window) is the mocked boundary; the PDF
// is written to a real temp directory so the atomic write is exercised for real.

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({
  dialog: { showSaveDialog: jest.fn() },
  app: { getPath: jest.fn(() => '/downloads') },
}));

const { dialog, app } = require('electron');
const pageOutput = require('../../../../main/services/pageOutput');

const PDF = Buffer.from('%PDF-1.7 test bytes');

function makeWindow() {
  return { isDestroyed: jest.fn(() => false), webContents: { send: jest.fn() } };
}

function makeContents(overrides = {}) {
  return {
    isDestroyed: jest.fn(() => false),
    getTitle: jest.fn(() => 'Example Domain'),
    print: jest.fn((_opts, cb) => cb(true, '')),
    printToPDF: jest.fn(() => Promise.resolve(PDF)),
    ...overrides,
  };
}

const failures = (win) => win.webContents.send.mock.calls.filter((c) => c[0] === 'page:action-failed');

let tmpDir;
let errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pageoutput-'));
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('printPage', () => {
  test('opens the print dialog for the page and reports nothing on success', async () => {
    const win = makeWindow();
    const contents = makeContents();
    await expect(pageOutput.printPage(contents, win)).resolves.toBe(true);
    expect(contents.print).toHaveBeenCalledWith({}, expect.any(Function));
    expect(failures(win)).toEqual([]);
  });

  test('a failed print job is logged and reported with its reason', async () => {
    const win = makeWindow();
    const contents = makeContents({ print: jest.fn((_o, cb) => cb(false, 'Invalid printer settings')) });
    await expect(pageOutput.printPage(contents, win)).resolves.toBe(false);
    expect(failures(win)).toEqual([['page:action-failed', { title: 'Print', message: 'Printing failed: Invalid printer settings.' }]]);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('the user cancelling the print dialog is not reported as an error', async () => {
    const win = makeWindow();
    const contents = makeContents({ print: jest.fn((_o, cb) => cb(false, 'Print job canceled')) });
    await expect(pageOutput.printPage(contents, win)).resolves.toBe(false);
    expect(failures(win)).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('print throwing synchronously is reported', async () => {
    const win = makeWindow();
    const contents = makeContents({ print: jest.fn(() => { throw new Error('no printing backend'); }) });
    await expect(pageOutput.printPage(contents, win)).resolves.toBe(false);
    expect(failures(win)[0][1].message).toContain('no printing backend');
  });

  test.each([
    ['missing', null],
    ['destroyed', { isDestroyed: () => true, print: jest.fn() }],
  ])('a %s page is reported instead of printed', async (_label, contents) => {
    const win = makeWindow();
    await expect(pageOutput.printPage(contents, win)).resolves.toBe(false);
    expect(failures(win)).toEqual([['page:action-failed', { title: 'Print', message: 'There is no open page to print.' }]]);
    if (contents) expect(contents.print).not.toHaveBeenCalled();
  });

  test('a destroyed main window still logs the failure without throwing', async () => {
    const win = makeWindow();
    win.isDestroyed.mockReturnValue(true);
    await expect(pageOutput.printPage(null, win)).resolves.toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('savePageAsPdf', () => {
  test('suggests a file named after the page title and writes the PDF there', async () => {
    const win = makeWindow();
    const target = path.join(tmpDir, 'Example Domain.pdf');
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    const contents = makeContents();
    await expect(pageOutput.savePageAsPdf(contents, win)).resolves.toBe(true);
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(win, expect.objectContaining({
      defaultPath: path.join('/downloads', 'Example Domain.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }));
    expect(app.getPath).toHaveBeenCalledWith('downloads');
    expect(contents.printToPDF).toHaveBeenCalledWith({});
    expect(fs.readFileSync(target)).toEqual(PDF);
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
    expect(failures(win)).toEqual([]);
  });

  test('strips characters a file name cannot hold and falls back when the title is empty', async () => {
    const win = makeWindow();
    dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
    await pageOutput.savePageAsPdf(makeContents({ getTitle: () => 'a/b:c*?"<>|  d\n' }), win);
    expect(dialog.showSaveDialog.mock.calls[0][1].defaultPath).toBe(path.join('/downloads', 'a b c d.pdf'));
    await pageOutput.savePageAsPdf(makeContents({ getTitle: () => '  ' }), win);
    expect(dialog.showSaveDialog.mock.calls[1][1].defaultPath).toBe(path.join('/downloads', 'page.pdf'));
  });

  test('appends .pdf when the chosen name has no extension', async () => {
    const win = makeWindow();
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(tmpDir, 'report') });
    await expect(pageOutput.savePageAsPdf(makeContents(), win)).resolves.toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'report.pdf'))).toEqual(PDF);
  });

  test('a dotless name whose .pdf file exists asks again on the real name instead of overwriting it', async () => {
    const win = makeWindow();
    const existing = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(existing, 'keep me');
    dialog.showSaveDialog
      .mockResolvedValueOnce({ canceled: false, filePath: path.join(tmpDir, 'report') })
      .mockResolvedValueOnce({ canceled: false, filePath: path.join(tmpDir, 'report-2.pdf') });
    await expect(pageOutput.savePageAsPdf(makeContents(), win)).resolves.toBe(true);
    expect(dialog.showSaveDialog).toHaveBeenCalledTimes(2);
    expect(dialog.showSaveDialog.mock.calls[1][1].defaultPath).toBe(existing);
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep me');
    expect(fs.readFileSync(path.join(tmpDir, 'report-2.pdf'))).toEqual(PDF);
  });

  test('confirming the full .pdf name on the second ask replaces the file', async () => {
    const existing = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(existing, 'old');
    dialog.showSaveDialog
      .mockResolvedValueOnce({ canceled: false, filePath: path.join(tmpDir, 'report') })
      .mockResolvedValueOnce({ canceled: false, filePath: existing });
    await expect(pageOutput.savePageAsPdf(makeContents(), makeWindow())).resolves.toBe(true);
    expect(fs.readFileSync(existing)).toEqual(PDF);
  });

  test('a second dotless name that collides again is refused and reported, never written', async () => {
    const win = makeWindow();
    const existing = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(existing, 'keep me');
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(tmpDir, 'report') });
    await expect(pageOutput.savePageAsPdf(makeContents(), win)).resolves.toBe(false);
    expect(dialog.showSaveDialog).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep me');
    expect(failures(win)).toEqual([['page:action-failed', {
      title: 'Save as PDF', message: expect.stringContaining('report.pdf already exists'),
    }]]);
  });

  test('cancelling the second ask writes nothing and reports nothing', async () => {
    const win = makeWindow();
    fs.writeFileSync(path.join(tmpDir, 'report.pdf'), 'keep me');
    dialog.showSaveDialog
      .mockResolvedValueOnce({ canceled: false, filePath: path.join(tmpDir, 'report') })
      .mockResolvedValueOnce({ canceled: true, filePath: '' });
    await expect(pageOutput.savePageAsPdf(makeContents(), win)).resolves.toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'report.pdf'), 'utf8')).toBe('keep me');
    expect(failures(win)).toEqual([]);
  });

  test('cancelling the save dialog writes nothing and reports nothing', async () => {
    const win = makeWindow();
    dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
    const contents = makeContents();
    await expect(pageOutput.savePageAsPdf(contents, win)).resolves.toBe(false);
    expect(contents.printToPDF).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(failures(win)).toEqual([]);
  });

  test('a page that cannot be rendered to PDF is reported', async () => {
    const win = makeWindow();
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(tmpDir, 'x.pdf') });
    const contents = makeContents({ printToPDF: jest.fn(() => Promise.reject(new Error('render crashed'))) });
    await expect(pageOutput.savePageAsPdf(contents, win)).resolves.toBe(false);
    expect(failures(win)).toEqual([['page:action-failed', {
      title: 'Save as PDF', message: 'Could not render the page as PDF: render crashed.',
    }]]);
    expect(fs.existsSync(path.join(tmpDir, 'x.pdf'))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('a write failure is reported with the file name', async () => {
    const win = makeWindow();
    const blocker = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(blocker, 'out.pdf') });
    await expect(pageOutput.savePageAsPdf(makeContents(), win)).resolves.toBe(false);
    const [[, payload]] = failures(win);
    expect(payload.title).toBe('Save as PDF');
    expect(payload.message).toMatch(/^Could not save out\.pdf: /);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('a save dialog that throws is reported', async () => {
    const win = makeWindow();
    dialog.showSaveDialog.mockRejectedValue(new Error('portal unavailable'));
    await expect(pageOutput.savePageAsPdf(makeContents(), win)).resolves.toBe(false);
    expect(failures(win)[0][1].message).toContain('portal unavailable');
  });

  test('a missing page is reported and no dialog opens', async () => {
    const win = makeWindow();
    await expect(pageOutput.savePageAsPdf(null, win)).resolves.toBe(false);
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(failures(win)).toEqual([['page:action-failed', { title: 'Save as PDF', message: 'There is no open page to save.' }]]);
  });
});
