"""Task placement, keyboard navigation and responsive layout in real Firefox."""
import base64
from pathlib import Path


def exercise_workspace(client):
    def set_viewport(width, height=950):
        client.call('WebDriver:SetWindowRect', {'width': width, 'height': height})
        # Firefox has a minimum native window width. Browser zoom lets the
        # content viewport reach 320px while exercising real CSS breakpoints.
        client.call('Marionette:SetContext', {'value': 'chrome'})
        try:
            client.call('WebDriver:ExecuteScript', {
                'script': 'const browser = window.gBrowser.selectedBrowser; browser.fullZoom = browser.clientWidth / arguments[0];',
                'args': [width], 'newSandbox': False, 'sandbox': None,
            })
        finally:
            client.call('Marionette:SetContext', {'value': 'content'})
        actual = client.js('await flow.frame(); return innerWidth;')
        assert abs(actual - width) <= 4, f'Viewport requested {width}px, got {actual}px'

    def screenshot(name):
        client.js('document.activeElement?.blur(); window.scrollTo(0, 0); await flow.frame();')
        data = client.call('WebDriver:TakeScreenshot', {'full': True})
        Path(f'/tmp/webencryptor-redesign-{name}.png').write_bytes(base64.b64decode(data))

    set_viewport(1440, 1000)
    client.js(r"""
        switchToTab('vault'); await flow.frame();
        await flow.wait(() => !document.getElementById('vault-status').textContent.includes('Loading'), 'vaults loading');
        flow.check(document.getElementById('secretFactors').hidden, 'welcome exposes credentials');
    """)
    screenshot('welcome')
    client.js(r"""
        document.getElementById('vault-new').click(); await flow.frame();
        flow.check(document.getElementById('secretFactors').parentElement.id === 'vault-access-factors', 'create credentials outside task');
        flow.check(document.querySelector('.sigpad-verify').disabled, 'vault enabled empty pattern verification');
        document.getElementById('passwordEncrypt').value = 'retained credentials';
        await flow.cell('A0');
        await flow.draw([[20,140],[140,140],[140,60],[260,60]]);
        const original = document.getElementById('secretFactors');
        const factor = window.getSecretFactors();
        document.getElementById('vaultTab').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));
        await flow.frame();
        flow.check(document.getElementById('dataTab').getAttribute('aria-selected') === 'true', 'vertical navigation failed');
        flow.check(document.activeElement.id === 'dataTab', 'navigation did not transfer focus');
        flow.check(original.parentElement.id === 'data-factors', 'text credentials outside task');
        flow.check(JSON.stringify(window.getSecretFactors()) === JSON.stringify(factor), 'moving credentials changed secret');
        switchToTab('manager'); await flow.frame();
        flow.check(original.parentElement.id === 'manager-factors', 'manager credentials outside task');
        flow.check(!document.getElementById('managerCredentials').open, 'manager credentials should start collapsed');
        flow.check(document.getElementById('workspaceTitle').textContent === 'Independent items', 'workspace heading stale');
        window.clearSecretFactors(); await flow.frame();
        window.triggerDecrypt(true); await flow.frame();
        flow.check(document.getElementById('managerCredentials').open, 'decrypt failed to reveal credentials');
        flow.check(original.getBoundingClientRect().height > 0, 'revealed credentials not visible');
        document.getElementById('managerCredentials').open = false;
        document.getElementById('errorDisplay').style.display = 'none';
        switchCryptoMode('encrypt');
        switchToTab('vault'); await flow.frame();
    """)
    screenshot('create')
    for width in [1440, 1120, 1024, 900, 768, 760, 600, 390, 320]:
        set_viewport(width)
        client.js(r"""
            await flow.frame();
            for (const tab of ['vault', 'data', 'manager']) {
                switchToTab(tab); await flow.frame();
                if (tab === 'manager') { document.getElementById('managerCredentials').open = true; await flow.frame(); }
                flow.check(document.documentElement.scrollWidth <= innerWidth + 1, tab + ' overflows at ' + innerWidth);
                flow.check(document.querySelector('.sigpad-canvas').getBoundingClientRect().width >= 190, tab + ' drawing area too narrow');
                const orientation = innerWidth <= 760 ? 'horizontal' : 'vertical';
                flow.check(document.querySelector('.workspace-tabs').getAttribute('aria-orientation') === orientation, 'wrong navigation orientation');
            }
            if (innerWidth <= 760) {
                document.getElementById('managerTab').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true}));
                flow.check(document.activeElement.id === 'dataTab', 'horizontal navigation failed');
            }
        """)
        if width in [1440, 390]:
            client.js("switchToTab('data'); await flow.frame();")
            screenshot(f'text-{width}')
            client.js("switchToTab('manager'); await flow.frame(); document.getElementById('managerCredentials').open = false;")
            screenshot(f'items-{width}')
    client.call('Marionette:SetContext', {'value': 'chrome'})
    try:
        client.call('WebDriver:ExecuteScript', {
            'script': 'window.gBrowser.selectedBrowser.fullZoom = 1;',
            'args': [], 'newSandbox': False, 'sandbox': None,
        })
    finally:
        client.call('Marionette:SetContext', {'value': 'content'})
    client.call('WebDriver:SetWindowRect', {'width': 1120, 'height': 900})
    client.js(r"""
        switchToTab('vault'); document.getElementById('vault-access-cancel').click();
        document.getElementById('managerCredentials').open = false;
        clearSecretFactors(); switchToTab('data'); await flow.frame();
    """)
    print('PASS: task-scoped credentials, retained factors, validity guards, keyboard navigation and responsive workspace layouts', flush=True)
