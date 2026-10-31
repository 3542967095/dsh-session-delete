/**
 * Logic test for the browser half without a real browser: the module loader,
 * React, the primitive components and the DOM are replaced by recording stubs.
 * It proves the menu row opens the dialog, the dialog posts the right request,
 * and a successful delete reloads the page.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')

const requests = []
const reloads = []
const containers = []

function makeElement(tag) {
  return {
    tag,
    attrs: {},
    dataset: {},
    children: [],
    append(child) {
      this.children.push(child)
    },
    remove() {
      this.removed = true
    },
    setAttribute(name, value) {
      this.attrs[name] = value
    },
  }
}

const document = {
  documentElement: { lang: 'zh-CN' },
  head: { children: [], append(element) { this.children.push(element) } },
  body: {
    append(element) {
      containers.push(element)
    },
  },
  querySelector: () => null,
  createElement: (tag) => makeElement(tag),
}

const registrations = new Map()
const injections = []
const ctx = {
  locale: {
    getLocale: () => ({ active: { id: 'zh' } }),
    subscribe: () => () => {},
  },
  slots: {
    inject(name, callback) {
      injections.push(name)
      callback()
    },
    register(options, component) {
      registrations.set(options.name, { options, component })
      return () => {}
    },
  },
}

const fakeRequire = (name) => {
  if (name === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
    }
  }
  if (name === 'react-dom/client') {
    return {
      createRoot(container) {
        return {
          render(element) {
            container.rendered = element
          },
          unmount() {
            container.unmounted = true
          },
        }
      },
    }
  }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    const marker = (tag) => tag
    return {
      Button: 'Button',
      MenuItemButton: 'MenuItemButton',
      Modal: 'Modal',
      IconTrashOutlineRegular: marker('IconTrashOutlineRegular'),
    }
  }
  throw new Error(`unexpected require: ${name}`)
}

const sandbox = {
  window: {
    __ModuleLoader__: { load: (definition) => { sandbox.definition = definition } },
    dispatchEvent: () => {},
  },
  document,
  navigator: { language: 'zh-CN' },
  location: { reload: () => reloads.push(Date.now()) },
  fetch: async (url, init) => {
    requests.push({ url, init })
    if (url.endsWith('/ping')) return { ok: true, json: async () => ({ ok: true }) }
    return { ok: true, json: async () => ({ ok: true }) }
  },
  setTimeout,
  console,
  Symbol,
  JSON,
  Date,
  Event: class {
    constructor(type) {
      this.type = String(type)
    }
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

assert.equal(sandbox.definition.id, 'dsh-plugin-session-delete')
const exportsObject = sandbox.definition.factory(fakeRequire)
assert.deepEqual(JSON.parse(JSON.stringify(exportsObject.inject)), ['slots', 'locale'])
exportsObject.apply(ctx)

// The client half must announce itself to the Host.
assert.equal(requests[0]?.url, '/api/session-delete/ping')

const menuRegistration = registrations.get('sidebar.workspaces.session.menu.item')
const footerRegistration = registrations.get('sidebar.footer.action')
assert.ok(menuRegistration, 'menu row registered')
assert.ok(footerRegistration, 'footer action registered')
assert.equal(menuRegistration.options.id, 'session-delete')
assert.equal(menuRegistration.options.order, 500)
assert.equal(footerRegistration.options.id, 'session-delete.trash')

// The footer entry is the visible recycle-bin preview.
const footer = footerRegistration.component({ wide: true })
assert.equal(footer.type, 'button')
assert.match(JSON.stringify(footer.props), /回收站/)

// Render the menu row and click it.
let menuOpen = true
const menuElement = menuRegistration.component({
  sessionId: 'session-11111111-2222-4333-8444-555555555555',
  displayTitle: '测试对话',
  useMenuOpenState: () => [menuOpen, (next) => { menuOpen = next }],
})
assert.equal(menuElement.type, 'MenuItemButton')
assert.equal(menuElement.props.separatorBefore, true)
menuElement.props.onSelect()
assert.equal(menuOpen, false)
assert.equal(containers.length, 1)

// The dialog was rendered into its own root.
const dialogElement = containers[0].rendered
assert.equal(typeof dialogElement.type, 'function')

// Render the dialog body and confirm.
const modal = dialogElement.type(dialogElement.props)
assert.equal(modal.type, 'Modal')
assert.match(JSON.stringify(modal.props.title), /删除对话/)

const buttons = modal.props.footer
const confirm = buttons.find((button) => button.props?.key === 'delete')
assert.ok(confirm, 'confirm button exists')
await confirm.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))

const deleteRequest = requests.find((request) => request.url === '/api/session-delete')
assert.ok(deleteRequest, 'delete request sent')
assert.equal(deleteRequest.init.method, 'POST')
assert.deepEqual(JSON.parse(deleteRequest.init.body), {
  sessionId: 'session-11111111-2222-4333-8444-555555555555',
  title: '测试对话',
})
await new Promise((resolve) => setTimeout(resolve, 250))
assert.equal(reloads.length, 1, 'page reloads after a successful delete')
assert.equal(containers[0].unmounted, true, 'dialog root unmounts')

console.log('client logic tests passed')
