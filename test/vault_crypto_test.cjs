const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const messages = [];
const context = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    WebAssembly, crypto: webcrypto, atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval,
    self: { postMessage: message => messages.push(message) } });
context.self.crypto = webcrypto;
context.importScripts = (...names) => names.forEach(name => vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../htdocs', name), 'utf8'), context));
vm.runInContext(fs.readFileSync(path.join(__dirname, '../htdocs/crypto_worker.js'), 'utf8'), context);
let serial = 0;
async function request(action, data = {}, success = true) {
    await context.self.onmessage({ data: { ...data, action, requestId: ++serial } });
    const reply = messages.at(-1);
    assert.equal(reply.requestId, serial);
    assert.equal(reply.status, success ? 'success' : 'error', reply.error);
    return reply.result;
}
(async () => {
    const vaultId = webcrypto.randomUUID(), itemId = webcrypto.randomUUID();
    const credentials = {password:'vault secret one', rulePhrase:'020', path:'REDA0GREENB1'};
    const created = await request('vault_create', {vaultId, ...credentials});
    assert.ok(created.password.startsWith('WVK1.'));
    assert.deepEqual(Object.keys(created).sort(), ['password','vaultId']);
    const account = {name:'测试网站', url:'https://example.com', username:'alice', password:'世界 🔐 unique secret', notes:'private notes'};
    const child = await request('vault_encrypt', {vaultId,itemId,account});
    const second = await request('vault_encrypt', {vaultId,itemId,account});
    assert.notEqual(child.password,second.password);
    assert.equal(child.name,''); assert.equal(child.description,'');
    const read = await request('vault_decrypt',{vaultId,child});
    assert.equal(JSON.stringify(read.account), JSON.stringify(account));
    await request('vault_decrypt',{vaultId,child:{...child,id:webcrypto.randomUUID()}},false);
    const tampered=child.password.split('.');
    const ct=Buffer.from(tampered[2],'base64');ct[0]^=1;tampered[2]=ct.toString('base64');
    await request('vault_decrypt',{vaultId,child:{...child,password:tampered.join('.')}},false);
    await request('vault_lock');
    await request('vault_encrypt',{vaultId,itemId,account},false);
    await request('vault_unlock',{vaultId,wrappedKey:created.password,children:[child],...credentials,password:'wrong'},false);
    for(const changed of [{rulePhrase:'1'},{path:'REDB0'}]) {
        await request('vault_unlock',{vaultId,wrappedKey:created.password,children:[child],...credentials,...changed},false);
    }
    const reopened=await request('vault_unlock',{vaultId,wrappedKey:created.password,children:[child],...credentials});
    assert.equal(reopened[0].account.password,account.password);
    const newCredentials={password:'vault secret two',rulePhrase:'135',path:'BLUEC2BLACKD3'};
    const newWrapped=await request('vault_rewrap',{vaultId,...newCredentials});
    await request('vault_lock');
    await request('vault_unlock',{vaultId,wrappedKey:newWrapped,children:[child],...credentials},false);
    assert.equal((await request('vault_unlock',{vaultId,wrappedKey:newWrapped,children:[child],...newCredentials}))[0].account.name,account.name);
    const legacy = await request('encrypt',{plaintext:'legacy imported secret',...credentials});
    const imported = await request('vault_import',{vaultId,itemId:webcrypto.randomUUID(),ciphertext:legacy,name:'Old entry',...credentials});
    assert.equal((await request('vault_decrypt',{vaultId,child:imported})).account.password,'legacy imported secret');
    const foreignId=webcrypto.randomUUID();
    const foreign=await request('vault_create',{vaultId:foreignId,...credentials});
    await request('vault_unlock',{vaultId:foreignId,wrappedKey:foreign.password,children:[child],...credentials},false);
    await request('vault_decrypt',{vaultId:foreignId,child},false);
    // A failed full unlock cannot leave a partially unlocked vault key active.
    await request('vault_unlock',{vaultId,wrappedKey:newWrapped,children:[child,{...child,id:webcrypto.randomUUID()}],...newCredentials},false);
    await request('vault_encrypt',{vaultId,itemId,account},false);
    const header=created.password.split('.'); const parsed=JSON.parse(Buffer.from(header[1],'base64'));
    parsed.mem=1;header[1]=Buffer.from(JSON.stringify(parsed)).toString('base64');
    await request('vault_unlock',{vaultId,wrappedKey:header.join('.'),children:[],...credentials},false);
    await request('vault_unlock',{vaultId,wrappedKey:newWrapped,children:[],...newCredentials});
    await request('vault_encrypt',{vaultId,itemId,account:{...account,notes:'x'.repeat(65536)}},false);
    assert.ok(!JSON.stringify(messages).includes('vault secret one'));
    console.log('Vault crypto passed: real sodium, credential checks, nonce freshness, tamper/context binding, lock, rewrap, import, size limits and key confinement.');
})().catch(error=>{console.error(error);process.exitCode=1});
