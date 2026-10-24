// Print and Save as PDF for a guest page. Shared by the app menu (the renderer
// resolves the active tab) and the page context menu. Every failure is logged
// and sent to the renderer as 'page:action-failed', which shows it as a toast.

const fs = require('fs');
const path = require('path');
const { dialog, app } = require('electron');
const { writeFileAtomic } = require('../../shared/atomicWrite');
const { errMsg } = require('../../shared/errMsg');

const PRINT = 'Print';
const SAVE_PDF = 'Save as PDF';
// Electron reports a print dialog the user dismissed as this failure reason.
const PRINT_CANCELED = 'Print job canceled';

/**
 * @param {Electron.BrowserWindow | null | undefined} win
 * @param {string} title
 * @param {string} message
 */
function reportFailure(win, title, message) {
  console.error(`[pageOutput] ${title}: ${message}`);
  if (win && !win.isDestroyed()) win.webContents.send('page:action-failed', { title, message });
}

/** @param {Electron.WebContents | null | undefined} contents */
function isOpen(contents) {
  return !!contents && !contents.isDestroyed();
}

/** @param {string} title */
function pdfFileName(title) {
  const base = String(title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${base || 'page'}.pdf`;
}

/**
 * @param {Electron.WebContents | null | undefined} contents
 * @param {Electron.BrowserWindow | null | undefined} win
 * @returns {Promise<boolean>} true when the page was sent to the printer
 */
function printPage(contents, win) {
  if (!isOpen(contents)) {
    reportFailure(win, PRINT, 'There is no open page to print.');
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      contents.print({}, (success, failureReason) => {
        if (!success && failureReason !== PRINT_CANCELED) {
          reportFailure(win, PRINT, `Printing failed: ${failureReason || 'unknown error'}.`);
        }
        resolve(success);
      });
    } catch (err) {
      reportFailure(win, PRINT, `Printing failed: ${errMsg(err)}.`);
      resolve(false);
    }
  });
}

/**
 * The dialog confirms an overwrite only for the name as typed, so a name
 * without .pdf whose .pdf file exists is asked for again under that full name.
 * @param {Electron.BrowserWindow | null | undefined} win
 * @param {string} defaultPath
 * @returns {Promise<string | null>} the path to write, or null (cancelled or reported)
 */
async function choosePdfPath(win, defaultPath) {
  let suggested = defaultPath;
  for (let ask = 0; ask < 2; ask += 1) {
    /** @type {Electron.SaveDialogOptions} */
    const options = { title: 'Save Page as PDF', defaultPath: suggested, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
    let choice;
    try {
      choice = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    } catch (err) {
      reportFailure(win, SAVE_PDF, `Could not open the save dialog: ${errMsg(err)}.`);
      return null;
    }
    if (choice.canceled || !choice.filePath) return null;
    if (/\.pdf$/i.test(choice.filePath)) return choice.filePath;
    suggested = `${choice.filePath}.pdf`;
    if (!fs.existsSync(suggested)) return suggested;
  }
  reportFailure(win, SAVE_PDF, `${path.basename(suggested)} already exists. Choose it by its full name to replace it, or pick another name.`);
  return null;
}

/**
 * @param {Electron.WebContents | null | undefined} contents
 * @param {Electron.BrowserWindow | null | undefined} win
 * @returns {Promise<boolean>} true when the PDF was written
 */
async function savePageAsPdf(contents, win) {
  if (!isOpen(contents)) {
    reportFailure(win, SAVE_PDF, 'There is no open page to save.');
    return false;
  }
  const filePath = await choosePdfPath(win, path.join(app.getPath('downloads'), pdfFileName(contents.getTitle())));
  if (!filePath) return false;

  let pdf;
  try {
    pdf = await contents.printToPDF({});
  } catch (err) {
    reportFailure(win, SAVE_PDF, `Could not render the page as PDF: ${errMsg(err)}.`);
    return false;
  }
  try {
    // writeFileSync takes the Buffer as-is; atomicWrite's JSDoc only names string.
    writeFileAtomic(fs, filePath, /** @type {any} */ (pdf));
  } catch (err) {
    reportFailure(win, SAVE_PDF, `Could not save ${path.basename(filePath)}: ${errMsg(err)}.`);
    return false;
  }
  return true;
}

module.exports = { printPage, savePageAsPdf };
