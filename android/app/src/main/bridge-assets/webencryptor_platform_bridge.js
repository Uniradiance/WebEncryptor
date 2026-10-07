/*
 * WebEncryptor Android platform bridge (injected shim).
 *
 * This file is NOT part of htdocs/. The native host installs it into the page
 * before any page script runs (WebViewCompat.addDocumentStartJavaScript), which is
 * what allows the web frontend to ship byte-identical to the desktop build:
 * `htdocs/password_service.js` keeps calling `fetch('/api/passwords')` and never
 * learns that the request is answered in-process.
 *
 * What it adapts, and why each one is needed:
 *
 *   fetch('/api/...')       -> WebMessageListener request/response. A hand-built
 *                              `Response` carries the status, headers and body, so
 *                              `response.ok`, `.status`, `.text()`, `.json()` and
 *                              abort handling all behave like a real fetch.
 *   navigator.clipboard     -> native clipboard with EXTRA_IS_SENSITIVE and a
 *                              timed clear (Android 13+ previews are privacy
 *                              leaks for a password manager).
 *   <a download href=blob:> -> Android WebView never calls onDownloadStart for
 *                              blob: URLs. Anchors are intercepted here and the
 *                              bytes are handed to the Storage Access Framework.
 *                              (`vault_manager.js` clicks a *detached* anchor, so
 *                              HTMLAnchorElement.prototype.click is patched, not
 *                              just a document-level listener.)
 *   window.__WE_APP__       -> lifecycle hooks the host calls with
 *                              evaluateJavascript: lock the vault when the app
 *                              goes to the background, and route the system back
 *                              gesture through the page's own modals/tabs.
 *
 * Everything else — ES modules, import maps, the crypto worker, WASM, localStorage
 * — works unchanged because the page is served from
 * https://appassets.androidplatform.net/assets/ (a real secure context).
 */
(function () {
    'use strict';

    if (window.__WE_APP__ && window.__WE_APP__.installed) return;

    var BRIDGE_OBJECT = 'weBridge';       // WebViewCompat.addWebMessageListener
    var NATIVE_OBJECT = '__WE_NATIVE__';  // addJavascriptInterface fallback
    var MAX_PENDING = 4096;

    // ------------------------------------------------------------------
    // Transport
    // ------------------------------------------------------------------

    var nextRequestId = 1;
    var pending = new Map();
    var lateReplyEnabled = false;

    function hasListenerTransport() {
        return !!(window[BRIDGE_OBJECT] && typeof window[BRIDGE_OBJECT].postMessage === 'function');
    }

    function hasInterfaceTransport() {
        return !!(window[NATIVE_OBJECT] && typeof window[NATIVE_OBJECT].call === 'function');
    }

    function available() {
        return hasListenerTransport() || hasInterfaceTransport();
    }

    function abortError() {
        try {
            return new DOMException('The operation was aborted.', 'AbortError');
        } catch (_) {
            var error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            return error;
        }
    }

    function deliver(json) {
        var message;
        try {
            message = JSON.parse(json);
        } catch (_) {
            return;
        }
        if (!message || typeof message.id !== 'number') return;
        var entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok) {
            entry.resolve(message);
        } else {
            var error = new Error(message.error || 'The storage bridge reported a failure.');
            if (typeof message.status === 'number') error.status = message.status;
            entry.reject(error);
        }
    }
    // Used by the @JavascriptInterface fallback for replies that arrive after the
    // synchronous call returned (file export only).
    window.__WE_DELIVER__ = deliver;

    function send(payload) {
        var serialized = JSON.stringify(payload);
        var bridge = window[BRIDGE_OBJECT];
        if (bridge && typeof bridge.postMessage === 'function') {
            bridge.postMessage(serialized);
            return;
        }
        var native = window[NATIVE_OBJECT];
        if (native && typeof native.call === 'function') {
            var immediate = native.call(serialized);
            if (immediate) deliver(immediate);
            return;
        }
        throw new Error('The native storage bridge is unavailable.');
    }

    function call(payload) {
        if (pending.size > MAX_PENDING) {
            return Promise.reject(new Error('Too many outstanding storage requests.'));
        }
        var id = nextRequestId++;
        payload.id = id;
        return new Promise(function (resolve, reject) {
            pending.set(id, { resolve: resolve, reject: reject });
            try {
                send(payload);
            } catch (error) {
                pending.delete(id);
                reject(error);
            }
        });
    }

    function cancel(id) {
        if (!pending.has(id)) return;
        pending.delete(id);
        try {
            send({ op: 'cancel', targetId: id });
        } catch (_) {
            /* the request is already gone locally */
        }
    }

    // ------------------------------------------------------------------
    // fetch('/api/...') -> bridge
    // ------------------------------------------------------------------

    var nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

    function headerObject(init, request) {
        var out = {};
        function absorb(source) {
            if (!source) return;
            if (typeof source.forEach === 'function' && typeof source.get === 'function') {
                source.forEach(function (value, key) { out[String(key)] = String(value); });
            } else if (Array.isArray(source)) {
                source.forEach(function (pair) { if (pair && pair.length === 2) out[String(pair[0])] = String(pair[1]); });
            } else if (typeof source === 'object') {
                Object.keys(source).forEach(function (key) { out[String(key)] = String(source[key]); });
            }
        }
        if (request && request.headers) absorb(request.headers);
        absorb(init && init.headers);
        return out;
    }

    function synthesizeResponse(message) {
        if (message.status === 204) {
            return new Response(null, { status: 204, statusText: 'No Content' });
        }
        var headers = { 'Content-Type': 'application/json; charset=utf-8' };
        if (message.headers) {
            Object.keys(message.headers).forEach(function (key) { headers[key] = message.headers[key]; });
        }
        return new Response(message.body === undefined ? '' : message.body, {
            status: message.status,
            statusText: '',
            headers: headers,
        });
    }

    function apiFetch(url, input, init) {
        var request = (typeof Request !== 'undefined' && input instanceof Request) ? input : null;
        var method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
        var body = init && init.body !== undefined && init.body !== null ? init.body : null;
        if (typeof body !== 'string' && body !== null) body = String(body);
        var signal = (init && init.signal) || (request && request.signal) || null;
        var headers = headerObject(init, request);

        function withBody(resolve, reject) {
            if (body === null && request) {
                request.clone().text().then(function (text) {
                    resolve(text);
                }, function () {
                    resolve(null);
                });
            } else {
                resolve(body);
            }
        }

        return new Promise(function (resolve, reject) {
            withBody(function (text) {
                var id = nextRequestId++;
                var settled = false;
                function cleanup() {
                    if (signal) signal.removeEventListener('abort', onAbort);
                }
                function onAbort() {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    cancel(id);
                    reject(abortError());
                }
                if (signal) {
                    if (signal.aborted) return onAbort();
                    signal.addEventListener('abort', onAbort, { once: true });
                }
                pending.set(id, {
                    resolve: function (message) {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        resolve(synthesizeResponse(message));
                    },
                    reject: function (error) {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        reject(error);
                    },
                });
                try {
                    send({
                        id: id,
                        op: 'http',
                        method: method,
                        path: url.pathname + url.search,
                        headers: headers,
                        body: text,
                    });
                } catch (error) {
                    settled = true;
                    cleanup();
                    pending.delete(id);
                    reject(error);
                }
            }, reject);
        });
    }

    function installFetch() {
        if (!nativeFetch) return;
        window.fetch = function (input, init) {
            var target = null;
            try {
                if (typeof input === 'string') target = input;
                else if (input && typeof input.url === 'string') target = input.url;
            } catch (_) {
                target = null;
            }
            if (target === null) return nativeFetch(input, init);
            var resolved;
            try {
                resolved = new URL(target, window.location.href);
            } catch (_) {
                return nativeFetch(input, init);
            }
            if (resolved.origin === window.location.origin && resolved.pathname.indexOf('/api/') === 0) {
                return apiFetch(resolved, input, init);
            }
            return nativeFetch(input, init);
        };
    }

    // ------------------------------------------------------------------
    // Clipboard
    // ------------------------------------------------------------------

    function installClipboard() {
        if (!available()) return;
        var shim = {
            writeText: function (text) {
                // Everything the app copies is treated as sensitive: Android 13+
                // then withholds it from the clipboard preview, and the native side
                // clears it after a short delay.
                return call({ op: 'clipboard.write', text: String(text), sensitive: true }).then(function () { });
            },
            readText: function () {
                return call({ op: 'clipboard.read' }).then(function (message) {
                    return message.text === null || message.text === undefined ? '' : message.text;
                });
            },
        };
        try {
            Object.defineProperty(navigator, 'clipboard', { value: shim, configurable: true, writable: false });
        } catch (_) {
            try { navigator.clipboard = shim; } catch (__) { /* keep the native one */ }
        }
    }

    // ------------------------------------------------------------------
    // blob: downloads -> Storage Access Framework
    // ------------------------------------------------------------------

    function installDownloadBridge() {
        if (!available() || typeof URL === 'undefined') return;
        var blobs = new Map();
        var createObjectURL = URL.createObjectURL;
        var revokeObjectURL = URL.revokeObjectURL;

        if (typeof createObjectURL === 'function') {
            URL.createObjectURL = function (object) {
                var url = createObjectURL.call(URL, object);
                try { blobs.set(url, object); } catch (_) { /* ignore */ }
                return url;
            };
        }
        if (typeof revokeObjectURL === 'function') {
            URL.revokeObjectURL = function (url) {
                blobs.delete(url);
                return revokeObjectURL.call(URL, url);
            };
        }

        function toBase64(bytes) {
            var chunk = 0x8000;
            var binary = '';
            for (var offset = 0; offset < bytes.length; offset += chunk) {
                binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
            }
            return btoa(binary);
        }

        function exportBlob(name, blob) {
            return blob.arrayBuffer().then(function (buffer) {
                return call({
                    op: 'file.save',
                    name: name || 'webencryptor-backup.json',
                    mime: blob.type || 'application/octet-stream',
                    base64: toBase64(new Uint8Array(buffer)),
                });
            }).catch(function () {
                /* The host reports failures with a native message. */
            });
        }

        function blobFor(anchor) {
            if (!anchor || typeof anchor.getAttribute !== 'function') return null;
            if (anchor.getAttribute('download') === null) return null;
            var href = anchor.getAttribute('href') || '';
            if (href.indexOf('blob:') !== 0) return null;
            return blobs.get(href) || null;
        }

        // vault_manager.js/App code builds a detached <a> and calls click(): the
        // event never reaches document, so the prototype is patched.
        if (window.HTMLAnchorElement && HTMLAnchorElement.prototype.click) {
            var nativeClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () {
                var blob = blobFor(this);
                if (blob) {
                    exportBlob(this.getAttribute('download'), blob);
                    return;
                }
                return nativeClick.apply(this, arguments);
            };
        }

        // Belt and braces for anchors that really are in the document.
        document.addEventListener('click', function (event) {
            var anchor = event.target && event.target.closest ? event.target.closest('a[download]') : null;
            var blob = blobFor(anchor);
            if (!blob) return;
            event.preventDefault();
            event.stopPropagation();
            exportBlob(anchor.getAttribute('download'), blob);
        }, true);
    }

    // ------------------------------------------------------------------
    // Host-facing hooks
    // ------------------------------------------------------------------

    function dispatchPageHide() {
        try {
            window.dispatchEvent(new Event('pagehide'));
            // Native background locking keeps this document alive. Restore only
            // the empty crypto worker so the text workspace can be used again.
            window.resumeCryptoSession?.();
        } catch (_) {
            /* nothing else to do */
        }
    }

    function isDirty() {
        // vault_manager.js registers the app's own draft guard on `beforeunload`;
        // a synthetic cancelable event reveals the answer without duplicating the
        // module's private `dirty` flag.
        try {
            var event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        } catch (_) {
            return false;
        }
    }

    function visible(element) {
        if (!element) return false;
        if (element.hidden) return false;
        try {
            return getComputedStyle(element).display !== 'none';
        } catch (_) {
            return false;
        }
    }

    function clickById(id) {
        var element = document.getElementById(id);
        if (element) element.click();
    }

    function handleBack() {
        var result = { handled: false, dirty: false, step: 'root' };

        var menu = document.getElementById('moreOptionsMenu');
        if (menu && menu.style.display === 'block') {
            menu.style.display = 'none';
            var button = document.getElementById('moreOptionsButton');
            if (button) button.setAttribute('aria-expanded', 'false');
            result.handled = true;
            result.step = 'app-menu';
            return finish(result);
        }

        var overlays = ['passwordGeneratorModal', 'decryptResultDialog'];
        for (var i = 0; i < overlays.length; i++) {
            var overlay = document.getElementById(overlays[i]);
            if (visible(overlay)) {
                overlay.style.display = 'none';
                result.handled = true;
                result.step = overlays[i];
                return finish(result);
            }
        }

        var details = document.querySelector('details[open]');
        if (details) {
            details.open = false;
            result.handled = true;
            result.step = 'details';
            return finish(result);
        }

        var editor = document.getElementById('vault-editor');
        if (editor && !editor.hidden) {
            clickById('account-cancel');
            result.handled = true;
            result.step = 'account-editor';
            return finish(result);
        }

        var access = document.getElementById('vault-access');
        if (access && !access.hidden) {
            clickById('vault-access-cancel');
            result.handled = true;
            result.step = 'vault-access';
            return finish(result);
        }

        var activeTab = document.querySelector('.tab-button.active');
        if (activeTab && activeTab.dataset && activeTab.dataset.tab && activeTab.dataset.tab !== 'vault') {
            clickById('vaultTab');
            result.handled = true;
            result.step = 'workspace-tab';
            return finish(result);
        }

        return finish(result);
    }

    function finish(result) {
        result.dirty = isDirty();
        return result;
    }

    window.__WE_APP__ = {
        installed: true,
        version: '1.0.0',
        bridgeAvailable: available,
        lock: dispatchPageHide,
        handleBack: handleBack,
        info: function () {
            return {
                version: '1.0.0',
                transport: hasListenerTransport() ? 'web-message-listener'
                    : (hasInterfaceTransport() ? 'javascript-interface' : 'unavailable'),
                href: window.location.href,
                origin: window.location.origin,
                secureContext: !!window.isSecureContext,
                pendingRequests: pending.size,
            };
        },
    };

    // ------------------------------------------------------------------
    // Bootstrap
    // ------------------------------------------------------------------

    installFetch();
    installClipboard();
    installDownloadBridge();
    installTransportListeners();

    function installTransportListeners() {
        var bridge = window[BRIDGE_OBJECT];
        if (!bridge) return;
        // `addWebMessageListener` injects an object whose replies arrive as
        // messages on `onmessage`; both spellings are accepted so the shim does not
        // depend on which one the WebView build implements.
        try {
            bridge.onmessage = function (event) {
                deliver(event && event.data !== undefined ? event.data : event);
            };
        } catch (_) {
            /* read-only on this WebView build */
        }
        if (typeof bridge.addEventListener === 'function') {
            bridge.addEventListener('message', function (event) {
                deliver(event && event.data !== undefined ? event.data : event);
            });
        }
    }

    function announce() {
        if (!available()) return;
        if (lateReplyEnabled) return;
        lateReplyEnabled = true;
        call({ op: 'app.ready', userAgent: navigator.userAgent, platform: String(navigator.platform || '') })
            .catch(function () { /* diagnostics only */ });
    }

    // The listener transport injects `weBridge` before document start, but the
    // @JavascriptInterface fallback is added at the same point, so one microtask
    // is enough to see both.
    if (document.readyState === 'loading') {
        Promise.resolve().then(announce);
        document.addEventListener('DOMContentLoaded', announce, { once: true });
    } else {
        announce();
    }
})();
