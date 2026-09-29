"""Vault scenarios run in browser_flow.py's real Firefox and temporary server."""
import base64
import json
from pathlib import Path


def exercise_vaults(client, database):
    client.js(r"""
        document.getElementById('closeDecryptResultActionButton').click();
        switchToTab('vault'); await flow.frame();
        await flow.wait(() => !document.getElementById('vault-status').textContent.includes('Loading'), 'vault list not loaded');
        flow.check(document.getElementById('secretFactors').hidden, 'empty vault page should not display credentials');
        document.getElementById('vault-new').click(); await flow.frame();
        flow.check(!document.getElementById('secretFactors').hidden, 'new vault factors hidden');
        flow.credentials = async (password, verified = false) => {
            clearSecretFactors(); await flow.frame();
            document.getElementById('passwordEncrypt').value = password;
            await flow.cell('A0'); await flow.cell('B0');
            await flow.draw([[20,140],[140,140],[140,60],[260,60]]);
            if (verified) {
                document.querySelector('.sigpad-verify').click();
                await flow.draw([[30,150],[150,150],[150,70],[270,70]]);
                document.querySelector('.sigpad-verify').click();
                flow.check(document.querySelector('.sigpad-feedback').textContent.includes('verified'), 'vault pattern not verified');
            }
        };
        document.getElementById('vault-name').value = 'Browser vault';
        await flow.credentials('vault original secret');
        document.getElementById('vault-access-submit').click();
        flow.check(document.getElementById('vault-status').textContent.includes('Redraw'), 'vault accepted unverified creation');
        await flow.credentials('vault original secret', true);
        document.getElementById('vault-access-submit').click();
        document.getElementById('vault-access-submit').click();
        flow.check(isCryptoBusy(), 'vault create did not lock shared factors');
        switchToTab('data');
        flow.check(document.getElementById('actionButton').disabled, 'text crypto allowed concurrent vault KDF');
        switchToTab('vault');
        await flow.wait(() => !isCryptoBusy(), 'vault create never completed');
        flow.check(!document.getElementById('vault-workspace').hidden, 'created vault not unlocked');
        flow.check(document.getElementById('secretFactors').hidden && document.getElementById('passwordEncrypt').value === '', 'credentials were retained after unlock');
        document.getElementById('vault-add').click();
        const fill = {name:'Private account title',url:'https://example.com/private',username:'private-alice',password:'secret account value 🔐',notes:'private account notes'};
        for (const [field,value] of Object.entries(fill)) {
            const input=document.getElementById('account-'+field); input.value=value; input.dispatchEvent(new Event('input',{bubbles:true}));
        }
        document.getElementById('account-save').click();
        await flow.wait(() => !isCryptoBusy(), 'account save never completed');
        flow.check(document.querySelectorAll('.vault-account').length === 1, 'account did not appear');
        flow.check(document.getElementById('vault-editor').hidden, 'successful save retained plaintext editor');
        document.getElementById('vault-search').value='no-match'; document.getElementById('vault-search').dispatchEvent(new Event('input'));
        flow.check(document.querySelectorAll('.vault-account').length === 0, 'search did not filter');
        document.getElementById('vault-search').value='private-alice'; document.getElementById('vault-search').dispatchEvent(new Event('input'));
        flow.check(document.querySelectorAll('.vault-account').length === 1, 'username search failed');
        document.getElementById('vault-search').value=''; document.getElementById('vault-search').dispatchEvent(new Event('input'));
        const nativeCopy=navigator.clipboard.writeText.bind(navigator.clipboard);
        let copied;
        navigator.clipboard.writeText=async text=>{copied=text;};
        try {
            [...document.querySelectorAll('.vault-account button')].find(button=>button.textContent==='Copy password').click();
            await flow.frame();flow.check(copied===fill.password,'copy used ciphertext or wrong account');
        } finally {navigator.clipboard.writeText=nativeCopy;}
        switchToTab('manager');await refreshPasswordList();
        flow.check([...document.querySelectorAll('.pm-card [data-name]')].every(name=>name.textContent!=='Browser vault'), 'legacy manager exposed vault as editable text');
        switchToTab('vault');await flow.frame();
        const headers={'Content-Type':'application/json','X-Auth-Token':'browser-test-token'};
        const entries=await(await fetch('/api/passwords',{headers})).json();
        const vault=entries.find(item=>item.type==='vault');
        flow.check(entries.filter(item=>item.type==='vault').length===1,'double create duplicated vault');
        flow.vaultId=vault.id;flow.vaultUuid=vault.vaultId;flow.childCipher=vault.children[0].password;
        flow.check(vault.password.startsWith('WVK1.') && vault.children[0].password.startsWith('WVI1.'), 'vault envelopes not saved');
        [...document.querySelectorAll('.vault-account button')].find(button=>button.textContent==='Edit').click();
        document.getElementById('account-password').value='unsaved conflicting draft';
        document.getElementById('account-password').dispatchEvent(new Event('input',{bubbles:true}));
        const {id,...body}=vault;
        const response=await fetch('/api/passwords/'+id,{method:'PUT',headers,body:JSON.stringify({...body,description:'changed by another tab'})});
        flow.check(response.status===200,'fixture concurrent update failed');
        document.getElementById('account-save').click();
        await flow.wait(()=>!isCryptoBusy(),'conflicting save did not unlock UI');
        flow.check(document.getElementById('account-password').value==='unsaved conflicting draft','conflict discarded draft');
        flow.check(document.getElementById('account-save').disabled && document.getElementById('vault-status').textContent.includes('409'),'conflict not surfaced');
        document.getElementById('vault-refresh').click();await flow.frame();
        flow.check(document.getElementById('account-password').value==='unsaved conflicting draft','refresh discarded conflict draft');
        const nativeConfirm=window.confirm;window.confirm=()=>true;
        try {document.getElementById('vault-lock').click();} finally {window.confirm=nativeConfirm;}
        flow.check(document.getElementById('account-password').value==='' && !document.querySelector('.vault-account'),'lock retained plaintext');
        await flow.credentials('vault original secret');
        document.getElementById('vault-access-submit').click();
        await flow.wait(()=>!isCryptoBusy(),'vault did not reopen after conflict');
        flow.check(document.querySelector('.vault-account'),'reopened vault lost account');
        [...document.querySelectorAll('.vault-account button')].find(button=>button.textContent==='Edit').click();
        flow.check(document.getElementById('account-password').value===fill.password,'failed save overwrote account');
        document.getElementById('account-cancel').click();
        document.getElementById('vault-change').click();await flow.frame();
        await flow.credentials('vault changed secret',true);
        document.querySelector('#vault-change-form [type="submit"]').click();
        await flow.wait(()=>!isCryptoBusy(),'rewrap did not complete');
        const updated=(await(await fetch('/api/passwords',{headers})).json()).find(item=>item.id===id);
        flow.check(updated.children[0].password===flow.childCipher,'credential change unnecessarily re-encrypted child');
        document.getElementById('vault-lock').click();await flow.frame();
        await flow.credentials('vault original secret');document.getElementById('vault-access-submit').click();
        await flow.wait(()=>!isCryptoBusy(),'wrong credential check stalled');
        flow.check(document.getElementById('vault-workspace').hidden && document.getElementById('vault-status').textContent.includes('does not match'),'old credentials still unlocked');
        document.getElementById('passwordEncrypt').value='vault changed secret';document.getElementById('vault-access-submit').click();
        await flow.wait(()=>!isCryptoBusy(),'new credentials did not unlock');
        flow.check(!document.getElementById('vault-workspace').hidden,'rewrapped vault did not reopen');
        document.getElementById('vault-import').click();await flow.frame();
        await flow.credentials('browser workflow secret');
        document.querySelector('#vault-import-form [type="submit"]').click();
        await flow.wait(()=>!isCryptoBusy(),'legacy import stalled');
        flow.check(document.querySelectorAll('.vault-account').length===2,'legacy import missing');
        const imported=(await(await fetch('/api/passwords',{headers})).json());
        flow.check(imported.some(item=>item.type!=='vault' && item.password.startsWith('WE2.')),'import deleted legacy source');
        document.getElementById('vault-lock').click();await flow.frame();
        await flow.credentials('vault changed secret');document.getElementById('vault-access-submit').click();
        await flow.wait(()=>!isCryptoBusy(),'final unlock stalled');
        flow.check(document.querySelectorAll('.vault-account').length===2,'saved children did not round-trip');
    """)
    data = json.loads(database.read_text())
    assert len([entry for entry in data["entries"] if entry.get("type") == "vault"]) == 1
    vault = next(entry for entry in data["entries"] if entry.get("type") == "vault")
    assert len(vault["children"]) == 2
    serialized = json.dumps(vault)
    for secret in ["Private account title", "secret account value", "private-alice", "private account notes", "vault original secret", "vault changed secret"]:
        assert secret not in serialized, f"plaintext persisted: {secret}"
    print("PASS: vault creation/verification, shared guards, encrypted accounts, search/copy, conflict drafts, lock, rewrap and legacy import", flush=True)
    client.call("WebDriver:SetWindowRect", {"width": 390, "height": 844})
    client.js(r"""
        await flow.frame();
        flow.check(document.documentElement.scrollWidth<=innerWidth+1,'mobile vault overflow');
        document.getElementById('vault-add').click();await flow.frame();
        flow.check(document.documentElement.scrollWidth<=innerWidth+1,'mobile editor overflow');
        document.getElementById('account-cancel').click();
    """)
    screenshot = client.call("WebDriver:TakeScreenshot", {"full": True})
    Path("/tmp/webencryptor-vault-mobile.png").write_bytes(base64.b64decode(screenshot))
    client.call("WebDriver:SetWindowRect", {"width": 1120, "height": 900})
    client.js("await flow.frame();")
    screenshot = client.call("WebDriver:TakeScreenshot", {"full": True})
    Path("/tmp/webencryptor-vault-desktop.png").write_bytes(base64.b64decode(screenshot))
    print("PASS: vault mobile layout and desktop/mobile screenshots", flush=True)

    client.js(r"""
        const headers={'Content-Type':'application/json','X-Auth-Token':'browser-test-token'};
        const original=(await(await fetch('/api/passwords',{headers})).json()).find(item=>item.type==='vault');
        const nativeCreate=URL.createObjectURL,nativeClick=HTMLAnchorElement.prototype.click;
        let backup;
        URL.createObjectURL=blob=>{backup=blob;return nativeCreate(blob)};
        HTMLAnchorElement.prototype.click=function(){};
        try {document.getElementById('vault-backup').click();} finally {URL.createObjectURL=nativeCreate;HTMLAnchorElement.prototype.click=nativeClick;}
        flow.check(backup instanceof Blob,'backup was not generated');
        const exported=await backup.text();
        flow.check(!exported.includes('secret account value') && JSON.parse(exported).entries.length===1,'backup leaked plaintext or omitted vault');
        flow.restore=async text=>{
            const transfer=new DataTransfer();transfer.items.add(new File([text],'vault.json',{type:'application/json'}));
            const input=document.getElementById('vault-restore-file');input.files=transfer.files;input.dispatchEvent(new Event('change'));
            await flow.wait(()=>!isCryptoBusy(),'restore stalled');
        };
        await flow.restore(exported);
        flow.check(document.getElementById('vault-status').textContent.includes('already exists'),'restore overwrote an existing vault');
        document.getElementById('vault-change').click();await flow.frame();
        const nativeConfirm=window.confirm;window.confirm=()=>true;
        try {document.getElementById('vault-delete').click();await flow.wait(()=>!isCryptoBusy(),'delete stalled');}
        finally {window.confirm=nativeConfirm;}
        flow.check(document.getElementById('vault-workspace').hidden && !document.querySelector('.vault-account'),'deleted vault plaintext retained');
        await flow.restore(exported);
        flow.check(document.getElementById('vault-status').textContent.includes('restored'),'backup restore failed');
        const restored=(await(await fetch('/api/passwords',{headers})).json()).find(item=>item.type==='vault');
        flow.check(restored.id!==original.id && restored.vaultId===original.vaultId && restored.children[0].password===original.children[0].password,'restore changed crypto identifiers/ciphertext');
        await flow.credentials('vault changed secret');document.getElementById('vault-access-submit').click();
        await flow.wait(()=>!isCryptoBusy(),'restored unlock stalled');
        flow.check(document.querySelectorAll('.vault-account').length===2,'restored accounts could not decrypt');
        const nativeFetch=window.fetch;
        let pending;
        window.fetch=(url,options)=>options?.method==='PUT' ? new Promise(resolve=>{pending=resolve}) : nativeFetch(url,options);
        try {
            [...document.querySelectorAll('.vault-account button')].find(button=>button.textContent==='Edit').click();
            document.getElementById('account-password').value='late reply draft';
            document.getElementById('account-password').dispatchEvent(new Event('input',{bubbles:true}));
            document.getElementById('account-save').click();await flow.wait(()=>pending,'PUT never started');
            window.confirm=()=>true;document.getElementById('vault-lock').click();window.confirm=nativeConfirm;
            pending(new Response(JSON.stringify(restored)));await flow.frame();
            flow.check(!isCryptoBusy() && document.getElementById('vault-workspace').hidden && document.getElementById('account-password').value==='','late save restored locked plaintext');
        } finally {window.fetch=nativeFetch;window.confirm=nativeConfirm;}
        await flow.credentials('vault changed secret');document.getElementById('vault-access-submit').click();
        await flow.wait(()=>!isCryptoBusy(),'reopen after pending lock stalled');
        [...document.querySelectorAll('.vault-account button')].find(button=>button.textContent==='Edit').click();
        document.getElementById('account-reveal').click();
        let expire;
        const nativeTimeout=window.setTimeout;
        window.setTimeout=(fn,delay,...args)=>{if(delay===300000)expire=fn;return nativeTimeout(fn,delay,...args)};
        try {document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));} finally {window.setTimeout=nativeTimeout;}
        flow.check(typeof expire==='function','five-minute inactivity timer missing');expire();
        flow.check(document.getElementById('vault-workspace').hidden && document.getElementById('account-password').value==='' && document.getElementById('account-password').type==='password','automatic lock retained sensitive editor state');
        flow.check(document.getElementById('vault-status').textContent.includes('inactivity'),'idle lock not reported');

        document.getElementById('vault-new').click();await flow.frame();
        document.getElementById('vault-name').value='Recovered creation';
        await flow.credentials('creation recovery secret',true);
        window.fetch=async (url,options)=>{
            const response=await nativeFetch(url,options);
            if(options?.method==='POST') {await response.text();throw new Error('response lost after commit');}
            return response;
        };
        try {
            document.getElementById('vault-access-submit').click();
            await flow.wait(()=>!isCryptoBusy(),'uncertain creation stalled');
            flow.check(document.getElementById('vault-access-submit').disabled && document.getElementById('vault-status').textContent.includes('Refresh'),'uncertain creation allowed a blind retry');
        } finally {window.fetch=nativeFetch;}
        document.getElementById('vault-refresh').click();
        await flow.wait(()=>document.getElementById('vault-status').textContent.includes('Creation reached'),'creation recovery did not find persisted vault');
        flow.check(document.getElementById('vault-access-title').textContent.includes('Recovered creation'),'recovered vault not selected');
        document.getElementById('vault-access-submit').click();
        await flow.wait(()=>!isCryptoBusy(),'recovered creation did not unlock');
        flow.check(!document.getElementById('vault-workspace').hidden,'recovered vault unusable');
        const finalEntries=await(await fetch('/api/passwords',{headers})).json();
        flow.check(finalEntries.filter(item=>item.name==='Recovered creation').length===1,'uncertain creation duplicated vault');
        document.getElementById('vault-lock').click();
    """)
    print("PASS: encrypted backup, duplicate refusal, delete/restore, pending-save lock, simulated idle expiry and creation response-loss recovery", flush=True)
