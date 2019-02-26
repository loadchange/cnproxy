const forge = require('node-forge')
const https = require('https')
const tls = require('tls')
const pki = forge.pki
const tlsUtils = require('./tlsUtils')
const CertAndKeyContainer = require('./CertAndKeyContainer')
const log = require('../common/log')


module.exports = class FakeServersCenter {
    constructor({maxLength = 100, requestHandler, upgradeHandler, caCert, caKey, getCertSocketTimeout}) {
        this.queue = []
        this.maxLength = maxLength
        this.requestHandler = requestHandler
        this.upgradeHandler = upgradeHandler
        this.certAndKeyContainer = new CertAndKeyContainer({
            getCertSocketTimeout,
            caCert,
            caKey
        })
    }

    addServerPromise(serverPromiseObj) {
        if (this.queue.length >= this.maxLength) {
            let delServerObj = this.queue.shift()
            try {
                delServerObj.serverObj.server.close()
            } catch (e) {
                log.error(e)
            }
        }
        this.queue.push(serverPromiseObj)
        return serverPromiseObj
    }

    getServerPromise(hostname, port) {
        for (let i = 0; i < this.queue.length; i++) {
            let serverPromiseObj = this.queue[i]
            let mappingHostNames = serverPromiseObj.mappingHostNames
            for (let j = 0; j < mappingHostNames.length; j++) {
                let DNSName = mappingHostNames[j]
                if (tlsUtils.isMappingHostName(DNSName, hostname)) {
                    this.reRankServer(i)
                    return serverPromiseObj.promise
                }
            }
        }

        let serverPromiseObj = {
            mappingHostNames: [hostname] // temporary hostname
        }

        let promise = new Promise((resolve) => {

            (async () => {
                let certObj = await this.certAndKeyContainer.getCertPromise(hostname, port)
                let cert = certObj.cert
                let key = certObj.key
                let certPem = pki.certificateToPem(cert)
                let keyPem = pki.privateKeyToPem(key)
                let fakeServer = new https.Server({
                    key: keyPem,
                    cert: certPem,
                    SNICallback: (hostname, done) => {
                        (async () => {
                            let certObj = await this.certAndKeyContainer.getCertPromise(hostname, port)
                            done(null, tls.createSecureContext({
                                key: pki.privateKeyToPem(certObj.key),
                                cert: pki.certificateToPem(certObj.cert)
                            }))
                        })()
                    }
                })
                let serverObj = {
                    cert,
                    key,
                    server: fakeServer,
                    port: 0  // if prot === 0 ,should listen server's `listening` event.
                }
                serverPromiseObj.serverObj = serverObj
                fakeServer.listen(0, () => {
                    let address = fakeServer.address()
                    serverObj.port = address.port
                })
                fakeServer.on('request', (req, res) => {
                    let ssl = true
                    this.requestHandler(req, res, ssl)
                })
                fakeServer.on('error', (e) => {
                    console.error(e)
                })
                fakeServer.on('listening', () => {
                    let mappingHostNames = tlsUtils.getMappingHostNamesFormCert(certObj.cert)
                    serverPromiseObj.mappingHostNames = mappingHostNames
                    resolve(serverObj)
                })
                fakeServer.on('upgrade', (req, socket, head) => {
                    let ssl = true
                    this.upgradeHandler(req, socket, head, ssl)
                })
            })()

        })

        serverPromiseObj.promise = promise

        return (this.addServerPromise(serverPromiseObj)).promise
    }

    reRankServer(index) {
        // index ==> queue foot
        this.queue.push((this.queue.splice(index, 1))[0])
    }

}