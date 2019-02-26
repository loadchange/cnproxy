const forge = require('node-forge')
const fs = require('fs')
const path = require('path')
const config = require('../common/config')
const _ = require('lodash')
const mkdirp = require('mkdirp')

let utils = exports
let pki = forge.pki

utils.createCA = function (CN) {

    let keys = pki.rsa.generateKeyPair(2046)
    let cert = pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = (new Date()).getTime() + ''
    cert.validity.notBefore = new Date()
    cert.validity.notBefore.setFullYear(cert.validity.notBefore.getFullYear() - 5)
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 20)
    let attrs = [{
        name: 'commonName',
        value: CN
    }, {
        name: 'countryName',
        value: 'CN'
    }, {
        shortName: 'ST',
        value: 'Beijing'
    }, {
        name: 'localityName',
        value: 'Beijing'
    }, {
        name: 'organizationName',
        value: 'CNPROXY'
    }, {
        shortName: 'OU',
        value: 'https://github.com/LoadChange/cnproxy'
    }]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([{
        name: 'basicConstraints',
        critical: true,
        cA: true
    }, {
        name: 'keyUsage',
        critical: true,
        keyCertSign: true
    }, {
        name: 'subjectKeyIdentifier'
    }])

    // self-sign certificate
    cert.sign(keys.privateKey, forge.md.sha256.create())

    return {
        key: keys.privateKey,
        cert: cert
    }
}

utils.covertNodeCertToForgeCert = function (originCertificate) {
    let obj = forge.asn1.fromDer(originCertificate.raw.toString('binary'))
    return forge.pki.certificateFromAsn1(obj)
}

utils.createFakeCertificateByDomain = function (caKey, caCert, domain) {
    let keys = pki.rsa.generateKeyPair(2046)
    let cert = pki.createCertificate()
    cert.publicKey = keys.publicKey

    cert.serialNumber = (new Date()).getTime() + ''
    cert.validity.notBefore = new Date()
    cert.validity.notBefore.setFullYear(cert.validity.notBefore.getFullYear() - 1)
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1)
    let attrs = [{
        name: 'commonName',
        value: domain
    }, {
        name: 'countryName',
        value: 'CN'
    }, {
        shortName: 'ST',
        value: 'Beijing'
    }, {
        name: 'localityName',
        value: 'Beijing'
    }, {
        name: 'organizationName',
        value: 'CNPORXY'
    }, {
        shortName: 'OU',
        value: 'https://github.com/LoadChange/cnproxy'
    }]

    cert.setIssuer(caCert.subject.attributes)
    cert.setSubject(attrs)

    cert.setExtensions([{
        name: 'basicConstraints',
        critical: true,
        cA: false
    },
        {
            name: 'keyUsage',
            critical: true,
            digitalSignature: true,
            contentCommitment: true,
            keyEncipherment: true,
            dataEncipherment: true,
            keyAgreement: true,
            keyCertSign: true,
            cRLSign: true,
            encipherOnly: true,
            decipherOnly: true
        },
        {
            name: 'subjectAltName',
            altNames: [{
                type: 2,
                value: domain
            }]
        },
        {
            name: 'subjectKeyIdentifier'
        },
        {
            name: 'extKeyUsage',
            serverAuth: true,
            clientAuth: true,
            codeSigning: true,
            emailProtection: true,
            timeStamping: true
        },
        {
            name: 'authorityKeyIdentifier'
        }])
    cert.sign(caKey, forge.md.sha256.create())

    return {
        key: keys.privateKey,
        cert: cert
    }
}

utils.createFakeCertificateByCA = function (caKey, caCert, originCertificate) {
    let certificate = utils.covertNodeCertToForgeCert(originCertificate)

    let keys = pki.rsa.generateKeyPair(2046)
    let cert = pki.createCertificate()
    cert.publicKey = keys.publicKey

    cert.serialNumber = certificate.serialNumber
    cert.validity.notBefore = new Date()
    cert.validity.notBefore.setFullYear(cert.validity.notBefore.getFullYear() - 1)
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1)

    cert.setSubject(certificate.subject.attributes)
    cert.setIssuer(caCert.subject.attributes)

    certificate.subjectaltname && (cert.subjectaltname = certificate.subjectaltname)

    let subjectAltName = _.find(certificate.extensions, {name: 'subjectAltName'})
    cert.setExtensions([{
        name: 'basicConstraints',
        critical: true,
        cA: false
    }, {
        name: 'keyUsage',
        critical: true,
        digitalSignature: true,
        contentCommitment: true,
        keyEncipherment: true,
        dataEncipherment: true,
        keyAgreement: true,
        keyCertSign: true,
        cRLSign: true,
        encipherOnly: true,
        decipherOnly: true
    }, {
        name: 'subjectAltName',
        altNames: subjectAltName.altNames
    }, {
        name: 'subjectKeyIdentifier'
    }, {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true,
        codeSigning: true,
        emailProtection: true,
        timeStamping: true
    }, {
        name: 'authorityKeyIdentifier'
    }])
    cert.sign(caKey, forge.md.sha256.create())

    return {
        key: keys.privateKey,
        cert: cert
    }
}

utils.isBrowserRequest = function () {
    return /Mozilla/i.test(userAgent)
}
//
//  /^[^.]+\.a\.com$/.test('c.a.com')
//
utils.isMappingHostName = function (DNSName, hostname) {
    let reg = DNSName.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')
    reg = '^' + reg + '$'
    return (new RegExp(reg)).test(hostname)
}

utils.getMappingHostNamesFormCert = function (cert) {
    let mappingHostNames = []
    mappingHostNames.push(cert.subject.getField('CN') ? cert.subject.getField('CN').value : '')
    let altNames = cert.getExtension('subjectAltName') ? cert.getExtension('subjectAltName').altNames : []
    mappingHostNames = mappingHostNames.concat(_.map(altNames, 'value'))
    return mappingHostNames
}

// sync
utils.initCA = function (basePath = config.getDefaultCABasePath()) {

    let caCertPath = path.resolve(basePath, config.caCertFileName)
    let caKeyPath = path.resolve(basePath, config.caKeyFileName)

    try {
        fs.accessSync(caCertPath, fs.F_OK)
        fs.accessSync(caKeyPath, fs.F_OK)

        // has exist
        return {
            caCertPath,
            caKeyPath,
            create: false
        }
    } catch (e) {

        let caObj = utils.createCA(config.caName)

        let caCert = caObj.cert
        let cakey = caObj.key

        let certPem = pki.certificateToPem(caCert)
        let keyPem = pki.privateKeyToPem(cakey)

        mkdirp.sync(path.dirname(caCertPath))
        fs.writeFileSync(caCertPath, certPem)
        fs.writeFileSync(caKeyPath, keyPem)

    }
    return {
        caCertPath,
        caKeyPath,
        create: true
    }
}