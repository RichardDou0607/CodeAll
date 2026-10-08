// Minimal event-capable DOM for the self-contained window/mini regression scripts.
export function createUiSandbox(html) {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const store = new Map(), preferences = new Map(), requests = [];
  const eventTarget = base => Object.assign(base, {
    __h: {},
    addEventListener(type, fn) { (this.__h[type] ||= []).push(fn); },
    async dispatch(type, event = {}) {
      const ev = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
      if (this['on' + type]) await this['on' + type](ev);
      for (const fn of this.__h[type] || []) await fn(ev);
    },
  });
  const element = (id = '', attrs = {}) => eventTarget({
    id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    disabled: false, hidden: false, title: '', open: false, attrs,
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    closest(selector) { return selector.startsWith('[') && selector.slice(1, -1) in this.attrs ? this : null; },
    focus() { this.focused = true; }, scrollIntoView() {},
    showModal() { this.open = true; }, close() { this.open = false; },
  });
  const getEl = id => {
    if (!ids.has(id)) throw new Error('Unknown HTML element: ' + id);
    if (!store.has(id)) store.set(id, element(id));
    return store.get(id);
  };
  const themes = ['dark', 'light', 'system'].map(mode => element('', { 'data-theme-mode': mode }));
  const media = eventTarget({ matches: false });
  const document = eventTarget({
    documentElement: { dataset: {} }, getElementById: getEl,
    querySelectorAll(selector) { return selector === '[data-theme-mode]' ? themes : []; },
    querySelector() { return null; },
  });
  const window = eventTarget({ matchMedia: () => media, confirm: () => true, open() {} });
  const sandbox = {
    document, window, console, JSON, Math, String, Number, Array, Object, Date, RegExp,
    setTimeout: () => 1, clearTimeout() {}, navigator: { clipboard: { async writeText() {} } },
    fetch: async (path, options) => { requests.push({ path, ...options }); return { ok: true, json: async () => ({ ok: true, item: {} }) }; },
    EventSource: function () { return { close() {} }; }, location: { href: '' },
    localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, String(value)) },
  };
  return { sandbox, getEl, store, preferences, requests, element, themes, media };
}
