'use strict';

var fs = require('fs');
var forge = require('node-forge');
var log = require('../common/log');
var FakeServersCenter = require('../tls/FakeServersCenter');

module.exports = function createFakeServerCenter(_ref) {
    var caCertPath = _ref.caCertPath,
        caKeyPath = _ref.caKeyPath,
        requestHandler = _ref.requestHandler,
        upgradeHandler = _ref.upgradeHandler,
        getCertSocketTimeout = _ref.getCertSocketTimeout;
    var _ref2 = {},
        caCert = _ref2.caCert,
        caKey = _ref2.caKey;

    try {
        fs.accessSync(caCertPath, fs.F_OK);
        fs.accessSync(caKeyPath, fs.F_OK);
        var caCertPem = fs.readFileSync(caCertPath);
        var caKeyPem = fs.readFileSync(caKeyPath);
        caCert = forge.pki.certificateFromPem(caCertPem);
        caKey = forge.pki.privateKeyFromPem(caKeyPem);
    } catch (e) {
        log.error('Can not find `CA certificate` or `CA key`.');
        process.exit(1);
    }

    return new FakeServersCenter({
        caCert: caCert,
        caKey: caKey,
        maxLength: 100,
        requestHandler: requestHandler,
        upgradeHandler: upgradeHandler,
        getCertSocketTimeout: getCertSocketTimeout
    });
};