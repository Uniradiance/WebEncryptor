#!/usr/bin/env python3
"""Real Firefox + Go workflow regression, using only Python's standard library.

Build first: go build -o /tmp/webencryptor-business-server .
Run: python3 test/browser_flow.py --server /tmp/webencryptor-business-server
All database/profile files live in a fresh temporary directory. Mouse/Pointer
events are dispatched in the real DOM; native pointer capture is stubbed because
synthetic events have no physical pointer. This does not test touch hardware.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.sock.settimeout(60)
        self.serial = 0
        self.read()
        self.call("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {"acceptInsecureCerts": True}}})
        self.call("WebDriver:SetTimeouts", {"script": 60000, "pageLoad": 60000})

    def read(self):
        length = b""
        while True:
            byte = self.sock.recv(1)
            if not byte:
                raise RuntimeError("Firefox closed Marionette connection")
            if byte == b":":
                break
            length += byte
        data = b""
        remaining = int(length)
        while remaining:
            part = self.sock.recv(remaining)
            if not part:
                raise RuntimeError("Firefox truncated reply")
            data += part
            remaining -= len(part)
        return json.loads(data)

    def call(self, name, params=None):
        self.serial += 1
        payload = json.dumps([0, self.serial, name, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        reply = self.read()
        if reply[2]:
            raise RuntimeError(f"{name}: {reply[2]}")
        result = reply[3]
        return result.get("value", result) if isinstance(result, dict) else result

    def js(self, body):
        script = "const done = arguments[arguments.length - 1]; (async () => {" + body + "})().then(value => done({ok:true,value}), error => done({ok:false,error:String(error) + String(error.stack || '')}));"
        result = self.call("WebDriver:ExecuteAsyncScript", {
            "script": script, "args": [], "newSandbox": False, "sandbox": None,
        })
        if not result["ok"]:
            raise AssertionError(result["error"])
        return result.get("value")


HELPERS = r"""
window.flow = {
  frame: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  check: (value, message) => { if (!value) throw new Error(message); },
  wait: async (predicate, message) => {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message + ': ' + document.getElementById('errorDisplay').textContent + ' ref=' + !!window.reactAppRef?.current + ' disabled=' + document.getElementById('actionButton').disabled);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  },
  cell: async (id) => {
    const cell = document.getElementById(id);
    cell.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
    await flow.frame();
    cell.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
    await flow.frame();
  },
  draw: async (vertices) => {
    const canvas = document.querySelector('.sigpad-canvas');
    canvas.setPointerCapture = () => {};
    const rect = canvas.getBoundingClientRect();
    const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, clientX: rect.left + x, clientY: rect.top + y, bubbles:true,
    }));
    fire('pointerdown', ...vertices[0]);
    for (let k = 1; k < vertices.length; k++) {
      const a = vertices[k-1], b = vertices[k];
      const steps = Math.ceil(Math.hypot(b[0]-a[0], b[1]-a[1])/3);
      for (let i = 1; i <= steps; i++) fire('pointermove', a[0]+(b[0]-a[0])*i/steps, a[1]+(b[1]-a[1])*i/steps);
    }
    fire('pointerup', ...vertices.at(-1));
    await flow.frame();
  },
};
await flow.wait(() => window.reactAppRef?.current && !document.getElementById('actionButton').disabled, 'app did not initialize');
localStorage.setItem('webencryptor_token', 'browser-test-token');
"""


def main():
    # Local fixture traffic must never follow a user's HTTP proxy settings.
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True)
    args = parser.parse_args()
    binary = str(Path(args.server).resolve())
    server_port, browser_port = free_port(), free_port()
    base = f"http://127.0.0.1:{server_port}"
    with tempfile.TemporaryDirectory(prefix="webencryptor-flow-") as temp:
        work = Path(temp)
        profile = work / "firefox"
        profile.mkdir()
        (profile / "user.js").write_text(
            f'user_pref("marionette.port", {browser_port});\n'
            'user_pref("browser.shell.checkDefaultBrowser", false);\n'
            'user_pref("browser.startup.homepage_override.mstone", "ignore");\n'
            'user_pref("datareporting.policy.dataSubmissionEnabled", false);\n'
        )
        log = (work / "processes.log").open("w")
        env = os.environ.copy()
        env["MOZ_DISABLE_CONTENT_SANDBOX"] = "1"
        browser = subprocess.Popen([
            "firefox", "--headless", "--marionette", "--no-remote", "--profile", str(profile), "about:blank",
        ], stdout=log, stderr=log, env=env)
        server = None
        client = None

        def start_server():
            process = subprocess.Popen([
                binary, "--http", "--no-browser", "--port", str(server_port), "--token", "browser-test-token",
            ], cwd=work, stdout=log, stderr=log)
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    urllib.request.urlopen(base + "/index.html", timeout=1).close()
                    return process
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError((work / "processes.log").read_text())
                    time.sleep(0.1)
            raise RuntimeError("server did not start")

        try:
            server = start_server()
            deadline = time.time() + 20
            while time.time() < deadline:
                try:
                    client = Marionette(browser_port)
                    break
                except (ConnectionRefusedError, TimeoutError):
                    time.sleep(0.1)
            if client is None:
                raise RuntimeError("Firefox did not start: " + (work / "processes.log").read_text())
            client.call("WebDriver:Navigate", {"url": base + "/index.html"})
            client.js(HELPERS)
            client.js(r"""
                await flow.cell('A0'); await flow.cell('B0'); await flow.cell('A0');
                flow.check(reactAppRef.current.getFullData() === 'REDB0GREENA0', 'grid color/order incorrect');
                document.querySelector('[aria-label="Undo cell change"]').click(); await flow.frame();
                flow.check(reactAppRef.current.getFullData() === 'REDA0REDB0', 'undo did not restore prior color/order');
                flow.check(document.getElementById('A0').textContent === '1', 'grid order labels missing');
                document.querySelector('.grid-status button').click(); await flow.frame();
                flow.check(reactAppRef.current.getFullData() === 'REDA0REDB0', 'hiding changed actual grid');
                await flow.cell('C0');
                flow.check(reactAppRef.current.getFullData() === 'REDA0REDB0', 'hidden grid remained editable');
                document.querySelector('.grid-status button').click(); await flow.frame();
                document.getElementById('passwordEncrypt').value = 'browser workflow secret';
                document.getElementById('plaintext').value = 'Saved and reopened 世界 🔐';
                await flow.draw([[20,140],[140,140],[140,60],[260,60]]);
                document.getElementById('actionButton').click();
                flow.check(!isCryptoBusy() && document.getElementById('errorDisplay').textContent.includes('Redraw'), 'unverified pattern accepted');
                document.querySelector('.sigpad-verify').click();
                await flow.draw([[20,140],[140,40]]);
                document.querySelector('.sigpad-verify').click();
                flow.check(document.querySelector('.sigpad-feedback').textContent.includes('differs'), 'different redraw accepted');
                document.querySelector('.sigpad-clear').click();
                await flow.draw([[30,150],[150,150],[150,70],[270,70]]);
                document.querySelector('.sigpad-verify').click();
                flow.check(document.querySelector('.sigpad-feedback').textContent.includes('verified'), 'matching redraw not verified');
                flow.check(document.querySelector('.sigpad').classList.contains('signed'), 'verified redraw was not confirmed/frozen');
                document.getElementById('actionButton').click();
                flow.check(isCryptoBusy(), 'crypto never entered busy state');
                switchToTab('manager');
                flow.check(document.getElementById('actionButton').disabled, 'tab switch unlocked action');
                flow.check(switchCryptoMode('decrypt') === false && triggerDecrypt(true) === false, 'overlapping manager request accepted');
                await flow.wait(() => !isCryptoBusy(), 'encryption did not finish');
                flow.check(document.getElementById('cryptoOutput').textContent.startsWith('WE2.'), 'encryption output missing/wrong format');
                switchToTab('data'); await flow.frame();
                flow.check(document.querySelector('.grid-status').textContent.includes('hidden'), 'grid was not explicitly hidden');
            """)
            print("PASS: real React undo/order/hiding, redraw mismatch/retry, busy tab/mode/manager guards, WE2 encryption", flush=True)

            # Force a real rename failure, verify no success toast or phantom item.
            database = work / "passwords.json"
            database.mkdir()
            client.js(r"""
                document.getElementById('saveToManagerButton').click();
                flow.check(isCryptoBusy(), 'save was not locked');
                await flow.wait(() => !isCryptoBusy(), 'failed save never released lock');
                flow.check(document.getElementById('errorDisplay').textContent.includes('not confirmed'), 'failed save reported success');
                flow.check(document.getElementById('cryptoOutput').textContent.startsWith('WE2.'), 'failed save discarded ciphertext');
            """)
            database.rmdir()
            ciphertext = client.js(r"""
                document.getElementById('saveToManagerButton').click();
                document.getElementById('saveToManagerButton').click();
                await flow.wait(() => !isCryptoBusy(), 'save did not finish');
                const response = await fetch('/api/passwords', {headers:{'X-Auth-Token':'browser-test-token'}});
                const entries = await response.json();
                flow.check(entries.length === 1, 'double save created duplicate entries');
                flow.check(entries[0].password === document.getElementById('cryptoOutput').textContent, 'wrong result saved');
                return entries[0].password;
            """)
            disk = json.loads(database.read_text())
            assert set(disk) == {"nextId", "entries"} and disk["nextId"] == 2
            assert len(disk["entries"]) == 1 and disk["entries"][0]["password"] == ciphertext
            print("PASS: disk failure remains an error; ciphertext retained; retry saved once and reached disk", flush=True)

            client.js(r"""
                switchToTab('manager');
                await refreshPasswordList();
                const original = document.querySelector('.pm-card');
                original.querySelector('.edit-btn').click();
                const draft = original.querySelector('[data-name-input]');
                draft.value = 'unsaved draft';
                draft.focus();
                const nativeFetch = window.fetch;
                const headers = {'Content-Type':'application/json','X-Auth-Token':'browser-test-token'};
                const response = await nativeFetch('/api/passwords', {method:'POST',headers,body:JSON.stringify({name:'other',password:'WE2.other'})});
                const other = await response.json();
                await refreshPasswordList();
                flow.check(original.isConnected && draft.value === 'unsaved draft', 'refresh lost draft DOM/value');
                flow.check(document.activeElement === draft, 'refresh stole typing focus');

                // Two concurrent refreshes completed in reverse order.
                const actual = await (await nativeFetch('/api/passwords',{headers})).json();
                const replies = [];
                window.fetch = () => new Promise(resolve => replies.push(resolve));
                try {
                    const older = refreshPasswordList(), newer = refreshPasswordList();
                    replies[1](new Response(JSON.stringify(actual.map(item => item.id === other.id ? {...item,name:'latest'} : item))));
                    await newer;
                    replies[0](new Response(JSON.stringify(actual)));
                    await older;
                    flow.check(document.querySelector(`[data-id='${other.id}'] [data-name]`).textContent === 'latest', 'stale refresh overwrote latest list');
                    flow.check(draft.value === 'unsaved draft', 'out-of-order refresh lost draft');
                    window.fetch = async () => { throw new Error('network unavailable'); };
                    await refreshPasswordList();
                    flow.check(original.isConnected && draft.value === 'unsaved draft', 'failed refresh lost draft');
                } finally { window.fetch = nativeFetch; }

                // Deleting B must preserve the unsaved inputs in A.
                const nativeConfirm = window.confirm;
                window.confirm = () => true;
                try {
                    document.querySelector(`[data-id='${other.id}'] .delete-btn`).click();
                    await flow.wait(() => !document.querySelector(`[data-id='${other.id}']`), 'other card was not deleted');
                    await refreshPasswordList();
                    flow.check(original.isConnected && draft.value === 'unsaved draft', 'deleting another card lost draft');
                } finally { window.confirm = nativeConfirm; }

                // A pending/failed save must retain its disabled card and draft.
                const nativeAlert = window.alert;
                const pendingWrites = [];
                window.alert = () => {};
                window.fetch = (url, options) => options?.method === 'PUT'
                    ? new Promise((resolve,reject) => pendingWrites.push({resolve,reject}))
                    : nativeFetch(url,options);
                try {
                    original.querySelector('.save-btn').click();
                    flow.check(draft.disabled, 'pending save left draft editable');
                    await refreshPasswordList();
                    flow.check(original.isConnected && draft.disabled, 'refresh replaced pending card');
                    pendingWrites[0].reject(new Error('connection interrupted'));
                    await flow.wait(() => !draft.disabled, 'failed save never unlocked card');
                    await refreshPasswordList();
                    flow.check(original.isConnected && draft.value === 'unsaved draft', 'failed save discarded draft');
                } finally { window.fetch = nativeFetch; window.alert = nativeAlert; }

                // Add while editing, and keep a draft removed by another client.
                document.getElementById('add-password-btn').click();
                await flow.wait(() => !document.getElementById('add-password-btn').disabled, 'add never unlocked');
                const added = [...document.querySelectorAll('.pm-card')].find(card => card !== original);
                flow.check(added?.classList.contains('editing') && draft.value === 'unsaved draft', 'add discarded original draft/new edit mode');
                await nativeFetch('/api/passwords/'+added.dataset.id,{method:'DELETE',headers});
                await refreshPasswordList();
                flow.check(added.isConnected && added.classList.contains('editing'), 'external deletion discarded draft');
                added.querySelector('.cancel-btn').click();
                await refreshPasswordList();
                flow.check(!added.isConnected, 'cancel did not clear deleted draft');
                original.querySelector('.cancel-btn').click();
                await refreshPasswordList();

                // The actual UI save lock must release on a request deadline.
                // WebDriver dynamic import can use a separate module map.
                // Import through a document module so this is the page's singleton.
                const probe = document.createElement('script');
                probe.type = 'module';
                probe.textContent = "import {passwordService} from './password_service.js'; window.flowPasswordService = passwordService;";
                document.head.appendChild(probe);
                await flow.wait(() => window.flowPasswordService, 'page service probe did not load');
                const passwordService = window.flowPasswordService;
                const normalTimeout = passwordService.timeoutMs;
                passwordService.timeoutMs = 30;
                window.fetch = (url, options) => options?.method === 'POST'
                    ? new Promise(() => {}) : nativeFetch(url, options);
                try {
                    const started = Date.now();
                    document.getElementById('saveToManagerButton').click();
                    flow.check(isCryptoBusy(), 'timeout save never locked');
                    await flow.wait(() => !isCryptoBusy(), 'timeout never released global save lock');
                    flow.check(Date.now() - started < 2000, 'page deadline override did not take effect');
                    flow.check(document.getElementById('errorDisplay').textContent.includes('Refresh the list'), 'unknown save outcome omitted retry guidance');
                    flow.check(!document.getElementById('actionButton').disabled, 'timeout left crypto disabled');
                    flow.check(document.getElementById('cryptoOutput').textContent.startsWith('WE2.'), 'timeout discarded ciphertext');
                } finally {
                    window.fetch = nativeFetch;
                    passwordService.timeoutMs = normalTimeout;
                    delete window.flowPasswordService;
                    probe.remove();
                }
                await refreshPasswordList();
            """)
            print("PASS: drafts/focus retained across refresh/add/delete/failure; stale replies ignored; pending cards protected; timeout releases save lock", flush=True)

            server.terminate()
            server.wait(timeout=10)
            server = start_server()
            client.call("WebDriver:Navigate", {"url": base + "/index.html"})
            client.js(HELPERS)
            client.js(r"""
                document.getElementById('passwordEncrypt').value = 'browser workflow secret';
                await flow.cell('A0'); await flow.cell('B0');
                await flow.draw([[20,140],[140,140],[140,60],[260,60]]);
                switchToTab('manager');
                await flow.wait(() => document.querySelector('.use-for-decrypt-btn'), 'saved card did not reload');
                document.querySelector('.use-for-decrypt-btn').click();
                flow.check(isCryptoBusy(), 'manager did not start decryption');
                await flow.wait(() => !isCryptoBusy(), 'decryption did not finish');
                flow.check(document.getElementById('decryptResultText').textContent === 'Saved and reopened 世界 🔐', 'restarted saved item failed round trip');
                flow.check(document.getElementById('decryptResultDialog').style.display === 'flex', 'manager result modal missing');
                flow.check(document.getElementById('saveToManagerButton').disabled, 'plaintext became saveable as ciphertext');
                return true;
            """)
            print("PASS: server restart + re-enter factors + Manager decrypt returns original Unicode plaintext", flush=True)
            client.call("WebDriver:SetWindowRect", {"width": 390, "height": 844})
            client.js(r"""
                await flow.frame();
                flow.check(document.documentElement.scrollWidth <= innerWidth + 1, 'mobile page has horizontal overflow');
                flow.check(document.querySelector('.sigpad-canvas').getBoundingClientRect().width > 200, 'mobile drawing area unusable');
            """)
            print("PASS: narrow viewport layout", flush=True)
        except Exception:
            if client:
                try:
                    print("Browser state:", client.js("return {errors:document.getElementById('errorDisplay')?.textContent,feedback:document.querySelector('.sigpad-feedback')?.textContent,body:document.body.innerText.slice(0,1800)};"), flush=True)
                    screenshot = client.call("WebDriver:TakeScreenshot", {"full": True})
                    import base64
                    Path("/tmp/webencryptor-flow-failure.png").write_bytes(base64.b64decode(screenshot))
                except Exception as error:
                    print("Could not capture failure:", error, flush=True)
            print((work / "processes.log").read_text()[-4000:], flush=True)
            raise
        finally:
            if client:
                client.sock.close()
            for process in [server, browser]:
                if process and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)
            log.close()


if __name__ == "__main__":
    main()
