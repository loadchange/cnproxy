const fs = require('fs');
const forge = require('node-forge')
const log = require('../common/log')
const FakeServersCenter = require('../tls/FakeServersCenter')

module.exports = function createFakeServerCenter({caCertPath, caKeyPath, requestHandler, upgradeHandler, getCertSocketTimeout}) {
    let {caCert, caKey} = {}
    try {
        fs.accessSync(caCertPath, fs.F_OK);
        fs.accessSync(caKeyPath, fs.F_OK);
        let caCertPem = fs.readFileSync(caCertPath);
        let caKeyPem = fs.readFileSync(caKeyPath);
        caCert = forge.pki.certificateFromPem(caCertPem);
        caKey = forge.pki.privateKeyFromPem(caKeyPem);
    } catch (e) {
        log.error('Can not find `CA certificate` or `CA key`.')
        process.exit(1)
    }

    return new FakeServersCenter({
        caCert,
        caKey,
        maxLength: 100,
        requestHandler,
        upgradeHandler,
        getCertSocketTimeout
    });
}