// Selected immutable workspace bytes are handed to Chromium, never host paths.
// Only requests carrying those bytes receive the larger upload-body allowance.
export class WebUploads {
  constructor(page, dom) { this.page = page; this.dom = dom; this.selected = new Map(); }
  async select(elementId, file, wait_ms = 300) {
    await file.assertAccess();
    const handle = await this.dom.resolve(elementId);
    const input = await handle.evaluate(node => node.tagName === 'INPUT' && node.type === 'file');
    const payload = { name: file.name, mimeType: file.mimeType, buffer: file.bytes };
    const previous = this.selected.get(elementId);
    this.selected.set(elementId, file);
    try {
      if (input) { await file.assertAccess(); await handle.setInputFiles(payload); }
      else {
        // Own the event listener so failed clicks/closure leave no pending waiter.
        let timer, choose, closed;
        const chooser = new Promise((accept, reject) => {
          choose = accept;
          timer = setTimeout(() => reject(new Error('WEB_UPLOAD_CHOOSER_TIMEOUT')), 10000);
          closed = () => reject(new Error('WEB_PAGE_CLOSED'));
          this.page.on('filechooser', choose); this.page.on('close', closed);
        });
        void chooser.catch(() => {});
        try {
          await handle.click();
          const selected = await chooser;
          await file.assertAccess(); await selected.setFiles(payload);
        } finally { clearTimeout(timer); this.page.off('filechooser', choose); this.page.off('close', closed); }
      }
      await this.page.waitForTimeout(Math.max(150, wait_ms));
      await file.assertAccess();
      return { selected: true, upload_confirmed: false,
        limitation: 'The file was selected. The website may upload immediately or require submission; inspect the returned page state before claiming success. Never repeat an uncertain upload automatically.' };
    } catch (error) {
      if (previous) this.selected.set(elementId, previous); else this.selected.delete(elementId);
      throw error;
    }
  }
  async request(body) {
    if (!body?.length) return {};
    const matches = [...this.selected.values()].filter(file => file.bytes.length && body.includes(file.bytes));
    if (!matches.length) return {};
    const maxBodyBytes = Math.max(65536, ...matches.map(file => file.bytes.length + 1024 * 1024));
    const beforeRequest = async () => { for (const file of matches) await file.assertAccess(); };
    await beforeRequest();
    return { maxBodyBytes, beforeRequest };
  }
  close() { this.selected.clear(); }
}
